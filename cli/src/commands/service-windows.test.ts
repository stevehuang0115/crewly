/**
 * Windows service: the generated supervisor is run for real against a fake
 * CLI (it is plain Node, so it runs on any platform); the registry and
 * scheduler commands are checked through an injected runner.
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
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import {
	WINDOWS_SERVICE,
	generateWindowsLauncher,
	generateWindowsSupervisor,
	installWindowsService,
	isLocalPortBusy,
	launcherCommand,
	readSupervisorPid,
	startWindowsService,
	uninstallWindowsService,
	windowsServiceCommand,
	windowsServicePaths,
	windowsServiceStatus,
	type WindowsCommandResult,
} from './service-windows.js';

/** A port nothing listens on. */
async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

describe('Windows supervisor script', () => {
	let tmp: string;
	let home: string;
	let root: string;
	let script: string;
	let calls: string;
	let marker: string;
	let port: number;

	/** Write the fake CLI: logs a call, then runs `body`. */
	function writeFakeCli(body: string): void {
		const entry = path.join(root, WINDOWS_SERVICE.CLI_ENTRY);
		fs.mkdirSync(path.dirname(entry), { recursive: true });
		fs.writeFileSync(entry, `const fs = require('fs');\nfs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n');\nconst n = fs.readFileSync(${JSON.stringify(calls)}, 'utf-8').trim().split('\\n').length;\n${body}\n`);
	}

	function runSupervisor(args: string[] = []): { status: number | null; log: string; calls: string[] } {
		const result = spawnSync(process.execPath, [script, ...args], {
			env: {
				PATH: process.env.PATH ?? '',
				CREWLY_HOME: home,
				CREWLY_WEB_PORT: String(port),
				CREWLY_SUPERVISOR_RESTART_MIN_S: '0',
				CREWLY_SUPERVISOR_RESTART_MAX_S: '0',
			},
			encoding: 'utf-8',
			timeout: 30_000,
		});
		const logFile = path.join(home, 'logs', WINDOWS_SERVICE.LOG_FILE);
		return {
			status: result.status,
			log: fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '',
			calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').trim().split('\n') : [],
		};
	}

	beforeEach(async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-win-supervisor-'));
		home = path.join(tmp, 'home');
		root = path.join(tmp, 'root');
		calls = path.join(tmp, 'calls');
		marker = path.join(home, 'run', 'shutdown-requested');
		fs.mkdirSync(path.join(home, 'run'), { recursive: true });
		port = await freePort();
		script = path.join(home, WINDOWS_SERVICE.SUPERVISOR_FILE);
		fs.writeFileSync(script, generateWindowsSupervisor(root, process.execPath));
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
	});

	it('relaunches Crewly after an exit and stays down after a stop request', () => {
		writeFakeCli(`if (n >= 3) { fs.writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(0); }\nprocess.exit(7);`);
		const run = runSupervisor();
		expect(run.status).toBe(0);
		expect(run.calls).toEqual(['start --no-browser', 'start --no-browser', 'start --no-browser']);
		expect(run.log).toContain('Crewly exited (code 7), restarting in 0s...');
		expect(run.log).toContain('after a stop request: not restarting.');
		expect(fs.existsSync(path.join(home, WINDOWS_SERVICE.LOCK_FILE))).toBe(false);
	});

	it('a sign-in start clears an earlier stop; a watchdog run respects it', () => {
		writeFakeCli(`fs.writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(0);`);
		fs.writeFileSync(marker, '{}');
		expect(runSupervisor([WINDOWS_SERVICE.WATCHDOG_ARG]).calls).toEqual([]);
		expect(runSupervisor().calls).toHaveLength(1);
	});

	it('a watchdog run starts Crewly when nothing stopped it', () => {
		writeFakeCli(`fs.writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(0);`);
		const run = runSupervisor([WINDOWS_SERVICE.WATCHDOG_ARG]);
		expect(run.calls).toHaveLength(1);
		expect(run.log).toContain('by the watchdog task');
	});

	it('does nothing while another supervisor holds a fresh lock', () => {
		writeFakeCli('process.exit(0);');
		fs.writeFileSync(path.join(home, WINDOWS_SERVICE.LOCK_FILE), String(process.pid));
		expect(runSupervisor().calls).toEqual([]);
		expect(fs.readFileSync(path.join(home, WINDOWS_SERVICE.LOCK_FILE), 'utf-8')).toBe(String(process.pid));
	});

	it('takes over a lock that was not refreshed (dead supervisor, reused pid)', () => {
		writeFakeCli(`fs.writeFileSync(${JSON.stringify(marker)}, '{}'); process.exit(0);`);
		const lock = path.join(home, WINDOWS_SERVICE.LOCK_FILE);
		fs.writeFileSync(lock, String(process.pid));
		const old = new Date(Date.now() - WINDOWS_SERVICE.LOCK_STALE_MS - 60_000);
		fs.utimesSync(lock, old, old);
		expect(runSupervisor().calls).toHaveLength(1);
	});

	it('does nothing when Crewly already listens on the port', async () => {
		writeFakeCli('process.exit(0);');
		const server = net.createServer();
		await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
		try {
			expect(await isLocalPortBusy(port)).toBe(true);
			// spawnSync would block this process's server: run the check through the async helper instead.
			const { spawn } = await import('child_process');
			const code = await new Promise<number | null>((resolve) => {
				const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', CREWLY_HOME: home, CREWLY_WEB_PORT: String(port) }, stdio: 'ignore' });
				child.once('exit', resolve);
			});
			expect(code).toBe(0);
			expect(fs.existsSync(calls)).toBe(false);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});

describe('Windows service commands', () => {
	let home: string;
	let ran: Array<{ file: string; args: readonly string[] }>;
	let printed: string[];
	let launched: string[];
	const ok: WindowsCommandResult = { ok: true, stdout: '', stderr: '' };
	const failed: WindowsCommandResult = { ok: false, stdout: '', stderr: 'ERROR: not found' };

	function deps(overrides: { result?: WindowsCommandResult; busy?: boolean; projectRoot?: string | null } = {}) {
		return {
			run: async (file: string, args: readonly string[]) => {
				ran.push({ file, args });
				return overrides.result ?? ok;
			},
			crewlyHome: home,
			projectRoot: overrides.projectRoot === undefined ? 'C:\\npm\\node_modules\\crewly' : overrides.projectRoot,
			nodePath: 'C:\\Program Files\\nodejs\\node.exe',
			print: (line: string) => void printed.push(line),
			launch: (launcher: string) => void launched.push(launcher),
			isPortBusy: async () => overrides.busy ?? false,
		};
	}

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-win-service-'));
		ran = [];
		printed = [];
		launched = [];
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('builds the launcher and its command lines', () => {
		const vbs = generateWindowsLauncher('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.crewly\\crewly-supervisor.cjs');
		expect(vbs).toContain('.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\me\\.crewly\\crewly-supervisor.cjs""" & extra, 0, False');
		expect(launcherCommand('C:\\x\\crewly-start.vbs')).toBe('wscript.exe "C:\\x\\crewly-start.vbs"');
		expect(launcherCommand('C:\\x\\crewly-start.vbs', true)).toBe('wscript.exe "C:\\x\\crewly-start.vbs" watchdog');
	});

	it('install writes the files, registers both entries and starts Crewly', async () => {
		expect(await installWindowsService(deps())).toBe(true);
		const paths = windowsServicePaths(home);
		expect(fs.readFileSync(paths.supervisor, 'utf-8')).toContain('const ROOT = "C:\\\\npm\\\\node_modules\\\\crewly";');
		expect(fs.existsSync(paths.launcher)).toBe(true);
		expect(ran[0]).toEqual({
			file: 'reg.exe',
			args: ['add', WINDOWS_SERVICE.RUN_KEY, '/v', 'CrewlyBackend', '/t', 'REG_SZ', '/d', `wscript.exe "${paths.launcher}"`, '/f'],
		});
		expect(ran[1]).toEqual({
			file: 'schtasks.exe',
			args: ['/Create', '/F', '/SC', 'MINUTE', '/MO', '5', '/TN', 'CrewlyWatchdog', '/TR', `wscript.exe "${paths.launcher}" watchdog`],
		});
		expect(launched).toEqual([paths.launcher]);
	});

	it('install leaves a running Crewly alone and reports a failed registration', async () => {
		expect(await installWindowsService(deps({ busy: true, result: failed }))).toBe(false);
		expect(launched).toEqual([]);
		expect(printed.join('\n')).toContain('Could not register the sign-in entry: ERROR: not found');
		expect(printed.join('\n')).toContain('Crewly is already running');
	});

	it('install refuses without a package root', async () => {
		expect(await installWindowsService(deps({ projectRoot: null }))).toBe(false);
		expect(ran).toEqual([]);
	});

	it('uninstall removes both entries and the files', async () => {
		await installWindowsService(deps({ busy: true }));
		ran = [];
		await uninstallWindowsService(deps());
		expect(ran.map((r) => r.args.slice(0, 2).join(' '))).toEqual([`delete ${WINDOWS_SERVICE.RUN_KEY}`, '/Delete /F']);
		expect(fs.existsSync(windowsServicePaths(home).supervisor)).toBe(false);
		expect(fs.existsSync(windowsServicePaths(home).launcher)).toBe(false);
	});

	it('start needs an install, and does not start a running Crewly twice', async () => {
		expect(await startWindowsService(deps())).toBe(false);
		await installWindowsService(deps({ busy: true }));
		expect(await startWindowsService(deps({ busy: true }))).toBe(true);
		expect(launched).toEqual([]);
		expect(await startWindowsService(deps())).toBe(true);
		expect(launched).toEqual([windowsServicePaths(home).launcher]);
	});

	it('status says what is installed and running', async () => {
		await windowsServiceStatus(deps({ result: failed }));
		const text = printed.join('\n');
		expect(text).toContain('Supervisor script: not installed');
		expect(text).toContain('Starts at sign-in: no');
		expect(text).toContain('Crewly:            not running');
	});

	it('reads a live supervisor from a fresh lock only', () => {
		const lock = windowsServicePaths(home).lock;
		expect(readSupervisorPid(lock)).toBeNull();
		fs.writeFileSync(lock, String(process.pid));
		expect(readSupervisorPid(lock)).toBe(process.pid);
		expect(readSupervisorPid(lock, Date.now() + WINDOWS_SERVICE.LOCK_STALE_MS + 60_000)).toBeNull();
	});

	it('routes actions; stop marks a deliberate stop', async () => {
		expect(await windowsServiceCommand('status', deps())).toBe(0);
		expect(await windowsServiceCommand('stop', deps())).toBe(0);
		expect(fs.existsSync(path.join(home, 'run', 'shutdown-requested'))).toBe(true);
		expect(await windowsServiceCommand('logs', deps())).toBe(1);
		expect(printed.join('\n')).toContain('not available on Windows yet');
	});
});
