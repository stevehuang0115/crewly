import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
	StandingAnswersService,
	StandingAnswersError,
	PROJECT_STANDING_PAGES,
	AGENT_STANDING_PAGE,
	OWNER_RULES_PAGE,
	findStandingPageDef,
	parseCustomQuestions,
	matchesQuestion,
	parseStandingPage,
	serializeStandingPage,
	upsertSection,
	computeWatermark,
	countNewer,
	findInvalidatedSections,
	invalidationKey,
	formatInvalidCites,
	possibleSupersedeLines,
	sectionWriteOp,
	type StandingPageDef,
	type StandingSourceEntry,
} from './standing-answers.service.js';

/** A key-looking string (matches the openai_key secret pattern). */
const FAKE_KEY = `sk-proj-${'A1b2C3d4E5'.repeat(4)}`;

const DECISIONS = findStandingPageDef('decisions-in-force') as StandingPageDef;
const GOTCHAS = findStandingPageDef('open-gotchas') as StandingPageDef;
const PREFS = findStandingPageDef('owner-preferences') as StandingPageDef;

describe('standing-answers pure helpers', () => {
	it('possibleSupersedeLines flags only same-day, same-topic, in-force pairs (#884)', () => {
		const e = (cite: string, at: string, text: string, inForce = true): StandingSourceEntry => ({ cite, title: '', text, at, inForce });
		const lines = possibleSupersedeLines([
			e('dec:a', '2026-09-29T03:04:00.000Z', 'Zeng pricing reply: $199 monthly trial offer'),
			e('dec:b', '2026-09-29T01:51:00.000Z', 'Zeng pricing too high, $150 monthly trial offer proposed'),
			e('dec:c', '2026-09-28T01:00:00.000Z', 'Zeng pricing monthly trial offer from last week'),
			e('dec:d', '2026-09-29T02:00:00.000Z', 'Deploy the relay on node one'),
			e('dec:e', '2026-09-29T02:30:00.000Z', 'Zeng pricing monthly trial offer withdrawn', false),
		]);
		expect(lines.filter((l) => l.includes('POSSIBLE SUPERSEDE'))).toEqual([
			'- POSSIBLE SUPERSEDE: `dec:a` (2026-09-29T03:04:00.000Z) may replace `dec:b` (2026-09-29T01:51:00.000Z); same day, same topic. Check the order before merging them.',
		]);
		expect(possibleSupersedeLines([e('dec:x', '2026-09-29T00:00:00.000Z', 'one thing')])).toEqual([]);
	});

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

	it('findInvalidatedSections names cites that are deleted or not in force, per section', () => {
		const e = (cite: string, inForce: boolean): StandingSourceEntry => ({ cite, title: '', text: '', at: '2026-09-01T00:00:00.000Z', inForce });
		const page = {
			sections: [
				{ heading: 'Ok', body: 'b', cites: ['dec:a'] },
				{ heading: 'Bad', body: 'b', cites: ['dec:a', 'dec:old', 'dec:gone'] },
			],
		};
		const out = findInvalidatedSections(page, [e('dec:a', true), e('dec:old', false)]);
		expect(out).toEqual([{ heading: 'Bad', invalidCites: [{ cite: 'dec:old', reason: 'not_in_force' }, { cite: 'dec:gone', reason: 'deleted' }] }]);
		expect(invalidationKey(out)).toBe('dec:gone,dec:old');
		expect(invalidationKey([])).toBe('');
		expect(formatInvalidCites(out[0].invalidCites)).toBe('dec:old (no longer in force), dec:gone (deleted)');
		expect(findInvalidatedSections(undefined, [])).toEqual([]);
	});

	it('sectionWriteOp: added / modified / removed / unchanged (#914 delta edits)', () => {
		const page = parseStandingPage('## Shell\nv1\nSources: got:g1\n');
		expect(sectionWriteOp(page, { heading: 'Other', body: 'o', cites: ['got:g1'] })).toBe('added');
		expect(sectionWriteOp(page, { heading: 'shell', body: 'v2', cites: ['got:g1'] })).toBe('modified');
		expect(sectionWriteOp(page, { heading: 'Shell', body: 'v1', cites: ['got:g1', 'got:g2'] })).toBe('modified');
		expect(sectionWriteOp(page, { heading: 'Shell', body: '', cites: [] })).toBe('removed');
		expect(sectionWriteOp(page, { heading: 'Missing', body: '', cites: [] })).toBe('unchanged');
		expect(sectionWriteOp(page, { heading: 'SHELL', body: 'v1', cites: ['got:g1'] })).toBe('unchanged');
	});

	it('knows the three project pages, the owner rules page and the agent page', () => {
		expect(PROJECT_STANDING_PAGES.map((p) => p.id)).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences']);
		expect(AGENT_STANDING_PAGE.scope).toBe('agent');
		expect(findStandingPageDef('owner-rules')).toMatchObject({ scope: 'project', source: 'owner', ownerOnly: true });
		expect(OWNER_RULES_PAGE.id).toBe('owner-rules');
		expect(findStandingPageDef('nope')).toBeUndefined();
	});

	it('parseCustomQuestions keeps valid entries in order and names why each bad one was dropped (#914 P2)', () => {
		const { defs, dropped } = parseCustomQuestions({
			questions: [
				{ id: 'release-rules', question: 'What must happen before a release?', source: 'decisions', match: ['Release', ' publish ', '', 7] },
				{ id: 'decisions-in-force', question: 'built-in id', source: 'decisions' },
				{ id: 'Bad Id', question: 'x', source: 'decisions' },
				{ id: 'no-source', question: 'x', source: 'wiki' },
				{ id: 'long', question: 'q'.repeat(201), source: 'gotchas' },
				{ id: 'release-rules', question: 'dup', source: 'gotchas' },
				{ id: 'prefs', question: 'What does the owner want in replies?', source: 'user_preferences' },
				null,
			],
		});
		expect(defs).toEqual([
			{ id: 'release-rules', scope: 'project', question: 'What must happen before a release?', source: 'decisions', custom: true, match: ['release', 'publish'] },
			{ id: 'prefs', scope: 'project', question: 'What does the owner want in replies?', source: 'user_preferences', custom: true },
		]);
		expect(dropped).toHaveLength(6);
		expect(dropped[0]).toContain('built in');
		expect(dropped[1]).toContain('id must match');
		expect(dropped[2]).toContain('source must be one of');
		expect(dropped[3]).toContain('1-200 characters');
		expect(dropped[4]).toContain('repeated');
		expect(dropped[5]).toContain('#8');

		// A bare array works; anything else is one dropped reason, nothing fatal.
		expect(parseCustomQuestions([{ id: 'a-b', question: 'q', source: 'gotchas' }]).defs).toHaveLength(1);
		expect(parseCustomQuestions({ nope: 1 }).dropped).toEqual(['expected { "questions": [...] } or an array']);
		expect(parseCustomQuestions(null)).toEqual({ defs: [], dropped: [] });

		// The cap holds.
		const many = { questions: Array.from({ length: 12 }, (_, i) => ({ id: `q-${i}`, question: 'q', source: 'decisions' })) };
		const capped = parseCustomQuestions(many);
		expect(capped.defs).toHaveLength(10);
		expect(capped.dropped).toHaveLength(2);
	});

	it('matchesQuestion filters on title or text, case-insensitively, and passes everything without a filter', () => {
		const def: StandingPageDef = { id: 'x', scope: 'project', question: 'q', source: 'decisions', match: ['release'] };
		expect(matchesQuestion(def, { title: 'Pre-RELEASE checklist', text: '' })).toBe(true);
		expect(matchesQuestion(def, { title: '', text: 'publish after release' })).toBe(true);
		expect(matchesQuestion(def, { title: 'Deploy', text: 'relay' })).toBe(false);
		expect(matchesQuestion({ ...def, match: [] }, { title: 'Deploy', text: 'relay' })).toBe(true);
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

		describe('retraction propagation (#914)', () => {
			const page = (): Promise<void> =>
				service.writeSection({ pageId: 'decisions-in-force', projectPath, heading: 'Prompts', body: 'Modules.', cites: ['dec:d1'] }).then(() => undefined);
			const setD1 = async (patch: Record<string, unknown>): Promise<void> => {
				const decisions = JSON.parse(await fs.readFile(knowledge('decisions.json'), 'utf8')) as Array<Record<string, unknown>>;
				await writeJson(knowledge('decisions.json'), decisions.map((d) => (d.id === 'd1' ? { ...d, ...patch } : d)));
			};

			it('all cited sources valid: no section is marked and the page stays fresh', async () => {
				await page();
				expect(await service.getPageStatus(DECISIONS, { projectPath })).toMatchObject({ stale: false, invalidatedSections: [] });
			});

			it('a cited decision superseded without the watermark moving marks the section', async () => {
				await page();
				await setD1({ supersededBy: 'd9' });
				const status = await service.getPageStatus(DECISIONS, { projectPath });
				expect(status?.newerEntries).toBe(0);
				expect(status?.invalidatedSections).toEqual([{ heading: 'Prompts', invalidCites: [{ cite: 'dec:d1', reason: 'not_in_force' }] }]);
			});

			it('a deleted cited decision marks the section as deleted', async () => {
				await page();
				const decisions = JSON.parse(await fs.readFile(knowledge('decisions.json'), 'utf8')) as Array<{ id: string }>;
				await writeJson(knowledge('decisions.json'), decisions.filter((d) => d.id !== 'd1'));
				expect((await service.getPageStatus(DECISIONS, { projectPath }))?.invalidatedSections).toEqual([
					{ heading: 'Prompts', invalidCites: [{ cite: 'dec:d1', reason: 'deleted' }] },
				]);
			});

			it('an expired agent memory (ttl passed) marks the agent page section', async () => {
				await service.writeSection({ pageId: 'unfinished-work', sessionName: session, heading: 'PR', body: 'Waiting.', cites: ['mem:k1'] });
				await writeJson(path.join(crewlyHome, 'agents', session, 'memory.json'), {
					roleKnowledge: [{ id: 'k1', content: 'PR #818 waiting on review', createdAt: '2026-09-26T01:00:00.000Z', ttl: '2026-09-27T00:00:00.000Z' }],
				});
				expect((await service.getPageStatus(AGENT_STANDING_PAGE, { sessionName: session }))?.invalidatedSections).toEqual([
					{ heading: 'PR', invalidCites: [{ cite: 'mem:k1', reason: 'not_in_force' }] },
				]);
			});

			it('the refresh brief names the invalidated section and its citations', async () => {
				await page();
				await setD1({ status: 'superseded' });
				const status = await service.getPageStatus(DECISIONS, { projectPath });
				const brief = await service.buildRefreshBrief(status!, { projectPath }, '/s');
				expect(brief).toContain('- Prompts (1 source) — BASIS INVALIDATED: dec:d1 (no longer in force)');
			});
		});

		it('lists project pages for a project and the agent page for a session', async () => {
			expect((await service.listPageStatuses({ projectPath })).map((s) => s.def.id)).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences', 'owner-rules']);
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

		describe('change history (#914 P1 delta edits)', () => {
			const historyDir = (): string => path.join(projectPath, '.crewly', 'standing-history', 'open-gotchas');
			const log = async (): Promise<string[]> => (await fs.readFile(path.join(historyDir(), 'changes.log'), 'utf8')).trim().split('\n');

			it('reports the op and snapshots the previous page only on a content change', async () => {
				const first = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v1', cites: ['got:g1'] });
				expect(first).toMatchObject({ op: 'added', snapshot: null, removed: false });

				const same = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'shell', body: 'v1', cites: ['got:g1'] });
				expect(same).toMatchObject({ op: 'unchanged', snapshot: null });
				expect(await service.listSnapshots(GOTCHAS, { projectPath })).toEqual([]);

				const edit = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v2', cites: ['got:g1'] });
				expect(edit.op).toBe('modified');
				expect(edit.snapshot).toMatch(/standing-history\/open-gotchas\/\d{4}-\d{2}-\d{2}T[\d-]+Z\.md$/);
				const before = parseStandingPage(await fs.readFile(edit.snapshot as string, 'utf8'));
				expect(before.sections).toEqual([{ heading: 'shell', body: 'v1', cites: ['got:g1'] }]);
				expect(parseStandingPage(await fs.readFile(edit.filePath, 'utf8')).sections[0].body).toBe('v2');

				const gone = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: '', cites: [] });
				expect(gone).toMatchObject({ op: 'removed', removed: true });
				expect(gone.snapshot).not.toBe(edit.snapshot);
				expect(await service.listSnapshots(GOTCHAS, { projectPath })).toEqual([edit.snapshot, gone.snapshot]);

				const lines = await log();
				expect(lines.map((l) => l.split('\t')[1])).toEqual(['added', 'unchanged', 'modified', 'removed']);
				expect(lines[2].split('\t').slice(2)).toEqual(['Shell', '1 cite', path.basename(edit.snapshot as string)]);
				expect(lines[1].split('\t')[4]).toBe('-');
			});

			it('an unchanged write still moves the watermark and last_refreshed', async () => {
				await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v1', cites: ['got:g1'] });
				await writeJson(knowledge('gotchas.json'), [
					{ id: 'g1', title: 'zsh split', problem: 'zsh does not split', solution: 'use arrays', createdAt: '2026-09-01T00:00:00.000Z' },
					{ id: 'g3', title: 'new', problem: 'y', createdAt: '2026-09-30T00:00:00.000Z' },
				]);
				expect((await service.getPageStatus(GOTCHAS, { projectPath }))?.stale).toBe(true);
				const res = await service.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: 'v1', cites: ['got:g1'] });
				expect(res).toMatchObject({ op: 'unchanged', watermark: '2026-09-30T00:00:00.000Z' });
				expect((await service.getPageStatus(GOTCHAS, { projectPath }))?.stale).toBe(false);
			});

			it('keeps the newest historyKeep snapshots', async () => {
				const small = new StandingAnswersService({ crewlyHome, historyKeep: 2 });
				for (let i = 0; i < 5; i++) {
					await small.writeSection({ pageId: 'open-gotchas', projectPath, heading: 'Shell', body: `v${i}`, cites: ['got:g1'] });
				}
				const kept = await small.listSnapshots(GOTCHAS, { projectPath });
				expect(kept).toHaveLength(2);
				const bodies = await Promise.all(kept.map(async (f) => parseStandingPage(await fs.readFile(f, 'utf8')).sections[0].body));
				expect(bodies).toEqual(['v2', 'v3']);
				expect(await log()).toHaveLength(5);
			});

			it('the agent page keeps its history under agents/<session>/standing-history', async () => {
				await service.writeSection({ pageId: 'unfinished-work', sessionName: session, heading: 'PR #818', body: 'Waiting.', cites: ['mem:k1'] });
				const res = await service.writeSection({ pageId: 'unfinished-work', sessionName: session, heading: 'PR #818', body: 'Merged.', cites: ['mem:k1'] });
				expect(res.snapshot).toContain(path.join(crewlyHome, 'agents', session, 'standing-history'));
				expect(await fs.readFile(path.join(crewlyHome, 'agents', session, 'standing-history', 'changes.log'), 'utf8')).toMatch(/\tmodified\tPR #818\t1 cite\t/);
			});
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

	describe('owner rules page (#914 P2)', () => {
		it('lives in the frozen owner/ folder, is never stale, and is listed with the project pages', async () => {
			const status = await service.getPageStatus(OWNER_RULES_PAGE, { projectPath });
			expect(status).toMatchObject({ stale: false, entriesInScope: 0, newerEntries: 0, currentWatermark: null, invalidatedSections: [] });
			expect(status?.filePath).toBe(path.join(projectPath, '.crewly', 'wiki', 'owner', 'rules.md'));
			const ids = (await service.listPageStatuses({ projectPath })).map((s) => s.def.id);
			expect(ids).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences', 'owner-rules']);
		});

		it('refuses an agent write (owner_only) and takes an owner write without citations', async () => {
			await expect(service.writeSection({ pageId: 'owner-rules', projectPath, heading: 'Replies', body: 'Always in Chinese.', cites: [] }))
				.rejects.toMatchObject({ code: 'owner_only' });
			await expect(service.writeSection({ pageId: 'owner-rules', projectPath, heading: 'Replies', body: 'x', cites: [], actor: 'agent' }))
				.rejects.toMatchObject({ code: 'owner_only' });
			expect(await fs.readFile(path.join(projectPath, '.crewly', 'wiki', 'owner', 'rules.md'), 'utf8').catch(() => null)).toBeNull();

			const res = await service.writeSection({ pageId: 'owner-rules', projectPath, heading: 'Replies', body: 'Always in Chinese.', cites: ['dec:ignored'], actor: 'owner' });
			expect(res).toMatchObject({ op: 'added', watermark: null, removed: false });
			const page = parseStandingPage(await fs.readFile(res.filePath, 'utf8'));
			expect(page.question).toBe('What rules has the owner set explicitly?');
			expect(page.watermark).toBeUndefined();
			expect(page.sections).toEqual([{ heading: 'Replies', body: 'Always in Chinese.', cites: [] }]);
			expect((await service.getPageStatus(OWNER_RULES_PAGE, { projectPath }))?.stale).toBe(false);
		});

		it('a hand-written rules file is read as it is', async () => {
			const file = path.join(projectPath, '.crewly', 'wiki', 'owner', 'rules.md');
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, '## Never push main\nOpen a PR.\n\n## Costs\nAsk before any paid API.\n');
			const status = await service.getPageStatus(OWNER_RULES_PAGE, { projectPath });
			expect(status?.page?.sections.map((s) => s.heading)).toEqual(['Never push main', 'Costs']);
			expect(status?.stale).toBe(false);
		});
	});

	describe('custom questions (#914 P2)', () => {
		const questionsFile = (): string => path.join(projectPath, '.crewly', 'standing-questions.json');

		it('adds the project\'s questions after the built-in pages, filtered by match', async () => {
			await writeJson(questionsFile(), { questions: [
				{ id: 'prompt-rules', question: 'How do we build prompts?', source: 'decisions', match: ['prompt'] },
				{ id: 'shell-gotchas', question: 'Which shell gotchas are open?', source: 'gotchas', match: ['zsh'] },
				{ id: 'nothing', question: 'Matches nothing?', source: 'decisions', match: ['kubernetes'] },
			] });
			const defs = await service.listProjectPageDefs(projectPath);
			expect(defs.map((d) => d.id)).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences', 'owner-rules', 'prompt-rules', 'shell-gotchas', 'nothing']);

			const statuses = await service.listPageStatuses({ projectPath });
			const byId = new Map(statuses.map((s) => [s.def.id, s]));
			// d1 and d2 mention prompts (d3 is a [COMPLETED] record); g1 is the zsh gotcha, g2 is not.
			expect(byId.get('prompt-rules')).toMatchObject({ entriesInScope: 2, stale: true });
			expect(byId.get('shell-gotchas')).toMatchObject({ entriesInScope: 1 });
			expect(byId.get('nothing')).toMatchObject({ entriesInScope: 0 });
			expect(byId.get('prompt-rules')?.filePath).toBe(path.join(projectPath, '.crewly', 'wiki', 'llm-curated', 'standing', 'prompt-rules.md'));
		});

		it('resolves and writes a custom page like a built-in one, citing only matched entries', async () => {
			await writeJson(questionsFile(), [{ id: 'shell-gotchas', question: 'Which shell gotchas are open?', source: 'gotchas', match: ['zsh'] }]);
			expect(await service.resolvePageDef('shell-gotchas', { projectPath })).toMatchObject({ custom: true, source: 'gotchas' });
			expect(await service.resolvePageDef('shell-gotchas', {})).toBeUndefined();

			const res = await service.writeSection({ pageId: 'shell-gotchas', projectPath, heading: 'zsh', body: 'Quote globs.', cites: ['got:g1'] });
			const page = parseStandingPage(await fs.readFile(res.filePath, 'utf8'));
			expect(page.question).toBe('Which shell gotchas are open?');
			expect(page.sections).toEqual([{ heading: 'zsh', body: 'Quote globs.', cites: ['got:g1'] }]);
			// g2 exists in gotchas.json but does not match the filter, so it is not a valid citation here.
			await expect(service.writeSection({ pageId: 'shell-gotchas', projectPath, heading: 'other', body: 'x', cites: ['got:g2'] }))
				.rejects.toMatchObject({ code: 'unknown_cite' });
		});

		it('an unknown page names the custom ids too; a broken questions file hides nothing else', async () => {
			await writeJson(questionsFile(), [{ id: 'shell-gotchas', question: 'q', source: 'gotchas' }]);
			await expect(service.writeSection({ pageId: 'nope', projectPath, heading: 'h', body: 'b', cites: ['got:g1'] }))
				.rejects.toThrow(/Known: .*owner-rules, unfinished-work, shell-gotchas/);

			await fs.writeFile(questionsFile(), '{ not json');
			expect(await service.loadCustomQuestions(projectPath)).toEqual({ defs: [], dropped: ['standing-questions.json is not valid JSON'] });
			expect((await service.listPageStatuses({ projectPath })).map((s) => s.def.id)).toEqual(['decisions-in-force', 'open-gotchas', 'owner-preferences', 'owner-rules']);
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
		// #884: two same-day entries looked simultaneous (date only), so their
		// order had to be guessed and a superseded "waiting on" state was
		// written back as pending.
		it('shows full timestamps, the sort order, supersede links, and flags same-day pairs on one topic', async () => {
			const decisions = JSON.parse(await fs.readFile(knowledge('decisions.json'), 'utf8'));
			decisions.push(
				{ id: 'z1', title: 'Zeng pricing', decision: 'Zeng said the price is too high; Owen proposed a $150 trial pricing, waiting on Steve', decidedAt: '2026-09-29T01:51:00.000Z', status: 'active' },
				{ id: 'z2', title: 'Zeng pricing reply', decision: 'Zeng pricing reply drafted: $199/mo for 3 months, then $300', decidedAt: '2026-09-29T03:04:00.000Z', status: 'active' },
			);
			decisions.find((d: { id: string }) => d.id === 'd2').supersededBy = 'd1';
			await writeJson(knowledge('decisions.json'), decisions);

			const status = await service.getPageStatus(DECISIONS, { projectPath });
			const brief = await service.buildRefreshBrief(status!, { projectPath }, '/s');
			expect(brief).toContain('`dec:z1` · 2026-09-29T01:51:00.000Z');
			expect(brief).toContain('`dec:z2` · 2026-09-29T03:04:00.000Z');
			expect(brief).toContain('newest first within each group');
			expect(brief).toContain('the one with the later timestamp is in force');
			expect(brief).toContain('verify it in that primary source');
			expect(brief).toContain('NOT IN FORCE (superseded by `dec:d1`)');
			expect(brief).toContain('POSSIBLE SUPERSEDE: `dec:z2` (2026-09-29T03:04:00.000Z) may replace `dec:z1` (2026-09-29T01:51:00.000Z)');
		});

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
			expect(brief).toMatch(/`dec:d2` · 2026-09-10T00:00:00.000Z · NOT IN FORCE/);
		});
	});
});
