/**
 * Tests for `crewly security scrub-logs`.
 *
 * Uses a temp CREWLY_HOME and a temp HOME so the real ~/.crewly and shell
 * history are never read or written.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('chalk', () => ({
	__esModule: true,
	default: new Proxy({}, {
		get: () => {
			const fn = (s: string) => s;
			return new Proxy(fn, { get: () => fn, apply: (_t: unknown, _this: unknown, args: string[]) => args[0] });
		},
	}),
}));

const mockHome = { dir: '' };
jest.mock('os', () => {
	const actual = jest.requireActual<typeof import('os')>('os');
	return { ...actual, homedir: () => mockHome.dir || actual.homedir() };
});

import { securityCommand, formatScrubSummary } from './security.js';

const KEY = 'AIzaSyTESTfakeGeminiKey0123456789abcdefg';

describe('crewly security scrub-logs', () => {
	const originalEnv = { ...process.env };
	let root: string;
	let logFile: string;
	let historyFile: string;
	let logSpy: jest.SpiedFunction<typeof console.log>;
	let errSpy: jest.SpiedFunction<typeof console.error>;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-cli-security-'));
		mockHome.dir = path.join(root, 'home');
		process.env.CREWLY_HOME = path.join(root, 'crewly');
		fs.mkdirSync(path.join(process.env.CREWLY_HOME, 'logs', 'sessions'), { recursive: true });
		fs.mkdirSync(mockHome.dir, { recursive: true });
		logFile = path.join(process.env.CREWLY_HOME, 'logs', 'sessions', 'orc.log');
		fs.writeFileSync(logFile, `export GEMINI_API_KEY=${KEY}\n`);
		historyFile = path.join(mockHome.dir, '.bash_history');
		fs.writeFileSync(historyFile, `export GEMINI_API_KEY="${KEY}"\n`);
		logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
		errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		mockHome.dir = '';
		fs.rmSync(root, { recursive: true, force: true });
		logSpy.mockRestore();
		errSpy.mockRestore();
	});

	/** Everything printed, as one string */
	function printed(): string {
		return [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => c.join(' ')).join('\n');
	}

	it('dry run by default: prints counts only and changes nothing', async () => {
		const code = await securityCommand('scrub-logs', {});
		expect(code).toBe(0);
		expect(printed()).toContain('Dry run: 2 file(s) scanned, 2 secret(s) found in 2 file(s)');
		expect(printed()).toContain('--apply');
		expect(printed()).not.toContain(KEY);
		expect(fs.readFileSync(logFile, 'utf8')).toContain(KEY);
		expect(fs.readFileSync(historyFile, 'utf8')).toContain(KEY);
	});

	it('--apply masks in place and a second run finds nothing', async () => {
		expect(await securityCommand('scrub-logs', { apply: true })).toBe(0);
		expect(printed()).toContain('2 secret(s) masked in 2 file(s), 2 rewritten');
		expect(fs.readFileSync(logFile, 'utf8')).toBe('export GEMINI_API_KEY=[REDACTED]\n');
		expect(fs.readFileSync(historyFile, 'utf8')).toBe('export GEMINI_API_KEY="[REDACTED]"\n');

		logSpy.mockClear();
		expect(await securityCommand('scrub-logs', { apply: true })).toBe(0);
		expect(printed()).toContain('0 secret(s) masked in 0 file(s), 0 rewritten');
	});

	it('--no-shell-history leaves history alone', async () => {
		await securityCommand('scrub-logs', { apply: true, shellHistory: false });
		expect(fs.readFileSync(historyFile, 'utf8')).toContain(KEY);
		expect(fs.readFileSync(logFile, 'utf8')).not.toContain(KEY);
	});

	it('rejects an unknown action', async () => {
		expect(await securityCommand('nope', {})).toBe(1);
		expect(printed()).toContain('Unknown action');
	});

	it('formatScrubSummary shows an error line without content', () => {
		const lines = formatScrubSummary({
			applied: false, filesScanned: 1, filesWithSecrets: 0, filesRewritten: 0, secrets: 0, errors: 1,
			files: [{ path: '/x/y.gz', kind: 'session-log-archive', secrets: 0, rewritten: false, error: 'Z_DATA_ERROR' }],
		});
		expect(lines.join('\n')).toContain('error  /x/y.gz (Z_DATA_ERROR)');
		expect(lines[lines.length - 1]).toContain('1 error(s)');
	});
});
