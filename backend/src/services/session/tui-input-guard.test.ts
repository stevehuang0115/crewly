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
			// …but leftover before we type.
			expect(classifyTuiInput(await cc('pasted-5-lines-marker'), TASK, 'before-write').state).toBe('foreign');
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

		it('Gemini box (not verified live): our text ours, faint hint empty', async () => {
			const top = '╭' + '─'.repeat(60) + '╮';
			const bottom = '╰' + '─'.repeat(60) + '╯';
			const ours = await render([top, '│ > hello gemini agent'.padEnd(61) + '│', bottom]);
			expect(classifyTuiInput(ours, 'hello gemini agent', 'after-paste')).toMatchObject({ state: 'ours', layout: 'gemini' });
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
