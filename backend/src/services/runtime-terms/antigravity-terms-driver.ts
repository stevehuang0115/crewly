/**
 * Drive Antigravity CLI's first-run screens to the owner's choice,
 * deterministically, in a terminal the harness controls.
 *
 * One key at a time; before every key the screen is read and parsed
 * ({@link parseAntigravityTermsScreen}) and the next key is chosen from what
 * is on screen — never from a fixed key count:
 *
 * - colour scheme: bring the focus to `terminal`, Enter; leave "Import
 *   extensions from Gemini CLI" unchecked; Enter on Next only when the
 *   screen shows `* terminal` and the import box unchecked;
 * - Terms: toggle the data-sharing box only when it differs from the
 *   owner's choice, re-read to verify, then go to Done and press Enter —
 *   only when the box (read again, right then) matches the choice;
 * - then wait for the main prompt.
 *
 * Anything that does not match (an unknown screen for too long, an account
 * sign-in, no focus, too many keys) aborts: Done is never pressed after a
 * mismatch. specs/2026-10-01-runtime-terms-consent.md
 *
 * @module services/runtime-terms/antigravity-terms-driver
 */

import { RUNTIME_TERMS_CONSTANTS } from '../../constants.js';
import { parseAntigravityTermsScreen, type AntigravityTermsScreen } from './antigravity-terms-screens.js';

const A = RUNTIME_TERMS_CONSTANTS.ANTIGRAVITY;
const D = RUNTIME_TERMS_CONSTANTS.DRIVE;

/** A terminal the driver can type into and read (a PTY session; the fake TUI in tests). */
export interface TermsTerminal {
	/** Write raw bytes (key escape sequences) */
	write(data: string): void | Promise<void>;
	/** Current screen text */
	capture(): string | Promise<string>;
}

/** Keys the driver sends. */
export type DriverKey = 'Up' | 'Down' | 'Left' | 'Right' | 'Enter';

/** Their bytes (the same as the session helper's KEY_CODES). */
export const DRIVER_KEY_BYTES: Readonly<Record<DriverKey, string>> = {
	Up: '\x1b[A',
	Down: '\x1b[B',
	Right: '\x1b[C',
	Left: '\x1b[D',
	Enter: '\r',
};

/** Outcome of a drive. */
export interface TermsDriveResult {
	ok: boolean;
	/** Done was pressed (the terms were accepted on screen) */
	donePressed: boolean;
	/** The runtime opened straight to its prompt: terms were already accepted */
	alreadyAccepted: boolean;
	/** Data-sharing box state when Done was pressed */
	dataSharing?: boolean;
	/** Why it stopped (English), when not ok */
	error?: string;
	/** Keys sent, in order */
	keys: DriverKey[];
	/** Last screen text */
	screen: string;
}

/** Options. */
export interface TermsDriveOptions {
	/** Leave the data-sharing box checked */
	shareData: boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	pollMs?: number;
	keySettleMs?: number;
	launchTimeoutMs?: number;
	unknownScreenTimeoutMs?: number;
	promptTimeoutMs?: number;
	maxKeys?: number;
}

/** What the next step is. */
type Step = { key: DriverKey } | { wait: true } | { done: true } | { abort: string };

/**
 * Decide the next step for a parsed screen.
 *
 * @param s - Parsed screen
 * @param shareData - Owner's choice for the data-sharing box
 * @param donePressed - Done was already pressed
 * @returns Next step
 */
export function nextTermsStep(s: AntigravityTermsScreen, shareData: boolean, donePressed: boolean): Step {
	switch (s.kind) {
		case 'login':
			return { abort: 'Antigravity CLI asked for a Google account sign-in (Crewly only runs it on a Gemini API key)' };
		case 'trust':
			// The folder-trust screen: its pre-selected "Yes, I trust this folder" (the harness's scratch folder).
			return { key: 'Enter' };
		case 'main_prompt':
			return { done: true };
		case 'unknown':
			return { wait: true };
		case 'color_scheme': {
			if (donePressed) return { abort: 'The setup screens came back after Done was pressed' };
			const f = s.focus;
			if (!f) return { wait: true };
			if (f.type === 'scheme') {
				if (f.name === A.DEFAULT_COLOR_SCHEME) return { key: 'Enter' };
				// Move toward `terminal` (the first scheme).
				return { key: 'Up' };
			}
			if (f.type === 'import') {
				if (f.checked) return { key: 'Enter' };
				if (s.chosenScheme !== A.DEFAULT_COLOR_SCHEME) return { key: 'Up' };
				return { key: 'Down' };
			}
			// Next
			if (s.chosenScheme === A.DEFAULT_COLOR_SCHEME && s.importChecked !== true) return { key: 'Enter' };
			return { key: 'Up' };
		}
		case 'terms': {
			if (donePressed) return { wait: true };
			if (s.dataChecked === null) return { abort: 'Could not read the data-sharing checkbox on the Terms screen' };
			if (!s.focus) return { wait: true };
			if (s.focus === 'data') return s.dataChecked === shareData ? { key: 'Down' } : { key: 'Enter' };
			if (s.focus === 'previous') return s.dataChecked === shareData ? { key: 'Right' } : { key: 'Up' };
			// Done is focused: press it only when the box matches the choice.
			return s.dataChecked === shareData ? { key: 'Enter' } : { key: 'Left' };
		}
	}
}

/**
 * Drive the first-run screens. Never throws.
 *
 * @param term - Terminal running a freshly launched `agy`
 * @param opts - Owner's choice and timing
 * @returns Result
 */
export async function driveAntigravityTerms(term: TermsTerminal, opts: TermsDriveOptions): Promise<TermsDriveResult> {
	const now = opts.now ?? (() => Date.now());
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pollMs = opts.pollMs ?? D.POLL_MS;
	const keySettleMs = opts.keySettleMs ?? D.KEY_SETTLE_MS;
	const maxKeys = opts.maxKeys ?? D.MAX_KEYS;
	const keys: DriverKey[] = [];
	let screen = '';
	let donePressed = false;
	let dataSharing: boolean | undefined;
	let sawFirstRun = false;
	const started = now();
	let unknownSince: number | null = null;
	let doneAt = 0;

	const read = async (): Promise<string> => {
		try {
			screen = String(await term.capture());
		} catch {
			// keep the last screen
		}
		return screen;
	};
	const result = (ok: boolean, error?: string): TermsDriveResult => ({
		ok,
		donePressed,
		alreadyAccepted: ok && !donePressed && !sawFirstRun,
		...(dataSharing !== undefined ? { dataSharing } : {}),
		...(error ? { error } : {}),
		keys,
		screen,
	});

	try {
		for (;;) {
			const parsed = parseAntigravityTermsScreen(await read());
			if (parsed.kind === 'color_scheme' || parsed.kind === 'terms') sawFirstRun = true;
			const step = nextTermsStep(parsed, opts.shareData, donePressed);
			if ('abort' in step) return result(false, step.abort);
			if ('done' in step) {
				if (sawFirstRun && !donePressed) return result(false, 'The prompt appeared without the Terms screen being completed');
				return result(true);
			}

			if ('wait' in step) {
				const t = now();
				if (donePressed) {
					if (t - doneAt > (opts.promptTimeoutMs ?? D.PROMPT_TIMEOUT_MS)) {
						return result(false, 'Done was pressed, but Antigravity CLI did not show its prompt in time');
					}
				} else if (!sawFirstRun && parsed.kind === 'unknown') {
					if (t - started > (opts.launchTimeoutMs ?? D.LAUNCH_TIMEOUT_MS)) {
						return result(false, 'Antigravity CLI did not show its setup screens or its prompt in time');
					}
				} else {
					unknownSince ??= t;
					if (t - unknownSince > (opts.unknownScreenTimeoutMs ?? D.UNKNOWN_SCREEN_TIMEOUT_MS)) {
						return result(false, 'The screen did not match the expected setup screens');
					}
				}
				await sleep(pollMs);
				continue;
			}
			unknownSince = null;

			if (keys.length >= maxKeys) return result(false, `Gave up after ${maxKeys} keys without reaching the end of the setup screens`);
			const pressingDone = parsed.kind === 'terms' && parsed.focus === 'done' && step.key === 'Enter';
			if (pressingDone) {
				// Last check right before accepting: read again, everything must still match.
				const again = parseAntigravityTermsScreen(await read());
				if (again.kind !== 'terms' || again.focus !== 'done' || again.dataChecked !== opts.shareData) {
					return result(false, 'The Terms screen changed just before Done; nothing was accepted');
				}
				dataSharing = again.dataChecked;
			}
			const before = screen;
			await term.write(DRIVER_KEY_BYTES[step.key]);
			keys.push(step.key);
			if (pressingDone) {
				donePressed = true;
				doneAt = now();
			}
			// Wait for the screen to react before deciding again.
			const settleUntil = now() + keySettleMs;
			while (now() < settleUntil) {
				await sleep(pollMs);
				if ((await read()) !== before) break;
			}
		}
	} catch (err) {
		return result(false, `Driving the setup screens failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
