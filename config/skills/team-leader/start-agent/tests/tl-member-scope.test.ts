import { execFile } from 'child_process';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { join } from 'path';

/**
 * Behavioural tests for the team lead's start-agent / stop-agent scope check (#930).
 *
 * Every Marketing member had `parentMemberId = null`, and both scripts required
 * `member.parentMemberId == tlMemberId`, so the lead (Ella) could not start a
 * single one of her own members and the orchestrator had to.
 *
 * These run the real `execute.sh` scripts against a stub API on a random port
 * and record which start/stop calls reach it.
 */

const START_SKILL = join(__dirname, '..', 'execute.sh');
const STOP_SKILL = join(__dirname, '..', '..', 'stop-agent', 'execute.sh');

const TL = 'tl-ella';
const OTHER_TL = 'tl-sam';

interface StubMember {
	id: string;
	parentMemberId?: string | null;
	canDelegate?: boolean;
}

/** Teams served by the stub, by id. */
const TEAMS: Record<string, { id: string; leaderIds?: string[]; members: StubMember[] }> = {
	marketing: {
		id: 'marketing',
		leaderIds: [TL],
		members: [
			{ id: TL, parentMemberId: null, canDelegate: true },
			{ id: 'dana', parentMemberId: null },
			{ id: 'luna', parentMemberId: TL },
			{ id: 'grace', parentMemberId: OTHER_TL },
		],
	},
	product: {
		id: 'product',
		leaderIds: [OTHER_TL],
		members: [
			{ id: OTHER_TL, parentMemberId: null, canDelegate: true },
			{ id: 'leo', parentMemberId: null },
		],
	},
	// A team whose leader is only marked through canDelegate (no leaderIds).
	ops: {
		id: 'ops',
		members: [
			{ id: TL, parentMemberId: null, canDelegate: true },
			{ id: 'ivy', parentMemberId: null },
		],
	},
	// The caller is a plain member here, not a leader.
	research: {
		id: 'research',
		leaderIds: ['tl-atlas'],
		members: [
			{ id: 'tl-atlas', parentMemberId: null, canDelegate: true },
			{ id: TL, parentMemberId: null },
			{ id: 'sage', parentMemberId: null },
		],
	},
};

let server: Server;
let baseUrl: string;
let lifecycleCalls: string[];

beforeAll((done) => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = req.url ?? '';
		req.resume();
		req.on('end', () => {
			const teamMatch = url.match(/^\/api\/teams\/([^/]+)$/);
			if (req.method === 'GET' && teamMatch) {
				const team = TEAMS[teamMatch[1]];
				res.writeHead(team ? 200 : 404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(team ? { success: true, data: team } : { success: false, error: 'Team not found' }));
				return;
			}
			const lifecycle = url.match(/^\/api\/teams\/([^/]+)\/members\/([^/]+)\/(start|stop)$/);
			if (req.method === 'POST' && lifecycle) {
				lifecycleCalls.push(`${lifecycle[3]}:${lifecycle[1]}/${lifecycle[2]}`);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ success: true }));
				return;
			}
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: false }));
		});
	});
	server.listen(0, '127.0.0.1', () => {
		baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		done();
	});
});

afterAll((done) => {
	server.close(() => done());
});

beforeEach(() => {
	lifecycleCalls = [];
});

/**
 * Runs a skill script against the stub API.
 *
 * @param script - Path to execute.sh
 * @param teamId - Team the request names
 * @param memberId - Member to start or stop
 * @returns Exit code and stderr
 */
function run(script: string, teamId: string, memberId: string): Promise<{ code: number; stderr: string }> {
	const env: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'marketing-ella' };
	const payload = JSON.stringify({ teamId, memberId, tlMemberId: TL });
	return new Promise((resolve) => {
		execFile('bash', [script, payload], { env, timeout: 30_000 }, (err, _stdout, stderr) => {
			const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
			resolve({ code, stderr });
		});
	});
}

describe.each([
	['start-agent', START_SKILL, 'start'],
	['stop-agent', STOP_SKILL, 'stop'],
])('team-leader %s scope (#930)', (_name, script, verb) => {
	it('allows a parentless member of the team the TL leads', async () => {
		const result = await run(script, 'marketing', 'dana');
		expect(result.code).toBe(0);
		expect(lifecycleCalls).toEqual([`${verb}:marketing/dana`]);
	});

	it('allows a parentless member when the TL leads through canDelegate only', async () => {
		const result = await run(script, 'ops', 'ivy');
		expect(result.code).toBe(0);
		expect(lifecycleCalls).toEqual([`${verb}:ops/ivy`]);
	});

	it('still allows a direct subordinate', async () => {
		const result = await run(script, 'marketing', 'luna');
		expect(result.code).toBe(0);
		expect(lifecycleCalls).toEqual([`${verb}:marketing/luna`]);
	});

	it('refuses a member of another team', async () => {
		const result = await run(script, 'product', 'leo');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('is not a member of this team');
		expect(lifecycleCalls).toEqual([]);
	});

	it('refuses a member whose parent is someone else', async () => {
		const result = await run(script, 'marketing', 'grace');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('Hierarchy violation');
		expect(lifecycleCalls).toEqual([]);
	});

	it('refuses a parentless member of a team the TL does not lead', async () => {
		const result = await run(script, 'research', 'sage');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('does not lead this team');
		expect(lifecycleCalls).toEqual([]);
	});

	it('refuses a member that is not in the team', async () => {
		const result = await run(script, 'marketing', 'nobody');
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('not in this team');
		expect(lifecycleCalls).toEqual([]);
	});
});
