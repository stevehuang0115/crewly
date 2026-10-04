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

import { classifyTuiInput, screenShowsTurnInProgress, type TuiInputView } from '../services/session/tui-input-guard.js';

/** The message used as the probe: it is never in a box, so only empty / ours-by-marker pass. */
export const PROBE_MESSAGE = '__probe__';

/** One agent's live view, as the backend sends it. */
export interface InputGuardViewInput {
	session: string;
	runtime: string;
	view: TuiInputView;
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
}

/**
 * Classify live views with this build's guard.
 *
 * @param inputs - One view per agent session
 * @returns One classification per input, in order
 */
export function classifyViews(inputs: readonly InputGuardViewInput[]): InputGuardClassification[] {
	return inputs.map((input): InputGuardClassification => {
		const { session, runtime, view } = input;
		const screen = (view?.lines ?? []).join('\n');
		if (screen.trim() === '') {
			return { session, runtime, state: 'unknown', idle: true, verdict: 'skip', reason: 'blank screen (session still starting?)' };
		}
		const idle = !screenShowsTurnInProgress(screen);
		const reading = classifyTuiInput(view, PROBE_MESSAGE, 'before-write');
		const base = { session, runtime, state: reading.state, layout: reading.layout, idle };
		switch (reading.state) {
			case 'empty':
				return { ...base, verdict: 'ok', reason: `empty ${reading.layout} input box` };
			case 'ours':
				return { ...base, verdict: 'ok', reason: `${reading.layout} box holds the harness's own paste` };
			case 'foreign':
				return {
					...base,
					verdict: idle ? 'warn' : 'ok',
					reason: idle
						? `${reading.layout} box holds text (${reading.text.length} chars) while idle`
						: `${reading.layout} box holds text while mid-turn`,
				};
			default:
				return {
					...base,
					verdict: idle ? 'fail' : 'warn',
					reason: idle
						? 'idle, but no input box of a known layout was found'
						: 'mid-turn and no input box of a known layout was found',
				};
		}
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
	process.stdout.write(JSON.stringify({ results: classifyViews(parsed.sessions ?? []) }));
}

// Run only when started as a script (also true for the compiled .js).
if (/input-guard-classify\.(js|ts)$/.test(process.argv[1] ?? '')) {
	main().catch((error) => {
		process.stderr.write(`input-guard-classify failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(2);
	});
}
