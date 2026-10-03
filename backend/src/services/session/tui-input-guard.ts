/**
 * TUI input guard — reads what is really in an agent runtime's input box.
 *
 * Why this exists (2026-10-03 incident): Claude Code paints a faint
 * "prompt suggestion" in an empty input box — a prediction of the user's
 * next message, such as "按这个草稿回吧" ("go ahead with this draft").
 * Tab accepts it. Crewly pressed Tab before every Claude Code delivery and
 * Tab+Enter in its stuck-message recovery, so a predicted message was
 * submitted as if the owner had typed it, and the agent posted on LinkedIn
 * as the owner.
 *
 * The rule enforced with this module: the harness types into an agent's
 * input only when the box is empty (after clearing it), and presses Enter
 * only when the box holds exactly the text the harness wrote.
 *
 * The box is found per runtime layout, from real captures
 * (`__fixtures__/tui/`, recorded from Claude Code 2.1.288 and Codex 0.160
 * in a PTY through headless xterm):
 *
 * - Claude Code: the box sits between two `────` rules; its first line is
 *   `❯` + U+00A0 + text, continuation lines are indented. The transcript
 *   echoes past prompts as `❯ text` too, so only the ruled box counts.
 * - Antigravity: the same ruled box with a `>` prompt.
 * - Codex: the composer starts at the bottom-most `›` line at column 0 and
 *   runs to the terminal cursor (Codex keeps it at the end of the text);
 *   blank lines inside a multi-line message belong to it.
 * - Gemini CLI 0.40.1: the box sits between a `▄▄▄` and a `▀▀▀` line; its
 *   first line is ` > text` (or `*`/`!`), continuation lines indented; the
 *   empty box shows `Type your message or @path/to/file` in solid grey.
 * - Older Gemini (not verified live): a `╭──╮ │ > text │ ╰──╯` box.
 *
 * Ghost text is read as absent: the screen is captured with faint cells
 * blanked (`captureInputView`). When no known layout is on screen the
 * reading is `unknown` — the caller falls back to the old path (no Tab, one
 * Enter after its own paste, never a blind or backup Enter).
 *
 * @module services/session/tui-input-guard
 */

import { TUI_INPUT_GUARD } from '../../constants.js';

/**
 * What the input box holds, relative to a message the harness wants to send.
 *
 * - `empty`: an input box was found and holds nothing.
 * - `ours`: it holds the message (or the runtime's collapsed
 *   "[Pasted text …]" marker for it), and nothing else.
 * - `foreign`: it holds text the harness did not write (alone or mixed
 *   with the message).
 * - `unknown`: no input box of a known layout is on screen.
 */
export type TuiInputState = 'empty' | 'ours' | 'foreign' | 'unknown';

/** Which runtime layout the box was read from. */
export type TuiInputLayout = 'claude-code' | 'antigravity' | 'codex' | 'gemini' | 'gemini-legacy';

/**
 * Result of reading an input box.
 */
export interface TuiInputReading {
	/** Classification of the input box contents */
	state: TuiInputState;
	/** The input box text as read (lines joined with '\n'), '' when none */
	text: string;
	/** Layout the box was found in (absent for `unknown`) */
	layout?: TuiInputLayout;
	/** How many screen lines the box text spans (0 for an empty box) */
	lineCount: number;
	/**
	 * Whether the layout was verified against live captures (Claude Code,
	 * Codex). Gemini and Antigravity were not; callers treat their readings
	 * conservatively.
	 */
	verified?: boolean;
	/**
	 * The box holds the collapsed marker of the harness's own earlier paste
	 * (whatever message it was): a delivery whose Enter was lost.
	 */
	ownPasteMarker?: boolean;
}

/** A captured screen: rows (faint text blanked) and the cursor row. */
export interface TuiInputView {
	lines: string[];
	/** Row of the terminal cursor in `lines`, -1 when unknown */
	cursorRow: number;
}

/**
 * Why the box is being read: before typing, right after our own paste into
 * a box proven empty, or later by recovery (the box was not watched since).
 */
export type TuiInputStage = 'before-write' | 'after-paste' | 'recovery';

/** A box found on screen: its layout and text lines. */
interface FoundBox {
	layout: TuiInputLayout;
	lines: string[];
}

/**
 * Normalise a screen line: U+00A0 (Claude Code's prompt separator) and other
 * non-breaking spaces become plain spaces.
 *
 * @param line - Raw line
 * @returns Line with plain spaces
 */
function normalizeLine(line: string): string {
	return line.replace(/[\u00a0\u2007\u202f]/g, ' ');
}

/**
 * Whether a line is a horizontal rule (Claude Code / Antigravity box edge).
 *
 * @param line - Normalised line
 * @returns True for a rule of at least RULE_MIN_CHARS `─`
 */
function isRule(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length >= TUI_INPUT_GUARD.RULE_MIN_CHARS && /^─+$/.test(trimmed);
}

/**
 * Drop one level of continuation indent (two spaces) from box lines after
 * the first.
 *
 * @param line - Continuation line
 * @returns Line without its indent
 */
function dedent(line: string): string {
	return line.startsWith('  ') ? line.slice(2) : line.trimStart();
}

/**
 * Claude Code / Antigravity: the bottom-most pair of rules near the bottom
 * of the screen with a prompt line right under the top rule.
 *
 * @param lines - Normalised screen lines (trailing blank rows dropped)
 * @returns The box, or null
 */
function findRuledBox(lines: string[]): FoundBox | null {
	const lowest = Math.max(0, lines.length - TUI_INPUT_GUARD.FOOTER_MAX_LINES - 1);
	let bottom = -1;
	for (let i = lines.length - 1; i >= lowest; i--) {
		if (isRule(lines[i])) {
			bottom = i;
			break;
		}
	}
	if (bottom < 1) return null;
	let top = -1;
	for (let i = bottom - 1; i >= Math.max(0, bottom - TUI_INPUT_GUARD.MAX_BOX_LINES - 1); i--) {
		if (isRule(lines[i])) {
			top = i;
			break;
		}
	}
	if (top < 0 || bottom - top < 2) return null;
	const first = lines[top + 1];
	const m = /^([❯>])(?: (.*))?$/.exec(first.trimEnd());
	if (!m) return null;
	const layout: TuiInputLayout = m[1] === '❯' ? 'claude-code' : 'antigravity';
	const body = [m[2] ?? '', ...lines.slice(top + 2, bottom).map(dedent)];
	return { layout, lines: body };
}

/**
 * Gemini CLI: `╭…╮` / `│ > text │` / `╰…╯`, bottom-most.
 *
 * @param lines - Normalised screen lines
 * @returns The box, or null
 */
function findGeminiBox(lines: string[]): FoundBox | null {
	let bottom = -1;
	for (let i = lines.length - 1; i >= Math.max(0, lines.length - TUI_INPUT_GUARD.FOOTER_MAX_LINES - 1); i--) {
		if (/^\s*╰─+╯\s*$/.test(lines[i])) {
			bottom = i;
			break;
		}
	}
	if (bottom < 1) return null;
	let top = -1;
	for (let i = bottom - 1; i >= Math.max(0, bottom - TUI_INPUT_GUARD.MAX_BOX_LINES - 1); i--) {
		if (/^\s*╭─+╮\s*$/.test(lines[i])) {
			top = i;
			break;
		}
	}
	if (top < 0 || bottom - top < 2) return null;
	const inner = lines.slice(top + 1, bottom).map((l) => {
		const m = /^\s*│(.*)│\s*$/.exec(l);
		return m ? m[1] : null;
	});
	if (inner.some((l) => l === null)) return null;
	const first = /^\s*[>!*] ?(.*)$/.exec((inner[0] as string).trimEnd());
	if (!first) return null;
	const rest = (inner.slice(1) as string[]).map((l) => l.trim());
	return { layout: 'gemini-legacy', lines: [first[1].trim(), ...rest] };
}

/**
 * Gemini CLI 0.40.1: `▄▄▄…` / ` > text` / `   more` / `▀▀▀…`, bottom-most.
 *
 * @param lines - Normalised screen lines
 * @returns The box, or null
 */
function findGeminiHalfBlockBox(lines: string[]): FoundBox | null {
	let bottom = -1;
	for (let i = lines.length - 1; i >= Math.max(0, lines.length - TUI_INPUT_GUARD.FOOTER_MAX_LINES - 1); i--) {
		if (/^▀{10,}$/.test(lines[i].trim())) {
			bottom = i;
			break;
		}
	}
	if (bottom < 1) return null;
	let top = -1;
	for (let i = bottom - 1; i >= Math.max(0, bottom - TUI_INPUT_GUARD.MAX_BOX_LINES - 1); i--) {
		if (/^▄{10,}$/.test(lines[i].trim())) {
			top = i;
			break;
		}
	}
	if (top < 0 || bottom - top < 2) return null;
	const first = /^ ?[>*!](?: +(.*))?$/.exec(lines[top + 1].trimEnd());
	if (!first) return null;
	const rest = lines.slice(top + 2, bottom).map((l) => l.replace(/^ {3}/, '').trimEnd());
	return { layout: 'gemini', lines: [(first[1] ?? '').trim(), ...rest] };
}

/**
 * Codex: the bottom-most `›` line at column 0 down to the cursor row.
 * Without a cursor inside that block the box is not trusted.
 *
 * @param lines - Normalised screen lines (all rows)
 * @param cursorRow - Cursor row, -1 when unknown
 * @returns The box, or null
 */
function findCodexComposer(lines: string[], cursorRow: number): FoundBox | null {
	let start = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (/^›(?: |$)/.test(lines[i])) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	if (cursorRow < start || cursorRow - start > TUI_INPUT_GUARD.MAX_BOX_LINES) return null;
	const body = [lines[start].replace(/^› ?/, ''), ...lines.slice(start + 1, cursorRow + 1).map(dedent)];
	return { layout: 'codex', lines: body };
}

/**
 * Find the input box on a screen.
 *
 * @param view - Screen rows (faint blanked) and cursor row
 * @returns The box, or null when no known layout is visible
 */
export function findTuiInputBox(view: TuiInputView): FoundBox | null {
	const all = view.lines.map(normalizeLine);
	let end = all.length;
	while (end > 0 && all[end - 1].trim() === '') end--;
	const lines = all.slice(0, end);
	return findRuledBox(lines) ?? findGeminiHalfBlockBox(lines) ?? findGeminiBox(lines) ?? findCodexComposer(all, view.cursorRow);
}

/**
 * Remove every whitespace character, so terminal wrapping (which can split
 * a word across lines) and indentation do not affect comparison.
 *
 * @param text - Text
 * @returns Text without whitespace
 */
function squash(text: string): string {
	return normalizeLine(text).replace(/\s+/g, '');
}

/**
 * Whether input-box text is a runtime's collapsed marker for a paste
 * (Claude Code "[Pasted text #1 +4 lines]" / "[Pasted text #2]", Codex
 * "[Pasted Content 1234 chars]"). Ghost suggestions are natural language
 * and never take this form.
 *
 * @param text - Input box text
 * @returns True for a lone paste marker
 */
export function isPasteMarker(text: string): boolean {
	return TUI_INPUT_GUARD.PASTE_MARKER_PATTERN.test(text.trim());
}

/**
 * Classify what an input box holds relative to the message the harness
 * wants to send (or has just pasted).
 *
 * `ours` requires that nothing else is in the box:
 * - the whole message (whitespace-insensitive), at any stage, or
 * - only right after our own paste into a box proven empty: a visible part
 *   of it (a long message scrolls inside the box) or a lone paste marker.
 *   During recovery a marker or a fragment is not proof — someone else may
 *   have pasted or typed it.
 *
 * @param view - Screen rows (faint blanked) and cursor row
 * @param message - The message the harness wrote (or will write)
 * @param stage - Why the box is read
 * @param ownMarker - The exact "[Pasted text …]" marker seen right after the
 *   harness's own last paste (of any message), when one was recorded
 * @returns The reading
 */
export function classifyTuiInput(
	view: TuiInputView,
	message: string,
	stage: TuiInputStage = 'after-paste',
	ownMarker?: string,
): TuiInputReading {
	const box = findTuiInputBox(view);
	if (!box) return { state: 'unknown', text: '', lineCount: 0 };
	const lines = [...box.lines];
	while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
	const text = lines.join('\n');
	const verified = TUI_INPUT_GUARD.VERIFIED_LAYOUTS.includes(box.layout);
	const base = { layout: box.layout, lineCount: lines.length, verified };
	const placeholder = TUI_INPUT_GUARD.SOLID_PLACEHOLDERS.some((p) => text.trim().toLowerCase() === p)
		|| (!verified && TUI_INPUT_GUARD.UNVERIFIED_PLACEHOLDERS.some((p) => text.trim().toLowerCase().startsWith(p)));
	if (text.trim() === '' || placeholder) return { state: 'empty', text: '', ...base, lineCount: 0 };

	const boxSquashed = squash(text);
	const messageSquashed = squash(message);
	// The collapsed marker the runtime showed right after the harness's own
	// paste (recorded by the caller) proves the box is ours later too, for
	// whatever message is sent next: a lost Enter must stay recoverable.
	if (ownMarker && text.trim() === ownMarker.trim()) {
		return { state: 'ours', text, ...base, ownPasteMarker: true };
	}
	const exact = messageSquashed.length > 0 && boxSquashed === messageSquashed;
	// Before typing, only an exact copy of this very message is ours (an
	// earlier attempt's paste); anything else is someone else's.
	if (stage === 'before-write') return { state: exact ? 'ours' : 'foreign', text, ...base };
	if (exact) return { state: 'ours', text, ...base };
	// A lone paste marker or a visible part of the message is only provably
	// ours right after our own paste into a box we proved empty.
	if (stage === 'after-paste') {
		if (isPasteMarker(text)) return { state: 'ours', text, ...base };
		if (messageSquashed.length > 0 && boxSquashed.length > 0 && messageSquashed.includes(boxSquashed)) {
			return { state: 'ours', text, ...base };
		}
	}
	return { state: 'foreign', text, ...base };
}

/**
 * Error raised when the harness refuses to type into, or submit, an input
 * box because it holds text the harness did not write.
 */
export class TuiInputGuardError extends Error {
	/** What the input box held when the harness refused */
	readonly reading: TuiInputReading;
	/** Which step refused: before typing, or before pressing Enter */
	readonly stage: 'before-write' | 'before-submit';

	/**
	 * @param stage - The step that refused
	 * @param reading - What the box held
	 */
	constructor(stage: 'before-write' | 'before-submit', reading: TuiInputReading) {
		super(
			stage === 'before-write'
				? `Input box is unreadable or holds text the harness did not write (${reading.state}); refusing to type into it`
				: `Input box does not hold exactly the harness's text (${reading.state}); refusing to press Enter`
		);
		this.name = 'TuiInputGuardError';
		this.stage = stage;
		this.reading = reading;
	}
}
