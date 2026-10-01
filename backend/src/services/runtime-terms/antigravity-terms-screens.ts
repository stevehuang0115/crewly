/**
 * Antigravity CLI first-run screens, read from screen text (pure).
 *
 * What agy 1.2.14 paints on its first interactive launch (captured in a PTY,
 * focus marked by `> `, a chosen colour scheme by `* `, a focused button
 * drawn without its brackets):
 *
 * ```
 * Welcome to Antigravity CLI!
 * Choose your color scheme:        ╭──── preview ────╮
 *   > terminal                     │ …               │
 *     light                        │ …               │
 *     …
 * Migration options:                                   ← only when Gemini CLI extensions exist
 *   > [ ] Import extensions from Gemini CLI (1 found: …)
 *     [Next]                                           ← focused: ">  Next"
 *
 * Terms of Service & Data Use
 *   > [x] Yes, I agree to help improve Antigravity CLI by allowing …
 *     [Previous]      [Done]                           ← focused: ">  Previous" / ">  Done"
 *   ↑/↓ Navigate · enter Toggle
 * ```
 *
 * Every field is derived from text, never from a key count, so the driver
 * can check the screen before and after each key.
 * specs/2026-10-01-runtime-terms-consent.md
 *
 * @module services/runtime-terms/antigravity-terms-screens
 */

import { ANTIGRAVITY_CONSTANTS, RUNTIME_TERMS_CONSTANTS } from '../../constants.js';
import { stripAnsiCodes } from '../../utils/terminal-string-ops.js';

const A = RUNTIME_TERMS_CONSTANTS.ANTIGRAVITY;

/** Focus on the colour-scheme screen. */
export type ColorSchemeFocus =
	| { type: 'scheme'; name: string }
	| { type: 'import'; checked: boolean }
	| { type: 'next' };

/** Focus on the Terms screen. */
export type TermsFocus = 'data' | 'previous' | 'done';

/** A parsed screen. */
export type AntigravityTermsScreen =
	| {
			kind: 'color_scheme';
			focus: ColorSchemeFocus | null;
			/** Scheme marked `*` (chosen), when one is */
			chosenScheme: string | null;
			/** The migration section is shown */
			migration: boolean;
			/** Its import checkbox, when shown */
			importChecked: boolean | null;
	  }
	| { kind: 'terms'; focus: TermsFocus | null; dataChecked: boolean | null }
	| { kind: 'trust' }
	| { kind: 'login' }
	| { kind: 'main_prompt' }
	| { kind: 'unknown' };

/**
 * The left column of a line (the colour list shares lines with the preview box).
 *
 * @param line - Screen line
 * @returns Text before the preview box border
 */
function leftColumn(line: string): string {
	const cut = line.search(/[│╭╰]/);
	return (cut >= 0 ? line.slice(0, cut) : line).replace(/\s+$/, '');
}

/**
 * Parse the colour-scheme screen.
 *
 * @param lines - Screen lines
 * @returns Parsed screen
 */
function parseColorScheme(lines: string[]): AntigravityTermsScreen {
	let focus: ColorSchemeFocus | null = null;
	let chosenScheme: string | null = null;
	let importChecked: boolean | null = null;
	let migration = false;
	for (const raw of lines) {
		const line = leftColumn(raw);
		const scheme = /^\s*([>*])?\s*(.+?)\s*$/.exec(line);
		if (scheme && A.COLOR_SCHEMES.includes(scheme[2])) {
			if (scheme[1] === '>') focus = { type: 'scheme', name: scheme[2] };
			if (scheme[1] === '*') chosenScheme = scheme[2];
			continue;
		}
		if (raw.includes(A.MIGRATION_TITLE)) migration = true;
		if (raw.includes(A.IMPORT_ITEM)) {
			const m = /^\s*(>)?\s*\[([ xX])\]/.exec(raw);
			if (m) {
				importChecked = m[2].toLowerCase() === 'x';
				if (m[1]) focus = { type: 'import', checked: importChecked };
			}
			continue;
		}
		if (new RegExp(`^\\s*>\\s+${A.NEXT_BUTTON}\\s*$`).test(raw)) focus = { type: 'next' };
	}
	return { kind: 'color_scheme', focus, chosenScheme, migration, importChecked };
}

/**
 * Parse the Terms screen.
 *
 * @param lines - Screen lines
 * @returns Parsed screen
 */
function parseTerms(lines: string[]): AntigravityTermsScreen {
	let focus: TermsFocus | null = null;
	let dataChecked: boolean | null = null;
	let dataLines = 0;
	for (const raw of lines) {
		if (raw.includes(A.DATA_ITEM)) {
			dataLines += 1;
			const m = /^\s*(>)?\s*\[([ xX])\]\s/.exec(raw);
			if (m) {
				dataChecked = m[2].toLowerCase() === 'x';
				if (m[1]) focus = 'data';
			}
			continue;
		}
		if (raw.includes(A.PREVIOUS_BUTTON) && raw.includes(A.DONE_BUTTON)) {
			if (new RegExp(`>\\s+${A.PREVIOUS_BUTTON}\\b`).test(raw)) focus = 'previous';
			else if (new RegExp(`>\\s+${A.DONE_BUTTON}\\b`).test(raw)) focus = 'done';
		}
	}
	// Two copies of the item would make "the" checkbox ambiguous.
	if (dataLines !== 1) dataChecked = null;
	return { kind: 'terms', focus, dataChecked };
}

/**
 * Parse an Antigravity CLI screen.
 *
 * @param screen - Captured screen (ANSI is stripped here)
 * @returns What is on screen
 */
export function parseAntigravityTermsScreen(screen: string): AntigravityTermsScreen {
	const clean = stripAnsiCodes(screen);
	const lines = clean.split(/\r?\n/);
	if (clean.includes(A.TERMS_TITLE)) return parseTerms(lines);
	if (clean.includes(A.COLOR_SCHEME_TITLE)) return parseColorScheme(lines);
	const S = ANTIGRAVITY_CONSTANTS.SCREEN;
	if (clean.includes(S.TRUST_PROMPT) && clean.includes(S.TRUST_ACCEPT_OPTION)) return { kind: 'trust' };
	if (S.ACCOUNT_LOGIN_MARKERS.some((m) => clean.includes(m))) return { kind: 'login' };
	if (clean.includes(S.IDLE_FOOTER)) return { kind: 'main_prompt' };
	return { kind: 'unknown' };
}

/**
 * Whether a screen shows the first-run (colour scheme / Terms) screens.
 *
 * @param screen - Captured screen
 * @returns True on either first-run screen
 */
export function isAntigravityFirstRunScreen(screen: string): boolean {
	const kind = parseAntigravityTermsScreen(screen).kind;
	return kind === 'terms' || kind === 'color_scheme';
}
