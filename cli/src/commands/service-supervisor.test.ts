/**
 * Runs the generated macOS supervisor script (`crewly-start.command`) for real
 * against a fake node, to check the shutdown marker: the loop stays down after
 * a dashboard shutdown, a plain exit is still relaunched, and a marker left by
 * an earlier shutdown is cleared by a fresh launch.
 */

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy(
		{},
		{
			get: () => {
				const fn = (s: string) => s;
				return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
			},
		},
	),
}));

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateCommandFile } from './service.js';

const IS_POSIX = process.platform !== 'win32';
const maybe = IS_POSIX ? describe : describe.skip;

maybe('crewly-start.command shutdown marker', () => {
	let tmp: string;
	let home: string;
	let root: string;
	let script: string;
	let fakeNode: string;
	let marker: string;
	let calls: string;

	/** Write the fake node: body runs for `start`, `--version` answers. */
	function writeFakeNode(body: string): void {
		fs.writeFileSync(fakeNode, `#!/bin/bash\nif [ "$1" = "--version" ]; then echo v0.0.0; exit 0; fi\necho run >> "${calls}"\n${body}\n`, { mode: 0o755 });
	}

	function runScript(): { status: number | null; log: string } {
		const r = spawnSync('bash', [script], {
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CREWLY_WEB_PORT: '59123' },
			encoding: 'utf-8',
			timeout: 30_000,
		});
		const logFile = path.join(home, '.crewly', 'logs', 'service.log');
		return { status: r.status, log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '' };
	}

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-supervisor-test-'));
		home = path.join(tmp, 'home');
		root = path.join(tmp, 'root');
		fs.mkdirSync(path.join(home, '.crewly', 'run'), { recursive: true });
		fs.mkdirSync(root, { recursive: true });
		fakeNode = path.join(tmp, 'fake-node');
		marker = path.join(home, '.crewly', 'run', 'shutdown-requested');
		calls = path.join(tmp, 'calls');
		script = path.join(tmp, 'crewly-start.command');
		fs.writeFileSync(script, generateCommandFile(root, { nodeBin: fakeNode, npmGlobalBin: null, path: process.env.PATH ?? '' }), { mode: 0o755 });
	});

	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it('checks the marker before relaunching (script text)', () => {
		const text = fs.readFileSync(script, 'utf-8');
		expect(text).toContain('SHUTDOWN_MARKER="$HOME/.crewly/run/shutdown-requested"');
		expect(text.indexOf('if [ -f "$SHUTDOWN_MARKER" ]')).toBeLessThan(text.indexOf('restarting in 5s'));
	});

	it('stays down after the backend exits with the marker present (and does not relaunch)', () => {
		writeFakeNode(`touch "${marker}"\nexit 0`);
		const { status, log } = runScript();
		expect(status).toBe(0);
		expect(fs.readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
		expect(log).toContain('after a shutdown request — not restarting');
		expect(log).not.toContain('restarting in 5s');
	});

	it('clears a marker left by an earlier shutdown on a fresh launch, then honours a new one', () => {
		fs.writeFileSync(marker, '{}');
		writeFakeNode(`if [ -f "${marker}" ]; then echo stale >> "${calls}"; fi\ntouch "${marker}"\nexit 0`);
		const { status } = runScript();
		expect(status).toBe(0);
		expect(fs.readFileSync(calls, 'utf-8')).not.toContain('stale');
	});

	it('still relaunches after a normal exit or restart (no marker)', () => {
		// First run exits 120 (restart); the second run shuts down.
		writeFakeNode(`n=$(grep -c run "${calls}")\nif [ "$n" -ge 2 ]; then touch "${marker}"; exit 0; fi\nexit 120`);
		const { status, log } = runScript();
		expect(status).toBe(0);
		expect(fs.readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
		expect(log).toContain('exited with code 120, restarting in 5s');
	}, 40_000);
});
