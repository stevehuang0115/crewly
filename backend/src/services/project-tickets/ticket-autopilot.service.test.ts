/**
 * Tests for the ticket autopilot service: settings permissions, waking the
 * driver (debounce, idle trigger, budget brake, stale triage), owner question
 * batching and the evening digest — all on an injected clock.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TICKET_AUTOPILOT_CONSTANTS as C } from '../../constants.js';
import { RestartDrainService } from '../restart/restart-drain.service.js';
import { ProjectTicketService } from './project-ticket.service.js';
import { ProjectTicketWorkflowService, type ProjectTicketPool } from './project-ticket-workflow.service.js';
import { TicketAutopilotService, type OwnerNotice } from './ticket-autopilot.service.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { TraceStore, setTraceStoreForTesting } from '../trace/trace-store.js';
import { setTraceContextForTesting } from '../trace/trace-context.service.js';
import { setTraceAnalysisForTesting } from '../trace/trace-analysis.service.js';
import type { AutopilotRetroDeps } from './ticket-autopilot.service.js';
import { applyRetroGapDecision } from './ticket-autopilot-retro.js';
import { notePausedTeam, resetTeamPauseRegistryForTesting } from '../team/team-pause.registry.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

const MIN = 60_000;
const HOUR = 60 * MIN;

function member(id: string, sessionName: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, name: id, sessionName, role: 'developer', systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '', ...extra } as TeamMember;
}

/** In-memory pool: enough for the workflow and the autopilot. */
class FakePool implements ProjectTicketPool {
  items = new Map<string, WorkItem>();
  async addToPool(wi: WorkItem): Promise<void> {
    this.items.set(wi.id, { ...wi });
  }
  async claimSpecificItem(agentId: string, id: string): Promise<{ workItem: WorkItem } | null> {
    const wi = this.items.get(id);
    if (!wi || wi.status !== 'queued' || (wi.target && wi.target !== agentId)) return null;
    wi.status = 'running';
    return { workItem: { ...wi } };
  }
  async findWorkItem(id: string): Promise<WorkItem | null> {
    return this.items.get(id) ?? null;
  }
  async getAllItems(): Promise<WorkItem[]> {
    return [...this.items.values()];
  }
  cancelQueued = jest.fn(async (id: string) => {
    const wi = this.items.get(id);
    if (wi) wi.status = 'cancelled';
  });
  async transitionStatus(id: string, status: WorkItemStatus): Promise<WorkItem | null> {
    const wi = this.items.get(id);
    if (wi) wi.status = status;
    return wi ?? null;
  }
  async releaseClaim(): Promise<void> {
    return undefined;
  }
  async mergeItemMetadata(id: string, patch: Record<string, unknown>): Promise<WorkItem | null> {
    const wi = this.items.get(id);
    if (!wi) return null;
    wi.metadata = { ...(wi.metadata ?? {}), ...patch };
    return { ...wi };
  }
  triage(): WorkItem[] {
    return [...this.items.values()].filter((wi) => wi.type === 'ticket_triage');
  }
}

describe('TicketAutopilotService', () => {
  let root: string;
  let clock: Date;
  let project: Project;
  let teams: Team[];
  let pool: FakePool;
  let wf: ProjectTicketWorkflowService;
  let spent: number;
  let boostOf: (teamIds: string[]) => { extra: number; unlimited: boolean };
  let notices: OwnerNotice[];
  let notifyOk: boolean;
  let svc: TicketAutopilotService;
  const owner = {};
  const orc = { session: 'crewly-orc' };
  const lead = { session: 'ce-owen' };
  const dev = { session: 'ce-dev' };

  const at = (h: number, m = 0) => new Date(2026, 8, 30, h, m, 0);
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  function build(extra: Partial<ConstructorParameters<typeof TicketAutopilotService>[0]> = {}): TicketAutopilotService {
    return new TicketAutopilotService({
      tickets: wf['tickets'] as ProjectTicketService,
      pool,
      directory: {
        getTeams: async () => teams,
        getProjects: async () => [project],
        saveProject: async (p) => {
          project = p;
        },
      },
      workflow: wf,
      ledger: { getSessionUsageSince: (s: string) => ({ totalTokens: s === 'ce-dev' ? spent : 0 }) },
      boosts: (teamIds: string[]) => boostOf(teamIds),
      notifyOwner: async (n) => {
        if (!notifyOk) return false;
        notices.push(n);
        return true;
      },
      stateFile: path.join(root, 'state.json'),
      now: () => clock,
      logger: quiet(),
      ...extra,
    });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-autopilot-'));
    clock = at(10);
    project = { id: 'p-ce', name: 'CE', path: path.join(root, 'ce'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    await fs.mkdir(project.path, { recursive: true });
    teams = [
      {
        id: 't-ce',
        name: 'CE',
        members: [member('m-lead', 'ce-owen', { role: 'team-leader' }), member('m-dev', 'ce-dev')],
        projectIds: ['p-ce'],
        createdAt: '',
        updatedAt: '',
      },
    ];
    pool = new FakePool();
    wf = new ProjectTicketWorkflowService({
      tickets: new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked', now: () => clock.toISOString() }),
      pool,
      directory: { getTeams: async () => teams, getProjects: async () => [project] },
      logger: quiet(),
      now: () => clock.toISOString(),
    });
    spent = 0;
    boostOf = () => ({ extra: 0, unlimited: false });
    notices = [];
    notifyOk = true;
    svc = build();
    svc.start(0);
  });

  afterEach(async () => {
    svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const enable = (extra: Record<string, unknown> = {}) => svc.updateSettings('p-ce', { enabled: true, ...extra }, owner);

  describe('settings', () => {
    it('only the owner and the orchestrator may read or change them', async () => {
      await expect(svc.getStatus('p-ce', lead)).rejects.toMatchObject({ status: 403 });
      await expect(svc.updateSettings('p-ce', { enabled: true }, lead)).rejects.toMatchObject({ status: 403 });
      await expect(svc.updateSettings('p-ce', { enabled: true }, dev)).rejects.toMatchObject({ status: 403 });
      await expect(svc.updateSettings('p-ce', { enabled: true }, { session: 'someone-else' })).rejects.toMatchObject({ status: 403 });
      const status = await svc.updateSettings('p-ce', { enabled: true }, orc);
      expect(status.settings.enabled).toBe(true);
      expect(project.ticketAutopilot).toEqual({ enabled: true });
      expect((await svc.getStatus('CE', owner)).driver).toEqual({ session: 'ce-owen', teamId: 't-ce', source: 'team_lead' });
    });

    it('accepts only a lead of a project team as driver', async () => {
      await expect(enable({ driver: 'ce-dev' })).rejects.toMatchObject({ status: 400 });
      const s = await enable({ driver: 'ce-owen' });
      expect(s.driver).toMatchObject({ session: 'ce-owen', source: 'setting' });
    });
  });

  describe('driver = the team lead by the one rule', () => {
    it('defaults to a tech-lead with no leaderIds (CE / Owen)', async () => {
      teams[0].members = [member('m-dev', 'ce-dev'), member('m-lead', 'ce-owen', { role: 'tech-lead' as TeamMember['role'] })];
      expect((await enable()).driver).toEqual({ session: 'ce-owen', teamId: 't-ce', source: 'team_lead' });
    });

    it('defaults to the explicit lead over a lead role, and validates an override by the same rule', async () => {
      teams[0].leaderIds = ['m-dev'];
      expect((await enable()).driver).toEqual({ session: 'ce-dev', teamId: 't-ce', source: 'team_lead' });
      // The team-leader role no longer leads once the team names its lead.
      await expect(enable({ driver: 'ce-owen' })).rejects.toMatchObject({ status: 400 });
      expect((await enable({ driver: 'ce-dev' })).driver).toMatchObject({ session: 'ce-dev', source: 'setting' });
    });
  });

  describe('the triage brief', () => {
    it('lists a stopped member as available (not busy), with its role line', async () => {
      teams[0].members.push(
        member('m-nova', '', { agentId: 'ce-nova-a2b1f759', name: 'Nova', role: 'content-strategist' as TeamMember['role'], agentStatus: 'inactive' }),
        member('m-vera', 'ce-vera', { name: 'Vera', workingStatus: 'in_progress' }),
      );
      svc = build();
      (svc as unknown as { deps: { roleDescription?: (r: string) => Promise<string | null> } }).deps.roleDescription = async (r) =>
        r === 'developer' ? 'Software developer focused on clean code' : null;
      await enable();
      await wf.create('p-ce', { title: 'Write the H-1B article and its images' }, owner);
      await svc.tick();
      const brief = pool.triage()[0].briefMarkdown ?? '';
      expect(brief).toContain('- ce-nova-a2b1f759 (Nova, content-strategist) — stopped: available, will be started when assigned; 0 in progress');
      expect(brief).toContain('- ce-vera (Vera, developer) — working; 0 in progress');
      expect(brief).toContain('(m-lead, team-leader, lead) — idle');
      expect(brief).not.toContain('busy');
      expect(brief).toContain('  role: Plans and writes content');
      expect(brief).toContain('  role: Software developer focused on clean code');
      expect(brief).toContain('Role is a preference, not a limit');
    });
  });

  describe('wind-down hold', () => {
    afterEach(() => RestartDrainService.resetInstance());

    it('ticks nothing while Crewly winds down for a shutdown / restart', async () => {
      await enable();
      await wf.create('p-ce', { title: 'A' }, owner);
      RestartDrainService.getInstance().beginWindDown('test');
      expect(await svc.tick()).toEqual([]);
      expect(pool.triage()).toHaveLength(0);
    });
  });

  describe('waking the driver', () => {
    it('does nothing while the switch is off', async () => {
      await wf.create('p-ce', { title: 'A' }, owner);
      expect(await svc.tick()).toEqual([]);
      expect(pool.triage()).toHaveLength(0);
    });

    it('creates ONE triage item for the lead, without verification, listing the backlog', async () => {
      await enable();
      const a = await wf.create('p-ce', { title: 'Partner email', priority: 'P1', labels: ['email'] }, owner);
      const b = await wf.create('p-ce', { title: 'Fix typo' }, dev);
      const [ev] = await svc.tick();
      expect(ev.decision).toEqual({ action: 'triage' });
      const [wi] = pool.triage();
      expect(wi).toMatchObject({
        type: 'ticket_triage',
        target: 'ce-owen',
        status: 'queued',
        metadata: { kind: 'ticket_triage', projectId: 'p-ce', requiresVerification: false, ticketIds: [a.id, b.id] },
      });
      expect(wi.briefMarkdown).toContain(`${b.id} · P2 · backlog`);
      expect(wi.briefMarkdown).toContain('**worker-created — review first**');
      expect(wi.briefMarkdown).toContain('deploying to production');

      // Still live → no second one.
      advance(HOUR);
      expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'triage_in_flight' });
      expect(pool.triage()).toHaveLength(1);
    });

    it('re-triggers at most every 30 minutes, and only for tickets not already listed', async () => {
      await enable();
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      pool.triage()[0].status = 'done';

      advance(5 * MIN);
      expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'nothing_to_triage' });

      const c = await wf.create('p-ce', { title: 'C' }, owner);
      advance(10 * MIN);
      expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'too_soon' });
      advance(20 * MIN);
      const [ev] = await svc.tick();
      expect(ev.decision).toEqual({ action: 'triage' });
      expect(ev.workItem?.metadata?.ticketIds).toEqual([c.id]);
    });

    it('a member going idle with nothing ready triggers sooner (but not in a loop)', async () => {
      await enable();
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      pool.triage()[0].status = 'done';
      await wf.create('p-ce', { title: 'B' }, owner);

      advance(2 * MIN);
      expect((await svc.onMemberIdle('ce-dev'))[0].decision).toEqual({ action: 'skip', reason: 'too_soon' });
      advance(C.IDLE_TRIGGER_MIN_INTERVAL_MS);
      expect((await svc.onMemberIdle('ce-dev'))[0].decision).toEqual({ action: 'triage' });
      expect(await svc.onMemberIdle('not-on-the-team')).toEqual([]);
    });

    it('does not wake anyone when nobody on the team is idle', async () => {
      await enable();
      for (const m of teams[0].members) m.workingStatus = 'in_progress';
      await wf.create('p-ce', { title: 'A' }, owner);
      expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'nobody_idle' });
    });

    it('replaces a triage item nobody picked up for hours', async () => {
      await enable();
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      const first = pool.triage()[0];
      advance(C.TRIAGE_STALE_QUEUED_MS);
      await wf.create('p-ce', { title: 'B' }, owner);
      const [ev] = await svc.tick();
      expect(pool.cancelQueued).toHaveBeenCalledWith(first.id, expect.any(String));
      expect(ev.decision).toEqual({ action: 'triage' });
    });

    it('remembers the last triage across a restart', async () => {
      await enable();
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      pool.triage()[0].status = 'done';
      await wf.create('p-ce', { title: 'B' }, owner);
      advance(10 * MIN);
      const restarted = build();
      expect((await restarted.tick())[0].decision).toEqual({ action: 'skip', reason: 'too_soon' });
    });
  });

  describe('budget brake', () => {
    it('pauses for the day at the budget, tells the owner once, and stops ticket auto-claim', async () => {
      await enable({ dailyBudgetTokens: '5M' });
      await wf.create('p-ce', { title: 'A' }, owner);
      await wf.create('p-ce', { title: 'Ready one', status: 'ready' }, owner);
      spent = 5_200_000;
      expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'budget_reached' });
      expect(pool.triage()).toHaveLength(0);
      advance(HOUR);
      await svc.tick();
      const paused = notices.filter((n) => n.title === 'Ticket autopilot paused');
      expect(paused).toHaveLength(1);
      expect(paused[0].message).toContain('5.2M tokens of its 5M tokens daily budget');

      expect(await svc.policy().isAutoClaimPaused(project)).toBe(true);
      expect(await wf.claimNextForAgent('ce-dev')).toBeNull();
      expect((await svc.getStatus('p-ce', owner)).pausedForToday).toBe(true);

      spent = 0;
      expect(await svc.policy().isAutoClaimPaused(project)).toBe(false);
      expect((await wf.claimNextForAgent('ce-dev'))?.ticket.title).toBe('Ready one');
    });

    it('honours a boost on the project\'s team: +X raises today\'s budget, unlimited lifts it', async () => {
      await enable({ dailyBudgetTokens: '5M' });
      await wf.create('p-ce', { title: 'A' }, owner);
      spent = 6_000_000;
      expect(await svc.policy().isAutoClaimPaused(project)).toBe(true);

      boostOf = (ids) => (ids.includes('t-ce') ? { extra: 5_000_000, unlimited: false } : { extra: 0, unlimited: false });
      expect(await svc.policy().isAutoClaimPaused(project)).toBe(false);
      const status = await svc.getStatus('p-ce', owner);
      expect(status).toMatchObject({ usedTodayTokens: 6_000_000, budgetTodayTokens: 10_000_000, boostTokens: 5_000_000, pausedForToday: false });
      expect((await svc.tick())[0].decision.action).not.toBe('skip');

      spent = 900_000_000;
      boostOf = () => ({ extra: 0, unlimited: true });
      expect(await svc.policy().isAutoClaimPaused(project)).toBe(false);
      expect((await svc.getStatus('p-ce', owner)).budgetTodayTokens).toBeNull();
    });

    it('converts a stored USD budget to tokens once and logs it', async () => {
      project = { ...project, ticketAutopilot: { enabled: true, dailyBudgetUsd: 12 } };
      expect(await svc.migrateUsdBudgets()).toBe(1);
      expect(project.ticketAutopilot).toEqual({ enabled: true, dailyBudgetTokens: 12_000_000 });
      expect(await svc.migrateUsdBudgets()).toBe(0);
    });

    it('caps in-progress tickets per member while on', async () => {
      await enable();
      const a = await wf.create('p-ce', { title: 'A', status: 'ready' }, owner);
      const b = await wf.create('p-ce', { title: 'B', status: 'ready' }, owner);
      await wf.assign('p-ce', a.id, 'ce-dev', lead);
      await expect(wf.assign('p-ce', b.id, 'ce-dev', lead)).rejects.toMatchObject({ status: 409 });
      await svc.updateSettings('p-ce', { maxInFlightPerMember: 2 }, owner);
      await expect(wf.assign('p-ce', b.id, 'ce-dev', lead)).resolves.toMatchObject({ ticket: { status: 'in_progress' } });
      expect(await svc.policy().maxInFlightPerMember({ ...project, ticketAutopilot: { enabled: false } })).toBeNull();
    });
  });

  describe('owner questions', () => {
    it('sends no batched "Tickets waiting on you" DM — decision cards carry the questions', async () => {
      await enable();
      const t = await wf.create('p-ce', { title: 'Partner email' }, owner);
      await wf.askOwner('p-ce', t.id, lead, { question: 'Send the draft to the 3 partners?' });
      await svc.tick();
      advance(3 * HOUR);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets waiting on you')).toHaveLength(0);
    });
  });

  describe('daily digest', () => {
    it('goes out once in the evening, and is skipped when nothing changed', async () => {
      await enable();
      for (const m of teams[0].members) m.workingStatus = 'in_progress';
      const a = await wf.create('p-ce', { title: 'Export CSV', status: 'ready' }, owner);
      await wf.transition('p-ce', a.id, 'cancelled', owner);
      const b = await wf.create('p-ce', { title: 'Landing page', status: 'ready' }, owner);
      await wf.assign('p-ce', b.id, 'ce-dev', lead);

      clock = at(20, 30);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets today')).toHaveLength(0);

      clock = at(21, 5);
      await svc.tick();
      const digest = notices.filter((n) => n.title === 'Tickets today');
      expect(digest).toHaveLength(1);
      expect(digest[0].message).toContain(`In progress (1): ${b.id} Landing page (ce-dev)`);
      expect(digest[0].message).not.toMatch(/WorkItem|[0-9a-f]{8}-[0-9a-f]{4}-/);

      clock = at(23);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets today')).toHaveLength(1);

      clock = new Date(2026, 9, 1, 21, 5);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets today')).toHaveLength(1);
    });

    it('carries the team leads block; a failing block never stops the digest (crewly#1083)', async () => {
      const leadShareDigest = jest.fn(async () => '*Team leads* (lead share of team tokens)\n- *CE* (Owen): 64% of 9.9M today, 55% this week');
      svc = build({ leadShareDigest });
      await enable();
      await wf.create('p-ce', { title: 'Export CSV', status: 'ready' }, owner);
      clock = at(21, 5);
      await svc.tick();
      const digest = notices.find((n) => n.title === 'Tickets today');
      expect(leadShareDigest).toHaveBeenCalledWith(clock);
      expect(digest?.message).toContain('*Team leads* (lead share of team tokens)');

      notices.length = 0;
      leadShareDigest.mockRejectedValue(new Error('ledger down'));
      clock = new Date(2026, 9, 1, 21, 5);
      const b = await wf.create('p-ce', { title: 'Another', status: 'ready' }, owner);
      await wf.assign('p-ce', b.id, 'ce-dev', lead);
      await svc.tick();
      const second = notices.find((n) => n.title === 'Tickets today');
      expect(second?.message).toContain('Another');
      expect(second?.message).not.toContain('Team leads');
    });
  });

  describe('tracing, stats and the daily retro (specs/2026-10-03-autopilot-experiments.md)', () => {
    let traceDir: string;
    let store: TraceStore;
    let crewly: Project;
    let wiki: Array<{ projectPath: string; rel: string; md: string }>;
    let asks: Array<Parameters<AutopilotRetroDeps['askOwner']>[0]>;
    let moved: Array<[string, string, string]>;
    let experimentRunning: boolean;
    let askFails: boolean;

    const evts = async (traceId: string) => (await store.read(traceId, 0, 1000))!.events;
    const actions = async (traceId: string) => (await evts(traceId)).filter((e) => e.type === 'autopilot.action').map((e) => e.data?.action);
    const settle = () => new Promise((r) => setTimeout(r, 20));

    function buildWithRetro(): TicketAutopilotService {
      const ticketsSvc = wf['tickets'] as ProjectTicketService;
      const retro: AutopilotRetroDeps = {
        writeWiki: async (projectPath, rel, md) => {
          wiki.push({ projectPath, rel, md });
          return true;
        },
        harnessProject: async () => crewly,
        createTicket: async (target, input) => {
          const t = await ticketsSvc.create(target.path, target.name, { ...input, status: 'backlog' }, 'autopilot');
          return { id: t.id, title: t.title };
        },
        applyGapDecision: async (projectPath, id, approve, note) => {
          const outcome = await applyRetroGapDecision(ticketsSvc, projectPath, id, approve, note);
          moved.push([id, outcome, note]);
          return outcome;
        },
        askOwner: async (input) => {
          if (askFails) throw new Error('Decision cards are not running');
          asks.push(input);
          return { id: `D-${asks.length}` };
        },
      };
      const s2 = build();
      const deps = (s2 as unknown as { deps: Record<string, unknown> & { directory: Record<string, unknown> } }).deps;
      Object.assign(deps, { retro, runningExperiment: async () => experimentRunning });
      deps.directory = { ...deps.directory, getProjects: async () => [project, crewly] };
      return s2;
    }

    beforeEach(async () => {
      traceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-ap-traces-'));
      store = new TraceStore({ dir: traceDir, indexFlushDelayMs: 5 });
      setTraceStoreForTesting(store);
      setTraceContextForTesting(null);
      setTraceAnalysisForTesting(null);
      crewly = { id: 'p-crewly', name: 'Crewly', path: path.join(root, 'crewly'), teams: {}, status: 'active', createdAt: '', updatedAt: '' } as Project;
      await fs.mkdir(crewly.path, { recursive: true });
      teams.push({ id: 't-crewly', name: 'Crewly', members: [member('m-cl', 'crewly-lead', { role: 'team-leader' }), member('m-cd', 'crewly-dev')], projectIds: ['p-crewly'], createdAt: '', updatedAt: '' } as Team);
      wiki = [];
      asks = [];
      moved = [];
      experimentRunning = false;
      askFails = false;
      svc.stop();
      svc = buildWithRetro();
      svc.start(0);
    });

    afterEach(async () => {
      await store.idle();
      setTraceStoreForTesting(null);
      setTraceContextForTesting(null);
      setTraceAnalysisForTesting(null);
      await fs.rm(traceDir, { recursive: true, force: true });
    });

    it('traces the triage in the day\'s run trace and records each skip reason once', async () => {
      await enable();
      const a = await wf.create('p-ce', { title: 'Feed chips', labels: ['feed'] }, owner);
      await svc.tick();
      const [wi] = pool.triage();
      const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0];
      expect(run.tags?.autopilot).toEqual({ projectId: 'p-ce', day: '2026-09-30' });
      // The triage turn has its own trace (tagged), not the run trace's event budget.
      const triage = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'triage' })[0];
      expect(wi.traceId).toBe(triage.traceId);
      expect(wi.traceId).not.toBe(run.traceId);
      expect((await evts(triage.traceId)).some((e) => e.data?.action === 'triage')).toBe(true);
      const steps = (await evts(run.traceId)).filter((e) => e.type === 'autopilot.action');
      expect(steps.map((e) => [e.data?.action, e.refs.ticketId])).toEqual([
        ['triage', undefined],
        ['triage_ticket', a.id],
      ]);
      expect(steps[1].data?.labels).toBe('feed');
      advance(10 * MIN);
      await svc.tick();
      advance(10 * MIN);
      await svc.tick();
      expect(await actions(run.traceId)).toEqual(['triage', 'triage_ticket', 'skip']);
      expect((await evts(run.traceId)).filter((e) => e.data?.action === 'skip')[0].data?.reason).toBe('triage_in_flight');
    });

    it('traces the budget brake: paused, then resumed by a boost', async () => {
      await enable({ dailyBudgetTokens: 1000 });
      await wf.create('p-ce', { title: 'A' }, owner);
      spent = 5000;
      await svc.tick();
      boostOf = () => ({ extra: 10_000, unlimited: false });
      advance(HOUR);
      await svc.tick();
      const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0];
      const brake = (await evts(run.traceId)).filter((e) => String(e.data?.action).startsWith('budget_'));
      expect(brake.map((e) => [e.data?.action, e.data?.reason ?? null])).toEqual([
        ['budget_paused', null],
        ['budget_resumed', 'boost'],
      ]);
    });

    it('gates on budget tokens, not raw tokens: heavy cache reads do not pause the autopilot (crewly#1090)', async () => {
      await enable({ dailyBudgetTokens: 50_000_000 });
      await wf.create('p-ce', { title: 'A' }, owner);
      // CE 2026-10-04: 108.5M raw, 14.2M weighted.
      const heavy = build({ ledger: { getSessionUsageSince: (s: string) => (s === 'ce-dev' ? { totalTokens: 108_548_716, budgetTokens: 14_182_728 } : { totalTokens: 0, budgetTokens: 0 }) } });
      const status = await heavy.getStatus('p-ce', owner);
      expect(status).toMatchObject({ usedTodayTokens: 14_182_728, usedTodayRawTokens: 108_548_716, budgetTodayTokens: 50_000_000, pausedForToday: false });
      expect(await heavy.policy().isAutoClaimPaused(project)).toBe(false);
      await heavy.tick();
      expect(notices).toHaveLength(0);
    });

    it('pauses on the weighted figure, and the notice and the budget_paused trace show weighted and raw', async () => {
      await enable({ dailyBudgetTokens: 10_000_000 });
      await wf.create('p-ce', { title: 'A' }, owner);
      const heavy = build({ ledger: { getSessionUsageSince: (s: string) => (s === 'ce-dev' ? { totalTokens: 108_548_716, budgetTokens: 14_182_728 } : { totalTokens: 0, budgetTokens: 0 }) } });
      expect(await heavy.policy().isAutoClaimPaused(project)).toBe(true);
      await heavy.tick();
      expect(notices).toHaveLength(1);
      expect(notices[0].message).toContain('14.2M tokens of its 10M tokens daily budget');
      expect(notices[0].message).toContain('109M tokens raw');
      const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0];
      const paused = (await evts(run.traceId)).find((e) => e.data?.action === 'budget_paused');
      expect(paused?.data).toMatchObject({ spentTokens: 14_182_728, rawSpentTokens: 108_548_716, budgetTokens: 10_000_000 });
      expect(String(paused?.summary ?? '')).toContain('14182728 of 10000000 budget tokens; 108548716 raw');
    });

    it('counts the autopilot stats ledger in budget tokens against the budget, with the raw figure beside it', async () => {
      await enable({ dailyBudgetTokens: 50_000_000 });
      const heavy = build({ ledger: { getSessionUsageSince: (s: string) => (s === 'ce-dev' ? { totalTokens: 108_548_716, budgetTokens: 14_182_728, cost: 3 } : { totalTokens: 0, budgetTokens: 0 }) } });
      const stats = await heavy.getStats('p-ce', lead, { days: 1 });
      expect(stats.total.budget).toMatchObject({ ledgerTokens: 14_182_728, ledgerRawTokens: 108_548_716 });
      expect(stats.total.budget.pct).toBeCloseTo(0.284, 3);
    });

    it('runs a started ticket in a tagged trace with its labels, and counts it in the stats and runs', async () => {
      await enable();
      const t = await wf.create('p-ce', { title: 'Feed chips', labels: ['feed'], status: 'ready' }, owner);
      const started = await wf.assign('p-ce', t.id, 'ce-dev', lead);
      await settle();
      const traceId = started.workItem!.traceId as string;
      expect(store.getEntry(traceId)).toMatchObject({ root: { kind: 'ticket' }, tags: { autopilot: { projectId: 'p-ce', day: '2026-09-30' }, labels: ['feed'] } });
      advance(3 * HOUR);
      await (wf['tickets'] as ProjectTicketService).transition(project.path, t.id, 'done', 'crewly');
      await settle();
      expect((await evts(traceId)).filter((e) => e.type === 'ticket.status').map((e) => e.data?.to)).toEqual(['in_progress', 'done']);

      const stats = await svc.getStats('p-ce', lead, { days: 3 });
      const today = stats.days[stats.days.length - 1];
      expect([today.started, today.done, today.verified]).toEqual([1, 1, 1]);
      expect(today.cycleTime.toVerified.medianMs).toBe(3 * HOUR);
      expect(stats.labels).toEqual(['feed']);
      expect((await svc.getStats('p-ce', owner, { label: 'other' })).total.started).toBe(0);
      await expect(svc.getStats('p-ce', dev)).rejects.toMatchObject({ status: 403 });
      await expect(svc.getStats('p-ce', owner, { days: 400 })).rejects.toMatchObject({ status: 400 });

      const runs = await svc.getRuns('p-ce', orc, { days: 2 });
      expect(runs.days[0].day).toBe('2026-09-30');
      expect(runs.days[0].runTraceId).toBeTruthy();
      expect(runs.days[0].traces.map((r) => [r.traceId, r.labels])).toEqual([[traceId, ['feed']]]);
      expect(await actions(runs.days[0].runTraceId as string)).toContain('dispatch');
    });

    it('schedules yesterday\'s retro once, at 09:00, only when it is on', async () => {
      await enable();
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick(); // day 1: a triage → a run trace
      const retros = () => [...pool.items.values()].filter((w) => w.type === 'autopilot_retro');

      clock = new Date(2026, 9, 1, 8, 30);
      await svc.tick();
      expect(retros()).toHaveLength(0); // not on (no experiment, no setting)

      experimentRunning = true;
      await svc.tick();
      expect(retros()).toHaveLength(0); // before 09:00

      clock = new Date(2026, 9, 1, 9, 5);
      await svc.tick();
      expect(retros()).toHaveLength(1);
      const [r] = retros();
      expect(r).toMatchObject({ target: 'ce-owen', metadata: { kind: 'autopilot_retro', projectId: 'p-ce', day: '2026-09-30', requiresVerification: false } });
      const yesterdayRun = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot', day: '2026-09-30' })[0];
      expect(r.traceId).toBe(yesterdayRun.traceId);
      expect(r.briefMarkdown).toContain('Tickets: 1 triaged');
      expect(r.briefMarkdown).toContain(`--trace ${yesterdayRun.traceId}`);

      advance(HOUR);
      await svc.tick();
      expect(retros()).toHaveLength(1);
      expect((await svc.getStatus('p-ce', owner)).retroOn).toBe(true);
      await svc.updateSettings('p-ce', { retro: false }, owner);
      expect((await svc.getStatus('p-ce', owner)).retroOn).toBe(false);
    });

    it('a retro writes the wiki, files deduped and capped harness gaps, and asks ONE card', async () => {
      await enable();
      await (wf['tickets'] as ProjectTicketService).create(crewly.path, 'Crewly', { title: 'Triage brief lists a stopped member as busy' }, 'owner');
      const body = {
        day: '2026-09-30',
        summary: 'Shipped nothing; CE-1 stalled waiting on the owner.',
        problems: [
          { class: 'owner_dependency', title: 'CE-1 waited for copy approval' },
          { class: 'harness_gap', title: 'Triage brief lists a stopped member as busy' },
          { class: 'harness_gap', title: 'Reconciler never woke the stopped lead', evidence: 'tr-x' },
          { class: 'harness_gap', title: 'Decision card posted in the wrong thread' },
          { class: 'harness_gap', title: 'Ticket digest repeats yesterday tickets' },
          { class: 'harness_gap', title: 'Status report routed to the orchestrator twice' },
        ],
      };
      await expect(svc.submitRetro('p-ce', body, dev)).rejects.toMatchObject({ status: 403 });
      await expect(svc.submitRetro('p-ce', { day: 'x' }, lead)).rejects.toMatchObject({ status: 400 });
      const res = await svc.submitRetro('p-ce', body, lead);
      expect(res.written).toBe(true);
      expect(wiki[0]).toMatchObject({ projectPath: project.path, rel: 'llm-curated/autopilot-retros/2026-09-30.md' });
      expect(wiki[0].md).toContain('### Owner dependency');
      expect(res.duplicates.map((d) => d.title)).toEqual(['Triage brief lists a stopped member as busy']);
      expect(res.filed.map((t) => t.title)).toEqual([
        'Reconciler never woke the stopped lead',
        'Decision card posted in the wrong thread',
        'Ticket digest repeats yesterday tickets',
      ]);
      expect(res.overCap).toEqual(['Status report routed to the orchestrator twice']);
      expect(asks).toHaveLength(1);
      expect(asks[0]).toMatchObject({ key: 'retro:p-ce:2026-09-30', question: 'File these 3 harness gaps for the Crewly team?' });
      const { tickets } = await (wf['tickets'] as ProjectTicketService).list(crewly.path);
      const filed = tickets.filter((t) => res.filed.some((f) => f.id === t.id));
      // Held until the owner approves: retro-pending keeps them out of triage.
      expect(filed.every((t) => t.status === 'backlog' && t.labels.includes('harness-gap') && t.labels.includes('retro-pending') && !t.labels.includes('needs-owner') && t.source === 'retro:CE:2026-09-30')).toBe(true);

      // Same retro again the same day: everything is a duplicate, no new card.
      const again = await svc.submitRetro('p-ce', body, lead);
      expect(again.filed).toEqual([]);
      expect(again.decisionId).toBeNull();
      expect(asks).toHaveLength(1);

      // Approve → the tickets become ready.
      const decision = (status: OwnerDecision['status'], key: string): OwnerDecision =>
        ({ id: res.decisionId, status, chosenKey: key, options: [{ key: 'a', label: 'Approve' }, { key: 'b', label: 'Skip' }] }) as unknown as OwnerDecision;
      await svc.onRetroDecision(decision('resolved', 'a'));
      expect(moved.map(([, to]) => to)).toEqual(['ready', 'ready', 'ready']);
      const after = (await (wf['tickets'] as ProjectTicketService).list(crewly.path)).tickets.filter((t) => res.filed.some((f) => f.id === t.id));
      expect(after.every((t) => t.status === 'ready' && !t.labels.includes('retro-pending'))).toBe(true);
      await svc.onRetroDecision(decision('resolved', 'a')); // settled once
      expect(moved).toHaveLength(3);
      await expect(svc.submitRetro('p-ce', { ...body, day: '2026-10-05' }, lead)).rejects.toMatchObject({ status: 400 });
    });

    it('cancels the tickets when the owner card cannot be asked', async () => {
      await enable();
      askFails = true;
      const res = await svc.submitRetro(
        'p-ce',
        { day: '2026-09-30', summary: 'One harness problem found today.', problems: [{ class: 'harness_gap', title: 'Wake missed for a stopped lead' }] },
        orc,
      );
      expect(res.decisionId).toBeNull();
      expect(res.unasked).toEqual([res.filed[0].id]);
      expect(moved.map(([, to]) => to)).toEqual(['cancelled']);
    });

    it('a skipped or defaulted retro card cancels its tickets', async () => {
      await enable();
      const res = await svc.submitRetro(
        'p-ce',
        { day: '2026-09-30', summary: 'One harness problem found today.', problems: [{ class: 'harness_gap', title: 'Wake missed for a stopped lead' }] },
        orc,
      );
      await svc.onRetroDecision({ id: res.decisionId, status: 'defaulted', chosenKey: 'b', options: [{ key: 'a', label: 'Approve' }, { key: 'b', label: 'Skip' }] } as unknown as OwnerDecision);
      expect(moved.map(([, to]) => to)).toEqual(['cancelled']);
    });

    it('Skip never cancels a gap ticket someone already started', async () => {
      await enable();
      const two = await svc.submitRetro(
        'p-ce',
        { day: '2026-09-30', summary: 'Two harness problems found today.', problems: [{ class: 'harness_gap', title: 'Wake missed for a stopped lead' }, { class: 'harness_gap', title: 'Digest repeats old tickets' }] },
        orc,
      );
      const ts = wf['tickets'] as ProjectTicketService;
      await ts.transition(crewly.path, two.filed[0].id, 'in_progress', 'someone');
      await svc.onRetroDecision({ id: two.decisionId, status: 'skipped', options: [{ key: 'a', label: 'Approve' }, { key: 'b', label: 'Skip' }] } as unknown as OwnerDecision);
      expect(moved.map(([id, to]) => [id, to])).toEqual([
        [two.filed[0].id, 'left'],
        [two.filed[1].id, 'cancelled'],
      ]);
      expect((await ts.get(crewly.path, two.filed[0].id))?.status).toBe('in_progress');
      // The lead of the project that runs it is told (a notify WorkItem).
      const notices = [...pool.items.values()].filter((w) => w.type === 'notify');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ target: 'crewly-lead', metadata: { ticketId: two.filed[0].id } });
    });

    it('trace readers: owner and orc without a lookup, project members yes, outsiders and unknown projects no', async () => {
      expect(await svc.canReadProjectTraces('p-gone', owner)).toBe(true);
      expect(await svc.canReadProjectTraces('p-gone', orc)).toBe(true);
      expect(await svc.canReadProjectTraces('p-ce', dev)).toBe(true);
      expect(await svc.canReadProjectTraces('p-ce', lead)).toBe(true);
      expect(await svc.canReadProjectTraces('p-ce', { session: 'stranger' })).toBe(false);
      expect(await svc.canReadProjectTraces('p-gone', dev)).toBe(false);
    });

    it('triage never lists a retro-pending ticket, and ask-owner --clear does not lift the hold', async () => {
      await enable();
      const held = await wf.create('p-ce', { title: 'Held gap', labels: ['harness-gap', 'retro-pending'] }, owner);
      const open = await wf.create('p-ce', { title: 'Normal' }, owner);
      await svc.tick();
      expect(pool.triage()[0].metadata?.ticketIds).toEqual([open.id]);
      await wf.askOwner('p-ce', held.id, owner, { clear: true });
      expect((await wf.get('p-ce', held.id)).labels).toContain('retro-pending');
    });

    it('backs off the retro scheduling while its reads keep failing', async () => {
      await enable();
      experimentRunning = true;
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      const realList = store.listTagged.bind(store);
      let calls = 0;
      store.listTagged = ((f: Parameters<typeof realList>[0]) => {
        calls += 1;
        throw new Error('index unreadable');
      }) as typeof store.listTagged;
      clock = new Date(2026, 9, 1, 9, 5);
      await svc.tick();
      const afterFirst = calls;
      advance(10 * MIN);
      await svc.tick(); // within the backoff: no retro read
      advance(10 * MIN);
      await svc.tick();
      expect(calls).toBe(afterFirst);
      store.listTagged = realList;
      advance(15 * MIN);
      await svc.tick();
      expect([...pool.items.values()].filter((w) => w.type === 'autopilot_retro')).toHaveLength(1);
    });

    it('a day with only skips starts no run trace and gets no retro; each skip reason is traced once a day', async () => {
      await enable();
      experimentRunning = true;
      for (const m of teams[0].members) m.workingStatus = 'in_progress'; // nobody idle → skip
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      expect(store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })).toHaveLength(0);
      // A real day: a triage starts the run, then skips alternate between reasons.
      for (const m of teams[0].members) m.workingStatus = 'idle';
      advance(HOUR);
      await svc.tick();
      const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
      pool.triage()[0].status = 'done';
      await wf.create('p-ce', { title: 'B' }, owner);
      for (const step of [5, 5]) {
        advance(step * MIN);
        await svc.tick(); // too_soon
        for (const m of teams[0].members) m.workingStatus = 'in_progress';
        advance(step * MIN);
        await svc.tick(); // nobody_idle
        for (const m of teams[0].members) m.workingStatus = 'idle';
      }
      const reasons = (await evts(run)).filter((e) => e.data?.action === 'skip').map((e) => e.data?.reason);
      expect(reasons.sort()).toEqual(['nobody_idle', 'too_soon']);
      // Next morning: yesterday had a triage → retro; a skip-only day would not.
      clock = new Date(2026, 9, 1, 9, 30);
      await svc.tick();
      expect([...pool.items.values()].filter((w) => w.type === 'autopilot_retro')).toHaveLength(1);
      // Scheduling is recorded in the reviewed day's run.
      expect(await actions(run)).toContain('retro_scheduled');
    });

    describe('goal replan when nothing is left to triage (specs/2026-10-04-autopilot-goal-replan.md)', () => {
      const GOAL = '(2026-10-03, set by owner) By 11/16-11/29: 1,000 /feed visitors a week, at least 25% returning within a week.';
      let goal: { text: string; sources: Array<'goals_log' | 'okr'> } | null;
      let goalReads: number;

      /** Give the running service a goal reader and an experiments reader. */
      function withGoal(target: TicketAutopilotService): TicketAutopilotService {
        const deps = (target as unknown as { deps: Record<string, unknown> }).deps;
        Object.assign(deps, {
          goalOf: async () => {
            goalReads += 1;
            return goal;
          },
          openExperiments: async () => [{ id: 'EXP-7', title: 'Goal-only feed', hypothesis: 'A goal alone keeps the feed growing', status: 'running' }],
        });
        return target;
      }
      const replans = () => [...pool.items.values()].filter((w) => w.type === 'goal_replan');
      const closeTicket = (title: string, status: 'done' | 'cancelled') =>
        (wf['tickets'] as ProjectTicketService).create(project.path, project.name, { title, status }, 'owner');

      beforeEach(() => {
        goal = { text: GOAL, sources: ['goals_log'] };
        goalReads = 0;
        withGoal(svc);
      });

      it('a project with no goal behaves exactly as before: nothing_to_triage, same trace, no replan', async () => {
        goal = null;
        await enable();
        await wf.create('p-ce', { title: 'A' }, owner);
        await svc.tick();
        pool.triage()[0].status = 'done';
        advance(5 * MIN);
        const [ev] = await svc.tick();
        expect(ev).toEqual({ projectId: 'p-ce', decision: { action: 'skip', reason: 'nothing_to_triage' } });
        expect(await svc.onMemberIdle('ce-dev')).toEqual([{ projectId: 'p-ce', decision: { action: 'skip', reason: 'nothing_to_triage' } }]);
        expect(replans()).toHaveLength(0);
        const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
        expect(await actions(run)).toEqual(['triage', 'triage_ticket', 'skip']);
        expect((await svc.getStatus('p-ce', owner)).replansToday).toBe(0);
      });

      it('wakes the driver with ONE goal_replan: the goal, closed tickets, open experiment and the ask', async () => {
        await enable();
        const shipped = await closeTicket('Ship the feed publicly', 'done');
        const dropped = await closeTicket('Old idea', 'cancelled');
        const [ev] = await svc.onMemberIdle('ce-dev');
        expect(ev.decision).toEqual({ action: 'skip', reason: 'nothing_to_triage' });
        expect(ev.replan).toEqual({ action: 'replan' });
        const [wi] = replans();
        expect(ev.workItem?.id).toBe(wi.id);
        expect(wi).toMatchObject({
          type: 'goal_replan',
          owner: 'team_lead',
          target: 'ce-owen',
          status: 'queued',
          targetSource: 'assigned',
          title: 'Plan next tickets toward the goal: CE',
          metadata: {
            kind: 'goal_replan',
            projectId: 'p-ce',
            requiresVerification: false,
            trigger: 'member_idle',
            goalSources: ['goals_log'],
            experimentIds: ['EXP-7'],
          },
        });
        expect((wi.metadata?.closedTicketIds as string[]).sort()).toEqual([shipped.id, dropped.id].sort());
        expect(wi.description).toContain('Open the next tickets toward this goal, or say why there are none.');
        expect(wi.briefMarkdown).toContain('1,000 /feed visitors a week');
        expect(wi.briefMarkdown).toContain(`${shipped.id} · done`);
        expect(wi.briefMarkdown).toContain('EXP-7 · running · Goal-only feed');
        expect(wi.briefMarkdown).toContain('Open the next tickets toward this goal, or say why there are none.');
        // The boundary: the autopilot opened nothing and started nothing.
        expect(pool.triage()).toHaveLength(0);
        const { tickets } = await (wf['tickets'] as ProjectTicketService).list(project.path);
        expect(tickets.map((t) => t.status).sort()).toEqual(['cancelled', 'done']);

        const status = await svc.getStatus('p-ce', owner);
        expect(status).toMatchObject({ replanInFlight: true, replansToday: 1, lastReplanAt: clock.toISOString() });
        // Normal (the default speed): up to 4 a day.
        expect(status.settings).toMatchObject({ speedMode: 'normal', replansPerDay: 4 });
      });

      it('Chill: at most once a day — a second idle event the same day does nothing, the next day replans again', async () => {
        await enable({ speedMode: 'chill' });
        await svc.onMemberIdle('ce-dev');
        expect(replans()).toHaveLength(1);
        expect(goalReads).toBe(1);
        // Still live → replan_in_flight (triage holds too).
        advance(30 * MIN);
        expect((await svc.onMemberIdle('ce-dev'))[0]).toEqual({ projectId: 'p-ce', decision: { action: 'skip', reason: 'replan_in_flight' } });
        // Done (the driver opened a ticket), but already replanned today.
        await closeTicket('Feed card 1', 'done');
        replans()[0].status = 'done';
        advance(2 * HOUR);
        const [again] = await svc.onMemberIdle('ce-dev');
        expect(again.replan).toEqual({ action: 'skip', reason: 'replanned_today' });
        expect(again.workItem).toBeUndefined();
        expect((await svc.tick())[0].replan).toEqual({ action: 'skip', reason: 'replanned_today' });
        expect(replans()).toHaveLength(1);
        // The limit survives a restart.
        const restarted = withGoal(build());
        expect((await restarted.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replanned_today' });
        // Cheap gates first: the replan skips above never read the goal (the
        // one other read is the tick's first self-review).
        expect(goalReads).toBe(2);
        // Next day.
        clock = new Date(2026, 9, 1, 10, 0);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        expect(replans()).toHaveLength(2);
      });

      it('the daily limit is configurable (0 = off, 2 = twice) and wins over the speed\'s cap', async () => {
        await enable({ replansPerDay: 0, speedMode: 'chill' });
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replan_off' });
        await enable({ replansPerDay: 2 });
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        await closeTicket('Opened by the replan', 'done');
        replans()[0].status = 'done';
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        await closeTicket('Opened by the second replan', 'done');
        replans()[1].status = 'done';
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replanned_today' });
      });

      it('tickets to triage come first; a live replan holds triage; a live triage holds the replan', async () => {
        await enable();
        await wf.create('p-ce', { title: 'A' }, owner);
        const [first] = await svc.tick();
        expect(first.decision).toEqual({ action: 'triage' });
        expect(first.replan).toBeUndefined();
        // The replan never read the goal (tickets to triage); the one read is the tick's first self-review.
        expect(goalReads).toBe(1);
        // Triage live (its ticket stays listed): the replan waits.
        advance(HOUR);
        expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'triage_in_flight' });
        expect(replans()).toHaveLength(0);
        // Triage done, ticket cancelled: replan; then a new backlog ticket waits for it.
        pool.triage()[0].status = 'done';
        const { tickets } = await (wf['tickets'] as ProjectTicketService).list(project.path);
        await wf.update('p-ce', tickets[0].id, { status: 'cancelled' }, owner, 'not needed');
        advance(HOUR);
        expect((await svc.tick())[0].replan).toEqual({ action: 'replan' });
        replans()[0].status = 'running';
        await wf.create('p-ce', { title: 'Next feed card', metric: 'weekly /feed visitors → +150' }, lead);
        advance(30 * MIN);
        expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'replan_in_flight' });
        // After an hour the running replan yields to the tickets waiting for triage.
        advance(30 * MIN);
        const [yielded] = await svc.tick();
        expect(yielded.decision).toEqual({ action: 'triage' });
        expect(replans()[0].status).toBe('running');
      });

      it('expires a replan past its TTL in any live state, so it never holds triage forever', async () => {
        await enable();
        await svc.onMemberIdle('ce-dev');
        const r1 = replans()[0];
        r1.status = 'running';
        advance(C.DEFAULT_REPLAN_TTL_HOURS * HOUR - MIN);
        expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'replan_in_flight' });
        expect((await svc.getStatus('p-ce', owner)).replanInFlight).toBe(true);
        advance(MIN);
        expect((await svc.getStatus('p-ce', owner)).replanInFlight).toBe(false);
        expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'nothing_to_triage' });
        expect(pool.items.get(r1.id)?.status).toBe('cancelled');

        // Configurable; a replan the driver finished (done_by_worker) cannot be cancelled, but stops counting as live.
        await enable({ replanTtlHours: 2 });
        clock = new Date(2026, 9, 1, 10, 0);
        await closeTicket('Lifts the backoff', 'done');
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        const r2 = replans().find((w) => w.id !== r1.id)!;
        r2.status = 'done_by_worker';
        advance(90 * MIN);
        expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'replan_in_flight' });
        advance(30 * MIN);
        expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'nothing_to_triage' });
        expect(pool.items.get(r2.id)?.status).toBe('done_by_worker');
      });

      it('Chill: after a replan that opened no tickets, waits a week, without reading the goal', async () => {
        await enable({ speedMode: 'chill' });
        const idleOn = async (m: number, d: number) => {
          clock = new Date(2026, m, d, 10, 0);
          const [ev] = await svc.onMemberIdle('ce-dev');
          for (const w of replans()) if (w.status === 'queued') w.status = 'done'; // the driver: "there are none"
          return ev.replan;
        };
        expect(await idleOn(8, 30)).toEqual({ action: 'replan' });
        for (const d of [1, 3, 6]) expect(await idleOn(9, d)).toEqual({ action: 'skip', reason: 'backed_off' });
        expect(goalReads).toBe(1);
        expect((await svc.getStatus('p-ce', owner)).replanBackoffUntil).toBe('2026-10-07');
        expect(await idleOn(9, 7)).toEqual({ action: 'replan' });
        expect(await idleOn(9, 8)).toEqual({ action: 'skip', reason: 'backed_off' });
      });

      it('Normal: after an empty replan, retries the next day (not 2 days later as before)', async () => {
        await enable();
        await svc.onMemberIdle('ce-dev');
        replans()[0].status = 'done';
        advance(4 * HOUR);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
        expect((await svc.getStatus('p-ce', owner)).replanBackoffUntilAt).toBe(new Date(2026, 9, 1, 0, 0).toISOString());
        clock = new Date(2026, 9, 1, 0, 30);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
      });

      it('Rush: after an empty replan, retries in 1 h; replans at least 1 h apart, at most 12 a day', async () => {
        await enable({ speedMode: 'rush' });
        clock = new Date(2026, 8, 30, 0, 5);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        replans()[0].status = 'done'; // opened nothing
        advance(30 * MIN);
        // Idle and empty: the 1 h gap no longer applies, but the empty replan's retry (1 h) still does.
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
        advance(30 * MIN);
        // The empty replan was assessed at 00:35: its retry comes at 01:35.
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
        advance(35 * MIN);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        // Productive replans from here: every hour until the cap of 12.
        let n = replans().length;
        for (let i = 0; i < 20; i += 1) {
          for (const w of replans()) if (w.status === 'queued') w.status = 'done';
          await closeTicket(`Opened by replan ${i}`, 'done');
          advance(HOUR);
          const [ev] = await svc.onMemberIdle('ce-dev');
          if (ev.replan?.action === 'replan') n += 1;
          if (clock.getDate() !== 30) break;
        }
        expect(n).toBe(12);
        expect((await svc.getStatus('p-ce', owner)).replansToday).toBe(12);
      });

      describe('idle and empty replans at once (specs/2026-10-04-autopilot-speed-modes.md §1)', () => {
        const createTicket = (extra: Record<string, unknown>) =>
          (wf['tickets'] as ProjectTicketService).create(project.path, project.name, { title: 'T', ...extra } as never, 'owner');

        it('Normal: the previous replan\'s work is done and everyone is idle → replans before the 3 h gap, within the cap', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          await closeTicket('Opened by the replan', 'done');
          replans()[0].status = 'done';
          advance(HOUR);
          const [ev] = await svc.onMemberIdle('ce-dev');
          expect(ev.replan).toEqual({ action: 'replan' });
          expect(replans()).toHaveLength(2);
        });

        it('a small debounce after the last replan keeps it from looping, and the status says when it may run', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          await closeTicket('Opened by the replan', 'done');
          replans()[0].status = 'done';
          advance(5 * MIN);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replan_too_soon' });
          await svc.tick();
          const st = await svc.getStatus('p-ce', owner);
          expect(st.stopReason).toBe('waiting_for_replan');
          expect(st.stopUntil).toBe(new Date(clock.getTime() + 5 * MIN).toISOString()); // last replan + 10 min
          expect(st.stopReasonText).toContain('waiting for the next goal replan');
          advance(5 * MIN);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        });

        it('work still in flight (a ready ticket) → the mode gap is respected, with a stop reason naming the time', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          await createTicket({ status: 'ready' });
          replans()[0].status = 'done';
          advance(HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replan_too_soon' });
          advance(2 * HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        });

        it('parked / deferred tickets do not count as work: a parked-only backlog is empty', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          await closeTicket('Opened by the replan', 'done');
          await createTicket({ title: 'Later', labels: ['parked'] });
          await createTicket({ title: 'Much later', labels: ['deferred'], status: 'ready' });
          replans()[0].status = 'done';
          advance(HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        });

        it('a member who is busy keeps the gap (not everyone idle)', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          await closeTicket('Opened by the replan', 'done');
          replans()[0].status = 'done';
          teams[0].members[0].workingStatus = 'in_progress';
          advance(HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replan_too_soon' });
          teams[0].members[0].workingStatus = 'idle';
        });

        it('an empty replan still waits its retry, even when idle and empty (no_ideas)', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          replans()[0].status = 'done'; // opened nothing
          advance(HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
          await svc.tick();
          expect((await svc.getStatus('p-ce', owner)).stopReason).toBe('no_ideas');
        });

        it('the daily cap still applies and shows as daily_replan_cap (in status and the digest)', async () => {
          await enable({ replansPerDay: 1 });
          await svc.onMemberIdle('ce-dev');
          await closeTicket('Opened by the replan', 'done');
          replans()[0].status = 'done';
          advance(HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'replanned_today' });
          await svc.tick();
          const st = await svc.getStatus('p-ce', owner);
          expect(st.stopReason).toBe('daily_replan_cap');
          expect(st.stopReasonText).toContain("today's goal replan limit is reached");
          expect(st.stopUntil).toBe(new Date(2026, 9, 1, 0, 0).toISOString()); // next local midnight
        });
      });

      it('a new ticket or a goal / OKR change lifts the backoff', async () => {
        let changedAt: number | null = null;
        const deps = (svc as unknown as { deps: Record<string, unknown> }).deps;
        deps.goalChangedAt = async () => changedAt;
        await enable({ speedMode: 'chill' });
        await svc.onMemberIdle('ce-dev');
        replans()[0].status = 'done';
        clock = new Date(2026, 9, 1, 10, 0);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
        // A ticket created (not one to triage) → lifted.
        advance(HOUR);
        await closeTicket('Owner shipped something', 'done');
        advance(MIN);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
        // That replan opened nothing → backed off again; a goal change lifts it.
        replans()[1].status = 'done';
        clock = new Date(2026, 9, 2, 10, 0);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
        changedAt = clock.getTime() + 1;
        advance(HOUR);
        expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
      });

      it('respects the brakes: nobody idle, the in-progress cap and the daily budget', async () => {
        await enable({ dailyBudgetTokens: 1000 });
        for (const m of teams[0].members) m.workingStatus = 'in_progress';
        // Nobody idle: triage still says nothing_to_triage; the replan says why it waits.
        expect((await svc.tick())[0].replan).toEqual({ action: 'skip', reason: 'nobody_idle' });
        // The lead is idle, but at the in-progress cap (the dev is busy).
        teams[0].members[0].workingStatus = 'idle';
        const held = await wf.create('p-ce', { title: 'Held', status: 'ready' }, owner);
        await wf.assign('p-ce', held.id, 'ce-owen', owner);
        await settle();
        expect((await svc.tick())[0].replan).toEqual({ action: 'skip', reason: 'at_capacity' });
        // Over the budget: triage pauses first, no replan read at all.
        await wf.update('p-ce', held.id, { status: 'cancelled' }, owner, 'x');
        spent = 5000;
        goalReads = 0;
        expect((await svc.tick())[0]).toEqual({ projectId: 'p-ce', decision: { action: 'skip', reason: 'budget_reached' } });
        expect(goalReads).toBe(0);
        expect(replans()).toHaveLength(0);
      });

      it('records the replan in the run trace and the daily stats; it is not an owner touch', async () => {
        await enable();
        await svc.onMemberIdle('ce-dev');
        await settle();
        const [wi] = replans();
        const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
        const steps = (await evts(run)).filter((e) => e.type === 'autopilot.action');
        expect(steps.map((e) => e.data?.action)).toEqual(['replan']);
        expect(steps[0]).toMatchObject({ outcome: 'queued', refs: { workItemId: wi.id, session: 'ce-owen' }, actor: { kind: 'system' } });
        expect(steps[0].data).toMatchObject({ trigger: 'member_idle', goalSources: 'goals_log', experiments: 1, replansToday: 1 });
        // The driver's replan turn runs in its own tagged trace.
        expect(wi.traceId).toBeTruthy();
        expect(wi.traceId).not.toBe(run);
        expect(store.getEntry(wi.traceId as string)).toMatchObject({ root: { kind: 'triage' }, tags: { autopilot: { projectId: 'p-ce', day: '2026-09-30' } } });

        const stats = await svc.getStats('p-ce', owner, { days: 2 });
        const today = stats.days[stats.days.length - 1];
        expect(today.replans).toBe(1);
        expect(stats.total.replans).toBe(1);
        expect(today.ownerTouches.total).toBe(0);
      });
      describe('speed modes, metric-linked replans, self-review and stop reasons (specs/2026-10-04-autopilot-speed-modes.md)', () => {
        const selfReviews = () => [...pool.items.values()].filter((w) => w.type === 'autopilot_self_review');

        it('a ticket the driver opens during a live replan must name a goal metric; others are unaffected', async () => {
          await enable();
          await svc.onMemberIdle('ce-dev');
          const [r] = replans();
          r.status = 'running';
          // The driver (lead) without a metric: refused with a message it can act on.
          await expect(wf.create('p-ce', { title: 'Feed card 9' }, lead)).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining('must name the goal metric it moves and the expected effect'),
          });
          // With --metric: created, the metric is the description's first line.
          const ok = await wf.create('p-ce', { title: 'Feed card 9', description: 'Why.', metric: 'weekly /feed visitors → +150' }, lead);
          expect(ok.description).toBe('Metric: weekly /feed visitors → +150\n\nWhy.');
          // A "Metric:" line written by hand counts too.
          await wf.create('p-ce', { title: 'Feed card 10', description: 'Metric: returning visitors → +5%' }, lead);
          // The owner, the orchestrator and other members are never checked.
          await wf.create('p-ce', { title: 'Owner idea' }, owner);
          await wf.create('p-ce', { title: 'Orc idea' }, orc);
          await wf.create('p-ce', { title: 'Dev idea' }, dev);
          // The refusal is traced.
          const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
          expect(await actions(run)).toContain('replan_ticket_rejected');
          // Once the replan is over, the lead creates freely again.
          r.status = 'done';
          await wf.create('p-ce', { title: 'After the replan' }, lead);
        });

        it('the replan brief asks for --metric and quotes the last self-review\'s next bet', async () => {
          await enable();
          await svc.submitSelfReview('p-ce', { gap: '620 of 1,000 weekly visitors', moved: 'feed cards', nextBet: 'two cards a day on the top queries' }, lead);
          await svc.onMemberIdle('ce-dev');
          const brief = replans()[0].briefMarkdown ?? '';
          expect(brief).toContain('--metric "<goal metric> → <expected effect>"');
          expect(brief).toContain('Next bet: two cards a day on the top queries');
        });

        it('asks for a self-review at the mode\'s cadence; skips it when nothing changed and nobody is idle', async () => {
          await enable({ speedMode: 'rush' });
          await svc.tick();
          expect(selfReviews()).toHaveLength(1);
          const [wi] = selfReviews();
          expect(wi).toMatchObject({ target: 'ce-owen', owner: 'team_lead', metadata: { kind: 'autopilot_self_review', projectId: 'p-ce', requiresVerification: false, speedMode: 'rush' } });
          expect(wi.briefMarkdown).toContain('self-review hourly');
          expect(wi.briefMarkdown).toContain('execute.sh self-review --project p-ce');
          // Within the hour: nothing more.
          advance(30 * MIN);
          await svc.tick();
          expect(selfReviews()).toHaveLength(1);
          // An hour later, nothing changed and nobody idle: skipped.
          wi.status = 'done';
          for (const m of teams[0].members) m.workingStatus = 'in_progress';
          advance(HOUR);
          await svc.tick();
          expect(selfReviews()).toHaveLength(1);
          // Someone idle again: asked.
          teams[0].members[1].workingStatus = 'idle';
          await svc.tick();
          expect(selfReviews()).toHaveLength(2);
          // Status shows when the next one is due.
          expect((await svc.getStatus('p-ce', owner)).nextSelfReviewAt).toBe(new Date(clock.getTime() + HOUR).toISOString());
        });

        it('Normal reviews daily, Chill weekly; a ticket change counts as "changed"', async () => {
          await enable({ speedMode: 'chill' });
          for (const m of teams[0].members) m.workingStatus = 'in_progress';
          await svc.tick();
          expect(selfReviews()).toHaveLength(1);
          selfReviews()[0].status = 'done';
          await closeTicket('Shipped', 'done');
          advance(6 * 24 * HOUR);
          await svc.tick();
          expect(selfReviews()).toHaveLength(1);
          advance(24 * HOUR);
          await svc.tick();
          expect(selfReviews()).toHaveLength(2);
          await enable({ speedMode: 'normal' });
          selfReviews()[1].status = 'done';
          await closeTicket('Shipped 2', 'done');
          advance(23 * HOUR);
          await svc.tick();
          expect(selfReviews()).toHaveLength(2);
          advance(HOUR);
          await svc.tick();
          expect(selfReviews()).toHaveLength(3);
        });

        it('never asks a paused team or over the budget; no goal, no self-review', async () => {
          await enable({ dailyBudgetTokens: 1000 });
          spent = 5000;
          await svc.tick();
          expect(selfReviews()).toHaveLength(0);
          spent = 0;
          teams[0].paused = { pausedAt: '2026-09-30T00:00:00.000Z', by: 'owner' };
          notePausedTeam(teams[0]);
          await svc.tick();
          expect(selfReviews()).toHaveLength(0);
          delete teams[0].paused;
          resetTeamPauseRegistryForTesting();
          goal = null;
          await svc.tick();
          expect(selfReviews()).toHaveLength(0);
        });

        it('a filed self-review is in the status, the digest and the trace', async () => {
          await enable();
          await expect(svc.submitSelfReview('p-ce', { gap: '' }, lead)).rejects.toMatchObject({ status: 400 });
          await expect(svc.submitSelfReview('p-ce', { gap: 'x', nextBet: 'y' }, dev)).rejects.toMatchObject({ status: 403 });
          const rec = await svc.submitSelfReview('p-ce', { gap: '620 of 1,000', nextBet: 'two cards a day' }, lead);
          expect(rec).toMatchObject({ by: 'ce-owen', gap: '620 of 1,000', moved: '', nextBet: 'two cards a day' });
          expect((await svc.getStatus('p-ce', owner)).lastSelfReview).toEqual(rec);
          await wf.create('p-ce', { title: 'Something changed' }, owner);
          clock = at(21, 30);
          await svc.tick();
          const digest = notices.find((n) => n.title === 'Tickets today');
          expect(digest?.message).toContain('Self-review: gap 620 of 1,000; next bet two cards a day');
          const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
          expect(await actions(run)).toContain('self_review_filed');
        });

        it('classifies and traces why it stopped, shows it in the status and the digest, and traces the resume', async () => {
          await enable();
          // A ticket waits on the owner and nothing else is open.
          const t = await wf.create('p-ce', { title: 'Copy for the landing page' }, owner);
          await wf.update('p-ce', t.id, { labels: ['needs-owner'] }, owner);
          // Nobody idle: no replan to mask it.
          for (const m of teams[0].members) m.workingStatus = 'in_progress';
          await svc.tick();
          let st = await svc.getStatus('p-ce', owner);
          expect(st).toMatchObject({ stopReason: 'waiting_on_owner', stopReasonText: 'waiting on you' });
          clock = at(21, 30);
          await svc.tick();
          expect(notices.find((n) => n.title === 'Tickets today')?.message).toContain('Stopped: waiting on you');
          // Budget reached outranks it.
          spent = 50_000_000;
          await svc.tick();
          expect((await svc.getStatus('p-ce', owner)).stopReason).toBe('budget_reached');
          // Work moves again: resumed.
          spent = 0;
          await wf.update('p-ce', t.id, { status: 'ready' }, owner);
          await svc.tick();
          st = await svc.getStatus('p-ce', owner);
          expect(st.stopReason).toBeNull();
          const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
          const steps = (await evts(run)).filter((e) => e.type === 'autopilot.action' && (e.data?.action === 'stopped' || e.data?.action === 'resumed'));
          expect(steps.map((e) => [e.data?.action, e.data?.reason ?? null])).toEqual([
            ['stopped', 'waiting_on_owner'],
            ['stopped', 'budget_reached'],
            ['resumed', null],
          ]);
        });

        it('no_ideas after an empty replan; system_error on a failed project WorkItem; paused when every team is paused', async () => {
          await enable({ speedMode: 'chill' });
          await svc.onMemberIdle('ce-dev');
          replans()[0].status = 'done'; // "there are none"
          advance(HOUR);
          await svc.tick();
          expect((await svc.getStatus('p-ce', owner)).stopReason).toBe('no_ideas');
          await pool.addToPool({ ...replans()[0], id: 'wi-failed', status: 'failed', type: 'delegate', metadata: { projectId: 'p-ce' }, createdAt: clock.toISOString() });
          await svc.tick();
          expect((await svc.getStatus('p-ce', owner)).stopReason).toBe('system_error');
          teams[0].paused = { pausedAt: '2026-09-30T00:00:00.000Z', by: 'owner' };
          notePausedTeam(teams[0]);
          await svc.tick();
          expect((await svc.getStatus('p-ce', owner)).stopReason).toBe('paused');
          resetTeamPauseRegistryForTesting();
          delete teams[0].paused;
        });

        it('switching the mode re-times a waiting retry and is traced; the CE explicit budget stays', async () => {
          await enable({ dailyBudgetTokens: 50_000_000 });
          await svc.onMemberIdle('ce-dev');
          replans()[0].status = 'done';
          advance(3 * HOUR);
          // Normal: the empty replan waits for the next day.
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'skip', reason: 'backed_off' });
          const st = await svc.updateSettings('p-ce', { speedMode: 'rush' }, owner);
          expect(st.settings).toMatchObject({ speedMode: 'rush', dailyBudgetTokens: 50_000_000, budgetSource: 'explicit', replansPerDay: 12 });
          expect(st.speedMode).toBe('rush');
          // Rush: the retry is 1 h after the empty replan was assessed (just now), not tomorrow.
          expect(st.replanBackoffUntilAt).toBe(new Date(clock.getTime() + HOUR).toISOString());
          advance(HOUR);
          expect((await svc.onMemberIdle('ce-dev'))[0].replan).toEqual({ action: 'replan' });
          const run = store.listTagged({ autopilotProjectId: 'p-ce', rootKind: 'autopilot' })[0].traceId;
          const changed = (await evts(run)).find((e) => e.data?.action === 'mode_changed');
          expect(changed?.data).toMatchObject({ from: 'normal', to: 'rush', budgetSource: 'explicit' });
          // Only the owner / orc may switch it.
          await expect(svc.updateSettings('p-ce', { speedMode: 'chill' }, lead)).rejects.toMatchObject({ status: 403 });
        });
      });
    });
  });

  describe('team pause (specs/2026-10-04-team-pause.md)', () => {
    const PAUSE = { pausedAt: '2026-09-30T00:00:00.000Z', by: 'owner' as const };
    afterEach(() => resetTeamPauseRegistryForTesting());

    it('never wakes a paused team\'s lead as the driver; nobody when no other team works on the project', async () => {
      await enable();
      teams[0].paused = PAUSE;
      notePausedTeam(teams[0]);
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      expect(pool.triage()).toHaveLength(0);
      expect([...pool.items.values()].some((wi) => wi.target === 'ce-owen')).toBe(false);
      expect((await svc.getStatus('p-ce', owner)).driver).toBeNull();
    });

    it('falls to the lead of the next team on the project that is not paused', async () => {
      teams.push({ id: 't-two', name: 'Two', members: [member('m-two', 'two-lead', { role: 'team-leader' })], projectIds: ['p-ce'], createdAt: '', updatedAt: '' } as Team);
      await enable();
      teams[0].paused = PAUSE;
      notePausedTeam(teams[0]);
      await wf.create('p-ce', { title: 'A' }, owner);
      await svc.tick();
      expect(pool.triage().map((wi) => wi.target)).toEqual(['two-lead']);
      expect((await svc.getStatus('p-ce', owner)).driver).toMatchObject({ session: 'two-lead', teamId: 't-two' });
    });
  });

  describe('stalled work (CE, 2026-10-05: idle members, tickets in progress, nobody moving)', () => {
    let redelivered: string[];
    let claimed: string[];

    beforeEach(() => {
      svc.stop();
      redelivered = [];
      claimed = [];
      svc = build({
        redeliverWork: async (wi) => {
          redelivered.push(wi.id);
          return true;
        },
        claimReadyFor: async (session) => {
          claimed.push(session);
          return !!(await wf.claimNextForAgent(session));
        },
      });
      svc.start(0);
    });

    it('reports stalled_work (not "running"), re-delivers the brief, then gives the ticket back to ready and re-assigns it', async () => {
      await enable();
      const t = await wf.create('p-ce', { title: 'Card share image', status: 'ready' }, owner);
      const workItem = (await wf.assign('p-ce', t.id, 'ce-dev', lead)).workItem!;
      // The assignee is registered and idle; nothing moves for the normal-mode threshold.
      advance(19 * MIN);
      await svc.tick();
      expect(redelivered).toEqual([]);
      expect((await svc.getStatus('p-ce', owner)).stopReason).toBeNull();

      advance(2 * MIN);
      await svc.tick();
      expect(redelivered).toEqual([workItem.id]);
      expect((await svc.getStatus('p-ce', owner)).stopReason).toBe('stalled_work');

      // Not again before another threshold has passed.
      advance(5 * MIN);
      await svc.tick();
      expect(redelivered).toHaveLength(1);
      advance(20 * MIN);
      await svc.tick();
      expect(redelivered).toHaveLength(2);

      // Two re-deliveries did not help: back to ready, then claimed again by an idle member.
      advance(20 * MIN);
      await svc.tick();
      expect(redelivered).toHaveLength(2);
      expect(pool.items.get(workItem.id)?.status).toBe('cancelled');
      expect(claimed).toContain('ce-dev');
      const after = (await wf['tickets'].list(project.path)).tickets.find((x) => x.id === t.id)!;
      expect(after.status).toBe('in_progress');
      expect(after.workItemId).not.toBe(workItem.id);
      expect(after.log.some((l) => l.includes('back to ready and unassigned: stalled'))).toBe(true);
    });

    it('waits for an agent that is not registered yet (restart), and acts once it is', async () => {
      await enable();
      const t = await wf.create('p-ce', { title: 'Short cards', status: 'ready' }, owner);
      await wf.assign('p-ce', t.id, 'ce-dev', lead);
      const dev = teams[0].members.find((m) => m.sessionName === 'ce-dev')!;
      dev.agentStatus = 'started';
      advance(90 * MIN);
      await svc.tick();
      expect(redelivered).toEqual([]);
      dev.agentStatus = 'active';
      await svc.tick();
      expect(redelivered).toHaveLength(1);
    });

    it('leaves a busy assignee alone and resets the count once the ticket moves', async () => {
      await enable();
      const t = await wf.create('p-ce', { title: 'A', status: 'ready' }, owner);
      await wf.assign('p-ce', t.id, 'ce-dev', lead);
      const dev = teams[0].members.find((m) => m.sessionName === 'ce-dev')!;
      dev.workingStatus = 'in_progress';
      advance(60 * MIN);
      await svc.tick();
      expect(redelivered).toEqual([]);
      expect((await svc.getStatus('p-ce', owner)).stopReason).toBeNull();
      dev.workingStatus = 'idle';
      await svc.tick();
      expect(redelivered).toHaveLength(1);
      advance(MIN);
      await wf.log('p-ce', t.id, { session: 'ce-dev' }, 'progress');
      advance(21 * MIN);
      await svc.tick();
      advance(21 * MIN);
      await svc.tick();
      // Progress reset the count: two more re-deliveries before any release.
      expect(redelivered).toHaveLength(3);
      expect((await wf['tickets'].list(project.path)).tickets.find((x) => x.id === t.id)?.status).toBe('in_progress');
    });

    it('gives an idle member a ready ticket on the tick, never the lead of a multi-member team', async () => {
      await enable();
      await wf.create('p-ce', { title: 'Ready one', status: 'ready' }, owner);
      await svc.tick();
      expect(claimed).toEqual(['ce-dev']);
      expect((await wf['tickets'].list(project.path)).tickets[0].assignee).toBe('ce-dev');
    });

    it('rush mode stalls after 10 minutes', async () => {
      await enable({ speedMode: 'rush' });
      const t = await wf.create('p-ce', { title: 'A', status: 'ready' }, owner);
      await wf.assign('p-ce', t.id, 'ce-dev', lead);
      advance(11 * MIN);
      await svc.tick();
      expect(redelivered).toHaveLength(1);
    });
  });
});
