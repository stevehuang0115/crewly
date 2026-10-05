/**
 * Session Command Helper
 *
 * Provides high-level terminal command operations using the ISessionBackend abstraction.
 * This helper bridges the gap between low-level PTY operations and the higher-level
 * commands that services like AgentRegistrationService need.
 *
 * Key mappings from TmuxCommandService:
 * - sendMessage → write(message + '\r')
 * - sendKey → write(keyCode)
 * - sendCtrlC → write('\x03')
 * - sendEnter → write('\r')
 * - clearCurrentCommandLine → write('\x03\x15') (Ctrl+C then Ctrl+U)
 * - capturePane → captureOutput()
 *
 * @module session-command-helper
 */

import type { ISession, ISessionBackend } from './session-backend.interface.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SESSION_COMMAND_DELAYS, EVENT_DELIVERY_CONSTANTS, PLAN_MODE_DISMISS_PATTERNS, TUI_INPUT_GUARD } from '../../constants.js';
import { delay } from '../../utils/async.utils.js';
import { assertNotSecretEnvKey } from '../../utils/secret-env.js';
import { quietShellLine } from '../../utils/shell-history.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import { attributeOwnPastes, boxIsOnlyMarkersAndPiecesOf, classifyTuiInput, isPasteMarker, pasteShowsAs, pasteShowsAsSplit, screenShowsTurnInProgress, TuiInputGuardError, TuiPasteHoldError, type TuiInputReading, type TuiInputStage } from './tui-input-guard.js';
import { forgetInputCircuit, noteInputDelivered, noteInputRefused } from './input-circuit-breaker.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import * as fs from 'fs';
import * as path from 'path';
import { noteHarnessWrite } from '../trace/turn-origin.js';
import {
	forgetInputLedger,
	harnessPastesSinceOutsideInput,
	resetInputLedgerForTesting as resetInputLedgerForTestingHook,
	keepHarnessPastes,
	keepShownMarkers,
	noteHarnessPaste,
	noteShownMarker,
	sessionsWithHarnessPastes,
	shownMarkers,
} from './input-ledger.js';

/**
 * Leading routing tags of a message ("[CHAT:abc] ", "[TASK RE-DELIVERY] "),
 * kept in front of a file-reference line so replies still route.
 *
 * @param message - The message
 * @returns The tags, or ''
 */
function leadingTags(message: string): string {
	const m = /^(?:\[[A-Za-z][A-Za-z0-9_ -]{0,40}(?::[^\]\n]{0,120})?\]\s?)+/.exec(message);
	return m ? m[0].trim().slice(0, TUI_INPUT_GUARD.FILE_REFERENCE_TAGS_MAX) : '';
}

/**
 * Write a message to a file an agent can read (owner-only permissions).
 * Files older than FILE_DELIVERY_KEEP_MS are pruned on the way.
 *
 * @param dir - Directory for delivery files
 * @param sessionName - The session
 * @param message - The message
 * @returns The file path
 */
export function writeDeliveryFile(dir: string, sessionName: string, message: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const now = Date.now();
	try {
		for (const name of fs.readdirSync(dir)) {
			const file = path.join(dir, name);
			try {
				if (now - fs.statSync(file).mtimeMs > TUI_INPUT_GUARD.FILE_DELIVERY_KEEP_MS) fs.rmSync(file, { force: true });
			} catch {
				// a file another prune removed
			}
		}
	} catch {
		// pruning is best effort
	}
	const safe = sessionName.replace(/[^A-Za-z0-9_.-]/g, '_');
	const file = path.join(dir, `${safe}-${now}-${Math.random().toString(36).slice(2, 8)}.md`);
	fs.writeFileSync(file, message, { encoding: 'utf8', mode: 0o600 });
	return file;
}

/**
 * The one-line pointer pasted instead of a message the runtime collapsed.
 *
 * @param message - The message (for its routing tags)
 * @param file - Where the message was written
 * @returns A single short line
 */
export function buildFileReferenceLine(message: string, file: string): string {
	const tags = leadingTags(message);
	return `${tags ? `${tags} ` : ''}[Crewly] This message was too long to paste here. Read the whole message in ${file} and act on it as if it had been typed here.`;
}

/**
 * Key code mappings for special keys
 */
export const KEY_CODES: Record<string, string> = {
	Enter: '\r',
	'C-c': '\x03', // Ctrl+C
	'C-u': '\x15', // Ctrl+U (clear line)
	'C-l': '\x0c', // Ctrl+L (clear screen)
	'C-d': '\x04', // Ctrl+D (EOF)
	Escape: '\x1b',
	Tab: '\t',
	'S-Tab': '\x1b[Z', // Shift+Tab (reverse tab / focus previous in TUI)
	Backspace: '\x7f',
	Delete: '\x1b[3~',
	Up: '\x1b[A',
	Down: '\x1b[B',
	Right: '\x1b[C',
	Left: '\x1b[D',
	Home: '\x1b[H',
	End: '\x1b[F',
	PageUp: '\x1b[5~',
	PageDown: '\x1b[6~',
	// Function keys — F12 is used to toggle Gemini CLI's error details panel (#130)
	F1: '\x1bOP',
	F2: '\x1bOQ',
	F3: '\x1bOR',
	F4: '\x1bOS',
	F5: '\x1b[15~',
	F6: '\x1b[17~',
	F7: '\x1b[18~',
	F8: '\x1b[19~',
	F9: '\x1b[20~',
	F10: '\x1b[21~',
	F11: '\x1b[23~',
	F12: '\x1b[24~',
};

/**
 * Session Command Helper class
 *
 * Provides a unified interface for terminal commands that works with both
 * PTY and tmux backends through the ISessionBackend abstraction.
 */
export class SessionCommandHelper {
	private logger: ComponentLogger;
	private backend: ISessionBackend;
	/**
	 * Per session: the harness's own latest paste into a box it had proven
	 * empty. While the box keeps showing it (the collapsed marker "[Pasted
	 * text #4 +5 lines]" / "[Pasted Content 1234 chars]", or the text itself)
	 * it is ours — whatever message is sent next — so a lost or never-pressed
	 * Enter can be recovered. Written by every paste path; shared across
	 * helper instances.
	 *
	 * - `pending`: pasted, not yet seen in the box (a busy Claude Code renders
	 *   a paste seconds late). The first readable box that is not empty must
	 *   show the paste's shape, or the record ends; it also ends unseen after
	 *   OWN_PASTE_PENDING_MAX_MS.
	 * - `seen`: the box showed `shown`. Every readable box since must show
	 *   exactly that; the first that does not ends the record. Unreadable
	 *   screens (a dialog) do not count as seen: unseen for
	 *   OWN_PASTE_UNSEEN_MAX_MS ends it too. While busy the watcher re-reads
	 *   the box, so a long turn keeps it alive.
	 *
	 * Also ended by our one Enter on it, and by session/runtime (re)start.
	 */
	private static readonly ownPastes = new Map<string, {
		message: string;
		shown?: string;
		pastedAt: number;
		lastSeenAt?: number;
		helper: SessionCommandHelper;
	}>();

	/** Sessions a sendMessage is typing into right now (the watcher keeps off) */
	private static readonly inFlight = new Set<string>();

	/** When each session last had a repaint requested (see readInputBoxSettled) */
	private static readonly lastRepaintAt = new Map<string, number>();

	/** The watcher re-reading boxes that hold a paste of ours */
	private static watchTimer: ReturnType<typeof setInterval> | null = null;

	/** Clock for the paste record (tests). */
	static now: () => number = Date.now;

	/** How long sendMessage waits for a late paste to render (tests shorten it). */
	static pasteRenderMaxWaitMs: number = TUI_INPUT_GUARD.PASTE_RENDER_MAX_WAIT_MS;

	/**
	 * Forget the recorded paste of a session: its runtime is being
	 * (re)started, a shell line is typed, or the session is created/killed —
	 * Claude Code's paste counter restarts at #1, and Codex markers carry only
	 * a character count, so an old record could match the owner's paste.
	 *
	 * @param sessionName - The session
	 */
	static forgetOwnPaste(sessionName: string): void {
		SessionCommandHelper.ownPastes.delete(sessionName);
		SessionCommandHelper.stopWatchingIfIdle();
	}

	/**
	 * Forget everything about a session's input: its paste record and its
	 * input ledger (session created or killed, runtime relaunched).
	 *
	 * @param sessionName - The session
	 */
	static resetSessionInput(sessionName: string): void {
		SessionCommandHelper.ownPastes.delete(sessionName);
		SessionCommandHelper.stuckSince.delete(sessionName);
		forgetInputLedger(sessionName);
		forgetInputCircuit(sessionName);
		SessionCommandHelper.stopWatchingIfIdle();
	}

	/**
	 * Called with the messages our Enter just submitted from the box (a lost
	 * Enter, or a paste that rendered late). Wired to drop queued copies of
	 * them, so a held retry does not deliver them a second time.
	 */
	static onOwnPasteSubmitted: ((sessionName: string, messages: string[]) => void) | null = null;

	/**
	 * Called once when an idle agent's box has held text that is not ours
	 * and not provably anyone else's for STUCK_INPUT_NOTIFY_MS. Wired to the
	 * blocked-input notice.
	 */
	static onStuckInput: ((sessionName: string, info: { inputLength: number; forMs: number }) => void) | null = null;

	/** Per session: since when an idle agent's box held text we could not attribute, and whether it was reported */
	private static readonly stuckSince = new Map<string, { since: number; reported: boolean }>();

	/** The latest helper, for sessions the watcher only knows from the ledger */
	private static lastHelper: SessionCommandHelper | null = null;

	/**
	 * Whether a paste of ours is on record for a session (tests, diagnostics).
	 *
	 * @param sessionName - The session
	 * @returns True while the record stands
	 */
	static hasOwnPaste(sessionName: string): boolean {
		return SessionCommandHelper.ownPastes.has(sessionName);
	}

	/**
	 * Record our paste of `message` into a box proven empty.
	 *
	 * @param sessionName - The session
	 * @param message - What was pasted
	 */
	private recordOwnPaste(sessionName: string, message: string): void {
		const at = SessionCommandHelper.now();
		SessionCommandHelper.ownPastes.set(sessionName, { message, pastedAt: at, helper: this });
		noteHarnessPaste(sessionName, message, at);
		SessionCommandHelper.lastHelper = this;
		SessionCommandHelper.startWatching();
	}

	/** Whether recording a paste starts the timed watcher (tests drive it by hand). */
	static autoWatch = true;

	/** Start the watcher (no-op when running). */
	private static startWatching(): void {
		if (SessionCommandHelper.watchTimer || !SessionCommandHelper.autoWatch) return;
		SessionCommandHelper.watchTimer = setInterval(() => {
			void SessionCommandHelper.watchOwnPastes();
		}, TUI_INPUT_GUARD.OWN_PASTE_WATCH_MS);
		SessionCommandHelper.watchTimer.unref?.();
	}

	/** Stop the watcher once no paste is on record. */
	private static stopWatchingIfIdle(): void {
		if (!SessionCommandHelper.watchTimer) return;
		if (SessionCommandHelper.ownPastes.size > 0 || sessionsWithHarnessPastes().length > 0) return;
		clearInterval(SessionCommandHelper.watchTimer);
		SessionCommandHelper.watchTimer = null;
	}

	/**
	 * One watcher pass: re-read every box holding a paste of ours (keeping
	 * the "seen continuously" record alive through a long turn, ending it the
	 * moment the box shows anything else), and once the agent is idle with
	 * our paste still sitting there, press Enter on it once.
	 *
	 * @returns Resolves when every session was looked at
	 */
	static async watchOwnPastes(): Promise<void> {
		const sessions = new Set<string>([...SessionCommandHelper.ownPastes.keys(), ...sessionsWithHarnessPastes()]);
		for (const sessionName of sessions) {
			if (SessionCommandHelper.inFlight.has(sessionName)) continue;
			const helper = SessionCommandHelper.ownPastes.get(sessionName)?.helper ?? SessionCommandHelper.lastHelper;
			if (!helper) continue;
			try {
				if (!helper.backend.sessionExists(sessionName)) {
					SessionCommandHelper.resetSessionInput(sessionName);
					continue;
				}
				const reading = helper.readInputBox(sessionName, '', 'recovery');
				if (reading.state === 'empty' || reading.state === 'unknown') {
					SessionCommandHelper.stuckSince.delete(sessionName);
					continue;
				}
				if (!(await helper.isAgentIdle(sessionName))) continue;
				if (reading.ownPasteMarker) {
					const outcome = await helper.ensureOwnPasteSubmitted(sessionName);
					helper.logger.warn('Our earlier paste was still in the input box of an idle agent — pressed Enter on it once', { sessionName, outcome });
					continue;
				}
				// An idle agent's box holds text we cannot attribute to our pastes,
				// though no outside input arrived since them (else the ledger would
				// be empty and we would not be here). Not submitted: text the harness
				// cannot prove it wrote is never submitted (2026-10-03 incident).
				// Reported once if it stays.
				const now = SessionCommandHelper.now();
				const stuck = SessionCommandHelper.stuckSince.get(sessionName) ?? { since: now, reported: false };
				SessionCommandHelper.stuckSince.set(sessionName, stuck);
				if (!stuck.reported && now - stuck.since >= TUI_INPUT_GUARD.STUCK_INPUT_NOTIFY_MS) {
					stuck.reported = true;
					helper.logger.warn('An idle agent\'s input box has held text Crewly cannot attribute for a long time', { sessionName, inputLength: reading.text.length });
					SessionCommandHelper.onStuckInput?.(sessionName, { inputLength: reading.text.length, forMs: now - stuck.since });
				}
			} catch {
				// A session that vanished mid-pass: the next pass drops it.
			}
		}
		SessionCommandHelper.stopWatchingIfIdle();
	}

	/** Pause between screen samples when checking that a busy screen repaints (tests shorten it). */
	static repaintSampleMs: number = TUI_INPUT_GUARD.BUSY_REPAINT_SAMPLE_MS;

	/**
	 * Whether the agent in a session is mid-turn. All three must hold:
	 * - a turn signal where the runtime paints it (see readTurnSignals): the
	 *   busy bar in the footer below the box, or the spinner line directly
	 *   above it — never text in the transcript;
	 * - the screen is repainting: it changes within a few short samples (a
	 *   live spinner animates its glyph and counter several times a second);
	 * - the PTY produced output within BUSY_FROZEN_MS: a screen that stopped
	 *   repainting is frozen, not busy, and a held message must go out.
	 *
	 * @param sessionName - The session
	 * @returns True when busy
	 */
	async isAgentBusy(sessionName: string): Promise<boolean> {
		const read = (): string => {
			try {
				return this.backend.captureOutput(sessionName, TUI_INPUT_GUARD.BUSY_BAR_TAIL_LINES) ?? '';
			} catch {
				return '';
			}
		};
		const first = read();
		if (!screenShowsTurnInProgress(first)) return false;
		const tracker = PtyActivityTrackerService.getInstance() as { getRawOutputIdleMs?: (s: string) => number | null };
		const quietMs = typeof tracker.getRawOutputIdleMs === 'function' ? tracker.getRawOutputIdleMs(sessionName) : null;
		if (quietMs !== null && quietMs >= TUI_INPUT_GUARD.BUSY_FROZEN_MS) {
			this.logger.warn('Screen shows a turn but the PTY has been silent — treating the agent as idle', { sessionName, quietMs });
			return false;
		}
		for (let i = 0; i < TUI_INPUT_GUARD.BUSY_REPAINT_SAMPLES; i++) {
			await delay(SessionCommandHelper.repaintSampleMs);
			const next = read();
			if (!screenShowsTurnInProgress(next)) return false;
			if (next !== first) return true;
		}
		return false;
	}

	/**
	 * Whether the agent in a session is resting: not busy (see
	 * {@link isAgentBusy}) and no meaningful output for a few seconds.
	 *
	 * @param sessionName - The session
	 * @returns True when idle
	 */
	async isAgentIdle(sessionName: string): Promise<boolean> {
		if (await this.isAgentBusy(sessionName)) return false;
		return PtyActivityTrackerService.getInstance().getIdleTimeMs(sessionName) >= SESSION_COMMAND_DELAYS.AGENT_BUSY_IDLE_THRESHOLD_MS;
	}

	constructor(backend: ISessionBackend) {
		this.logger = LoggerService.getInstance().createComponentLogger('SessionCommandHelper');
		this.backend = backend;
		// Any helper can read a box (they share the one backend): the watcher
		// uses the latest for sessions it only knows from the input ledger.
		SessionCommandHelper.lastHelper = this;
	}

	/**
	 * Get a session by name, throwing an error if it doesn't exist.
	 *
	 * @param sessionName - The name of the session to retrieve
	 * @returns The session instance
	 * @throws Error if the session does not exist
	 */
	private getSessionOrThrow(sessionName: string): ISession {
		const session = this.backend.getSession(sessionName);
		if (!session) {
			throw new Error(`Session '${sessionName}' does not exist`);
		}
		return session;
	}

	/**
	 * Check if a session exists
	 */
	sessionExists(sessionName: string): boolean {
		return this.backend.sessionExists(sessionName);
	}

	/**
	 * Get a session by name
	 */
	getSession(sessionName: string): ISession | undefined {
		return this.backend.getSession(sessionName);
	}

	/**
	 * Send a message to an agent session and submit it with Enter — guarded.
	 *
	 * The harness only submits its own text (2026-10-03 phantom-input
	 * incident: a predicted "owner" message sitting in Claude Code's input
	 * was submitted with a delivery):
	 *
	 * 1. Before typing, the input box must be readable and empty. A leftover
	 *    exact copy of this message (an earlier attempt) is cleared; anything
	 *    else — someone's half-typed text, an unreadable screen — is left
	 *    untouched and nothing is typed.
	 * 2. The message is pasted (bracketed paste) without Enter.
	 * 3. Enter is pressed only when the box holds exactly the message (or the
	 *    runtime's collapsed "[Pasted text …]" marker). Otherwise nothing is
	 *    submitted and nothing is cleared: text we cannot prove is ours is
	 *    never wiped.
	 *
	 * Every paste is recorded (see `ownPastes`): if its Enter is lost, or it
	 * renders only after we stopped looking (a busy Claude Code), it stays
	 * ours while the box keeps showing it, and is submitted once the agent
	 * is idle — by the next delivery or by the watcher.
	 *
	 * A refusal throws `TuiInputGuardError`; agent delivery keeps the message
	 * queued and retries (AgentRegistrationService). Shell command lines
	 * typed before a runtime starts use {@link sendShellLine} instead.
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 * @throws Error if session does not exist
	 * @throws TuiInputGuardError when the box is unreadable or not ours
	 */
	async sendMessage(sessionName: string, message: string): Promise<void> {
		SessionCommandHelper.inFlight.add(sessionName);
		try {
			await this.sendMessageGuarded(sessionName, message);
			noteInputDelivered(sessionName, SessionCommandHelper.now());
		} catch (err) {
			// Feeds the circuit breaker that stops redelivery storms against a
			// box that stays someone else's (crewly#1028).
			if (err instanceof TuiInputGuardError) {
				noteInputRefused(sessionName, { state: err.reading.state, inputLength: err.reading.text.length }, SessionCommandHelper.now());
			}
			throw err;
		} finally {
			SessionCommandHelper.inFlight.delete(sessionName);
		}
	}

	/**
	 * The body of {@link sendMessage}, run while the watcher keeps off.
	 *
	 * @param sessionName - The session to send to
	 * @param message - The message to send
	 */
	private async sendMessageGuarded(sessionName: string, message: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		this.logger.debug('Sending message to session', {
			sessionName,
			messageLength: message.length,
			isMultiLine: message.includes('\n'),
		});

		// Step 1: the box must be readable and empty before we type.
		let before = await this.readInputBoxSettled(sessionName, message, 'before-write');

		// Never paste while an earlier paste of ours may still land in the box
		// (pasted, not yet seen — a busy Claude Code renders it seconds late):
		// two pastes in one box are one prompt nobody can take apart
		// (1.20.207 Ella). When it is this very message, wait for it a while
		// and submit it — that is this delivery.
		const pending = SessionCommandHelper.ownPastes.get(sessionName);
		if (pending && pending.shown === undefined && !before.ownPasteMarker) {
			if (pending.message === message) {
				const deadline = pending.pastedAt + TUI_INPUT_GUARD.PASTE_PENDING_HOLD_MS;
				const maxPolls = Math.ceil(TUI_INPUT_GUARD.PASTE_PENDING_HOLD_MS / TUI_INPUT_GUARD.PASTE_RENDER_POLL_MS);
				for (let i = 0; i < maxPolls && SessionCommandHelper.now() < deadline && before.state === 'empty'; i++) {
					await delay(TUI_INPUT_GUARD.PASTE_RENDER_POLL_MS);
					before = this.readInputBox(sessionName, message, 'before-write');
				}
			}
			if (!before.ownPasteMarker) {
				this.logger.info('Not pasting: an earlier paste of ours may still render in the input box — holding this message', {
					sessionName,
					pendingForMs: SessionCommandHelper.now() - pending.pastedAt,
					sameMessage: pending.message === message,
				});
				throw new TuiPasteHoldError('pending-paste');
			}
		}

		if (before.ownPasteMarker) {
			// An earlier paste of ours is still in the box (its Enter was lost,
			// or it rendered late): submit it first. When it holds this very
			// message, submitting it IS this delivery — never paste it twice.
			// Only when certain: a guessed match could be another message, and
			// treating this delivery as done would lose this one.
			const sameMessage = !before.ownPasteAmbiguous && (before.ownPasteMessages ?? []).includes(message);
			this.logger.warn('An earlier paste of ours is still in the input box — submitting it', { sessionName, sameMessage, pastes: before.ownPasteMessages?.length ?? 1 });
			const outcome = await this.ensureOwnPasteSubmitted(sessionName);
			if (sameMessage && outcome === 'submitted') return;
			// Do not paste on top of what we just submitted: hold this message
			// until the box has settled (it may still be clearing, or our Enter
			// may not have taken — 1.20.207 02:12).
			throw new TuiPasteHoldError('just-submitted');
		}
		if (before.state === 'ours' && !before.ownPasteMarker) {
			// Our own earlier paste of this very message: safe to clear.
			before = await this.clearInputBox(sessionName, message, before);
		}
		if (before.state !== 'empty') {
			this.logger.warn('Not typing into the input box: it is unreadable or holds text the harness did not write', {
				sessionName,
				state: before.state,
				layout: before.layout,
				inputPreview: before.text.slice(0, 80),
			});
			throw new TuiInputGuardError('before-write', before);
		}

		// Step 2: paste. Wrap the message in bracketed paste markers
		// (\x1b[200~ ... \x1b[201~) so TUI applications (Gemini CLI, Codex CLI,
		// Claude Code) treat it as pasted text rather than typed keystrokes.
		// Without this, special characters like (), $, `, and " can trigger
		// shell mode or be read as key sequences in Gemini CLI (#292, #293).
		session.write(`\x1b[200~${message}\x1b[201~`);
		this.recordOwnPaste(sessionName, message);

		// Scale delay based on message size: large prompts (e.g. 409-line registration
		// prompts) need more time for Claude Code to process the bracketed paste.
		// Base delay + 1ms per 10 characters, capped at 5 seconds.
		const scaledDelay = Math.min(
			SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(message.length / 10),
			5000
		);
		await delay(scaledDelay);

		// Step 3: submit only our own text.
		let after = this.readInputBox(sessionName, message, 'after-paste');
		for (const waitMs of TUI_INPUT_GUARD.PASTE_RENDER_RETRY_MS) {
			if (after.state !== 'empty') break;
			await delay(waitMs); // the paste may not have rendered yet
			after = this.readInputBox(sessionName, message, 'after-paste');
		}
		// A busy agent renders a paste late (Claude Code: ~10 s mid-turn,
		// 2026-10-03 Ella). Keep looking a while before giving up; if it shows
		// up later anyway, the record makes it ours and it is submitted then.
		const renderDeadline = SessionCommandHelper.now() + SessionCommandHelper.pasteRenderMaxWaitMs;
		while (after.state === 'empty' && SessionCommandHelper.now() < renderDeadline) {
			await delay(TUI_INPUT_GUARD.PASTE_RENDER_POLL_MS);
			after = this.readInputBox(sessionName, message, 'after-paste');
		}
		if (after.state === 'unknown') after = await this.readInputBoxSettled(sessionName, message, 'after-paste');
		if (after.state !== 'ours' && this.isOwnUnmatchedCollapse(sessionName, after, message)) {
			// Our paste, collapsed by the runtime into markers we cannot account
			// for line by line (crewly#1028). Nobody typed since we pasted into a
			// box we proved empty, so it is ours: clear it and send the message
			// in a form that is never collapsed.
			await this.deliverViaFileReference(sessionName, message, after);
			return;
		}
		if (after.state !== 'ours') {
			this.logger.warn('Input box does not hold exactly our text after the paste — not pressing Enter, not clearing', {
				sessionName,
				state: after.state,
				layout: after.layout,
				inputPreview: after.text.slice(0, 80),
			});
			throw new TuiInputGuardError('before-submit', after);
		}

		// The prompt this Enter submits is a harness delivery: a submitted
		// prompt with no such write before it is recorded as unsolicited.
		noteHarnessWrite(sessionName);

		// Send Enter explicitly as a separate keystroke
		// Use \r (carriage return) which is the standard Enter key in terminals
		session.write('\r');

		// Additional delay for Enter to be processed
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);

		this.logger.debug('Message sent with Enter key', {
			sessionName,
			messageLength: message.length,
			pasteDelay: scaledDelay,
			layout: after.layout,
		});
	}

	/**
	 * Where messages delivered by file reference are written (tests replace
	 * it). Default: `<CREWLY_HOME>/deliveries`.
	 */
	static deliveryDir: () => string = () => path.join(getCrewlyHomePath(), TUI_INPUT_GUARD.FILE_DELIVERY_DIR);

	/**
	 * Whether a box read right after our paste holds that paste, collapsed by
	 * the runtime into markers we cannot account for line by line
	 * (crewly#1028): nothing but paste markers and pieces of the message, and
	 * no outside input since we pasted it into a box we proved empty — the
	 * input ledger drops our pastes on any outside input, so the paste still
	 * being on record is that proof. An owner's own paste is never this: it
	 * arrives as outside input.
	 *
	 * @param sessionName - The session
	 * @param reading - The box read after our paste
	 * @param message - What we pasted
	 * @returns True when the box is our collapsed paste
	 */
	private isOwnUnmatchedCollapse(sessionName: string, reading: TuiInputReading, message: string): boolean {
		if (reading.state !== 'foreign' || reading.layout !== 'claude-code') return false;
		if (!boxIsOnlyMarkersAndPiecesOf(reading.text, message)) return false;
		const pastes = harnessPastesSinceOutsideInput(sessionName);
		// Our paste of this message must be the latest thing that went in.
		return pastes.length > 0 && pastes[pastes.length - 1].message === message;
	}

	/**
	 * Clear our collapsed paste and deliver the message as a one-line pointer
	 * to a file holding it: a short single line is never collapsed, so the
	 * box shows exactly what we pasted and the usual exact-match check can
	 * press Enter. Used once per delivery, only after
	 * {@link isOwnUnmatchedCollapse} proved the box ours.
	 *
	 * @param sessionName - The session
	 * @param message - The message
	 * @param current - The box as just read
	 * @throws TuiInputGuardError when the box does not clear or the pointer
	 *   does not show as pasted
	 */
	private async deliverViaFileReference(sessionName: string, message: string, current: TuiInputReading): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		this.logger.warn('Our paste was collapsed into markers that do not add up to it — clearing it and delivering the message by file reference', {
			sessionName,
			messageLength: message.length,
			inputPreview: current.text.slice(0, 80),
		});
		const cleared = await this.clearInputBox(sessionName, message, current);
		if (cleared.state !== 'empty') throw new TuiInputGuardError('before-submit', cleared);
		// The collapsed paste is gone: nothing may submit it later.
		SessionCommandHelper.forgetOwnPaste(sessionName);
		keepHarnessPastes(sessionName, (p) => p.message !== message);
		keepShownMarkers(sessionName, (m) => m.message !== message);

		const pointer = buildFileReferenceLine(message, writeDeliveryFile(SessionCommandHelper.deliveryDir(), sessionName, message));
		session.write(`\x1b[200~${pointer}\x1b[201~`);
		this.recordOwnPaste(sessionName, pointer);
		await delay(SESSION_COMMAND_DELAYS.MESSAGE_DELAY);
		let after = this.readInputBox(sessionName, pointer, 'after-paste');
		for (const waitMs of TUI_INPUT_GUARD.PASTE_RENDER_RETRY_MS) {
			if (after.state !== 'empty') break;
			await delay(waitMs);
			after = this.readInputBox(sessionName, pointer, 'after-paste');
		}
		if (after.state !== 'ours') {
			this.logger.warn('The file-reference line did not show as pasted — not pressing Enter', { sessionName, state: after.state });
			throw new TuiInputGuardError('before-submit', after);
		}
		noteHarnessWrite(sessionName);
		session.write('\r');
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
		this.logger.info('Delivered a collapsed message by file reference', { sessionName, messageLength: message.length });
	}

	/**
	 * After a delivery: if the box still holds the collapsed marker of our
	 * own paste, the Enter was lost — press Enter once and look again. Runs
	 * whatever the caller's success checks said: a fast-reply or weak-signal
	 * check can report "delivered" while the marker is still sitting there.
	 *
	 * @param sessionName - The session
	 * @returns `clear` (no marker of ours in the box), `submitted` (Enter took
	 *   it), or `stuck` (still there after one Enter — not delivered)
	 */
	async ensureOwnPasteSubmitted(sessionName: string): Promise<'clear' | 'submitted' | 'stuck'> {
		const reading = this.readInputBox(sessionName, '', 'recovery');
		if (!reading.ownPasteMarker) return 'clear';
		const session = this.getSessionOrThrow(sessionName);
		noteHarnessWrite(sessionName);
		session.write('\r');
		await delay(TUI_INPUT_GUARD.OWN_MARKER_SUBMIT_SETTLE_MS);
		const after = this.readInputBox(sessionName, '', 'recovery');
		// One Enter on it, whatever happened: never press Enter on those
		// pastes again — not from the record, not from the ledger.
		const messages = reading.ownPasteMessages ?? [];
		SessionCommandHelper.forgetOwnPaste(sessionName);
		keepHarnessPastes(sessionName, (p) => !messages.includes(p.message));
		keepShownMarkers(sessionName, (m) => !messages.includes(m.message));
		if (after.state !== 'empty' && after.state !== 'unknown' && after.text.trim() === reading.text.trim()) {
			this.logger.warn('Our pasted message is still in the input box after Enter — not delivered', { sessionName });
			return 'stuck';
		}
		this.logger.info('Submitted our own paste whose Enter had been lost', { sessionName, pastes: messages.length });
		SessionCommandHelper.stuckSince.delete(sessionName);
		if (messages.length > 0 && reading.ownPasteAmbiguous) {
			// Which of our same-shaped pastes this was is a guess: dropping the
			// wrong queued copy would lose one message and send the other twice.
			// Keep the queue as it is — a possible duplicate beats a loss.
			this.logger.warn('Submitted a paste of ours that matched more than one queued message by shape — leaving their queued copies (a duplicate is possible, a loss is not)', {
				sessionName,
				guessed: messages.length,
			});
		} else if (messages.length > 0) {
			try {
				SessionCommandHelper.onOwnPasteSubmitted?.(sessionName, messages);
			} catch {
				// The hook only tidies queued copies; delivery already happened.
			}
		}
		return 'submitted';
	}

	/**
	 * Forget recorded paste markers (tests).
	 */
	static resetOwnPasteMarkersForTesting(): void {
		SessionCommandHelper.ownPastes.clear();
		SessionCommandHelper.inFlight.clear();
		SessionCommandHelper.stuckSince.clear();
		resetInputLedgerForTestingHook();
		SessionCommandHelper.stopWatchingIfIdle();
	}

	/**
	 * Type a command line into a plain shell and run it (paste + Enter).
	 *
	 * Only for the lines Crewly types into a session's login shell before a
	 * runtime starts there (history off, `cd`, PATH, the launch command). It
	 * does not read an input box: a shell has none. Never use it to talk to
	 * an agent — that is {@link sendMessage}.
	 *
	 * @param sessionName - The session
	 * @param line - The command line
	 */
	async sendShellLine(sessionName: string, line: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		// A shell line means the runtime is (re)starting in this session.
		SessionCommandHelper.resetSessionInput(sessionName);
		session.write(`\x1b[200~${line}\x1b[201~`);
		await delay(Math.min(SESSION_COMMAND_DELAYS.MESSAGE_DELAY + Math.ceil(line.length / 10), 5000));
		session.write('\r');
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Read what an agent's input box really holds, relative to a message.
	 *
	 * Uses the backend's faint-free screen view, so ghost text (Claude Code's
	 * prompt suggestion, placeholders) reads as an empty box. Returns
	 * `unknown` when the backend has no styled capture or no input box of a
	 * known layout is on screen.
	 *
	 * @param sessionName - The session to read
	 * @param message - The harness's message to compare against ('' for none)
	 * @param stage - Why it is read (see classifyTuiInput)
	 * @returns The reading
	 */
	readInputBox(sessionName: string, message: string, stage: TuiInputStage = 'recovery'): TuiInputReading {
		// First: a paste record that has gone unseen too long ends here, even
		// when the box cannot be read now.
		const shown = this.ownPasteShown(sessionName);
		const capture = this.backend.captureInputView;
		if (typeof capture !== 'function') return { state: 'unknown', text: '', lineCount: 0 };
		try {
			const view = capture.call(this.backend, sessionName);
			if (!view) return { state: 'unknown', text: '', lineCount: 0 };
			return this.applyOwnPaste(sessionName, classifyTuiInput(view, message, stage, shown));
		} catch {
			return { state: 'unknown', text: '', lineCount: 0 };
		}
	}

	/**
	 * {@link readInputBox}, but an `unknown` reading is not taken at face
	 * value (crewly 1.20.232, 2026-10-05: hundreds of held deliveries):
	 * 1. wait for the terminal parser to drain and read again — a read can
	 *    land mid-frame on a loaded machine;
	 * 2. still unknown: ask the runtime to repaint its whole screen (one
	 *    column narrower and back, no input sent — Claude Code keeps the box
	 *    text) at most once per REPAINT_MIN_INTERVAL_MS, and read again —
	 *    Claude Code 2.1.289 sometimes emits a broken UTF-8 byte, and the
	 *    cells it leaves are only cleared by a full repaint.
	 * Only re-reads: the reading is classified exactly as by readInputBox,
	 * so text the harness did not write is never read as empty or ours.
	 * When it stays unknown, the bottom rows are logged as a shape (letters
	 * and digits masked) so new screen layouts can be recognised.
	 *
	 * @param sessionName - The session to read
	 * @param message - The harness's message to compare against ('' for none)
	 * @param stage - Why it is read
	 * @returns The reading
	 */
	async readInputBoxSettled(sessionName: string, message: string, stage: TuiInputStage): Promise<TuiInputReading> {
		let reading = this.readInputBox(sessionName, message, stage);
		if (reading.state !== 'unknown') return reading;
		try {
			await this.backend.flushInputView?.(sessionName);
		} catch {
			// best effort
		}
		await delay(TUI_INPUT_GUARD.UNKNOWN_REREAD_MS);
		reading = this.readInputBox(sessionName, message, stage);
		if (reading.state !== 'unknown') {
			this.logger.info('Input box readable on a second look (the screen was mid-frame)', { sessionName, state: reading.state });
			return reading;
		}
		const now = SessionCommandHelper.now();
		const last = SessionCommandHelper.lastRepaintAt.get(sessionName) ?? 0;
		if (typeof this.backend.requestRepaint === 'function' && now - last >= TUI_INPUT_GUARD.REPAINT_MIN_INTERVAL_MS) {
			SessionCommandHelper.lastRepaintAt.set(sessionName, now);
			let requested = false;
			try {
				requested = await this.backend.requestRepaint(sessionName, TUI_INPUT_GUARD.REPAINT_RESIZE_SETTLE_MS);
			} catch {
				requested = false;
			}
			if (requested) {
				await delay(TUI_INPUT_GUARD.REPAINT_READ_SETTLE_MS);
				try {
					await this.backend.flushInputView?.(sessionName);
				} catch {
					// best effort
				}
				reading = this.readInputBox(sessionName, message, stage);
				this.logger.info('Asked the runtime to repaint an unreadable input box', { sessionName, state: reading.state });
				if (reading.state !== 'unknown') return reading;
			}
		}
		this.logger.warn('Input box still unreadable — screen shape (letters and digits masked)', {
			sessionName,
			stage,
			shape: this.unreadableShape(sessionName),
		});
		return reading;
	}

	/**
	 * The bottom rows of a session's input view with every letter and digit
	 * masked as `x`: enough to see the layout (rules, prompt, footer, U+FFFD
	 * cells, stray escape text), never the words.
	 *
	 * @param sessionName - The session
	 * @returns Masked rows, bottom-most last
	 */
	private unreadableShape(sessionName: string): string[] {
		try {
			const view = this.backend.captureInputView?.call(this.backend, sessionName);
			if (!view) return [];
			const lines = [...view.lines];
			while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
			return lines.slice(-TUI_INPUT_GUARD.UNKNOWN_SHAPE_ROWS).map((l) => l.replace(/[\p{L}\p{N}]/gu, 'x').slice(0, 120));
		} catch {
			return [];
		}
	}

	/**
	 * What the box showed for our recorded paste, while the record stands.
	 * Ends the record when it has gone unseen too long.
	 *
	 * @param sessionName - The session
	 * @returns The text the box showed, or undefined (none seen / no record)
	 */
	private ownPasteShown(sessionName: string): string | undefined {
		const rec = SessionCommandHelper.ownPastes.get(sessionName);
		if (!rec) return undefined;
		const now = SessionCommandHelper.now();
		const unseenFor = now - (rec.lastSeenAt ?? rec.pastedAt);
		const limit = rec.shown === undefined ? TUI_INPUT_GUARD.OWN_PASTE_PENDING_MAX_MS : TUI_INPUT_GUARD.OWN_PASTE_UNSEEN_MAX_MS;
		if (unseenFor > limit) {
			SessionCommandHelper.forgetOwnPaste(sessionName);
			return undefined;
		}
		return rec.shown;
	}

	/**
	 * Keep the paste record in step with a reading: the record stands only
	 * while every readable box shows our paste. A pending paste (not seen
	 * yet) is adopted when the box first shows its shape; an empty box keeps
	 * it pending; anything else ends it.
	 *
	 * @param sessionName - The session
	 * @param reading - The classification just made
	 * @returns The reading, marked `ownPasteMarker` when the box shows our paste
	 */
	private applyOwnPaste(sessionName: string, reading: TuiInputReading): TuiInputReading {
		if (reading.state === 'unknown') return reading;
		const now = SessionCommandHelper.now();
		if (reading.state === 'empty') {
			// Nothing of ours in the box now. Pastes older than the render
			// window were submitted (or lost); markers the box showed are gone.
			keepHarnessPastes(sessionName, (p) => now - p.at < TUI_INPUT_GUARD.PASTE_PENDING_HOLD_MS);
			keepShownMarkers(sessionName, () => false);
		}
		const rec = SessionCommandHelper.ownPastes.get(sessionName);
		if (rec) {
			if (rec.shown !== undefined) {
				if (reading.ownPasteMarker) {
					rec.lastSeenAt = now;
					return { ...reading, ownPasteMessages: [rec.message] };
				}
				SessionCommandHelper.forgetOwnPaste(sessionName);
			} else if (reading.state !== 'empty') {
				if (pasteShowsAs(reading.text, rec.message) || pasteShowsAsSplit(reading.text, rec.message)) {
					rec.shown = reading.text.trim();
					rec.lastSeenAt = now;
					// One marker stands for the whole paste; split pieces do not each.
					if (isPasteMarker(rec.shown)) noteShownMarker(sessionName, rec.shown, rec.message);
					return { ...reading, state: 'ours', ownPasteMarker: true, ownPasteMessages: [rec.message] };
				}
				SessionCommandHelper.forgetOwnPaste(sessionName);
			}
		}
		if (reading.state === 'empty' || reading.ownPasteMarker) return reading;
		// No single recorded paste matches. The box may still be made up only
		// of our pastes — several run together, or one whose record ended —
		// with no outside input since (input-ledger).
		const attribution = attributeOwnPastes(
			reading.text,
			harnessPastesSinceOutsideInput(sessionName).map((p) => p.message),
			shownMarkers(sessionName),
		);
		if (attribution) {
			return { ...reading, state: 'ours', ownPasteMarker: true, ownPasteMessages: attribution.messages, ownPasteAmbiguous: attribution.ambiguous };
		}
		return reading;
	}

	/**
	 * Empty the input box — only call it for text proven to be the harness's
	 * own. Sends Ctrl+U then Backspace (clear the line, join the empty line to
	 * the one above), re-reading after each pair, until the box reads empty;
	 * one pair per line plus a margin (verified live on Claude Code, Codex
	 * and Gemini). A box that stops being readable is not "cleared": the
	 * final reading is then `unknown`, and callers treat only `empty` as
	 * success. Never sends Escape (cancels a running Claude Code turn; twice
	 * opens Rewind) or Ctrl+C (twice exits).
	 *
	 * @param sessionName - The session
	 * @param message - The harness's message, for classification
	 * @param current - A reading just taken (saves one re-read)
	 * @returns The final reading (`empty` when cleared)
	 */
	async clearInputBox(sessionName: string, message: string, current?: TuiInputReading): Promise<TuiInputReading> {
		const session = this.getSessionOrThrow(sessionName);
		let reading = current ?? this.readInputBox(sessionName, message, 'before-write');
		if (reading.state === 'empty' || reading.state === 'unknown') return reading;
		const lines = Math.max(reading.lineCount, message.split('\n').length, 1);
		const budget = Math.min(lines + TUI_INPUT_GUARD.CLEAR_PAIRS_EXTRA, TUI_INPUT_GUARD.CLEAR_PAIRS_MAX);
		for (let i = 0; i < budget; i++) {
			session.write(TUI_INPUT_GUARD.CLEAR_KEY);
			session.write(TUI_INPUT_GUARD.JOIN_KEY);
			await delay(TUI_INPUT_GUARD.CLEAR_SETTLE_MS);
			reading = this.readInputBox(sessionName, message, 'before-write');
			if (reading.state === 'empty' || reading.state === 'unknown') break;
		}
		if (reading.state !== 'empty') {
			this.logger.warn('Input box did not clear', { sessionName, state: reading.state, budget });
		}
		return reading;
	}

	/**
	 * Press Enter only when the input box holds exactly the harness's text.
	 * The safe replacement for "press Enter / Tab+Enter to recover a stuck
	 * message": an empty box (which may show a ghost suggestion) or a box
	 * with anyone else's text is never submitted.
	 *
	 * @param sessionName - The session
	 * @param message - The message the harness wrote
	 * @returns The reading; Enter was pressed only when its state is `ours`
	 */
	async submitIfInputIsOurs(sessionName: string, message: string): Promise<TuiInputReading> {
		const reading = this.readInputBox(sessionName, message, 'recovery');
		if (reading.state !== 'ours') {
			this.logger.debug('Not pressing Enter — input box does not hold our text', {
				sessionName,
				state: reading.state,
			});
			return reading;
		}
		const session = this.getSessionOrThrow(sessionName);
		noteHarnessWrite(sessionName);
		session.write('\r');
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
		return reading;
	}

	/**
	 * Send a key to a session
	 *
	 * @param sessionName - The session to send to
	 * @param key - The key name (e.g., 'Enter', 'C-c', 'Escape')
	 * @throws Error if session does not exist or key is unknown
	 */
	async sendKey(sessionName: string, key: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		const keyCode = KEY_CODES[key];
		if (!keyCode) {
			// If not a special key, send as literal
			session.write(key);
		} else {
			session.write(keyCode);
		}

		this.logger.debug('Sent key to session', {
			sessionName,
			key,
			isSpecialKey: !!keyCode,
		});

		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Send Ctrl+C to a session
	 */
	async sendCtrlC(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write('\x03');
		this.logger.debug('Sent Ctrl+C to session', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Send Enter key to a session
	 */
	async sendEnter(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write('\r');
		this.logger.debug('Sent Enter to session', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Send Escape key to a session
	 */
	async sendEscape(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);
		session.write('\x1b');
		this.logger.debug('Sent Escape to session', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Detect and dismiss interactive prompts (e.g., plan mode) before message delivery.
	 * Checks the last terminal output for plan mode patterns and sends Escape to exit
	 * if detected. This prevents agents from getting permanently stuck in plan mode.
	 *
	 * @param sessionName - The session to check
	 * @returns True if an interactive prompt was detected and dismissed
	 */
	async dismissInteractivePromptIfNeeded(sessionName: string): Promise<boolean> {
		const output = this.capturePane(sessionName);

		// Guard: do NOT send ESC if the agent is actively processing.
		// ESC during processing triggers Claude Code's Rewind mode, which
		// permanently blocks input. Two ESCs = unrecoverable Rewind UI takeover.
		// Use PTY idle time for robust cross-runtime detection instead of regex.
		const idleMs = PtyActivityTrackerService.getInstance().getIdleTimeMs(sessionName);
		const isBusy = idleMs < SESSION_COMMAND_DELAYS.AGENT_BUSY_IDLE_THRESHOLD_MS;
		if (isBusy) {
			this.logger.debug('Skipping plan mode dismissal — agent is busy', {
				sessionName,
			});
			return false;
		}

		// Restrict plan mode detection to the last 500 chars to avoid
		// false-positives from historical output further up the buffer.
		const recentOutput = output.slice(-500);
		const isPlanMode = PLAN_MODE_DISMISS_PATTERNS.some(pattern => pattern.test(recentOutput));

		if (isPlanMode) {
			this.logger.warn('Plan mode detected in session, sending Escape to dismiss', {
				sessionName,
			});
			await this.sendEscape(sessionName);
			await delay(SESSION_COMMAND_DELAYS.CLAUDE_RECOVERY_DELAY);
			return true;
		}

		return false;
	}

	/**
	 * Clear the current command line in a session
	 * Sends Ctrl+C followed by Ctrl+U to cancel any input and clear the line
	 */
	async clearCurrentCommandLine(sessionName: string): Promise<void> {
		const session = this.getSessionOrThrow(sessionName);

		// Ctrl+C to cancel any running command
		session.write('\x03');
		await delay(SESSION_COMMAND_DELAYS.CLEAR_COMMAND_DELAY);

		// Ctrl+U to clear the current line
		session.write('\x15');

		this.logger.debug('Cleared command line', { sessionName });
		await delay(SESSION_COMMAND_DELAYS.KEY_DELAY);
	}

	/**
	 * Capture terminal output from a session.
	 *
	 * Strips trailing empty lines that result from empty terminal rows below
	 * the actual content. Large terminals (e.g., maximized browser windows)
	 * can have 50+ empty rows below the prompt, which would cause prompt
	 * detection to fail if the capture window is too small.
	 *
	 * @param sessionName - The session to capture from
	 * @param lines - Number of lines to capture (default: 200)
	 * @returns The captured terminal content with trailing empty lines removed
	 */
	capturePane(sessionName: string, lines: number = 200): string {
		const output = this.backend.captureOutput(sessionName, lines);
		// Strip trailing empty/whitespace-only lines from terminal buffer.
		// xterm.js returns empty rows for unused terminal space below content.
		// NOTE: The previous regex /(\n\s*)+$/ caused catastrophic backtracking
		// (ReDoS) because \s* includes \n, creating exponential backtracking on
		// long terminal output with many trailing blank lines. This iterative
		// approach is O(n) and immune to ReDoS.
		const outputLines = output.split('\n');
		let lastContentLine = outputLines.length - 1;
		while (lastContentLine >= 0 && outputLines[lastContentLine].trim() === '') {
			lastContentLine--;
		}
		if (lastContentLine < 0) return '\n';
		return outputLines.slice(0, lastContentLine + 1).join('\n') + '\n';
	}

	/**
	 * Get raw output history with ANSI escape codes preserved.
	 *
	 * @param sessionName - The session to get history from
	 * @returns Raw output history with ANSI codes
	 */
	getRawHistory(sessionName: string): string {
		return this.backend.getRawHistory(sessionName);
	}

	/**
	 * List all active sessions
	 */
	listSessions(): string[] {
		return this.backend.listSessions();
	}

	/**
	 * Kill a session
	 */
	async killSession(sessionName: string): Promise<void> {
		SessionCommandHelper.resetSessionInput(sessionName);
		await this.backend.killSession(sessionName);
		this.logger.info('Session killed', { sessionName });
	}

	/**
	 * Create a new session
	 *
	 * @param sessionName - Unique name for the session
	 * @param cwd - Working directory for the session
	 * @param options - Additional session options
	 * @returns The created session
	 */
	async createSession(
		sessionName: string,
		cwd: string,
		options?: {
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			cols?: number;
			rows?: number;
		}
	): Promise<ISession> {
		this.logger.info('Creating session', { sessionName, cwd });
		SessionCommandHelper.resetSessionInput(sessionName);

		// Default to shell if no command specified
		const command = options?.command || process.env.SHELL || '/bin/bash';

		const session = await this.backend.createSession(sessionName, {
			cwd,
			command,
			args: options?.args,
			env: options?.env,
			cols: options?.cols,
			rows: options?.rows,
		});

		this.logger.info('Session created', { sessionName, pid: session.pid });
		return session;
	}

	/**
	 * Set an environment variable in a session by typing an `export` command.
	 *
	 * Only for non-secret values: the shell echoes the typed line, so the value
	 * ends up in scrollback, the persistent session log and the terminal-output
	 * API. Secrets (API keys, tokens, passwords) belong in the spawn environment
	 * (`createSession(..., { env })`) and are refused here.
	 * Note: This only affects new commands run in the session.
	 *
	 * @param sessionName - Session to type into
	 * @param key - Variable name
	 * @param value - Variable value (not secret)
	 * @throws Error when `key` names a secret (see utils/secret-env) or the session does not exist
	 */
	async setEnvironmentVariable(
		sessionName: string,
		key: string,
		value: string
	): Promise<void> {
		assertNotSecretEnvKey(key);
		const session = this.getSessionOrThrow(sessionName);

		// Export the variable — space-prefixed so the line stays out of shell history
		session.write(`${quietShellLine(`export ${key}="${value}"`)}\r`);
		this.logger.debug('Set environment variable', { sessionName, key });
		await delay(SESSION_COMMAND_DELAYS.ENV_VAR_DELAY);
	}

	/**
	 * Resize a session's terminal
	 */
	resizeSession(sessionName: string, cols: number, rows: number): void {
		const session = this.getSessionOrThrow(sessionName);
		session.resize(cols, rows);
		this.logger.debug('Session resized', { sessionName, cols, rows });
	}

	/**
	 * Get the underlying backend
	 */
	getBackend(): ISessionBackend {
		return this.backend;
	}

	/**
	 * Subscribe to session output events.
	 *
	 * This method provides direct access to the terminal output stream,
	 * enabling event-driven processing instead of polling.
	 *
	 * @param sessionName - The session to subscribe to
	 * @param callback - Function called on each data event
	 * @returns Unsubscribe function to stop receiving events
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = helper.subscribeToOutput('my-session', (data) => {
	 *   console.log('Received:', data);
	 * });
	 * // Later: unsubscribe();
	 * ```
	 */
	subscribeToOutput(sessionName: string, callback: (data: string) => void): () => void {
		const session = this.getSessionOrThrow(sessionName);
		this.logger.debug('Subscribing to session output', { sessionName });
		return session.onData(callback);
	}

	/**
	 * Subscribe to session exit events.
	 *
	 * @param sessionName - The session to subscribe to
	 * @param callback - Function called when session exits with exit code
	 * @returns Unsubscribe function to stop receiving events
	 * @throws Error if session does not exist
	 *
	 * @example
	 * ```typescript
	 * const unsubscribe = helper.subscribeToExit('my-session', (code) => {
	 *   console.log('Session exited with code:', code);
	 * });
	 * ```
	 */
	subscribeToExit(sessionName: string, callback: (code: number) => void): () => void {
		const session = this.getSessionOrThrow(sessionName);
		this.logger.debug('Subscribing to session exit', { sessionName });
		return session.onExit(callback);
	}

	/**
	 * Wait for a pattern to appear in session output.
	 *
	 * Subscribes to the output stream and resolves when the pattern is found.
	 * Useful for waiting for specific prompts or indicators.
	 *
	 * @param sessionName - The session to monitor
	 * @param pattern - RegExp or string to match against output
	 * @param timeoutMs - Maximum time to wait (default: 30 seconds)
	 * @returns Promise resolving to the accumulated buffer when pattern matches
	 * @throws Error if timeout or session does not exist
	 *
	 * @example
	 * ```typescript
	 * // Wait for Claude prompt
	 * const output = await helper.waitForPattern('agent-1', />\s*$/, 10000);
	 * console.log('Claude is ready:', output);
	 * ```
	 */
	async waitForPattern(
		sessionName: string,
		pattern: RegExp | string,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.DEFAULT_PATTERN_TIMEOUT
	): Promise<string> {
		const session = this.getSessionOrThrow(sessionName);

		return new Promise<string>((resolve, reject) => {
			let buffer = '';
			let resolved = false;

			const cleanup = () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					unsubscribe();
				}
			};

			const timeoutId = setTimeout(() => {
				cleanup();
				this.logger.debug('waitForPattern timed out', {
					sessionName,
					pattern: pattern.toString(),
					bufferLength: buffer.length,
				});
				reject(new Error(`Timeout waiting for pattern: ${pattern}`));
			}, timeoutMs);

			const unsubscribe = session.onData((data) => {
				if (resolved) return;

				buffer += data;

				const match =
					typeof pattern === 'string' ? buffer.includes(pattern) : pattern.test(buffer);

				if (match) {
					this.logger.debug('Pattern matched in output', {
						sessionName,
						pattern: pattern.toString(),
						bufferLength: buffer.length,
					});
					cleanup();
					resolve(buffer);
				}
			});
		});
	}

	/**
	 * Wait for any of multiple patterns to appear in session output.
	 *
	 * Useful when multiple outcomes are possible (e.g., success or error).
	 *
	 * @param sessionName - The session to monitor
	 * @param patterns - Array of patterns with identifiers
	 * @param timeoutMs - Maximum time to wait
	 * @returns Promise resolving to which pattern matched and the buffer
	 *
	 * @example
	 * ```typescript
	 * const result = await helper.waitForAnyPattern('agent-1', [
	 *   { id: 'prompt', pattern: />\s*$/ },
	 *   { id: 'error', pattern: /error:/i },
	 * ], 10000);
	 *
	 * if (result.matchedId === 'error') {
	 *   console.log('Error occurred:', result.buffer);
	 * }
	 * ```
	 */
	async waitForAnyPattern(
		sessionName: string,
		patterns: Array<{ id: string; pattern: RegExp | string }>,
		timeoutMs: number = EVENT_DELIVERY_CONSTANTS.DEFAULT_PATTERN_TIMEOUT
	): Promise<{ matchedId: string; buffer: string }> {
		const session = this.getSessionOrThrow(sessionName);

		return new Promise((resolve, reject) => {
			let buffer = '';
			let resolved = false;

			const cleanup = () => {
				if (!resolved) {
					resolved = true;
					clearTimeout(timeoutId);
					unsubscribe();
				}
			};

			const timeoutId = setTimeout(() => {
				cleanup();
				this.logger.debug('waitForAnyPattern timed out', {
					sessionName,
					patternCount: patterns.length,
					bufferLength: buffer.length,
				});
				reject(new Error(`Timeout waiting for any pattern`));
			}, timeoutMs);

			const unsubscribe = session.onData((data) => {
				if (resolved) return;

				buffer += data;

				for (const { id, pattern } of patterns) {
					const match =
						typeof pattern === 'string' ? buffer.includes(pattern) : pattern.test(buffer);

					if (match) {
						this.logger.debug('Pattern matched in waitForAnyPattern', {
							sessionName,
							matchedId: id,
							pattern: pattern.toString(),
						});
						cleanup();
						resolve({ matchedId: id, buffer });
						return;
					}
				}
			});
		});
	}

	/**
	 * Write raw data to session without Enter key.
	 *
	 * Useful for sending partial input or special key sequences.
	 *
	 * @param sessionName - The session to write to
	 * @param data - Data to write
	 * @throws Error if session does not exist
	 */
	writeRaw(sessionName: string, data: string): void {
		const session = this.getSessionOrThrow(sessionName);
		session.write(data);
		this.logger.debug('Wrote raw data to session', {
			sessionName,
			dataLength: data.length,
		});
	}

}

/**
 * Create a SessionCommandHelper instance
 */
export function createSessionCommandHelper(backend: ISessionBackend): SessionCommandHelper {
	return new SessionCommandHelper(backend);
}
