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
import { notePausedTeam, resetTeamPauseRegistryForTesting } from '../team/team-pause.registry.js';

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
  mergeItemMetadata = jest.fn(async (id: string, patch: Record<string, unknown>) => {
    const wi = this.items.get(id);
    if (!wi) return null;
    wi.metadata = { ...(wi.metadata ?? {}), ...patch };
    return { ...wi };
  });
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
      // A team configured with role 'tech-lead' (e.g. CE's Owen) and no leaderId is still led by that member.
      const owen = { ...teams[0].members[1], role: 'tech-lead' as const };
      expect(isTeamLead({ ...teams[0], leaderId: undefined, leaderIds: [], members: [teams[0].members[0], owen] }, owen)).toBe(true);
      // The shared rule: an explicit lead wins over lead roles, and canDelegate alone does not lead.
      expect(isTeamLead({ ...teams[0], leaderIds: ['m-dev'] }, teams[0].members[0])).toBe(false);
      const delegator = { ...teams[0].members[1], canDelegate: true };
      expect(isTeamLead({ ...teams[0], members: [teams[0].members[0], delegator] }, delegator)).toBe(false);
    });

    it('uses the harness-wide rule (utils/team.utils), not a copy', async () => {
      const shared = await import('../../utils/team.utils.js');
      expect(isTeamLead).toBe(shared.isTeamLead);
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

    // 2026-10-07: a lead assigning while it handles the owner's request — the
    // pool must be told who is assigning so the work keeps the owner origin.
    it('tells the pool the assigning lead (owner origin only), so the work keeps the owner origin', async () => {
      const spy = jest.spyOn(pool, 'addToPool');
      const t = await wf.create('p1', { title: 'x' }, owner);
      await wf.assign('p1', t.id, 'app-qa', lead);
      expect(spy).toHaveBeenCalledWith(expect.anything(), { creatorSession: 'app-lead', ownerOriginOnly: true });
    });

    it('starts a stopped assignee through the member-start path, as the lead who assigned it', async () => {
      const wakes: Array<Record<string, unknown>> = [];
      teams[1].members[0] = { ...teams[1].members[0], sessionName: '', agentId: 'app-qa', agentStatus: 'inactive' };
      wf = new ProjectTicketWorkflowService({
        tickets,
        pool,
        directory: { getTeams: async () => teams, getProjects: async () => [project, other] },
        logger: quiet(),
        wakeAssignee: async (req) => {
          wakes.push({ ...req });
          return { outcome: 'started' };
        },
      });
      const t = await wf.create('p1', { title: 'Write the article' }, owner);
      const res = await wf.assign('p1', t.id, 'app-qa', lead);
      expect(res.wake).toEqual({ outcome: 'started' });
      expect(wakes).toEqual([{ teamId: 't-qa', memberId: 'm-qa', session: 'app-qa', workItemId: res.workItem!.id, callerSession: 'app-lead' }]);
      expect((await wf.get('p1', t.id)).log.at(-1)).toMatch(/app-qa was stopped — starting it/);
    });

    it('does not start a running assignee, and reports a start gate that refused a stopped one', async () => {
      const wake = jest.fn(async () => ({ outcome: 'blocked' as const, code: 'commitment_requires_owner_approval' }));
      wf = new ProjectTicketWorkflowService({
        tickets,
        pool,
        directory: { getTeams: async () => teams, getProjects: async () => [project, other] },
        logger: quiet(),
        wakeAssignee: wake,
      });
      const running = await wf.create('p1', { title: 'a' }, owner);
      expect((await wf.assign('p1', running.id, 'app-qa', lead)).wake).toBeUndefined();
      expect(wake).not.toHaveBeenCalled();

      teams[0].members[1] = { ...teams[0].members[1], agentStatus: 'suspended' };
      const stopped = await wf.create('p1', { title: 'b' }, owner);
      const res = await wf.assign('p1', stopped.id, 'app-dev', owner);
      expect(res.ticket).toMatchObject({ status: 'in_progress', assignee: 'app-dev' });
      expect(res.wake).toMatchObject({ outcome: 'blocked', code: 'commitment_requires_owner_approval' });
      expect(wake).toHaveBeenCalledWith(expect.not.objectContaining({ callerSession: expect.anything() }));
      expect((await wf.get('p1', stopped.id)).log.at(-1)).toMatch(/could not be started \(commitment_requires_owner_approval\)/);
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
      await readyTicket({ title: 'low', priority: 'P3', team: 't-app' });
      const p0 = await readyTicket({ title: 'urgent', priority: 'P0', team: 't-app' });
      await wf.create('p2', { title: 'marketing', status: 'ready', priority: 'P0', team: 't-mkt' }, owner);
      await wf.create('p1', { title: 'backlog P0', priority: 'P0' }, owner);
      const got = await wf.claimNextForAgent('app-dev');
      expect(got?.ticket.id).toBe(p0.id);
    });

    it('never offers a team-less ticket to idle pickup — not to a member of any project team (CREW-397)', async () => {
      // CREW-394 (backend fix, team: null) was claimed by a Marketing writer whose team shared the project.
      await readyTicket({ title: 'no team', priority: 'P0' });
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
      expect(await wf.claimNextForAgent('app-qa')).toBeNull();
      teams.push({ id: 't-mkt2', name: 'Mkt on app', members: [member('m-w2', 'mkt-writer2')], projectIds: ['p1'], createdAt: '', updatedAt: '' });
      expect(await wf.claimNextForAgent('mkt-writer2')).toBeNull();
      // Once a lead gives it a team, that team's member takes it — and only that team.
      const t = (await tickets.list(project.path)).tickets.find((x) => x.title === 'no team')!;
      await wf.update('p1', t.id, { team: 't-app' }, lead);
      expect(await wf.claimNextForAgent('mkt-writer2')).toBeNull();
      expect((await wf.claimNextForAgent('app-dev'))?.ticket.id).toBe(t.id);
    });

    it('skips tickets reserved for another team', async () => {
      await readyTicket({ title: 'qa only', priority: 'P0', team: 't-qa' });
      const mine = await readyTicket({ title: 'my team', priority: 'P2', team: 't-app' });
      expect((await wf.claimNextForAgent('app-dev'))?.ticket.id).toBe(mine.id);
    });

    it('does nothing while the agent has its own work or already works a ticket', async () => {
      await readyTicket({ team: 't-app' });
      await readyTicket({ title: 'second', team: 't-app' });
      await pool.addToPool({ id: 'direct', type: 'delegate', owner: 'agent', target: 'app-dev', title: 'direct', status: 'queued', createdAt: '', retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0 });
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
      pool.items.delete('direct');
      const first = await wf.claimNextForAgent('app-dev');
      expect(first).not.toBeNull();
      pool.set(first!.workItem.id, { status: 'done_by_worker' });
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
    });

    it('does not feed tickets to a lead who has workers, but does to a solo lead', async () => {
      teams.push({ id: 't-solo', name: 'Solo', members: [member('m-solo', 'solo-lead', { role: 'team-leader' })], projectIds: ['p1'], createdAt: '', updatedAt: '' });
      await readyTicket({ team: 't-app' });
      expect(await wf.claimNextForAgent('app-lead')).toBeNull();
      expect(await wf.claimNextForAgent('solo-lead')).toBeNull();
      await readyTicket({ title: 'solo', team: 't-solo' });
      expect((await wf.claimNextForAgent('solo-lead'))?.ticket.assignee).toBe('solo-lead');
    });

    it('never runs for the orchestrator or an unknown session', async () => {
      await readyTicket();
      expect(await wf.claimNextForAgent('crewly-orc')).toBeNull();
      expect(await wf.claimNextForAgent('nobody')).toBeNull();
    });
  });

  describe('ticket autopilot hooks (specs/2026-09-30-ticket-autopilot.md)', () => {
    const policy = (paused: boolean, cap: number | null) => ({
      isAutoClaimPaused: jest.fn(async () => paused),
      maxInFlightPerMember: jest.fn(async () => cap),
    });

    it('keeps the one-ticket AutoClaim lock even when the per-member cap is higher', async () => {
      wf.setAutopilotPolicy(policy(false, 3));
      await readyTicket({ team: 't-app' });
      await readyTicket({ title: 'second', team: 't-app' });
      expect(await wf.claimNextForAgent('app-dev')).not.toBeNull();
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
    });

    it('feeds nobody from a project paused on its budget', async () => {
      wf.setAutopilotPolicy(policy(true, 1));
      await readyTicket({ team: 't-app' });
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
      wf.setAutopilotPolicy(null);
      expect(await wf.claimNextForAgent('app-dev')).not.toBeNull();
    });

    it('caps what a lead may assign to one member, but not the owner', async () => {
      wf.setAutopilotPolicy(policy(false, 1));
      const a = await readyTicket();
      const b = await readyTicket({ title: 'second' });
      const c = await readyTicket({ title: 'third' });
      await wf.assign('p1', a.id, 'app-dev', lead);
      await expect(wf.assign('p1', b.id, 'app-dev', lead)).rejects.toMatchObject({ status: 409 });
      await expect(wf.assign('p1', b.id, 'app-dev', owner)).resolves.toMatchObject({ ticket: { status: 'in_progress' } });
      // Only recording an assignee starts no work, so the cap does not apply.
      await expect(wf.assign('p1', c.id, 'app-dev', lead, { start: false })).resolves.toMatchObject({ ticket: { status: 'ready', assignee: 'app-dev' } });
    });

    it('ask-owner: lead / orc / owner mark and clear needs-owner; members and outsiders may not', async () => {
      const t = await wf.create('p1', { title: 'Email partners' }, owner);
      await expect(wf.askOwner('p1', t.id, dev, { question: 'Send?' })).rejects.toMatchObject({ status: 403 });
      await expect(wf.askOwner('p1', t.id, outsider, { question: 'Send?' })).rejects.toMatchObject({ status: 403 });
      await expect(wf.askOwner('p1', t.id, lead, { question: '   ' })).rejects.toMatchObject({ status: 400 });
      await expect(wf.askOwner('p1', t.id, lead, { question: 'x'.repeat(400) })).rejects.toMatchObject({ status: 400 });
      const asked = await wf.askOwner('p1', t.id, lead, { question: 'Send the draft\nto the partners?' });
      expect(asked.labels).toEqual(['needs-owner']);
      expect(asked.log[asked.log.length - 1]).toContain('owner question: Send the draft to the partners?');
      const again = await wf.askOwner('p1', t.id, { session: 'crewly-orc' }, { question: 'Today or Monday?' });
      expect(again.labels).toEqual(['needs-owner']);
      const cleared = await wf.askOwner('p1', t.id, owner, { clear: true, note: 'Monday' });
      expect(cleared.labels).toEqual([]);
      expect(cleared.log[cleared.log.length - 1]).toContain('owner question answered — Monday');
      await wf.transition('p1', t.id, 'cancelled', owner);
      await expect(wf.askOwner('p1', t.id, lead, { question: 'Still?' })).rejects.toMatchObject({ status: 409 });
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
  describe('delegation through tickets (spec §11)', () => {
    let seq = 0;
    /** A delegate WorkItem as the delegate-task skill builds it. */
    function delegation(patch: Partial<WorkItem> = {}): WorkItem {
      seq += 1;
      return {
        id: `wi-del-${seq}`,
        type: 'delegate',
        owner: 'team_lead',
        target: 'app-dev',
        title: 'Build the list page\nGoal: …',
        description: 'New task from Team Leader …',
        briefMarkdown: 'Build the list page.\n\nGoal: users see the list.',
        status: 'queued',
        createdAt: 'now',
        retryCount: 0,
        maxRetries: 3,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        metadata: { priority: 'high', directDelivery: true },
        ...patch,
      };
    }

    it('without --ticket: creates a ticket, assigns it, and links the delegated item as is', async () => {
      const wi = delegation();
      const routed = await wf.routeDelegation({ workItem: wi, callerSession: 'app-lead', addOptions: { creatorSession: 'app-lead' } });
      expect(routed).not.toBeNull();
      expect(routed!.createdTicket).toBe(true);
      expect(routed!.ticket).toMatchObject({
        title: 'Build the list page',
        status: 'in_progress',
        assignee: 'app-dev',
        workItemId: wi.id,
        team: 't-app',
        priority: 'P1',
        source: 'agent:app-lead',
      });
      expect(routed!.ticket.description).toContain('users see the list');
      expect(routed!.ticket.log.join('\n')).toContain('created from delegation by app-lead');
      const stored = pool.items.get(wi.id)!;
      // Delegate fields untouched, only the link (+ project/team) added.
      expect(stored).toMatchObject({ type: 'delegate', owner: 'team_lead', target: 'app-dev', title: wi.title, briefMarkdown: wi.briefMarkdown, status: 'queued' });
      expect(stored.metadata).toMatchObject({
        priority: 'high',
        directDelivery: true,
        projectTicket: { projectPath: project.path, id: routed!.ticket.id },
        projectId: 'p1',
        projectPath: project.path,
        teamId: 't-app',
      });
    });

    it('passes the add options through to the pool', async () => {
      const spy = jest.spyOn(pool, 'addToPool');
      await wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead', addOptions: { creatorSession: 'app-lead' } });
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'delegate' }), { creatorSession: 'app-lead' });
    });

    it('with --ticket: assigns that backlog/ready ticket through the assign path', async () => {
      const t = await wf.create('p1', { title: 'List pages C' }, owner);
      const wi = delegation();
      const routed = await wf.routeDelegation({ workItem: wi, callerSession: 'app-lead', ticketId: t.id });
      expect(routed!.createdTicket).toBe(false);
      expect(routed!.ticket).toMatchObject({ id: t.id, status: 'in_progress', assignee: 'app-dev', workItemId: wi.id, title: 'List pages C' });
      expect(routed!.ticket.log.join('\n')).toMatch(/delegated by app-lead[\s\S]*assigned to app-dev — WorkItem wi-del-/);
      expect(pool.items.get(wi.id)!.metadata).toMatchObject({ projectTicket: { projectPath: project.path, id: t.id } });
    });

    it('with --ticket: refuses a ticket that already has a live WorkItem, and adds nothing', async () => {
      const t = await readyTicket();
      await wf.claim('p1', t.id, qa);
      const before = pool.items.size;
      await expect(wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead', ticketId: t.id })).rejects.toMatchObject({ status: 409 });
      expect(pool.items.size).toBe(before);
    });

    it('with --ticket: refuses a done ticket', async () => {
      const t = await readyTicket();
      await wf.transition('p1', t.id, 'cancelled', owner);
      await expect(wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead', ticketId: t.id })).rejects.toMatchObject({ status: 409 });
      const d = await readyTicket({ title: 'done one' });
      const s = await wf.claim('p1', d.id, dev);
      pool.set(s.workItem.id, { status: 'verified' });
      await wf.syncTicket(project.path, d.id);
      await expect(wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead', ticketId: d.id })).rejects.toMatchObject({ status: 409 });
    });

    it('with --ticket: refuses a self-target, a target with no project, an unknown ticket, and a member caller', async () => {
      const t = await readyTicket();
      await expect(wf.routeDelegation({ workItem: delegation({ target: 'app-lead' }), callerSession: 'app-lead', ticketId: t.id })).rejects.toMatchObject({ status: 400 });
      teams.push({ id: 't-free', name: 'Free', members: [member('m-free', 'free-agent')], projectIds: [], createdAt: '', updatedAt: '' });
      await expect(wf.routeDelegation({ workItem: delegation({ target: 'free-agent' }), callerSession: 'app-lead', ticketId: t.id })).rejects.toMatchObject({ status: 400 });
      await expect(wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead', ticketId: 'APP-999' })).rejects.toMatchObject({ status: 404 });
      await expect(wf.routeDelegation({ workItem: delegation({ target: 'app-qa' }), callerSession: 'app-dev', ticketId: t.id })).rejects.toMatchObject({ status: 403 });
      expect(pool.items.size).toBe(0);
    });

    it('without --ticket: leaves self-reminders, review items, system items and no-project targets alone', async () => {
      teams.push({ id: 't-free', name: 'Free', members: [member('m-free', 'free-agent')], projectIds: [], createdAt: '', updatedAt: '' });
      const cases: Array<[WorkItem, string | undefined]> = [
        [delegation({ target: 'app-lead', title: 'Push Vera' }), 'app-lead'],
        [delegation({ metadata: { verifyOf: 'wi-x' } }), 'app-lead'],
        [delegation({ owner: 'system' }), undefined],
        [delegation({ target: 'free-agent' }), 'app-lead'],
        [delegation({ type: 'review' }), 'app-lead'],
      ];
      for (const [wi, caller] of cases) expect(await wf.routeDelegation({ workItem: wi, callerSession: caller })).toBeNull();
      expect(pool.items.size).toBe(0);
      expect((await wf.list('p1')).tickets).toHaveLength(0);
    });

    it('picks the project from metadata.projectPath when the target works on several', async () => {
      teams[0].projectIds = ['p1', 'p2'];
      expect(await wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead' })).toBeNull();
      const routed = await wf.routeDelegation({ workItem: delegation({ metadata: { projectPath: other.path } }), callerSession: 'app-lead' });
      expect(routed!.project.id).toBe('p2');
    });

    it('cancels the new ticket when the WorkItem cannot be added', async () => {
      jest.spyOn(pool, 'addToPool').mockRejectedValueOnce(new Error('team budget exceeded'));
      await expect(wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead' })).rejects.toThrow('team budget exceeded');
      const [t] = (await wf.list('p1')).tickets;
      expect(t.status).toBe('cancelled');
    });

    it('falls back to a plain delegation when the ticket cannot be created', async () => {
      jest.spyOn(tickets, 'create').mockRejectedValueOnce(new Error('read-only fs'));
      expect(await wf.routeDelegation({ workItem: delegation(), callerSession: 'app-lead' })).toBeNull();
    });

    it('the existing sync closes an auto-created ticket when its WorkItem is verified (via its review item)', async () => {
      const wi = delegation({ metadata: { requiresVerification: true } });
      const routed = await wf.routeDelegation({ workItem: wi, callerSession: 'app-lead' });
      pool.set(wi.id, { status: 'done_by_worker' });
      await pool.addToPool({ ...delegation({ owner: 'agent', target: 'app-lead' }), id: 'wi-review', metadata: { verifyOf: wi.id } });
      pool.set(wi.id, { status: 'verified' });
      await wf.onWorkItemEvent('wi-review');
      const t = await wf.get('p1', routed!.ticket.id);
      expect(t.status).toBe('done');
      expect(t.log.at(-1)).toContain(`WorkItem ${wi.id} verified → done`);
    });
  });

  describe('link (spec §11)', () => {
    function live(id: string, patch: Partial<WorkItem> = {}): WorkItem {
      const wi: WorkItem = {
        id, type: 'delegate', owner: 'team_lead', target: 'app-dev', title: 'Deploy 485', status: 'running',
        createdAt: '', retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0, metadata: {}, ...patch,
      };
      pool.items.set(id, wi);
      return wi;
    }

    it('links a running item: in_progress, assignee, workItemId, metadata, Log', async () => {
      const t = await wf.create('p1', { title: 'Deploy 485' }, owner);
      live('wi-run');
      const { ticket, workItem } = await wf.link('p1', t.id, 'wi-run', lead);
      expect(ticket).toMatchObject({ status: 'in_progress', assignee: 'app-dev', workItemId: 'wi-run' });
      expect(ticket.log.at(-1)).toContain('linked to WorkItem wi-run (running, app-dev) by app-lead');
      expect(workItem.metadata).toMatchObject({ projectTicket: { projectPath: project.path, id: t.id } });
      expect(pool.items.get('wi-run')!.status).toBe('running');
      // idempotent
      expect((await wf.link('p1', t.id, 'wi-run', lead)).ticket.log).toHaveLength(ticket.log.length);
    });

    it('keeps a ticket in review', async () => {
      const t = await readyTicket();
      await wf.claim('p1', t.id, dev);
      await wf.transition('p1', t.id, 'review', owner);
      live('wi-rev', { status: 'done_by_worker' });
      expect((await wf.link('p1', t.id, 'wi-rev', owner)).ticket.status).toBe('review');
    });

    it('then syncs like any linked ticket', async () => {
      const t = await wf.create('p1', { title: 'x' }, owner);
      live('wi-s');
      await wf.link('p1', t.id, 'wi-s', { session: 'crewly-orc' });
      pool.set('wi-s', { status: 'verified' });
      await wf.onWorkItemEvent('wi-s');
      expect((await wf.get('p1', t.id)).status).toBe('done');
    });

    it('refuses: done/cancelled ticket, finished item, item on another ticket, ticket with another live item, members', async () => {
      const done = await wf.create('p1', { title: 'c' }, owner);
      await wf.transition('p1', done.id, 'cancelled', owner);
      live('wi-a');
      await expect(wf.link('p1', done.id, 'wi-a', lead)).rejects.toMatchObject({ status: 409 });

      const t = await wf.create('p1', { title: 'x' }, owner);
      live('wi-old', { status: 'verified' });
      await expect(wf.link('p1', t.id, 'wi-old', lead)).rejects.toMatchObject({ status: 409 });
      await expect(wf.link('p1', t.id, 'wi-missing', lead)).rejects.toMatchObject({ status: 404 });

      live('wi-other', { metadata: { projectTicket: { projectPath: project.path, id: 'APP-77' } } });
      await expect(wf.link('p1', t.id, 'wi-other', lead)).rejects.toMatchObject({ status: 409 });

      const busy = await readyTicket();
      await wf.claim('p1', busy.id, qa);
      await expect(wf.link('p1', busy.id, 'wi-a', lead)).rejects.toMatchObject({ status: 409 });

      await expect(wf.link('p1', t.id, 'wi-a', dev)).rejects.toMatchObject({ status: 403 });
      expect(pool.items.get('wi-a')!.metadata).toEqual({});
    });

    it('removes the link from the item again when the ticket write fails', async () => {
      const t = await wf.create('p1', { title: 'x' }, owner);
      live('wi-f');
      jest.spyOn(tickets, 'mutate').mockImplementationOnce(async (p, id, _actor, compute) => {
        await compute((await tickets.get(p, id))!);
        throw new Error('disk full');
      });
      await expect(wf.link('p1', t.id, 'wi-f', owner)).rejects.toThrow('disk full');
      expect(pool.items.get('wi-f')!.metadata?.projectTicket).toBeUndefined();
    });
  });

  describe('team pause (specs/2026-10-04-team-pause.md)', () => {
    const pause = (): void => {
      teams[0] = { ...teams[0], paused: { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' }, issueRepo: 'stevehuang0115/crewly' };
      notePausedTeam(teams[0]);
    };
    afterEach(() => resetTeamPauseRegistryForTesting());

    it('refuses an agent assigning a ticket to a paused member (409, file an issue); the owner may still assign', async () => {
      const t = await wf.create('p1', { title: 'x' }, owner);
      pause();
      await expect(wf.assign('p1', t.id, 'app-dev', { session: 'crewly-orc' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringMatching(/^App is paused by the owner\. File a GitHub issue instead: `gh issue create -R stevehuang0115\/crewly/),
      });
      // A lead of the paused team itself is refused too (the team takes no new work from agents).
      await expect(wf.assign('p1', t.id, 'app-dev', lead)).rejects.toMatchObject({ status: 409 });
      const { ticket } = await wf.assign('p1', t.id, 'app-dev', owner);
      expect(ticket.assignee).toBe('app-dev');
    });

    it('feeds no ticket to a paused agent', async () => {
      await readyTicket({ team: 't-app' });
      await readyTicket({ title: 'for qa', team: 't-qa' });
      pause();
      expect(await wf.claimNextForAgent('app-dev')).toBeNull();
      // Another team on the project still gets its own ticket.
      expect((await wf.claimNextForAgent('app-qa'))?.ticket.assignee).toBe('app-qa');
    });

    it('releaseForPausedTeam unassigns unstarted tickets and leaves started work alone', async () => {
      const ready = await readyTicket({ title: 'ready one' });
      await tickets.mutate(project.path, ready.id, 'test', () => ({ fields: { assignee: 'app-dev' } }));
      const backlog = await wf.create('p1', { title: 'backlog one' }, owner);
      await tickets.mutate(project.path, backlog.id, 'test', () => ({ fields: { assignee: 'app-dev' } }));
      const queued = await wf.create('p1', { title: 'queued one' }, owner);
      const { workItem: queuedWi } = await wf.assign('p1', queued.id, 'app-dev', owner);
      const running = await readyTicket({ title: 'running one' });
      const started = await wf.claim('p1', running.id, dev);
      const othersTicket = await readyTicket({ title: 'qa one' });
      await tickets.mutate(project.path, othersTicket.id, 'test', () => ({ fields: { assignee: 'app-qa' } }));

      const out = await wf.releaseForPausedTeam(new Set(['app-dev', 'app-lead']), 'App');
      expect(out.sort()).toEqual([`Crewly App/${backlog.id}`, `Crewly App/${queued.id}`, `Crewly App/${ready.id}`].sort());

      expect(await tickets.get(project.path, ready.id)).toMatchObject({ status: 'ready', assignee: null });
      expect(await tickets.get(project.path, backlog.id)).toMatchObject({ status: 'backlog', assignee: null });
      const q = await tickets.get(project.path, queued.id);
      expect(q).toMatchObject({ status: 'ready', assignee: null, workItemId: null });
      expect(q!.log.at(-1)).toContain('team App was paused by the owner');
      expect(pool.items.get(queuedWi!.id)!.status).toBe('cancelled');
      expect(await tickets.get(project.path, running.id)).toMatchObject({ status: 'in_progress', assignee: 'app-dev' });
      expect(pool.items.get(started.workItem.id)!.status).toBe('running');
      expect(await tickets.get(project.path, othersTicket.id)).toMatchObject({ assignee: 'app-qa' });
    });
  });
});
