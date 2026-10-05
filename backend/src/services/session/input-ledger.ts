/**
 * Input ledger — who last put input into each agent's terminal.
 *
 * Text reaches an agent's PTY input box from exactly two places:
 * - the harness's guarded paste (`SessionCommandHelper.sendMessage`), which
 *   records each paste here with {@link noteHarnessPaste};
 * - outside input: the dashboard / phone terminal (TerminalGateway) and the
 *   raw-input HTTP surfaces (`/terminal/:s/write` raw mode, `/input`,
 *   `/key`, `/sessions/:name/write` raw mode), which record it here with
 *   {@link noteOutsideInput}. These are the only writers of raw input a
 *   person (the owner, or another agent typing raw) can reach.
 *
 * So when the box holds text and no outside input arrived since the
 * harness's own pastes, that text is the harness's — it cannot be the
 * owner's (1.20.207 Ella: two of our pastes, concatenated, sat unsent for
 * nine hours because the box no longer matched one recorded paste).
 *
 * Other harness writes (OAuth relogin, runtime-terms answers, `/clear`) are
 * submitted at once and leave nothing in the box; they are neither.
 *
 * Module-level and nearly dependency-free (only the input circuit breaker,
 * itself dependency-free) so the gateway, controllers and the
 * session helper can share it without import cycles. In memory: a restart
 * recreates every session, which starts a new ledger.
 *
 * @module services/session/input-ledger
 */

import { noteInputTouched } from './input-circuit-breaker.js';

/** One harness paste. */
export interface HarnessPaste {
	/** The pasted message */
	message: string;
	/** Epoch ms of the paste */
	at: number;
	/**
	 * The box has shown this paste (as text, a marker, or pieces). A paste
	 * never seen may still be rendered much later: a busy Claude Code shows a
	 * paste only when its turn reaches a boundary, minutes later (2026-10-05
	 * edu-game-milo).
	 */
	seen?: boolean;
}

interface Ledger {
	pastes: HarnessPaste[];
	lastOutsideInputAt?: number;
	/** Exact markers the box showed for harness pastes (the runtime's counter makes each unique) */
	shown: Array<{ marker: string; message: string }>;
}

/** Most pastes remembered per session */
const MAX_PASTES = 10;

const ledgers = new Map<string, Ledger>();

/**
 * Mark pastes of these messages as shown by the box.
 *
 * @param sessionName - The session
 * @param messages - Messages the box was seen to hold
 */
export function noteHarnessPastesSeen(sessionName: string, messages: readonly string[]): void {
	const ledger = ledgers.get(sessionName);
	if (!ledger) return;
	for (const p of ledger.pastes) if (messages.includes(p.message)) p.seen = true;
}

/**
 * Record a harness paste into a session's input box.
 *
 * @param sessionName - The session
 * @param message - What was pasted
 * @param at - When (ms)
 */
export function noteHarnessPaste(sessionName: string, message: string, at: number = Date.now()): void {
	const ledger = ledgers.get(sessionName) ?? { pastes: [], shown: [] };
	ledger.pastes.push({ message, at });
	if (ledger.pastes.length > MAX_PASTES) ledger.pastes.splice(0, ledger.pastes.length - MAX_PASTES);
	ledgers.set(sessionName, ledger);
}

/**
 * Record outside input into a session (owner keystrokes / pastes from the
 * dashboard or phone terminal, raw writes through the input API). The
 * harness's earlier pastes can no longer be told apart from it.
 *
 * @param sessionName - The session
 * @param at - When (ms)
 */
export function noteOutsideInput(sessionName: string, at: number = Date.now()): void {
	const ledger = ledgers.get(sessionName) ?? { pastes: [], shown: [] };
	ledger.lastOutsideInputAt = at;
	ledger.pastes = [];
	ledgers.set(sessionName, ledger);
	// Someone is acting on the terminal: an open delivery circuit probes at once.
	noteInputTouched(sessionName);
}

/**
 * The harness pastes made since the last outside input, oldest first.
 *
 * @param sessionName - The session
 * @returns The pastes (a copy)
 */
export function harnessPastesSinceOutsideInput(sessionName: string): HarnessPaste[] {
	return [...(ledgers.get(sessionName)?.pastes ?? [])];
}

/**
 * When outside input last arrived, if ever.
 *
 * @param sessionName - The session
 * @returns Epoch ms, or undefined
 */
export function lastOutsideInputAt(sessionName: string): number | undefined {
	return ledgers.get(sessionName)?.lastOutsideInputAt;
}

/**
 * Forget pastes the box no longer holds: those submitted (by our Enter),
 * or older than `before` when the box reads empty.
 *
 * @param sessionName - The session
 * @param keep - Pastes to keep
 */
export function keepHarnessPastes(sessionName: string, keep: (p: HarnessPaste) => boolean): void {
	const ledger = ledgers.get(sessionName);
	if (!ledger) return;
	ledger.pastes = ledger.pastes.filter(keep);
}

/**
 * Record the exact marker the box showed for one of our pastes.
 *
 * @param sessionName - The session
 * @param marker - The marker text ("[Pasted text #2 +5 lines]")
 * @param message - The paste it stands for
 */
export function noteShownMarker(sessionName: string, marker: string, message: string): void {
	const ledger = ledgers.get(sessionName) ?? { pastes: [], shown: [] };
	if (!ledger.shown.some((m) => m.marker === marker)) ledger.shown.push({ marker, message });
	if (ledger.shown.length > MAX_PASTES) ledger.shown.splice(0, ledger.shown.length - MAX_PASTES);
	ledgers.set(sessionName, ledger);
}

/**
 * Markers the box showed for our pastes.
 *
 * @param sessionName - The session
 * @returns Marker → message pairs (a copy)
 */
export function shownMarkers(sessionName: string): Array<{ marker: string; message: string }> {
	return [...(ledgers.get(sessionName)?.shown ?? [])];
}

/**
 * Forget shown markers (the box no longer holds them).
 *
 * @param sessionName - The session
 * @param keep - Markers to keep
 */
export function keepShownMarkers(sessionName: string, keep: (m: { marker: string; message: string }) => boolean): void {
	const ledger = ledgers.get(sessionName);
	if (ledger) ledger.shown = ledger.shown.filter(keep);
}

/**
 * Forget a session's ledger (session created, killed, runtime relaunched).
 *
 * @param sessionName - The session
 */
export function forgetInputLedger(sessionName: string): void {
	ledgers.delete(sessionName);
}

/**
 * Sessions with harness pastes on record.
 *
 * @returns Session names
 */
export function sessionsWithHarnessPastes(): string[] {
	return [...ledgers.entries()].filter(([, l]) => l.pastes.length > 0 || l.shown.length > 0).map(([s]) => s);
}

/** Clear every ledger (tests). */
export function resetInputLedgerForTesting(): void {
	ledgers.clear();
}
