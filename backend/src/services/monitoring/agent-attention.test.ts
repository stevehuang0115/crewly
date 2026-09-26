/**
 * Tests for the waiting_on_human attention verdict (#815).
 *
 * The fixture half runs every captured real screen in
 * `__fixtures__/agent-screens/manifest.json` through the verdict, both with
 * the OSC title it was captured with and with no title at all (the screen
 * alone must be enough). It prints how many fixtures it examined and fails on
 * an empty set.
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import {
	bottomRegion,
	classifyTitle,
	computeAgentAttention,
	detectPromptOnScreen,
} from './agent-attention.js';
import { PLAN_MODE_PATTERNS } from '../continuation/patterns/waiting-patterns.js';

interface FixtureEntry {
	file: string;
	runtime: string;
	title: string;
	expected: 'waiting_on_human' | 'busy' | 'idle';
	kind?: string;
}

const FIXTURE_DIR = path.join(__dirname, '__fixtures__', 'agent-screens');
const manifest = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
	fixtures: FixtureEntry[];
};
const fixtures = manifest.fixtures.map((f) => ({
	...f,
	screen: readFileSync(path.join(FIXTURE_DIR, f.file), 'utf8'),
}));

describe('agent attention: captured screen fixtures', () => {
	let examined = 0;

	afterAll(() => {
		// Guard norm: say what was examined, and refuse an empty set.
		process.stdout.write(`[agent-attention] ${examined} fixture(s) examined\n`);
	});

	it('has fixtures to examine, both blocked and non-blocked', () => {
		expect(fixtures.length).toBeGreaterThan(0);
		expect(fixtures.some((f) => f.expected === 'waiting_on_human')).toBe(true);
		expect(fixtures.some((f) => f.expected === 'busy')).toBe(true);
		expect(fixtures.some((f) => f.expected === 'idle')).toBe(true);
	});

	it.each(fixtures)('$file (screen + title) -> $expected', (f) => {
		examined += 1;
		const r = computeAgentAttention({ screen: f.screen, title: f.title });
		expect(r.linesExamined).toBeGreaterThan(0);
		expect(r.verdict).toBe(f.expected);
		if (f.kind) {
			expect(r.kind).toBe(f.kind);
		}
	});

	it.each(fixtures)('$file (screen alone) -> $expected', (f) => {
		const r = computeAgentAttention({ screen: f.screen });
		expect(r.verdict).toBe(f.expected);
		if (f.kind) {
			expect(r.kind).toBe(f.kind);
		}
	});

	it('no fixture contains an unscrubbed path, user or host name', () => {
		for (const f of fixtures) {
			expect(f.screen).not.toMatch(/\/Users\/|\/private\/tmp|scratchpad|\.lan\b/);
		}
	});
});

describe('plan-mode dismiss patterns (PLAN_MODE_PATTERNS)', () => {
	const byFile = (name: string): string => {
		const f = fixtures.find((x) => x.file === name);
		if (!f) throw new Error(`fixture ${name} missing`);
		return f.screen;
	};
	const matches = (text: string): boolean => PLAN_MODE_PATTERNS.some((p) => p.test(text.slice(-500)));

	it('does NOT match an idle Claude screen whose footer says "shift+tab to cycle"', () => {
		const idle = byFile('claude-idle.txt');
		expect(idle).toMatch(/shift\+tab to cycle/);
		expect(matches(idle)).toBe(false);
	});

	it('does NOT match a busy Claude screen', () => {
		expect(matches(byFile('claude-busy.txt'))).toBe(false);
	});

	it('matches the real plan-approval menu', () => {
		expect(matches(byFile('claude-plan-menu.txt'))).toBe(true);
	});
});

describe('computeAgentAttention rules', () => {
	it('ignores a dialog that has scrolled out of the bottom region', () => {
		const oldDialog = [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend'];
		const later = Array.from({ length: 30 }, (_, i) => `⏺ line ${i} of later work`);
		const screen = [...oldDialog, ...later, '❯ ', '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\n');
		expect(computeAgentAttention({ screen }).verdict).toBe('idle');
	});

	it('does not treat prose that asks a question as a dialog', () => {
		const screen = [
			'❯ refactor the parser',
			'⏺ I can split it into two modules. Do you want to proceed?',
			'────────',
			'❯ ',
			'  ⏵⏵ auto mode on (shift+tab to cycle)',
		].join('\n');
		expect(computeAgentAttention({ screen }).verdict).toBe('idle');
	});

	it('a Codex "Action Required" title alone yields waiting_on_human (unspecified)', () => {
		const r = computeAgentAttention({ screen: '› Ask Codex to do anything', title: '[ ! ] Action Required | ⠸ | repo' });
		expect(r.verdict).toBe('waiting_on_human');
		expect(r.kind).toBe('unspecified');
		expect(r.evidence).toContain('title:waiting');
	});

	it('a spinner title alone yields busy', () => {
		expect(computeAgentAttention({ screen: '› Ask Codex', title: '⠋ Build | repo' }).verdict).toBe('busy');
	});

	it('a Claude ✳ title does not vote', () => {
		expect(computeAgentAttention({ screen: '❯ ', title: '✳ Doing things' }).verdict).toBe('idle');
	});

	it('a dialog on screen wins over a busy title', () => {
		const screen = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel';
		expect(computeAgentAttention({ screen, title: '⠋ x' }).verdict).toBe('waiting_on_human');
	});

	it('reports 0 lines examined for an empty screen and never waiting', () => {
		const r = computeAgentAttention({ screen: '\n\n' });
		expect(r.linesExamined).toBe(0);
		expect(r.verdict).toBe('idle');
	});

	it('strips ANSI before matching', () => {
		const screen = '\x1b[1m Do you want to proceed?\x1b[0m\n \x1b[36m❯ 1. Yes\x1b[0m\n Esc to cancel';
		expect(detectPromptOnScreen(screen).kind).toBe('permission');
	});
});

describe('classifyTitle', () => {
	it.each([
		['[ ! ] Action Required | ⠸ | repo', 'waiting', 'repo'],
		['⠧ Create file | repo', 'busy', 'Create file | repo'],
		['✳ Fix login', 'none', 'Fix login'],
		['', 'none', ''],
	])('%s -> %s', (title, signal, label) => {
		expect(classifyTitle(title)).toEqual({ signal, label });
	});

	it('handles null and undefined', () => {
		expect(classifyTitle(null).signal).toBe('none');
		expect(classifyTitle(undefined).signal).toBe('none');
	});
});

describe('bottomRegion', () => {
	it('keeps at most the last 20 non-empty lines', () => {
		const screen = Array.from({ length: 50 }, (_, i) => `l${i}`).join('\n\n');
		const r = bottomRegion(screen);
		expect(r.lines).toBe(20);
		expect(r.text.startsWith('l30')).toBe(true);
	});
});
