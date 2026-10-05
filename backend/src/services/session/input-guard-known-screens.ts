/**
 * Known input-box screens the input guard must keep reading right — run by
 * the release input-guard check (`npm run check:input-guard` /
 * `crewly doctor --input-guard`) against the NEW build's classifier,
 * alongside the live agent screens.
 *
 * The views are rendered from the recorded Claude Code 2.1.288 frames in
 * `__fixtures__/tui/claude-code-2.1.288/` (the same bytes the unit tests
 * replay), kept here as plain screen rows because the `.ansi` fixtures are
 * not part of a build. The split-paste frames reproduce the screen of
 * crewly#1028 (ce-vera, Claude Code 2.1.288/289): one harness paste that
 * Claude Code showed as two markers on one line,
 * `❯ [Pasted text #3 +7 lines][Pasted text #4 +6 lines]`, idle and mid-turn.
 *
 * The `cc289-*` screens are live Claude Code 2.1.289 screens from the
 * owner's Mac (2026-10-05, 324 held deliveries in a day): a `─` of a box
 * rule arrived as broken UTF-8 and shows as U+FFFD cells, or a misplaced
 * repaint left stale transcript text (`(ct`) over the top rule's left end.
 * Only the box rows (and the line above) are kept.
 *
 * @module services/session/input-guard-known-screens
 */

import type { TuiInputStage, TuiInputState, TuiInputView } from './tui-input-guard.js';

/** One known screen and how the guard must read it. */
export interface KnownInputScreen {
	/** Short name (reported as `fixture:<name>`) */
	name: string;
	/** Runtime and version the frame was recorded from */
	runtime: string;
	view: TuiInputView;
	/** The message being delivered (or '' for none) */
	message: string;
	stage: TuiInputStage;
	/** Harness pastes since the last outside input (the input ledger), oldest first */
	pastes: string[];
	/** The reading the guard must give */
	expect: TuiInputState;
	/** Why this screen matters */
	why: string;
}

/** A 15-line brief (14 line breaks), like the CE-93 brief of crewly#1028. */
export const SPLIT_BRIEF = [
	'[TASK] CE-93: brand preview page',
	'',
	'## Goal',
	'Ship the brand preview page behind /preview-brand.',
	'',
	'## Steps',
	'1. Read the design notes.',
	'2. Build the page.',
	'3. Add the locale paths.',
	'4. Run the tests.',
	'',
	'## Done when',
	'- the page renders in both locales',
	'- the ticket has a screenshot',
	'Reply with report-status when done.',
].join('\n');

/** A 5-line message (4 line breaks). */
export const FIVE_LINES = ['M1-MARK line one', 'line two', 'line three', 'line four', 'line five'].join('\n');

/** `labelled-rule-empty.ansi` */
const LABELLED_EMPTY: TuiInputView = {
	lines: [
		' ▐▛███▛█   Claude Code v2.1.288',
		'▝▜██████▀  Opus 5.5 · Claude Max',
		' ▝▝   ▝▝   @fixture-agent · /…/7573773a-4098-43b3-a9f9-af36146453a7/scratchpad/cap2/cc',
		'',
		'',
		'──────────────────────────────────────────────────────────────────────────────────── fixture-agent ─',
		'❯',
		'────────────────────────────────────────────────────────────────────────────────────────────────────',
		'  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents                           ◐ medium · /effort',
	],
	cursorRow: 6,
};

/** `labelled-rule-pasted-marker.ansi` */
const LABELLED_ONE_MARKER: TuiInputView = {
	lines: [
		' ▐▛███▛█   Claude Code v2.1.288',
		'▝▜██████▀  Opus 5.5 · Claude Max',
		' ▝▝   ▝▝   @fixture-agent · /…/7573773a-4098-43b3-a9f9-af36146453a7/scratchpad/cap2/cc',
		'',
		'',
		'──────────────────────────────────────────────────────────────────────────────────── fixture-agent ─',
		'❯\u00a0[Pasted text #1 +4 lines]',
		'────────────────────────────────────────────────────────────────────────────────────────────────────',
		'  paste again to expand                                                         ◐ medium · /effort',
	],
	cursorRow: 6,
};

/** `split-paste-two-markers.ansi` */
const SPLIT_TWO_MARKERS: TuiInputView = {
	lines: [
		' ▐▛███▛█   Claude Code v2.1.288',
		'▝▜██████▀  Opus 5.5 · Claude Max',
		' ▝▝   ▝▝   @fixture-agent · /…/7573773a-4098-43b3-a9f9-af36146453a7/scratchpad/cap2/cc',
		'',
		'',
		'──────────────────────────────────────────────────────────────────────────────────── fixture-agent ─',
		'❯\u00a0[Pasted text #3 +7 lines][Pasted text #4 +6 lines]',
		'────────────────────────────────────────────────────────────────────────────────────────────────────',
		'  paste again to expand                                                         ◐ medium · /effort',
	],
	cursorRow: 6,
};

/** `busy-split-paste-two-markers.ansi` */
const BUSY_SPLIT_TWO_MARKERS: TuiInputView = {
	lines: [
		' ▐▛███▛█   Claude Code v2.1.288',
		'▝▜██████▀  Opus 5.5 · Claude Max',
		' ▝▝   ▝▝   @fixture-agent · /…/7573773a-4098-43b3-a9f9-af36146453a7/scratchpad/cap2/cc',
		'',
		'',
		'❯ M1-MARK line one',
		'  line two',
		'  line three',
		'  line four',
		'  line five',
		'',
		'✳ Flambéing…',
		'',
		'──────────────────────────────────────────────────────────────────────────────────── fixture-agent ─',
		'❯\u00a0[Pasted text #4 +7 lines][Pasted text #5 +6 lines]',
		'────────────────────────────────────────────────────────────────────────────────────────────────────',
		'  paste again to expand',
	],
	cursorRow: 14,
};

/** Live ce-vera (2.1.289): three U+FFFD cells inside the labelled top rule. */
const CC289_GARBLED_TOP_RULE: TuiInputView = {
	lines: [
		'✻ Worked for 30s · done 9:59 AM',
		'',
		'────────────────────────\ufffd\ufffd\ufffd──────────────────────────────────── ce-vera-d8f94e9c ─',
		'❯',
		'────────────────────────────────────────────────────────────────────────────────',
		'  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
	],
	cursorRow: 3,
};

/** Live crewly-marketing-lyra (2.1.289): U+FFFD cells inside the bottom rule. */
const CC289_GARBLED_BOTTOM_RULE: TuiInputView = {
	lines: [
		'✻ Crunched for 2m 0s · done 9:28 AM',
		'',
		'─────────────────────────────────────────────── crewly-marketing-lyra-c5fd5f97 ─',
		'❯',
		'──────────────────────────────────────────────────────────────\ufffd\ufffd\ufffd─────────────────',
		'  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
	],
	cursorRow: 3,
};

/** Live flopost-pia (2.1.289): stale transcript text over the top rule's left end. */
const CC289_STALE_TOP_RULE: TuiInputView = {
	lines: [
		'     10.000000',
		'     (3s)',
		'     (ct───────────────────────────────────────────────── flopost-pia-50c4c954 ─',
		'❯',
		'────────────────────────────────────────────────────────────────────────────────',
		'  ⏵⏵ bypass permissions on (shift+tab to cycle) · /tasks to see subagents · e…',
	],
	cursorRow: 3,
};

/** {@link CC289_GARBLED_TOP_RULE} with text in the box. */
function cc289GarbledWithText(text: string): TuiInputView {
	const lines = [...CC289_GARBLED_TOP_RULE.lines];
	lines[3] = `❯\u00a0${text}`;
	return { lines, cursorRow: 3 };
}

/** One line typed into the box (the owner's draft, or our earlier paste). */
export const CC289_BOX_TEXT = 'M1-MARK draft reply to the client';

/**
 * Live crewly-marketing-luna (2.1.289, 2026-10-05 16:32Z) mid-repaint: the
 * top rule and prompt are drawn, the bottom rule is not yet. Without the
 * bottom rule the box's end is unknown (owner text could continue below),
 * so it must stay unreadable; the helper reads it again once the frame is
 * complete (readInputBoxSettled).
 */
const CC289_NO_BOTTOM_RULE: TuiInputView = {
	lines: [
		'✢ Simmering… (1m 25s · ↓ 193 tokens)',
		"  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's",
		'     current work',
		'',
		'─────────────────────────────────────────────── crewly-marketing-luna-40e6e251 ─',
		'❯',
	],
	cursorRow: 5,
};

/** The screens, in report order. */
export const KNOWN_INPUT_SCREENS: readonly KnownInputScreen[] = [
	{
		name: 'labelled-empty',
		runtime: 'claude-code-2.1.288',
		view: LABELLED_EMPTY,
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'empty',
		why: 'an empty box under a labelled top rule reads empty',
	},
	{
		name: 'own-single-marker',
		runtime: 'claude-code-2.1.288',
		view: LABELLED_ONE_MARKER,
		message: '',
		stage: 'recovery',
		pastes: [FIVE_LINES],
		expect: 'ours',
		why: 'our own collapsed paste ("[Pasted text #1 +4 lines]") is ours',
	},
	{
		name: 'own-split-paste',
		runtime: 'claude-code-2.1.288',
		view: SPLIT_TWO_MARKERS,
		message: '',
		stage: 'recovery',
		pastes: [SPLIT_BRIEF],
		expect: 'ours',
		why: 'crewly#1028: one paste of ours shown as two markers is ours (Enter, not a redelivery storm)',
	},
	{
		name: 'own-split-paste-busy',
		runtime: 'claude-code-2.1.288',
		view: BUSY_SPLIT_TWO_MARKERS,
		message: '',
		stage: 'recovery',
		pastes: [SPLIT_BRIEF],
		expect: 'ours',
		why: 'crewly#1028 mid-turn: the split paste stays ours while the agent works',
	},
	{
		name: 'owner-split-paste',
		runtime: 'claude-code-2.1.288',
		view: SPLIT_TWO_MARKERS,
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'foreign',
		why: 'the same markers with no paste of ours on record (the owner pasted) are never ours',
	},
	{
		name: 'split-paste-wrong-shape',
		runtime: 'claude-code-2.1.288',
		view: SPLIT_TWO_MARKERS,
		message: '',
		stage: 'recovery',
		pastes: [FIVE_LINES],
		expect: 'foreign',
		why: 'markers that do not add up to any paste of ours are not ours',
	},
	{
		name: 'cc289-garbled-top-rule-empty',
		runtime: 'claude-code-2.1.289',
		view: CC289_GARBLED_TOP_RULE,
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'empty',
		why: 'a top rule with U+FFFD cells (broken UTF-8 from 2.1.289) still bounds an empty box',
	},
	{
		name: 'cc289-garbled-bottom-rule-empty',
		runtime: 'claude-code-2.1.289',
		view: CC289_GARBLED_BOTTOM_RULE,
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'empty',
		why: 'a bottom rule with U+FFFD cells still bounds an empty box',
	},
	{
		name: 'cc289-stale-top-rule-empty',
		runtime: 'claude-code-2.1.289',
		view: CC289_STALE_TOP_RULE,
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'empty',
		why: 'a labelled top rule with stale text over its left end still bounds an empty box',
	},
	{
		name: 'cc289-garbled-rule-owner-text',
		runtime: 'claude-code-2.1.289',
		view: cc289GarbledWithText(CC289_BOX_TEXT),
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'foreign',
		why: 'text in a box with a garbled rule is still read exactly: not ours, never typed over',
	},
	{
		name: 'cc289-garbled-rule-own-text',
		runtime: 'claude-code-2.1.289',
		view: cc289GarbledWithText(CC289_BOX_TEXT),
		message: CC289_BOX_TEXT,
		stage: 'before-write',
		pastes: [],
		expect: 'ours',
		why: 'an exact copy of this very message in a box with a garbled rule is ours',
	},
	{
		name: 'cc289-mid-repaint-no-bottom-rule',
		runtime: 'claude-code-2.1.289',
		view: CC289_NO_BOTTOM_RULE,
		message: SPLIT_BRIEF,
		stage: 'before-write',
		pastes: [],
		expect: 'unknown',
		why: 'a box whose bottom rule is not drawn yet is never read as empty (the helper re-reads it once the frame is done)',
	},
];
