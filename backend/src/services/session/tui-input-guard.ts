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
 * only when the box holds exactly the text the harness wrote. Text it did
 * not write — typed by someone, accepted from a suggestion, or left over —
 * is never submitted by the harness.
 *
 * Reading relies on a capture with faint cells blanked
 * (`captureOutputWithoutFaint`), because ghost text is only distinguishable
 * from real input by its style.
 *
 * @module services/session/tui-input-guard
 */

import { matchTuiPromptLine, stripTuiLineBorders } from '../../utils/terminal-string-ops.js';
import { TUI_INPUT_GUARD } from '../../constants.js';

/**
 * What the input box holds, relative to a message the harness wants to send.
 *
 * - `empty`: an input box was found and holds nothing.
 * - `ours`: it holds exactly the message (or the runtime's collapsed
 *   "[Pasted text …]" marker for it), and nothing else.
 * - `foreign`: it holds text the harness did not write (alone or mixed
 *   with the message).
 * - `unknown`: no input box was found on screen (a shell, a dialog,
 *   a runtime still starting). The caller decides; nothing is known.
 */
export type TuiInputState = 'empty' | 'ours' | 'foreign' | 'unknown';

/**
 * Result of reading an input box.
 */
export interface TuiInputReading {
	/** Classification of the input box contents */
	state: TuiInputState;
	/** The input box text as read (whitespace-normalised), '' when none */
	text: string;
}

/**
 * Whether a line is an input-box border (a run of horizontal box-drawing
 * characters, optionally with corner pieces).
 *
 * @param line - A terminal line
 * @returns True for a border line
 */
function isBorderLine(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed.length < 3) return false;
	return /^[─━═╌╍┄┅╭╮╰╯┌┐└┘├┤▔▁-]+$/u.test(trimmed);
}

/**
 * Read the text of the bottom-most input box on a screen.
 *
 * Finds the last prompt line (`❯`, `>`, `›` at the start of a line, inside
 * optional box borders) within the bottom of the screen, then collects its
 * continuation lines until the box's bottom border or a blank line.
 *
 * @param screen - Captured screen, ideally with faint text blanked
 * @returns `{ found, text }` — text is whitespace-normalised
 */
export function readTuiInputBox(screen: string): { found: boolean; text: string } {
	const lines = screen.split('\n');
	const lowest = Math.max(0, lines.length - TUI_INPUT_GUARD.SCAN_LINES);

	for (let i = lines.length - 1; i >= lowest; i--) {
		const line = lines[i];
		const promptText = readPromptLine(line);
		if (promptText === null) continue;

		const parts = [promptText];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j];
			if (isBorderLine(next)) break;
			const inner = stripTuiLineBorders(next);
			if (inner.trim() === '') break;
			parts.push(inner);
		}
		return { found: true, text: parts.join(' ').replace(/\s+/g, ' ').trim() };
	}
	return { found: false, text: '' };
}

/**
 * Content of a prompt line, '' for an empty prompt, null when the line is
 * not a prompt line.
 *
 * @param line - A terminal line
 * @returns Prompt content or null
 */
function readPromptLine(line: string): string | null {
	const content = matchTuiPromptLine(line);
	if (content !== null) return stripTuiLineBorders(content);
	// matchTuiPromptLine needs text after the prompt char; an empty prompt
	// is the prompt char alone (borders and spaces around it).
	const bare = stripTuiLineBorders(line).trim();
	if (bare === '❯' || bare === '>' || bare === '›') return '';
	return null;
}

/**
 * Remove every whitespace character, so terminal wrapping (which can split
 * a word across lines) does not affect comparison.
 *
 * @param text - Text
 * @returns Text without whitespace
 */
function squash(text: string): string {
	return text.replace(/\s+/g, '');
}

/**
 * Whether input-box text is a runtime's collapsed marker for a paste
 * (Claude Code "[Pasted text #1 +40 lines]", Codex "[Pasted Content 1234
 * chars]", and similar). Ghost suggestions are natural language and never
 * take this form.
 *
 * @param text - Input box text
 * @returns True for a lone paste marker
 */
export function isPasteMarker(text: string): boolean {
	return TUI_INPUT_GUARD.PASTE_MARKER_PATTERN.test(text.trim());
}

/**
 * Whether input-box text is a known placeholder hint that a runtime paints
 * in an empty box. Used only as a fallback when faint styling could not be
 * seen (a backend without styled capture).
 *
 * @param text - Input box text
 * @returns True for a known placeholder
 */
function isKnownPlaceholder(text: string): boolean {
	const lower = text.toLowerCase();
	return TUI_INPUT_GUARD.KNOWN_PLACEHOLDERS.some((p) => lower.startsWith(p));
}

/**
 * Classify what an input box holds relative to the message the harness
 * wants to send (or has just pasted).
 *
 * `ours` requires that nothing else is in the box: either the whole
 * message, a window of it (a long message can scroll inside the box), or a
 * lone collapsed-paste marker. Anything before or after it is `foreign`.
 *
 * @param screen - Captured screen with faint text blanked
 * @param message - The message the harness wrote (or will write)
 * @returns The reading
 */
export function classifyTuiInput(screen: string, message: string): TuiInputReading {
	const box = readTuiInputBox(screen);
	if (!box.found) return { state: 'unknown', text: '' };
	const text = box.text;
	if (text === '' || isKnownPlaceholder(text)) return { state: 'empty', text: '' };
	if (isPasteMarker(text)) return { state: 'ours', text };

	const boxSquashed = squash(text);
	const messageSquashed = squash(message);
	if (messageSquashed.length > 0) {
		if (boxSquashed === messageSquashed) return { state: 'ours', text };
		// A window of the message: long text scrolls inside the box, so the
		// visible part may be any slice of it — but only a slice of it.
		const minWindow = Math.min(TUI_INPUT_GUARD.MIN_WINDOW_CHARS, messageSquashed.length);
		if (boxSquashed.length >= minWindow && messageSquashed.includes(boxSquashed)) {
			return { state: 'ours', text };
		}
	}
	return { state: 'foreign', text };
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
				? `Input box holds text the harness did not write (${reading.state}); refusing to type into it`
				: `Input box does not hold exactly the harness's text (${reading.state}); refusing to press Enter`
		);
		this.name = 'TuiInputGuardError';
		this.stage = stage;
		this.reading = reading;
	}
}
