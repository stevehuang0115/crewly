/**
 * Runtime fallback — when an agent's runtime runs out of usage, run the agent
 * on the next runtime of its fallback chain until the limit resets, then
 * switch it back at an idle boundary.
 *
 * Flow (specs/2026-10-01-runtime-fallback.md):
 *
 * 1. **Detect** ({@link RuntimeFallbackService.reportOutput}): live output or
 *    an in-process run error matched a usage-limit rule. Transient rate limits
 *    are left to the runtime's own retries unless they keep coming.
 * 2. **Confirm** with the runtime's probe (Claude: a one-line print-mode turn);
 *    a probe that answers normally marks the match a false positive.
 * 3. **Mark the runtime exhausted** (account-wide) with its reset time.
 * 4. **Switch** the agent that hit it at its next safe point: handover file,
 *    `runtimeOverride` (the configured runtime is not changed), relaunch, then
 *    re-deliver what waited for it.
 * 5. Other agents on that runtime switch **when they next get work**
 *    ({@link RuntimeFallbackService.beforeDelivery}) or when started
 *    ({@link RuntimeFallbackService.resolveLaunch}); idle ones are not woken.
 * 6. **Switch back** ({@link RuntimeFallbackService.tick}) only after the
 *    runtime's probe answers normally (at the reset time, or on the probe
 *    interval); each agent reverts at its next idle boundary. A runtime that
 *    is out of money/credit (`billing`) has no reset time and is probed at
 *    most every BILLING_PROBE_INTERVAL_MS. A switch-back that fails (the limit
 *    comes straight back) doubles the next probe interval.
 * 7. **Tell the owner once** per event, and once when it is over.
 *
 * A chain entry may be one of the owner's other Claude Code accounts
 * (`claude-code@work`, issue #942): it is a runtime target of its own — out
 * of usage, probed and switched to independently of the default login. An
 * agent on such an account still reports `claude-code` as its runtime
 * ({@link RuntimeFallbackService.overrideFor}); the account comes from
 * {@link RuntimeFallbackService.accountFor}. When that account's login
 * expires the agent moves on along its chain, and the account comes back
 * once the owner signs it in again ({@link RuntimeFallbackService.onAccountLogin}).
 *
 * Nothing here throws into its callers: delivery and launch fall back to the
 * configured runtime on any error.
 *
 * @module services/runtime-fallback/runtime-fallback.service
 */

import { ORCHESTRATOR_SESSION_NAME, RUNTIME_FALLBACK_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { detectUsageLimit, type UsageLimitMatch } from './usage-limit-rules.js';
import { traceRuntimeBlocked } from '../trace/trace-recorder.js';
import { accountOf, baseRuntimeOf, parseRuntimeTarget, runtimeTarget } from '../harness/claude-accounts.js';
import type { LaunchRuntimeDecision, LaunchRuntimeInput, RuntimeFallbackHooks, RuntimeOutputSource } from './effective-runtime.js';
import type { RuntimeFallbackStore } from './runtime-fallback.store.js';
import {
	applySettingsPatch,
	runtimeLabel,
	runtimeShortLabel,
	type ExhaustedRuntime,
	type RuntimeAvailability,
	type RuntimeFallbackSettings,
	type RuntimeFallbackState,
	type RuntimeOverride,
} from './runtime-fallback.types.js';

const C = RUNTIME_FALLBACK_CONSTANTS;

/**
 * Result of a switch-back probe: `available` (it answered normally),
 * `limited` (still out), `unknown` (the probe ran but could not tell — never
 * switches back), `unsupported` (this runtime has no probe; only a parsed
 * reset time can bring it back).
 */
export type ProbeResult = 'available' | 'limited' | 'unknown' | 'unsupported';

/** What the service needs to know about an agent. */
export interface FallbackAgentInfo {
	sessionName: string;
	/** Name the owner knows ("Ella", "Orc") */
	name: string;
	/** Configured runtime */
	primary: string;
	memberId?: string;
	teamId?: string;
	isOrchestrator: boolean;
}

/** A handover to write when an agent changes runtime. */
export interface HandoverRequest {
	sessionName: string;
	from: string;
	to: string;
	direction: 'switch' | 'revert';
	/** Conversation id on `from`, when known */
	conversationId: string | null;
	/** WorkItem the agent is on */
	workItem: { id: string; title: string } | null;
}

/** Minimal logger. */
export interface FallbackLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

/** Sends the owner a DM. */
export interface FallbackOwnerNotifier {
	sendToOwner(text: string): Promise<unknown>;
}

/** Injectable dependencies. */
export interface RuntimeFallbackDeps {
	store: RuntimeFallbackStore;
	/** Configured agent behind a session (null when unknown) */
	getAgent: (sessionName: string) => Promise<FallbackAgentInfo | null>;
	/** Number of agents configured on a runtime (orc included), for the notice */
	countAgentsOnRuntime?: (runtime: string) => Promise<number>;
	/** The session has a live runtime (PTY or in-process) */
	isLive: (sessionName: string) => boolean;
	/** Mid-turn, or a message is being delivered / queued */
	isBusy: (sessionName: string) => Promise<boolean>;
	/** Which runtimes are installed and signed in */
	getAvailability: (settings: RuntimeFallbackSettings) => Promise<RuntimeAvailability[]>;
	/** Does the runtime (target: `claude-code@work` probes that account) have usage again? */
	probe: (runtime: string) => Promise<ProbeResult>;
	/** Write the handover file; returns its path */
	writeHandover: (req: HandoverRequest) => Promise<string | null>;
	/** WorkItem the agent is on */
	getActiveWorkItem: (sessionName: string) => Promise<{ id: string; title: string } | null>;
	/** Stored conversation id of a session */
	conversation: {
		get: (sessionName: string) => string | undefined;
		set: (sessionName: string, id: string) => void;
		clear: (sessionName: string) => void;
	};
	/** Stop the session and start it again (the launch resolves the runtime) */
	relaunch: (agent: FallbackAgentInfo) => Promise<boolean>;
	/** After a relaunch: re-deliver unanswered owner messages */
	redeliver: (sessionName: string) => Promise<void>;
	/** Write out messages queued for the session */
	flushQueued: (sessionName: string) => Promise<void>;
	/** This machine's name */
	machineName: () => string;
	notifier?: () => FallbackOwnerNotifier | null;
	/** Sessions the fallback never touches (smoke tests) */
	isExempt?: (sessionName: string) => boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Zone for times in owner messages and clock-only reset times */
	timeZone?: string;
	logger?: FallbackLogger;
}

/** An override as the API shows it. */
export interface RuntimeOverrideView extends RuntimeOverride {
	sessionName: string;
	/** "on DeepSeek (Claude limit)" */
	badge: string;
	runtimeLabel: string;
	primaryLabel: string;
}

/** `GET /api/system/runtime-fallback`. */
export interface RuntimeFallbackSnapshot {
	settings: RuntimeFallbackSettings;
	runtimes: Array<RuntimeAvailability & { exhausted: boolean }>;
	exhausted: ExhaustedRuntime[];
	overrides: RuntimeOverrideView[];
}

/** Outcome of a switch attempt. */
export type SwitchOutcome = 'switched' | 'reverted' | 'no_fallback' | 'skipped' | 'failed';

const SILENT: FallbackLogger = { info: () => undefined, warn: () => undefined, debug: () => undefined };

/**
 * "1 agent" / "3 agents".
 *
 * @param n - Count
 * @returns Phrase
 */
function agents(n: number): string {
	return `${n} agent${n === 1 ? '' : 's'}`;
}

/** Runtime fallback coordinator. */
export class RuntimeFallbackService implements RuntimeFallbackHooks {
	private state: RuntimeFallbackState;
	private readonly logger: FallbackLogger;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** Sessions being switched (messages for them are queued) */
	private readonly switching = new Set<string>();
	/** Runtimes whose detection is being confirmed by a probe */
	private readonly confirming = new Map<string, Promise<boolean>>();
	/** A probe said the runtime is fine: ignore matches until then */
	private readonly mutedUntil = new Map<string, number>();
	/** Recent transient rate limits per session */
	private readonly transients = new Map<string, number[]>();
	/** Owner notice due time per exhausted runtime */
	private readonly noticeDue = new Map<string, number>();
	/** Kickoff notes waiting for a session's next launch */
	private readonly kickoffNotes = new Map<string, string>();
	/** Last switch-back per runtime, to recognise one that failed */
	private readonly recentRecoveries = new Map<string, { at: number; failedReverts: number; notified: boolean }>();
	private availability: { at: number; list: RuntimeAvailability[] } | null = null;
	private timer: NodeJS.Timeout | null = null;
	private ticking = false;

	/**
	 * @param deps - Dependencies
	 */
	constructor(private readonly deps: RuntimeFallbackDeps) {
		this.logger = deps.logger ?? SILENT;
		this.now = deps.now ?? (() => Date.now());
		this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.state = deps.store.load();
	}

	// ---------------------------------------------------------------- lifecycle

	/** Start the periodic tick (switch-back checks, reverts, notices). */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), C.TICK_MS);
		this.timer.unref?.();
		// Notices that were due before a restart, and a first availability read.
		void this.tick();
	}

	/** Stop the tick. */
	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	// ----------------------------------------------------------------- settings

	/** @returns Current settings (copy) */
	getSettings(): RuntimeFallbackSettings {
		return JSON.parse(JSON.stringify(this.state.settings)) as RuntimeFallbackSettings;
	}

	/**
	 * Apply a partial settings update.
	 *
	 * @param patch - Owner's update (validated)
	 * @returns New settings
	 * @throws RuntimeFallbackSettingsError when invalid
	 */
	updateSettings(patch: unknown): RuntimeFallbackSettings {
		this.state.settings = applySettingsPatch(this.state.settings, patch);
		this.availability = null;
		this.save();
		return this.getSettings();
	}

	/** Forget the cached availability (a runtime's Terms consent changed). */
	invalidateAvailability(): void {
		this.availability = null;
	}

	// ------------------------------------------------------------------- hooks

	/**
	 * Runtime a session runs on instead of its configured one.
	 *
	 * @param sessionName - Session
	 * @returns Fallback runtime, or null
	 */
	overrideFor(sessionName: string): string | null {
		const target = this.state.overrides[sessionName]?.runtime;
		return target ? baseRuntimeOf(target) : null;
	}

	/**
	 * The owner's other Claude Code account a session runs on.
	 *
	 * @param sessionName - Session
	 * @returns Account name, or null
	 */
	accountFor(sessionName: string): string | null {
		const target = this.state.overrides[sessionName]?.runtime;
		return target ? accountOf(target) : null;
	}

	/**
	 * A session's login expired. When it runs on one of the owner's other
	 * Claude Code accounts, that account is marked signed out (`login`) and
	 * the agent moves on along its chain; the owner is told how to sign it
	 * in again. The default login's expiry is left to the re-login flow.
	 *
	 * @param sessionName - Session
	 * @returns True when handled here
	 */
	reportLoginExpiry(sessionName: string): boolean {
		if (!this.state.settings.enabled || this.isExempt(sessionName)) return false;
		const target = this.state.overrides[sessionName]?.runtime;
		if (!target || !accountOf(target)) return false;
		void this.onAccountSignedOut(sessionName, target).catch((err) =>
			this.logger.warn('Runtime fallback failed after an account sign-out', { sessionName, error: err instanceof Error ? err.message : String(err) }),
		);
		return true;
	}

	/**
	 * One of the owner's other Claude Code accounts was signed in: if it was
	 * marked signed out, probe it and bring it back.
	 *
	 * @param account - Account name
	 * @returns Resolves when done; never rejects
	 */
	async onAccountLogin(account: string): Promise<void> {
		this.availability = null;
		const target = runtimeTarget(RUNTIME_TYPES.CLAUDE_CODE, account);
		const entry = this.state.exhausted[target];
		if (!entry || entry.kind !== 'login') return;
		const result = await this.deps.probe(target).catch((): ProbeResult => 'unknown');
		entry.lastProbeAt = new Date(this.now()).toISOString();
		if (result === 'available') {
			await this.recover(target);
			return;
		}
		if (result === 'limited') {
			// Signed in again, but that account is out of usage too.
			entry.kind = 'usage_limit';
			entry.ruleId = 'probe_limited';
		}
		this.save();
	}

	/**
	 * Take the note for a session's next kickoff.
	 *
	 * @param sessionName - Session
	 * @returns Note (once) or null
	 */
	takeKickoffNote(sessionName: string): string | null {
		const note = this.kickoffNotes.get(sessionName) ?? null;
		this.kickoffNotes.delete(sessionName);
		return note;
	}

	/**
	 * Runtime output / error of a session. A usage limit starts the fallback
	 * (asynchronously); everything else is ignored.
	 *
	 * @param sessionName - Session
	 * @param runtime - Runtime it runs on
	 * @param text - Output (never logged)
	 * @param source - `output` (live chunk), `screen` (sweep, ignored: old scrollback) or `error`
	 * @returns True when a usage limit was recognised
	 */
	reportOutput(sessionName: string, runtime: string, text: string, source: RuntimeOutputSource): boolean {
		if (!this.state.settings.enabled || source === 'screen' || this.isExempt(sessionName)) return false;
		// On another Claude Code account the account is what ran out, not the default login.
		const target = this.targetOf(sessionName, runtime);
		if ((this.mutedUntil.get(target) ?? 0) > this.now()) return false;
		let match = detectUsageLimit(text, runtime, this.now(), this.deps.timeZone);
		if (!match) return false;
		if (match.kind === 'transient') {
			match = this.escalateTransient(sessionName, match);
			if (!match) return false;
		}
		void this.onUsageLimit(sessionName, target, match).catch((err) =>
			this.logger.warn('Runtime fallback failed', { sessionName, runtime, error: err instanceof Error ? err.message : String(err) }),
		);
		return true;
	}

	/**
	 * Gate before a message is written into a session.
	 *
	 * @param sessionName - Session
	 * @param runtime - Runtime the caller resolved
	 * @returns `queue` while a switch runs or when the session's runtime is out of usage and a fallback exists
	 */
	beforeDelivery(sessionName: string, runtime: string): 'deliver' | 'queue' {
		if (!this.state.settings.enabled || this.isExempt(sessionName)) return 'deliver';
		if (this.switching.has(sessionName)) return 'queue';
		const current = this.state.overrides[sessionName]?.runtime ?? runtime;
		if (!this.state.exhausted[current]) return 'deliver';
		if (sessionName === ORCHESTRATOR_SESSION_NAME && !this.state.settings.orcFollows) return 'deliver';
		if (!this.hasCandidateSync(current)) return 'deliver';
		this.logger.info('Message for an agent whose runtime is out of usage — switching it first', { sessionName, runtime: current });
		void this.switchSession(sessionName, { waitForSafePoint: true, flushAfter: true });
		return 'queue';
	}

	/**
	 * Runtime to launch a session on.
	 *
	 * @param input - Session, configured runtime
	 * @returns The decision
	 */
	async resolveLaunch(input: LaunchRuntimeInput): Promise<LaunchRuntimeDecision> {
		const configured = { runtime: input.configured, overridden: false };
		if (!this.state.settings.enabled || this.isExempt(input.sessionName)) return configured;
		const existing = this.state.overrides[input.sessionName];
		if (existing) {
			if (existing.primary !== input.configured) {
				// The owner changed the member's runtime: the override is stale.
				delete this.state.overrides[input.sessionName];
				this.save();
			} else if (existing.revertPending && !this.state.exhausted[existing.primary]) {
				// A stopped agent being started after its runtime came back.
				this.finishRevertOffline(input.sessionName, existing);
				return configured;
			} else {
				return this.decision(existing.runtime);
			}
		}
		if (!this.state.exhausted[input.configured]) return configured;
		if (input.isOrchestrator && !this.state.settings.orcFollows) return configured;

		const agent: FallbackAgentInfo = (await this.deps.getAgent(input.sessionName).catch(() => null)) ?? {
			sessionName: input.sessionName,
			name: input.sessionName,
			primary: input.configured,
			memberId: input.memberId,
			teamId: input.teamId,
			isOrchestrator: input.isOrchestrator,
		};
		const target = await this.pickFallback(agent, input.configured);
		if (!target) {
			this.markNoFallback(input.configured);
			return configured;
		}
		await this.recordSwitch(agent, input.configured, target);
		this.logger.info('Starting an agent on its fallback runtime (its runtime is out of usage)', {
			sessionName: input.sessionName,
			primary: input.configured,
			runtime: target,
		});
		return this.decision(target);
	}

	// --------------------------------------------------------------- detection

	/**
	 * The runtime target a session's output belongs to: the account it runs
	 * on when its override is a Claude Code account of that runtime.
	 *
	 * @param sessionName - Session
	 * @param runtime - Runtime the caller resolved (no account)
	 * @returns Target
	 */
	private targetOf(sessionName: string, runtime: string): string {
		const override = this.state.overrides[sessionName]?.runtime;
		return override && baseRuntimeOf(override) === runtime ? override : runtime;
	}

	/**
	 * A session on one of the owner's other Claude Code accounts lost its
	 * login: mark the account signed out and move the agent on.
	 *
	 * @param sessionName - Session
	 * @param target - `claude-code@<account>`
	 */
	private async onAccountSignedOut(sessionName: string, target: string): Promise<void> {
		const known = this.state.exhausted[target];
		if (!known) {
			this.state.exhausted[target] = {
				runtime: target,
				since: new Date(this.now()).toISOString(),
				kind: 'login',
				ruleId: 'login_expired',
				switched: [],
				switchedTo: [],
				notified: false,
			};
			this.availability = null;
			this.save();
			this.logger.info('Claude Code account is signed out — its agents move on along their chain', { runtime: target });
		} else if (known.kind !== 'login') {
			known.kind = 'login';
			known.ruleId = 'login_expired';
			delete known.until;
			this.save();
		}
		traceRuntimeBlocked(sessionName, 'login', target);
		await this.switchSession(sessionName, { waitForSafePoint: false, flushAfter: false });
	}

	/**
	 * Count a transient rate limit; escalate when they keep coming.
	 *
	 * @param sessionName - Session
	 * @param match - Transient match
	 * @returns A usage-limit match when escalated, else null
	 */
	private escalateTransient(sessionName: string, match: UsageLimitMatch): UsageLimitMatch | null {
		const now = this.now();
		const recent = (this.transients.get(sessionName) ?? []).filter((t) => now - t < C.TRANSIENT_WINDOW_MS);
		recent.push(now);
		this.transients.set(sessionName, recent);
		if (recent.length < C.TRANSIENT_ESCALATE_COUNT) {
			this.logger.debug('Transient rate limit — the runtime retries it', { sessionName, rule: match.ruleId, count: recent.length });
			return null;
		}
		this.transients.delete(sessionName);
		return { ...match, kind: 'usage_limit', ruleId: `${match.ruleId}+repeated`, resetAt: now + C.TRANSIENT_ESCALATED_HORIZON_MS };
	}

	/**
	 * A usage limit was seen in a session.
	 *
	 * @param sessionName - Session
	 * @param runtime - Runtime that is out of usage
	 * @param match - The match
	 */
	private async onUsageLimit(sessionName: string, runtime: string, match: UsageLimitMatch): Promise<void> {
		const known = this.state.exhausted[runtime];
		const billing = match.kind === 'billing';
		if (known) {
			if (billing && known.kind !== 'billing') {
				// Out of credit trumps a window limit: no reset time to wait for.
				known.kind = 'billing';
				known.ruleId = match.ruleId;
				delete known.until;
				this.save();
			} else if (!billing && known.kind !== 'billing' && match.resetAt && known.until !== new Date(match.resetAt).toISOString()) {
				known.until = new Date(match.resetAt).toISOString();
				this.save();
			}
		} else {
			const confirmed = await this.confirm(runtime);
			if (!confirmed) return;
			if (!this.state.exhausted[runtime]) {
				// The limit came straight back after a switch-back: back off the
				// next probe, and do not tell the owner a second time.
				const recent = this.recentRecoveries.get(runtime);
				const failedRevert = recent !== undefined && this.now() - recent.at < C.FAILED_REVERT_WINDOW_MS;
				this.recentRecoveries.delete(runtime);
				const failedReverts = failedRevert ? recent.failedReverts + 1 : 0;
				this.state.exhausted[runtime] = {
					runtime,
					since: new Date(this.now()).toISOString(),
					...(match.resetAt && !billing ? { until: new Date(match.resetAt).toISOString() } : {}),
					kind: billing ? 'billing' : 'usage_limit',
					...(failedReverts > 0 ? { failedReverts } : {}),
					ruleId: match.ruleId,
					switched: [],
					switchedTo: [],
					notified: failedRevert ? recent.notified : false,
				};
				this.save();
				this.logger.info(billing ? 'Runtime is out of credit (no timed retry; probed until it is topped up)' : 'Runtime is out of usage', {
					runtime,
					rule: match.ruleId,
					until: this.state.exhausted[runtime].until ?? null,
					...(failedReverts > 0 ? { failedReverts } : {}),
				});
			}
		}
		const until = this.state.exhausted[runtime]?.until;
		traceRuntimeBlocked(sessionName, billing ? 'billing' : 'usage_limit', runtime, `${match.ruleId}${until ? `, until ${until}` : ''}`);
		await this.switchSession(sessionName, { waitForSafePoint: true, flushAfter: false });
	}

	/**
	 * Confirm a detection with the runtime's probe (one probe per runtime at a time).
	 *
	 * @param runtime - Runtime
	 * @returns False when the probe shows the runtime works (a false positive)
	 */
	private confirm(runtime: string): Promise<boolean> {
		const running = this.confirming.get(runtime);
		if (running) return running;
		const run = (async () => {
			const result = await this.deps.probe(runtime).catch((): ProbeResult => 'unknown');
			if (result === 'available') {
				this.mutedUntil.set(runtime, this.now() + C.FALSE_POSITIVE_MUTE_MS);
				this.logger.info('Usage-limit text seen but the runtime answers normally — ignoring it', { runtime });
				return false;
			}
			return true;
		})();
		this.confirming.set(runtime, run);
		void run.finally(() => this.confirming.delete(runtime));
		return run;
	}

	// ------------------------------------------------------------------ switch

	/**
	 * Move a session to the next runtime of its chain (or back to its primary).
	 *
	 * @param sessionName - Session
	 * @param opts - Wait for its safe point first; flush queued messages when nothing switched
	 * @returns What happened
	 */
	async switchSession(sessionName: string, opts: { waitForSafePoint: boolean; flushAfter: boolean }): Promise<SwitchOutcome> {
		if (this.switching.has(sessionName)) return 'skipped';
		this.switching.add(sessionName);
		let outcome: SwitchOutcome = 'skipped';
		try {
			outcome = await this.doSwitch(sessionName, opts.waitForSafePoint);
			return outcome;
		} catch (err) {
			this.logger.warn('Runtime switch failed', { sessionName, error: err instanceof Error ? err.message : String(err) });
			outcome = 'failed';
			return outcome;
		} finally {
			this.switching.delete(sessionName);
			await this.afterSwitch(sessionName, outcome, opts.flushAfter);
		}
	}

	/**
	 * After a switch, once messages are no longer held back: re-deliver what
	 * waited for the agent and write out its queue. Messages the gate queued
	 * must not wait for an event that will not come, also when nothing switched.
	 *
	 * @param sessionName - Session
	 * @param outcome - How the switch went
	 * @param flushAlways - Flush the queue even when nothing switched
	 */
	private async afterSwitch(sessionName: string, outcome: SwitchOutcome, flushAlways: boolean): Promise<void> {
		const moved = outcome === 'switched' || outcome === 'reverted';
		if (moved) await this.deps.redeliver(sessionName).catch(() => undefined);
		if (moved || flushAlways) await this.deps.flushQueued(sessionName).catch(() => undefined);
	}

	private async doSwitch(sessionName: string, waitForSafePoint: boolean): Promise<SwitchOutcome> {
		const agent = await this.deps.getAgent(sessionName);
		if (!agent) return 'skipped';
		if (agent.isOrchestrator && !this.state.settings.orcFollows) return 'skipped';
		const current = this.state.overrides[sessionName]?.runtime ?? agent.primary;
		if (!this.state.exhausted[current]) return 'skipped';
		if (waitForSafePoint) await this.waitForSafePoint(sessionName);

		const target = await this.pickFallback(agent, current);
		if (!target) {
			this.markNoFallback(current);
			this.logger.warn('No fallback runtime available — the agent waits for its runtime to reset', { sessionName, runtime: current });
			return 'no_fallback';
		}
		const handover = await this.deps
			.writeHandover({
				sessionName,
				from: current,
				to: target,
				direction: 'switch',
				conversationId: this.deps.conversation.get(sessionName) ?? null,
				workItem: await this.deps.getActiveWorkItem(sessionName).catch(() => null),
			})
			.catch(() => null);
		await this.recordSwitch(agent, current, target, handover);
		this.logger.info('Switching agent to its fallback runtime', { sessionName, from: current, to: target, handover });
		const ok = await this.deps.relaunch(agent).catch(() => false);
		if (!ok) {
			this.logger.warn('Relaunch on the fallback runtime failed (the override stays; the next start uses it)', { sessionName, runtime: target });
			return 'failed';
		}
		return 'switched';
	}

	/**
	 * Record an override (or clear it when the target is the primary) and
	 * prepare the kickoff note.
	 *
	 * @param agent - Agent
	 * @param from - Runtime it leaves (out of usage)
	 * @param target - Runtime it goes to
	 * @param handover - Handover file, when written
	 */
	private async recordSwitch(agent: FallbackAgentInfo, from: string, target: string, handover: string | null = null): Promise<void> {
		const sessionName = agent.sessionName;
		const existing = this.state.overrides[sessionName];
		const exhausted = this.state.exhausted[from];
		// The primary's conversation is kept for the switch back; the fallback
		// runtime starts fresh.
		const primarySessionId = existing?.primarySessionId ?? (from === agent.primary ? this.deps.conversation.get(sessionName) : undefined);
		this.deps.conversation.clear(sessionName);
		if (target === agent.primary) {
			delete this.state.overrides[sessionName];
			if (primarySessionId) this.deps.conversation.set(sessionName, primarySessionId);
		} else {
			this.state.overrides[sessionName] = {
				runtime: target,
				primary: agent.primary,
				reason: 'usage_limit',
				since: existing?.since ?? new Date(this.now()).toISOString(),
				...(this.state.exhausted[agent.primary]?.until ? { until: this.state.exhausted[agent.primary].until } : {}),
				...(primarySessionId ? { primarySessionId } : {}),
			};
		}
		if (exhausted) {
			if (!exhausted.switched.includes(sessionName)) exhausted.switched.push(sessionName);
			if (!exhausted.switchedTo.includes(target)) exhausted.switchedTo.push(target);
		}
		this.save();
		const workItem = await this.deps.getActiveWorkItem(sessionName).catch(() => null);
		this.kickoffNotes.set(sessionName, this.switchNote(from, target, exhausted?.until, handover, workItem));
		this.scheduleNotice(from);
	}

	/**
	 * Wait until the agent is not mid-turn (bounded: a usage limit ends the turn anyway).
	 *
	 * @param sessionName - Session
	 */
	private async waitForSafePoint(sessionName: string): Promise<void> {
		const deadline = this.now() + C.SAFE_POINT_MAX_WAIT_MS;
		while (this.now() < deadline) {
			const busy = await this.deps.isBusy(sessionName).catch(() => false);
			if (!busy) return;
			await this.sleep(C.SAFE_POINT_POLL_MS);
		}
	}

	/**
	 * First runtime of the agent's chain that is not `current`, not out of
	 * usage, and installed + signed in.
	 *
	 * @param agent - Agent
	 * @param current - Runtime it is on (out of usage)
	 * @returns Runtime, or null
	 */
	private async pickFallback(agent: FallbackAgentInfo, current: string): Promise<string | null> {
		const available = await this.getAvailability();
		const selectable = new Set(available.filter((a) => a.selectable).map((a) => a.runtime));
		for (const runtime of this.chainFor(agent)) {
			if (runtime === current || this.state.exhausted[runtime]) continue;
			if (selectable.has(runtime)) return runtime;
		}
		return null;
	}

	/**
	 * The agent's chain: its own, or the global one.
	 *
	 * @param agent - Agent
	 * @returns Chain
	 */
	private chainFor(agent: Pick<FallbackAgentInfo, 'memberId'>): string[] {
		const own = agent.memberId ? this.state.settings.memberChains[agent.memberId] : undefined;
		return own && own.length > 0 ? own : this.state.settings.chain;
	}

	/**
	 * Whether some runtime could take over (synchronous; uses the cached
	 * availability, optimistic when nothing is cached yet).
	 *
	 * @param current - Runtime out of usage
	 * @returns True when a candidate exists
	 */
	private hasCandidateSync(current: string): boolean {
		const candidates = this.state.settings.chain.filter((r) => r !== current && !this.state.exhausted[r]);
		const memberCandidates = Object.values(this.state.settings.memberChains).flat().filter((r) => r !== current && !this.state.exhausted[r]);
		const all = [...candidates, ...memberCandidates];
		if (!this.availability) return all.length > 0;
		const selectable = new Set(this.availability.list.filter((a) => a.selectable).map((a) => a.runtime));
		return all.some((r) => selectable.has(r));
	}

	/**
	 * Availability, cached for 5 minutes.
	 *
	 * @param force - Ignore the cache
	 * @returns List
	 */
	async getAvailability(force = false): Promise<RuntimeAvailability[]> {
		const ttl = 5 * 60_000;
		if (!force && this.availability && this.now() - this.availability.at < ttl) return this.availability.list;
		try {
			const list = await this.deps.getAvailability(this.state.settings);
			this.availability = { at: this.now(), list };
			return list;
		} catch (err) {
			this.logger.warn('Could not read runtime availability', { error: err instanceof Error ? err.message : String(err) });
			return this.availability?.list ?? [];
		}
	}

	private markNoFallback(runtime: string): void {
		const exhausted = this.state.exhausted[runtime];
		if (!exhausted || exhausted.noFallback) return;
		exhausted.noFallback = true;
		this.save();
		this.scheduleNotice(runtime);
	}

	// ------------------------------------------------------------- switch back

	/**
	 * Periodic work: owner notices, switch-back checks, idle-boundary reverts.
	 */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.flushNotices();
			for (const runtime of Object.keys(this.state.exhausted)) {
				await this.checkRecovery(runtime);
			}
			await this.revertIdle();
		} catch (err) {
			this.logger.warn('Runtime fallback tick failed', { error: err instanceof Error ? err.message : String(err) });
		} finally {
			this.ticking = false;
		}
	}

	/**
	 * Is an exhausted runtime back?
	 *
	 * @param runtime - Runtime
	 */
	private async checkRecovery(runtime: string): Promise<void> {
		const entry = this.state.exhausted[runtime];
		if (!entry) return;
		const now = this.now();
		if (!this.isRecoveryCheckDue(entry, now)) return;
		const result = await this.deps.probe(runtime).catch((): ProbeResult => 'unknown');
		entry.lastProbeAt = new Date(now).toISOString();
		const until = entry.until ? Date.parse(entry.until) : null;
		const resetPassed = until !== null && now >= until;
		// Only a probe that answered normally proves the runtime works. A
		// runtime without a probe (`unsupported`) may come back on its parsed
		// reset time; a billing limit has none and never comes back on a clock.
		const back = result === 'available' || (result === 'unsupported' && entry.kind !== 'billing' && resetPassed);
		if (!back) {
			// The reset time passed but it is still limited: probe on the interval from now on.
			if (result === 'limited' && resetPassed) delete entry.until;
			this.save();
			this.logger.info(entry.kind === 'billing' ? 'Runtime is still out of credit' : 'Runtime is still out of usage', { runtime, probe: result });
			return;
		}
		await this.recover(runtime);
	}

	/**
	 * Whether a switch-back probe is due for an exhausted runtime.
	 *
	 * - `billing`: every BILLING_PROBE_INTERVAL_MS, whatever any clock says.
	 * - With a reset time: once it (plus a grace) passed.
	 * - Otherwise: on the owner's probe interval.
	 *
	 * Each failed switch-back doubles the interval (up to MAX_PROBE_BACKOFF_MS).
	 *
	 * @param entry - Exhausted runtime
	 * @param now - Current time
	 * @returns True when a probe should run now
	 */
	private isRecoveryCheckDue(entry: ExhaustedRuntime, now: number): boolean {
		const lastCheck = Date.parse(entry.lastProbeAt ?? entry.since);
		const baseMs = entry.kind === 'billing' ? C.BILLING_PROBE_INTERVAL_MS : this.state.settings.probeIntervalMinutes * 60_000;
		const backoffMs = Math.min(baseMs * 2 ** Math.min(entry.failedReverts ?? 0, 16), Math.max(baseMs, C.MAX_PROBE_BACKOFF_MS));
		const sinceLast = now - lastCheck;
		if (entry.kind === 'billing') return sinceLast >= backoffMs;
		const until = entry.until ? Date.parse(entry.until) : null;
		if (until !== null) {
			const minGap = entry.failedReverts ? backoffMs : C.RESET_GRACE_MS;
			return now >= until + C.RESET_GRACE_MS && sinceLast >= minGap;
		}
		return sinceLast >= backoffMs;
	}

	/**
	 * A runtime has usage again: mark every agent that left it for revert and tell the owner.
	 *
	 * @param runtime - Runtime
	 */
	async recover(runtime: string): Promise<void> {
		const entry = this.state.exhausted[runtime];
		if (!entry) return;
		delete this.state.exhausted[runtime];
		this.noticeDue.delete(runtime);
		this.recentRecoveries.set(runtime, { at: this.now(), failedReverts: entry.failedReverts ?? 0, notified: entry.notified });
		const reverting: RuntimeOverride[] = [];
		for (const override of Object.values(this.state.overrides)) {
			if (override.primary === runtime) {
				override.revertPending = true;
				reverting.push(override);
			}
		}
		this.save();
		this.logger.info('Runtime has usage again', { runtime, agentsToRevert: reverting.length });
		if (entry.notified && reverting.length > 0) {
			const fallbacks = [...new Set(reverting.map((o) => this.label(o.runtime)))];
			await this.notify(
				`${this.label(runtime)} is available again on ${this.deps.machineName()}. ` +
					`${agents(reverting.length)} ${reverting.length === 1 ? 'is' : 'are'} switching back from ${fallbacks.join(' / ')} as ${reverting.length === 1 ? 'it finishes its' : 'they finish their'} current turn.`,
			);
		}
		await this.revertIdle();
	}

	/** Revert every pending override whose agent is idle (or not running). */
	private async revertIdle(): Promise<void> {
		for (const [sessionName, override] of Object.entries(this.state.overrides)) {
			if (this.state.exhausted[override.primary]) continue;
			if (!override.revertPending) {
				// State from before a restart whose primary is no longer marked out of usage.
				override.revertPending = true;
				this.save();
			}
			if (this.switching.has(sessionName)) continue;
			if (!this.deps.isLive(sessionName)) {
				this.finishRevertOffline(sessionName, override);
				continue;
			}
			if (await this.deps.isBusy(sessionName).catch(() => true)) continue;
			await this.revertSession(sessionName);
		}
	}

	/**
	 * Clear the override of an agent that is not running.
	 *
	 * @param sessionName - Session
	 * @param override - Its override
	 */
	private finishRevertOffline(sessionName: string, override: RuntimeOverride): void {
		delete this.state.overrides[sessionName];
		if (override.primarySessionId) this.deps.conversation.set(sessionName, override.primarySessionId);
		else this.deps.conversation.clear(sessionName);
		this.save();
		this.logger.info('Fallback ended for a stopped agent (its next start uses its own runtime)', { sessionName, runtime: override.primary });
	}

	/**
	 * Move an idle agent back to its configured runtime.
	 *
	 * @param sessionName - Session
	 * @returns Outcome
	 */
	async revertSession(sessionName: string): Promise<SwitchOutcome> {
		if (!this.state.overrides[sessionName] || this.switching.has(sessionName)) return 'skipped';
		this.switching.add(sessionName);
		let outcome: SwitchOutcome = 'skipped';
		try {
			outcome = await this.doRevert(sessionName);
			return outcome;
		} finally {
			this.switching.delete(sessionName);
			await this.afterSwitch(sessionName, outcome, false);
		}
	}

	private async doRevert(sessionName: string): Promise<SwitchOutcome> {
		const override = this.state.overrides[sessionName];
		if (!override) return 'skipped';
		{
			// Last look right before: anything that started since means "not now".
			if (await this.deps.isBusy(sessionName).catch(() => true)) return 'skipped';
			const agent = (await this.deps.getAgent(sessionName)) ?? null;
			if (!agent) return 'skipped';
			const workItem = await this.deps.getActiveWorkItem(sessionName).catch(() => null);
			const handover = await this.deps
				.writeHandover({
					sessionName,
					from: override.runtime,
					to: override.primary,
					direction: 'revert',
					conversationId: this.deps.conversation.get(sessionName) ?? null,
					workItem,
				})
				.catch(() => null);
			delete this.state.overrides[sessionName];
			if (override.primarySessionId) this.deps.conversation.set(sessionName, override.primarySessionId);
			else this.deps.conversation.clear(sessionName);
			this.save();
			this.kickoffNotes.set(sessionName, this.revertNote(override, handover, workItem));
			this.logger.info('Switching agent back to its own runtime at an idle boundary', { sessionName, from: override.runtime, to: override.primary });
			const ok = await this.deps.relaunch(agent).catch(() => false);
			if (!ok) {
				this.logger.warn('Relaunch on the primary runtime failed (its next start uses it)', { sessionName });
				return 'failed';
			}
			return 'reverted';
		}
	}

	// ----------------------------------------------------------------- notices

	private scheduleNotice(runtime: string): void {
		const entry = this.state.exhausted[runtime];
		if (!entry || entry.notified || this.noticeDue.has(runtime)) return;
		this.noticeDue.set(runtime, this.now() + C.NOTICE_DELAY_MS);
		const t = setTimeout(() => void this.flushNotices(), C.NOTICE_DELAY_MS + 100);
		t.unref?.();
	}

	/** Send every owner notice that is due (once per event). */
	async flushNotices(): Promise<void> {
		// Events from before a restart that were never sent.
		for (const entry of Object.values(this.state.exhausted)) {
			if (!entry.notified && !this.noticeDue.has(entry.runtime) && (entry.switched.length > 0 || entry.noFallback)) {
				this.noticeDue.set(entry.runtime, this.now());
			}
		}
		for (const [runtime, due] of [...this.noticeDue]) {
			if (due > this.now()) continue;
			const entry = this.state.exhausted[runtime];
			if (!entry || entry.notified) {
				this.noticeDue.delete(runtime);
				continue;
			}
			const text = await this.limitNoticeText(entry);
			const sent = await this.notify(text);
			if (sent) {
				entry.notified = true;
				this.noticeDue.delete(runtime);
				this.save();
			}
		}
	}

	private async limitNoticeText(entry: ExhaustedRuntime): Promise<string> {
		if (entry.kind === 'billing') return this.billingNoticeText(entry);
		if (entry.kind === 'login') return this.signedOutNoticeText(entry);
		const label = this.label(entry.runtime);
		const reset = entry.until ? ` (resets ~${this.formatTime(Date.parse(entry.until))})` : '';
		const head = `${label} hit its usage limit on ${this.deps.machineName()}${reset}.`;
		const n = entry.switched.length;
		if (n === 0) {
			return `${head} No fallback runtime is available, so its agents wait until it resets. Set one in Settings → Runtimes.`;
		}
		const targets = entry.switchedTo.map((r) => this.label(r)).join(' / ');
		let text = `${head} ${agents(n)} switched to ${targets} until then.`;
		const total = this.deps.countAgentsOnRuntime ? await this.deps.countAgentsOnRuntime(entry.runtime).catch(() => n) : n;
		if (total > n) text += ' The others switch when they next get work.';
		if (entry.noFallback) text += ' Some agents had no fallback available and wait for the reset.';
		return text;
	}

	/**
	 * "Claude Code (work) is signed out on iriss-air. Reply `login claude work`
	 * to sign it in again. 2 agents switched to DeepSeek meanwhile."
	 *
	 * @param entry - The sign-out event
	 * @returns Owner message
	 */
	private signedOutNoticeText(entry: ExhaustedRuntime): string {
		const account = accountOf(entry.runtime) ?? '';
		const head = `${this.label(entry.runtime)} is signed out on ${this.deps.machineName()}. Reply \`login claude ${account}\` to sign it in again.`;
		const n = entry.switched.length;
		if (n === 0) return `${head} No other runtime is available meanwhile.`;
		const targets = entry.switchedTo.map((r) => this.label(r)).join(' / ');
		return `${head} ${agents(n)} switched to ${targets} meanwhile.`;
	}

	/**
	 * "DeepSeek is out of credit — top up at platform.deepseek.com. Orc is
	 * running on Claude Code meanwhile."
	 *
	 * @param entry - The billing event
	 * @returns Owner message
	 */
	private async billingNoticeText(entry: ExhaustedRuntime): Promise<string> {
		const label = this.label(entry.runtime);
		const url = this.topUpUrl(entry);
		const head = `${label} is out of credit — ${url ? `top up at ${url}` : 'top up its account'}.`;
		if (entry.switched.length === 0) {
			return `${head} Its agents wait until it is topped up: no fallback runtime is available (set one in Settings → Runtimes).`;
		}
		const names: string[] = [];
		for (const sessionName of entry.switched) {
			const agent = await this.deps.getAgent(sessionName).catch(() => null);
			names.push(agent?.name ?? sessionName);
		}
		const who = names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
		const targets = entry.switchedTo.map((r) => this.label(r)).join(' / ');
		let text = `${head} ${who} ${names.length === 1 ? 'is' : 'are'} running on ${targets} meanwhile.`;
		if (entry.noFallback) text += ' Some agents had no fallback available and wait for the top-up.';
		return text;
	}

	/**
	 * Where to top up the account behind a billing limit.
	 *
	 * @param entry - The billing event
	 * @returns Host/path, or null when unknown
	 */
	private topUpUrl(entry: ExhaustedRuntime): string | null {
		let provider: string | null = null;
		if (baseRuntimeOf(entry.runtime) === RUNTIME_TYPES.CLAUDE_CODE) provider = 'anthropic';
		else if (entry.runtime === RUNTIME_TYPES.CODEX_CLI) provider = 'openai';
		else if (entry.runtime === RUNTIME_TYPES.CREWLY_AGENT) {
			// "Insufficient Balance" is DeepSeek's wording.
			if (entry.ruleId.endsWith('insufficient_balance')) provider = 'deepseek';
			else provider = this.state.settings.crewlyAgentModel.split('/')[0] ?? null;
		}
		return provider ? (C.TOP_UP_URLS[provider] ?? null) : null;
	}

	private async notify(text: string): Promise<boolean> {
		const notifier = this.deps.notifier?.() ?? null;
		if (!notifier) return false;
		try {
			const delivered = await notifier.sendToOwner(text);
			return delivered !== false;
		} catch {
			return false;
		}
	}

	// -------------------------------------------------------------------- text

	private formatTime(epochMs: number): string {
		const tz = this.deps.timeZone;
		const sameDay = new Date(epochMs).toDateString() === new Date(this.now()).toDateString() && epochMs - this.now() < 24 * 3600_000;
		return new Intl.DateTimeFormat('en-US', {
			...(sameDay ? {} : { month: 'short', day: 'numeric' }),
			hour: 'numeric',
			minute: '2-digit',
			timeZoneName: 'short',
			...(tz ? { timeZone: tz } : {}),
		}).format(new Date(epochMs));
	}

	private switchNote(from: string, to: string, until: string | undefined, handover: string | null, workItem: { id: string; title: string } | null): string {
		const reset = until ? ` (it resets ~${this.formatTime(Date.parse(until))})` : '';
		const kind = this.state.exhausted[from]?.kind;
		const parts = [
			kind === 'billing'
				? `Crewly moved you from ${this.label(from)} to ${this.label(to)} because ${this.label(from)} is out of credit; you will be moved back once it is topped up.`
				: kind === 'login'
					? `Crewly moved you from ${this.label(from)} to ${this.label(to)} because the ${this.label(from)} login expired.`
					: `Crewly moved you from ${this.label(from)} to ${this.label(to)} because ${this.label(from)} hit its usage limit${reset}; you will be moved back when it resets.`,
			handover
				? `This is a fresh conversation: after registering, read ${handover} once — it holds the end of your previous conversation.`
				: 'This is a fresh conversation: your tasks, teams and wiki are all still in Crewly.',
		];
		if (workItem) parts.push(`Then continue WorkItem ${workItem.id} ("${workItem.title}") where you left off.`);
		return parts.join(' ');
	}

	private revertNote(override: RuntimeOverride, handover: string | null, workItem: { id: string; title: string } | null): string {
		const parts = [
			`${this.label(override.primary)} is available again, so Crewly moved you back from ${this.label(override.runtime)}.`,
			handover
				? `Work went on while you were away: read ${handover} once for what happened since.`
				: 'Work went on while you were away: check your WorkItems and wiki for what happened since.',
		];
		if (workItem) parts.push(`Then continue WorkItem ${workItem.id} ("${workItem.title}").`);
		return parts.join(' ');
	}

	// ---------------------------------------------------------------- snapshot

	/**
	 * Badge data for an agent running on a fallback.
	 *
	 * @param sessionName - Session
	 * @returns Override view, or null
	 */
	overrideView(sessionName: string): RuntimeOverrideView | null {
		const override = this.state.overrides[sessionName];
		if (!override) return null;
		const label = this.label(override.runtime);
		return {
			...override,
			sessionName,
			runtimeLabel: label,
			primaryLabel: this.label(override.primary),
			badge: `on ${label} (${runtimeShortLabel(override.primary)} limit)`,
		};
	}

	/**
	 * Everything the API shows.
	 *
	 * @returns Snapshot
	 */
	async snapshot(): Promise<RuntimeFallbackSnapshot> {
		const runtimes = (await this.getAvailability()).map((a) => ({ ...a, exhausted: Boolean(this.state.exhausted[a.runtime]) }));
		return {
			settings: this.getSettings(),
			runtimes,
			exhausted: Object.values(this.state.exhausted).map((e) => ({ ...e })),
			overrides: Object.keys(this.state.overrides)
				.map((s) => this.overrideView(s))
				.filter((v): v is RuntimeOverrideView => v !== null),
		};
	}

	// ------------------------------------------------------------------ helpers

	private label(runtime: string): string {
		return runtimeLabel(runtime, this.state.settings.crewlyAgentModel);
	}

	private decision(target: string): LaunchRuntimeDecision {
		const { runtime, account } = parseRuntimeTarget(target);
		return {
			runtime,
			overridden: true,
			...(account ? { claudeAccount: account } : {}),
			...(runtime === RUNTIME_TYPES.CREWLY_AGENT ? { crewlyAgentModel: this.state.settings.crewlyAgentModel } : {}),
		};
	}

	private isExempt(sessionName: string): boolean {
		if (this.deps.isExempt) return this.deps.isExempt(sessionName);
		return sessionName.startsWith(C.SMOKE.TEAM_PREFIX);
	}

	private save(): void {
		try {
			this.deps.store.save(this.state);
		} catch (err) {
			this.logger.warn('Could not save runtime-fallback state', { error: err instanceof Error ? err.message : String(err) });
		}
	}
}

/** The backend's instance (set by the wiring at boot). */
let backendInstance: RuntimeFallbackService | null = null;

/**
 * The running backend's runtime-fallback service.
 *
 * @returns The instance, or null before boot wired it (and in tests)
 */
export function getRuntimeFallbackService(): RuntimeFallbackService | null {
	return backendInstance;
}

/**
 * Set (or clear) the backend instance.
 *
 * @param service - Instance, or null
 */
export function setRuntimeFallbackService(service: RuntimeFallbackService | null): void {
	backendInstance = service;
}
