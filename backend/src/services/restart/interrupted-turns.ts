/**
 * Interrupted Turns — persist on shutdown, resume on boot.
 *
 * When the restart drain gives up (timeout, second signal, drain disabled),
 * the turns still in flight are written to `<CREWLY_HOME>/interrupted-turns.json`.
 * On the next boot those sessions count as having work in hand (so
 * auto-restore brings them back), and once each agent is up its message is
 * re-delivered with a short notice through the normal delivery path:
 * - messages that came through the message queue are re-enqueued with their
 *   original source, conversation and Slack thread, so replies still route;
 * - anything else goes through `sendMessageToAgent`, whose registration gate
 *   holds the text until the agent has registered.
 *
 * Scheduler / status pings ([SYSTEM] markers) are not persisted: their
 * producers fire again after a restart, and replaying a stale ping is noise.
 *
 * @module services/restart/interrupted-turns
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import { SAFE_RESTART, MESSAGE_SOURCES, type MessageSource } from '../../constants.js';
import type { InFlightTurn } from './in-flight-turn-tracker.service.js';

/** One interrupted message, as stored on disk. */
export interface InterruptedTurnEntry {
	/** Agent session that was mid-turn */
	sessionName: string;
	/** Epoch ms the message was delivered */
	deliveredAt: number;
	/** Exactly what had been written into the PTY */
	text: string;
	/** One-line preview */
	preview: string;
	/** Queue metadata, present when the message came through the message queue */
	messageId?: string;
	source?: string;
	conversationId?: string;
	originalContent?: string;
	sourceMetadata?: Record<string, string | number | boolean>;
}

/** File layout. */
interface InterruptedTurnsFile {
	version: 1;
	savedAt: string;
	reason?: string;
	turns: InterruptedTurnEntry[];
}

/** Outcome of loading the file. */
export interface LoadedInterruptedTurns {
	/** Entries young enough to resume */
	fresh: InterruptedTurnEntry[];
	/** Number of entries dropped for age or shape */
	dropped: number;
}

/** Input for a message-queue re-enqueue. */
export interface ResumeEnqueueInput {
	content: string;
	conversationId: string;
	source: MessageSource;
	sourceMetadata?: Record<string, string | number | boolean>;
	targetSession?: string;
}

/** Dependencies of {@link resumeInterruptedTurns}. */
export interface ResumeDeps {
	/** Orchestrator session name */
	orchestratorSession: string;
	/** Whether the session is running now (PTY exists or in-process runtime registered) */
	isSessionRunning: (sessionName: string) => boolean;
	/** Enqueue on the persistent message queue */
	enqueue: (input: ResumeEnqueueInput) => void;
	/** Direct delivery (registration-gated) */
	sendMessageToAgent: (sessionName: string, text: string) => Promise<{ success: boolean; error?: string; queued?: boolean }>;
	/** Resolves true once the orchestrator is registered and active */
	waitForOrchestratorActive: () => Promise<boolean>;
	/** Called after each entry is handled (delivered, skipped or failed) */
	onEntryHandled?: (entry: InterruptedTurnEntry, remaining: InterruptedTurnEntry[]) => void;
	/** Logger */
	logger: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Summary of a resume pass. */
export interface ResumeSummary {
	redelivered: number;
	skipped: number;
	failed: number;
}

const SOURCE_VALUES: ReadonlySet<string> = new Set(Object.values(MESSAGE_SOURCES));

/**
 * Default location of the interrupted-turns file.
 *
 * @param crewlyHome - CREWLY_HOME directory
 * @returns Absolute file path
 */
export function interruptedTurnsPath(crewlyHome: string): string {
	return path.join(crewlyHome, SAFE_RESTART.INTERRUPTED_TURNS_FILE);
}

/**
 * Flatten in-flight turns into storable entries, dropping [SYSTEM] pings.
 *
 * @param turns - Turns still in flight when the drain ended
 * @returns Entries to persist
 */
export function toInterruptedEntries(turns: readonly InFlightTurn[]): InterruptedTurnEntry[] {
	const out: InterruptedTurnEntry[] = [];
	for (const turn of turns) {
		for (const m of turn.messages) {
			if (m.systemEvent) continue;
			out.push({
				sessionName: turn.sessionName,
				deliveredAt: m.deliveredAt,
				text: m.text,
				preview: m.preview,
				...(m.messageId ? { messageId: m.messageId } : {}),
				...(m.source ? { source: m.source } : {}),
				...(m.conversationId ? { conversationId: m.conversationId } : {}),
				...(m.originalContent !== undefined ? { originalContent: m.originalContent } : {}),
				...(m.sourceMetadata ? { sourceMetadata: m.sourceMetadata } : {}),
			});
		}
	}
	return out;
}

/**
 * Read the file without filtering. Missing or unreadable file → [].
 *
 * @param filePath - File path
 * @returns Stored entries
 */
function readEntries(filePath: string): InterruptedTurnEntry[] {
	try {
		const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<InterruptedTurnsFile>;
		return Array.isArray(parsed.turns) ? parsed.turns : [];
	} catch {
		return [];
	}
}

/**
 * Write entries atomically (write-then-rename), or remove the file when empty.
 *
 * @param filePath - File path
 * @param entries - Entries to store
 * @param reason - Why they were interrupted
 */
export function writeInterruptedTurns(filePath: string, entries: readonly InterruptedTurnEntry[], reason?: string): void {
	if (entries.length === 0) {
		clearInterruptedTurns(filePath);
		return;
	}
	const body: InterruptedTurnsFile = {
		version: 1,
		savedAt: new Date().toISOString(),
		...(reason ? { reason } : {}),
		turns: [...entries],
	};
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf-8');
	renameSync(tmp, filePath);
}

/**
 * Persist interrupted turns at shutdown, merged with any entries a previous
 * boot had not resumed yet (so a quick second restart cannot drop them).
 *
 * @param filePath - File path
 * @param turns - Turns still in flight
 * @param reason - Drain outcome / signal
 * @returns Number of entries now on disk
 */
export function saveInterruptedTurns(filePath: string, turns: readonly InFlightTurn[], reason?: string): number {
	const incoming = toInterruptedEntries(turns);
	const existing = readEntries(filePath);
	const key = (e: InterruptedTurnEntry): string => `${e.sessionName}\u0000${e.deliveredAt}\u0000${e.text}`;
	const seen = new Set<string>();
	const merged: InterruptedTurnEntry[] = [];
	for (const e of [...existing, ...incoming]) {
		const k = key(e);
		if (seen.has(k)) continue;
		seen.add(k);
		merged.push(e);
	}
	if (merged.length === 0) return 0;
	writeInterruptedTurns(filePath, merged, reason);
	return merged.length;
}

/**
 * Load entries worth resuming.
 *
 * @param filePath - File path
 * @param now - Current time (ms)
 * @param maxAgeMs - Older entries are dropped
 * @returns Fresh entries and the number dropped
 */
export function loadInterruptedTurns(
	filePath: string,
	now: number = Date.now(),
	maxAgeMs: number = SAFE_RESTART.INTERRUPTED_TURN_MAX_AGE_MS,
): LoadedInterruptedTurns {
	const all = readEntries(filePath);
	const fresh: InterruptedTurnEntry[] = [];
	let dropped = 0;
	for (const e of all) {
		const valid =
			e &&
			typeof e.sessionName === 'string' &&
			e.sessionName.length > 0 &&
			typeof e.text === 'string' &&
			typeof e.deliveredAt === 'number' &&
			now - e.deliveredAt <= maxAgeMs;
		if (valid) fresh.push(e);
		else dropped += 1;
	}
	return { fresh, dropped };
}

/**
 * Remove the file (missing file is fine).
 *
 * @param filePath - File path
 */
export function clearInterruptedTurns(filePath: string): void {
	try {
		unlinkSync(filePath);
	} catch {
		// Already gone.
	}
}

/**
 * Prefix a message with the resume notice, without stacking notices when a
 * resumed message is itself interrupted again.
 *
 * @param original - The message to resume
 * @returns Notice + original
 */
export function buildResumeMessage(original: string): string {
	let body = original;
	while (body.startsWith(SAFE_RESTART.RESUME_NOTICE)) {
		body = body.slice(SAFE_RESTART.RESUME_NOTICE.length).replace(/^\s+/, '');
	}
	return `${SAFE_RESTART.RESUME_NOTICE}\n${body}`;
}

/**
 * Whether an entry carries enough queue metadata to be re-enqueued.
 *
 * @param entry - Stored entry
 * @returns True for message-queue deliveries with a known source
 */
function isQueueEntry(entry: InterruptedTurnEntry): entry is InterruptedTurnEntry & { source: MessageSource; conversationId: string; originalContent: string } {
	return (
		typeof entry.source === 'string' &&
		SOURCE_VALUES.has(entry.source) &&
		entry.source !== MESSAGE_SOURCES.SYSTEM_EVENT &&
		typeof entry.conversationId === 'string' &&
		entry.conversationId.length > 0 &&
		typeof entry.originalContent === 'string'
	);
}

/**
 * Re-deliver interrupted messages, one at a time.
 *
 * @param entries - Fresh entries from loadInterruptedTurns
 * @param deps - Delivery hooks
 * @returns Counts of redelivered / skipped / failed
 *
 * @example
 * ```typescript
 * const { fresh } = loadInterruptedTurns(file);
 * await resumeInterruptedTurns(fresh, deps);
 * clearInterruptedTurns(file);
 * ```
 */
export async function resumeInterruptedTurns(entries: readonly InterruptedTurnEntry[], deps: ResumeDeps): Promise<ResumeSummary> {
	const summary: ResumeSummary = { redelivered: 0, skipped: 0, failed: 0 };
	const remaining = [...entries];
	let orcReady: boolean | null = null;

	for (const entry of entries) {
		const isOrc = entry.sessionName === deps.orchestratorSession;
		try {
			if (!isOrc && !deps.isSessionRunning(entry.sessionName)) {
				summary.skipped += 1;
				deps.logger.warn('Interrupted turn not resumed: agent is not running after restart', {
					sessionName: entry.sessionName,
					messagePreview: entry.preview,
				});
			} else if (isQueueEntry(entry)) {
				deps.enqueue({
					content: buildResumeMessage(entry.originalContent),
					conversationId: entry.conversationId,
					source: entry.source,
					...(entry.sourceMetadata ? { sourceMetadata: entry.sourceMetadata } : {}),
					...(isOrc ? {} : { targetSession: entry.sessionName }),
				});
				summary.redelivered += 1;
				deps.logger.info('Interrupted turn re-enqueued with its original source', {
					sessionName: entry.sessionName,
					source: entry.source,
					messagePreview: entry.preview,
				});
			} else {
				if (isOrc) {
					if (orcReady === null) orcReady = await deps.waitForOrchestratorActive();
					if (!orcReady) {
						summary.failed += 1;
						deps.logger.warn('Interrupted turn not resumed: orchestrator never became active', {
							messagePreview: entry.preview,
						});
						continue;
					}
				}
				const result = await deps.sendMessageToAgent(entry.sessionName, buildResumeMessage(entry.text));
				if (result.success) {
					summary.redelivered += 1;
					deps.logger.info('Interrupted turn re-delivered', {
						sessionName: entry.sessionName,
						queuedUntilRegistered: result.queued === true,
						messagePreview: entry.preview,
					});
				} else {
					summary.failed += 1;
					deps.logger.warn('Interrupted turn re-delivery failed', {
						sessionName: entry.sessionName,
						error: result.error,
						messagePreview: entry.preview,
					});
				}
			}
		} catch (error) {
			summary.failed += 1;
			deps.logger.warn('Interrupted turn re-delivery threw', {
				sessionName: entry.sessionName,
				error: error instanceof Error ? error.message : String(error),
			});
		} finally {
			remaining.splice(remaining.indexOf(entry), 1);
			deps.onEntryHandled?.(entry, [...remaining]);
		}
	}
	return summary;
}
