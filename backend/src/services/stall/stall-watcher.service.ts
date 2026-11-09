/**
 * Stall watcher (crewly#1363, crewly#1362, specs/2026-10-17-stall-watcher.md).
 *
 * Stalls used to be a metric only (`TRACE_CONSTANTS.STALL_MINUTES`). This
 * service acts on three kinds of in-flight work, each keyed to the agent's
 * own estimate when it gave one:
 *
 * - **Promises to the owner** (open-items commitments): at 1.5× the estimate
 *   past the promise with nothing posted, the agent is re-briefed once with
 *   the last message from someone else before the promise (the approval it
 *   may be re-waiting for, crewly#1361); at 3× the team lead is told once;
 *   when the lead has not answered in the thread within LEAD_GRACE_MS, the
 *   owner gets one plain line (at most one per item per day).
 * - **Claimed WorkItems**: the run trace's ongoing stall (no tool calls,
 *   posts or worktree changes for CLAIM_STALL_MS) nudges the claimer once
 *   with the cause; a second window with no progress releases the claim
 *   (unassigned, so the route sweep hands it to the lead and then the
 *   orchestrator) and tells the lead. Tickets the ticket autopilot already
 *   watches are left to it.
 * - **Background runs**: an agent saying it started something that takes a
 *   while ("已经开跑…预计 1 小时左右") is recorded in
 *   `CREWLY_HOME/in-flight-runs.json`; the agent is protected from idle stops
 *   and evictions until expectedBy + grace; the same ladder as promises
 *   applies when nothing (a file, a link, a finished / failed report) lands in
 *   the thread.
 *
 * Plus the claim check (crewly#1362): "X is doing it" told to the owner with
 * no WorkItem or ticket for X within CLAIM_CHECK_WINDOW_MS gets the speaker
 * one internal line; the owner hears nothing.
 *
 * Cost control: every line to an agent is one line and tagged; one nudge per
 * agent per NUDGE_COOLDOWN_MS; the owner is never the retry loop. The first
 * ARM_DELAY_MS after the first pass is a dry run (logs only).
 *
 * @module services/stall/stall-watcher.service
 */

import { STALL_WATCHER_CONSTANTS } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TaskClaim } from '../../types/v2/claim.types.js';
import { ACTIVE_OPEN_ITEM_STATUSES, type RequestOpenItem } from '../../types/v2/open-item.types.js';
import type { StallCause } from '../trace/trace-metrics.js';
import { STALL_CAUSE_LABELS } from '../trace/trace-timeline.js';
import { isInterim } from '../slack/slack-typing-placeholder.service.js';
import { detectBackgroundRun, hasDeliverable, isRunFinishedReport } from './background-run-detector.js';
import { claimNudgeText, detectTeammateClaims, type ClaimableMember } from './claim-check.js';
import { emptyState, pruneState, type InFlightRun, type InFlightRunsStore, type LadderState, type PendingClaim, type StallWatcherState } from './in-flight-runs.store.js';

const C = STALL_WATCHER_CONSTANTS;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A chat-v2 message as the watcher reads it (from the thread or the live event). */
export interface StallThreadMessage {
	id: string;
	senderType: string;
	senderId: string;
	content: string;
	/** Epoch ms */
	createdAt: number;
	/** Attachments on the post */
	attachmentCount?: number;
	metadata?: Record<string, unknown>;
}

/** A live chat-v2 message (the `chat_message` event). */
export interface StallIncomingMessage extends StallThreadMessage {
	channelId: string;
	/** Thread root; absent for a root post */
	threadId?: string;
}

/** Where a conversation lives in chat-v2. */
export interface StallThreadRef {
	channelId: string;
	threadId: string;
}

/** An ongoing stall on a trace, as the traces service sees it. */
export interface StallSignal {
	/** Length of the gap so far (ms) */
	ms: number;
	cause: StallCause;
	detail: string;
}

/** A step of the ladder. */
export type LadderStep = 'agent' | 'lead' | 'owner';

/** The owner's language, read from the owner's own messages in the thread. */
export type OwnerLanguage = 'zh' | 'en';

/** The boot-pressure gate (same shape as the wiki maintenance one). */
export type StallBootGate = () => Promise<{ reduced: boolean; waitedMs: number; reason?: string }>;

/** Collaborators. */
export interface StallWatcherDeps {
	/** Every request (tickets with open items) */
	listRequests: () => Promise<Request[]>;
	/** Every WorkItem */
	listWorkItems: () => Promise<WorkItem[]>;
	/** Active claims (running items with a holder) */
	activeClaims: () => Promise<TaskClaim[]>;
	/** WorkItems that belong to an in-progress project ticket (the ticket autopilot watches those) */
	ticketLinkedWorkItemIds?: () => Promise<ReadonlySet<string>>;
	/** Every message of a thread, oldest first */
	threadMessages: (ref: StallThreadRef) => Promise<StallThreadMessage[]>;
	/** The ongoing stall of the trace a claimed item (or its holder) is on, or null when it is moving */
	stallOf: (ref: { workItemId: string; session: string }) => Promise<StallSignal | null>;
	/** Release a stalled claim: the item goes back to the queue, unassigned */
	releaseClaim: (workItemId: string, reason: string) => Promise<void>;
	/** One line to an agent (wakes it); false when it could not be delivered */
	deliverToAgent: (session: string, text: string) => Promise<boolean>;
	/** The agent's team lead, or null */
	leadOf: (session: string) => Promise<string | null>;
	/** Display name ("Pia") */
	displayName: (session: string) => Promise<string>;
	/** One plain line to the owner (the owner-alert notifier); false when not sent */
	notifyOwner: (line: string) => Promise<boolean>;
	/** Called once after the owner was told an agent's work stalled (who only; the weekly owner-pulls count, #1387) */
	onOwnerTold?: (agent: string) => void;
	/** Stamp a ladder step on an open-items commitment, so the open-items sweep does not repeat it */
	recordPromiseStep: (requestId: string, itemId: string, step: LadderStep, at: Date) => Promise<void>;
	/** The speaker's teammates (for "X is doing it") */
	teammatesOf: (session: string) => Promise<ClaimableMember[]>;
	/** A WorkItem or ticket for `member`, created by `speaker` or the harness, within ±windowMs of `saidAt` */
	assignmentExists: (speaker: string, member: string, saidAt: number, windowMs: number) => Promise<boolean>;
	/** Whether a live message is a reply to the owner (claims elsewhere are not checked); absent = every agent post */
	isOwnerThread?: (message: StallIncomingMessage) => Promise<boolean>;
	/** Record a harness nudge on the session's trace */
	trace?: (input: { session: string; summary: string; workItemId?: string; data?: Record<string, unknown> }) => void;
	bootGate?: StallBootGate;
	store: InFlightRunsStore;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	logger?: ComponentLogger;
}

/** What one pass did. */
export interface StallTickResult {
	/** Set when the pass did not run */
	skipped?: 'disabled';
	dryRun: boolean;
	promises: { agent: number; lead: number; owner: number };
	claims: { nudged: number; released: number };
	runs: { agent: number; lead: number; owner: number; cleared: number };
	teammateClaims: { checked: number; nudged: number };
}

/** One item the ladder runs over. */
interface LadderItem {
	key: string;
	agent: string;
	/** When the promise was made / the run started (ms) */
	madeAt: number;
	estimateMs: number;
	thread: StallThreadRef | null;
	/** Stamps from elsewhere (the open-items sweep) that count as steps already taken */
	prior?: { agentAt?: number; leadAt?: number; ownerAt?: number; recentNudgeAt?: number };
	agentText: () => Promise<string>;
	leadText: (leadName: string) => Promise<string>;
	ownerLine: (lang: OwnerLanguage, leadName: string | null) => Promise<string>;
	onStep?: (step: LadderStep, at: Date) => Promise<void>;
	workItemId?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Clip text to one line of at most `max` characters.
 *
 * @param text - Text
 * @param max - Max characters
 * @returns Clipped text
 */
export function clip(text: string, max: number): string {
	const one = (text ?? '').replace(/\s+/g, ' ').trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * A duration in words, in the owner's language.
 *
 * @param ms - Milliseconds
 * @param lang - Language
 * @returns "40 分钟" / "1.5 小时" / "40 minutes" / "1.5 hours"
 */
export function durationWords(ms: number, lang: OwnerLanguage = 'en'): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return lang === 'zh' ? `${minutes} 分钟` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
	const hours = Math.round((minutes / 60) * 10) / 10;
	if (hours < 48) return lang === 'zh' ? `${hours} 小时` : `${hours} hour${hours === 1 ? '' : 's'}`;
	const days = Math.round((hours / 24) * 10) / 10;
	return lang === 'zh' ? `${days} 天` : `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The owner's language in a thread: Chinese when the owner's own messages
 * hold more CJK characters than Latin letters, else English (CLAUDE.md:
 * harness text is English; a line to the owner follows the owner).
 *
 * @param messages - The thread
 * @returns 'zh' or 'en'
 */
export function ownerLanguage(messages: readonly StallThreadMessage[]): OwnerLanguage {
	let cjk = 0;
	let latin = 0;
	for (const m of messages) {
		if (m.senderType !== 'user') continue;
		cjk += (m.content.match(/[぀-ヿ㐀-䶿一-鿿]/g) ?? []).length;
		latin += (m.content.match(/[a-z]/gi) ?? []).length;
	}
	return cjk > 0 && cjk >= latin ? 'zh' : 'en';
}

/**
 * The last message by someone other than the agent before a time: the
 * approval or instruction the promise answered (crewly#1361 expectation 2).
 *
 * @param messages - The thread
 * @param agent - The promising agent
 * @param before - Epoch ms of the promise
 * @returns That message, or null
 */
export function contextBefore(messages: readonly StallThreadMessage[], agent: string, before: number): StallThreadMessage | null {
	let found: StallThreadMessage | null = null;
	for (const m of messages) {
		if (m.createdAt >= before || m.senderId === agent || m.senderType === 'system' || !m.content.trim()) continue;
		if (!found || m.createdAt > found.createdAt) found = m;
	}
	return found;
}

/**
 * Whether a run's agent posted a deliverable or a finished / failed report in
 * the thread after the run started.
 *
 * @param messages - The thread
 * @param run - The run
 * @returns True when the run is over as far as the thread shows
 */
export function runDeliveredIn(messages: readonly StallThreadMessage[], run: Pick<InFlightRun, 'agent' | 'startedAt' | 'id'>): boolean {
	return messages.some(
		(m) =>
			m.senderType === 'agent' &&
			m.senderId === run.agent &&
			m.id !== run.id &&
			m.createdAt > run.startedAt &&
			!isInterim(m) &&
			(hasDeliverable({ content: m.content, ...(m.attachmentCount !== undefined ? { attachmentCount: m.attachmentCount } : {}) }) || isRunFinishedReport(m.content)),
	);
}

/**
 * The time each ladder step is due.
 *
 * @param madeAt - Promise / run start (ms)
 * @param estimateMs - The agent's estimate
 * @returns Due times (ms)
 */
export function ladderDue(madeAt: number, estimateMs: number): { agentDue: number; leadDue: number } {
	return {
		agentDue: madeAt + Math.max(C.AGENT_STEP_MULTIPLIER * estimateMs, C.MIN_AGENT_STEP_MS),
		leadDue: madeAt + Math.max(C.LEAD_STEP_MULTIPLIER * estimateMs, C.MIN_AGENT_STEP_MS + C.LEAD_GRACE_MS),
	};
}

/**
 * The idle-stop / eviction protection reason for a session with a run in
 * flight, or null.
 *
 * @param runs - Recorded runs
 * @param session - Agent session
 * @param now - Epoch ms
 * @returns English reason, or null
 */
export function runProtectionReason(runs: readonly InFlightRun[], session: string, now: number): string | null {
	const run = runs.find((r) => r.agent === session && now < r.expectedBy + C.RUN_PROTECTION_GRACE_MS);
	if (!run) return null;
	return `a background run it announced ("${clip(run.head, C.QUOTE_MAX_CHARS)}") is expected by ${new Date(run.expectedBy).toISOString()}`;
}

/**
 * Whether the watcher is switched on.
 *
 * @param env - Environment
 * @returns False when CREWLY_STALL_WATCHER=false
 */
export function stallWatcherEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env[C.ENV_KILL_SWITCH] ?? '').trim().toLowerCase() !== 'false';
}

/**
 * Whether a pass is a dry run: CREWLY_STALL_WATCHER_DRY_RUN=true/false wins;
 * otherwise dry until ARM_DELAY_MS after the first pass.
 *
 * @param armedAt - When the first pass ran (ms), or undefined
 * @param now - Epoch ms
 * @param env - Environment
 * @returns True to only log
 */
export function stallWatcherDryRun(armedAt: number | undefined, now: number, env: NodeJS.ProcessEnv = process.env): boolean {
	const forced = (env[C.ENV_DRY_RUN] ?? '').trim().toLowerCase();
	if (forced === 'true' || forced === '1') return true;
	if (forced === 'false' || forced === '0') return false;
	return armedAt === undefined || now - armedAt < C.ARM_DELAY_MS;
}

/**
 * The agent-facing stall cause: the trace's label plus its detail.
 *
 * @param signal - Stall signal
 * @returns One clause
 */
export function causeText(signal: StallSignal): string {
	const label = STALL_CAUSE_LABELS[signal.cause] ?? signal.cause;
	const detail = clip(signal.detail, C.QUOTE_MAX_CHARS);
	return detail && detail.toLowerCase() !== label.toLowerCase() ? `${label} (${detail})` : label;
}

/**
 * The one plain line the owner gets about a promise.
 *
 * @param lang - Owner's language
 * @param input - Names and times
 * @returns The line
 */
export function promiseOwnerLine(lang: OwnerLanguage, input: { name: string; what: string; estimateMs: number; elapsedMs: number; leadName: string | null }): string {
	const est = durationWords(input.estimateMs, lang);
	const elapsed = durationWords(input.elapsedMs, lang);
	if (lang === 'zh') {
		const asked = input.leadName ? `也问了 ${input.leadName}` : '团队里没有负责人可问';
		return `${input.name} 说大约 ${est} 内给「${input.what}」，现在过了 ${elapsed} 还没有，已经提醒过 ${input.name}，${asked}。`;
	}
	const asked = input.leadName ? `I asked ${input.leadName}` : 'there is no team lead to ask';
	return `${input.name} said "${input.what}" would come in about ${est}; ${elapsed} later nothing has arrived. ${input.name} has been reminded and ${asked}.`;
}

/**
 * Whether an open item is an owner decision asked in prose that has no card
 * (crewly#1369): it is followed up on the promise ladder.
 *
 * @param item - Open item
 * @returns True for an uncarded owner question with a due time
 */
export function isUncardedOwnerQuestion(item: RequestOpenItem): boolean {
	return item.type === 'question' && item.ownerQuestion === true && !item.decisionId && !!item.due;
}

/**
 * The one plain line the owner gets about a question still waiting on him.
 *
 * @param lang - Owner's language
 * @param input - Name, question, time since
 * @returns The line
 */
export function questionOwnerLine(lang: OwnerLanguage, input: { name: string; what: string; elapsedMs: number }): string {
	const elapsed = durationWords(input.elapsedMs, lang);
	if (lang === 'zh') return `${input.name} ${elapsed}前问你：「${input.what}」还没有你的回答。回一句就行，或者说「不用了」。`;
	return `${input.name} asked you ${elapsed} ago: "${input.what}" — there is no answer from you yet. One line is enough, or say "skip".`;
}

/**
 * The one plain line the owner gets about a background run.
 *
 * @param lang - Owner's language
 * @param input - Names and times
 * @returns The line
 */
export function runOwnerLine(lang: OwnerLanguage, input: { name: string; head: string; estimateMs: number; elapsedMs: number; leadName: string | null }): string {
	const est = durationWords(input.estimateMs, lang);
	const elapsed = durationWords(input.elapsedMs, lang);
	if (lang === 'zh') {
		const asked = input.leadName ? `也问了 ${input.leadName}` : '团队里没有负责人可问';
		return `${input.name} 说「${input.head}」大约 ${est}，现在过了 ${elapsed} 还没有结果，已经提醒过 ${input.name}，${asked}。`;
	}
	const asked = input.leadName ? `I asked ${input.leadName}` : 'there is no team lead to ask';
	return `${input.name} said "${input.head}" (about ${est}); ${elapsed} later there is no result in the thread. ${input.name} has been reminded and ${asked}.`;
}

/**
 * ISO → epoch ms, NaN-safe.
 *
 * @param iso - ISO string
 * @returns Epoch ms, or null
 */
function ms(iso: string | undefined): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Process-wide instance. */
let instance: StallWatcherService | null = null;

/**
 * The running watcher, if any.
 *
 * @returns The service, or null
 */
export function getStallWatcher(): StallWatcherService | null {
	return instance;
}

/**
 * Install (or clear) the process-wide watcher.
 *
 * @param service - The service, or null
 */
export function setStallWatcher(service: StallWatcherService | null): void {
	instance = service;
}

/**
 * Watches in-flight work and climbs the agent → lead → owner ladder.
 */
export class StallWatcherService {
	private readonly logger: ComponentLogger;
	private readonly now: () => number;
	private readonly env: NodeJS.ProcessEnv;
	private state: StallWatcherState = emptyState();
	private loaded = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private bootTimer: ReturnType<typeof setTimeout> | null = null;
	private chain: Promise<unknown> = Promise.resolve();

	/**
	 * @param deps - Collaborators
	 */
	constructor(private readonly deps: StallWatcherDeps) {
		this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('StallWatcher');
		this.now = deps.now ?? (() => Date.now());
		this.env = deps.env ?? process.env;
	}

	/**
	 * Whether the kill switch is off.
	 *
	 * @returns True when the watcher may run
	 */
	enabled(): boolean {
		return stallWatcherEnabled(this.env);
	}

	/**
	 * Load the state file, then schedule the first pass (after the boot
	 * gate and BOOT_DELAY_MS) and the periodic passes. No-op when disabled.
	 */
	start(): void {
		if (!this.enabled()) {
			this.logger.info('Stall watcher disabled by environment', { env: C.ENV_KILL_SWITCH });
			return;
		}
		if (this.timer) return;
		void this.load();
		this.bootTimer = setTimeout(() => {
			this.bootTimer = null;
			void this.bootTick();
		}, C.BOOT_DELAY_MS);
		this.bootTimer.unref?.();
		this.timer = setInterval(() => void this.tick().catch((err) => this.logger.warn('Stall watcher pass failed', { error: errText(err) })), C.INTERVAL_MS);
		this.timer.unref?.();
		this.logger.info('Stall watcher started', { intervalMs: C.INTERVAL_MS, bootDelayMs: C.BOOT_DELAY_MS, stateFile: this.deps.store.path });
	}

	/** Stop the passes. Safe to call more than once. */
	stop(): void {
		if (this.bootTimer) {
			clearTimeout(this.bootTimer);
			this.bootTimer = null;
		}
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Read the state file once (later passes keep the in-memory copy).
	 *
	 * @returns The state
	 */
	async load(): Promise<StallWatcherState> {
		if (!this.loaded) {
			this.state = await this.deps.store.load();
			this.loaded = true;
		}
		return this.state;
	}

	/**
	 * The first pass: waits at the boot-pressure gate like the other
	 * maintenance passes, then ticks.
	 *
	 * @returns What the pass did
	 */
	async bootTick(): Promise<StallTickResult> {
		if (this.deps.bootGate) {
			try {
				const gate = await this.deps.bootGate();
				if (gate.waitedMs > 0) this.logger.info('Stall watcher boot pass waited for a quiet machine', { waitedMs: gate.waitedMs, reduced: gate.reduced, reason: gate.reason });
			} catch (err) {
				this.logger.warn('Stall watcher boot gate failed (running anyway)', { error: errText(err) });
			}
		}
		return this.tick();
	}

	/**
	 * Why an agent must not be idle-stopped or evicted right now: a run it
	 * announced is still expected. Synchronous, from the in-memory state.
	 *
	 * @param session - Agent session
	 * @returns English reason, or null
	 */
	protectedRunReason(session: string): string | null {
		return runProtectionReason(this.state.runs, session, this.now());
	}

	/**
	 * The runs recorded for a session (tests and the status endpoint).
	 *
	 * @param session - Agent session
	 * @returns Runs, newest last
	 */
	runsOf(session: string): InFlightRun[] {
		return this.state.runs.filter((r) => r.agent === session);
	}

	/**
	 * A chat-v2 message arrived. Agent posts can start a background run,
	 * close one (a deliverable or a finished / failed report in its thread)
	 * or claim that a teammate is doing something. Other posts are ignored
	 * here; the lead's answer is read from the thread when the ladder needs it.
	 *
	 * @param message - The message
	 */
	onMessage(message: StallIncomingMessage): Promise<void> {
		if (!this.enabled() || message.senderType !== 'agent') return Promise.resolve();
		return this.serial(async () => {
			await this.load();
			const now = this.now();
			const threadId = message.threadId ?? message.id;
			let changed = false;
			// Close runs this post delivers.
			const done = this.state.runs.filter(
				(r) =>
					r.agent === message.senderId &&
					r.channelId === message.channelId &&
					r.threadId === threadId &&
					r.id !== message.id &&
					(hasDeliverable({ content: message.content, ...(message.attachmentCount !== undefined ? { attachmentCount: message.attachmentCount } : {}) }) || isRunFinishedReport(message.content)),
			);
			if (done.length > 0) {
				this.state.runs = this.state.runs.filter((r) => !done.includes(r));
				for (const r of done) delete this.state.ladders[`run:${r.id}`];
				this.logger.info('Background run closed by the agent\'s post', { agent: message.senderId, runs: done.map((r) => r.id), message: message.id });
				changed = true;
			}
			// A new run.
			if (!isInterim(message)) {
				const run = detectBackgroundRun(message.content);
				const already = this.state.runs.some((r) => r.agent === message.senderId && r.channelId === message.channelId && r.threadId === threadId);
				if (run && !already) {
					const estimateMs = run.estimateMs ?? C.RUN_DEFAULT_ESTIMATE_MS;
					this.state.runs.push({
						id: message.id,
						agent: message.senderId,
						channelId: message.channelId,
						threadId,
						head: run.head,
						startedAt: message.createdAt,
						estimateMs,
						estimateSource: run.estimateMs !== null ? 'text' : 'default',
						expectedBy: message.createdAt + estimateMs,
					});
					this.logger.info('Background run registered', { agent: message.senderId, message: message.id, estimateMs, expectedBy: new Date(message.createdAt + estimateMs).toISOString() });
					changed = true;
				}
			}
			// "X is doing it" to the owner.
			if (!isInterim(message) && ((await this.deps.isOwnerThread?.(message).catch(() => false)) ?? true)) {
				const teammates = await this.deps.teammatesOf(message.senderId).catch(() => [] as ClaimableMember[]);
				for (const claim of detectTeammateClaims(message.content, teammates, message.senderId)) {
					const pending = this.state.claims.some((c) => c.speaker === message.senderId && c.member === claim.member && Math.abs(c.saidAt - message.createdAt) < C.CLAIM_CHECK_WINDOW_MS);
					if (pending) continue;
					this.state.claims.push({ id: message.id, speaker: message.senderId, member: claim.member, memberName: claim.memberName, saidAt: message.createdAt, head: claim.sentence });
					this.logger.info('Teammate claim noted for a check', { speaker: message.senderId, member: claim.member, message: message.id });
					changed = true;
				}
			}
			if (changed) {
				pruneState(this.state, now);
				await this.deps.store.save(this.state).catch((err) => this.logger.warn('Stall watcher state not saved', { error: errText(err) }));
			}
		});
	}

	/**
	 * One pass over every kind of in-flight work.
	 *
	 * @returns What the pass did
	 */
	tick(): Promise<StallTickResult> {
		return this.serial(() => this.pass());
	}

	/**
	 * Run `fn` after every earlier change to the state (one writer).
	 *
	 * @param fn - Work
	 * @returns Its result
	 */
	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => undefined);
		return run;
	}

	/**
	 * The pass itself (under {@link serial}).
	 *
	 * @returns What it did
	 */
	private async pass(): Promise<StallTickResult> {
		const result: StallTickResult = {
			dryRun: false,
			promises: { agent: 0, lead: 0, owner: 0 },
			claims: { nudged: 0, released: 0 },
			runs: { agent: 0, lead: 0, owner: 0, cleared: 0 },
			teammateClaims: { checked: 0, nudged: 0 },
		};
		if (!this.enabled()) return { ...result, skipped: 'disabled' };
		await this.load();
		const now = this.now();
		if (this.state.armedAt === undefined) {
			this.state.armedAt = now;
			this.logger.info('Stall watcher armed: dry run (logs only) until the arm delay passes', { armedAt: new Date(now).toISOString(), armDelayMs: C.ARM_DELAY_MS });
		}
		const dry = stallWatcherDryRun(this.state.armedAt, now, this.env);
		result.dryRun = dry;
		pruneState(this.state, now);

		await this.promisesPass(now, dry, result).catch((err) => this.logger.warn('Stall watcher promises pass failed', { error: errText(err) }));
		await this.claimsPass(now, dry, result).catch((err) => this.logger.warn('Stall watcher claims pass failed', { error: errText(err) }));
		await this.runsPass(now, dry, result).catch((err) => this.logger.warn('Stall watcher runs pass failed', { error: errText(err) }));
		await this.teammateClaimsPass(now, dry, result).catch((err) => this.logger.warn('Stall watcher claim-check pass failed', { error: errText(err) }));

		await this.deps.store.save(this.state).catch((err) => this.logger.warn('Stall watcher state not saved', { error: errText(err) }));
		const acted =
			result.promises.agent + result.promises.lead + result.promises.owner + result.claims.nudged + result.claims.released + result.runs.agent + result.runs.lead + result.runs.owner + result.runs.cleared + result.teammateClaims.nudged;
		if (acted > 0) this.logger.info(dry ? 'Stall watcher pass (dry run, nothing sent)' : 'Stall watcher pass', { ...result });
		return result;
	}

	// -------------------------------------------------------------------------
	// Sending (every path honours the dry run and the per-agent cooldown)
	// -------------------------------------------------------------------------

	/**
	 * One line to an agent, at most one per agent per NUDGE_COOLDOWN_MS.
	 *
	 * @param agent - Session
	 * @param text - The line
	 * @param now - Epoch ms
	 * @param dry - Dry run: log only
	 * @param recentNudgeAt - A nudge from elsewhere that counts for the cooldown
	 * @returns What happened
	 */
	private async nudgeAgent(agent: string, text: string, now: number, dry: boolean, recentNudgeAt?: number): Promise<'sent' | 'dry' | 'cooldown' | 'failed'> {
		const last = Math.max(this.state.lastNudgeByAgent[agent] ?? 0, recentNudgeAt ?? 0);
		if (last && now - last < C.NUDGE_COOLDOWN_MS) return 'cooldown';
		if (dry) {
			this.logger.info('Dry run: would nudge agent', { agent, text });
			return 'dry';
		}
		const ok = await this.deps.deliverToAgent(agent, text).catch(() => false);
		if (!ok) return 'failed';
		this.state.lastNudgeByAgent[agent] = now;
		return 'sent';
	}

	/**
	 * One line to an agent's lead.
	 *
	 * @param agent - The agent whose lead is told
	 * @param text - The line (built with the lead's name)
	 * @param dry - Dry run
	 * @returns The lead session when told (or would be), null when there is no lead or it failed
	 */
	private async tellLead(agent: string, text: (leadName: string) => Promise<string>, dry: boolean): Promise<string | null> {
		const lead = await this.deps.leadOf(agent).catch(() => null);
		if (!lead || lead === agent) return null;
		const line = await text(await this.name(lead));
		if (dry) {
			this.logger.info('Dry run: would tell the lead', { agent, lead, text: line });
			return lead;
		}
		const ok = await this.deps.deliverToAgent(lead, line).catch(() => false);
		return ok ? lead : null;
	}

	/**
	 * Display name of a session (falls back to the session).
	 *
	 * @param session - Session
	 * @returns Name
	 */
	private async name(session: string): Promise<string> {
		return (await this.deps.displayName(session).catch(() => session)) || session;
	}

	// -------------------------------------------------------------------------
	// The ladder
	// -------------------------------------------------------------------------

	/**
	 * Climb one step of the ladder for an item, when it is due.
	 *
	 * @param item - The item
	 * @param now - Epoch ms
	 * @param dry - Dry run
	 * @returns The step taken, or null
	 */
	private async climb(item: LadderItem, now: number, dry: boolean): Promise<LadderStep | null> {
		const ladder: LadderState = (this.state.ladders[item.key] ??= { seenAt: now });
		ladder.seenAt = now;
		const agentAt = ladder.agentAt ?? item.prior?.agentAt;
		const leadAt = ladder.leadAt ?? item.prior?.leadAt;
		const ownerAt = ladder.ownerAt ?? item.prior?.ownerAt;
		const { agentDue, leadDue } = ladderDue(item.madeAt, item.estimateMs);

		if (!agentAt) {
			if (now < agentDue) return null;
			const outcome = await this.nudgeAgent(item.agent, await item.agentText(), now, dry, item.prior?.recentNudgeAt);
			if (outcome === 'cooldown' || outcome === 'failed') {
				this.logger.debug('Stall ladder: agent step deferred', { key: item.key, outcome });
				return null;
			}
			ladder.agentAt = now;
			this.deps.trace?.({ session: item.agent, summary: `Stall watcher: ${item.key} re-briefed at ${Math.round((now - item.madeAt) / 60_000)} min`, ...(item.workItemId ? { workItemId: item.workItemId } : {}), data: { reason: 'stall', step: 'agent', key: item.key, dryRun: dry } });
			if (!dry) await item.onStep?.('agent', new Date(now)).catch(() => undefined);
			this.logger.info('Stall ladder: agent re-briefed', { key: item.key, agent: item.agent, dryRun: dry });
			return 'agent';
		}
		if (!leadAt) {
			if (now < leadDue) return null;
			const lead = await this.tellLead(item.agent, item.leadText, dry);
			ladder.leadAt = now;
			ladder.leadSession = lead ?? undefined;
			this.deps.trace?.({ session: item.agent, summary: `Stall watcher: ${item.key} escalated to ${lead ?? 'no lead'}`, ...(item.workItemId ? { workItemId: item.workItemId } : {}), data: { reason: 'stall', step: 'lead', key: item.key, dryRun: dry } });
			if (!dry) await item.onStep?.('lead', new Date(now)).catch(() => undefined);
			this.logger.info('Stall ladder: lead told', { key: item.key, agent: item.agent, lead, dryRun: dry });
			return 'lead';
		}
		if (now < leadAt + C.LEAD_GRACE_MS) return null;
		if (ownerAt && now - ownerAt < C.OWNER_LINE_INTERVAL_MS) return null;
		const lead = ladder.leadSession ?? (await this.deps.leadOf(item.agent).catch(() => null));
		const messages = item.thread ? await this.deps.threadMessages(item.thread).catch(() => [] as StallThreadMessage[]) : [];
		if (lead && messages.some((m) => m.senderId === lead && m.createdAt > leadAt)) {
			this.logger.info('Stall ladder: the lead answered in the thread; the owner is not told', { key: item.key, lead });
			return null;
		}
		const line = await item.ownerLine(ownerLanguage(messages), lead ? await this.name(lead) : null);
		if (dry) {
			this.logger.info('Dry run: would tell the owner', { key: item.key, text: line });
		} else {
			const ok = await this.deps.notifyOwner(line).catch(() => false);
			if (!ok) {
				this.logger.warn('Stall ladder: owner line not sent', { key: item.key });
				return null;
			}
			await item.onStep?.('owner', new Date(now)).catch(() => undefined);
			try {
				this.deps.onOwnerTold?.(item.agent);
			} catch {
				/* a count must never block the ladder */
			}
		}
		ladder.ownerAt = now;
		this.deps.trace?.({ session: item.agent, summary: `Stall watcher: owner told about ${item.key}`, ...(item.workItemId ? { workItemId: item.workItemId } : {}), data: { reason: 'stall', step: 'owner', key: item.key, dryRun: dry } });
		this.logger.info('Stall ladder: owner told', { key: item.key, agent: item.agent, dryRun: dry });
		return 'owner';
	}

	// -------------------------------------------------------------------------
	// (a) Promises to the owner
	// -------------------------------------------------------------------------

	/**
	 * Active commitments with a due time: the ladder keyed to the agent's
	 * estimate (due − made). The open-items sweep's own stamps count as steps.
	 *
	 * @param now - Epoch ms
	 * @param dry - Dry run
	 * @param result - Counters
	 */
	private async promisesPass(now: number, dry: boolean, result: StallTickResult): Promise<void> {
		const requests = await this.deps.listRequests();
		for (const request of requests) {
			if (request.status === 'cancelled' || request.status === 'done') continue;
			for (const item of request.openItems ?? []) {
				if (!ACTIVE_OPEN_ITEM_STATUSES.has(item.status) || item.status === 'waiting_owner') continue;
				// An owner decision asked in prose with no card waits on an answer the same way (crewly#1369).
				const question = isUncardedOwnerQuestion(item);
				if (item.type !== 'commitment' && !question) continue;
				const madeAt = ms(item.createdAt);
				const due = ms(item.due);
				if (madeAt === null || due === null || due <= madeAt) continue;
				const ladderItem = question
					? this.questionLadderItem(request, item, madeAt, due - madeAt, now)
					: this.promiseLadderItem(request, item, madeAt, due - madeAt, now);
				const step = await this.climb(ladderItem, now, dry);
				if (step) result.promises[step] += 1;
			}
		}
	}

	/**
	 * The ladder item of a commitment.
	 *
	 * @param request - Its request
	 * @param item - The commitment
	 * @param madeAt - Promise time (ms)
	 * @param estimateMs - due − made
	 * @param now - Epoch ms
	 * @returns Ladder item
	 */
	private promiseLadderItem(request: Request, item: RequestOpenItem, madeAt: number, estimateMs: number, now: number): LadderItem {
		const thread: StallThreadRef | null = request.chatRef ? { channelId: request.chatRef.channelId, threadId: request.chatRef.threadRootId } : null;
		const what = clip(item.text, C.QUOTE_MAX_CHARS);
		const elapsedMs = now - madeAt;
		return {
			key: `promise:${request.id}/${item.id}`,
			agent: item.agent,
			madeAt,
			estimateMs,
			thread,
			prior: {
				...(ms(item.stallNudgedAt) !== null ? { agentAt: ms(item.stallNudgedAt) as number } : {}),
				...(ms(item.leadNotifiedAt) !== null ? { leadAt: ms(item.leadNotifiedAt) as number } : {}),
				...(ms(item.ownerNotifiedAt) !== null ? { ownerAt: ms(item.ownerNotifiedAt) as number } : {}),
				...(ms(item.nudgedAt) !== null ? { recentNudgeAt: ms(item.nudgedAt) as number } : {}),
			},
			agentText: async () => {
				const messages = thread ? await this.deps.threadMessages(thread).catch(() => [] as StallThreadMessage[]) : [];
				const ctx = contextBefore(messages, item.agent, madeAt);
				const context = ctx
					? ` Context — the last message before your promise (${ctx.senderType === 'user' ? 'the owner' : await this.name(ctx.senderId)}): "${clip(ctx.content, C.CONTEXT_MAX_CHARS)}" — if that was the go-ahead, do not wait for another.`
					: '';
				return (
					`${C.NUDGE_TAG} You told the owner "${what}" ${durationWords(elapsedMs)} ago and gave yourself about ${durationWords(estimateMs)}; nothing has been posted in that thread since. ` +
					`Post the deliverable now, or tell the owner in one line what blocks it and when it will come.${context}`
				);
			},
			leadText: async () => {
				const name = await this.name(item.agent);
				return (
					`${C.NUDGE_TAG} ${name} promised the owner "${what}" ${durationWords(elapsedMs)} ago (estimate ${durationWords(estimateMs)}) and has posted nothing since being reminded. ` +
					`Check on ${name}, reassign the work, or answer the owner in that thread.`
				);
			},
			ownerLine: async (lang, leadName) => promiseOwnerLine(lang, { name: await this.name(item.agent), what, estimateMs, elapsedMs, leadName }),
			onStep: (step, at) => this.deps.recordPromiseStep(request.id, item.id, step, at),
			...(item.workItemId ? { workItemId: item.workItemId } : {}),
		};
	}

	/**
	 * The ladder item of an uncarded owner question: the agent is asked to
	 * put it on a card (or record the answer), then the lead, then the owner
	 * gets the question itself once.
	 *
	 * @param request - Its request
	 * @param item - The owner question
	 * @param madeAt - When it was asked (ms)
	 * @param estimateMs - due − asked
	 * @param now - Epoch ms
	 * @returns Ladder item
	 */
	private questionLadderItem(request: Request, item: RequestOpenItem, madeAt: number, estimateMs: number, now: number): LadderItem {
		const thread: StallThreadRef | null = request.chatRef ? { channelId: request.chatRef.channelId, threadId: request.chatRef.threadRootId } : null;
		const what = clip(item.text, C.QUOTE_MAX_CHARS);
		const elapsedMs = now - madeAt;
		return {
			key: `question:${request.id}/${item.id}`,
			agent: item.agent,
			madeAt,
			estimateMs,
			thread,
			prior: {
				...(ms(item.stallNudgedAt) !== null ? { agentAt: ms(item.stallNudgedAt) as number } : {}),
				...(ms(item.leadNotifiedAt) !== null ? { leadAt: ms(item.leadNotifiedAt) as number } : {}),
				...(ms(item.ownerNotifiedAt) !== null ? { ownerAt: ms(item.ownerNotifiedAt) as number } : {}),
			},
			agentText: async () =>
				`${C.NUDGE_TAG} You asked the owner "${what}" ${durationWords(elapsedMs)} ago and no answer is on file. ` +
				'If he answered somewhere else, act on it and say so in that thread. If not, ask it once as a decision card (ask-owner) so he can tap an answer — or drop it if it no longer matters. Do not act on it without an answer.',
			leadText: async () => {
				const name = await this.name(item.agent);
				return (
					`${C.NUDGE_TAG} ${name} asked the owner "${what}" ${durationWords(elapsedMs)} ago; there is still no answer on file and ${name} was reminded. ` +
					`Make sure it becomes a decision card or is dropped; nobody acts on it without the owner's answer.`
				);
			},
			ownerLine: async (lang) => questionOwnerLine(lang, { name: await this.name(item.agent), what, elapsedMs }),
			onStep: (step, at) => this.deps.recordPromiseStep(request.id, item.id, step, at),
		};
	}

	// -------------------------------------------------------------------------
	// (b) Claimed WorkItems
	// -------------------------------------------------------------------------

	/**
	 * Running items with an active claim: the trace's ongoing stall nudges the
	 * claimer once; a second window releases the claim and tells the lead.
	 *
	 * @param now - Epoch ms
	 * @param dry - Dry run
	 * @param result - Counters
	 */
	private async claimsPass(now: number, dry: boolean, result: StallTickResult): Promise<void> {
		const claims = (await this.deps.activeClaims()).filter((c) => c.status === 'active' || c.status === 'expiring');
		if (claims.length === 0) return;
		const items = new Map((await this.deps.listWorkItems()).map((w) => [w.id, w] as const));
		const linked = (await this.deps.ticketLinkedWorkItemIds?.().catch(() => new Set<string>())) ?? new Set<string>();
		for (const claim of claims) {
			const wi = items.get(claim.workItemId);
			if (!wi || wi.status !== 'running') continue;
			const key = `claim:${wi.id}`;
			if (linked.has(wi.id)) continue; // the ticket autopilot re-briefs and releases those
			const signal = await this.deps.stallOf({ workItemId: wi.id, session: claim.agentId }).catch(() => null);
			if (!signal || signal.ms < C.CLAIM_STALL_MS || signal.cause === 'waiting_on_owner') {
				if (this.state.ladders[key]) delete this.state.ladders[key]; // moving again: a fresh cycle next time
				continue;
			}
			const ladder: LadderState = (this.state.ladders[key] ??= { seenAt: now });
			ladder.seenAt = now;
			const title = clip(wi.title ?? wi.id, C.QUOTE_MAX_CHARS);
			const minutes = Math.round(signal.ms / 60_000);
			const cause = causeText(signal);
			if (!ladder.agentAt) {
				const text = `${C.NUDGE_TAG} Work item ${wi.id} ("${title}") has shown no progress for ${minutes} min — ${cause}. Continue it now, or release it with a one-line reason.`;
				const outcome = await this.nudgeAgent(claim.agentId, text, now, dry);
				if (outcome === 'cooldown' || outcome === 'failed') continue;
				ladder.agentAt = now;
				result.claims.nudged += 1;
				this.deps.trace?.({ session: claim.agentId, summary: `Stall watcher: ${wi.id} stalled ${minutes} min (${signal.cause}) — claimer nudged`, workItemId: wi.id, data: { reason: 'stall', step: 'agent', cause: signal.cause, dryRun: dry } });
				this.logger.info('Stalled claim: claimer nudged', { workItemId: wi.id, agent: claim.agentId, minutes, cause: signal.cause, dryRun: dry });
				continue;
			}
			if (ladder.leadAt || now - ladder.agentAt < C.CLAIM_STALL_MS || signal.ms < 2 * C.CLAIM_STALL_MS) continue;
			const reason = `stall watcher: no progress for ${minutes} min after a reminder (${cause})`;
			if (dry) {
				this.logger.info('Dry run: would release the claim and tell the lead', { workItemId: wi.id, agent: claim.agentId, reason });
			} else {
				await this.deps.releaseClaim(wi.id, reason).catch((err) => this.logger.warn('Stalled claim not released', { workItemId: wi.id, error: errText(err) }));
			}
			const name = await this.name(claim.agentId);
			const lead = await this.tellLead(
				claim.agentId,
				async () =>
					`${C.NUDGE_TAG} ${name}'s work item ${wi.id} ("${title}") showed no progress for ${minutes} min after a reminder (${cause}); its claim was released and it is queued again, unassigned ` +
					`(the route sweep hands it to you, then to the orchestrator). Take it, reassign it, or cancel it with a reason.`,
				dry,
			);
			ladder.leadAt = now;
			result.claims.released += 1;
			this.deps.trace?.({ session: claim.agentId, summary: `Stall watcher: ${wi.id} released after ${minutes} min with no progress; lead ${lead ?? 'none'} told`, workItemId: wi.id, data: { reason: 'stall', step: 'lead', cause: signal.cause, dryRun: dry } });
			this.logger.warn('Stalled claim released and escalated', { workItemId: wi.id, agent: claim.agentId, lead, minutes, cause: signal.cause, dryRun: dry });
		}
	}

	// -------------------------------------------------------------------------
	// (c) Background runs
	// -------------------------------------------------------------------------

	/**
	 * Runs agents announced: closed when the thread shows a deliverable or a
	 * report, else the same ladder as promises from the run's start.
	 *
	 * @param now - Epoch ms
	 * @param dry - Dry run
	 * @param result - Counters
	 */
	private async runsPass(now: number, dry: boolean, result: StallTickResult): Promise<void> {
		for (const run of [...this.state.runs]) {
			const thread: StallThreadRef = { channelId: run.channelId, threadId: run.threadId };
			const key = `run:${run.id}`;
			const { agentDue } = ladderDue(run.startedAt, run.estimateMs);
			if (now < agentDue) continue;
			const messages = await this.deps.threadMessages(thread).catch(() => [] as StallThreadMessage[]);
			if (runDeliveredIn(messages, run)) {
				this.state.runs = this.state.runs.filter((r) => r.id !== run.id);
				delete this.state.ladders[key];
				result.runs.cleared += 1;
				this.logger.info('Background run closed: the thread shows its result', { agent: run.agent, run: run.id });
				continue;
			}
			const head = clip(run.head, C.QUOTE_MAX_CHARS);
			const elapsedMs = now - run.startedAt;
			const step = await this.climb(
				{
					key,
					agent: run.agent,
					madeAt: run.startedAt,
					estimateMs: run.estimateMs,
					thread,
					agentText: async () =>
						`${C.NUDGE_TAG} You said "${head}" ${durationWords(elapsedMs)} ago (estimate ${durationWords(run.estimateMs)}) and nothing has been posted in that thread since. ` +
						`Check the run: post the result, or say in one line that it failed and what you will do.`,
					leadText: async () => {
						const name = await this.name(run.agent);
						return (
							`${C.NUDGE_TAG} ${name} said "${head}" ${durationWords(elapsedMs)} ago (estimate ${durationWords(run.estimateMs)}) and has posted no result since being reminded. ` +
							`Check whether the run is still alive, restart it or reassign it, or answer the owner in that thread.`
						);
					},
					ownerLine: async (lang, leadName) => runOwnerLine(lang, { name: await this.name(run.agent), head, estimateMs: run.estimateMs, elapsedMs, leadName }),
				},
				now,
				dry,
			);
			if (step) result.runs[step] += 1;
		}
	}

	// -------------------------------------------------------------------------
	// (#1362) "X is doing it"
	// -------------------------------------------------------------------------

	/**
	 * Claims past their window: a WorkItem or ticket for the teammate exists,
	 * or the speaker is told once. Never the owner.
	 *
	 * @param now - Epoch ms
	 * @param dry - Dry run
	 * @param result - Counters
	 */
	private async teammateClaimsPass(now: number, dry: boolean, result: StallTickResult): Promise<void> {
		const keep: PendingClaim[] = [];
		for (const claim of this.state.claims) {
			if (now < claim.saidAt + C.CLAIM_CHECK_WINDOW_MS) {
				keep.push(claim);
				continue;
			}
			result.teammateClaims.checked += 1;
			const exists = await this.deps.assignmentExists(claim.speaker, claim.member, claim.saidAt, C.CLAIM_CHECK_WINDOW_MS).catch(() => true);
			if (exists) {
				this.logger.debug('Teammate claim backed by an assignment', { speaker: claim.speaker, member: claim.member, message: claim.id });
				continue;
			}
			const outcome = await this.nudgeAgent(claim.speaker, claimNudgeText(claim.memberName, claim.head), now, dry);
			if (outcome === 'cooldown') {
				keep.push(claim); // next pass (pruned if it never gets through)
				continue;
			}
			result.teammateClaims.nudged += 1;
			this.deps.trace?.({ session: claim.speaker, summary: `Claim check: told the owner ${claim.memberName} is doing it; nothing assigned to ${claim.member}`, data: { reason: 'claim_check', member: claim.member, dryRun: dry } });
			this.logger.warn('Teammate claim with no assignment — speaker told', { speaker: claim.speaker, member: claim.member, message: claim.id, outcome });
		}
		this.state.claims = keep;
	}
}

/**
 * Error text.
 *
 * @param err - Anything thrown
 * @returns Message
 */
function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
