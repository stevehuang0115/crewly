import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { createStandingRouter } from './standing.controller.js';
import { StandingAnswersService } from '../../services/memory/standing-answers.service.js';

/**
 * Exercises the router over real HTTP with a real service on a temp dir.
 */
describe('standing controller', () => {
	let tmp: string;
	let projectPath: string;
	let server: http.Server;
	let base: string;

	const call = async (method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> => {
		const res = await fetch(`${base}${url}`, {
			method,
			headers: { 'Content-Type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: res.status, json: (await res.json()) as Record<string, unknown> };
	};

	beforeAll(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standing-ctl-'));
		projectPath = path.join(tmp, 'proj');
		await fs.mkdir(path.join(projectPath, '.crewly', 'knowledge'), { recursive: true });
		await fs.writeFile(path.join(projectPath, '.crewly', 'knowledge', 'decisions.json'), JSON.stringify([
			{ id: 'd1', title: 'Modules', decision: 'use modules', decidedAt: '2026-09-20T00:00:00.000Z', status: 'active' },
		]));
		const app = express();
		app.use(express.json());
		app.use('/api/standing', createStandingRouter(new StandingAnswersService({ crewlyHome: path.join(tmp, 'home') })));
		server = app.listen(0, '127.0.0.1');
		await new Promise((r) => server.once('listening', r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	afterAll(async () => {
		await new Promise((r) => server.close(r));
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it('GET requires a project or a session', async () => {
		expect((await call('GET', '/api/standing')).status).toBe(400);
	});

	it('GET lists page statuses with a count of what it examined', async () => {
		const { status, json } = await call('GET', `/api/standing?projectPath=${encodeURIComponent(projectPath)}`);
		expect(status).toBe(200);
		const data = json.data as { pagesExamined: number; pages: Array<Record<string, unknown>> };
		expect(data.pagesExamined).toBe(3);
		expect(data.pages[0]).toMatchObject({ pageId: 'decisions-in-force', exists: false, stale: true, entriesInScope: 1, newerEntries: 1 });
	});

	it('PUT writes a section; GET then reports the page fresh', async () => {
		const put = await call('PUT', '/api/standing/decisions-in-force/section', { projectPath, heading: 'Prompts', body: 'Use modules.', cites: ['dec:d1'] });
		expect(put.status).toBe(200);
		expect(put.json.data).toMatchObject({ removed: false, watermark: '2026-09-20T00:00:00.000Z' });

		const { json } = await call('GET', `/api/standing?projectPath=${encodeURIComponent(projectPath)}`);
		const page = (json.data as { pages: Array<Record<string, unknown>> }).pages[0];
		expect(page).toMatchObject({ exists: true, stale: false, sections: [{ heading: 'Prompts', cites: ['dec:d1'] }] });
	});

	it('PUT accepts cites as a comma-separated string (the skill sends an array; hand calls may not)', async () => {
		const put = await call('PUT', '/api/standing/decisions-in-force/section', { projectPath, heading: 'Other', body: 'x', cites: 'dec:d1' });
		expect(put.status).toBe(200);
	});

	it.each([
		['missing body', { heading: 'H' }, 'invalid_input'],
		['an unknown citation', { heading: 'H', body: 'b', cites: ['dec:nope'] }, 'unknown_cite'],
		['no citation', { heading: 'H', body: 'b', cites: [] }, 'missing_cite'],
	])('PUT returns 400 with a code for %s', async (_label, body, code) => {
		const { status, json } = await call('PUT', '/api/standing/decisions-in-force/section', { projectPath, ...body });
		expect(status).toBe(400);
		expect(json.code).toBe(code);
	});

	it('PUT returns 400 unknown_page for a page that does not exist', async () => {
		const { status, json } = await call('PUT', '/api/standing/nope/section', { projectPath, heading: 'H', body: 'b', cites: ['dec:d1'] });
		expect(status).toBe(400);
		expect(json.code).toBe('unknown_page');
	});

	it('returns 500 when the service fails unexpectedly', async () => {
		const broken = { listPageStatuses: jest.fn().mockRejectedValue(new Error('EIO')), writeSection: jest.fn().mockRejectedValue(new Error('EIO')) } as unknown as StandingAnswersService;
		const app = express();
		app.use(express.json());
		app.use('/s', createStandingRouter(broken));
		const s = app.listen(0, '127.0.0.1');
		await new Promise((r) => s.once('listening', r));
		const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
		try {
			expect((await fetch(`${url}/s?projectPath=/x`)).status).toBe(500);
			const put = await fetch(`${url}/s/decisions-in-force/section`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ heading: 'h', body: 'b' }) });
			expect(put.status).toBe(500);
		} finally {
			await new Promise((r) => s.close(r));
		}
	});
});
