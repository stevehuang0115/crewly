/**
 * Tests for the input-guard classify script, on the recorded TUI fixtures
 * (replayed into a PtyTerminalBuffer, so faint styling is kept exactly as the
 * live backend's buffer keeps it).
 */

import * as fs from 'fs';
import * as path from 'path';
import { PtyTerminalBuffer } from '../services/session/pty/pty-terminal-buffer.js';
import type { TuiInputView } from '../services/session/tui-input-guard.js';
import { classifyViews } from './input-guard-classify.js';

const FIXTURES = path.join(__dirname, '..', 'services', 'session', '__fixtures__', 'tui');

async function frame(runtime: string, name: string): Promise<TuiInputView> {
	const buffer = new PtyTerminalBuffer(100, 30);
	buffer.write(fs.readFileSync(path.join(FIXTURES, runtime, `${name}.ansi`), 'utf8'));
	await buffer.flush();
	const view = buffer.getInputView();
	buffer.dispose();
	return view;
}

async function classify(runtime: string, fixtureDir: string, name: string) {
	const [result] = classifyViews([{ session: `s-${name}`, runtime, view: await frame(fixtureDir, name) }]);
	return result;
}

describe('classifyViews', () => {
	it('the labelled top rule (`──── crewly-orc ─`, the 1.20.198 incident) reads as an empty box', async () => {
		const r = await classify('claude-code', 'claude-code-2.1.288', 'labelled-rule-empty');
		expect(r).toMatchObject({ state: 'empty', layout: 'claude-code', verdict: 'ok', idle: true });
	});

	it('a grey placeholder is empty because the real buffer keeps the faint styling', async () => {
		expect((await classify('claude-code', 'claude-code-2.1.288', 'empty-placeholder')).verdict).toBe('ok');
		expect((await classify('codex', 'codex-0.160.0', 'empty-placeholder')).verdict).toBe('ok');
		expect((await classify('gemini', 'gemini-0.40.1', 'empty-placeholder')).verdict).toBe('ok');
	});

	it('a busy labelled box is found and not idle', async () => {
		const r = await classify('claude-code', 'claude-code-2.1.288', 'busy-labelled-empty');
		expect(r.state).not.toBe('unknown');
		expect(r.verdict).toBe('ok');
	});

	it('a lone paste marker in a labelled box is a box the guard can read', async () => {
		const r = await classify('claude-code', 'claude-code-2.1.288', 'labelled-rule-pasted-marker');
		expect(r.state).not.toBe('unknown');
	});

	it('an idle box holding typed text warns, and does not print the text', async () => {
		const r = await classify('claude-code', 'claude-code-2.1.288', 'typed-single');
		expect(r).toMatchObject({ state: 'foreign', verdict: 'warn', idle: true });
		expect(r.reason).not.toContain('hello world probe');
	});

	it('an idle screen with no input box of a known layout fails', () => {
		const view = { lines: ['$ ls', 'file-a  file-b', '$ '], cursorRow: 2 };
		const [r] = classifyViews([{ session: 'shell', runtime: 'claude-code', view }]);
		expect(r).toMatchObject({ state: 'unknown', verdict: 'fail', idle: true });
	});

	it('a blank screen is skipped, not failed', () => {
		const [r] = classifyViews([{ session: 'new', runtime: 'codex', view: { lines: ['', ''], cursorRow: 0 } }]);
		expect(r.verdict).toBe('skip');
	});

	it('mid-turn with no box only warns', () => {
		const view = { lines: ['working on it', 'esc to interrupt'], cursorRow: -1 };
		const [r] = classifyViews([{ session: 'busy', runtime: 'codex', view }]);
		expect(r).toMatchObject({ state: 'unknown', idle: false, verdict: 'warn' });
	});
});
