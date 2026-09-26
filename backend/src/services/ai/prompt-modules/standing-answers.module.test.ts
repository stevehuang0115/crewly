import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
	StandingAnswersModule,
	STANDING_ANSWERS_HEADING,
	renderStandingAnswers,
} from './standing-answers.module.js';
import { PromptAssemblyService } from './prompt-assembly.service.js';
import type { ModuleConfig } from './prompt-module.interface.js';
import {
	StandingAnswersService,
	PROJECT_STANDING_PAGES,
	AGENT_STANDING_PAGE,
	type StandingPageStatus,
	type StandingPageDef,
} from '../../memory/standing-answers.service.js';
import { STANDING_ANSWERS_CONSTANTS } from '../../../constants.js';

const FAKE_KEY = `sk-proj-${'A1b2C3d4E5'.repeat(4)}`;

/** Build a status with one section per body. */
function status(def: StandingPageDef, bodies: string[], opts: Partial<StandingPageStatus> = {}): StandingPageStatus {
	return {
		def,
		filePath: `/pages/${def.id}.md`,
		page: {
			question: def.question,
			lastRefreshed: '2026-09-26T10:00:00.000Z',
			watermark: '2026-09-26T09:00:00.000Z',
			sections: bodies.map((b, i) => ({ heading: `S${i}`, body: b, cites: ['dec:x'] })),
		},
		currentWatermark: '2026-09-26T09:00:00.000Z',
		entriesInScope: 3,
		newerEntries: 0,
		stale: false,
		...opts,
	};
}

const [DECISIONS, GOTCHAS, PREFS] = PROJECT_STANDING_PAGES;

describe('renderStandingAnswers', () => {
	it('renders nothing when no page has content', () => {
		expect(renderStandingAnswers([])).toBe('');
		expect(renderStandingAnswers([status(DECISIONS, []), { ...status(GOTCHAS, ['x']), page: undefined }])).toBe('');
	});

	it('puts the agent page first and demotes page sections under the question', () => {
		const md = renderStandingAnswers([status(DECISIONS, ['Use modules.']), status(AGENT_STANDING_PAGE, ['PR #818 in review'])]);
		expect(md.startsWith(STANDING_ANSWERS_HEADING)).toBe(true);
		expect(md.indexOf(AGENT_STANDING_PAGE.question)).toBeLessThan(md.indexOf(DECISIONS.question));
		expect(md).toContain('### What decisions are in force?\n_project · refreshed 2026-09-26_\n\n#### S0\nUse modules.');
		expect(md).not.toContain('Sources:');
	});

	it('labels a stale page with how many memories it has not absorbed', () => {
		const md = renderStandingAnswers([status(GOTCHAS, ['x'], { stale: true, newerEntries: 3 })]);
		expect(md).toContain('**STALE** — 3 newer memories since this page was refreshed (2026-09-26)');
		expect(renderStandingAnswers([status(GOTCHAS, ['x'], { stale: true, newerEntries: 1 })])).toContain('1 newer memory since');
	});

	it('caps one page body and points to the full file', () => {
		const md = renderStandingAnswers([status(DECISIONS, ['y'.repeat(STANDING_ANSWERS_CONSTANTS.PROMPT_PAGE_MAX_CHARS + 500)])]);
		expect(md).toContain('… (truncated; full page: /pages/decisions-in-force.md)');
	});

	it('enforces the section cap: never longer than PROMPT_MAX_CHARS, and names what it left out', () => {
		const big = 'z'.repeat(STANDING_ANSWERS_CONSTANTS.PROMPT_PAGE_MAX_CHARS);
		const statuses = [status(DECISIONS, [big]), status(GOTCHAS, [big]), status(PREFS, [big]), status(AGENT_STANDING_PAGE, [big])];
		const md = renderStandingAnswers(statuses);
		expect(md.length).toBeLessThanOrEqual(STANDING_ANSWERS_CONSTANTS.PROMPT_MAX_CHARS);
		expect(md).toMatch(/_Not shown \(prompt cap\): .*"Which gotchas are still open\?" — \/pages\/open-gotchas\.md/);
		// With a tiny cap the guarantee still holds.
		expect(renderStandingAnswers(statuses, 300).length).toBeLessThanOrEqual(300);
	});

	it('masks a secret in a hand-edited page', () => {
		const md = renderStandingAnswers([status(DECISIONS, [`deploy with ${FAKE_KEY}`])]);
		expect(md).not.toContain(FAKE_KEY);
		expect(md).toContain('[REDACTED api_key]');
	});
});

describe('StandingAnswersModule', () => {
	const base: ModuleConfig = {
		sessionName: 'dev-1',
		memberId: 'm1',
		role: 'developer',
		agentSkillsPath: '/skills/agent',
		tlSkillsPath: '/skills/tl',
		projectRoot: '/root',
	};

	it('sits after the startup briefings, before recovery, and is compactable', () => {
		const m = new StandingAnswersModule();
		expect(m.name).toBe('standing-answers');
		expect(m.priority).toBeGreaterThan(1.6);
		expect(m.priority).toBeLessThan(2);
		expect(m.compactable).toBe(true);
		expect(m.maxTokens * 4).toBeGreaterThanOrEqual(STANDING_ANSWERS_CONSTANTS.PROMPT_MAX_CHARS);
	});

	it('is included only with a project or a session', () => {
		const m = new StandingAnswersModule();
		expect(m.shouldInclude({ ...base, sessionName: '' })).toBe(false);
		expect(m.shouldInclude(base)).toBe(true);
		expect(m.shouldInclude({ ...base, sessionName: '', projectPath: '/p' })).toBe(true);
	});

	it('fails soft: a read error yields no section', async () => {
		const broken = { listPageStatuses: jest.fn().mockRejectedValue(new Error('EACCES')) } as unknown as StandingAnswersService;
		await expect(new StandingAnswersModule(broken).build(base)).resolves.toBe('');
	});

	describe('at boot, from files on disk (acceptance: answer without recall)', () => {
		let tmp: string;
		let projectPath: string;
		let crewlyHome: string;
		const savedHome = process.env.CREWLY_HOME;

		beforeEach(async () => {
			tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standing-mod-'));
			projectPath = path.join(tmp, 'proj');
			crewlyHome = path.join(tmp, 'home');
			process.env.CREWLY_HOME = crewlyHome;
			const kdir = path.join(projectPath, '.crewly', 'knowledge');
			await fs.mkdir(kdir, { recursive: true });
			await fs.writeFile(path.join(kdir, 'decisions.json'), JSON.stringify([
				{ id: 'd1', title: 'Prompt modules', decision: 'New prompt content is a module', decidedAt: '2026-09-20T00:00:00.000Z', status: 'active' },
			]));
			const adir = path.join(crewlyHome, 'agents', 'dev-1');
			await fs.mkdir(adir, { recursive: true });
			await fs.writeFile(path.join(adir, 'memory.json'), JSON.stringify({
				roleKnowledge: [{ id: 'k1', content: 'PR #818 awaiting review', createdAt: '2026-09-26T01:00:00.000Z' }],
			}));
			const svc = new StandingAnswersService({ crewlyHome });
			await svc.writeSection({ pageId: 'decisions-in-force', projectPath, heading: 'Prompt assembly', body: 'decision-probe: new prompt content must be a prompt module.', cites: ['dec:d1'] });
			await svc.writeSection({ pageId: 'unfinished-work', sessionName: 'dev-1', heading: 'PR #818', body: 'unfinished-probe: waiting on Steve to merge.', cites: ['mem:k1'] });
		});

		afterEach(async () => {
			if (savedHome === undefined) delete process.env.CREWLY_HOME;
			else process.env.CREWLY_HOME = savedHome;
			await fs.rm(tmp, { recursive: true, force: true });
		});

		it('the assembled prompt carries both answers, fresh, before the recovery protocol', async () => {
			const { prompt, report } = await new PromptAssemblyService().assemble({ ...base, projectPath });
			expect(report.moduleBreakdown.map((m) => m.name)).toContain('standing-answers');
			const standingAt = prompt.indexOf(STANDING_ANSWERS_HEADING);
			expect(standingAt).toBeGreaterThanOrEqual(0);
			expect(prompt).toContain('decision-probe');
			expect(prompt).toContain('unfinished-probe');
			expect(prompt.indexOf('## Session Recovery Protocol')).toBeGreaterThan(standingAt);
			expect(prompt.slice(standingAt, prompt.indexOf('## Session Recovery Protocol'))).not.toContain('**STALE** —');
		});

		it('a memory newer than the page makes the prompt label it STALE', async () => {
			const kdir = path.join(projectPath, '.crewly', 'knowledge');
			await fs.writeFile(path.join(kdir, 'decisions.json'), JSON.stringify([
				{ id: 'd1', title: 'Prompt modules', decision: 'x', decidedAt: '2026-09-20T00:00:00.000Z', status: 'active' },
				{ id: 'd2', title: 'Newer', decision: 'y', decidedAt: '2026-09-27T00:00:00.000Z', status: 'active' },
			]));
			const md = await new StandingAnswersModule(new StandingAnswersService({ crewlyHome })).build({ ...base, projectPath });
			const decisionsBlock = md.slice(md.indexOf('What decisions are in force?'));
			expect(decisionsBlock).toContain('**STALE** — 1 newer memory');
			// The agent page's memory did not move, so it stays fresh.
			const agentBlock = md.slice(0, md.indexOf('What decisions are in force?'));
			expect(agentBlock).not.toContain('**STALE** —');
		});
	});
});
