import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';
import type { Request, Response, NextFunction } from 'express';

/**
 * Behavioural tests for the learning that `report-status` records (#816).
 *
 * The skill used to post `{agentId, content, type}` to
 * `/memory/record-learning`, but the controller requires `agentRole` and
 * `learning`, so every call 400'd and `2>/dev/null || true` hid it.
 *
 * These run the real `execute.sh` against a stub API on a random port. The
 * `/memory/record-learning` route is served by the REAL controller
 * (`recordLearning`) with only `MemoryService` mocked, so the test fails if
 * the script's payload ever drifts from what the controller accepts again.
 */

const mockRecordLearning = jest.fn().mockResolvedValue(undefined);

jest.mock('../../../../../../backend/src/services/memory/memory.service.js', () => ({
	MemoryService: { getInstance: () => ({ recordLearning: mockRecordLearning }) },
}));

// Imported after the mock is registered so the controller binds to it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { recordLearning } = require('../../../../../../backend/src/controllers/memory/memory.controller.js') as {
	recordLearning: (req: Request, res: Response, next: NextFunction) => Promise<void>;
};

const SKILL = join(__dirname, '..', 'execute.sh');
const LEARNING_PATH = '/api/memory/record-learning';

interface Captured {
	path: string;
	body: Record<string, unknown>;
	status: number;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];

/**
 * Serves one request through the real recordLearning controller, adapting
 * the raw node request/response to the Express shapes it uses.
 *
 * @param body - Parsed JSON request body
 * @param res - Node response to write to
 * @returns The HTTP status the controller produced
 */
async function serveRecordLearning(body: Record<string, unknown>, res: ServerResponse): Promise<number> {
	let status = 200;
	let payload: unknown = {};
	const expressRes = {
		status(code: number) { status = code; return expressRes; },
		json(data: unknown) { payload = data; return expressRes; },
	} as unknown as Response;
	await recordLearning({ body } as Request, expressRes, (err?: unknown) => {
		status = 500;
		payload = { success: false, error: String(err) };
	});
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(payload));
	return status;
}

/**
 * Runs the skill with the stub API wired in.
 *
 * @param args - CLI arguments for execute.sh
 * @param env - Extra environment variables
 * @returns exit code and stdout/stderr
 */
function runSkill(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'dev-1', ...env };
	delete childEnv.CREWLY_ROLE;
	if (env.CREWLY_ROLE !== undefined) childEnv.CREWLY_ROLE = env.CREWLY_ROLE;
	return new Promise((resolve) => {
		execFile('bash', [SKILL, ...args], { env: childEnv, timeout: 60_000 }, (err, stdout, stderr) => {
			const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

beforeAll((done) => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			let body: Record<string, unknown> = {};
			try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep empty */ }
			const path = (req.url ?? '').split('?')[0];
			if (path === LEARNING_PATH) {
				void serveRecordLearning(body, res).then((status) => captured.push({ path, body, status }));
				return;
			}
			captured.push({ path, body, status: 200 });
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

beforeEach(() => {
	captured = [];
	mockRecordLearning.mockReset().mockResolvedValue(undefined);
});

/** All captured calls to the record-learning route. */
const learningCalls = (): Captured[] => captured.filter((c) => c.path === LEARNING_PATH);

const DONE_SUMMARY = 'Fixed the modular prompt so Active Work reaches the agent';

describe('report-status records its learning (#816)', () => {
	it('done: the record-learning call is accepted by the real controller (200)', async () => {
		const { code } = await runSkill(
			['--session', 'dev-1', '--status', 'done', '--summary', DONE_SUMMARY, '--project', '/tmp/proj', '--work-item-id', 'wi-816'],
			{ CREWLY_ROLE: 'developer' },
		);
		expect(code).toBe(0);

		const calls = learningCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].status).toBe(200);
		expect(calls[0].body).toMatchObject({
			agentId: 'dev-1',
			agentRole: 'developer',
			projectPath: '/tmp/proj',
			relatedTask: 'wi-816',
		});
		expect(mockRecordLearning).toHaveBeenCalledTimes(1);
		expect(mockRecordLearning.mock.calls[0][0]).toMatchObject({
			agentId: 'dev-1',
			agentRole: 'developer',
			projectPath: '/tmp/proj',
			learning: `Task completed: ${DONE_SUMMARY}`,
			relatedTask: 'wi-816',
		});
	});

	it('failed: records a "Task failed" learning that the controller accepts', async () => {
		await runSkill(
			['--session', 'dev-1', '--status', 'failed', '--summary', 'Build broke on a missing type', '--project', '/tmp/proj'],
			{ CREWLY_ROLE: 'developer' },
		);
		const calls = learningCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].status).toBe(200);
		expect(mockRecordLearning.mock.calls[0][0].learning).toBe('Task failed: Build broke on a missing type');
		expect(calls[0].body).not.toHaveProperty('relatedTask');
	});

	it('takes the role from the JSON input over CREWLY_ROLE', async () => {
		await runSkill(
			[JSON.stringify({ sessionName: 'dev-1', status: 'done', summary: DONE_SUMMARY, projectPath: '/tmp/proj', role: 'qa' })],
			{ CREWLY_ROLE: 'developer' },
		);
		expect(learningCalls()[0]?.body.agentRole).toBe('qa');
		expect(learningCalls()[0]?.status).toBe(200);
	});

	it('falls back to a generic role when none is known, and is still accepted', async () => {
		await runSkill(['--session', 'dev-1', '--status', 'done', '--summary', DONE_SUMMARY, '--project', '/tmp/proj']);
		expect(learningCalls()[0]?.body.agentRole).toBe('agent');
		expect(learningCalls()[0]?.status).toBe(200);
	});

	it('surfaces a failed learning call on stderr instead of hiding it', async () => {
		mockRecordLearning.mockRejectedValueOnce(new Error('disk full'));
		const { code, stderr } = await runSkill(
			['--session', 'dev-1', '--status', 'done', '--summary', DONE_SUMMARY, '--project', '/tmp/proj'],
			{ CREWLY_ROLE: 'developer' },
		);
		expect(learningCalls()[0]?.status).toBe(500);
		expect(code).toBe(0);
		expect(stderr).toContain('recording the learning FAILED');
	});

	it('does not record a learning for in-progress updates', async () => {
		await runSkill(['--session', 'dev-1', '--status', 'in_progress', '--summary', 'halfway there', '--project', '/tmp/proj']);
		// Guard against a vacuous pass: the status report itself must have gone out.
		expect(captured.length).toBeGreaterThan(0);
		expect(learningCalls()).toHaveLength(0);
	});
});
