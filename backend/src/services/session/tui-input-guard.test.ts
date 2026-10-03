/**
 * Tests for the TUI input guard.
 *
 * Frames are rendered through a real headless terminal (PtyTerminalBuffer)
 * so faint (SGR 2) ghost text is blanked exactly as in production.
 */

import { PtyTerminalBuffer } from './pty/pty-terminal-buffer.js';
import {
	classifyTuiInput,
	isPasteMarker,
	readTuiInputBox,
	TuiInputGuardError,
} from './tui-input-guard.js';

const DIM = '\x1b[2m';
const UNDIM = '\x1b[22m';
const INV = '\x1b[7m';
const UNINV = '\x1b[27m';
const RULE = '─'.repeat(70);

/**
 * Render a frame and return the faint-free capture.
 *
 * @param lines - Raw lines (may contain ANSI)
 * @returns Capture without faint text
 */
async function render(lines: string[]): Promise<{ solid: string; plain: string }> {
	const buffer = new PtyTerminalBuffer(80, 24);
	buffer.write(lines.join('\r\n'));
	await buffer.flush();
	const result = { solid: buffer.getContentWithoutFaint(40), plain: buffer.getContent(40) };
	buffer.dispose();
	return result;
}

/** Claude Code frame: a reply above the input box, then the box and footer. */
function claudeFrame(inputLine: string): string[] {
	return [
		'⏺ 要不要按这个草稿回，还是你想换个说法？',
		'',
		RULE,
		`❯ ${inputLine}`,
		RULE,
		'  ⏵⏵ bypass permissions on (shift+tab to cycle)',
	];
}

describe('tui-input-guard', () => {
	describe('captured frames — Claude Code prompt suggestion', () => {
		it('reads an empty box when the only text is a faint prompt suggestion (2026-10-03 incident)', async () => {
			// Claude Code paints the fake cursor (inverse) on the first character
			// of the suggestion and the rest faint.
			const frame = claudeFrame(`${INV}按${UNINV}${DIM}这个草稿回吧${UNDIM}`);
			const { solid, plain } = await render(frame);

			// In plain text the suggestion looks exactly like typed input...
			expect(readTuiInputBox(plain).text).toBe('按这个草稿回吧');
			// ...the faint-free capture shows the box is empty.
			expect(readTuiInputBox(solid)).toEqual({ found: true, text: '' });
			expect(classifyTuiInput(solid, '[CHAT:abc] owner reminder').state).toBe('empty');
		});

		it('reads a fully faint suggestion (no fake cursor) as empty', async () => {
			const { solid } = await render(claudeFrame(`${DIM}Reply with the draft${UNDIM}`));
			expect(classifyTuiInput(solid, 'anything').state).toBe('empty');
		});

		it('reads an accepted suggestion (solid text) as foreign — never ours', async () => {
			const { solid } = await render(claudeFrame('按这个草稿回吧'));
			expect(classifyTuiInput(solid, '[CHAT:abc] owner reminder')).toEqual({
				state: 'foreign',
				text: '按这个草稿回吧',
			});
		});

		it('reads an accepted suggestion with our message pasted after it as foreign', async () => {
			const message = '[CHAT:abc] reminder: reply to the owner';
			const { solid } = await render(claudeFrame(`按这个草稿回吧${message}`));
			expect(classifyTuiInput(solid, message).state).toBe('foreign');
		});

		it('reads exactly our message as ours', async () => {
			const message = '[CHAT:abc] reminder: reply to the owner';
			const { solid } = await render(claudeFrame(message));
			expect(classifyTuiInput(solid, message).state).toBe('ours');
		});

		it('reads a lone collapsed paste marker as ours', async () => {
			const { solid } = await render(claudeFrame('[Pasted text #1 +42 lines]'));
			expect(classifyTuiInput(solid, 'line1\nline2').state).toBe('ours');
		});

		it('reads a paste marker with a prefix as foreign', async () => {
			const { solid } = await render(claudeFrame('按这个草稿回吧[Pasted text #1 +42 lines]'));
			expect(classifyTuiInput(solid, 'line1\nline2').state).toBe('foreign');
		});

		it('joins a wrapped message across lines (wrap may split words)', async () => {
			const message = 'Please review the draft reply for Rugwed and tell me if it reads well';
			const frame = [
				RULE,
				'❯ Please review the draft reply for Rugwed and tell me if it re',
				'  ads well',
				RULE,
			];
			const { solid } = await render(frame);
			expect(classifyTuiInput(solid, message).state).toBe('ours');
		});

		it('ignores the footer and history above the box', async () => {
			const frame = [
				'> [CHAT:old] an earlier delivered message',
				'⏺ done',
				RULE,
				'❯ ',
				RULE,
				'  ? for shortcuts',
			];
			const { solid } = await render(frame);
			expect(classifyTuiInput(solid, '[CHAT:old] an earlier delivered message').state).toBe('empty');
		});
	});

	describe('captured frames — other runtimes', () => {
		it('Codex: faint rotating placeholder reads as empty', async () => {
			const frame = ['', `› ${DIM}Explain this codebase${UNDIM}`, '', '  ⏎ send   ⌃J newline'];
			const { solid } = await render(frame);
			expect(classifyTuiInput(solid, 'hello').state).toBe('empty');
		});

		it('Gemini: boxed prompt with our text reads as ours, faint hint as empty', async () => {
			const top = '╭' + '─'.repeat(60) + '╮';
			const bottom = '╰' + '─'.repeat(60) + '╯';
			const ours = await render([top, '│ > hello gemini agent'.padEnd(61) + '│', bottom]);
			expect(classifyTuiInput(ours.solid, 'hello gemini agent').state).toBe('ours');
			const hint = await render([top, `│ > ${DIM}Type your message or @path/to/file${UNDIM}`.padEnd(70) + '│', bottom]);
			expect(classifyTuiInput(hint.solid, 'x').state).toBe('empty');
		});

		it('a plain shell screen has no input box (unknown)', async () => {
			const { solid } = await render(['Last login: today', 'user@host ~ % ']);
			expect(classifyTuiInput(solid, 'claude --settings x').state).toBe('unknown');
		});
	});

	describe('helpers', () => {
		it('isPasteMarker accepts Claude Code and Codex markers only', () => {
			expect(isPasteMarker('[Pasted text #3 +12 lines]')).toBe(true);
			expect(isPasteMarker('[Pasted Content 1234 chars]')).toBe(true);
			expect(isPasteMarker('go ahead [Pasted text #3 +12 lines]')).toBe(false);
			expect(isPasteMarker('按这个草稿回吧')).toBe(false);
		});

		it('a visible window of a long message counts as ours, other text does not', () => {
			const message = 'A'.repeat(10) + ' the quick brown fox jumps over the lazy dog ' + 'B'.repeat(10);
			const screen = `${RULE}\n❯ the quick brown fox jumps over the lazy\n${RULE}`;
			expect(classifyTuiInput(screen, message).state).toBe('ours');
			expect(classifyTuiInput(`${RULE}\n❯ the quick brown cat\n${RULE}`, message).state).toBe('foreign');
		});

		it('TuiInputGuardError carries the stage and reading', () => {
			const err = new TuiInputGuardError('before-submit', { state: 'foreign', text: 'x' });
			expect(err).toBeInstanceOf(Error);
			expect(err.stage).toBe('before-submit');
			expect(err.reading.state).toBe('foreign');
			expect(err.message).toContain('refusing to press Enter');
		});
	});
});
