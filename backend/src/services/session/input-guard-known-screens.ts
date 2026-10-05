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
];
