import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * CREW-790: `report-status --status done` without a workItemId must not close
 * a running WorkItem the report is not about.
 *
 * With exactly one running item the skill used to complete it whatever the
 * summary said (a CE-305 report closed the CE-388 item). Now the summary must
 * name the item (full id or 8-char prefix) or its linked ticket id; otherwise
 * the skill refuses, completes nothing, and prints the candidate id.
 */

const SKILL = join(__dirname, '..', 'execute.sh');
const WI = '785db737-5832-4748-ae74-c3df9f2c22c6';
const TICKET = 'CREW-790';
const EVIDENCE = ['--artifact', 'https://github.com/o/r/pull/1'];

interface Call { method: string; path: string }

let server: Server;
let baseUrl: string;
let calls: Call[];

beforeAll((done) => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		req.on('data', () => undefined);
		req.on('end', () => {
			const path = (req.url ?? '').split('?')[0];
			calls.push({ method: req.method ?? '', path });
			res.writeHead(200, { 'Content-Type': 'application/json' });
			if (req.method === 'GET' && path === '/api/task-pool/items') {
				res.end(JSON.stringify({ success: true, data: [{ id: WI, status: 'running', metadata: { projectTicket: { id: TICKET } } }] }));
				return;
			}
			res.end(JSON.stringify({ success: true, message: 'completed' }));
		});
	});
	server.listen(0, '127.0.0.1', () => {
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		done();
	});
});

afterAll((done) => { server.close(() => done()); });
beforeEach(() => { calls = []; });

/** Runs the skill against the stub API. */
function runSkill(args: string[]): Promise<{ code: number; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'dev-1' };
	return new Promise((resolve) => {
		execFile('bash', [SKILL, ...args], { env, timeout: 60_000 }, (err, _stdout, stderr) => {
			const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
			resolve({ code, stderr });
		});
	});
}

const completions = (): Call[] => calls.filter((c) => c.path.startsWith('/api/task-pool/complete/'));
const doneArgs = (summary: string, extra: string[] = []): string[] =>
	['--session', 'dev-1', '--status', 'done', '--summary', summary, ...EVIDENCE, ...extra];

describe('report-status done must name the item it completes (CREW-790)', () => {
	it('refuses a report that names neither the only running item nor its ticket', async () => {
		const { code, stderr } = await runSkill(doneArgs('Pulled the CE-305 card files and checked them'));
		expect(code).not.toBe(0);
		expect(completions()).toEqual([]);
		expect(stderr).toContain(WI);
		expect(stderr).toContain('workItemId');
	});

	it('does not treat a longer ticket id (CREW-7901) as naming CREW-790', async () => {
		const { code } = await runSkill(doneArgs('Finished CREW-7901 follow-up'));
		expect(code).not.toBe(0);
		expect(completions()).toEqual([]);
	});

	it('completes it when the report names the full item id', async () => {
		const { code, stderr } = await runSkill(doneArgs(`Fixed ${WI}`));
		expect(code).toBe(0);
		expect(completions()).toEqual([{ method: 'POST', path: `/api/task-pool/complete/${WI}` }]);
		expect(stderr).toContain('"resolvedBy": "inferred"');
	});

	it('completes it when the report names the 8-char id prefix', async () => {
		const { code } = await runSkill(doneArgs('Work item 785db737 is finished'));
		expect(code).toBe(0);
		expect(completions()).toHaveLength(1);
	});

	it('completes it when the report names its linked ticket', async () => {
		const { code } = await runSkill(doneArgs('CREW-790: report-status now checks the report'));
		expect(code).toBe(0);
		expect(completions()).toEqual([{ method: 'POST', path: `/api/task-pool/complete/${WI}` }]);
	});

	it('explicit workItemId still completes whatever the summary says', async () => {
		const { code, stderr } = await runSkill(doneArgs('Unrelated words only', ['--work-item-id', WI]));
		expect(code).toBe(0);
		expect(completions()).toEqual([{ method: 'POST', path: `/api/task-pool/complete/${WI}` }]);
		expect(stderr).toContain('"resolvedBy": "explicit"');
	});
});
