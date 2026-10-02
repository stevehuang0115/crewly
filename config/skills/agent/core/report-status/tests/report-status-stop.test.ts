import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * `report-status blocked|failed` moves the WorkItem (#842).
 *
 * Only `done` used to touch the pool. A blocked or failed report reached the
 * orchestrator's chat and nothing else: the WorkItem stayed `running` with its
 * claim held, its team lead was never told, and the reason lived only in a
 * chat message (think-tank-sage, WI fe2421ae, 2026-09-27).
 *
 * These run the real `execute.sh` against a stub API and record the calls.
 */

const SKILL = join(__dirname, '..', 'execute.sh');

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown>;
}

let server: Server;
let baseUrl: string;
let calls: Call[];
let runningIds: string[];

beforeAll((done) => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let body: Record<string, unknown> = {};
			try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep empty */ }
			const path = (req.url ?? '').split('?')[0];
			calls.push({ method: req.method ?? '', path, body });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			if (req.method === 'GET' && path === '/api/task-pool/items') {
				res.end(JSON.stringify({ success: true, data: runningIds.map((id) => ({ id, status: 'running' })) }));
				return;
			}
			res.end(JSON.stringify({ success: true, data: {} }));
		});
	});
	server.listen(0, '127.0.0.1', () => {
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		done();
	});
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
	calls = [];
	runningIds = [];
});

/**
 * Runs the skill with the stub API wired in.
 *
 * @param args - CLI arguments
 * @returns Exit code and stderr
 */
function runSkill(args: string[]): Promise<{ code: number; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'think-tank-sage' };
	return new Promise((resolve) => {
		execFile('bash', [SKILL, ...args], { env, timeout: 60_000 }, (err, _stdout, stderr) => {
			const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
			resolve({ code, stderr });
		});
	});
}

/** The pool stop calls (block / fail) the skill made. */
const stopCalls = (): Call[] => calls.filter((c) => /^\/api\/task-pool\/(block|fail)\//.test(c.path));

const REASON = 'needs_alignment: the sermon transcripts are copyrighted; need the owner to confirm use';

describe('report-status blocked/failed moves the WorkItem (#842)', () => {
	it('blocked with a workItemId blocks that item and stores the reason', async () => {
		const { code } = await runSkill(['--session', 'think-tank-sage', '--status', 'blocked', '--summary', REASON, '--work-item-id', 'fe2421ae']);
		expect(code).toBe(0);
		expect(stopCalls()).toEqual([
			{ method: 'POST', path: '/api/task-pool/block/fe2421ae', body: { agentId: 'think-tank-sage', reason: REASON } },
		]);
		// The status report to the chat still goes out.
		expect(calls.some((c) => c.path === '/api/chat/agent-response')).toBe(true);
	});

	it('failed without a workItemId fails the one running item', async () => {
		runningIds = ['wi-only'];
		const { code, stderr } = await runSkill(['--session', 'think-tank-sage', '--status', 'failed', '--summary', 'The upstream API was removed']);
		expect(code).toBe(0);
		expect(stopCalls()).toEqual([
			{ method: 'POST', path: '/api/task-pool/fail/wi-only', body: { agentId: 'think-tank-sage', error: 'The upstream API was removed' } },
		]);
		expect(stderr).toContain('"resolvedBy": "inferred"');
	});

	it('refuses to guess when several items are running', async () => {
		runningIds = ['wi-a', 'wi-b'];
		const { code, stderr } = await runSkill(['--session', 'think-tank-sage', '--status', 'blocked', '--summary', REASON]);
		expect(code).not.toBe(0);
		expect(stderr).toContain('will not guess');
		expect(stopCalls()).toEqual([]);
	});

	it('does nothing to the pool when no item is running', async () => {
		const { code } = await runSkill(['--session', 'think-tank-sage', '--status', 'blocked', '--summary', REASON]);
		expect(code).toBe(0);
		expect(stopCalls()).toEqual([]);
	});

	it('leaves the pool alone for in-progress updates', async () => {
		runningIds = ['wi-only'];
		await runSkill(['--session', 'think-tank-sage', '--status', 'in_progress', '--summary', 'halfway there']);
		expect(stopCalls()).toEqual([]);
	});
});
