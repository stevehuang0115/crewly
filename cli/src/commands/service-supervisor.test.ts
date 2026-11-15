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

	function runScript(extraEnv: Record<string, string> = {}): { status: number | null; log: string } {
		const r = spawnSync('bash', [script], {
			env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CREWLY_WEB_PORT: '59123', ...extraEnv },
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
		writeScript();
	});

	/**
	 * Generate the supervisor script. The script exports its own PATH (captured
	 * at install time), so stubbed helpers must be put on that PATH here.
	 *
	 * @param pathPrefix - Directory to put first on the script's PATH
	 */
	function writeScript(pathPrefix?: string): void {
		const scriptPath = [pathPrefix, process.env.PATH ?? ''].filter(Boolean).join(':');
		fs.writeFileSync(script, generateCommandFile(root, { nodeBin: fakeNode, npmGlobalBin: null, path: scriptPath }), { mode: 0o755 });
	}

	afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

	it('checks the marker before relaunching (script text)', () => {
		const text = fs.readFileSync(script, 'utf-8');
		expect(text).toContain('SHUTDOWN_MARKER="$HOME/.crewly/run/shutdown-requested"');
		expect(text.indexOf('if [ -f "$SHUTDOWN_MARKER" ]')).toBeLessThan(text.indexOf('restarting in ${RESTART_DELAY}s'));
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

	describe('nothing inside the restart loop ends the supervisor (incident 2026-11-13: down for 5 hours)', () => {
		/** Fast backoff so a test covers several relaunches in a few seconds. */
		const FAST = { CREWLY_SUPERVISOR_RESTART_MIN_S: '1', CREWLY_SUPERVISOR_RESTART_MAX_S: '2' };
		/** Fake node: fail `failures` times with `code`, then request shutdown. */
		const failThenStop = (failures: number, code: number): string =>
			`n=$(grep -c run "${calls}")\nif [ "$n" -gt ${failures} ]; then touch "${marker}"; exit 0; fi\nexit ${code}`;
		const runs = (): number => fs.readFileSync(calls, 'utf-8').trim().split('\n').length;

		it('leaves errexit/pipefail/nounset off before the loop and guards the loop body (script text)', () => {
			const text = fs.readFileSync(script, 'utf-8');
			const loopStart = text.indexOf('while true; do');
			expect(text.indexOf('set +e +u +o pipefail')).toBeGreaterThan(-1);
			expect(text.indexOf('set +e +u +o pipefail')).toBeLessThan(loopStart);
			const loop = text.slice(loopStart);
			// The only exits left in the loop are the two deliberate ones.
			expect(loop.match(/^\s*exit \d+$/gm)).toEqual(['    exit 0', '    exit 0']);
			expect(loop).toContain('Port $WEB_PORT already in use');
			expect(loop).toContain('after a shutdown request — not restarting');
			// bash 3.2: no associative arrays, no arrays at all.
			expect(text).not.toMatch(/declare -A|\[@\]/);
		});

		it('parses under bash', () => {
			expect(spawnSync('bash', ['-n', script]).status).toBe(0);
		});

		it('keeps relaunching after repeated failed starts and backs off: 1 s, 2 s, then capped at 2 s', () => {
			writeFakeNode(failThenStop(3, 1));
			const { status, log } = runScript(FAST);
			expect(status).toBe(0);
			expect(runs()).toBe(4);
			const waits = [...log.matchAll(/exited with code 1, restarting in (\d+)s/g)].map((m) => m[1]);
			expect(waits).toEqual(['1', '2', '2']);
			expect(log).toContain('after a shutdown request — not restarting');
		}, 40_000);

		it('resets the wait after a run that stayed up long enough', () => {
			// Every run counts as "stable" (threshold 0 s), so the wait never grows.
			writeFakeNode(failThenStop(3, 1));
			const { log } = runScript({ ...FAST, CREWLY_SUPERVISOR_STABLE_RUN_S: '0' });
			const waits = [...log.matchAll(/restarting in (\d+)s/g)].map((m) => m[1]);
			expect(waits).toEqual(['1', '1', '1']);
		}, 40_000);

		it('survives helpers that fail inside the loop: `file`, `tee`, `date` and the node arch probe all broken', () => {
			// A from-source node-pty build makes the loop run the arch check.
			fs.mkdirSync(path.join(root, 'node_modules', 'node-pty', 'build', 'Release'), { recursive: true });
			fs.writeFileSync(path.join(root, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node'), 'x');
			// Fake node: the arch probe (`-p`) fails like a process that cannot start.
			fs.writeFileSync(
				fakeNode,
				`#!/bin/bash\nif [ "$1" = "--version" ]; then echo v0.0.0; exit 0; fi\nif [ "$1" = "-p" ]; then exit 23; fi\necho run >> "${calls}"\n${failThenStop(2, 1)}\n`,
				{ mode: 0o755 },
			);
			// Broken helpers first on PATH. They work during setup (flag absent)
			// and fail once the first run has started, i.e. inside the loop.
			const stubs = path.join(tmp, 'stubs');
			fs.mkdirSync(stubs);
			for (const name of ['file', 'tee', 'date']) {
				const real = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf-8' }).stdout.trim();
				fs.writeFileSync(
					path.join(stubs, name),
					`#!/bin/bash\nif [ -f "${calls}" ]; then echo ${name} >> "${path.join(stubs, 'used')}"; exit 24; fi\nexec "${real}" "$@"\n`,
					{ mode: 0o755 },
				);
			}
			fs.writeFileSync(path.join(stubs, 'used'), '');
			writeScript(stubs);
			const { status } = runScript(FAST);
			// The supervisor outlived every failure and ended only on the shutdown request.
			expect(status).toBe(0);
			expect(runs()).toBe(3);
			// The broken helpers really were the ones the loop called.
			expect(fs.readFileSync(path.join(stubs, 'used'), 'utf-8')).toMatch(/file[\s\S]*tee|tee[\s\S]*file/);
			expect(fs.readFileSync(path.join(stubs, 'used'), 'utf-8')).toContain('date');
		}, 40_000);

		it('survives an unwritable pid file', () => {
			// The pid file path becomes a directory once the first run starts: writing it fails.
			const pidfile = path.join(home, '.crewly', 'crewly.pid');
			fs.writeFileSync(
				fakeNode,
				`#!/bin/bash\nif [ "$1" = "--version" ]; then echo v0.0.0; exit 0; fi\necho run >> "${calls}"\nrm -f "${pidfile}"; mkdir -p "${pidfile}"\n${failThenStop(2, 7)}\n`,
				{ mode: 0o755 },
			);
			const { status, log } = runScript(FAST);
			expect(status).toBe(0);
			expect(runs()).toBe(3);
			expect(log).toContain(`Could not write ${pidfile}`);
			expect(log).toContain('exited with code 7, restarting in 1s');
		}, 40_000);

		it('retries when the install directory is missing, and starts once it is back', () => {
			fs.rmSync(root, { recursive: true, force: true });
			writeFakeNode(`touch "${marker}"\nexit 0`);
			// Restore the directory from a background shell after the first failed cd.
			const restorer = spawnSync('bash', ['-c', `( sleep 2; mkdir -p "${root}" ) >/dev/null 2>&1 &`]);
			expect(restorer.status).toBe(0);
			const { status, log } = runScript(FAST);
			expect(status).toBe(0);
			expect(log).toContain(`Cannot cd to ${root}, retrying in 1s`);
			expect(runs()).toBe(1);
		}, 40_000);

		it('still exits when the port is already in use (duplicate guard kept)', () => {
			const stubs = path.join(tmp, 'stubs');
			fs.mkdirSync(stubs);
			fs.writeFileSync(path.join(stubs, 'lsof'), '#!/bin/bash\necho 4242\nexit 0\n', { mode: 0o755 });
			writeFakeNode('exit 1');
			writeScript(stubs);
			const { status, log } = runScript(FAST);
			expect(status).toBe(0);
			expect(fs.existsSync(calls)).toBe(false);
			expect(log).toContain('Port 59123 already in use');
		});
	});
});
