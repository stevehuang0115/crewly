/**
 * Tests for the ticket autopilot service: settings permissions, waking the
 * driver (debounce, idle trigger, budget brake, stale triage), owner question
 * batching and the evening digest — all on an injected clock.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TICKET_AUTOPILOT_CONSTANTS as C } from '../../constants.js';
import { ProjectTicketService } from './project-ticket.service.js';
import { ProjectTicketWorkflowService, type ProjectTicketPool } from './project-ticket-workflow.service.js';
import { TicketAutopilotService, type OwnerNotice } from './ticket-autopilot.service.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';

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

  function build(): TicketAutopilotService {
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
      ledger: { getSessionUsageSince: (s: string) => ({ cost: s === 'ce-dev' ? spent : 0 }) },
      notifyOwner: async (n) => {
        if (!notifyOk) return false;
        notices.push(n);
        return true;
      },
      stateFile: path.join(root, 'state.json'),
      now: () => clock,
      logger: quiet(),
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
      await enable({ dailyBudgetUsd: 5 });
      await wf.create('p-ce', { title: 'A' }, owner);
      await wf.create('p-ce', { title: 'Ready one', status: 'ready' }, owner);
      spent = 5.2;
      expect((await svc.tick())[0].decision).toEqual({ action: 'skip', reason: 'budget_reached' });
      expect(pool.triage()).toHaveLength(0);
      advance(HOUR);
      await svc.tick();
      const paused = notices.filter((n) => n.title === 'Ticket autopilot paused');
      expect(paused).toHaveLength(1);
      expect(paused[0].message).toContain('$5.20 of its $5.00');

      expect(await svc.policy().isAutoClaimPaused(project)).toBe(true);
      expect(await wf.claimNextForAgent('ce-dev')).toBeNull();
      expect((await svc.getStatus('p-ce', owner)).pausedForToday).toBe(true);

      spent = 0;
      expect(await svc.policy().isAutoClaimPaused(project)).toBe(false);
      expect((await wf.claimNextForAgent('ce-dev'))?.ticket.title).toBe('Ready one');
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
    async function ask(title: string, question: string, priority = 'P2') {
      const t = await wf.create('p-ce', { title, priority }, owner);
      await wf.askOwner('p-ce', t.id, lead, { question });
      return t;
    }

    it('batches open questions into one message, at most every 2 hours', async () => {
      await enable();
      const a = await ask('Partner email', 'Send the draft to the 3 partners?');
      const b = await ask('Pricing page', 'Publish on Monday?');
      await svc.tick();
      const q1 = notices.filter((n) => n.title === 'Tickets waiting on you');
      expect(q1).toHaveLength(1);
      expect(q1[0].message).toContain(`1. ${a.id} Partner email — Send the draft to the 3 partners?`);
      expect(q1[0].message).toContain(`2. ${b.id} Pricing page — Publish on Monday?`);
      expect(q1[0].message).not.toMatch(/WorkItem/);

      advance(5 * MIN);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets waiting on you')).toHaveLength(1);

      await ask('Logo', 'Blue or green?');
      advance(30 * MIN);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets waiting on you')).toHaveLength(1);

      advance(2 * HOUR);
      await svc.tick();
      const q2 = notices.filter((n) => n.title === 'Tickets waiting on you');
      expect(q2).toHaveLength(2);
      expect(q2[1].message).toContain('3 tickets are waiting on you');
    });

    it('sends a new urgent question at once, and retries when the owner channel is down', async () => {
      await enable();
      await ask('A', 'Q1?');
      await svc.tick();
      advance(MIN);
      notifyOk = false;
      await ask('Outage', 'Roll back now?', 'P0');
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets waiting on you')).toHaveLength(1);
      notifyOk = true;
      advance(MIN);
      await svc.tick();
      const sent = notices.filter((n) => n.title === 'Tickets waiting on you');
      expect(sent).toHaveLength(2);
      expect(sent[1].urgent).toBe(true);
      expect(sent[1].message.split('\n')[2]).toContain('Roll back now?');
    });

    it('drops answered questions', async () => {
      await enable();
      const a = await ask('A', 'Q1?');
      await svc.tick();
      await wf.askOwner('p-ce', a.id, lead, { clear: true });
      advance(3 * HOUR);
      await svc.tick();
      expect(notices.filter((n) => n.title === 'Tickets waiting on you')).toHaveLength(1);
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
  });
});
