import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import { isAgentStatusMarker } from '../../../../../../backend/src/controllers/chat/chat.controller.js';

/**
 * specs/2026-10-02-harness-owned-routing.md: the payloads the skills really
 * send to `/api/chat/agent-response`, captured from the real scripts.
 * Status payloads must read as status lines (so they never reach the owner);
 * the person-facing skills mark themselves with `intent: "message"`.
 */

const CORE = join(__dirname, '..', '..');

let server: Server;
let baseUrl: string;
let posted: Array<Record<string, unknown>>;

beforeAll((done) => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			const path = (req.url ?? '').split('?')[0];
			if (path === '/api/chat/agent-response') {
				try { posted.push(JSON.parse(raw)); } catch { /* ignore */ }
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, data: {} }));
		});
	});
	server.listen(0, '127.0.0.1', () => {
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		done();
	});
});

afterAll((done) => { server.close(() => done()); });
beforeEach(() => { posted = []; });

/**
 * Runs a core skill against the stub API.
 *
 * @param skill - Skill directory name
 * @param args - CLI arguments
 * @returns When it exits
 */
function run(skill: string, args: string[]): Promise<void> {
	const env: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'dev-1' };
	return new Promise((resolve) => {
		execFile('bash', [join(CORE, skill, 'execute.sh'), ...args], { env, timeout: 60_000 }, () => resolve());
	});
}

describe('skill payloads to agent-response (2026-10-02)', () => {
	it('report-status --structured sends a status line with real newlines', async () => {
		await run('report-status', ['--session', 'dev-1', '--status', 'done', '--summary', 'Shipped the API and its tests pass.', '--task-id', 'task-1', '--structured']);
		const content = String(posted[0]?.content ?? '');
		expect(content.startsWith('---\n[STATUS REPORT]\n')).toBe(true);
		expect(content).not.toContain('\\n');
		expect(isAgentStatusMarker(content)).toBe(true);
		expect(posted[0]?.intent).toBeUndefined();
	});

	it('report-status milestone is a status line', async () => {
		await run('report-status', ['--session', 'dev-1', '--status', 'milestone', '--summary', 'PR #12 merged — checkout takes Apple Pay; owners see it on the next deploy']);
		const content = String(posted[0]?.content ?? '');
		expect(content.startsWith('[MILESTONE]')).toBe(true);
		expect(isAgentStatusMarker(content)).toBe(true);
	});

	it('complete-task --structured sends a [VERIFICATION REQUEST] status line with real newlines', async () => {
		await run('complete-task', [JSON.stringify({ workItemId: 'wi-1', sessionName: 'dev-1', summary: 'API done.', taskId: 'task-1', structured: true })]);
		const ver = posted.find((p) => String(p.content).includes('[VERIFICATION REQUEST]'));
		expect(ver).toBeDefined();
		expect(String(ver!.content)).not.toContain('\\n');
		expect(isAgentStatusMarker(String(ver!.content))).toBe(true);
	});

	it('handoff-task notice is a status line', async () => {
		await run('handoff-task', [JSON.stringify({ sessionName: 'dev-1', to: 'dev-2', workItemId: 'wi-1', reason: 'switching to the billing bug' })]);
		const notice = posted.find((p) => String(p.content).startsWith('[HANDOFF]'));
		expect(notice).toBeDefined();
		expect(isAgentStatusMarker(String(notice!.content))).toBe(true);
	});

	it('reply-chat and send-chat-response mark themselves as messages for a person', async () => {
		await run('reply-chat', ['--sender', 'dev-1', '--thread', 'C0C2Y1FRCP7:1790897084.888289', '--text', 'Here is the preview']);
		await run('send-chat-response', [JSON.stringify({ content: 'Here is the preview', senderName: 'dev-1' })]);
		expect(posted.map((p) => p.intent)).toEqual(['message', 'message']);
	});

	it('the old literal-\\n structured payload still reads as status (older skills in the field)', () => {
		expect(isAgentStatusMarker('---\\n[STATUS REPORT]\\nTask ID: task-1')).toBe(true);
		expect(isAgentStatusMarker('---\\n[VERIFICATION REQUEST]\\nTask ID: task-1')).toBe(true);
	});
});
