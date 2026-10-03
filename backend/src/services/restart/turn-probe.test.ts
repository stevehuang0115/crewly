/**
 * Tests for the PTY turn probe.
 */

import { createPtyTurnProbe, type ProbeSessionBackend } from './turn-probe.js';

const CLAUDE_BUSY = [
	'⏺ Reading the To Do list…',
	'',
	'✻ Thinking… (12s · ↓ 300 tokens · esc to interrupt)',
	'╭──────────────────────────╮',
	'│ >                        │',
	'╰──────────────────────────╯',
].join('\n');

const CLAUDE_IDLE = [
	'⏺ Done — three items left.',
	'',
	'╭──────────────────────────╮',
	'│ >                        │',
	'╰──────────────────────────╯',
	'  ? for shortcuts',
].join('\n');

/**
 * Build a fake backend.
 *
 * @param screen - What captureOutput returns
 * @param opts - exists / childAlive flags
 * @returns Fake backend
 */
function backend(screen: string, opts: { exists?: boolean; childAlive?: boolean } = {}): ProbeSessionBackend {
	return {
		sessionExists: () => opts.exists ?? true,
		captureOutput: () => screen,
		...(opts.childAlive === undefined ? {} : { isChildProcessAlive: () => opts.childAlive as boolean }),
	};
}

describe('createPtyTurnProbe', () => {
	it('reports gone when there is no backend or no session', () => {
		expect(createPtyTurnProbe({ getBackend: () => null, getIdleTimeMs: () => null })('s')).toBe('gone');
		expect(createPtyTurnProbe({ getBackend: () => backend('', { exists: false }), getIdleTimeMs: () => null })('s')).toBe('gone');
	});

	it('reports gone when the runtime process has exited', () => {
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_BUSY, { childAlive: false }), getIdleTimeMs: () => 60_000 })('s')).toBe('gone');
	});

	it('reports busy while the "esc to interrupt" status bar is on screen, even when output is quiet', () => {
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_BUSY), getIdleTimeMs: () => 60_000 })('s')).toBe('busy');
	});

	it('sees the status bar through ANSI colour codes (Codex style)', () => {
		const codex = '\u001b[2m• Working (1m 12s • \u001b[1mesc\u001b[22m to interrupt)\u001b[0m\n› ';
		expect(createPtyTurnProbe({ getBackend: () => backend(codex, { childAlive: true }), getIdleTimeMs: () => 60_000 })('s')).toBe('busy');
	});

	it('reports busy while output is recent even without a status bar', () => {
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_IDLE), getIdleTimeMs: () => 1_000, quietMs: 15_000 })('s')).toBe('busy');
	});

	it('reports idle when the bar is gone and the PTY has been quiet', () => {
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_IDLE), getIdleTimeMs: () => 20_000, quietMs: 15_000 })('s')).toBe('idle');
	});

	it('reports idle when no activity was ever recorded and no bar is shown', () => {
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_IDLE), getIdleTimeMs: () => null })('s')).toBe('idle');
	});

	it('silence during a long tool call is not idle: the runtime verdict overrides a quiet PTY (2026-10-02, Eve)', () => {
		const probe = createPtyTurnProbe({
			getBackend: () => backend(CLAUDE_IDLE),
			getIdleTimeMs: () => 120_000,
			quietMs: 15_000,
			getRuntimeVerdict: () => ({ state: 'turn', longRunning: true, since: 0, source: 'hooks' }),
		});
		expect(probe('eve')).toBe('busy');
	});

	it('background work after the turn ended is busy; an idle runtime verdict falls back to the screen', () => {
		const verdict = { state: 'background' as const, longRunning: true, since: 0, source: 'hooks' as const };
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_IDLE), getIdleTimeMs: () => 120_000, getRuntimeVerdict: () => verdict })('eve')).toBe('busy');
		const idle = { state: 'idle' as const, longRunning: false, since: null, source: 'hooks' as const };
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_IDLE), getIdleTimeMs: () => 120_000, getRuntimeVerdict: () => idle })('eve')).toBe('idle');
		expect(createPtyTurnProbe({ getBackend: () => backend(CLAUDE_BUSY), getIdleTimeMs: () => 120_000, getRuntimeVerdict: () => idle })('eve')).toBe('busy');
	});

	it('a delivery the runtime has not acknowledged yet is busy, for a bounded time', () => {
		const delivered = 1_000_000;
		const make = (now: number, lastHook: number | null) =>
			createPtyTurnProbe({
				getBackend: () => backend(CLAUDE_IDLE),
				getIdleTimeMs: () => 120_000,
				getLastHookEventAt: () => lastHook,
				now: () => now,
			});
		expect(make(delivered + 30_000, delivered - 5_000)('eve', { since: delivered })).toBe('busy');
		// The runtime has spoken since the delivery: the screen decides.
		expect(make(delivered + 30_000, delivered + 1_000)('eve', { since: delivered })).toBe('idle');
		// Never acknowledged within the window: not pinned busy forever.
		expect(make(delivered + 10 * 60_000, delivered - 5_000)('eve', { since: delivered })).toBe('idle');
		// A runtime without hooks: the screen decides.
		expect(make(delivered + 30_000, null)('eve', { since: delivered })).toBe('idle');
	});

	it('reads Gemini\'s "esc to cancel" footer only for Gemini sessions', () => {
		const gemini = '⠏ Searching the web (esc to cancel, 41s)\n> ';
		const base = { getBackend: () => backend(gemini), getIdleTimeMs: () => 120_000 };
		expect(createPtyTurnProbe({ ...base, getRuntimeType: () => 'gemini-cli' })('g')).toBe('busy');
		expect(createPtyTurnProbe({ ...base, getRuntimeType: () => 'claude-code' })('g')).toBe('idle');
	});

	it('ignores a status bar that has scrolled out of the inspected tail', () => {
		const scrolled = [CLAUDE_BUSY, ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n');
		expect(createPtyTurnProbe({ getBackend: () => backend(scrolled), getIdleTimeMs: () => 60_000, tailLines: 10 })('s')).toBe('idle');
	});
});
