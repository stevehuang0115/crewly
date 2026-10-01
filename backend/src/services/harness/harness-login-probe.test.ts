/**
 * Tests for the live sign-in probe. The CLIs are fake scripts in a temp
 * directory, run with a temp HOME / CLAUDE_CONFIG_DIR / CODEX_HOME — never
 * the real ones, and never a real login or logout.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { classifyClaudeProbe, createHarnessLoginProbe } from './harness-login-probe.js';

describe('classifyClaudeProbe', () => {
	it.each([
		['Not logged in · Please run /login', 1],
		['Login expired · Please run /login', 1],
		['OAuth token revoked · Please run /login', 1],
		['API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}} · Please run /login', 1],
	])('"%s" → logged_out', (out, code) => {
		expect(classifyClaudeProbe({ code, stdout: out, stderr: '' })).toBe('logged_out');
	});

	it('a clean answer → logged_in; anything else → unknown', () => {
		expect(classifyClaudeProbe({ code: 0, stdout: 'OK', stderr: '' })).toBe('logged_in');
		expect(classifyClaudeProbe({ code: 1, stdout: '', stderr: 'API Error: Connection error.' })).toBe('unknown');
		expect(classifyClaudeProbe({ code: null, stdout: '', stderr: '' })).toBe('unknown');
		// The warning that a login *will* expire is not an expiry.
		expect(classifyClaudeProbe({ code: 0, stdout: 'OK\nYour login expires in 3 days · run /login to renew', stderr: '' })).toBe('logged_in');
	});
});

describe('createHarnessLoginProbe (fake CLIs, temp homes)', () => {
	let dir: string;
	let bin: string;
	let home: string;

	/**
	 * Write an executable fake CLI.
	 *
	 * @param name - Command name
	 * @param body - Shell body
	 */
	function fakeCli(name: string, body: string): void {
		const file = path.join(bin, name);
		fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}

	/**
	 * Probe with the fake bin dir and temp homes.
	 *
	 * @param env - Extra env
	 * @returns The probe
	 */
	function probe(env: Record<string, string> = {}) {
		return createHarnessLoginProbe({
			env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex'), ...env },
			homeDir: home,
			resolveCommand: (cmd) => (fs.existsSync(path.join(bin, cmd)) ? path.join(bin, cmd) : null),
			credentials: { harnessEnvForAgents: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake' }) },
			scratchDir: path.join(dir, 'scratch'),
			timeoutMs: 10_000,
		});
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-probe-'));
		bin = path.join(dir, 'bin');
		home = path.join(dir, 'home');
		fs.mkdirSync(bin);
		fs.mkdirSync(home);
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('Claude signed out → logged_out (the probe runs a print-mode turn in the scratch dir with the agent env)', async () => {
		const log = path.join(dir, 'args.txt');
		fakeCli('claude', `echo "$@" > ${log}; pwd >> ${log}; echo "token=$CLAUDE_CODE_OAUTH_TOKEN api=\${CREWLY_API_TOKEN:-none}" >> ${log}; echo 'Not logged in · Please run /login'; exit 1`);
		expect(await probe({ CREWLY_API_TOKEN: 'secret' })('claude-code')).toBe('logged_out');
		const [args, cwd, env] = fs.readFileSync(log, 'utf8').trim().split('\n');
		expect(args).toBe(HARNESS_CONSTANTS.CLAUDE.PROBE_ARGS.join(' '));
		expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(path.join(dir, 'scratch')));
		expect(env).toBe('token=sk-ant-oat01-fake api=none');
	});

	it('Claude signed in → logged_in; a network error → unknown; no claude binary → unknown', async () => {
		fakeCli('claude', 'echo OK; exit 0');
		expect(await probe()('claude-code')).toBe('logged_in');
		fakeCli('claude', "echo 'API Error: Connection error.' >&2; exit 1");
		expect(await probe()('claude-code')).toBe('unknown');
		fs.rmSync(path.join(bin, 'claude'));
		expect(await probe()('claude-code')).toBe('unknown');
	});

	it('Codex: `codex login status` exit code decides', async () => {
		fakeCli('codex', '[ "$1 $2" = "login status" ] || exit 9; echo "Not logged in"; exit 1');
		expect(await probe()('codex-cli')).toBe('logged_out');
		fakeCli('codex', '[ "$1 $2" = "login status" ] || exit 9; echo "Logged in using ChatGPT"; exit 0');
		expect(await probe()('codex-cli')).toBe('logged_in');
	});

	it('harnesses without a probe → unknown', async () => {
		expect(await probe()('antigravity-cli')).toBe('unknown');
	});
});
