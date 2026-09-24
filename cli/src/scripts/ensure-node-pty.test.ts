/**
 * Tests for the install-time node-pty check (#778).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureNodePty, firstErrorLine, type LoadProbeResult } from './ensure-node-pty.js';

let root: string;
let ptyDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-ensure-pty-'));
	ptyDir = path.join(root, 'node_modules', 'node-pty');
	fs.mkdirSync(ptyDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/** Probe stub returning the given results in order. */
function probes(...results: LoadProbeResult[]): jest.Mock<LoadProbeResult, [string]> {
	const fn = jest.fn<LoadProbeResult, [string]>();
	for (const r of results) fn.mockReturnValueOnce(r);
	return fn;
}

describe('ensureNodePty', () => {
	it('does nothing more when the prebuilt binary loads — never compiles', () => {
		const rebuild = jest.fn(() => true);
		const log = jest.fn();
		const status = ensureNodePty({
			packageRoot: root,
			findNodePtyDir: () => ptyDir,
			probeLoad: probes({ ok: true }),
			rebuildFromSource: rebuild,
			log,
		});
		expect(status).toBe('ok');
		expect(rebuild).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalled();
	});

	(process.platform === 'win32' ? it.skip : it)('restores the spawn-helper exec bit before probing', () => {
		const dir = path.join(ptyDir, 'prebuilds', 'darwin-arm64');
		fs.mkdirSync(dir, { recursive: true });
		const helper = path.join(dir, 'spawn-helper');
		fs.writeFileSync(helper, '');
		fs.chmodSync(helper, 0o644);
		const log = jest.fn();
		ensureNodePty({
			packageRoot: root,
			platform: 'darwin',
			arch: 'arm64',
			findNodePtyDir: () => ptyDir,
			probeLoad: probes({ ok: true }),
			log,
		});
		expect(fs.statSync(helper).mode & 0o111).not.toBe(0);
		expect(log).toHaveBeenCalledWith(expect.stringContaining('spawn-helper executable'));
	});

	it('compiles from source only when the prebuild does not load (e.g. musl)', () => {
		const rebuild = jest.fn(() => true);
		const log = jest.fn();
		const status = ensureNodePty({
			packageRoot: root,
			platform: 'linux',
			arch: 'x64',
			findNodePtyDir: () => ptyDir,
			probeLoad: probes({ ok: false, error: 'Error: Error loading shared library ld-linux-x86-64.so.2' }, { ok: true }),
			rebuildFromSource: rebuild,
			log,
		});
		expect(status).toBe('rebuilt');
		expect(rebuild).toHaveBeenCalledWith(root);
		expect(log.mock.calls.map((c) => c[0]).join('\n')).toContain('does not load on linux-x64');
	});

	it('names the libc reason instead of node-pty\'s last-path error when known', () => {
		const log = jest.fn();
		ensureNodePty({
			packageRoot: root,
			platform: 'linux',
			arch: 'arm64',
			findNodePtyDir: () => ptyDir,
			probeLoad: probes({ ok: false, error: "Cannot find module './prebuilds/linux-arm64/pty.node'" }, { ok: true }),
			rebuildFromSource: () => true,
			prebuildProblem: 'musl libc (e.g. Alpine) — the prebuilds target glibc',
			log,
		});
		expect(log).toHaveBeenCalledWith(expect.stringContaining('does not load on linux-arm64: musl libc'));
	});

	it('says clearly when node-pty still cannot load after the compile', () => {
		const log = jest.fn();
		const status = ensureNodePty({
			packageRoot: root,
			platform: 'linux',
			arch: 'x64',
			findNodePtyDir: () => ptyDir,
			probeLoad: probes({ ok: false, error: 'dlopen failed' }, { ok: false, error: 'dlopen failed' }),
			rebuildFromSource: () => false,
			installHint: 'sudo apk add --no-cache build-base python3',
			log,
		});
		expect(status).toBe('failed');
		const out = log.mock.calls.map((c) => c[0]).join('\n');
		expect(out).toContain('the compile failed');
		expect(out).toContain('sudo apk add --no-cache build-base python3');
		expect(out).toContain('npm i -g crewly');
	});

	it('reports a missing node-pty without throwing', () => {
		const log = jest.fn();
		expect(ensureNodePty({ packageRoot: root, findNodePtyDir: () => null, log })).toBe('missing');
		expect(log).toHaveBeenCalledWith(expect.stringContaining('not installed'));
	});
});

describe('firstErrorLine', () => {
	it('returns the thrown message, not the echoed source line', () => {
		const stderr = [
			'/x/node_modules/node-pty/lib/utils.js:34',
			'    throw new Error("Failed to load native module: ".concat(name));',
			'    ^',
			'',
			'Error: Failed to load native module: pty.node, checked: build/Release',
			'    at loadNativeModule (/x/utils.js:34:11)',
		].join('\n');
		expect(firstErrorLine(stderr)).toBe('Error: Failed to load native module: pty.node, checked: build/Release');
		expect(firstErrorLine('TypeError [ERR_DLOPEN_FAILED]: bad')).toBe('TypeError [ERR_DLOPEN_FAILED]: bad');
		expect(firstErrorLine('')).toBeNull();
	});
});
