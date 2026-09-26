import { execFile } from 'child_process';
import http from 'http';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import express from 'express';
import { createStandingRouter } from '../../../../../../backend/src/controllers/standing/standing.controller.js';
import { StandingAnswersService, parseStandingPage } from '../../../../../../backend/src/services/memory/standing-answers.service.js';

/**
 * End-to-end tests for the `standing-update` skill (#816): the real
 * `execute.sh` → the real `/api/standing` router → the real service → the
 * page file on a temp dir.
 */

const SKILL = path.join(__dirname, '..', 'execute.sh');
const FAKE_KEY = `sk-proj-${'A1b2C3d4E5'.repeat(4)}`;

let tmp: string;
let projectPath: string;
let crewlyHome: string;
let server: http.Server;
let baseUrl: string;

/**
 * Run the skill against the test server.
 *
 * @param args - CLI arguments
 * @param env - Extra environment (undefined removes a variable)
 * @returns exit code, stdout, stderr
 */
function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, CREWLY_API_URL: baseUrl, CREWLY_SESSION_NAME: 'dev-1' };
	delete childEnv.CREWLY_PROJECT_PATH;
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	return new Promise((resolve) => {
		execFile('bash', [SKILL, ...args], { env: childEnv, timeout: 60_000 }, (err, stdout, stderr) => {
			const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

const pageFile = (id: string): string => path.join(projectPath, '.crewly', 'wiki', 'llm-curated', 'standing', `${id}.md`);

beforeAll(async () => {
	tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standing-skill-'));
	projectPath = path.join(tmp, 'proj');
	crewlyHome = path.join(tmp, 'home');
	await fs.mkdir(path.join(projectPath, '.crewly', 'knowledge'), { recursive: true });
	await fs.writeFile(path.join(projectPath, '.crewly', 'knowledge', 'decisions.json'), JSON.stringify([
		{ id: 'd1', title: 'Modules', decision: 'use modules', decidedAt: '2026-09-20T00:00:00.000Z', status: 'active' },
		{ id: 'd2', title: 'Specs', decision: 'force-add specs', decidedAt: '2026-09-21T00:00:00.000Z', status: 'active' },
	]));
	await fs.mkdir(path.join(crewlyHome, 'agents', 'dev-1'), { recursive: true });
	await fs.writeFile(path.join(crewlyHome, 'agents', 'dev-1', 'memory.json'), JSON.stringify({
		roleKnowledge: [{ id: 'k1', content: 'PR open', createdAt: '2026-09-26T00:00:00.000Z' }],
	}));
	const app = express();
	app.use(express.json());
	app.use('/api/standing', createStandingRouter(new StandingAnswersService({ crewlyHome })));
	server = app.listen(0, '127.0.0.1');
	await new Promise((r) => server.once('listening', r));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise((r) => server.close(r));
	await fs.rm(tmp, { recursive: true, force: true });
});

describe('standing-update skill', () => {
	it('writes a section with citations to the project page', async () => {
		const { code, stdout } = await run(['--page', 'decisions-in-force', '--project', projectPath, '--heading', 'Prompts', '--body', 'Use modules.', '--cites', 'dec:d1, dec:d2']);
		expect(code).toBe(0);
		expect(JSON.parse(stdout).data).toMatchObject({ removed: false, watermark: '2026-09-21T00:00:00.000Z' });
		const page = parseStandingPage(await fs.readFile(pageFile('decisions-in-force'), 'utf8'));
		expect(page.sections).toEqual([{ heading: 'Prompts', body: 'Use modules.', cites: ['dec:d1', 'dec:d2'] }]);
	});

	it('reads the body from a file and takes the project from CREWLY_PROJECT_PATH', async () => {
		const bodyFile = path.join(tmp, 'body.md');
		await fs.writeFile(bodyFile, 'Line one.\n\n### Detail\nLine two.');
		const { code } = await run(['--page', 'decisions-in-force', '--heading', 'Specs', '--body-file', bodyFile, '--cites', 'dec:d2'], { CREWLY_PROJECT_PATH: projectPath });
		expect(code).toBe(0);
		const page = parseStandingPage(await fs.readFile(pageFile('decisions-in-force'), 'utf8'));
		expect(page.sections.find((s) => s.heading === 'Specs')?.body).toBe('Line one.\n\n### Detail\nLine two.');
	});

	it('an empty --body removes the section', async () => {
		const { code, stdout } = await run(['--page', 'decisions-in-force', '--project', projectPath, '--heading', 'Specs', '--body', '']);
		expect(code).toBe(0);
		expect(JSON.parse(stdout).data.removed).toBe(true);
	});

	it('the agent page goes by session (CREWLY_SESSION_NAME by default)', async () => {
		const { code } = await run(['--page', 'unfinished-work', '--heading', 'PR', '--body', 'open', '--cites', 'mem:k1']);
		expect(code).toBe(0);
		const page = parseStandingPage(await fs.readFile(path.join(crewlyHome, 'agents', 'dev-1', 'standing.md'), 'utf8'));
		expect(page.sections[0]).toMatchObject({ heading: 'PR', cites: ['mem:k1'] });
	});

	it('accepts the legacy JSON form with cites as an array', async () => {
		const { code } = await run([JSON.stringify({ page: 'decisions-in-force', projectPath, heading: 'Json', body: 'from json', cites: ['dec:d1'] })]);
		expect(code).toBe(0);
	});

	it('fails (non-zero, reason on stderr) when a citation does not resolve', async () => {
		const { code, stderr } = await run(['--page', 'decisions-in-force', '--project', projectPath, '--heading', 'Bad', '--body', 'x', '--cites', 'dec:nope']);
		expect(code).not.toBe(0);
		expect(stderr).toContain('unknown_cite');
	});

	it.each([
		['no page', ['--project', '/p', '--heading', 'H', '--body', 'b']],
		['no body flag at all', ['--page', 'decisions-in-force', '--project', '/p', '--heading', 'H']],
		['no project for a project page', ['--page', 'decisions-in-force', '--heading', 'H', '--body', 'b']],
		['a page id that is not a slug', ['--page', '../x', '--project', '/p', '--heading', 'H', '--body', 'b']],
	])('rejects %s before calling the API', async (_label, args) => {
		const { code } = await run(args);
		expect(code).not.toBe(0);
	});

	it('a key copied into the body never reaches the page', async () => {
		const { code, stdout } = await run(['--page', 'decisions-in-force', '--project', projectPath, '--heading', 'Deploy', '--body', `bot key ${FAKE_KEY}`, '--cites', 'dec:d1']);
		expect(code).toBe(0);
		expect(JSON.parse(stdout).data.masked).toBe(true);
		expect(await fs.readFile(pageFile('decisions-in-force'), 'utf8')).not.toContain(FAKE_KEY);
	});
});
