import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import { join } from 'path';

/**
 * Tests for the agent-status hook (#815, specs/2026-09-26-agent-waiting-on-human.md).
 *
 * Each test runs the real script with a Claude Code hook payload on stdin and
 * a throwaway HTTP server standing in for the backend, then inspects exactly
 * what reached the server. The privacy contract: only the event name, the
 * notification type and the session are ever sent.
 */

const HOOK = join(__dirname, 'report.sh');

interface Captured {
	url: string;
	headers: IncomingHttpHeaders;
	body: string;
}

let server: Server;
let received: Captured[];
let apiUrl: string;

beforeEach(async () => {
	received = [];
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			received.push({ url: req.url ?? '', headers: req.headers, body });
			res.statusCode = 202;
			res.end('{}');
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

/**
 * Run the hook with a payload on stdin (async, so the test server can answer).
 *
 * @param payload - Hook JSON (object is serialised; a string is sent as-is)
 * @param env - Extra environment
 * @returns Exit status and stdout/stderr
 */
function runHook(payload: unknown, env: Record<string, string | undefined> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn('bash', [HOOK], {
			env: { ...process.env, CREWLY_API_URL: apiUrl, CREWLY_SESSION_NAME: 'crewly-dev-1', CREWLY_AGENT_AUTHORIZATION: '', ...env },
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => (stdout += c));
		child.stderr.on('data', (c) => (stderr += c));
		child.on('close', (status) => resolve({ status, stdout, stderr }));
		child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
	});
}

const SECRET = 'sk-ant-api03-THISISAFAKEKEYFORTESTING0123456789abcdef';

describe('agent-status hook (report.sh)', () => {
	it('sends only event, notification type and session for a permission prompt', async () => {
		const r = await runHook({
			session_id: 'abc',
			transcript_path: `/home/user/.claude/projects/x/${SECRET}.jsonl`,
			cwd: '/home/user/project',
			hook_event_name: 'Notification',
			notification_type: 'permission_prompt',
			message: `Claude needs your permission to use Bash: export ANTHROPIC_API_KEY=${SECRET}`,
		});

		expect(r.status).toBe(0);
		expect(received).toHaveLength(1);
		expect(received[0].url).toBe('/api/agent-hooks');
		expect(received[0].headers['x-agent-session']).toBe('crewly-dev-1');
		expect(received[0].headers['user-agent']).toMatch(/^crewly-agent-status-hook\//);
		const body = JSON.parse(received[0].body);
		expect(body).toEqual({ event: 'Notification', notificationType: 'permission_prompt' });
		expect(Object.keys(body).sort()).toEqual(['event', 'notificationType']);
	});

	it('never forwards tool_input, the transcript or a key-looking string, and prints nothing', async () => {
		const r = await runHook({
			hook_event_name: 'PostToolUse',
			tool_name: 'Bash',
			tool_input: { command: `curl -H "x-api-key: ${SECRET}" https://api.example.com` },
			tool_response: { stdout: SECRET },
			transcript_path: `/tmp/${SECRET}`,
		});

		expect(r.status).toBe(0);
		expect(received).toHaveLength(1);
		const wire = received[0].body + JSON.stringify(received[0].headers);
		expect(wire).not.toContain(SECRET);
		expect(wire).not.toContain('sk-ant');
		expect(wire).not.toContain('tool_input');
		expect(JSON.parse(received[0].body)).toEqual({ event: 'PostToolUse' });
		expect(r.stdout + r.stderr).toBe('');
	});

	it('drops a field that is not a plain identifier instead of sending it', async () => {
		await runHook({ hook_event_name: 'Notification', notification_type: `x","leak":"${SECRET}` });
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0].body)).toEqual({ event: 'Notification' });
		expect(received[0].body).not.toContain(SECRET);
	});

	it('sends nothing without a session or an event name, and still exits 0', async () => {
		expect((await runHook({ hook_event_name: 'Stop' }, { CREWLY_SESSION_NAME: '' })).status).toBe(0);
		expect((await runHook({ notification_type: 'permission_prompt' })).status).toBe(0);
		expect((await runHook('not json at all')).status).toBe(0);
		expect(received).toHaveLength(0);
	});

	it('exits 0 quickly when the backend is unreachable', async () => {
		const started = Date.now();
		const r = await runHook({ hook_event_name: 'Stop' }, { CREWLY_API_URL: 'http://127.0.0.1:9' });
		expect(r.status).toBe(0);
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it('works without jq (sed fallback), still sending only identifiers', async () => {
		// A PATH with only the tools the fallback needs, and provably no jq.
		const bin = mkdtempSync(join(tmpdir(), 'nojq-'));
		for (const tool of ['bash', 'cat', 'tr', 'sed', 'grep', 'curl', 'base64']) {
			const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).stdout.trim();
			if (found) symlinkSync(found, join(bin, tool));
		}
		expect(spawnSync(join(bin, 'bash'), ['-c', 'command -v jq'], { env: { PATH: bin } }).status).not.toBe(0);

		const r = await runHook(
			{ hook_event_name: 'PermissionRequest', tool_input: { command: SECRET } },
			{ PATH: bin },
		);
		rmSync(bin, { recursive: true, force: true });
		expect(r.status).toBe(0);
		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0].body)).toEqual({ event: 'PermissionRequest' });
		expect(received[0].body).not.toContain(SECRET);
	});
});
