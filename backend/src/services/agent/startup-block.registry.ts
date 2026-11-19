/**
 * Start-up blocks — agents whose most recent start ended in a
 * RuntimeStartupBlockedError and that have not started successfully since.
 *
 * Such an agent waits on the user (a consent screen, a sign-in, a menu
 * Crewly does not know). Two things follow from that, and both read this
 * registry as the single source of truth:
 *
 * - status: the orchestrator status, the health summary and `crewly status`
 *   say "blocked, waiting on you" with the reason. The session may still be
 *   alive on its menu, which used to read as "idle" / "orchestrator ok"
 *   (Windows host, 2026-11-19).
 * - starts: an automatic caller (restart service, monitors, the CLI's
 *   follow-up setup call, the reconciler) must not start the agent again;
 *   the same wall is still there. A start the user asked for (dashboard,
 *   API, the consent / re-login resume) clears the block first and goes ahead.
 *
 * Module-level and dependency-free so services and controllers can share it
 * without import cycles. Kept in memory on purpose: a backend restart always
 * gets one fresh attempt.
 *
 * @module services/agent/startup-block.registry
 */

import { STARTUP_BLOCK_CONSTANTS } from '../../constants.js';

/** One agent waiting on the user before it can start. */
export interface StartupBlock {
	/** Session the block is about */
	sessionName: string;
	/** Reason code of the RuntimeStartupBlockedError (e.g. `consent_required`) */
	reason: string;
	/** The error's user-facing message, unchanged */
	message: string;
	/** When the start was blocked (ISO) */
	at: string;
}

const blocks = new Map<string, StartupBlock>();

/**
 * Remember that a start of this session was blocked on the user.
 *
 * @param sessionName - Session whose start was blocked
 * @param reason - Reason code; a missing one is stored as `unknown`
 * @param message - User-facing message of the error
 * @returns The stored block
 *
 * @example
 * ```ts
 * recordStartupBlock('crewly-orc', 'consent_required', 'Claude Code asks to accept Bypass Permissions mode.');
 * ```
 */
export function recordStartupBlock(sessionName: string, reason: string | undefined, message: string): StartupBlock {
	const block: StartupBlock = {
		sessionName,
		reason: reason || STARTUP_BLOCK_CONSTANTS.UNKNOWN_REASON,
		message,
		at: new Date().toISOString(),
	};
	if (sessionName) blocks.set(sessionName, block);
	return block;
}

/**
 * Forget the block: the agent started, the user stopped it, or the user (or
 * the consent / re-login flow) is starting it again.
 *
 * @param sessionName - Session
 * @returns True when a block was removed
 */
export function clearStartupBlock(sessionName: string): boolean {
	return blocks.delete(sessionName);
}

/**
 * The block on a session, if its last start was blocked and it has not
 * started since.
 *
 * @param sessionName - Session
 * @returns The block, or null
 */
export function startupBlockOf(sessionName: string): StartupBlock | null {
	return blocks.get(sessionName) ?? null;
}

/**
 * The block that should stop an AUTOMATIC start of a session right now.
 *
 * A block holds automatic callers back for a while, not for ever: after
 * {@link STARTUP_BLOCK_CONSTANTS.AUTOMATIC_RETRY_AFTER_MS} one automatic
 * attempt is let through again. The owner is usually not at the machine, the
 * cause may be gone (they answered the prompt in a terminal), and a wrong
 * detection must not keep an agent down until someone notices (2026-11-19: a
 * false consent detection kept the orchestrator down for 50 minutes). The
 * attempt either starts the agent, which clears the block, or blocks again,
 * which records a new time. Status keeps showing the block meanwhile.
 *
 * @param sessionName - Agent session
 * @param now - Current time in ms (injectable for tests)
 * @returns The block while it is fresh, else null
 *
 * @example
 * ```ts
 * if (automaticStartBlockOf('crewly-orc')) return; // not now; someone has to act first
 * ```
 */
export function automaticStartBlockOf(sessionName: string, now: number = Date.now()): StartupBlock | null {
	const block = blocks.get(sessionName);
	if (!block) return null;
	const age = now - Date.parse(block.at);
	return age >= 0 && age < STARTUP_BLOCK_CONSTANTS.AUTOMATIC_RETRY_AFTER_MS ? block : null;
}

/**
 * Every blocked session (for the health summary).
 *
 * @returns Blocks, oldest first
 */
export function listStartupBlocks(): StartupBlock[] {
	return [...blocks.values()];
}

/**
 * One line that says an agent waits on the user and why.
 *
 * @param subject - Who is blocked, e.g. `Orchestrator`
 * @param block - The block
 * @returns `<subject> start-up is waiting on you: <message>`
 */
export function describeStartupBlock(subject: string, block: StartupBlock): string {
	return `${subject}${STARTUP_BLOCK_CONSTANTS.WAITING_ON_USER_TEXT}${block.message}`;
}

/**
 * Forget every block (tests only).
 */
export function resetStartupBlocksForTesting(): void {
	blocks.clear();
}
