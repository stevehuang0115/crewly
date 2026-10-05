/**
 * Child process of the release input-guard check
 * (specs/2026-10-04-release-input-guard-check.md).
 *
 * The running backend pipes the live input views of its agent sessions
 * (real terminal buffers, faint text already blanked) to this script on
 * stdin; this script — loaded from the NEW build, in a fresh process so the
 * new classifier and constants are what run — classifies each one and
 * prints the verdicts as JSON on stdout. It only calls the classifier.
 *
 * @module backend/scripts/input-guard-classify
 */

import { INPUT_GUARD_CHECK_CONSTANTS, RUNTIME_INPUT_READY_PATTERNS } from '../constants.js';
import { classifyWithOwnPastes, screenShowsTurnInProgress, type TuiInputView } from '../services/session/tui-input-guard.js';
import { KNOWN_INPUT_SCREENS, type KnownInputScreen } from '../services/session/input-guard-known-screens.js';

/** The message used as the probe: it is never in a box, so only empty / ours-by-marker pass. */
export const PROBE_MESSAGE = '__probe__';

/** One agent's live view, as the backend sends it. */
export interface InputGuardViewInput {
	session: string;
	runtime: string;
	/** Null when the backend has no styled capture for the session */
	view: TuiInputView | null;
	/**
	 * The harness's pastes into this session since the last outside input
	 * (input ledger), oldest first: a box holding only those is the
	 * harness's own (crewly#1028). Absent from older backends.
	 */
	ownPastes?: string[];
	/** Exact markers the box showed for those pastes */
	shownMarkers?: Array<{ marker: string; message: string }>;
}

/** Verdict for one agent. */
export type InputGuardVerdict = 'ok' | 'warn' | 'fail' | 'skip';

/** The new build's reading of one agent. */
export interface InputGuardClassification {
	session: string;
	runtime: string;
	state: 'empty' | 'ours' | 'foreign' | 'unknown';
	layout?: string;
	/** No spinner / busy bar on screen */
	idle: boolean;
	verdict: InputGuardVerdict;
	/** Short English reason */
	reason: string;
	/** `fixture` for a known recorded screen (session is `fixture:<name>`); absent for a live agent */
	kind?: 'fixture';
}

/**
 * First marker (lower-case) found in the bottom rows of a screen.
 *
 * @param lines - Screen rows
 * @param markers - Lower-case markers
 * @returns The marker found, or null
 */
function findInTail(lines: readonly string[], markers: readonly string[]): string | null {
	const tail = lines.filter((l) => l.trim() !== '').slice(-INPUT_GUARD_CHECK_CONSTANTS.TAIL_LINES).join('\n').toLowerCase().replace(/\s+/g, ' ');
	return markers.find((m) => tail.includes(m)) ?? null;
}

/** Every runtime's "not ready" marker (booting, sign-in, approval dialogs). */
const NOT_READY_MARKERS: readonly string[] = Object.values(RUNTIME_INPUT_READY_PATTERNS)
	.flatMap((v) => (v && typeof v === 'object' && 'NOT_READY_MARKERS' in v ? (v as { NOT_READY_MARKERS: readonly string[] }).NOT_READY_MARKERS : []));

/**
 * Why a screen with no input box is not a failure, or null when it is one:
 * a failure needs a known READY footer on screen. Dialogs, login screens,
 * startup banners and a bare shell prompt are reported, not blocked on.
 *
 * @param lines - Screen rows
 * @returns A warn reason, or null for a real failure
 */
function explainMissingBox(lines: readonly string[]): string | null {
	const notReady = findInTail(lines, NOT_READY_MARKERS);
	if (notReady) return `no input box: runtime not ready ("${notReady}": sign-in, trust or approval screen)`;
	if (findInTail(lines, INPUT_GUARD_CHECK_CONSTANTS.READY_MARKERS)) return null;
	const dialog = findInTail(lines, INPUT_GUARD_CHECK_CONSTANTS.DIALOG_MARKERS);
	if (dialog) return `no input box: dialog, login or picker screen ("${dialog}")`;
	return 'no input box and no ready footer (startup screen, shell prompt or unknown screen)';
}

/**
 * Classify live views with this build's guard.
 *
 * @param inputs - One view per agent session
 * @returns One classification per input, in order
 */
export function classifyViews(inputs: readonly InputGuardViewInput[]): InputGuardClassification[] {
	return inputs.map((input): InputGuardClassification => {
		const { session, runtime, view, ownPastes, shownMarkers } = input;
		if (!view) {
			return { session, runtime, state: 'unknown', idle: true, verdict: 'skip', reason: 'no styled capture for this session (not checked)' };
		}
		const screen = (view.lines ?? []).join('\n');
		if (screen.trim() === '') {
			return { session, runtime, state: 'unknown', idle: true, verdict: 'skip', reason: 'blank screen (session still starting?)' };
		}
		const idle = !screenShowsTurnInProgress(screen);
		const reading = classifyWithOwnPastes(view, PROBE_MESSAGE, 'before-write', ownPastes ?? [], shownMarkers ?? []);
		const base = { session, runtime, state: reading.state, layout: reading.layout, idle };
		switch (reading.state) {
			case 'empty':
				return { ...base, verdict: 'ok', reason: `empty ${reading.layout} input box` };
			case 'ours':
				return {
					...base,
					verdict: 'ok',
					reason: reading.ownPasteMarker && (reading.ownPasteMessages?.length ?? 0) > 0
						? `${reading.layout} box holds the harness's own paste (${reading.ownPasteMessages?.length} message${reading.ownPasteMessages?.length === 1 ? '' : 's'}); the guard submits it once the agent is idle`
						: `${reading.layout} box holds the harness's own paste`,
				};
			case 'foreign':
				return {
					...base,
					verdict: idle ? 'warn' : 'ok',
					reason: idle
						? `${reading.layout} box holds text (${reading.text.length} chars) while idle`
						: `${reading.layout} box holds text while mid-turn`,
				};
			default: {
				if (!idle) return { ...base, verdict: 'warn', reason: 'mid-turn and no input box of a known layout was found' };
				const why = explainMissingBox(view.lines);
				if (why) return { ...base, verdict: 'warn', reason: why };
				return { ...base, verdict: 'fail', reason: 'idle with the runtime\'s ready footer on screen, but no input box of a known layout was found' };
			}
		}
	});
}

/**
 * Classify the known recorded screens (crewly#1028 and the labelled-rule
 * frames) with this build's guard. A screen read differently from its
 * expectation is a `fail`: the build would misread a box it has met in
 * production.
 *
 * @param screens - The screens (default: all known ones)
 * @returns One row per screen, session `fixture:<name>`
 */
export function checkKnownScreens(screens: readonly KnownInputScreen[] = KNOWN_INPUT_SCREENS): InputGuardClassification[] {
	return screens.map((screen): InputGuardClassification => {
		const reading = classifyWithOwnPastes(screen.view, screen.message, screen.stage, screen.pastes);
		const idle = !screenShowsTurnInProgress(screen.view.lines.join('\n'));
		const ok = reading.state === screen.expect;
		return {
			session: `fixture:${screen.name}`,
			runtime: screen.runtime,
			state: reading.state,
			layout: reading.layout,
			idle,
			kind: 'fixture',
			verdict: ok ? 'ok' : 'fail',
			reason: ok ? screen.why : `read as ${reading.state}, expected ${screen.expect}: ${screen.why}`,
		};
	});
}

/**
 * Read all of stdin as text.
 *
 * @returns The text
 */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString('utf8');
}

/** stdin `{ sessions: InputGuardViewInput[] }` → stdout `{ results: InputGuardClassification[] }`. */
async function main(): Promise<void> {
	const parsed = JSON.parse(await readStdin()) as { sessions?: InputGuardViewInput[] };
	process.stdout.write(JSON.stringify({ results: [...classifyViews(parsed.sessions ?? []), ...checkKnownScreens()] }));
}

// Run only when started as a script (also true for the compiled .js).
if (/input-guard-classify\.(js|ts)$/.test(process.argv[1] ?? '')) {
	main().catch((error) => {
		process.stderr.write(`input-guard-classify failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	});
}
