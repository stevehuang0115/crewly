/**
 * Wiring for the follow-through guard, the ticket work guard and the idle
 * work guard onto the real backend services. Kept apart from the services so
 * their logic stays transport-free (and testable).
 *
 * @module services/agent/follow-through.wiring
 * @see specs/2026-10-10-agent-follow-through.md
 */

import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import { LoggerService } from '../core/logger.service.js';
import { RequestService } from '../v3/request.service.js';
import { getTicketReviewService } from '../v3/ticket-review.service.js';
import { ensureTicketWorkItems } from '../v3/ticket-work-guard.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { DecisionStore, PENDING_DECISION_STATUSES } from '../decisions/decision-store.js';
import { getOwnerThreadSentinel } from '../messaging/owner-thread-sentinel.service.js';
import { AgentTurnStateService } from '../monitoring/agent-turn-state.js';
import { isOwnerStopped } from './owner-stopped.registry.js';
import { pausedTeamOfSession } from '../team/team-pause.registry.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { AgentFollowThroughService, getFollowThrough, setFollowThrough } from './follow-through.service.js';
import { holdReasonFor, releaseHeldWork, type IdleWorkGuardDeps, type ReleaseWorkDeps } from './idle-work-guard.js';

const logger = LoggerService.getInstance().createComponentLogger('FollowThroughWiring');

/**
 * Whether the agent handed the work off or put it on the pool since `since`:
 * a WorkItem created after that for itself (tracked), or one it delegated to
 * a teammate (`delegatedBy` / `createdBy` / the project-ticket caller stamp).
 *
 * @param items - Pool items
 * @param session - The agent
 * @param since - Epoch ms
 * @returns True when something covers the statement
 */
export function handedOffSince(items: readonly WorkItem[], session: string, since: number): boolean {
	return items.some((wi) => {
		if (Date.parse(wi.createdAt) < since) return false;
		if (wi.target === session) return true;
		const m = (wi.metadata ?? {}) as Record<string, unknown>;
		return m['delegatedBy'] === session || m['createdBy'] === session || m[PROJECT_TICKET_CONSTANTS.DELEGATION_CALLER_METADATA_KEY] === session;
	});
}

/** What the wiring needs from the composition root. */
export interface FollowThroughWiringDeps {
	crewlyHome: string;
	/** Deliver text into an agent's conversation */
	sendToAgent: (session: string, text: string) => Promise<{ success: boolean }>;
}

/**
 * Build the guard on the real services and expose it as the singleton.
 * `CREWLY_FOLLOW_THROUGH=off` switches it off (nothing tracked, no nudges).
 *
 * @param deps - Seams
 * @returns The guard, or null when switched off
 */
export function createFollowThrough(deps: FollowThroughWiringDeps): AgentFollowThroughService | null {
	if ((process.env['CREWLY_FOLLOW_THROUGH'] ?? '').trim().toLowerCase() === 'off') return null;
	const turnState = AgentTurnStateService.getInstance();
	const tracker = PtyActivityTrackerService.getInstance();
	const service = new AgentFollowThroughService({
		nudgeAgent: async (session, text) => (await deps.sendToAgent(session, text)).success,
		toolStartsSince: (session, since) => turnState.toolStartsSince(session, since),
		runtimeStartedAt: (session) => turnState.runtimeStartedAt(session),
		outputSpanSince: (session, since) => {
			if (!tracker.hasActivity(session)) return null;
			return Math.max(0, Date.now() - tracker.getIdleTimeMs(session) - since);
		},
		handedOff: async (session, since) => handedOffSince(await TaskPoolService.getInstance().getAllItems(), session, since),
		waitingOnOwner: async (session) => {
			const open = await DecisionStore.inHome(deps.crewlyHome).list((d) => d.asker === session && !d.system && PENDING_DECISION_STATUSES.has(d.status));
			return open.length > 0;
		},
		isHeldBack: (session) => isOwnerStopped(session) || !!pausedTeamOfSession(session),
	});
	setFollowThrough(service);
	return service;
}

const settling = new Set<string>();

/**
 * End of an agent's turn: nudge a stated intent nothing followed, give an
 * unanswered owner ticket a WorkItem, then (the caller) submit answered
 * tickets. Order matters: the WorkItem exists before the review looks.
 * Never throws.
 *
 * @param session - Agent whose turn ended
 */
export async function settleFollowThrough(session: string): Promise<void> {
	if (settling.has(session)) return;
	settling.add(session);
	try {
		const guard = getFollowThrough();
		await guard?.onTurnEnd(session);
		const pool = TaskPoolService.getInstance();
		const created = await ensureTicketWorkItems(session, {
			listTickets: () => RequestService.getInstance().listAll(),
			listWorkItems: () => pool.getAllItems(),
			addWorkItem: (wi, creator) => pool.addToPool(wi, { creatorSession: creator }),
			setChecklist: async (ticketId, items) => getTicketReviewService()?.setAcceptance(ticketId, items),
			holdsIntent: (agent) => guard?.holdsIntent(agent) ?? false,
			lastRealReplyAt: (agent) => guard?.lastRealReplyAt(agent),
		});
		for (const c of created) logger.info('Owner request had no WorkItem — created one for its assignee', { agent: session, ...c });
	} catch (err) {
		logger.debug('Follow-through settle failed (non-fatal)', { session, error: err instanceof Error ? err.message : String(err) });
	} finally {
		settling.delete(session);
	}
}

/** Seams of the idle work guard on the real services. */
export function idleWorkGuardDeps(): IdleWorkGuardDeps {
	return {
		listWorkItems: () => TaskPoolService.getInstance().getAllItems(),
		listTickets: () => RequestService.getInstance().listAll(),
		owesOwner: (session) => getOwnerThreadSentinel()?.owesOwner(session) ?? false,
		holdsIntent: (session) => getFollowThrough()?.holdsIntent(session) ?? false,
	};
}

/** The idle check's pending-work check on the real services. */
export function idlePendingWorkCheck(): (session: string) => Promise<string | null> {
	return (session) => holdReasonFor(session, idleWorkGuardDeps());
}

/** Seams of the work release on the real services. */
export function releaseWorkDeps(): ReleaseWorkDeps {
	const pool = TaskPoolService.getInstance();
	return {
		listWorkItems: () => pool.getAllItems(),
		releaseBack: (id, reason) => pool.releaseBack(id, reason),
		parkIntent: async (session) => {
			const intent = getFollowThrough()?.takeIntent(session);
			if (!intent) return null;
			const wi = createWorkItem({
				type: 'delegate',
				owner: 'system',
				target: session,
				title: `Follow through: ${intent.sentence.slice(0, 70)}`,
				description:
					`You told the owner: "${intent.sentence}". Crewly stopped you (memory) before you started it. ` +
					'Start it now; reply to the owner when there is a result or a real blocker.',
				metadata: { harnessCreated: 'stated-intent' },
			});
			await pool.addToPool(wi, { creatorSession: session });
			return wi.id;
		},
	};
}

/**
 * Release what a stopping agent holds (idle stop under pressure, emergency stop).
 *
 * @param session - Agent being stopped
 * @param why - Reason text
 * @returns Ids released or created
 */
export function releaseWorkForStop(session: string, why: string): Promise<string[]> {
	return releaseHeldWork(session, why, releaseWorkDeps());
}
