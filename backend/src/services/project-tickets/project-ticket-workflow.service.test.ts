/**
 * Tests for the project ticket workflow: permissions, claim / assign through
 * a linked WorkItem (one agent per ticket), WorkItem → ticket sync, the
 * AutoClaim pick, and rollback.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ProjectTicketService } from './project-ticket.service.js';
import { ProjectTicketWorkflowService, isTeamLead, type ProjectTicketPool } from './project-ticket-workflow.service.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

function member(id: string, sessionName: string, extra: Partial<TeamMember> = {}): TeamMember {
  return { id, name: id, sessionName, role: 'developer', systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '', ...extra } as TeamMember;
}

/** In-memory pool with just enough of the real semantics. */
class FakePool implements ProjectTicketPool {
  items = new Map<string, WorkItem>();
  cancelQueued = jest.fn(async (id: string, reason: string) => {
    const wi = this.items.get(id);
    if (wi) Object.assign(wi, { status: 'cancelled', cancelReason: reason });
  });
  releaseClaim = jest.fn(async () => undefined);
  transitionStatus = jest.fn(async (id: string, status: WorkItemStatus, _a: 'system', _m?: (wi: WorkItem) => void, reason?: string) => {
    const wi = this.items.get(id);
    if (!wi) return null;
    wi.status = status;
    if (status === 'cancelled') wi.cancelReason = reason;
    return wi;
  });
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
  set(id: string, patch: Partial<WorkItem>): void {
    Object.assign(this.items.get(id)!, patch);
  }
}

describe('ProjectTicketWorkflowService', () => {
  let root: string;
  let project: Project;
  let other: Project;
  let teams: Team[];
  let pool: FakePool;
  let tickets: ProjectTicketService;
  let wf: ProjectTicketWorkflowService;
  const owner = {};
  const lead = { session: 'app-lead' };
  const dev = { session: 'app-dev' };
  const qa = { session: 'app-qa' };
  const outsider = { session: 'mkt-writer' };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-wf-'));
    project = { id: 'p1', name: 'Crewly App', path: path.join(root, 'app'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    other = { id: 'p2', name: 'Marketing', path: path.join(root, 'mkt'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    await fs.mkdir(project.path, { recursive: true });
    await fs.mkdir(other.path, { recursive: true });
    teams = [
      { id: 't-app', name: 'App', members: [member('m-lead', 'app-lead', { role: 'team-leader' }), member('m-dev', 'app-dev')], projectIds: ['p1'], createdAt: '', updatedAt: '' },
      { id: 't-qa', name: 'QA', members: [member('m-qa', 'app-qa')], projectIds: ['p1'], createdAt: '', updatedAt: '' },
      { id: 't-mkt', name: 'Mkt', members: [member('m-w', 'mkt-writer')], projectIds: ['p2'], createdAt: '', updatedAt: '' },
    ];
    pool = new FakePool();
    tickets = new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' });
    wf = new ProjectTicketWorkflowService({
      tickets,
      pool,
      directory: { getTeams: async () => teams, getProjects: async () => [project, other] },
      logger: quiet(),
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function readyTicket(input: Record<string, unknown> = {}) {
    return wf.create('p1', { title: 'Export CSV', status: 'ready', acceptance: ['header row'], ...input }, owner);
  }

  describe('permissions', () => {
    it('recognises team leads', () => {
      expect(isTeamLead(teams[0], teams[0].members[0])).toBe(true);
      expect(isTeamLead(teams[0], teams[0].members[1])).toBe(false);
      expect(isTeamLead({ ...teams[0], leaderIds: ['m-dev'] }, teams[0].members[1])).toBe(true);
    });

    it('resolves the project by id, name or path', async () => {
      expect((await wf.resolveProject('p1')).id).toBe('p1');
      expect((await wf.resolveProject('crewly app')).id).toBe('p1');
      expect((await wf.resolveProject(project.path)).id).toBe('p1');
      await expect(wf.resolveProject('nope')).rejects.toMatchObject({ status: 404 });
    });

    it('lets members create only backlog tickets, and outsiders none', async () => {
      const t = await wf.create('p1', { title: 'idea', status: 'ready' }, dev);
      expect(t).toMatchObject({ status: 'backlog', source: 'agent:app-dev' });
      await expect(wf.create('p1', { title: 'x' }, outsider)).rejects.toMatchObject({ status: 403 });
      expect((await wf.create('p1', { title: 'y', status: 'ready' }, lead)).status).toBe('ready');
      await expect(wf.create('p1', { title: 'z', status: 'done' }, owner)).rejects.toMatchObject({ status: 400 });
      await expect(wf.create('p1', { title: 'w', team: 't-mkt' }, owner)).rejects.toMatchObject({ status: 400 });
    });

    it('lets only owner / orchestrator / lead make a ticket ready', async () => {
      const t = await wf.create('p1', { title: 'idea' }, dev);
      await expect(wf.transition('p1', t.id, 'ready', dev)).rejects.toMatchObject({ status: 403 });
      expect((await wf.transition('p1', t.id, 'ready', lead)).status).toBe('ready');
      expect((await wf.transition('p1', t.id, 'backlog', { session: 'crewly-orc' })).status).toBe('backlog');
      await expect(wf.transition('p1', t.id, 'in_progress', owner)).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('claim', () => {
    it('starts work: in_progress, assignee, a linked + claimed WorkItem', async () => {
      const t = await readyTicket();
      const started = await wf.claim('p1', t.id, dev);
      expect(started.claimed).toBe(true);
      expect(started.ticket).toMatchObject({ status: 'in_progress', assignee: 'app-dev', workItemId: started.workItem.id });
      expect(started.ticket.log.at(-1)).toContain(`claimed by app-dev — WorkItem ${started.workItem.id}`);
      const wi = pool.items.get(started.workItem.id)!;
      expect(wi).toMatchObject({ type: 'project_task', target: 'app-dev', targetSource: 'assigned', status: 'running', projectTaskId: t.id });
      expect(wi.metadata).toMatchObject({ projectTicket: { projectPath: project.path, id: t.id }, teamId: 't-app', requiresVerification: true, projectId: 'p1' });
      expect(wi.briefMarkdown).toContain('- [ ] header row');
    });

    it('never lets two agents work one ticket', async () => {
      const t = await readyTicket();
      const results = await Promise.allSettled([wf.claim('p1', t.id, dev), wf.claim('p1', t.id, qa)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(pool.items.size).toBe(1);
    });

    it('refuses a ticket that a live WorkItem already carries, even if the file says ready', async () => {
      const t = await readyTicket();
      const started = await wf.claim('p1', t.id, dev);
      // someone hand-edits the file back to ready while the work is still running
      const text = await fs.readFile(started.ticket.filePath, 'utf8');
      await fs.writeFile(started.ticket.filePath, text.replace('status: in_progress', 'status: ready'));
      await fs.utimes(started.ticket.filePath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
      await expect(wf.claim('p1', t.id, qa)).rejects.toMatchObject({ status: 409 });
    });

    it('only lets members of the project teams (and of the ticket team) claim', async () => {
      const t = await readyTicket({ team: 't-qa' });
      await expect(wf.claim('p1', t.id, outsider)).rejects.toMatchObject({ status: 403 });
      await expect(wf.claim('p1', t.id, dev)).rejects.toMatchObject({ status: 403 });
      expect((await wf.claim('p1', t.id, qa)).ticket.assignee).toBe('app-qa');
      await expect(wf.claim('p1', t.id, owner)).rejects.toMatchObject({ status: 400 });
    });

    it('refuses to claim a backlog ticket', async () => {
      const t = await wf.create('p1', { title: 'later' }, owner);
      await expect(wf.claim('p1', t.id, dev)).rejects.toMatchObject({ status: 409 });
    });

    it('rolls the WorkItem back when the ticket write fails', async () => {
      const t = await readyTicket();
      jest.spyOn(tickets, 'mutate').mockImplementationOnce(async (p, id, _actor, compute) => {
        await compute((await tickets.get(p, id))!);
        throw new Error('disk full');
      });
      await expect(wf.claim('p1', t.id, dev)).rejects.toThrow('disk full');
      expect(pool.cancelQueued).toHaveBeenCalledTimes(1);
      expect([...pool.items.values()][0].status).toBe('cancelled');
    });
  });

  describe('assign', () => {
    it('lets a lead assign a member: work starts, WorkItem queued for the dispatcher', async () => {
      const t = await wf.create('p1', { title: 'x' }, owner);
      const { ticket, workItem } = await wf.assign('p1', t.id, 'app-qa', lead);
      expect(ticket).toMatchObject({ status: 'in_progress', assignee: 'app-qa' });
      expect(workItem?.status).toBe('queued');
      expect(ticket.log.at(-1)).toMatch(/app-lead · assigned to app-qa — WorkItem/);
    });

    it('refuses members and non-team agents; records a human assignee without work', async () => {
      const t = await readyTicket();
      await expect(wf.assign('p1', t.id, 'app-qa', dev)).rejects.toMatchObject({ status: 403 });
      await expect(wf.assign('p1', t.id, 'mkt-writer', owner)).rejects.toMatchObject({ status: 403 });
      const { ticket, workItem } = await wf.assign('p1', t.id, 'Steve', owner);
      expect(workItem).toBeUndefined();
      expect(ticket).toMatchObject({ status: 'ready', assignee: 'Steve' });
      const noStart = await wf.assign('p1', t.id, 'app-dev', owner, { start: false });
      expect(noStart.ticket.assignee).toBe('app-dev');
      expect(pool.items.size).toBe(0);
    });
  });

  describe('release / cancel', () => {
    it('lets the assignee release its ticket; the queued WorkItem is cancelled', async () => {
      const t = await wf.create('p1', { title: 'x' }, owner);
      const { workItem } = await wf.assign('p1', t.id, 'app-dev', owner);
      const back = await wf.transition('p1', t.id, 'ready', dev, 'blocked on design');
      expect(back).toMatchObject({ status: 'ready', assignee: null, workItemId: null });
      expect(pool.cancelQueued).toHaveBeenCalledWith(workItem!.id, expect.stringContaining('moved to ready'));
      await expect(wf.transition('p1', t.id, 'cancelled', dev)).rejects.toMatchObject({ status: 403 });
    });

    it('cancels a running WorkItem when the owner cancels the ticket', async () => {
      const t = await readyTicket();
      const { workItem } = await wf.claim('p1', t.id, dev);
      await wf.transition('p1', t.id, 'cancelled', owner);
      expect(pool.releaseClaim).toHaveBeenCalledWith(workItem.id, expect.any(String));
      expect(pool.items.get(workItem.id)!.status).toBe('cancelled');
    });

    it('stops the work when the owner closes an in-progress ticket by hand, keeping the assignee', async () => {
      const t = await readyTicket();
      const { workItem } = await wf.claim('p1', t.id, dev);
      const done = await wf.transition('p1', t.id, 'done', owner, 'shipped it myself');
      expect(done).toMatchObject({ status: 'done', assignee: 'app-dev' });
      expect(pool.items.get(workItem.id)!.status).toBe('cancelled');
    });

    it('leaves a WorkItem that is already waiting for review to its reviewer', async () => {
      const t = await readyTicket();
      const { workItem } = await wf.claim('p1', t.id, dev);
      pool.set(workItem.id, { status: 'done_by_worker' });
      await wf.transition('p1', t.id, 'review', owner);
      expect(pool.items.get(workItem.id)!.status).toBe('done_by_worker');
    });

    it('does not let another member release someone else’s ticket', async () => {
      const t = await readyTicket();
      await wf.claim('p1', t.id, dev);
      await expect(wf.transition('p1', t.id, 'ready', qa)).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('sync from the WorkItem', () => {
    async function started(input: Record<string, unknown> = {}) {
      const t = await readyTicket(input);
      return wf.claim('p1', t.id, dev);
    }

    it('verified → done (event path)', async () => {
      const s = await started();
      pool.set(s.workItem.id, { status: 'verified' });
      await wf.onWorkItemEvent(s.workItem.id);
      const t = await wf.get('p1', s.ticket.id);
      expect(t.status).toBe('done');
      expect(t.log.at(-1)).toMatch(/crewly · WorkItem .* verified → done$/);
    });

    it('verified → review when the ticket asks for owner review', async () => {
      const s = await started({ ownerReview: true });
      pool.set(s.workItem.id, { status: 'verified' });
      expect(await wf.syncTicket(project.path, s.ticket.id)).toBe('review');
      expect((await wf.transition('p1', s.ticket.id, 'done', owner)).status).toBe('done');
    });

    it('cancelled → back to ready with a Log line', async () => {
      const s = await started();
      pool.set(s.workItem.id, { status: 'cancelled', cancelReason: 'stale' });
      expect(await wf.syncTicket(project.path, s.ticket.id)).toBe('returned');
      const t = await wf.get('p1', s.ticket.id);
      expect(t).toMatchObject({ status: 'ready', assignee: null, workItemId: null });
      expect(t.log.at(-1)).toContain('cancelled: stale — back to ready');
    });

    it('rejected with a retry successor → relinked, still in progress; retry verified → done', async () => {
      const s = await started();
      const retryId = `${s.workItem.id}:retry:1`;
      pool.set(s.workItem.id, { status: 'rejected', metadata: { ...pool.items.get(s.workItem.id)!.metadata, disposition: { kind: 'succeeded_by', at: 'now', by: 'system', reason: 'retry', successorWorkItemId: retryId } } });
      await pool.addToPool({ ...pool.items.get(s.workItem.id)!, id: retryId, status: 'queued', parentWorkItemId: s.workItem.id, metadata: { retryAttempt: 1 } });
      expect(await wf.syncTicket(project.path, s.ticket.id)).toBe('relinked');
      expect((await wf.get('p1', s.ticket.id)).workItemId).toBe(retryId);
      pool.set(retryId, { status: 'verified' });
      await wf.onWorkItemEvent(retryId); // retry item has no link: found through its parent
      expect((await wf.get('p1', s.ticket.id)).status).toBe('done');
    });

    it('rejected/failed with no decision yet → unchanged; terminal → ready; missing → ready', async () => {
      const s = await started();
      pool.set(s.workItem.id, { status: 'failed' });
      expect(await wf.syncTicket(project.path, s.ticket.id)).toBe('unchanged');
      pool.set(s.workItem.id, { error: 'crashed', metadata: { ...pool.items.get(s.workItem.id)!.metadata, disposition: { kind: 'terminal', at: 'now', by: 'system', reason: 'budget spent' } } });
      expect(await wf.syncTicket(project.path, s.ticket.id)).toBe('returned');

      const s2 = await started();
      pool.items.delete(s2.workItem.id);
      expect(await wf.syncTicket(project.path, s2.ticket.id)).toBe('returned');
      expect((await wf.get('p1', s2.ticket.id)).log.at(-1)).toContain('no longer exists');
    });

    it('never touches a ticket a human already moved', async () => {
      const s = await started();
      await wf.transition('p1', s.ticket.id, 'review', owner);
      pool.set(s.workItem.id, { status: 'cancelled' });
      expect(await wf.syncTicket(project.path, s.ticket.id)).toBe('unchanged');
    });

    it('syncAll sweeps every project', async () => {
      const a = await started();
      const b = await started();
      pool.set(a.workItem.id, { status: 'done' });
      pool.set(b.workItem.id, { status: 'cancelled' });
      expect(await wf.syncAll()).toBe(2);
    });

    it('start() subscribes to pool events and stop() unsubscribes', async () => {
      const unsubscribe = jest.fn();
      const onInProcess = jest.fn(() => unsubscribe);
      wf.start({ onInProcess }, 0);
      expect(onInProcess).toHaveBeenCalledWith(expect.arrayContaining(['task:verified', 'task:cancelled']), expect.any(Function));
      wf.stop();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });

  describe('claimNextForAgent (AutoClaim fallback)', () => {
    it('picks the highest-priority ready ticket of the agent’s teams', async () => {
      await readyTicket({ title: 'low', priority: 'P3' });
      const p0 = await readyTicket({ title: 'urgent', priority: 'P0' });
      await wf.create('p2', { title: 'marketing', status: 'ready', priority: 'P0' }, owner);
      await wf.create('p1', { title: 'backlog P0', priority: 'P0' }, owner);
      const got = await wf.claimNextForAgent('app-dev');
      expect(got?.ticket.id).toBe(p0.id);
    });

    it('skips tickets reserved for another team', async () => {
      await readyTicket({ title: 'qa only', priority: 'P0', team: 't-qa' });
      const mine = await readyTicket({ title: 'any team', priority: 'P2' });
      expect((await wf.claimNextForAgent('app-dev'))?.ticket.id).toBe(mine.id);
    });

    it('does nothing while the agent has its own work or already works a ticket', async () => {
      await readyTicket();
      await readyTicket({ title: 'second' });
      await pool.addToPool({ id: 'direct', type: 'delegate', owner: 'agent', target: 'app-dev', title: 'direct', status: 'queued', createdAt: '', retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0 });
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
      pool.items.delete('direct');
      const first = await wf.claimNextForAgent('app-dev');
      expect(first).not.toBeNull();
      pool.set(first!.workItem.id, { status: 'done_by_worker' });
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
    });

    it('does not feed tickets to a lead who has workers, but does to a solo lead', async () => {
      await readyTicket();
      expect(await wf.claimNextForAgent('app-lead')).toBeNull();
      teams.push({ id: 't-solo', name: 'Solo', members: [member('m-solo', 'solo-lead', { role: 'team-leader' })], projectIds: ['p1'], createdAt: '', updatedAt: '' });
      expect((await wf.claimNextForAgent('solo-lead'))?.ticket.assignee).toBe('solo-lead');
    });

    it('never runs for the orchestrator or an unknown session', async () => {
      await readyTicket();
      expect(await wf.claimNextForAgent('crewly-orc')).toBeNull();
      expect(await wf.claimNextForAgent('nobody')).toBeNull();
    });
  });

  describe('reads', () => {
    it('lists with filters and per session', async () => {
      await readyTicket({ labels: ['ui'] });
      await wf.create('p1', { title: 'b' }, owner);
      expect((await wf.list('p1', { status: 'ready' })).tickets).toHaveLength(1);
      expect((await wf.list('p1', { label: 'ui' })).tickets).toHaveLength(1);
      const mine = await wf.listForSession('app-dev');
      expect(mine.map((m) => m.project.id)).toEqual(['p1']);
      expect(mine[0].tickets).toHaveLength(2);
      await expect(wf.get('p1', 'X-1')).rejects.toMatchObject({ status: 404 });
    });

    it('appends log notes for members, not outsiders', async () => {
      const t = await readyTicket();
      expect((await wf.log('p1', t.id, dev, 'looking')).log.at(-1)).toContain('app-dev · looking');
      await expect(wf.log('p1', t.id, outsider, 'hi')).rejects.toMatchObject({ status: 403 });
    });

    it('updates fields and moves status in one call', async () => {
      const t = await wf.create('p1', { title: 'x' }, owner);
      const u = await wf.update('p1', t.id, { priority: 'P0', status: 'ready' }, lead, 'groomed');
      expect(u).toMatchObject({ priority: 'P0', status: 'ready' });
      await expect(wf.update('p1', t.id, { title: 'y' }, outsider)).rejects.toMatchObject({ status: 403 });
    });
  });
});
