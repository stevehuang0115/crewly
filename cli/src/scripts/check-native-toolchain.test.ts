/**
 * Tests for the install-time toolchain preflight entry.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runToolchainCheck } from './check-native-toolchain.js';

let tmp: string;
let prevPath: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-preflight-'));
	prevPath = process.env.PATH;
});

afterEach(() => {
	process.env.PATH = prevPath;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runToolchainCheck', () => {
	it('prints one message and returns false when tools are missing and node-pty is unbuilt', () => {
		// Empty PATH → every tool is "missing", no package manager recognised.
		process.env.PATH = '';
		// node-pty installed with no prebuild for this host and not compiled.
		fs.mkdirSync(path.join(tmp, 'node_modules', 'node-pty'), { recursive: true });
		const lines: string[] = [];
		const ok = runToolchainCheck(tmp, (m) => lines.push(m));
		expect(ok).toBe(false);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('Missing native build tools: g++, make, python3.');
	});

	(['darwin', 'linux'].includes(process.platform) && ['x64', 'arm64'].includes(process.arch) ? it : it.skip)(
		'is silent at preinstall (node-pty not on disk yet) on a platform node-pty ships prebuilds for (#778)',
		() => {
			process.env.PATH = '';
			const lines: string[] = [];
			const ok = runToolchainCheck(tmp, (m) => lines.push(m));
			// A musl host has no usable prebuild, so the warning is still right there.
			const musl = process.platform === 'linux'
				&& !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
			expect(ok).toBe(!musl);
		},
	);

	it('is silent and returns true when node-pty is already built', () => {
		process.env.PATH = '';
		const dir = path.join(tmp, 'node_modules', 'node-pty', 'build', 'Release');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'pty.node'), '');
		const lines: string[] = [];
		expect(runToolchainCheck(tmp, (m) => lines.push(m))).toBe(true);
		expect(lines).toHaveLength(0);
	});
});
