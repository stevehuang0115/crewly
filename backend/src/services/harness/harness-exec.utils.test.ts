/**
 * Tests for the harness PATH helpers and the command runner.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { buildHarnessPath, buildNpmPath, createRunCommand, getUserNpmBinDir, getUserNpmPrefix, resolveExecutable, runCommand, spawnTarget, withHarnessPath } from './harness-exec.utils.js';

describe('harness PATH helpers', () => {
	const originalHome = process.env.CREWLY_HOME;
	beforeEach(() => {
		process.env.CREWLY_HOME = '/tmp/crewly-home-test';
	});
	afterAll(() => {
		process.env.CREWLY_HOME = originalHome;
	});

	it('puts the user npm prefix under the Crewly home', () => {
		expect(getUserNpmPrefix()).toBe('/tmp/crewly-home-test/npm-global');
		expect(getUserNpmBinDir('darwin')).toBe('/tmp/crewly-home-test/npm-global/bin');
		expect(getUserNpmBinDir('win32')).toBe('/tmp/crewly-home-test/npm-global');
	});

	it('prepends the npm prefix bin and appends ~/.local/bin', () => {
		expect(buildHarnessPath('/usr/bin:/bin', '/home/me')).toBe('/tmp/crewly-home-test/npm-global/bin:/usr/bin:/bin:/home/me/.local/bin');
	});

	it('does not duplicate entries already present', () => {
		const current = '/tmp/crewly-home-test/npm-global/bin:/usr/bin:/home/me/.local/bin';
		expect(buildHarnessPath(current, '/home/me')).toBe(current);
	});

	it('handles an empty PATH', () => {
		expect(buildHarnessPath(undefined, '/home/me')).toBe('/tmp/crewly-home-test/npm-global/bin:/home/me/.local/bin');
	});

	it('buildNpmPath adds the Node binary directory once', () => {
		expect(buildNpmPath('/usr/bin', '/home/me', '/opt/node/bin')).toBe(
			'/tmp/crewly-home-test/npm-global/bin:/usr/bin:/home/me/.local/bin:/opt/node/bin',
		);
		expect(buildNpmPath('/opt/node/bin', '/home/me', '/opt/node/bin').split(':').filter((d) => d === '/opt/node/bin')).toHaveLength(1);
	});

	it('withHarnessPath copies the env with the harness PATH', () => {
		const env = withHarnessPath({ PATH: '/usr/bin', FOO: 'bar' });
		expect(env.FOO).toBe('bar');
		expect(env.PATH?.startsWith('/tmp/crewly-home-test/npm-global/bin:/usr/bin')).toBe(true);
	});
});

describe('resolveExecutable', () => {
	it('finds the first executable on PATH', () => {
		const exists = new Set(['/b/claude', '/c/claude']);
		expect(resolveExecutable('claude', '/a:/b:/c', (f) => exists.has(f))).toBe('/b/claude');
	});

	it('returns null when not found', () => {
		expect(resolveExecutable('claude', '/a:/b', () => false)).toBeNull();
		expect(resolveExecutable('claude', undefined, () => true)).toBeNull();
	});

	it('checks an absolute path directly', () => {
		expect(resolveExecutable('/opt/x/claude', '/a', (f) => f === '/opt/x/claude')).toBe('/opt/x/claude');
	});

	it('tries the PATHEXT extensions on Windows', () => {
		// Windows file names are case-insensitive: `claude.EXE` names `claude.exe`.
		const files = ['c:\\users\\me\\.local\\bin\\claude.exe', 'c:\\npm\\codex.cmd', 'c:\\npm\\codex'];
		const exists = (f: string): boolean => files.includes(f.toLowerCase());
		const win = { platform: 'win32' as const, pathExt: '.COM;.EXE;.BAT;.CMD' };
		const searchPath = 'C:\\Windows;C:\\npm;C:\\Users\\me\\.local\\bin';
		expect(resolveExecutable('claude', searchPath, exists, win)).toBe('C:\\Users\\me\\.local\\bin\\claude.EXE');
		// The extensionless npm shell script next to the shim is not a Windows command.
		expect(resolveExecutable('codex', searchPath, exists, win)).toBe('C:\\npm\\codex.CMD');
		expect(resolveExecutable('claude.exe', searchPath, exists, win)).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
		expect(resolveExecutable('C:\\npm\\codex', searchPath, exists, win)).toBe('C:\\npm\\codex.CMD');
		expect(resolveExecutable('gemini', searchPath, exists, win)).toBeNull();
	});

	it('uses the real file system by default', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-exec-'));
		const bin = path.join(dir, 'fake-tool');
		fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
		fs.writeFileSync(path.join(dir, 'not-exec'), '', { mode: 0o644 });
		expect(resolveExecutable('fake-tool', dir)).toBe(bin);
		expect(resolveExecutable('not-exec', dir)).toBeNull();
		fs.rmSync(dir, { recursive: true, force: true });
	});
});

describe('spawnTarget', () => {
	it('starts a binary directly', () => {
		expect(spawnTarget('/usr/bin/claude', ['--version'], 'darwin')).toEqual({ file: '/usr/bin/claude', args: ['--version'], verbatim: false });
		expect(spawnTarget('C:\\bin\\claude.exe', ['--version'], 'win32')).toEqual({ file: 'C:\\bin\\claude.exe', args: ['--version'], verbatim: false });
	});

	it('runs a Windows command shim through cmd.exe in one quoted line', () => {
		expect(spawnTarget('C:\\Program Files\\nodejs\\npm.cmd', ['view', 'a b', 'version'], 'win32')).toEqual({
			file: 'cmd.exe',
			args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" view "a b" version"'],
			verbatim: true,
		});
	});
});

describe('runCommand', () => {
	const node = process.execPath;

	it('collects stdout, stderr and the exit code', async () => {
		const result = await runCommand(node, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
		expect(result).toEqual({ code: 3, stdout: 'out', stderr: 'err' });
	});

	it('writes stdin and closes it (secrets never go in argv)', async () => {
		const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.trim().toUpperCase()))';
		const result = await runCommand(node, ['-e', script], { stdin: 'secret-key\n' });
		expect(result.stdout).toBe('SECRET-KEY');
	});

	it('streams output to onOutput', async () => {
		const chunks: string[] = [];
		await runCommand(node, ['-e', 'console.log("line")'], { onOutput: (c) => chunks.push(c) });
		expect(chunks.join('')).toContain('line');
	});

	it('reports a missing binary without rejecting', async () => {
		const result = await runCommand('/nonexistent/binary-xyz', []);
		expect(result.code).toBeNull();
		expect(result.error).toBeDefined();
	});

	it('kills a command that runs past its timeout', async () => {
		const result = await runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
		expect(result.code).toBeNull();
		expect(result.error).toMatch(/timed out/);
	});

	(process.platform === 'win32' ? it.skip : it)('kills the native child of a wrapper on timeout', async () => {
		// Like the codex wrapper: a Node parent that spawns the real worker and waits.
		const pidFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'run-tree-')), 'pid');
		const wrapper = `const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => {}, 30000);`;
		// Let the previous test's killed node exit so the pile-up guard is clear.
		await new Promise((r) => setTimeout(r, 300));
		const result = await runCommand(node, ['-e', wrapper], { timeoutMs: 1000 });
		expect(result.error).toMatch(/timed out/);
		const childPid = Number(fs.readFileSync(pidFile, 'utf-8'));
		await new Promise((r) => setTimeout(r, 100));
		expect(() => process.kill(childPid, 0)).toThrow();
	});
});

describe('runCommand pile-up guard', () => {
	/** Fake child: never exits until `exit()` is called. */
	function fakeSpawn(pidStart = 1000) {
		let pid = pidStart;
		const children: EventEmitter[] = [];
		const fn = jest.fn(() => {
			const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
			c.pid = pid++;
			c.exitCode = null;
			c.signalCode = null;
			c.stdout = new EventEmitter();
			c.stderr = new EventEmitter();
			c.stdin = { on: () => undefined, end: () => undefined };
			c.kill = () => true;
			children.push(c);
			return c;
		});
		return { fn: fn as unknown as typeof import('child_process').spawn, spawned: fn, children };
	}

	let killSpy: jest.SpyInstance;
	beforeEach(() => {
		killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
		jest.useFakeTimers();
	});
	afterEach(() => {
		killSpy.mockRestore();
		jest.useRealTimers();
	});

	function setup(alive: Set<number>) {
		const sp = fakeSpawn();
		const warn = jest.fn();
		let t = 0;
		const run = createRunCommand({ spawn: sp.fn, now: () => t, isAlive: (p) => alive.has(p), warn });
		return { sp, warn, run, advance: (ms: number) => (t += ms) };
	}

	it('refuses to spawn while a killed child is still alive, and resumes once it is gone', async () => {
		const alive = new Set<number>([1000]);
		const { sp, run, warn } = setup(alive);
		const first = run('/bin/codex', ['--help'], { timeoutMs: 100 });
		jest.advanceTimersByTime(100);
		expect((await first).error).toMatch(/timed out/);

		const blocked = await run('/bin/codex', ['login', 'status'], { timeoutMs: 100 });
		expect(blocked.code).toBeNull();
		expect(blocked.error).toBe('/bin/codex is not responding (an earlier run is still stuck)');
		expect(sp.spawned).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toEqual({ executable: '/bin/codex', stuckPids: 1 });

		// Other executables are unaffected.
		void run('/bin/other', [], { timeoutMs: 100 });
		expect(sp.spawned).toHaveBeenCalledTimes(2);

		alive.delete(1000);
		void run('/bin/codex', [], { timeoutMs: 100 });
		expect(sp.spawned).toHaveBeenCalledTimes(3);
	});

	it('keeps refusing after the wrapper exits while its process group is still alive', async () => {
		const alive = new Set([1000]);
		const { sp, run } = setup(alive);
		const first = run('/bin/codex', [], { timeoutMs: 50 });
		jest.advanceTimersByTime(50);
		await first;
		sp.children[0].emit('exit', null, 'SIGKILL');
		expect((await run('/bin/codex', [], { timeoutMs: 50 })).error).toMatch(/still stuck/);
		alive.delete(1000);
		void run('/bin/codex', [], { timeoutMs: 50 });
		expect(sp.spawned).toHaveBeenCalledTimes(2);
	});

	it('rate-limits the warning per executable', async () => {
		const { run, warn, advance } = setup(new Set([1000]));
		const first = run('/bin/codex', [], { timeoutMs: 50 });
		jest.advanceTimersByTime(50);
		await first;
		await run('/bin/codex', []);
		await run('/bin/codex', []);
		expect(warn).toHaveBeenCalledTimes(1);
		advance(HARNESS_CONSTANTS.STUCK_WARN_INTERVAL_MS + 1);
		await run('/bin/codex', []);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it('caps concurrent timeout-bounded runs per executable', async () => {
		const { sp, run } = setup(new Set());
		const max = HARNESS_CONSTANTS.MAX_INFLIGHT_PER_EXECUTABLE;
		for (let i = 0; i < max; i++) void run('/bin/codex', [], { timeoutMs: 10_000 });
		expect(sp.spawned).toHaveBeenCalledTimes(max);
		const over = await run('/bin/codex', [], { timeoutMs: 10_000 });
		expect(over.error).toMatch(/too many runs in flight/);
		expect(sp.spawned).toHaveBeenCalledTimes(max);
		// Unbounded runs are not capped.
		void run('/bin/codex', []);
		expect(sp.spawned).toHaveBeenCalledTimes(max + 1);
		// A finished run frees a slot.
		sp.children[0].emit('close', 0);
		void run('/bin/codex', [], { timeoutMs: 10_000 });
		expect(sp.spawned).toHaveBeenCalledTimes(max + 2);
	});
});
