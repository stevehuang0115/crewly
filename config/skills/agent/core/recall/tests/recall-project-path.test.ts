import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * Behavioural tests for recall's projectPath default (#816).
 *
 * `remember` has defaulted `projectPath` from `CREWLY_PROJECT_PATH` since
 * #187; `recall` did not, so a recall from an agent shell that omitted the
 * path searched agent memory only. These run the real `execute.sh` against
 * a stub API and assert the body it sends.
 */

const SKILL = join(__dirname, '..', 'execute.sh');

let server: Server;
let baseUrl: string;
let bodies: Array<Record<string, unknown>>;

/**
 * Runs the skill with the stub API wired in.
 *
 * @param args - CLI arguments for execute.sh
 * @param env - Extra environment variables (undefined removes one)
 * @returns exit code
 */
function runSkill(args: string[], env: Record<string, string | undefined>): Promise<number> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'dev-1' };
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	return new Promise((resolve) => {
		execFile('bash', [SKILL, ...args], { env: childEnv, timeout: 60_000 }, (err) => {
			resolve(err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0);
		});
	});
}

beforeAll((done) => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c as Buffer));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			if ((req.url ?? '').startsWith('/api/memory/recall')) {
				bodies.push(raw ? JSON.parse(raw) : {});
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true, data: { agentMemories: [], projectMemories: [] } }));
		});
	});
	server.listen(0, '127.0.0.1', () => {
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		done();
	});
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => { bodies = []; });

const BASE_INPUT = { agentId: 'dev-1', context: 'decisions in force' };

describe('recall projectPath default (#816)', () => {
	it('defaults projectPath from CREWLY_PROJECT_PATH when none is given', async () => {
		expect(await runSkill([JSON.stringify(BASE_INPUT)], { CREWLY_PROJECT_PATH: '/tmp/env-proj' })).toBe(0);
		expect(bodies).toHaveLength(1);
		expect(bodies[0].projectPath).toBe('/tmp/env-proj');
	});

	it('an explicit projectPath wins over CREWLY_PROJECT_PATH', async () => {
		await runSkill([JSON.stringify({ ...BASE_INPUT, projectPath: '/tmp/explicit' })], { CREWLY_PROJECT_PATH: '/tmp/env-proj' });
		expect(bodies).toHaveLength(1);
		expect(bodies[0].projectPath).toBe('/tmp/explicit');
	});

	it('sends no projectPath when neither is set', async () => {
		await runSkill([JSON.stringify(BASE_INPUT)], { CREWLY_PROJECT_PATH: undefined });
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).not.toHaveProperty('projectPath');
	});
});
