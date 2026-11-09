/**
 * Tests for the trace-read skill against a stub backend: argument → endpoint
 * mapping, the output size bound, the recent-runs list and argument errors.
 */

import { execFile } from 'child_process';
import * as http from 'http';
import * as path from 'path';
import type { AddressInfo } from 'net';

const SCRIPT = path.join(__dirname, 'execute.sh');
const TRACE = 'tr-20261003-0000abcd';

interface Seen {
	method: string;
	url: string;
	session?: string;
}

/** Result of one skill run. */
interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

describe('trace-read skill', () => {
	let server: http.Server;
	let base: string;
	let seen: Seen[];
	/** Length of the summary text the stub returns (ignores maxChars on purpose) */
	let summaryChars: number;

	beforeAll(async () => {
		server = http.createServer((req, res) => {
			// lib.sh's own heartbeat is not part of what the skill asks for.
			if (!(req.url ?? '').startsWith('/api/heartbeat')) seen.push({ method: req.method ?? '', url: req.url ?? '', session: req.headers['x-agent-session'] as string | undefined });
			const url = new URL(req.url ?? '/', 'http://stub');
			const send = (code: number, body: unknown): void => {
				res.writeHead(code, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(body));
			};
			if (url.pathname === '/api/traces/by-ref') {
				if (url.searchParams.get('workItemId') === 'missing') return send(404, { success: false, error: 'No trace' });
				return send(200, { success: true, data: { traceId: TRACE, root: { kind: 'request' } } });
			}
			if (url.pathname === `/api/traces/${TRACE}/summary`) {
				const text = `Trace ${TRACE} · request · Fix it\n${'Key event line with → arrows and · dots\n'.repeat(Math.ceil(summaryChars / 40))}`.slice(0, summaryChars);
				return send(200, { success: true, data: { traceId: TRACE, text, links: { ui: `/tickets/traces/${TRACE}`, api: `/api/traces/${TRACE}/timeline` }, metrics: { traceId: TRACE } } });
			}
			if (url.pathname === '/api/requests/TKT-12/whereabouts') {
				return send(200, { success: true, data: {
					requestId: 'req-1', ticketNumber: 12, title: 'Replicate the video', status: 'running', finished: false,
					summary: 'dex (working on "Dex, replicate it", from pia) for 3h 32m.',
					holders: [
						{ session: 'pia', state: 'waiting_on_agent', since: '2026-10-14T13:46:00.000Z', forMs: 4.2 * 3_600_000, what: 'Pia, you take this', from: 'ella' },
						{ session: 'dex', state: 'working', since: '2026-10-14T14:28:00.000Z', forMs: 212 * 60_000, what: 'Dex, replicate it', from: 'pia' },
					],
				} });
			}
			if (url.pathname.startsWith('/api/requests/')) return send(404, { success: false, error: 'Request not found' });
			if (url.pathname === '/api/projects') {
				return send(200, { success: true, data: [{ id: 'proj-ce', name: 'careerengine', path: '/Users/me/careerengine' }] });
			}
			if (url.pathname === '/api/traces') {
				const tagged = url.searchParams.get('autopilotProject') === 'proj-ce';
				const row = (i: number) => ({
					traceId: `tr-20261003-0000000${i}`,
					root: { kind: 'request', summary: `Run number ${i} ${'x'.repeat(200)}` },
					updatedAt: '2026-10-03T12:00:00.000Z',
					...(tagged ? { tags: { autopilot: { projectId: 'proj-ce', day: '2026-10-03' }, labels: ['CE-7'] } } : {}),
					metrics: {
						state: 'waiting_on_owner', wallMs: 7_500_000, activeMs: 900_000, waitingOwnerMs: 3_600_000, ownerTouches: 2, rework: 1, stalls: 1, ongoingStall: true, interventions: 3, costUsd: 1.234,
						...(tagged ? { stallMs: 5_400_000, stallMsByCause: { runtime_quota: 1_800_000, delivery_failure: 0, waiting_on_owner: 2_700_000, waiting_on_agent: 900_000, nobody_pushing: 0 } } : {}),
					},
				});
				return send(200, { success: true, data: { traces: Array.from({ length: Number(url.searchParams.get('limit') ?? 10) }, (_, i) => row(i)), writeFailures: 0 } });
			}
			return send(404, { success: false, error: 'not found' });
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	beforeEach(() => {
		seen = [];
		summaryChars = 1200;
	});

	/** Run the skill with arguments. */
	const run = (...args: string[]): Promise<Run> =>
		new Promise((resolve) => {
			execFile('bash', [SCRIPT, ...args], { env: { ...process.env, CREWLY_API_URL: base, CREWLY_SESSION_NAME: 'team-lead-1' }, timeout: 30_000 }, (err, stdout, stderr) => {
				const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
				resolve({ code, stdout, stderr });
			});
		});

	it('--where shows who holds a request now', async () => {
		const r = await run('--where', 'TKT-12');
		expect(r.code).toBe(0);
		expect(seen.map((s) => s.url)).toEqual(['/api/requests/TKT-12/whereabouts']);
		expect(r.stdout).toContain('TKT-12 · Replicate the video · running');
		expect(r.stdout).toContain('- dex: working for 3h 32m (since 2026-10-14 14:28) · from pia');
		expect(r.stdout).toContain('- pia: waiting on agent for 4h 12m');
	});

	it('--where fails clearly for an unknown request', async () => {
		const r = await run('--where', 'TKT-99');
		expect(r.code).not.toBe(0);
		expect(r.stdout + r.stderr).toContain('No owner request TKT-99');
	});

	it('reads one run by trace id with the size bound and stall threshold', async () => {
		const r = await run('--trace', TRACE, '--max-chars', '2000', '--stall-minutes', '45');
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`Trace ${TRACE}`);
		expect(seen).toEqual([{ method: 'GET', url: `/api/traces/${TRACE}/summary?maxChars=2000&stallMinutes=45`, session: 'team-lead-1' }]);
	});

	it.each([
		[['--work-item', 'wi-1'], 'workItemId=wi-1'],
		[['--ticket', 'CE-7'], 'ticketId=CE-7'],
		[['--request', 'req 1'], 'requestId=req%201'],
		[['--experiment', 'EXP-3'], 'experimentId=EXP-3'],
	])('resolves %j through by-ref', async (args, query) => {
		const r = await run(...args);
		expect(r.code).toBe(0);
		expect(seen.map((s) => s.url)).toEqual([`/api/traces/by-ref?${query}`, `/api/traces/${TRACE}/summary?maxChars=4000`]);
	});

	it('never prints more than --max-chars, even when the backend sends more', async () => {
		summaryChars = 50_000;
		for (const max of [600, 1000, 4000]) {
			const r = await run('--trace', TRACE, '--max-chars', String(max));
			expect(r.code).toBe(0);
			// Characters, not bytes: the text has multi-byte arrows and dots.
			expect([...r.stdout.replace(/\n$/, '')].length).toBeLessThanOrEqual(max);
		}
		// Below the minimum is raised to it; above the maximum is lowered.
		await run('--trace', TRACE, '--max-chars', '5');
		await run('--trace', TRACE, '--max-chars', '99999');
		expect(seen.slice(-2).map((s) => s.url)).toEqual([`/api/traces/${TRACE}/summary?maxChars=600`, `/api/traces/${TRACE}/summary?maxChars=16000`]);
	});

	it('lists recent runs, one bounded line each', async () => {
		const r = await run('--since', '2026-10-01T00:00:00Z', '--limit', '3');
		expect(r.code).toBe(0);
		expect(seen[0].url).toBe('/api/traces?since=2026-10-01T00%3A00%3A00Z&limit=3');
		const lines = r.stdout.trim().split('\n');
		expect(lines[0]).toBe('3 runs (newest first):');
		expect(lines[1]).toMatch(/^tr-20261003-00000000 · request · 2026-10-03 12:00 · Run number 0 x+ — waiting on owner; wall 2h 5m, active 15m, waiting on owner 1h 0m; touches 2, rework 1, stalls 1 \(one ongoing\), interventions 3, \$1\.23$/);
		expect(lines[lines.length - 1]).toBe('Read one: trace-read --trace <id>');
		const many = await run('--since', '2026-10-01T00:00:00Z', '--limit', '200', '--max-chars', '1500');
		expect(seen[seen.length - 1].url).toBe('/api/traces?since=2026-10-01T00%3A00%3A00Z&limit=100');
		expect([...many.stdout.replace(/\n$/, '')].length).toBeLessThanOrEqual(1500);
	});

	it('closes the window with --until and narrows by project, day and label (#1472)', async () => {
		// --project takes a name: the skill resolves it to the id through GET /api/projects.
		const r = await run('--since', '2026-10-19T00:00:00Z', '--until', '2026-10-26T00:00:00Z', '--project', 'careerengine', '--day', '2026-10-03', '--label', 'CE-7', '--limit', '2', '--json');
		expect(r.code).toBe(0);
		expect(seen.map((s) => s.url)).toEqual([
			'/api/projects',
			'/api/traces?since=2026-10-19T00%3A00%3A00Z&until=2026-10-26T00%3A00%3A00Z&limit=2&autopilotProject=proj-ce&day=2026-10-03&label=CE-7',
		]);
		const out = JSON.parse(r.stdout);
		expect(out.traces).toHaveLength(2);
		expect(out.traces[0]).toMatchObject({ traceId: 'tr-20261003-00000000', project: 'proj-ce', day: '2026-10-03', labels: ['CE-7'], metrics: { stallMsByCause: { runtime_quota: 1_800_000 } } });
		// An unknown project name is passed through as the id.
		await run('--since', '2026-10-19T00:00:00Z', '--project', 'proj-other', '--limit', '1');
		expect(seen[seen.length - 1].url).toBe('/api/traces?since=2026-10-19T00%3A00%3A00Z&limit=1&autopilotProject=proj-other');
		// The text line splits stalled time between the harness, the owner and the team.
		const text = await run('--since', '2026-10-19T00:00:00Z', '--project', 'proj-ce', '--limit', '1');
		expect(text.stdout).toContain('stalls 1 (one ongoing) (harness 30m, owner 45m, team 15m), interventions 3');
		// --max-chars may exceed 16000 for a list; a bad --day is refused.
		const wide = await run('--since', '2026-10-19T00:00:00Z', '--limit', '100', '--max-chars', '64000');
		expect([...wide.stdout.replace(/\n$/, '')].length).toBeGreaterThan(16000);
		const bad = await run('--since', '2026-10-19T00:00:00Z', '--day', 'Friday');
		expect(bad.code).not.toBe(0);
	});

	it('returns JSON with --json', async () => {
		const r = await run('--trace', TRACE, '--json');
		expect(JSON.parse(r.stdout)).toMatchObject({ success: true, traceId: TRACE, links: { ui: `/tickets/traces/${TRACE}` }, metrics: { traceId: TRACE } });
	});

	it('fails clearly on bad input and unknown references', async () => {
		expect((await run()).code).toBe(1);
		expect((await run('--trace', '../../etc/passwd')).stderr).toContain('Not a trace id');
		expect((await run('--trace', TRACE, '--max-chars', 'lots')).code).toBe(1);
		expect((await run('--trace', TRACE, '--stall-minutes', '-1')).code).toBe(1);
		expect((await run('--bogus')).stderr).toContain('Unknown option');
		const missing = await run('--work-item', 'missing');
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain('No trace for that reference');
		expect((await run('--help')).stdout).toContain('Usage:');
	});
});
