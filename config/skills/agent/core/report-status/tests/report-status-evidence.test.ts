import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * `report-status --status done` sends the evidence block (#873).
 *
 * "Done" needs evidence: artifacts that exist, commands with exit codes, or a
 * blocked step. These run the real `execute.sh` against a stub API and check
 * the completion body it sends and what it prints from the response.
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
let completeResponse: Record<string, unknown>;

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
			if (path.startsWith('/api/task-pool/complete/')) {
				res.end(JSON.stringify(completeResponse));
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
	completeResponse = { success: true, message: 'completed' };
});

/**
 * Runs the skill with the stub API wired in.
 *
 * @param args - CLI arguments
 * @returns Exit code and stderr
 */
function runSkill(args: string[]): Promise<{ code: number; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'dev-1' };
	return new Promise((resolve) => {
		execFile('bash', [SKILL, ...args], { env, timeout: 60_000 }, (err, _stdout, stderr) => {
			const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
			resolve({ code, stderr });
		});
	});
}

/** The body of the completion call, if one was made. */
const completeBody = (): Record<string, unknown> | undefined =>
	calls.find((c) => c.path === '/api/task-pool/complete/wi-1')?.body;

const BASE = ['--session', 'dev-1', '--status', 'done', '--summary', 'Wrote the importer and its tests', '--work-item-id', 'wi-1'];

describe('report-status done sends evidence (#873)', () => {
	it('builds artifact and command entries from flags, in order', async () => {
		const { code } = await runSkill([
			...BASE,
			'--artifact', 'src/importer.ts',
			'--command', 'npx jest src/importer.test.ts', '--exit-code', '0', '--output-tail', 'Tests: 9 passed',
			'--command', 'npx tsc --noEmit', '--exit-code', '0',
			'--artifact', 'https://github.com/o/r/pull/7',
		]);
		expect(code).toBe(0);
		expect(completeBody()).toEqual({
			agentId: 'dev-1',
			result: {
				summary: 'Wrote the importer and its tests',
				evidence: [
					{ type: 'artifact', path: 'src/importer.ts' },
					{ type: 'command', command: 'npx jest src/importer.test.ts', exitCode: 0, outputTail: 'Tests: 9 passed' },
					{ type: 'command', command: 'npx tsc --noEmit', exitCode: 0 },
					{ type: 'artifact', path: 'https://github.com/o/r/pull/7' },
				],
			},
		});
	});

	it('sends a non-zero exit code as given (the server decides)', async () => {
		await runSkill([...BASE, '--command', 'npm test', '--exit-code', '1']);
		expect((completeBody()?.result as { evidence: unknown[] }).evidence).toEqual([{ type: 'command', command: 'npm test', exitCode: 1 }]);
	});

	it('--blocked-step/--blocked-reason send a blocked entry and print that it was recorded as blocked', async () => {
		completeResponse = { success: true, recordedAs: 'blocked', message: 'recorded as BLOCKED' };
		const { code, stderr } = await runSkill([...BASE, '--blocked-step', 'npm test', '--blocked-reason', 'test DB unreachable']);
		expect(code).toBe(0);
		expect((completeBody()?.result as { evidence: unknown[] }).evidence).toEqual([
			{ type: 'blocked', step: 'npm test', reason: 'test DB unreachable' },
		]);
		expect(stderr).toContain('"markedAs": "blocked"');
		expect(stderr).not.toContain('completedWorkItem');
	});

	it('--evidence JSON (and JSON input evidence) is sent ahead of flag entries', async () => {
		await runSkill([...BASE, '--evidence', '[{"type":"artifact","path":"/abs/a.md"}]', '--artifact', 'b.md']);
		expect((completeBody()?.result as { evidence: unknown[] }).evidence).toEqual([
			{ type: 'artifact', path: '/abs/a.md' },
			{ type: 'artifact', path: 'b.md' },
		]);
		calls = [];
		await runSkill([JSON.stringify({
			sessionName: 'dev-1', status: 'done', summary: 'Wrote the importer and its tests', workItemId: 'wi-1',
			evidence: [{ type: 'command', command: 'make', exitCode: 0 }],
		})]);
		expect((completeBody()?.result as { evidence: unknown[] }).evidence).toEqual([{ type: 'command', command: 'make', exitCode: 0 }]);
	});

	it('omits evidence when none is given and prints the server warning', async () => {
		completeResponse = { success: true, message: 'completed', warning: 'Completed WITHOUT evidence.' };
		const { code, stderr } = await runSkill(BASE);
		expect(code).toBe(0);
		expect(completeBody()).toEqual({ agentId: 'dev-1', result: { summary: 'Wrote the importer and its tests' } });
		expect(stderr).toContain('"warning": "Completed WITHOUT evidence."');
		expect(stderr).toContain('"completedWorkItem": "wi-1"');
	});

	it.each([
		[['--command', 'npm test'], 'needs --exit-code'],
		[['--exit-code', '0'], '--exit-code must follow --command'],
		[['--command', 'npm test', '--exit-code', 'zero'], '--exit-code must be an integer'],
		[['--blocked-step', 'deploy'], '--blocked-step and --blocked-reason go together'],
		[['--evidence', '{"type":"artifact"}'], 'evidence must be a JSON array'],
	])('refuses %j before sending anything', async (extra, msg) => {
		const { code, stderr } = await runSkill([...BASE, ...extra]);
		expect(code).not.toBe(0);
		expect(stderr).toContain(msg);
		// lib.sh sends a skill-start heartbeat; nothing else may go out.
		expect(calls.filter((c) => c.path !== '/api/heartbeat')).toEqual([]);
	});
});
