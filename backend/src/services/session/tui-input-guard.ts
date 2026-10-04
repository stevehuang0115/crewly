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
	/** With `ownPasteMarker`: the harness messages the box holds, in order */
	ownPasteMessages?: string[];
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
 * Whether a line is an input box's horizontal rule (Claude Code /
 * Antigravity box edge), bare (`────`) or labelled: Claude Code prints the
 * agent/session name inside the top rule (`──── crewly-orc ─`) on every
 * live machine. Every rule detector should use this, not `/^─+$/`.
 *
 * @param line - Screen line
 * @param minChars - Fewest `─` that make a rule
 * @returns True for a rule
 */
export function isInputBoxRule(line: string, minChars: number = TUI_INPUT_GUARD.RULE_MIN_CHARS): boolean {
	const trimmed = line.trim();
	const m = /^(─*)(?: ([^─]{1,60}) )?(─*)$/.exec(trimmed);
	if (!m) return false;
	return m[1].length + m[3].length >= minChars;
}

/** {@link isInputBoxRule} at the default length. */
function isRule(line: string): boolean {
	return isInputBoxRule(line);
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
 * Claude Code's spinner line while a turn runs: a spinner glyph, one
 * capitalised word ending in `…`, then optionally the elapsed/tokens part —
 * "✳ Flambéing…", "✻ Ideating… (4m 2s · ↓ 3.1k tokens · esc to interrupt)".
 * Transcript lines (`⏺ Understood…`, `❯ Thanks…`, `⎿  Waiting…`) do not use
 * these glyphs; a finished turn's line has no `…` ("✻ Worked for 17s").
 */
const SPINNER_LINE = /^\s*[·✢✳✶✻✽]\s+\p{Lu}[\p{L}'’-]*…(?:\s+\(.*\))?\s*$/u;

/** What a screen says about a turn in progress, read from its structure. */
export interface TurnScreenSignals {
	/** A Claude Code / Antigravity input box (two rules) was found */
	box: boolean;
	/** "esc to interrupt" in the footer rows below the box (or, without a box, in the bottom rows) */
	busyBar: boolean;
	/** The spinner line directly above the box's top rule, if any */
	spinner: string | null;
}

/**
 * Read a screen's turn-in-progress signals from where the runtime paints
 * them — never from the transcript, which can quote anything (an agent
 * working on Crewly prints "esc to interrupt"; a reply can end "Understood…"):
 * - the busy bar only in the footer rows below the box's bottom rule
 *   (at most FOOTER_MAX_LINES); without a box (Codex), only in the bottom
 *   FOOTER_MAX_LINES non-empty rows;
 * - the spinner only as the single non-empty line directly above the box's
 *   top rule, in Claude Code's spinner shape.
 *
 * @param screen - Plain screen text (bottom of the screen)
 * @returns The signals
 */
export function readTurnSignals(screen: string): TurnScreenSignals {
	const lines = (screen || '').split('\n');
	const rules: number[] = [];
	lines.forEach((l, i) => { if (isInputBoxRule(l)) rules.push(i); });
	const bar = (text: string): boolean => /esc\s+to\s+interrupt/i.test(text);
	if (rules.length < 2) {
		const bottom = lines.filter((l) => l.trim() !== '').slice(-TUI_INPUT_GUARD.FOOTER_MAX_LINES);
		return { box: false, busyBar: bar(bottom.join('\n')), spinner: null };
	}
	const top = rules[rules.length - 2];
	const bottomRule = rules[rules.length - 1];
	const footer = lines.slice(bottomRule + 1, bottomRule + 1 + TUI_INPUT_GUARD.FOOTER_MAX_LINES).join('\n');
	let spinner: string | null = null;
	for (let i = top - 1; i >= 0; i--) {
		if (lines[i].trim() === '') continue;
		if (SPINNER_LINE.test(lines[i])) spinner = lines[i].trim();
		break;
	}
	return { box: true, busyBar: bar(footer), spinner };
}

/**
 * Whether a screen shows a turn in progress (see {@link readTurnSignals}).
 * Structure only: callers that act on "busy" for long also check that the
 * screen is repainting (SessionCommandHelper.isAgentBusy).
 *
 * @param screen - Plain screen text (bottom of the screen)
 * @returns True when the busy bar or the spinner line is in place
 */
export function screenShowsTurnInProgress(screen: string): boolean {
	const s = readTurnSignals(screen);
	return s.busyBar || s.spinner !== null;
}

/**
 * Whether input-box text is how the runtime shows a paste of `message`:
 * the message itself (whitespace-insensitive), or a collapsed marker of its
 * shape — Claude Code "[Pasted text #N +L lines]" where L is the number of
 * line breaks (a single long line shows as "[Pasted text #N]"), Codex
 * "[Pasted Content C chars]" where C is its length. Used to recognise a
 * paste of ours that rendered only after we stopped looking (a busy Claude
 * Code renders a paste seconds late).
 *
 * @param text - The input box text
 * @param message - The message the harness pasted
 * @returns True when the text is what that paste looks like
 */
export function pasteShowsAs(text: string, message: string): boolean {
	const t = text.trim();
	if (t === '' || message.trim() === '') return false;
	if (squash(t) === squash(message)) return true;
	const normalized = message.replace(/\r\n?/g, '\n');
	const breaks = (normalized.match(/\n/g) ?? []).length;
	const claude = /^\[Pasted text #\d+(?: \+(\d+) lines?)?\]$/i.exec(t);
	if (claude) {
		if (claude[1] === undefined) return breaks === 0;
		const shown = Number(claude[1]);
		return shown === breaks || (normalized.endsWith('\n') && shown === breaks - 1);
	}
	const codex = /^\[Pasted Content (\d+) chars?\]$/i.exec(t);
	if (codex) {
		const shown = Number(codex[1]);
		return shown === message.length || shown === [...message].length || shown === normalized.length;
	}
	return false;
}

/**
 * Whether input-box text is made up only of the harness's own pastes:
 * runtime paste markers and/or the pasted texts, possibly several of them
 * run together ("[Pasted text #2 +5 lines][Pasted text #3 +5 lines]" — a
 * second paste landed on a first one that rendered late, 1.20.207 Ella).
 *
 * Each part must be accounted for, in order, by a distinct paste:
 * - a marker that the harness saw for its own paste (`shownMarkers`, exact
 *   text: the runtime's counter makes it unique in the session), or
 * - a marker or text with the shape of one of `pastes` — the harness's
 *   pastes since the last outside input, oldest first. With no outside
 *   input since, nothing else can have put it there.
 *
 * @param text - The input box text
 * @param pastes - Harness paste messages since the last outside input, oldest first
 * @param shownMarkers - Exact markers the box showed for harness pastes
 * @returns The messages the box holds, in order, when every part of it is
 *   one of our pastes; null otherwise
 */
export function boxHoldsOnlyOwnPastes(
	text: string,
	pastes: readonly string[],
	shownMarkers: ReadonlyArray<{ marker: string; message: string }> = [],
): string[] | null {
	const body = text.replace(/\s+/g, ' ').trim();
	if (body === '') return null;
	const used: string[] = [];
	// Split into markers and the text between them.
	const parts: Array<{ marker: boolean; text: string }> = [];
	const re = /\[Pasted (?:text|content)[^\]]*\]/gi;
	let last = 0;
	for (const m of body.matchAll(re)) {
		const before = body.slice(last, m.index).trim();
		if (before) parts.push({ marker: false, text: before });
		parts.push({ marker: true, text: m[0] });
		last = (m.index ?? 0) + m[0].length;
	}
	const tail = body.slice(last).trim();
	if (tail) parts.push({ marker: false, text: tail });

	let next = 0; // the next paste that may account for a part
	for (const part of parts) {
		if (part.marker) {
			const shown = shownMarkers.find((m) => m.marker === part.text);
			if (shown) {
				// That paste is accounted for: it cannot stand for another part.
				const k = pastes.indexOf(shown.message, next);
				if (k >= 0) next = k + 1;
				used.push(shown.message);
				continue;
			}
			let j = next;
			while (j < pastes.length && !pasteShowsAs(part.text, pastes[j])) j++;
			if (j >= pastes.length) return null;
			used.push(pastes[j]);
			next = j + 1;
			continue;
		}
		// Plain text: one or more whole pasted messages, run together.
		let rest = squash(part.text);
		while (rest.length > 0) {
			let j = next;
			while (j < pastes.length && !(squash(pastes[j]).length > 0 && rest.startsWith(squash(pastes[j])))) j++;
			if (j >= pastes.length) return null;
			used.push(pastes[j]);
			rest = rest.slice(squash(pastes[j]).length);
			next = j + 1;
		}
	}
	return used;
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

/**
 * Raised when the harness will not paste because an earlier paste of its
 * own may still land in the box (pasted but not yet seen, or just
 * submitted): pasting now could put two messages in one box (1.20.207
 * Ella). The caller queues the message; it goes out once the box is
 * settled.
 */
export class TuiPasteHoldError extends Error {
	/** Why the paste was held */
	readonly reason: 'pending-paste' | 'just-submitted';

	/**
	 * @param reason - Why the paste was held
	 */
	constructor(reason: 'pending-paste' | 'just-submitted') {
		super(reason === 'pending-paste'
			? 'An earlier paste of ours may still render in the input box; holding this message'
			: 'Just submitted an earlier paste of ours; holding this message until the box settles');
		this.name = 'TuiPasteHoldError';
		this.reason = reason;
	}
}
