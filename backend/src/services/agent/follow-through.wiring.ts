/**
 * Wiring for the follow-through guard, the ticket work guard and the idle
 * work guard onto the real backend services. Kept apart from the services so
 * their logic stays transport-free (and testable).
 *
 * @module services/agent/follow-through.wiring
 * @see specs/2026-10-10-agent-follow-through.md
 */

import { OPEN_ITEMS_CONSTANTS, PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { createWorkItem, TERMINAL_WORK_ITEM_STATUSES, type WorkItem } from '../../types/v2/work-item.types.js';
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
import { findExistingFollowThrough } from '../../utils/duplicate-creation.utils.js';
import { formatReminderAge, isPastReminderCutoff, reminderAgeMs } from '../orc/harness-reminder.js';
import { PtyActivityTrackerService } from './pty-activity-tracker.service.js';
import { AgentFollowThroughService, FOLLOW_THROUGH_CONSTANTS, getFollowThrough, setFollowThrough } from './follow-through.service.js';
import { holdReasonFor, releaseHeldWork, type IdleWorkGuardDeps, type ReleaseWorkDeps } from './idle-work-guard.js';
import { getStallWatcher } from '../stall/stall-watcher.service.js';

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
		const m = (wi.metadata ?? {}) as Record<string, unknown>;
		if (wi.target === session) {
			// An item the harness queued for the agent (the promise's own WorkItem,
			// a ticket's) is not the agent starting: it waits until the agent does.
			const waiting = wi.status === 'queued' || wi.status === 'proposed' || wi.status === 'scheduled' || wi.status === 'blocked';
			// The follow-up Crewly files for a promise in the same reply carries no
			// `harnessCreated`: counting it made every "I'm doing X now" look
			// started, so the guard never nudged (Pia, 2026-11-16: idle 79 minutes).
			const harnessQueued = typeof m['harnessCreated'] === 'string' || m[OPEN_ITEMS_CONSTANTS.FOLLOW_UP_METADATA_KEY] !== undefined;
			if (!(waiting && harnessQueued)) return true;
		}
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
		isQuiet: (session) => !tracker.hasActivity(session) || tracker.getIdleTimeMs(session) >= FOLLOW_THROUGH_CONSTANTS.QUIET_MS,
		commit: (session, sentence) => commitStatedIntent(session, sentence),
		settle: (workItemId) => settleStatedIntent(workItemId),
	});
	setFollowThrough(service);
	// A post can land after the turn-end settle ran: sweep quiet agents too.
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = setInterval(() => {
		void service.sweep().catch(() => undefined);
	}, FOLLOW_THROUGH_CONSTANTS.SWEEP_INTERVAL_MS);
	sweepTimer.unref?.();
	return service;
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Metadata marker on WorkItems made for a stated intent. */
export const STATED_INTENT_MARKER = 'stated-intent';

/**
 * Make "I'm starting X now" a WorkItem for the agent, so it survives a stop or
 * restart. Created with the agent as creator, so the answer goes to the owner
 * thread the agent is in (the pool stamps the origin). One open item per agent.
 *
 * @param session - The agent
 * @param sentence - What it said
 * @returns The WorkItem id, or null when none could be made
 */
export async function commitStatedIntent(session: string, sentence: string): Promise<string | null> {
	const pool = TaskPoolService.getInstance();
	const all = await pool.getAllItems();
	const open = all.find(
		(wi) => wi.target === session && (wi.metadata as Record<string, unknown> | undefined)?.['harnessCreated'] === STATED_INTENT_MARKER && !TERMINAL_WORK_ITEM_STATUSES.has(wi.status),
	);
	if (open) return open.id;
	const title = `Follow through: ${sentence.slice(0, 70)}`;
	// The same sentence already had its item (finished or not) within a day: one item per promise.
	if (findExistingFollowThrough(all, session, title, STATED_INTENT_MARKER, Date.now())) return null;
	const wi = createWorkItem({
		type: 'delegate',
		owner: 'agent',
		target: session,
		title,
		description: stateIntentBrief(sentence),
		metadata: { harnessCreated: STATED_INTENT_MARKER },
	});
	await pool.addToPool(wi, { creatorSession: session });
	return wi.id;
}

/**
 * @param sentence - What the agent told the owner
 * @returns The brief put on the promise's WorkItem (harness text)
 */
export function stateIntentBrief(sentence: string): string {
	return (
		`You told the owner: "${sentence}". Do it now, and reply in the owner's thread when there is a result or a real blocker. ` +
		'If you asked a question and stated a default, go ahead with the default.'
	);
}

/**
 * The promise was answered: close its WorkItem (queued ones are cancelled,
 * started ones completed). Never throws.
 *
 * @param workItemId - The promise's WorkItem
 */
export async function settleStatedIntent(workItemId: string): Promise<void> {
	const pool = TaskPoolService.getInstance();
	try {
		await pool.cancelQueued(workItemId, 'answered by the agent', { cancelledBy: 'system' });
	} catch {
		await pool.completeSimpleItem(workItemId, 'system').catch(() => undefined);
	}
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
		holdsBackgroundRun: (session) => getStallWatcher()?.protectedRunReason(session) !== null && getStallWatcher() !== null,
		owedAgeMs: (session) => {
			const ages = [getOwnerThreadSentinel()?.owedAgeMs(session) ?? null, getFollowThrough()?.intentAgeMs(session) ?? null].filter((a): a is number => a !== null);
			return ages.length > 0 ? Math.min(...ages) : null;
		},
	};
}

/** The idle check's pending-work check on the real services. */
export function idlePendingWorkCheck(): (session: string) => Promise<string | null> {
	return (session) => holdReasonFor(session, idleWorkGuardDeps());
}

/** Promise keys being parked right now, so concurrent stop paths share one run. */
const parkingPromises = new Map<string, Promise<string | null>>();

/** Seams of the work release on the real services. */
export function releaseWorkDeps(): ReleaseWorkDeps {
	const pool = TaskPoolService.getInstance();
	return {
		listWorkItems: () => pool.getAllItems(),
		releaseBack: (id, reason) => pool.releaseBack(id, reason),
		parkIntent: async (session) => {
			const intent = getFollowThrough()?.takeIntent(session);
			if (!intent) return null;
			// Already a WorkItem since the statement: nothing more to park.
			if (intent.workItemId) return intent.workItemId;
			// One "Follow through" item per target + sentence, whatever its status now: parked once, not
			// after every stop (ten identical items for one agent, 2026-10-12).
			const title = `Follow through: ${intent.sentence.slice(0, 70)}`;
			const twin = findExistingFollowThrough(await pool.getAllItems(), session, title, 'stated-intent', Date.now());
			if (twin) return TERMINAL_WORK_ITEM_STATUSES.has(twin.status) ? null : twin.id;
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
		parkPromise: (session) => {
			const promise = getOwnerThreadSentinel()?.parkablePromise(session);
			if (!promise) return Promise.resolve(null);
			// Several stop paths can reach here in the same second (idle stop, slot
			// eviction, runtime exit). The existing-item check below is a read followed
			// by a write, so concurrent calls all saw "no item" and made one each (the
			// bursts of 3). Calls for the same promise share one in-flight run.
			const running = parkingPromises.get(promise.key);
			if (running) return running;
			const run = (async (): Promise<string | null> => {
				// One WorkItem per thread + promise, whatever its status now (open, done or
				// cancelled): a promise that was already parked or answered must not come
				// back as a new item after every stop or restart. Items made before
				// promiseKey existed are matched by target + harness origin + title.
				const title = `Follow through: ${promise.text.slice(0, 70)}`;
				const allItems = await pool.getAllItems();
				const existing = allItems.find((wi) => {
					const meta = wi.metadata as Record<string, unknown> | undefined;
					return meta?.['promiseKey'] === promise.key
						|| (meta?.['promiseKey'] === undefined && meta?.['harnessCreated'] === 'owner-promise' && wi.target === session && wi.title === title);
				}) ?? findExistingFollowThrough(allItems, session, title, 'owner-promise', Date.now());
				if (existing) {
					promise.markParked(existing.id);
					return TERMINAL_WORK_ITEM_STATUSES.has(existing.status) ? null : existing.id;
				}
				const wi = createWorkItem({
					type: 'delegate',
					owner: 'system',
					target: session,
					title,
					description: `You promised the owner: "${promise.text}". Crewly stopped you (memory) before you delivered. Deliver it; reply in the owner's thread with the result or a real blocker.`,
					metadata: { harnessCreated: 'owner-promise', promiseKey: promise.key },
				});
				await pool.addToPool(wi, { creatorSession: session });
				promise.markParked(wi.id);
				return wi.id;
			})().finally(() => parkingPromises.delete(promise.key));
			parkingPromises.set(promise.key, run);
			return run;
		},
	};
}

/**
 * After an agent that owes work was stopped for memory: build the reminder it
 * gets when it is brought back, from the WorkItems queued for it. Null when
 * nothing is queued for it.
 *
 * @param items - Pool items
 * @param session - The stopped agent
 * @returns Reminder text, or null
 */
export function owedWorkReminder(items: readonly WorkItem[], session: string): string | null {
	const nowMs = Date.now();
	// Work queued past the reminder cutoff is not pushed at the agent again; the lead's stale-item path owns it.
	const queued = items.filter((wi) => wi.target === session && wi.status === 'queued' && !isPastReminderCutoff(wi.createdAt, nowMs));
	if (queued.length === 0) return null;
	const lines = queued.slice(0, 5).map((wi) => {
		const age = reminderAgeMs(wi.createdAt, nowMs);
		return `- ${wi.title}${age === null ? '' : ` (asked ${formatReminderAge(age)} ago)`}`;
	});
	return (
		'[FOLLOW-THROUGH] Crewly stopped your session (to free a slot or memory, or your runtime exited) while you still owed the owner this. It is still yours; start it now and reply in the owner thread with the result:\n' +
		lines.join('\n') +
		'\nIf you already delivered or answered any of these, send NOTHING to the owner: close the item with the usual command. Never re-post content the owner already has.'
	);
}

/** Marker at the start of the reminder {@link owedWorkReminder} builds. */
export const OWED_REMINDER_MARKER = '[FOLLOW-THROUGH]';

/** Seams of {@link restoreStoppedOwingWork}. */
export interface StoppedOwingDeps {
	/** Put the agent's running work back in the queue (default: {@link releaseWorkForStop}) */
	release?: (session: string, why: string) => Promise<unknown>;
	/** All pool items */
	listWorkItems: () => Promise<WorkItem[]>;
	/** Stopped on purpose (owner stop, paused team): leave it alone */
	isHeldBack: (session: string) => boolean;
	/** A reminder is already waiting on the agent's queue */
	hasReminder: (session: string) => boolean;
	/** Queue the reminder for the agent's next start */
	enqueue: (session: string, text: string) => void;
	/** Keep the agent's typing placeholders up while it is down (it owes the answer) */
	holdPlaceholders?: (session: string) => Promise<unknown>;
	/** Bring the agent back (retries while the running-agent cap defers it) */
	restart: (session: string) => Promise<void>;
}

const restoring = new Set<string>();

/**
 * The one hook every stop path runs (idle stop, memory-pressure stop, slot
 * eviction, reconciler eviction, runtime exit): put the work the agent holds
 * back in the queue, and if it still owes anything, queue a reminder and bring
 * it back. Stop paths used to do this separately; slot eviction did not do it
 * at all and Pia's promise was stranded (2026-10-12). Idempotent; never throws.
 *
 * @param session - The agent that stopped
 * @param why - Reason text for the release
 * @param deps - Seams
 * @returns True when the agent is being brought back
 */
export async function restoreStoppedOwingWork(session: string, why: string, deps: StoppedOwingDeps): Promise<boolean> {
	if (restoring.has(session)) return false;
	restoring.add(session);
	try {
		if (deps.isHeldBack(session)) return false;
		await (deps.release ?? releaseWorkForStop)(session, why);
		const reminder = owedWorkReminder(await deps.listWorkItems(), session);
		if (!reminder) return false;
		await deps.holdPlaceholders?.(session).catch(() => undefined);
		if (!deps.hasReminder(session)) deps.enqueue(session, reminder);
		logger.info('Stopped agent still owes work — it will be restarted', { session, why });
		await deps.restart(session);
		return true;
	} catch (err) {
		logger.warn('Could not restore a stopped agent that owes work', { session, error: err instanceof Error ? err.message : String(err) });
		return false;
	} finally {
		restoring.delete(session);
	}
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
