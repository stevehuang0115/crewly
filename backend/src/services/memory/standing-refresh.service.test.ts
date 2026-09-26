import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { StandingRefreshService, type RefreshPool } from './standing-refresh.service.js';
import { StandingAnswersService } from './standing-answers.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const FAKE_KEY = `sk-proj-${'A1b2C3d4E5'.repeat(4)}`;
const HOUR = 60 * 60 * 1000;

describe('StandingRefreshService', () => {
	let tmp: string;
	let projectPath: string;
	let crewlyHome: string;
	let statePath: string;
	let pool: RefreshPool & { items: WorkItem[] };
	let service: StandingAnswersService;
	let clock: number;

	const decisionsFile = (): string => path.join(projectPath, '.crewly', 'knowledge', 'decisions.json');
	const setDecisions = async (list: unknown[]): Promise<void> => {
		await fs.mkdir(path.dirname(decisionsFile()), { recursive: true });
		await fs.writeFile(decisionsFile(), JSON.stringify(list));
	};
	const decision = (id: string, at: string, text = 'rule'): Record<string, string> => ({ id, title: `T ${id}`, decision: text, decidedAt: at, status: 'active' });

	const make = (overrides: Partial<ConstructorParameters<typeof StandingRefreshService>[0]> = {}): StandingRefreshService =>
		new StandingRefreshService({
			pool,
			service,
			agentSkillsPath: '/skills/agent',
			listProjects: async () => [projectPath],
			listAgents: async () => [],
			statePath,
			now: () => clock,
			...overrides,
		});

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standing-refresh-'));
		projectPath = path.join(tmp, 'proj');
		crewlyHome = path.join(tmp, 'home');
		statePath = path.join(crewlyHome, 'standing-refresh-state.json');
		service = new StandingAnswersService({ crewlyHome });
		clock = Date.parse('2026-09-26T12:00:00.000Z');
		const items: WorkItem[] = [];
		pool = {
			items,
			addToPool: jest.fn(async (wi: WorkItem) => { items.push(wi); }),
			getAllItems: jest.fn(async () => items),
		};
		await setDecisions([decision('d1', '2026-09-20T00:00:00.000Z')]);
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	it('raises one WorkItem for a missing page that has entries, and reports what it examined', async () => {
		const res = await make().tick();
		expect(res.pagesExamined).toBe(3); // three project pages
		expect(res.created).toHaveLength(1);
		expect(res.skipped.no_entries).toBe(2); // no gotchas, no preferences
		const wi = pool.items[0];
		expect(wi.target).toBe('crewly-orc');
		expect(wi.status).toBe('queued');
		expect(wi.metadata).toMatchObject({ kind: 'standing-refresh', pageId: 'decisions-in-force', projectPath, watermark: '2026-09-20T00:00:00.000Z' });
		expect(wi.briefMarkdown).toContain('`dec:d1`');
		expect(wi.briefMarkdown).toContain('/skills/agent/core/standing-update/execute.sh --page decisions-in-force');
	});

	it('does not raise again while the watermark has not moved, even after the WorkItem closes and the cooldown passes', async () => {
		await make().tick();
		pool.items[0].status = 'done'; // closed without refreshing the page
		clock += 48 * HOUR;
		const res = await make().tick();
		expect(res.created).toHaveLength(0);
		expect(res.skipped.watermark_unchanged).toBe(1);
	});

	it('raises again once the watermark moves (after the cooldown, with no open WorkItem)', async () => {
		await make().tick();
		pool.items[0].status = 'done';
		await setDecisions([decision('d1', '2026-09-20T00:00:00.000Z'), decision('d2', '2026-09-26T08:00:00.000Z')]);

		clock += 1 * HOUR;
		expect((await make().tick()).skipped.cooldown).toBe(1);

		clock += 6 * HOUR;
		const res = await make().tick();
		expect(res.created).toHaveLength(1);
		expect(pool.items[1].metadata?.['watermark']).toBe('2026-09-26T08:00:00.000Z');
	});

	it('does not stack a second WorkItem while one is still open', async () => {
		await make().tick();
		await setDecisions([decision('d1', '2026-09-20T00:00:00.000Z'), decision('d2', '2026-09-26T08:00:00.000Z')]);
		clock += 48 * HOUR;
		const res = await make().tick();
		expect(res.skipped.inflight).toBe(1);
		expect(pool.items).toHaveLength(1);
	});

	it('a refreshed page is fresh and raises nothing', async () => {
		await service.writeSection({ pageId: 'decisions-in-force', projectPath, heading: 'Rules', body: 'rule', cites: ['dec:d1'] });
		const res = await make().tick();
		expect(res.created).toHaveLength(0);
		expect(res.skipped.fresh).toBe(1);
	});

	it('caps creations per tick; the rest wait for the next tick', async () => {
		const p2 = path.join(tmp, 'proj2');
		const p3 = path.join(tmp, 'proj3');
		for (const p of [p2, p3]) {
			await fs.mkdir(path.join(p, '.crewly', 'knowledge'), { recursive: true });
			await fs.writeFile(path.join(p, '.crewly', 'knowledge', 'decisions.json'), JSON.stringify([decision('x', '2026-09-20T00:00:00.000Z')]));
		}
		const refresher = make({ listProjects: async () => [projectPath, p2, p3], maxCreatesPerTick: 2 });
		const first = await refresher.tick();
		expect(first.created).toHaveLength(2);
		expect(first.skipped.tick_cap).toBe(1);
		const second = await refresher.tick();
		expect(second.created).toHaveLength(1);
		expect(second.created[0].key).toContain('proj3');
	});

	it('persists what it raised across restarts', async () => {
		await make().tick();
		pool.items[0].status = 'done';
		clock += 48 * HOUR;
		// A new service instance (restart) reads the state file.
		expect((await make().tick()).skipped.watermark_unchanged).toBe(1);
		const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
		expect(Object.keys(state)).toEqual([`project:${projectPath}:decisions-in-force`]);
	});

	it('routes project pages to the resolved owner, falling back to the orchestrator on error', async () => {
		await make({ resolveProjectTarget: async () => 'crewly-product-sam' }).tick();
		expect(pool.items[0].target).toBe('crewly-product-sam');

		pool.items.length = 0;
		await fs.rm(statePath, { force: true });
		await make({ resolveProjectTarget: async () => { throw new Error('storage down'); } }).tick();
		expect(pool.items[0].target).toBe('crewly-orc');
	});

	it('routes the agent page to the agent itself', async () => {
		const adir = path.join(crewlyHome, 'agents', 'dev-1');
		await fs.mkdir(adir, { recursive: true });
		await fs.writeFile(path.join(adir, 'memory.json'), JSON.stringify({ roleKnowledge: [{ id: 'k1', content: 'blocked on review', createdAt: '2026-09-26T01:00:00.000Z' }] }));
		const res = await make({ listProjects: async () => [], listAgents: async () => ['dev-1'] }).tick();
		expect(res.pagesExamined).toBe(1);
		expect(pool.items[0]).toMatchObject({ target: 'dev-1', owner: 'agent' });
		expect(pool.items[0].briefMarkdown).toContain('--page unfinished-work --session dev-1');
	});

	it('the WorkItem never carries a secret from the source memory', async () => {
		await setDecisions([decision('d1', '2026-09-20T00:00:00.000Z', `rotate ${FAKE_KEY} monthly`)]);
		await make().tick();
		expect(JSON.stringify(pool.items[0])).not.toContain(FAKE_KEY);
	});

	describe('status reports do not flood refreshes (TL requirement, #816 after PR-A)', () => {
		/**
		 * Replays what one report-status call writes, through the real memory
		 * writers: the auto_remember "[COMPLETED]" decision, the project
		 * learning (learnings.md), and — the worst case — the same learning
		 * mirrored into the agent's roleKnowledge.
		 */
		const N = 10;
		let projectMemory: import('./project-memory.service.js').ProjectMemoryService;
		let agentMemory: import('./agent-memory.service.js').AgentMemoryService;

		const report = async (i: number, status: 'done' | 'failed'): Promise<void> => {
			const summary = `report ${i}: ${status === 'done' ? 'shipped' : 'broke on'} widget-${i} with a long enough summary`;
			await projectMemory.addDecision(projectPath, { title: `[COMPLETED] Task completed by dev-1: ${summary}`, decision: `[COMPLETED] ${summary}`, rationale: '', decidedBy: 'dev-1' });
			const learning = `${status === 'done' ? 'Task completed' : 'Task failed'}: ${summary}`;
			await projectMemory.recordLearning(projectPath, 'dev-1', 'developer', learning);
			await agentMemory.addRoleKnowledge('dev-1', { category: 'best-practice', content: learning, confidence: 0.5 });
		};

		beforeEach(async () => {
			const { ProjectMemoryService } = await import('./project-memory.service.js');
			const { AgentMemoryService } = await import('./agent-memory.service.js');
			projectMemory = ProjectMemoryService.getInstance();
			agentMemory = new AgentMemoryService(crewlyHome);
			await agentMemory.initializeAgent('dev-1', 'developer');
			await agentMemory.addRoleKnowledge('dev-1', { category: 'best-practice', content: 'Blocked on review of PR #818', confidence: 0.5 });
			// Both pages start fresh.
			await service.writeSection({ pageId: 'decisions-in-force', projectPath, heading: 'Rules', body: 'rule', cites: ['dec:d1'] });
			const [mem] = await service.loadSourceEntries((await import('./standing-answers.service.js')).AGENT_STANDING_PAGE, { sessionName: 'dev-1' });
			await service.writeSection({ pageId: 'unfinished-work', sessionName: 'dev-1', heading: 'PR', body: 'blocked', cites: [mem.cite] });
		});

		const tickAll = (): Promise<import('./standing-refresh.service.js').RefreshTickResult> =>
			make({ listAgents: async () => ['dev-1'] }).tick();

		it(`${N} "done" reports, one tick after each: 0 refresh WorkItems, and the pages stay fresh`, async () => {
			let examined = 0;
			for (let i = 0; i < N; i++) {
				await report(i, 'done');
				examined += (await tickAll()).pagesExamined;
				clock += 10 * 60 * 1000; // 10 min apart: all inside one cooldown window
			}
			expect(examined).toBe(N * 4); // 3 project pages + 1 agent page, every tick
			expect(pool.items).toHaveLength(0);
			const statuses = await service.listPageStatuses({ projectPath, sessionName: 'dev-1' });
			expect(statuses.filter((s) => s.page && s.stale)).toEqual([]);
			// The reports really were written (not a vacuous pass).
			const decisions = JSON.parse(await fs.readFile(decisionsFile(), 'utf8')) as unknown[];
			expect(decisions.length).toBe(1 + N);
			const learnings = await fs.readFile(path.join(projectPath, '.crewly', 'knowledge', 'learnings.md'), 'utf8');
			expect(learnings.split('Task completed:').length - 1).toBe(N);
		});

		it(`${N} "failed" reports inside one refresh window raise at most 1 refresh WorkItem`, async () => {
			for (let i = 0; i < N; i++) {
				await report(i, 'failed');
				await tickAll();
				clock += 10 * 60 * 1000;
			}
			// Failed reports ARE in scope for the agent page, so exactly one is
			// raised; the other N-1 ticks are held by the open WorkItem / cooldown.
			expect(pool.items).toHaveLength(1);
			expect(pool.items.every((wi) => wi.target === 'dev-1')).toBe(true); // never a project page
		});
	});

	it('examines nothing when there are no projects or agents, and says so', async () => {
		const res = await make({ listProjects: async () => [] }).tick();
		expect(res.pagesExamined).toBe(0);
		expect(res.created).toHaveLength(0);
	});
});
