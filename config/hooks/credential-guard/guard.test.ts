/**
 * Tests for the credential guard hook (specs/2026-10-04-agent-credential-isolation.md, layer 2).
 *
 * Runs the real script with the paths file the backend writes, in every
 * input/output format it speaks. Includes the 2026-10-04 incident commands.
 */

import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildCredentialGuardPathsBody } from '../../../backend/src/services/agent/credential-guard.service.js';

const HOOK = join(__dirname, 'guard.sh');

let home: string;
let crewlyHome: string;
let pathsFile: string;

/** Env the hook sees in an agent session. */
function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: home,
		CREWLY_SESSION_NAME: 'biblestudy-ruth-2090d4cc',
		CREWLY_API_URL: 'http://127.0.0.1:9',
		...extra,
	};
}

/** Run the hook. */
function run(format: string, payload: unknown, env: NodeJS.ProcessEnv = agentEnv()) {
	const r = spawnSync('bash', [HOOK, format, pathsFile], { input: JSON.stringify(payload), encoding: 'utf-8', env });
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A Claude Code / Codex Bash call. */
const bash = (command: string, cwd = '/tmp') => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd });

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'credguard-home-'));
	crewlyHome = join(home, '.crewly');
	mkdirSync(join(crewlyHome, 'runtime', 'credential-guard'), { recursive: true });
	pathsFile = join(crewlyHome, 'runtime', 'credential-guard', 'paths');
	writeFileSync(
		pathsFile,
		buildCredentialGuardPathsBody(crewlyHome, [
			{ id: 'cloud-config', path: join(crewlyHome, 'cloud'), isDirectory: true },
			{ id: 'api-token', path: join(crewlyHome, 'api-token'), isDirectory: false },
			{ id: 'settings-api-keys', path: join(crewlyHome, 'settings.json'), isDirectory: false },
			{ id: 'secret-store', path: join(home, '.local', 'share', 'crewly', 'secrets', 'abc'), isDirectory: true },
		]),
	);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('the 2026-10-04 incident', () => {
	it("blocks Ruth's `jq -r .token ~/.crewly/cloud/config.json` (Claude/Codex: exit 2 + reason)", () => {
		const r = run('claude', bash('curl -H "Authorization: Bearer $(jq -r .token ~/.crewly/cloud/config.json)" https://api.crewlyai.com/api/cloud/google/workspace/token'));
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/cloud-config/);
		expect(r.stderr).toMatch(/not available to agents/);
		expect(r.stderr).toMatch(/docs-read|drive-read/);
	});

	it("blocks agy's view_file of the cloud config (antigravity: JSON deny, exit 0)", () => {
		const r = run('antigravity', { toolCall: { name: 'view_file', args: { AbsolutePath: join(crewlyHome, 'cloud', 'config.json') } }, workspacePaths: ['/tmp'] });
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout);
		expect(out.decision).toBe('deny');
		expect(out.reason).toMatch(/Crewly credentials are not available to agents/);
	});

	it('blocks agy run_command with the token in a $HOME path', () => {
		const r = run('antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'cat $HOME/.crewly/api-token', Cwd: '/tmp' } } });
		expect(JSON.parse(r.stdout).decision).toBe('deny');
	});
});

describe('what is blocked', () => {
	it.each([
		['absolute path', `cat ${crewlyHomeFor('api-token')}`],
		['${HOME}', 'cat "${HOME}/.crewly/cloud/config.json"'],
		['quoted ~ path', "jq . '~/.crewly/cloud/config.json'"],
		['$CREWLY_HOME', 'cat $CREWLY_HOME/api-token'],
		['double slash', 'cat ~/.crewly//cloud/config.json'],
		['the directory itself', 'ls ~/.crewly/cloud'],
		['settings.json keys', 'jq .apiKeys ~/.crewly/settings.json'],
		['tail from another dir', 'cd ~ && cat .crewly/api-token'],
		['the file secret store', 'ls ~/.local/share/crewly/secrets/abc'],
		['keychain item', 'security find-generic-password -s crewly:vault-key -w'],
		['keychain via -i', 'echo "find-generic-password -s crewly:vault-key -w" | security -i'],
		['keychain dump', '/usr/bin/security dump-keychain -d login.keychain'],
	])('%s', (_name, command) => {
		const cmd = command.replace('__HOME__', home);
		expect(run('codex', bash(cmd)).status).toBe(2);
	});

	it('a relative path when the cwd is inside the Crewly home', () => {
		expect(run('claude', bash('cat cloud/config.json', crewlyHome)).status).toBe(2);
		expect(run('claude', bash('cat ./api-token', crewlyHome)).status).toBe(2);
		expect(run('claude', bash(`cd ${crewlyHome} && cat api-token`)).status).toBe(2);
	});

	it('the Claude Read / Grep tools and Gemini read_file', () => {
		expect(run('claude', { tool_name: 'Read', tool_input: { file_path: join(crewlyHome, 'api-token') }, cwd: '/tmp' }).status).toBe(2);
		expect(run('claude', { tool_name: 'Grep', tool_input: { pattern: 'token', path: join(crewlyHome, 'cloud') }, cwd: '/tmp' }).status).toBe(2);
		expect(run('gemini', { tool_name: 'read_file', tool_input: { absolute_path: join(crewlyHome, 'cloud', 'config.json') } }).status).toBe(2);
	});
});

describe('what is allowed', () => {
	it.each([
		['other files in the Crewly home', 'cat ~/.crewly/teams/t1/config.json'],
		['a similar name', 'cat ~/.crewly/api-tokens-notes.md'],
		['cloud elsewhere', 'ls ~/projects/cloud/config.json'],
		['an unrelated security call', 'security find-certificate -a -c Apple'],
		['words in a message', 'git commit -m "rotate the api token and cloud config"'],
	])('%s', (_name, command) => {
		const r = run('claude', bash(command));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe('');
	});

	it('a relative `cloud` outside the Crewly home', () => {
		expect(run('claude', bash('cat cloud/config.json', '/srv/app')).status).toBe(0);
	});

	it('agy: an allowed call prints NOTHING (agy reads `{}` as deny)', () => {
		const r = run('antigravity', { toolCall: { name: 'run_command', args: { CommandLine: 'ls -la', Cwd: '/tmp' } } });
		expect(r.status).toBe(0);
		expect(r.stdout).toBe('');
	});

	it("the owner's own runtime (no CREWLY_SESSION_NAME) is never judged", () => {
		const env = agentEnv();
		delete env.CREWLY_SESSION_NAME;
		const r = run('antigravity', { toolCall: { name: 'view_file', args: { AbsolutePath: join(crewlyHome, 'api-token') } } }, env);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe('');
	});

	it('a missing paths file: agy allows (fail-open, never a dead agent); others report a non-blocking error', () => {
		const payload = bash('cat ~/.crewly/api-token');
		const a = spawnSync('bash', [HOOK, 'antigravity', join(home, 'nope')], { input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'x' } } }), encoding: 'utf-8', env: agentEnv() });
		expect(a.status).toBe(0);
		expect(a.stdout).toBe('');
		const c = spawnSync('bash', [HOOK, 'claude', join(home, 'nope')], { input: JSON.stringify(payload), encoding: 'utf-8', env: agentEnv() });
		expect(c.status).toBe(1);
		expect(c.stderr).toMatch(/NO PATHS CHECKED/);
	});

	it('reads the paths file from CREWLY_CREDENTIAL_GUARD_PATHS when no argument is given', () => {
		const r = spawnSync('bash', [HOOK, 'claude'], { input: JSON.stringify(bash('cat ~/.crewly/api-token')), encoding: 'utf-8', env: agentEnv({ CREWLY_CREDENTIAL_GUARD_PATHS: pathsFile }) });
		expect(r.status).toBe(2);
	});
});

describe('detection', () => {
	let server: Server;
	afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

	it('reports the block to the backend with the rule id, never the command', async () => {
		const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
		server = createServer((req, res) => {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				received.push({ headers: req.headers, body });
				res.writeHead(202).end('{}');
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		const port = (server.address() as { port: number }).port;
		const child = spawn('bash', [HOOK, 'claude', pathsFile], { env: agentEnv({ CREWLY_API_URL: `http://127.0.0.1:${port}`, CREWLY_AGENT_BADGE: 'badge-x' }) });
		child.stdin.end(JSON.stringify(bash('cat ~/.crewly/api-token')));
		const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
		expect(status).toBe(2);
		expect(received).toHaveLength(1);
		expect(received[0].headers['x-agent-session']).toBe('biblestudy-ruth-2090d4cc');
		expect(received[0].headers['x-agent-badge']).toBe('badge-x');
		expect(JSON.parse(received[0].body)).toEqual({ event: 'CredentialAccessBlocked', rule: 'api-token', runtime: 'claude' });
		expect(received[0].body).not.toContain('cat');
	});
});

/** `__HOME__/.crewly/<rel>` (expanded per test). */
function crewlyHomeFor(rel: string): string {
	return `__HOME__/.crewly/${rel}`;
}
