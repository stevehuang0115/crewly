/**
 * Tests for the native-module build toolchain preflight.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	checkNativeToolchain,
	detectMissingBuildTools,
	formatToolchainMessage,
	isOnPath,
	nodePtyBuildStatus,
	prebuildLibcProblem,
	toolchainInstallHint,
} from './native-toolchain.js';

/** Build a PATH-lookup stub from a set of "installed" executables. */
function whichOf(...installed: string[]): (bin: string) => boolean {
	const set = new Set(installed);
	return (bin) => set.has(bin);
}

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-toolchain-'));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('detectMissingBuildTools', () => {
	it('reports nothing when a compiler, make and python3 are present', () => {
		expect(detectMissingBuildTools(whichOf('g++', 'make', 'python3'))).toEqual([]);
	});

	it('accepts clang++ / c++ as the compiler', () => {
		expect(detectMissingBuildTools(whichOf('clang++', 'make', 'python3'))).toEqual([]);
		expect(detectMissingBuildTools(whichOf('c++', 'make', 'python3'))).toEqual([]);
	});

	it('names only the missing tool (finding 11: make + python3 present, g++ absent)', () => {
		expect(detectMissingBuildTools(whichOf('make', 'python3'))).toEqual(['g++']);
	});

	it('lists every missing tool in a fixed order', () => {
		expect(detectMissingBuildTools(whichOf())).toEqual(['g++', 'make', 'python3']);
	});

	it('works with the real PATH lookup (regression: Array#some passed the index as env)', () => {
		const bin = path.join(tmp, 'bin');
		fs.mkdirSync(bin);
		for (const tool of ['g++', 'make', 'python3']) {
			fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\n', { mode: 0o755 });
		}
		const prev = process.env.PATH;
		process.env.PATH = bin;
		try {
			expect(detectMissingBuildTools()).toEqual([]);
			fs.unlinkSync(path.join(bin, 'g++'));
			expect(detectMissingBuildTools()).toEqual(['g++']);
		} finally {
			process.env.PATH = prev;
		}
	});
});

describe('toolchainInstallHint', () => {
	it('prefers apt-get on Debian/Ubuntu', () => {
		expect(toolchainInstallHint(whichOf('apt-get', 'yum'))).toContain('apt-get install -y build-essential');
	});

	it('uses dnf/yum on RHEL-likes', () => {
		expect(toolchainInstallHint(whichOf('dnf'))).toContain('dnf install -y gcc-c++');
		expect(toolchainInstallHint(whichOf('yum'))).toContain('yum install -y gcc-c++');
	});

	it('uses brew/xcode on macOS', () => {
		expect(toolchainInstallHint(whichOf('brew'))).toContain('xcode-select --install');
	});

	it('falls back to a generic hint', () => {
		expect(toolchainInstallHint(whichOf())).toContain('install a C++ compiler');
	});
});

describe('nodePtyBuildStatus', () => {
	it('before node-pty is installed (preinstall), infers the prebuild from the known targets', () => {
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64', null)).toEqual({ built: false, prebuilt: true });
		expect(nodePtyBuildStatus(tmp, 'darwin', 'arm64', null)).toEqual({ built: false, prebuilt: true });
		expect(nodePtyBuildStatus(tmp, 'linux', 'arm', null)).toEqual({ built: false, prebuilt: false });
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64', { family: 'musl' }).prebuilt).toBe(false);
	});

	it('reports not prebuilt when installed node-pty has no prebuild for the platform', () => {
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty'), { recursive: true });
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64', null)).toEqual({ built: false, prebuilt: false });
	});

	it('detects a compiled pty.node', () => {
		const dir = path.join(tmp, 'node_modules', 'node-pty', 'build', 'Release');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'pty.node'), '');
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64').built).toBe(true);
	});

	it('detects a prebuild for the current platform only', () => {
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64'), { recursive: true });
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64').prebuilt).toBe(true);
		expect(nodePtyBuildStatus(tmp, 'linux', 'arm64').prebuilt).toBe(false);
	});

	it('does not count a glibc prebuild as usable on musl or glibc < 2.28 (#778)', () => {
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64'), { recursive: true });
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64', { family: 'glibc', version: '2.39' })).toEqual({ built: false, prebuilt: true });
		expect(nodePtyBuildStatus(tmp, 'linux', 'x64', { family: 'glibc', version: '2.28' }).prebuilt).toBe(true);
		const musl = nodePtyBuildStatus(tmp, 'linux', 'x64', { family: 'musl' });
		expect(musl.prebuilt).toBe(false);
		expect(musl.prebuildProblem).toContain('musl');
		const old = nodePtyBuildStatus(tmp, 'linux', 'x64', { family: 'glibc', version: '2.17' });
		expect(old.prebuilt).toBe(false);
		expect(old.prebuildProblem).toContain('glibc 2.17');
	});
});

describe('prebuildLibcProblem', () => {
	it('only applies to Linux with a known libc', () => {
		expect(prebuildLibcProblem('darwin', { family: 'musl' })).toBeNull();
		expect(prebuildLibcProblem('linux', null)).toBeNull();
		expect(prebuildLibcProblem('linux', { family: 'glibc', version: '2.31' })).toBeNull();
		expect(prebuildLibcProblem('linux', { family: 'glibc', version: '2.27' })).toContain('older than');
	});
});

describe('checkNativeToolchain', () => {
	it('is ok when the toolchain is complete', () => {
		const res = checkNativeToolchain({ packageRoot: tmp, which: whichOf('g++', 'make', 'python3', 'apt-get') });
		expect(res.ok).toBe(true);
		expect(res.message).toBe('');
	});

	it('produces ONE message naming the missing tool and the apt line when node-pty must be built', () => {
		const res = checkNativeToolchain({ packageRoot: tmp, which: whichOf('make', 'python3', 'apt-get'), platform: 'linux', arch: 'arm' });
		expect(res.ok).toBe(false);
		expect(res.missing).toEqual(['g++']);
		expect(res.message).toContain('Missing native build tool: g++.');
		expect(res.message).toContain('must be compiled');
		expect(res.message).toContain('sudo apt-get update && sudo apt-get install -y build-essential python3');
		// No raw gyp noise — four short lines.
		expect(res.message.split('\n')).toHaveLength(4);
	});

	it('stays quiet when node-pty is already built, unless forced (doctor mode)', () => {
		const dir = path.join(tmp, 'node_modules', 'node-pty', 'build', 'Release');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'pty.node'), '');
		const which = whichOf('make', 'python3', 'brew');
		expect(checkNativeToolchain({ packageRoot: tmp, which }).ok).toBe(true);
		const forced = checkNativeToolchain({ packageRoot: tmp, which, force: true });
		expect(forced.ok).toBe(false);
		expect(forced.message).toContain('currently built');
	});

	it('stays quiet when a prebuild exists for the platform', () => {
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', 'linux-arm64'), { recursive: true });
		const res = checkNativeToolchain({ packageRoot: tmp, which: whichOf(), platform: 'linux', arch: 'arm64' });
		expect(res.ok).toBe(true);
	});

	it('warns on musl even though a (glibc) prebuild directory exists', () => {
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64'), { recursive: true });
		const res = checkNativeToolchain({
			packageRoot: tmp,
			which: whichOf('apk'),
			platform: 'linux',
			arch: 'x64',
			libc: { family: 'musl' },
		});
		expect(res.ok).toBe(false);
		expect(res.message).toContain('cannot run here (musl libc');
		expect(res.message).toContain('apk add --no-cache build-base python3');
	});
});

describe('formatToolchainMessage', () => {
	it('pluralises for multiple tools', () => {
		expect(formatToolchainMessage(['g++', 'make'], 'cmd', true)).toContain('Missing native build tools: g++, make.');
	});
});

describe('isOnPath', () => {
	it('finds an executable file on the given PATH and ignores non-executables', () => {
		const bin = path.join(tmp, 'bin');
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(bin, 'tool-x'), '#!/bin/sh\n', { mode: 0o755 });
		fs.writeFileSync(path.join(bin, 'tool-y'), '', { mode: 0o644 });
		const env = { PATH: `${path.join(tmp, 'missing')}${path.delimiter}${bin}` };
		expect(isOnPath('tool-x', env)).toBe(true);
		expect(isOnPath('tool-y', env)).toBe(false);
		expect(isOnPath('tool-z', env)).toBe(false);
	});

	it('handles an empty PATH', () => {
		expect(isOnPath('sh', { PATH: '' })).toBe(false);
	});
});
