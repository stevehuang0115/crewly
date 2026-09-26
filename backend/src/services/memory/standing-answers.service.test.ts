import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
	StandingAnswersService,
	StandingAnswersError,
	PROJECT_STANDING_PAGES,
	AGENT_STANDING_PAGE,
	findStandingPageDef,
	parseStandingPage,
	serializeStandingPage,
	upsertSection,
	computeWatermark,
	countNewer,
	type StandingPageDef,
	type StandingSourceEntry,
} from './standing-answers.service.js';

/** A key-looking string (matches the openai_key secret pattern). */
const FAKE_KEY = `sk-proj-${'A1b2C3d4E5'.repeat(4)}`;

const DECISIONS = findStandingPageDef('decisions-in-force') as StandingPageDef;
const GOTCHAS = findStandingPageDef('open-gotchas') as StandingPageDef;
const PREFS = findStandingPageDef('owner-preferences') as StandingPageDef;

describe('standing-answers pure helpers', () => {
	it('parse ∘ serialise round-trips frontmatter, sections and citations', () => {
		const page = {
			question: 'What decisions are in force? (a: "quoted")',
			lastRefreshed: '2026-09-26T10:00:00.000Z',
			watermark: '2026-09-26T09:00:00.000Z',
			sections: [
				{ heading: 'Prompts', body: 'Use modules.\n\n### Detail\nline', cites: ['dec:1', 'dec:2'] },
				{ heading: 'Specs', body: 'force-add', cites: ['dec:3'] },
			],
		};
		expect(parseStandingPage(serializeStandingPage(page))).toEqual(page);
	});

	it('parses a hand-edited page tolerantly (no frontmatter, preamble, CRLF, no Sources line)', () => {
		const parsed = parseStandingPage('Intro text\r\n## One\r\nbody one\r\n\r\n## Two\r\nbody two\r\nSources: got:x ,  got:y\r\n');
		expect(parsed.question).toBeUndefined();
		expect(parsed.sections).toEqual([
			{ heading: 'One', body: 'body one', cites: [] },
			{ heading: 'Two', body: 'body two', cites: ['got:x', 'got:y'] },
		]);
	});

	it('upsertSection replaces (case-insensitively), appends, and removes on empty body', () => {
		const base = { sections: [{ heading: 'A', body: 'a', cites: ['dec:1'] }] };
		expect(upsertSection(base, { heading: 'a', body: 'a2', cites: ['dec:2'] }).page.sections).toEqual([{ heading: 'a', body: 'a2', cites: ['dec:2'] }]);
		expect(upsertSection(base, { heading: 'B', body: 'b', cites: ['dec:3'] }).page.sections.map((s) => s.heading)).toEqual(['A', 'B']);
		const removed = upsertSection(base, { heading: 'A', body: '  ', cites: [] });
		expect(removed.removed).toBe(true);
		expect(removed.page.sections).toEqual([]);
		expect(upsertSection(base, { heading: 'Z', body: '', cites: [] }).removed).toBe(false);
		expect(base.sections).toHaveLength(1); // not mutated
	});

	it('computeWatermark takes the newest parseable timestamp; countNewer counts past it', () => {
		const e = (at: string): StandingSourceEntry => ({ cite: `dec:${at}`, title: '', text: '', at, inForce: true });
		const entries = [e('2026-09-01T00:00:00.000Z'), e('2026-09-03T00:00:00.000Z'), e('garbage')];
		expect(computeWatermark(entries)).toBe('2026-09-03T00:00:00.000Z');
		expect(computeWatermark([])).toBeNull();
		expect(countNewer(entries, '2026-09-02T00:00:00.000Z')).toBe(1);
		expect(countNewer(entries, '2026-09-03T00:00:00.000Z')).toBe(0);
		expect(countNewer(entries, undefined)).toBe(3);
	});

	it('knows the three project pages and the agent page', () => {
		expect(PROJECT_STANDING_PAGES.map((p) => p.id)).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences']);
		expect(AGENT_STANDING_PAGE.scope).toBe('agent');
		expect(findStandingPageDef('nope')).toBeUndefined();
	});
});

describe('StandingAnswersService (on disk)', () => {
	let tmp: string;
	let projectPath: string;
	let crewlyHome: string;
	let service: StandingAnswersService;
	const session = 'dev-1';

	const knowledge = (file: string): string => path.join(projectPath, '.crewly', 'knowledge', file);
	const writeJson = async (file: string, data: unknown): Promise<void> => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(data));
	};

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standing-'));
		projectPath = path.join(tmp, 'proj');
		crewlyHome = path.join(tmp, 'home');
		service = new StandingAnswersService({ crewlyHome });
		await writeJson(knowledge('decisions.json'), [
			{ id: 'd1', title: 'Use modules', decision: 'Prompt content is a module', decidedAt: '2026-09-20T00:00:00.000Z', status: 'active' },
			{ id: 'd2', title: 'Old choice', decision: 'Legacy prompt', decidedAt: '2026-09-10T00:00:00.000Z', status: 'superseded' },
			{ id: 'd3', title: '[COMPLETED] Task completed by x', decision: '[COMPLETED] shipped', decidedAt: '2026-09-25T00:00:00.000Z', status: 'active' },
		]);
		await writeJson(knowledge('gotchas.json'), [
			{ id: 'g1', title: 'zsh split', problem: 'zsh does not split', solution: 'use arrays', createdAt: '2026-09-01T00:00:00.000Z' },
			{ id: 'g2', title: 'fixed', problem: 'x', createdAt: '2026-08-01T00:00:00.000Z', resolved: true, resolvedAt: '2026-09-22T00:00:00.000Z' },
		]);
		await writeJson(knowledge('patterns.json'), [
			{ id: 'p1', category: 'user_preference', title: 'Chinese replies', description: 'Reply in Chinese', createdAt: '2026-09-05T00:00:00.000Z' },
			{ id: 'p2', category: 'other', title: 'not a pref', description: 'x', createdAt: '2026-09-06T00:00:00.000Z' },
		]);
		await writeJson(path.join(crewlyHome, 'agents', session, 'memory.json'), {
			roleKnowledge: [
				{ id: 'k1', content: 'PR #818 waiting on review', createdAt: '2026-09-26T01:00:00.000Z' },
				{ id: 'k2', content: 'old', createdAt: '2026-09-01T00:00:00.000Z', superseded: true },
			],
		});
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	describe('loadSourceEntries', () => {
		it('decisions: drops [COMPLETED] records, marks superseded not in force, newest first', async () => {
			const entries = await service.loadSourceEntries(DECISIONS, { projectPath });
			expect(entries.map((e) => [e.cite, e.inForce])).toEqual([['dec:d1', true], ['dec:d2', false]]);
		});

		it('gotchas: resolution time moves the entry; resolved is not in force', async () => {
			const entries = await service.loadSourceEntries(GOTCHAS, { projectPath });
			expect(entries.map((e) => [e.cite, e.at, e.inForce])).toEqual([
				['got:g2', '2026-09-22T00:00:00.000Z', false],
				['got:g1', '2026-09-01T00:00:00.000Z', true],
			]);
			expect(entries[1].text).toContain('Fix: use arrays');
		});

		it('owner preferences: only user_preference patterns', async () => {
			expect((await service.loadSourceEntries(PREFS, { projectPath })).map((e) => e.cite)).toEqual(['pref:p1']);
		});

		it('agent memory: roleKnowledge from the agent memory file', async () => {
			const entries = await service.loadSourceEntries(AGENT_STANDING_PAGE, { sessionName: session });
			expect(entries.map((e) => [e.cite, e.inForce])).toEqual([['mem:k1', true], ['mem:k2', false]]);
		});

		it('agent memory: report-status "Task completed:" learnings are out of scope; failed/blocked stay in', async () => {
			await writeJson(path.join(crewlyHome, 'agents', session, 'memory.json'), {
				roleKnowledge: [
					{ id: 'c1', content: 'Task completed: shipped X', createdAt: '2026-09-26T05:00:00.000Z' },
					{ id: 'f1', content: 'Task failed: build broke', createdAt: '2026-09-26T04:00:00.000Z' },
				],
			});
			expect((await service.loadSourceEntries(AGENT_STANDING_PAGE, { sessionName: session })).map((e) => e.cite)).toEqual(['mem:f1']);
		});

		it('missing or corrupt memory files yield no entries', async () => {
			await fs.writeFile(knowledge('decisions.json'), '{not json');
			expect(await service.loadSourceEntries(DECISIONS, { projectPath })).toEqual([]);
			expect(await service.loadSourceEntries(DECISIONS, { projectPath: path.join(tmp, 'nowhere') })).toEqual([]);
		});
	});

	describe('getPageStatus / listPageStatuses', () => {
		it('a missing page is stale and counts every entry as newer', async () => {
			const status = await service.getPageStatus(DECISIONS, { projectPath });
			expect(status).toMatchObject({ stale: true, entriesInScope: 2, newerEntries: 2, currentWatermark: '2026-09-20T00:00:00.000Z' });
			expect(status?.page).toBeUndefined();
			expect(status?.filePath).toBe(path.join(projectPath, '.crewly', 'wiki', 'llm-curated', 'standing', 'decisions-in-force.md'));
		});

		it('a page at the current watermark is fresh; a newer memory makes it stale', async () => {
			await service.writeSection({ pageId: 'decisions-in-force', projectPath, heading: 'Prompts', body: 'Modules.', cites: ['dec:d1'] });
			expect((await service.getPageStatus(DECISIONS, { projectPath }))?.stale).toBe(false);

			const decisions = JSON.parse(await fs.readFile(knowledge('decisions.json'), 'utf8'));
			decisions.push({ id: 'd4', title: 'New', decision: 'new rule', decidedAt: '2026-09-26T00:00:00.000Z' });
			await writeJson(knowledge('decisions.json'), decisions);

			expect(await service.getPageStatus(DECISIONS, { projectPath })).toMatchObject({ stale: true, newerEntries: 1 });
		});

		it('a new [COMPLETED] record does not make "decisions in force" stale', async () => {
			await service.writeSection({ pageId: 'decisions-in-force', projectPath, heading: 'Prompts', body: 'Modules.', cites: ['dec:d1'] });
			const decisions = JSON.parse(await fs.readFile(knowledge('decisions.json'), 'utf8'));
			decisions.push({ id: 'd5', title: '[COMPLETED] Task completed', decision: '[COMPLETED] done', decidedAt: '2026-09-27T00:00:00.000Z' });
			await writeJson(knowledge('decisions.json'), decisions);
			expect((await service.getPageStatus(DECISIONS, { projectPath }))?.stale).toBe(false);
		});

		it('lists project pages for a project and the agent page for a session', async () => {
			expect((await service.listPageStatuses({ projectPath })).map((s) => s.def.id)).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences']);
			expect((await service.listPageStatuses({ sessionName: session })).map((s) => s.def.id)).toEqual(['unfinished-work']);
			expect(await service.listPageStatuses({})).toEqual([]);
		});

		it('refuses a session name that is not a single path segment', async () => {
			expect(service.pagePath(AGENT_STANDING_PAGE, { sessionName: '../etc' })).toBeNull();
			expect(await service.getPageStatus(AGENT_STANDING_PAGE, { sessionName: '../etc' })).toBeNull();
		});
	});

	describe('writeSection', () => {
		it('creates the page with its question, stamps last_refreshed and moves the watermark', async () => {
			const res = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'Quote globs; zsh does not split.', cites: ['got:g1'] });
			expect(res).toMatchObject({ removed: false, masked: false, watermark: '2026-09-22T00:00:00.000Z' });
			const page = parseStandingPage(await fs.readFile(res.filePath, 'utf8'));
			expect(page.question).toBe('Which gotchas are still open?');
			expect(page.watermark).toBe('2026-09-22T00:00:00.000Z');
			expect(Date.parse(page.lastRefreshed ?? '')).not.toBeNaN();
			expect(page.sections).toEqual([{ heading: 'Shell', body: 'Quote globs; zsh does not split.', cites: ['got:g1'] }]);
		});

		it('edits one section and leaves the others', async () => {
			await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v1', cites: ['got:g1'] });
			await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Other', body: 'o', cites: ['got:g1'] });
			const res = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'shell', body: 'v2', cites: ['got:g1', 'got:g1'] });
			const page = parseStandingPage(await fs.readFile(res.filePath, 'utf8'));
			expect(page.sections).toEqual([
				{ heading: 'shell', body: 'v2', cites: ['got:g1'] },
				{ heading: 'Other', body: 'o', cites: ['got:g1'] },
			]);
		});

		it('an empty body removes the section and needs no citation', async () => {
			await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v1', cites: ['got:g1'] });
			const res = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: '', cites: [] });
			expect(res.removed).toBe(true);
			expect(parseStandingPage(await fs.readFile(res.filePath, 'utf8')).sections).toEqual([]);
		});

		it('writes the agent page under CREWLY_HOME/agents/<session>/standing.md', async () => {
			const res = await service.writeSection({ pageId: 'unfinished-work', sessionName: session, heading: 'PR #818', body: 'Waiting on review.', cites: ['mem:k1'] });
			expect(res.filePath).toBe(path.join(crewlyHome, 'agents', session, 'standing.md'));
		});

		it.each([
			['unknown page', { pageId: 'nope' }, 'unknown_page'],
			['no project path for a project page', { projectPath: undefined }, 'invalid_input'],
			['multi-line heading', { heading: 'a\nb' }, 'invalid_input'],
			['over-long heading', { heading: 'h'.repeat(81) }, 'invalid_input'],
			['over-long body', { body: 'b'.repeat(1501) }, 'invalid_input'],
			['a ## heading inside the body', { body: 'x\n## sneaky' }, 'invalid_input'],
			['a Sources: line inside the body', { body: 'x\nSources: dec:d1' }, 'invalid_input'],
			['no citation', { cites: [] }, 'missing_cite'],
			['a citation from another source', { cites: ['got:g1'] }, 'unknown_cite'],
			['a citation that does not exist', { cites: ['dec:zzz'] }, 'unknown_cite'],
			['a [COMPLETED] record as a citation', { cites: ['dec:d3'] }, 'unknown_cite'],
		])('rejects %s', async (_label, override, code) => {
			const input = { pageId: 'decisions-in-force', projectPath, heading: 'H', body: 'b', cites: ['dec:d1'], ...override };
			await expect(service.writeSection(input)).rejects.toMatchObject({ code });
			await expect(service.writeSection(input)).rejects.toBeInstanceOf(StandingAnswersError);
		});
	});

	describe('secrets never reach a page (TL requirement, #816)', () => {
		beforeEach(async () => {
			await writeJson(knowledge('decisions.json'), [
				{ id: 'dk', title: 'Deploy key', decision: `Use key ${FAKE_KEY} for the deploy bot`, decidedAt: '2026-09-21T00:00:00.000Z', status: 'active' },
			]);
		});

		it('the refresh brief shows the source memory with the key masked', async () => {
			const status = await service.getPageStatus(DECISIONS, { projectPath });
			const brief = await service.buildRefreshBrief(status!, { projectPath }, '/skills/agent');
			expect(brief).toContain('dec:dk');
			expect(brief).toContain('Deploy key');
			expect(brief).not.toContain(FAKE_KEY);
			expect(brief).toContain('[REDACTED api_key]');
		});

		it('a section that copies the key from the memory is written masked', async () => {
			const res = await service.writeSection({
				pageId: 'decisions-in-force', projectPath, heading: `Deploy ${FAKE_KEY}`, body: `The deploy bot uses ${FAKE_KEY}.`, cites: ['dec:dk'],
			});
			expect(res.masked).toBe(true);
			const file = await fs.readFile(res.filePath, 'utf8');
			expect(file).not.toContain(FAKE_KEY);
			expect(file).toContain('[REDACTED api_key]');
		});
	});

	describe('buildRefreshBrief', () => {
		it('lists newer entries first, the current sections, and the exact skill command', async () => {
			await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v1', cites: ['got:g1'] });
			const gotchas = JSON.parse(await fs.readFile(knowledge('gotchas.json'), 'utf8'));
			gotchas.push({ id: 'g3', title: 'new trap', problem: 'p', createdAt: '2026-09-26T00:00:00.000Z' });
			await writeJson(knowledge('gotchas.json'), gotchas);

			const status = await service.getPageStatus(GOTCHAS, { projectPath });
			const brief = await service.buildRefreshBrief(status!, { projectPath }, '/skills/agent');
			expect(brief).toContain('**Question:** Which gotchas are still open?');
			expect(brief).toContain('- Shell (1 source)');
			expect(brief).toContain('1 newer entry of 3 in scope');
			const g3 = brief.indexOf('`got:g3`');
			const g1 = brief.indexOf('`got:g1`');
			expect(g3).toBeGreaterThan(-1);
			expect(g1).toBeGreaterThan(g3); // older in-force entries follow the newer ones
			expect(brief).not.toContain('`got:g2`'); // older and resolved: nothing to add
			expect(brief).toContain(`bash /skills/agent/core/standing-update/execute.sh --page open-gotchas --project '${projectPath}'`);
		});

		it('marks entries that are no longer in force', async () => {
			const status = await service.getPageStatus(DECISIONS, { projectPath });
			const brief = await service.buildRefreshBrief(status!, { projectPath }, '/s');
			expect(brief).toMatch(/`dec:d2` · 2026-09-10 · NOT IN FORCE/);
		});
	});
});
