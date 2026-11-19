import { findExecutable, probeVersion } from './find-executable.utils.js';

describe('findExecutable', () => {
	it('finds a command on a POSIX PATH', () => {
		const files = new Set(['/opt/homebrew/bin/jq']);
		expect(findExecutable('jq', { platform: 'darwin', env: { PATH: '/usr/bin:/opt/homebrew/bin' }, isFile: (f) => files.has(f) })).toBe('/opt/homebrew/bin/jq');
		expect(findExecutable('jq', { platform: 'linux', env: { PATH: '/usr/bin' }, isFile: () => false })).toBeNull();
	});

	it('finds a winget-linked exe on Windows through PATHEXT (crewly init, 2026-11-19)', () => {
		const links = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links';
		const env = { PATH: `C:\\Windows\\system32;${links}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
		expect(findExecutable('jq', { platform: 'win32', env, isFile: (f) => f === `${links}\\jq.EXE` })).toBe(`${links}\\jq.EXE`);
	});

	it('finds an npm .cmd shim, reads `Path`, and falls back to default extensions', () => {
		const env = { Path: 'C:\\npm' };
		expect(findExecutable('claude', { platform: 'win32', env, isFile: (f) => f === 'C:\\npm\\claude.CMD' })).toBe('C:\\npm\\claude.CMD');
	});

	it('does not accept an extensionless file on Windows, but accepts a name that carries its extension', () => {
		const env = { PATH: 'C:\\tools', PATHEXT: '.EXE' };
		expect(findExecutable('jq', { platform: 'win32', env, isFile: (f) => f === 'C:\\tools\\jq' })).toBeNull();
		expect(findExecutable('jq.exe', { platform: 'win32', env, isFile: (f) => f === 'C:\\tools\\jq.exe' })).toBe('C:\\tools\\jq.exe');
	});

	it('returns null on an empty PATH', () => {
		expect(findExecutable('jq', { platform: 'linux', env: {}, isFile: () => true })).toBeNull();
	});
});

describe('probeVersion', () => {
	it('reads the version of a real executable without a shell', () => {
		expect(probeVersion(process.execPath, '--version')).toMatch(/^\d+\.\d+/);
	});

	it('returns null for a command that is not on PATH', () => {
		expect(probeVersion('crewly-no-such-tool-xyz')).toBeNull();
	});
});
