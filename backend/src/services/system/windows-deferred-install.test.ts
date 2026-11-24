import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AUTO_UPDATE_CONSTANTS } from '../../constants.js';
import { hasShutdownMarker, shutdownMarkerPath, writeShutdownMarker } from './shutdown-marker.js';
import {
	cancelDeferredInstall,
	generateDeferredInstallHelper,
	resolveRelaunch,
	startDeferredInstall,
	type DeferredInstallPlan,
} from './windows-deferred-install.js';

describe('windows deferred install', () => {
	let home: string;
	let pkg: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-deferred-'));
		pkg = path.join(home, 'pkg');
		fs.mkdirSync(pkg, { recursive: true });
		fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ version: '1.0.0' }));
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	});

	describe('resolveRelaunch', () => {
		it('runs crewly start directly when no service is installed', () => {
			expect(resolveRelaunch(home, pkg, 'node.exe')).toEqual({
				command: 'node.exe',
				args: [path.join(pkg, AUTO_UPDATE_CONSTANTS.CLI_ENTRY), 'start', '--no-browser'],
			});
		});

		it('goes through the service launcher when the service is installed', () => {
			fs.writeFileSync(path.join(home, AUTO_UPDATE_CONSTANTS.WINDOWS_LAUNCHER_FILE), '');
			fs.writeFileSync(path.join(home, AUTO_UPDATE_CONSTANTS.WINDOWS_SUPERVISOR_FILE), '');
			expect(resolveRelaunch(home, pkg, 'node.exe')).toEqual({
				command: 'wscript.exe',
				args: [path.join(home, AUTO_UPDATE_CONSTANTS.WINDOWS_LAUNCHER_FILE)],
			});
		});
	});

	describe('startDeferredInstall', () => {
		it('writes the plan, the helper and the shutdown marker, then starts the helper outside the package', () => {
			const launch = jest.fn();
			const plan = startDeferredInstall({
				crewlyHome: home,
				packageRoot: pkg,
				npmCommand: 'C:\\Program Files\\nodejs\\npm.cmd',
				npmArgs: ['install', '-g', 'crewly@1.1.0'],
				version: '1.1.0',
				logFile: path.join(home, 'logs', 'auto-update.log'),
				nodePath: 'node.exe',
				backendPid: 4288,
				parentPid: 12924,
				launch,
			});
			expect(plan.waitForPids).toEqual([4288, 12924]);
			expect(plan.treeRootPid).toBe(4288);
			expect(plan.cwd).toBe(home);
			expect(hasShutdownMarker(home)).toBe(true);
			const scriptPath = path.join(home, AUTO_UPDATE_CONSTANTS.DEFERRED_HELPER_FILE);
			const planPath = path.join(home, 'run', AUTO_UPDATE_CONSTANTS.DEFERRED_PLAN_FILE);
			expect(launch).toHaveBeenCalledWith('node.exe', scriptPath, planPath, home);
			expect(JSON.parse(fs.readFileSync(planPath, 'utf-8')).version).toBe('1.1.0');
			expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(generateDeferredInstallHelper());
		});

		it('removes the marker when the helper cannot be started', () => {
			expect(() =>
				startDeferredInstall({
					crewlyHome: home,
					packageRoot: pkg,
					npmCommand: 'npm',
					npmArgs: [],
					version: '1.1.0',
					logFile: path.join(home, 'x.log'),
					launch: () => {
						throw new Error('spawn failed');
					},
				}),
			).toThrow('spawn failed');
			expect(hasShutdownMarker(home)).toBe(false);
		});

		it('cancelDeferredInstall removes the marker', () => {
			writeShutdownMarker(home);
			cancelDeferredInstall(home);
			expect(hasShutdownMarker(home)).toBe(false);
		});
	});

	describe('helper script (run for real)', () => {
		/**
		 * Write a plan and the helper, with a fake npm and a fake relaunch.
		 *
		 * @param overrides - Plan overrides
		 * @returns Paths of the pieces
		 */
		function setUp(overrides: Partial<DeferredInstallPlan> = {}): { script: string; planPath: string; log: string; relaunched: string; npmCalls: string } {
			const script = path.join(home, 'helper.cjs');
			const planPath = path.join(home, 'plan.json');
			const log = path.join(home, 'logs', 'auto-update.log');
			const relaunched = path.join(home, 'relaunched');
			const npmCalls = path.join(home, 'npm-calls');
			const fakeNpm = path.join(home, 'fake-npm.cjs');
			// Fails until the call count reaches FAIL_UNTIL, then "installs" the version.
			fs.writeFileSync(
				fakeNpm,
				`const fs=require('fs');const [calls,pkg,version,failUntil]=process.argv.slice(2);
fs.appendFileSync(calls,'x');const n=fs.readFileSync(calls,'utf-8').length;
if(n<=Number(failUntil)){console.error('npm error code EBUSY');process.exit(1);}
fs.writeFileSync(pkg+'/package.json',JSON.stringify({version}));`,
			);
			const fakeStart = path.join(home, 'fake-start.cjs');
			fs.writeFileSync(fakeStart, `require('fs').writeFileSync(process.argv[2],'up');`);
			fs.writeFileSync(script, generateDeferredInstallHelper());
			writeShutdownMarker(home);
			const plan: DeferredInstallPlan = {
				version: '1.1.0',
				npmCommand: process.execPath,
				npmArgs: [fakeNpm, npmCalls, pkg, '1.1.0', '0'],
				packageRoot: pkg,
				cwd: home,
				waitForPids: [],
				treeRootPid: 999999,
				shutdownMarker: shutdownMarkerPath(home),
				logFile: log,
				relaunch: { command: process.execPath, args: [fakeStart, relaunched] },
				exitWaitMs: 20_000,
				attempts: 3,
				retryDelayMs: 50,
				...overrides,
			};
			fs.writeFileSync(planPath, JSON.stringify(plan));
			return { script, planPath, log, relaunched, npmCalls };
		}

		/**
		 * Wait for a file to appear.
		 *
		 * @param file - Path
		 * @returns True when it exists within a few seconds
		 */
		async function appears(file: string): Promise<boolean> {
			for (let i = 0; i < 100; i++) {
				if (fs.existsSync(file)) return true;
				await new Promise((r) => setTimeout(r, 50));
			}
			return false;
		}

		it('installs, removes the marker and starts Crewly again', async () => {
			const t = setUp();
			const run = spawnSync(process.execPath, [t.script, t.planPath], { encoding: 'utf-8' });
			expect(run.status).toBe(0);
			expect(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf-8')).version).toBe('1.1.0');
			expect(hasShutdownMarker(home)).toBe(false);
			expect(await appears(t.relaunched)).toBe(true);
			expect(fs.readFileSync(t.log, 'utf-8')).toContain('installed 1.1.0 (attempt 1)');
		});

		it('retries a failed npm run', async () => {
			const t = setUp();
			const plan = JSON.parse(fs.readFileSync(t.planPath, 'utf-8')) as DeferredInstallPlan;
			plan.npmArgs[4] = '2';
			fs.writeFileSync(t.planPath, JSON.stringify(plan));
			spawnSync(process.execPath, [t.script, t.planPath]);
			expect(fs.readFileSync(t.npmCalls, 'utf-8')).toBe('xxx');
			expect(fs.readFileSync(t.log, 'utf-8')).toContain('installed 1.1.0 (attempt 3)');
			expect(await appears(t.relaunched)).toBe(true);
		});

		it('starts the old version again when every attempt fails', async () => {
			const t = setUp();
			const plan = JSON.parse(fs.readFileSync(t.planPath, 'utf-8')) as DeferredInstallPlan;
			plan.npmArgs[4] = '99';
			fs.writeFileSync(t.planPath, JSON.stringify(plan));
			spawnSync(process.execPath, [t.script, t.planPath]);
			expect(JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf-8')).version).toBe('1.0.0');
			expect(hasShutdownMarker(home)).toBe(false);
			expect(await appears(t.relaunched)).toBe(true);
			const log = fs.readFileSync(t.log, 'utf-8');
			expect(log).toContain('attempt 3 of 3 failed');
			expect(log).toContain('EBUSY');
		});

		it('waits for the old processes, and installs only after they exit', async () => {
			const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
			const t = setUp({ waitForPids: [sleeper.pid as number] });
			const helper = spawn(process.execPath, [t.script, t.planPath], { stdio: 'ignore' });
			const done = new Promise((resolve) => helper.once('exit', resolve));
			await new Promise((r) => setTimeout(r, 1500));
			expect(fs.existsSync(t.npmCalls)).toBe(false);
			sleeper.kill('SIGKILL');
			await done;
			expect(fs.readFileSync(t.npmCalls, 'utf-8')).toBe('x');
			expect(await appears(t.relaunched)).toBe(true);
		}, 20_000);

		it('does nothing when the restart is called off', async () => {
			const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
			try {
				const t = setUp({ waitForPids: [sleeper.pid as number] });
				cancelDeferredInstall(home);
				const run = spawnSync(process.execPath, [t.script, t.planPath]);
				expect(run.status).toBe(0);
				expect(fs.existsSync(t.npmCalls)).toBe(false);
				expect(fs.existsSync(t.relaunched)).toBe(false);
				expect(fs.readFileSync(t.log, 'utf-8')).toContain('called off');
			} finally {
				sleeper.kill('SIGKILL');
			}
		});

		it('gives up and lifts the marker when Crewly never exits', () => {
			const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
			try {
				const t = setUp({ waitForPids: [sleeper.pid as number], exitWaitMs: 500 });
				spawnSync(process.execPath, [t.script, t.planPath]);
				expect(fs.existsSync(t.npmCalls)).toBe(false);
				expect(hasShutdownMarker(home)).toBe(false);
				expect(fs.readFileSync(t.log, 'utf-8')).toContain('did not exit in time');
			} finally {
				sleeper.kill('SIGKILL');
			}
		});
	});
});
