/**
 * Tests for the detached replacement launcher.
 *
 * The end-to-end cases run the real launcher script with `node -e`, but the
 * "backend" it starts is a one-line script that writes a file — nothing
 * touches a running Crewly.
 *
 * @module services/system/restart-replacement.test
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
	REPLACEMENT_LAUNCHER_SCRIPT,
	buildReplacementPlan,
	spawnReplacementLauncher,
	type ReplacementPlan,
} from './restart-replacement.js';
import { SYSTEM_CONTROL_CONSTANTS } from '../../constants.js';

describe('buildReplacementPlan', () => {
	const base = {
		execPath: '/usr/local/bin/node',
		execArgv: ['--max-old-space-size=4096'],
		argv: ['/usr/local/bin/node', '/usr/local/lib/node_modules/crewly/dist/backend/backend/src/index.js', '--port', '8787'],
		cwd: '/usr/local/lib/node_modules/crewly',
		pid: 4242,
		port: 8787,
		crewlyHome: '/home/me/.crewly',
	};

	it('replays node flags, the entry script and its arguments', () => {
		const plan = buildReplacementPlan({ ...base, supervisorUnknown: false });
		expect(plan.execPath).toBe('/usr/local/bin/node');
		expect(plan.args).toEqual([
			'--max-old-space-size=4096',
			'/usr/local/lib/node_modules/crewly/dist/backend/backend/src/index.js',
			'--port',
			'8787',
		]);
		expect(plan.oldPid).toBe(4242);
		expect(plan.logFile).toBe(path.join('/home/me/.crewly', 'logs', SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_LOG_FILE));
		expect(plan.portGraceMs).toBe(SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_PORT_GRACE_MS);
	});

	it('waits longer before the port check when a supervisor might bring it back first', () => {
		const plan = buildReplacementPlan({ ...base, supervisorUnknown: true });
		expect(plan.portGraceMs).toBe(SYSTEM_CONTROL_CONSTANTS.REPLACEMENT_PORT_GRACE_UNKNOWN_MS);
	});
});

describe('spawnReplacementLauncher', () => {
	it('spawns a detached node -e launcher with the plan as its only argument and unrefs it', () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), 'replacement-spawn-'));
		const unref = jest.fn();
		const spawnFn = jest.fn(() => ({ pid: 999, unref }));
		const plan = buildReplacementPlan({
			execPath: '/usr/bin/node',
			execArgv: [],
			argv: ['/usr/bin/node', '/app/index.js'],
			cwd: '/app',
			pid: 1234,
			port: 8787,
			crewlyHome: home,
			supervisorUnknown: false,
		});
		const env = { SECRET_TOKEN: 'shh' };
		const pid = spawnReplacementLauncher(plan, home, env, spawnFn);
		expect(pid).toBe(999);
		expect(spawnFn).toHaveBeenCalledWith('/usr/bin/node', ['-e', REPLACEMENT_LAUNCHER_SCRIPT, JSON.stringify(plan)], {
			cwd: home,
			env,
			detached: true,
			stdio: 'ignore',
		});
		// Secrets travel in the environment, never on the command line.
		expect(JSON.stringify(spawnFn.mock.calls)).not.toContain('shh"]');
		expect(JSON.stringify(plan)).not.toContain('shh');
		expect(unref).toHaveBeenCalled();
		fs.rmSync(home, { recursive: true, force: true });
	});
});

describe('launcher script (real node, fake backend)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replacement-run-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Run the launcher to completion.
	 *
	 * @param plan - Plan
	 * @returns Exit code
	 */
	function runLauncher(plan: ReplacementPlan): Promise<number | null> {
		return new Promise((resolve) => {
			const child = spawn(process.execPath, ['-e', REPLACEMENT_LAUNCHER_SCRIPT, JSON.stringify(plan)], {
				cwd: dir,
				stdio: 'ignore',
			});
			child.on('close', (code) => resolve(code));
		});
	}

	/**
	 * Wait for a file to appear.
	 *
	 * @param file - Path
	 * @param timeoutMs - Cap
	 * @returns True when it appeared
	 */
	async function waitForFile(file: string, timeoutMs = 5000): Promise<boolean> {
		const end = Date.now() + timeoutMs;
		while (Date.now() < end) {
			if (fs.existsSync(file)) return true;
			await new Promise((r) => setTimeout(r, 50));
		}
		return false;
	}

	/**
	 * A pid that is certainly not running (a child that already exited).
	 *
	 * @returns Dead pid
	 */
	async function deadPid(): Promise<number> {
		const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
		const pid = child.pid as number;
		await new Promise((r) => child.on('close', r));
		return pid;
	}

	/**
	 * A free TCP port.
	 *
	 * @returns Port
	 */
	function freePort(): Promise<number> {
		return new Promise((resolve) => {
			const srv = net.createServer();
			srv.listen(0, '127.0.0.1', () => {
				const port = (srv.address() as net.AddressInfo).port;
				srv.close(() => resolve(port));
			});
		});
	}

	it('starts the backend again once the old process is gone and the port is free', async () => {
		const started = path.join(dir, 'started.txt');
		const plan: ReplacementPlan = {
			execPath: process.execPath,
			args: ['-e', `require('fs').writeFileSync(${JSON.stringify(started)}, process.argv.slice(1).join(' '))`, 'arg1'],
			cwd: dir,
			oldPid: await deadPid(),
			port: await freePort(),
			portGraceMs: 10,
			maxWaitMs: 5000,
			pollMs: 20,
			logFile: path.join(dir, 'launcher.log'),
		};
		await runLauncher(plan);
		expect(await waitForFile(started)).toBe(true);
		expect(fs.readFileSync(started, 'utf-8')).toBe('arg1');
		expect(fs.readFileSync(plan.logFile, 'utf-8')).toContain('Started Crewly again');
	}, 15000);

	it('does nothing when something already answers on the port (a supervisor brought it back)', async () => {
		const server = net.createServer();
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
		const port = (server.address() as net.AddressInfo).port;
		const started = path.join(dir, 'started.txt');
		try {
			const plan: ReplacementPlan = {
				execPath: process.execPath,
				args: ['-e', `require('fs').writeFileSync(${JSON.stringify(started)}, 'x')`],
				cwd: dir,
				oldPid: await deadPid(),
				port,
				portGraceMs: 10,
				maxWaitMs: 5000,
				pollMs: 20,
				logFile: path.join(dir, 'launcher.log'),
			};
			await runLauncher(plan);
			await new Promise((r) => setTimeout(r, 300));
			expect(fs.existsSync(started)).toBe(false);
			expect(fs.readFileSync(plan.logFile, 'utf-8')).toContain('already answers');
		} finally {
			await new Promise((r) => server.close(r));
		}
	}, 15000);

	it('never starts a second copy while the old process is still running', async () => {
		const started = path.join(dir, 'started.txt');
		const plan: ReplacementPlan = {
			execPath: process.execPath,
			args: ['-e', `require('fs').writeFileSync(${JSON.stringify(started)}, 'x')`],
			cwd: dir,
			oldPid: process.pid, // this test process stays alive
			port: await freePort(),
			portGraceMs: 10,
			maxWaitMs: 200,
			pollMs: 20,
			logFile: path.join(dir, 'launcher.log'),
		};
		await runLauncher(plan);
		expect(fs.existsSync(started)).toBe(false);
		expect(fs.readFileSync(plan.logFile, 'utf-8')).toContain('still running');
	}, 15000);
});
