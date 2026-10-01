/**
 * Runtime fallback — the real dependencies, bound to the running backend.
 *
 * Kept apart from the coordinator so the coordinator stays testable with
 * fakes; heavy services are imported lazily so importing this module from
 * index.ts adds no import cycles.
 *
 * @module services/runtime-fallback/runtime-fallback.wiring
 */

import * as fs from 'fs';
import * as path from 'path';
import { ORC_CONVERSATION_CONSTANTS, ORCHESTRATOR_SESSION_NAME, RUNTIME_FALLBACK_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import type { ApiKeyProvider } from '../../types/settings.types.js';
import { buildHandoverSummary, claudeTranscriptPath } from '../agent/runtime-session-recovery.js';
import { setRuntimeFallbackHooks } from './effective-runtime.js';
import { computeRuntimeAvailability } from './runtime-availability.js';
import { FileRuntimeFallbackStore } from './runtime-fallback.store.js';
import {
	RuntimeFallbackService,
	setRuntimeFallbackService,
	type FallbackAgentInfo,
	type FallbackLogger,
	type FallbackOwnerNotifier,
	type HandoverRequest,
} from './runtime-fallback.service.js';
import { runtimeLabel } from './runtime-fallback.types.js';
import { createRuntimeUsageProbe, type CrewlyAgentProbeTarget } from './runtime-usage-probe.js';
import { clearPlannedRelaunch, markPlannedRelaunch } from '../agent/planned-relaunch.registry.js';

/** Reason recorded for the fallback's relaunches. */
const PLANNED_RELAUNCH_REASON = 'runtime_fallback';

/** Provider of an in-process Crewly Agent run without a model id (CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL). */
const DEFAULT_CREWLY_AGENT_PROVIDER = 'google';

/**
 * Providers (with model) the in-process Crewly Agent runtime uses: the
 * orchestrator's model when it runs on it, and each member configured on it.
 *
 * @param storage - Teams / orchestrator status
 * @returns Unique provider → model (first model seen) pairs
 */
export async function crewlyAgentModelsInUse(storage: StorageLike): Promise<Array<{ provider: string; model?: string }>> {
	const modelIds: Array<string | undefined> = [];
	const orc = await storage.getOrchestratorStatus().catch(() => null);
	if (orc?.runtimeType === RUNTIME_TYPES.CREWLY_AGENT) modelIds.push(orc.modelId);
	for (const team of await storage.getTeams().catch(() => [])) {
		for (const member of team.members) {
			if (member.runtimeType === RUNTIME_TYPES.CREWLY_AGENT) modelIds.push(member.modelId);
		}
	}
	const byProvider = new Map<string, string | undefined>();
	for (const id of modelIds) {
		const slash = id ? id.indexOf('/') : -1;
		const provider = id && slash > 0 ? id.slice(0, slash) : DEFAULT_CREWLY_AGENT_PROVIDER;
		const model = id && slash > 0 ? id.slice(slash + 1) : undefined;
		if (!byProvider.has(provider) || (!byProvider.get(provider) && model)) byProvider.set(provider, model);
	}
	return [...byProvider].map(([provider, model]) => ({ provider, ...(model ? { model } : {}) }));
}

/** Team / member facts the wiring reads. */
interface StorageLike {
	getTeams(): Promise<Array<{ id: string; name: string; projectIds: string[]; members: Array<{ id: string; name: string; role: string; sessionName: string; runtimeType?: string; modelId?: string }> }>>;
	getProjects(): Promise<Array<{ id: string; path: string }>>;
	getOrchestratorStatus(): Promise<{ runtimeType?: string; modelId?: string } | null>;
}

/** The registration-service calls the wiring makes. */
interface RegistrationLike {
	isInProcessRuntimeActive(sessionName: string): boolean;
	stopSessionForRelaunch(sessionName: string): Promise<boolean>;
	createAgentSession(config: { sessionName: string; role: string; projectPath?: string; memberId?: string; teamId?: string }): Promise<{ success: boolean; error?: string }>;
	sendMessageToAgent(sessionName: string, message: string): Promise<{ success: boolean; queued?: boolean }>;
}

/** What index.ts provides. */
export interface RuntimeFallbackWiringContext {
	crewlyHome: string;
	storage: StorageLike;
	registration: () => RegistrationLike | null;
	/** Whether a PTY session exists */
	sessionExists: (sessionName: string) => boolean;
	notifier: () => FallbackOwnerNotifier | null;
	machineName: () => string;
	logger: FallbackLogger;
}

/** Crewly Agent model provider → settings API key provider. */
const KEY_PROVIDER: Readonly<Record<string, ApiKeyProvider>> = {
	deepseek: 'deepseek',
	google: 'gemini',
	anthropic: 'anthropic',
	openai: 'openai',
};

/**
 * Write a handover file for a runtime change.
 *
 * @param crewlyHome - CREWLY_HOME
 * @param req - What changes
 * @param cwd - The agent's working directory (Claude transcripts are keyed on it)
 * @param now - Clock
 * @returns The file path
 */
export function writeRuntimeHandover(crewlyHome: string, req: HandoverRequest, cwd: string | undefined, now: Date = new Date()): string {
	const dir = path.join(crewlyHome, ORC_CONVERSATION_CONSTANTS.HANDOVER_DIR);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${req.sessionName}-runtime-${req.direction}-${now.toISOString().replace(/[:.]/g, '-')}.md`);
	let summary = '';
	if (req.from === RUNTIME_TYPES.CLAUDE_CODE && req.conversationId && cwd) {
		summary = buildHandoverSummary(claudeTranscriptPath({ sessionId: req.conversationId, cwd }));
	}
	const why =
		req.direction === 'switch'
			? `You were running on ${runtimeLabel(req.from)}. It ran out of usage, so Crewly moved you to ${runtimeLabel(req.to)} until it resets.`
			: `You ran on ${runtimeLabel(req.from)} while ${runtimeLabel(req.to)} was out of usage. ${runtimeLabel(req.to)} is back, so Crewly moved you back.`;
	fs.writeFileSync(
		file,
		[
			'# Handover: runtime change',
			'',
			why,
			'Everything Crewly tracks — tasks, teams, OKRs, wiki — is still there; this file keeps only the end of what was said before.',
			...(req.workItem ? ['', `You were on WorkItem ${req.workItem.id} ("${req.workItem.title}"). Continue it.`] : []),
			'',
			summary || `_The ${runtimeLabel(req.from)} conversation is not readable here; check your WorkItems and wiki for where you were._`,
			'',
		].join('\n'),
		'utf-8',
	);
	return file;
}

/**
 * Build the backend's runtime-fallback service, register its hooks and the
 * instance, and start its tick.
 *
 * @param ctx - Backend context
 * @returns The running service
 */
export function startBackendRuntimeFallback(ctx: RuntimeFallbackWiringContext): RuntimeFallbackService {
	const probe = createRuntimeUsageProbe({
		crewlyAgentTargets: async (): Promise<CrewlyAgentProbeTarget[]> => {
			const { getSettingsService } = await import('../settings/settings.service.js');
			const targets: CrewlyAgentProbeTarget[] = [];
			for (const { provider, model } of await crewlyAgentModelsInUse(ctx.storage)) {
				const keyProvider = KEY_PROVIDER[provider];
				if (!keyProvider) continue;
				const apiKey = await getSettingsService().getApiKey(keyProvider, { runtime: RUNTIME_TYPES.CREWLY_AGENT }).catch(() => undefined);
				if (apiKey && apiKey.trim()) targets.push({ provider, apiKey: apiKey.trim(), ...(model ? { model } : {}) });
			}
			return targets;
		},
	});

	const findMember = async (sessionName: string) => {
		for (const team of await ctx.storage.getTeams()) {
			const member = team.members.find((m) => m.sessionName === sessionName);
			if (member) return { team, member };
		}
		return null;
	};

	const persistence = async () => {
		const { getSessionStatePersistence } = await import('../session/session-state-persistence.js');
		return getSessionStatePersistence();
	};
	let persistenceSync: Awaited<ReturnType<typeof persistence>> | null = null;
	void persistence()
		.then((p) => {
			persistenceSync = p;
		})
		.catch(() => undefined);

	const getAgent = async (sessionName: string): Promise<FallbackAgentInfo | null> => {
		if (sessionName === ORCHESTRATOR_SESSION_NAME) {
			const status = await ctx.storage.getOrchestratorStatus().catch(() => null);
			return { sessionName, name: 'Orc', primary: status?.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE, isOrchestrator: true };
		}
		const found = await findMember(sessionName);
		if (!found) return null;
		return {
			sessionName,
			name: found.member.name,
			primary: found.member.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE,
			memberId: found.member.id,
			teamId: found.team.id,
			isOrchestrator: false,
		};
	};

	const relaunchSession = async (agent: FallbackAgentInfo, reg: RegistrationLike): Promise<boolean> => {
		await reg.stopSessionForRelaunch(agent.sessionName);
		const { PtyActivityTrackerService } = await import('../agent/pty-activity-tracker.service.js');
		PtyActivityTrackerService.getInstance().clearSession(agent.sessionName);
		// Grace-revokes of the old session must not flag the new one as hung.
		const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
		try {
			TaskPoolService.getInstance().clearHungState(agent.sessionName);
		} catch {
			// task pool not ready
		}
		if (agent.isOrchestrator) {
			const { OrchestratorRestartService } = await import('../orchestrator/orchestrator-restart.service.js');
			return OrchestratorRestartService.getInstance().attemptRestart({ planned: true, reason: PLANNED_RELAUNCH_REASON });
		}
		const found = await findMember(agent.sessionName);
		if (!found) return false;
		let projectPath: string | undefined;
		if (found.team.projectIds[0]) {
			projectPath = (await ctx.storage.getProjects()).find((p) => p.id === found.team.projectIds[0])?.path;
		}
		projectPath ??= (await persistence().catch(() => null))?.getSessionMetadata(agent.sessionName)?.cwd;
		const result = await reg.createAgentSession({
			sessionName: agent.sessionName,
			role: found.member.role,
			projectPath,
			memberId: found.member.id,
			teamId: found.team.id,
		});
		if (!result.success) ctx.logger.warn('Relaunch failed', { sessionName: agent.sessionName, error: result.error });
		return result.success;
	};

	const service = new RuntimeFallbackService({
		store: new FileRuntimeFallbackStore(path.join(ctx.crewlyHome, RUNTIME_FALLBACK_CONSTANTS.STATE_FILE)),
		getAgent,
		countAgentsOnRuntime: async (runtime) => {
			let n = 0;
			const orc = await ctx.storage.getOrchestratorStatus().catch(() => null);
			if ((orc?.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE) === runtime) n += 1;
			for (const team of await ctx.storage.getTeams()) {
				n += team.members.filter((m) => (m.runtimeType ?? RUNTIME_TYPES.CLAUDE_CODE) === runtime).length;
			}
			return n;
		},
		isLive: (sessionName) => {
			try {
				if (ctx.registration()?.isInProcessRuntimeActive(sessionName)) return true;
				return ctx.sessionExists(sessionName);
			} catch {
				return false;
			}
		},
		isBusy: async (sessionName) => {
			const { ActivityMonitorService } = await import('../monitoring/activity-monitor.service.js');
			const { PtyActivityTrackerService } = await import('../agent/pty-activity-tracker.service.js');
			if (ActivityMonitorService.getInstance().getObservedWorkingStatus(sessionName) === 'in_progress') return true;
			const tracker = PtyActivityTrackerService.getInstance();
			return tracker.hasActivity(sessionName) && tracker.getIdleTimeMs(sessionName) < RUNTIME_FALLBACK_CONSTANTS.IDLE_QUIET_MS;
		},
		getAvailability: async (settings) => {
			const { getHarnessService } = await import('../harness/harness.service.js');
			const { getSettingsService } = await import('../settings/settings.service.js');
			const harnesses = await getHarnessService().status.listStatuses();
			const provider = settings.crewlyAgentModel.split('/')[0] ?? '';
			const keyProvider = KEY_PROVIDER[provider];
			const key = keyProvider ? await getSettingsService().getApiKey(keyProvider, { runtime: RUNTIME_TYPES.CREWLY_AGENT }).catch(() => undefined) : undefined;
			return computeRuntimeAvailability({
				harnesses,
				crewlyAgentModel: settings.crewlyAgentModel,
				hasProviderKey: (p) => p === provider && Boolean(key && key.trim()),
			});
		},
		probe,
		writeHandover: async (req) => {
			const cwd = (await persistence().catch(() => null))?.getSessionMetadata(req.sessionName)?.cwd;
			return writeRuntimeHandover(ctx.crewlyHome, req, cwd);
		},
		getActiveWorkItem: async (sessionName) => {
			const { TaskPoolService } = await import('../task-pool/task-pool.service.js');
			const active = (await TaskPoolService.getInstance().getAllItems()).filter(
				(wi) => wi.target === sessionName && (wi.status === 'running' || wi.status === 'accepted' || wi.status === 'proposed'),
			);
			const rank: Record<string, number> = { running: 0, accepted: 1, proposed: 2 };
			active.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
			const wi = active[0];
			return wi ? { id: wi.id, title: wi.title } : null;
		},
		conversation: {
			get: (s) => persistenceSync?.getSessionId(s),
			set: (s, id) => persistenceSync?.updateSessionId(s, id),
			clear: (s) => persistenceSync?.clearSessionId(s),
		},
		relaunch: async (agent) => {
			const reg = ctx.registration();
			if (!reg) return false;
			// A runtime switch is not a crash or a hang: the restart, heartbeat and
			// hung monitors leave the session alone through the relaunch and its
			// start-up, and the owner gets only the fallback's own message.
			markPlannedRelaunch(agent.sessionName, PLANNED_RELAUNCH_REASON);
			const ok = await relaunchSession(agent, reg).catch(() => false);
			if (ok) markPlannedRelaunch(agent.sessionName, PLANNED_RELAUNCH_REASON);
			else clearPlannedRelaunch(agent.sessionName);
			return ok;
		},
		redeliver: async (sessionName) => {
			const { getOwnerMessageWatchdog } = await import('../messaging/owner-message-watchdog.service.js');
			await getOwnerMessageWatchdog()?.resumeAfterLogin({ sessions: [sessionName] });
		},
		flushQueued: async (sessionName) => {
			const reg = ctx.registration();
			if (!reg) return;
			const { SubAgentMessageQueue } = await import('../messaging/sub-agent-message-queue.service.js');
			const queue = SubAgentMessageQueue.getInstance();
			if (!queue.hasPending(sessionName)) return;
			await queue.flush(sessionName, (data) => reg.sendMessageToAgent(sessionName, data));
		},
		machineName: ctx.machineName,
		notifier: ctx.notifier,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		logger: ctx.logger,
	});

	setRuntimeFallbackService(service);
	setRuntimeFallbackHooks(service);
	service.start();
	return service;
}
