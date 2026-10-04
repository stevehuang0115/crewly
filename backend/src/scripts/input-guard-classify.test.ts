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

	const one = (lines: string[]) => classifyViews([{ session: 's', runtime: 'x', view: { lines, cursorRow: -1 } }])[0];

	it('fails only when a READY footer is on screen and no box parses', () => {
		expect(one(['some output', '  ⏵⏵ auto mode on (shift+tab to cycle)'])).toMatchObject({ state: 'unknown', verdict: 'fail', idle: true });
		expect(one(['Hello, you.', '  ← for agents · ? for shortcuts'])).toMatchObject({ verdict: 'fail' });
		expect(one(['x', ' >   Type your message or @path/to/file'])).toMatchObject({ verdict: 'fail' });
	});

	it.each([
		['folder-trust dialog', ['Do you trust the files in this folder?', ' 1. Yes, proceed', ' Enter to confirm · Esc to cancel']],
		['Claude login / OAuth', ['Browser didn\'t open? Use the url below to sign in', 'Paste code here if prompted >']],
		['Codex login (device code)', ['Sign in with ChatGPT', 'Open auth.openai.com/codex/device and enter the code']],
		['Gemini login', ['Waiting for auth... (Press ESC to cancel)']],
		['agy trust screen', ['Do you trust the contents of this project?', '1. Yes']],
		['agy sign-in screen', ['You are currently not signed in', 'Select login method']],
		['/resume picker', ['Resume a conversation', '> 1. fix lint', '  2. add tests']],
		['model picker', ['Select model', ' 1. Default', ' 2. Opus']],
		['permission dialog', ['Allow Codex to run this command?', ' Permission needed']],
	])('%s warns with a reason instead of failing', (_name, lines) => {
		const r = one(lines);
		expect(r.verdict).toBe('warn');
		expect(r.reason).toMatch(/no input box/);
	});

	it('a startup banner or a dead shell prompt warns', () => {
		expect(one(['Claude Code v2.1.288', 'Starting up…'])).toMatchObject({ verdict: 'warn' });
		const shell = one(['$ ls', 'file-a  file-b', '$ ']);
		expect(shell.verdict).toBe('warn');
		expect(shell.reason).toContain('no ready footer');
	});

	it('a ready footer still wins over "permission" in Claude\'s bypass-permissions footer', () => {
		expect(one(['x', '  ⏵⏵ bypass permissions on (shift+tab to cycle)']).verdict).toBe('fail');
	});

	it('a session with no styled capture is skipped', () => {
		expect(classifyViews([{ session: 'a', runtime: 'claude-code', view: null }])[0]).toMatchObject({ verdict: 'skip' });
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
