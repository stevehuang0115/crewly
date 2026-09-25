/**
 * Tests for the harness PATH helpers and the command runner.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildHarnessPath, buildNpmPath, getUserNpmBinDir, getUserNpmPrefix, resolveExecutable, runCommand, withHarnessPath } from './harness-exec.utils.js';

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
		expect(getUserNpmBinDir()).toBe('/tmp/crewly-home-test/npm-global/bin');
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
});
