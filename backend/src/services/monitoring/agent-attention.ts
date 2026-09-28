/**
 * Agent Attention Verdict
 *
 * Decides, from what an agent's terminal shows, whether the agent is blocked
 * on a human (an approval prompt, a trust dialog, a plan-mode menu, any
 * selection dialog) rather than working or idle. See
 * `specs/2026-09-26-agent-waiting-on-human.md`.
 *
 * Pure functions only: the caller supplies the rendered screen text and the
 * latest OSC terminal title. The rules are pinned by fixture files of real
 * captured screens in `__fixtures__/agent-screens/`.
 *
 * Signals and what each one is worth (verified 2026-09-26 on Claude Code
 * 2.1.283 and Codex 0.157.1):
 * - Screen text: the primary signal. A blocking dialog renders a selector
 *   (`❯` / `›`) plus dialog-specific text or a confirm footer.
 * - OSC title: Codex writes `[ ! ] Action Required | …` while it waits and a
 *   braille spinner while it works, so its title votes. Claude Code writes
 *   `✳ <task label>` in every state, so a Claude title is a label only.
 *
 * @module services/monitoring/agent-attention
 */

import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';
import { AGENT_ATTENTION_CONSTANTS } from '../../constants.js';

/** Overall verdict for one agent at one moment. */
export type AttentionVerdict = 'waiting_on_human' | 'busy' | 'idle';

/**
 * What the agent is waiting on.
 * - `permission`: a tool or command approval
 * - `trust`: a folder / workspace trust dialog
 * - `plan`: Claude Code's plan-approval menu
 * - `menu`: some other selection dialog (onboarding, opt-in, …)
 * - `unspecified`: only the terminal title said so
 */
export type WaitingKind = 'permission' | 'trust' | 'plan' | 'menu' | 'unspecified';

/** What the OSC terminal title says on its own. */
export type TitleSignal = 'waiting' | 'busy' | 'none';

/** Input to {@link computeAgentAttention}. */
export interface AttentionInput {
	/** Rendered screen text (ANSI allowed; it is stripped). */
	screen: string;
	/** Latest OSC 0/2 terminal title, if known. */
	title?: string | null;
}

/** Result of {@link computeAgentAttention}. */
export interface AttentionResult {
	/** The fused verdict. */
	verdict: AttentionVerdict;
	/** Set only when `verdict` is `waiting_on_human`. */
	kind?: WaitingKind;
	/** Names of the rules that fired, for logs and escalation text. */
	evidence: string[];
	/** Non-empty screen lines the rules examined (0 means nothing was examined). */
	linesExamined: number;
	/** Human-readable task label taken from the title, without status glyphs. */
	titleLabel?: string;
}

/** A selector cursor at the start of a line (Claude `❯`, Codex `›`). */
const SELECTOR_LINE = /^\s*[❯›]\s*\S/m;

/** A selector cursor on a numbered option, e.g. `❯ 1. Yes`. */
const NUMBERED_SELECTOR_LINE = /^\s*[❯›]\s*\d+\.\s+\S/m;

/** Footer lines that only selection dialogs render. */
const CONFIRM_FOOTER = /(Esc to cancel|Enter to confirm|Press enter to confirm|enter continue\s*·\s*esc back)/i;

/** Work-in-progress markers (Claude and Codex both show "esc to interrupt"). */
const BUSY_MARKER = /esc to interrupt/i;

/** Claude Code's plan-approval menu. */
const PLAN_MENU_HEADER = /(Claude has written up a plan|Ready to code\?)/i;
const PLAN_MENU_QUESTION = /Would you like to proceed\?/i;

/** Folder / workspace trust dialogs (Claude, Codex, Gemini wording). */
const TRUST_TEXT = /(trust this folder|Do you trust the files|Is this a project you (created or one you )?trust|Accessing workspace)/i;

/** Tool / command approval questions. */
const PERMISSION_TEXT = /(Do you want to proceed\?|Do you want to (make this edit|create|allow|run)|Would you like to run the following command\?|Would you like to make the following edits\?)/i;

/** Codex (and similar) title while waiting on the user. */
const TITLE_WAITING = /Action Required/i;

/** A braille spinner glyph (U+2800–U+28FF) leading the title means work in progress. */
const TITLE_SPINNER = /^\s*[⠀-⣿]/;

/** Status glyphs and markers stripped from a title to get its label. */
const TITLE_DECORATION = /^\s*(\[\s*!\s*\]\s*Action Required\s*\|\s*)?([⠀-⣿]\s*\|?\s*)?([✳✻✽✶✢·*]\s*)?/i;

/**
 * Keep the bottom of the screen: the last N non-empty lines.
 *
 * Dialogs render at the bottom. Restricting to the bottom region keeps a
 * dialog that was answered minutes ago (still in scrollback) from counting.
 *
 * @param screen - Rendered screen text, ANSI allowed
 * @returns The bottom non-empty lines, joined with newlines, and their count
 */
export function bottomRegion(screen: string): { text: string; lines: number } {
	const nonEmpty = stripAnsiCodes(screen)
		.split('\n')
		.map((line) => line.replace(/\s+$/, ''))
		.filter((line) => line.trim() !== '');
	const kept = nonEmpty.slice(-AGENT_ATTENTION_CONSTANTS.BOTTOM_LINES);
	return { text: kept.join('\n'), lines: kept.length };
}

/**
 * Read the OSC terminal title.
 *
 * @param title - Latest OSC title, or null/undefined when unknown
 * @returns The title's own signal and its label without status glyphs
 *
 * @example
 * ```typescript
 * classifyTitle('[ ! ] Action Required | ⠸ | repo'); // { signal: 'waiting', label: 'repo' }
 * classifyTitle('✳ Fix login bug');                  // { signal: 'none', label: 'Fix login bug' }
 * ```
 */
export function classifyTitle(title: string | null | undefined): { signal: TitleSignal; label: string } {
	if (!title || title.trim() === '') {
		return { signal: 'none', label: '' };
	}
	const label = title.replace(TITLE_DECORATION, '').trim();
	if (TITLE_WAITING.test(title)) {
		return { signal: 'waiting', label };
	}
	if (TITLE_SPINNER.test(title)) {
		return { signal: 'busy', label };
	}
	return { signal: 'none', label };
}

/**
 * Find a blocking dialog at the bottom of the screen.
 *
 * @param screen - Rendered screen text, ANSI allowed
 * @returns The dialog kind (undefined when none), rule evidence, whether a
 *   busy marker is visible, and how many lines were examined
 */
export function detectPromptOnScreen(screen: string): {
	kind?: WaitingKind;
	evidence: string[];
	busy: boolean;
	linesExamined: number;
} {
	const { text, lines } = bottomRegion(screen);
	const evidence: string[] = [];
	const busy = BUSY_MARKER.test(text);

	const selector = SELECTOR_LINE.test(text);
	const numbered = NUMBERED_SELECTOR_LINE.test(text);
	const footer = CONFIRM_FOOTER.test(text);
	// A selector alone is not enough: Claude renders user messages and the
	// input box with `❯`, and Codex its input box with `›`.
	const menuPresent = numbered || (selector && footer);

	let kind: WaitingKind | undefined;
	if (PLAN_MENU_HEADER.test(text) && PLAN_MENU_QUESTION.test(text)) {
		kind = 'plan';
		evidence.push('screen:plan-menu');
	} else if (menuPresent && TRUST_TEXT.test(text)) {
		kind = 'trust';
		evidence.push('screen:trust-dialog');
	} else if (menuPresent && PERMISSION_TEXT.test(text)) {
		kind = 'permission';
		evidence.push('screen:permission-prompt');
	} else if (selector && footer) {
		kind = 'menu';
		evidence.push('screen:selection-dialog');
	}
	if (busy) {
		evidence.push('screen:busy-marker');
	}
	return { kind, evidence, busy, linesExamined: lines };
}

/**
 * Fuse screen and title into one attention verdict.
 *
 * Precedence: a dialog on screen wins (it is explicit), then a waiting title,
 * then any busy signal, else idle.
 *
 * @param input - Rendered screen and latest title
 * @returns The verdict with its evidence and the number of lines examined
 *
 * @example
 * ```typescript
 * const r = computeAgentAttention({ screen: backend.captureOutput(s, 40), title });
 * if (r.verdict === 'waiting_on_human') routeToOwner(r.kind);
 * ```
 */
export function computeAgentAttention(input: AttentionInput): AttentionResult {
	const screen = detectPromptOnScreen(input.screen);
	const title = classifyTitle(input.title);
	const evidence = [...screen.evidence];
	if (title.signal !== 'none') {
		evidence.push(`title:${title.signal}`);
	}
	const base = {
		evidence,
		linesExamined: screen.linesExamined,
		...(title.label ? { titleLabel: title.label } : {}),
	};

	if (screen.kind) {
		return { verdict: 'waiting_on_human', kind: screen.kind, ...base };
	}
	if (title.signal === 'waiting') {
		return { verdict: 'waiting_on_human', kind: 'unspecified', ...base };
	}
	if (screen.busy || title.signal === 'busy') {
		return { verdict: 'busy', ...base };
	}
	return { verdict: 'idle', ...base };
}
