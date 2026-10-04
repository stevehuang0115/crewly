/**
 * Tests for the TUI input guard, on real TUI captures.
 *
 * Fixtures under `__fixtures__/tui/` are the raw byte streams recorded from
 * Claude Code 2.1.288 and Codex 0.160.0 running in a PTY (100x30) and fed
 * through headless xterm — the same way the backend captures agent
 * sessions. Replaying a stream into a fresh PtyTerminalBuffer reproduces
 * the frame exactly, faint styling included. (Paths in the banners were
 * anonymised.)
 *
 * Claude Code's prompt suggestion could not be made to appear live (it is
 * server-gated); it is rendered with the same faint style as the
 * `Try "…"` placeholder, which the real frames cover. The synthetic test at
 * the end uses that style.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PtyTerminalBuffer } from './pty/pty-terminal-buffer.js';
import {
	classifyTuiInput,
	findTuiInputBox,
	isPasteMarker,
	pasteShowsAs,
	boxHoldsOnlyOwnPastes,
	attributeOwnPastes,
	isInputBoxRule,
	screenShowsTurnInProgress,
	readTurnSignals,
	TuiInputGuardError,
	type TuiInputView,
} from './tui-input-guard.js';

const FIXTURES = path.join(__dirname, '__fixtures__', 'tui');

/**
 * Replay a recorded TUI stream into a headless terminal and read the view.
 *
 * @param runtime - Fixture folder (runtime and version)
 * @param name - Frame name
 * @returns The faint-free view with cursor row
 */
async function frame(runtime: string, name: string): Promise<TuiInputView> {
	const buffer = new PtyTerminalBuffer(100, 30);
	buffer.write(fs.readFileSync(path.join(FIXTURES, runtime, `${name}.ansi`), 'utf8'));
	await buffer.flush();
	const view = buffer.getInputView();
	buffer.dispose();
	return view;
}
const cc = (name: string): Promise<TuiInputView> => frame('claude-code-2.1.288', name);
const cx = (name: string): Promise<TuiInputView> => frame('codex-0.160.0', name);
const gm = (name: string): Promise<TuiInputView> => frame('gemini-0.40.1', name);

const OURS = '[CHAT:c1] reminder: the owner is waiting';
const TASK = '## Task\n\nPlease reply.\n> ok go\nthanks';

describe('tui-input-guard', () => {
	describe('Claude Code 2.1.288 (real captures)', () => {
		it('reads the box between the rules, with the ❯ + U+00A0 prompt', async () => {
			const box = findTuiInputBox(await cc('typed-single'));
			expect(box).toEqual({ layout: 'claude-code', lines: ['hello world probe'] });
		});

		it('an empty box with the faint `Try "…"` placeholder reads empty', async () => {
			expect(classifyTuiInput(await cc('empty-placeholder'), OURS, 'before-write')).toMatchObject({ state: 'empty', layout: 'claude-code' });
		});

		it('an accepted suggestion (solid text) is foreign before we type, and never ours', async () => {
			const view = await cc('accepted-suggestion');
			expect(classifyTuiInput(view, OURS, 'before-write')).toMatchObject({ state: 'foreign', text: '按这个草稿回吧' });
			expect(classifyTuiInput(view, OURS, 'after-paste').state).toBe('foreign');
		});

		it('before typing, an exact copy of this message (an earlier attempt) is ours; anything else is not', async () => {
			expect(classifyTuiInput(await cc('typed-single'), 'hello world probe', 'before-write').state).toBe('ours');
			expect(classifyTuiInput(await cc('typed-single'), 'hello world', 'before-write').state).toBe('foreign');
		});

		it('the incident frame — accepted suggestion with our message after it — is foreign (no Enter)', async () => {
			const reading = classifyTuiInput(await cc('accepted-suggestion-plus-ours'), OURS, 'after-paste');
			expect(reading).toMatchObject({ state: 'foreign', text: `按这个草稿回吧${OURS}` });
		});

		it('our own text after a turn is ours; the transcript echo of an earlier prompt is not the box', async () => {
			const view = await cc('after-turn-ours-in-box');
			expect(classifyTuiInput(view, OURS, 'after-paste').state).toBe('ours');
			const echoed = 'I am drafting a reply to a LinkedIn comment. Answer only: Draft ready - should I post it?';
			expect(classifyTuiInput(view, echoed, 'recovery').state).toBe('foreign');
			// The empty box under the same transcript reads empty, not "our text is stuck".
			expect(classifyTuiInput(await cc('after-turn-empty-box'), echoed, 'recovery').state).toBe('empty');
		});

		it('collapsed pastes ("[Pasted text #1 +4 lines]", "[Pasted text #2]") are ours after our paste', async () => {
			expect(classifyTuiInput(await cc('pasted-5-lines-marker'), TASK, 'after-paste').state).toBe('ours');
			expect(classifyTuiInput(await cc('pasted-long-marker'), 'LONG START …', 'after-paste').state).toBe('ours');
			// …but not as a leftover before we type, nor during recovery: a
			// marker proves nothing about whose paste it was.
			expect(classifyTuiInput(await cc('pasted-5-lines-marker'), TASK, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await cc('pasted-5-lines-marker'), TASK, 'recovery').state).toBe('foreign');
		});

		it('short and quoted messages are ours ("> ok go", two lines, "## Task" with a blank line)', async () => {
			expect(classifyTuiInput(await cc('pasted-quote-line'), '> ok go', 'after-paste').state).toBe('ours');
			expect(classifyTuiInput(await cc('pasted-two-lines'), 'line one\nline two', 'after-paste').state).toBe('ours');
			expect(classifyTuiInput(await cc('pasted-heading-3-lines'), '## Task\n\nPlease reply.', 'after-paste').state).toBe('ours');
		});

		it('one Ctrl+U clears a single line, a mixed line and a paste marker', async () => {
			for (const name of ['after-ctrl-u', 'mixed-after-one-ctrl-u', 'marker-after-one-ctrl-u']) {
				expect(classifyTuiInput(await cc(name), OURS, 'before-write').state).toBe('empty');
			}
		});

		it('Ctrl+U + Backspace pairs clear one line each (3 lines: 3 pairs)', async () => {
			const msg = 'line one\nline two\nline three';
			expect(classifyTuiInput(await cc('pasted-three-lines'), msg, 'before-write')).toMatchObject({ state: 'ours', lineCount: 3 });
			expect(classifyTuiInput(await cc('three-pair-1'), msg, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await cc('three-pair-3'), msg, 'before-write').state).toBe('empty');
		});
	});

	describe('Codex 0.160.0 (real captures)', () => {
		it('an empty composer with the faint placeholder reads empty', async () => {
			expect(classifyTuiInput(await cx('empty-placeholder'), OURS, 'before-write')).toMatchObject({ state: 'empty', layout: 'codex' });
			expect(classifyTuiInput(await cx('after-turn-empty'), OURS, 'before-write').state).toBe('empty');
		});

		it('reads the composer from the bottom-most › line to the cursor, blank lines included', async () => {
			const box = findTuiInputBox(await cx('pasted-5-lines'));
			expect(box).toEqual({ layout: 'codex', lines: ['## Task', '', 'Please reply.', '> ok go', 'thanks'] });
			expect(classifyTuiInput(await cx('pasted-5-lines'), TASK, 'after-paste')).toMatchObject({ state: 'ours', lineCount: 5 });
		});

		it('the history echo above the composer is not the box', async () => {
			expect(classifyTuiInput(await cx('after-turn-pasted-5-lines'), TASK, 'after-paste').state).toBe('ours');
			expect(classifyTuiInput(await cx('after-turn-pasted-5-lines'), 'Reply with only the word OK.', 'recovery').state).toBe('foreign');
		});

		it('short, quoted and long messages are ours', async () => {
			expect(classifyTuiInput(await cx('short-text'), 'ok go', 'after-paste').state).toBe('ours');
			expect(classifyTuiInput(await cx('pasted-quote-line'), '> ok go', 'after-paste').state).toBe('ours');
			const long = `LONG START ${Array.from({ length: 79 }, () => '0123456789').join(' ')} END`;
			expect(classifyTuiInput(await cx('pasted-long'), long, 'after-paste').state).toBe('ours');
			expect(classifyTuiInput(await cx('typed-single'), 'hello world probe', 'recovery').state).toBe('ours');
		});

		it('Ctrl+U + Backspace pairs clear one line each (5 lines: 5 pairs)', async () => {
			expect(classifyTuiInput(await cx('pair-1'), TASK, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await cx('pair-4'), TASK, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await cx('pair-5'), TASK, 'before-write').state).toBe('empty');
		});

		it('Ctrl+U clears about one line per two presses: four presses leave text, ten clear it', async () => {
			for (const name of ['ctrl-u-1', 'ctrl-u-2', 'ctrl-u-3', 'ctrl-u-4']) {
				expect(classifyTuiInput(await cx(name), TASK, 'before-write').state).toBe('foreign');
			}
			expect(classifyTuiInput(await cx('ctrl-u-10'), TASK, 'before-write').state).toBe('empty');
		});

		it('without the cursor inside the composer the box is not trusted (unknown)', async () => {
			const view = await cx('typed-single');
			expect(classifyTuiInput({ ...view, cursorRow: -1 }, 'hello world probe').state).toBe('unknown');
		});
	});

	describe('Gemini CLI 0.40.1 (real captures)', () => {
		it('reads the ▄▄▄ / > text / ▀▀▀ box; the solid "Type your message" hint reads empty', async () => {
			expect(classifyTuiInput(await gm('empty-placeholder'), OURS, 'before-write')).toMatchObject({ state: 'empty', layout: 'gemini', verified: true });
			expect(findTuiInputBox(await gm('typed-single'))).toEqual({ layout: 'gemini', lines: ['hello world probe'] });
			expect(classifyTuiInput(await gm('after-ctrl-u'), OURS, 'before-write').state).toBe('empty');
		});

		it('a multi-line "## Task" message with a blank line and a quoted line is ours', async () => {
			expect(classifyTuiInput(await gm('pasted-5-lines'), TASK, 'after-paste')).toMatchObject({ state: 'ours', lineCount: 5 });
		});

		it('Ctrl+U alone stalls on the first empty line; Ctrl+U + Backspace pairs clear a line each', async () => {
			expect(classifyTuiInput(await gm('ctrl-u-only-10-presses'), TASK, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await gm('pair-1'), TASK, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await gm('pair-4'), TASK, 'before-write').state).toBe('foreign');
			expect(classifyTuiInput(await gm('pair-5'), TASK, 'before-write').state).toBe('empty');
		});
	});

	describe('other layouts', () => {
		/**
		 * Render ANSI lines into a fresh terminal.
		 *
		 * @param lines - Lines (may contain ANSI)
		 * @returns The view
		 */
		async function render(lines: string[]): Promise<TuiInputView> {
			const buffer = new PtyTerminalBuffer(80, 24);
			buffer.write(lines.join('\r\n'));
			await buffer.flush();
			const view = buffer.getInputView();
			buffer.dispose();
			return view;
		}
		const RULE = '─'.repeat(70);

		it('synthetic: a faint Claude Code prompt suggestion with a fake cursor reads empty', async () => {
			const view = await render([RULE, '❯ \x1b[7m按\x1b[27m\x1b[2m这个草稿回吧\x1b[22m', RULE, '  ⏵⏵ auto mode on']);
			expect(classifyTuiInput(view, OURS, 'before-write')).toMatchObject({ state: 'empty', layout: 'claude-code' });
		});

		it('Claude Code top rule labelled with the session name still reads the box', async () => {
			const labelled = '─'.repeat(60) + ' crewly-orc ─';
			const empty = await render([labelled, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents']);
			expect(classifyTuiInput(empty, OURS, 'before-write')).toMatchObject({ state: 'empty', layout: 'claude-code' });
			const ours = await render([labelled, '❯ hello orc', RULE, '  ⏵⏵ bypass permissions on']);
			expect(classifyTuiInput(ours, 'hello orc', 'after-paste')).toMatchObject({ state: 'ours', layout: 'claude-code' });
			const foreign = await render([labelled, '❯ owner typed this', RULE]);
			expect(classifyTuiInput(foreign, 'hello orc', 'before-write').state).toBe('foreign');
		});

		it('older Gemini ╭│╰ box (not verified live): our text ours, faint hint empty', async () => {
			const top = '╭' + '─'.repeat(60) + '╮';
			const bottom = '╰' + '─'.repeat(60) + '╯';
			const ours = await render([top, '│ > hello gemini agent'.padEnd(61) + '│', bottom]);
			expect(classifyTuiInput(ours, 'hello gemini agent', 'after-paste')).toMatchObject({ state: 'ours', layout: 'gemini-legacy', verified: false });
			const hint = await render([top, `│ > \x1b[2mType your message or @path/to/file\x1b[22m`.padEnd(70) + '│', bottom]);
			expect(classifyTuiInput(hint, 'x', 'before-write').state).toBe('empty');
		});

		it('Antigravity ruled box with a > prompt', async () => {
			const view = await render([RULE, '> Read the file at /x.md', RULE, '? for shortcuts']);
			expect(classifyTuiInput(view, 'Read the file at /x.md', 'after-paste')).toMatchObject({ state: 'ours', layout: 'antigravity' });
		});

		it('a plain shell screen has no input box (unknown)', async () => {
			expect(classifyTuiInput(await render(['Last login: today', 'user@host ~ % ']), 'claude --settings x').state).toBe('unknown');
		});
	});

	describe('helpers', () => {
		it('isPasteMarker accepts Claude Code and Codex markers only', () => {
			expect(isPasteMarker('[Pasted text #3 +12 lines]')).toBe(true);
			expect(isPasteMarker('[Pasted text #2]')).toBe(true);
			expect(isPasteMarker('[Pasted Content 1234 chars]')).toBe(true);
			expect(isPasteMarker('go ahead [Pasted text #3 +12 lines]')).toBe(false);
			expect(isPasteMarker('按这个草稿回吧')).toBe(false);
		});

		it('TuiInputGuardError carries the stage and reading', () => {
			const err = new TuiInputGuardError('before-submit', { state: 'foreign', text: 'x', lineCount: 1 });
			expect(err).toBeInstanceOf(Error);
			expect(err.stage).toBe('before-submit');
			expect(err.message).toContain('refusing to press Enter');
		});
	});
});

describe('pasteShowsAs (a late-rendered paste of ours)', () => {
	const FIVE = 'a\nb\nc\nd\ne';
	it('matches the message itself and markers of its shape', () => {
		expect(pasteShowsAs('a b c d e', FIVE)).toBe(true);
		expect(pasteShowsAs('[Pasted text #4 +4 lines]', FIVE)).toBe(true);
		expect(pasteShowsAs('[Pasted text #2]', 'one long line')).toBe(true);
		expect(pasteShowsAs(`[Pasted Content ${FIVE.length} chars]`, FIVE)).toBe(true);
	});
	it('rejects other shapes, two pastes, and anything else', () => {
		expect(pasteShowsAs('[Pasted text #4 +5 lines]', FIVE)).toBe(false);
		expect(pasteShowsAs('[Pasted text #2]', FIVE)).toBe(false);
		expect(pasteShowsAs('[Pasted Content 999 chars]', FIVE)).toBe(false);
		expect(pasteShowsAs('[Pasted text #4 +4 lines][Pasted text #5 +4 lines]', FIVE)).toBe(false);
		expect(pasteShowsAs('按这个草稿回吧', FIVE)).toBe(false);
		expect(pasteShowsAs('', FIVE)).toBe(false);
	});
});

describe('screenShowsTurnInProgress (real Claude Code 2.1.288 captures, labelled top rule)', () => {
	const text = async (name: string) => (await cc(name)).lines.join('\n');
	it('a busy agent: the spinner line above the box, even with the bar hidden by a paste hint', async () => {
		expect(await text('busy-labelled-empty')).not.toMatch(/esc to interrupt/);
		expect(screenShowsTurnInProgress(await text('busy-labelled-empty'))).toBe(true);
		expect(screenShowsTurnInProgress(await text('busy-labelled-pasted-marker'))).toBe(true);
		expect(screenShowsTurnInProgress('  ⏵⏵ auto mode on · 1 shell · esc to interrupt')).toBe(true);
		// A Stop hook still running after the reply ("✽ Nucleating… (running Stop hook · 17s)").
		expect(screenShowsTurnInProgress(await text('after-turn-empty-box'))).toBe(true);
	});
	it('a resting agent: no spinner line, a finished turn line, or none at all', async () => {
		expect(screenShowsTurnInProgress(await text('labelled-rule-empty'))).toBe(false);
		expect(screenShowsTurnInProgress(await text('labelled-rule-pasted-marker'))).toBe(false);
		const done = ['✻ Worked for 17s · done 9:29 AM', '', '─'.repeat(60) + ' crewly-orc ─', '❯ ', '─'.repeat(80)].join('\n');
		expect(screenShowsTurnInProgress(done)).toBe(false);
		// An ellipsis in the transcript far above the box does not count.
		const old = ['✻ Ideating…', 'reply text', 'more', 'more', 'more', '', '─'.repeat(80), '❯ ', '─'.repeat(80)].join('\n');
		expect(screenShowsTurnInProgress(old)).toBe(false);
	});
});

describe('isInputBoxRule', () => {
	it('accepts bare and labelled rules, nothing else', () => {
		expect(isInputBoxRule('─'.repeat(80))).toBe(true);
		expect(isInputBoxRule(`${'─'.repeat(63)} crewly-marketing-ella-e6a6b8ea ─`)).toBe(true);
		expect(isInputBoxRule(`${'─'.repeat(84)} fixture-agent ─`)).toBe(true);
		expect(isInputBoxRule('─'.repeat(5))).toBe(false);
		expect(isInputBoxRule('─'.repeat(20), 30)).toBe(false);
		expect(isInputBoxRule(`${'─'.repeat(20)} two words here and more ─ x ─`)).toBe(false);
		expect(isInputBoxRule('❯ hello')).toBe(false);
	});
});

describe('readTurnSignals: only where the runtime paints them, never the transcript', () => {
	const R = '─'.repeat(80);
	const box = (above: string[], footer: string) => [...above, '', `${'─'.repeat(64)} crewly-ella ─`, '❯ ', R, footer].join('\n');
	it('an idle box under a transcript quoting "esc to interrupt" and "Word…" is not a turn', () => {
		for (const last of ['⏺ Understood…', '❯ Thanks…', '  ⎿  Waiting…', '⏺ Press esc to interrupt to stop it.', '✻ Worked for 17s · done']) {
			const screen = box(['⏺ The busy bar says esc to interrupt.', last], '  ⏵⏵ bypass permissions on (shift+tab to cycle)');
			expect([last, screenShowsTurnInProgress(screen)]).toEqual([last, false]);
		}
	});
	it('the busy bar in the footer, or the spinner directly above the box, is a turn', () => {
		expect(readTurnSignals(box(['⏺ ok'], '  ⏵⏵ bypass permissions on · esc to interrupt'))).toMatchObject({ box: true, busyBar: true, spinner: null });
		expect(readTurnSignals(box(['⏺ ok', '✳ Flambéing… (3s · ↓ 110 tokens)'], '  paste again to expand'))).toMatchObject({ busyBar: false, spinner: '✳ Flambéing… (3s · ↓ 110 tokens)' });
		expect(readTurnSignals(box(['✳ Flambéing…'], ''))).toMatchObject({ spinner: '✳ Flambéing…' });
	});
	it('a spinner-shaped line that is not the one directly above the box does not count', () => {
		expect(screenShowsTurnInProgress(box(['✳ Flambéing…', '⏺ done'], ''))).toBe(false);
	});
	it('without a box (Codex) only the bottom rows count', () => {
		const codex = ['• Working (4s • esc to interrupt)', '', '› ', '', '  ? for shortcuts'].join('\n');
		expect(screenShowsTurnInProgress(codex)).toBe(true);
		const old = ['• Working (4s • esc to interrupt)', ...Array.from({ length: 8 }, (_, i) => `reply line ${i}`), '› ', '  ? for shortcuts'].join('\n');
		expect(screenShowsTurnInProgress(old)).toBe(false);
	});
});

describe('boxHoldsOnlyOwnPastes (1.20.207 Ella: two pastes run together)', () => {
	const A = 'A1\nA2\nA3\nA4\nA5\nA6';
	const B = 'B1\nB2\nB3\nB4\nB5\nB6';
	it('markers and texts of our pastes, alone or run together, in order', () => {
		expect(boxHoldsOnlyOwnPastes('[Pasted text #2 +5 lines][Pasted text #3 +5 lines]', [A, B])).toEqual([A, B]);
		expect(boxHoldsOnlyOwnPastes('[Pasted text #4 +5 lines]', [A])).toEqual([A]);
		expect(boxHoldsOnlyOwnPastes('short one[Pasted text #3 +5 lines]', ['short one', B])).toEqual(['short one', B]);
		expect(boxHoldsOnlyOwnPastes('first msgsecond msg', ['first msg', 'second msg'])).toEqual(['first msg', 'second msg']);
		expect(boxHoldsOnlyOwnPastes('[Pasted text #3 +5 lines]', [A, B])).toEqual([A]);
	});
	it('a shown marker counts by its exact counter, even when no paste since matches', () => {
		expect(boxHoldsOnlyOwnPastes('[Pasted text #2 +5 lines]', [], [{ marker: '[Pasted text #2 +5 lines]', message: A }])).toEqual([A]);
		expect(boxHoldsOnlyOwnPastes('[Pasted text #5 +5 lines]', [], [{ marker: '[Pasted text #2 +5 lines]', message: A }])).toBeNull();
	});
	it('anything else in the box, too many markers, or a wrong shape is not ours', () => {
		expect(boxHoldsOnlyOwnPastes('[Pasted text #2 +5 lines][Pasted text #3 +5 lines]', [A])).toBeNull();
		expect(boxHoldsOnlyOwnPastes('[Pasted text #2 +5 lines] and a typed note', [A])).toBeNull();
		expect(boxHoldsOnlyOwnPastes('[Pasted text #2 +9 lines]', [A])).toBeNull();
		expect(boxHoldsOnlyOwnPastes('按这个草稿回吧', [A])).toBeNull();
		expect(boxHoldsOnlyOwnPastes('', [A])).toBeNull();
		// The shown marker's paste cannot also stand for a second marker.
		expect(boxHoldsOnlyOwnPastes('[Pasted text #2 +5 lines][Pasted text #3 +5 lines]', [A], [{ marker: '[Pasted text #2 +5 lines]', message: A }])).toBeNull();
	});
});

describe('attributeOwnPastes: an uncertain match is flagged', () => {
	const X = 'X1\nX2\nX3\nX4\nX5';
	const Y = 'Y1\nY2\nY3\nY4\nY5';
	it('one marker, two unseen pastes of different messages with its shape: ambiguous', () => {
		expect(attributeOwnPastes('[Pasted text #2 +4 lines]', [X, Y])).toEqual({ messages: [X], ambiguous: true });
	});
	it('certain when only one candidate has the shape, when both are the same message, or when the marker was seen', () => {
		expect(attributeOwnPastes('[Pasted text #2 +4 lines]', [X, 'one line'])).toEqual({ messages: [X], ambiguous: false });
		expect(attributeOwnPastes('[Pasted text #2 +4 lines]', [X, X])).toEqual({ messages: [X], ambiguous: false });
		expect(attributeOwnPastes('[Pasted text #2 +4 lines][Pasted text #3 +4 lines]', [X, Y])).toEqual({ messages: [X, Y], ambiguous: false });
		expect(attributeOwnPastes('[Pasted text #2 +4 lines]', [X, Y], [{ marker: '[Pasted text #2 +4 lines]', message: Y }])).toEqual({ messages: [Y], ambiguous: false });
		expect(attributeOwnPastes('X1 X2 X3 X4 X5', [X, Y])).toEqual({ messages: [X], ambiguous: false });
	});
});
