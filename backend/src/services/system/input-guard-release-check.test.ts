/**
 * Tests for the release input-guard check (no live PTY, no Claude).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyViews } from '../../scripts/input-guard-classify.js';
import { INPUT_GUARD_CHECK_CONSTANTS } from '../../constants.js';
import {
	collectLiveViews,
	composeBlockNotice,
	describeBlock,
	formatReportLines,
	markBlockNotified,
	resolveClassifierScript,
	runInputGuardCheck,
	spawnClassifier,
	type ClassifierRunner,
} from './input-guard-release-check.js';

const OK_VIEW = { lines: ['─'.repeat(30), '❯ ', '─'.repeat(30)], cursorRow: 1 };
const SHELL_VIEW = { lines: ['$ ls', '$ '], cursorRow: 1 };

/** A runner that classifies in-process (stands in for the child). */
const inProcess: ClassifierRunner = async (_script, stdin) =>
	JSON.stringify({ results: classifyViews((JSON.parse(stdin) as { sessions: never[] }).sessions) });

describe('input-guard-release-check', () => {
	let dir: string;
	beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-check-')); });
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const makeBuild = (): string => {
		const script = path.join(dir, 'dist', INPUT_GUARD_CHECK_CONSTANTS.SCRIPT_RELATIVE);
		fs.mkdirSync(path.dirname(script), { recursive: true });
		fs.writeFileSync(script, '// stub');
		return dir;
	};

	it('finds the script from a package root, dist dir or dist/backend dir', () => {
		makeBuild();
		const script = path.join(dir, 'dist', INPUT_GUARD_CHECK_CONSTANTS.SCRIPT_RELATIVE);
		expect(resolveClassifierScript(dir)).toBe(script);
		expect(resolveClassifierScript(path.join(dir, 'dist'))).toBe(script);
		expect(resolveClassifierScript(path.join(dir, 'dist', 'backend'))).toBe(script);
		expect(resolveClassifierScript(path.join(dir, 'nope'))).toBeNull();
	});

	it('collects the styled view of each session with its runtime', () => {
		const views = collectLiveViews(
			{ listSessions: () => ['a', 'b', 'c'], captureInputView: (n) => (n === 'b' ? null : n === 'c' ? (() => { throw new Error('x'); })() : OK_VIEW) },
			(n) => (n === 'a' ? 'claude-code' : undefined),
		);
		expect(views).toEqual([{ session: 'a', runtime: 'claude-code', view: OK_VIEW }]);
		expect(collectLiveViews({ listSessions: () => ['a'] }, () => undefined)).toEqual([]);
	});

	it('passes when every idle agent has a readable box', async () => {
		const report = await runInputGuardCheck({ build: makeBuild(), views: [{ session: 'a', runtime: 'claude-code', view: OK_VIEW }], run: inProcess });
		expect(report.ok).toBe(true);
		expect(report.agents[0]).toMatchObject({ session: 'a', verdict: 'ok' });
	});

	it('fails when an idle agent reads as unknown, and names it', async () => {
		const report = await runInputGuardCheck({
			build: makeBuild(),
			views: [{ session: 'a', runtime: 'claude-code', view: OK_VIEW }, { session: 'orc', runtime: 'claude-code', view: SHELL_VIEW }],
			run: inProcess,
		});
		expect(report.ok).toBe(false);
		expect(describeBlock(report, '1.2.3')).toContain('cannot read 1 idle agent (orc)');
		expect(formatReportLines(report).join('\n')).toMatch(/FAIL\s+orc/);
		expect(composeBlockNotice(report, '1.2.3').title).toBe('Crewly 1.2.3 was not restarted');
	});

	it('is "unavailable" and not blocking when the build has no script', async () => {
		const report = await runInputGuardCheck({ build: dir, views: [], run: inProcess });
		expect(report).toMatchObject({ ok: true, unavailable: true });
	});

	it('fails when the new build\'s script crashes', async () => {
		const report = await runInputGuardCheck({ build: makeBuild(), views: [], run: async () => { throw new Error('boom'); } });
		expect(report.ok).toBe(false);
		expect(report.error).toContain('boom');
		expect(describeBlock(report)).toContain('could not be run');
	});

	it('spawnClassifier runs a script in a fresh node process', async () => {
		const script = path.join(dir, 'echo.js');
		fs.writeFileSync(script, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(d));");
		await expect(spawnClassifier(script, '{"a":1}')).resolves.toBe('{"a":1}');
		const bad = path.join(dir, 'bad.js');
		fs.writeFileSync(bad, 'process.exit(2)');
		await expect(spawnClassifier(bad, '{}')).rejects.toThrow(/exited 2/);
	});

	it('notifies once per version', () => {
		expect(markBlockNotified(dir, '1.2.3')).toBe(true);
		expect(markBlockNotified(dir, '1.2.3')).toBe(false);
		expect(markBlockNotified(dir, '1.2.4')).toBe(true);
	});
});
