/**
 * Tests for the ticket hygiene sweep: auto-reconcile of settled tickets (with
 * the done gate), orphan flags, and the once-a-day batched lead review (no
 * loop, cooldown, orchestrator fallback, stale queued item replaced).
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TICKET_HYGIENE_CONSTANTS as C } from '../../constants.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import type { WorkItem, WorkItemStatus } from '../../types/v2/work-item.types.js';
import { ProjectTicketService } from './project-ticket.service.js';
import { TicketHygieneService, type TicketHygienePool } from './ticket-hygiene.service.js';
import type { ChainEnd } from './project-ticket-workflow.service.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW0 = Date.parse('2026-10-10T12:00:00.000Z');

const quiet = (): ComponentLogger => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

function member(id: string, sessionName: string, role = 'developer'): TeamMember {
  return { id, name: id, sessionName, role, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' } as TeamMember;
}

class FakePool implements TicketHygienePool {
  items = new Map<string, WorkItem>();
  async getAllItems(): Promise<WorkItem[]> {
    return [...this.items.values()];
  }
  addToPool = jest.fn(async (wi: WorkItem) => {
    this.items.set(wi.id, { ...wi });
  });
  cancelQueued = jest.fn(async (id: string, reason: string) => {
    const wi = this.items.get(id);
    if (wi) Object.assign(wi, { status: 'cancelled', cancelReason: reason });
  });
  put(id: string, status: WorkItemStatus, metadata?: Record<string, unknown>): WorkItem {
    const wi = { id, status, title: id, type: 'delegate', owner: 'team_lead', description: '', createdAt: new Date(NOW0).toISOString(), metadata } as unknown as WorkItem;
    this.items.set(id, wi);
    return wi;
  }
  reviewItems(): WorkItem[] {
    return [...this.items.values()].filter((w) => w.metadata?.kind === C.REVIEW_METADATA_KIND);
  }
}

describe('TicketHygieneService', () => {
  let root: string;
  let project: Project;
  let teams: Team[];
  let pool: FakePool;
  let store: ProjectTicketService;
  let clock = NOW0;
  let svc: TicketHygieneService;
  let chain: Map<string, ChainEnd>;

  const lead = 'app-lead-aaaaaaaa';
  const dev = 'app-dev-bbbbbbbb';

  /** Create a ticket whose clock reads `daysAgo` days before NOW0. */
  async function make(input: Record<string, unknown>, daysAgo = 0): Promise<string> {
    const saved = clock;
    clock = NOW0 - daysAgo * DAY;
    const t = await store.create(project.path, project.name, { title: 'A ticket', status: 'ready', ...input } as never, 'owner');
    clock = saved;
    return t.id;
  }

  async function ticketOf(id: string) {
    return (await store.get(project.path, id))!;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-hyg-'));
    project = { id: 'p1', name: 'Crewly App', path: path.join(root, 'app'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    await fs.mkdir(project.path, { recursive: true });
    teams = [{ id: 't-app', name: 'App', members: [member('m-lead', lead, 'team-leader'), member('m-dev', dev)], projectIds: ['p1'], createdAt: '', updatedAt: '' } as Team];
    pool = new FakePool();
    clock = NOW0;
    chain = new Map();
    store = new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked', now: () => new Date(clock).toISOString() });
    svc = new TicketHygieneService({
      tickets: store,
      pool,
      directory: { getTeams: async () => teams, getProjects: async () => [project] },
      followChain: async (id) => chain.get(id) ?? { kind: 'pending' },
      stateFile: path.join(root, 'state.json'),
      logger: quiet(),
      now: () => new Date(clock),
    });
  });

  afterEach(async () => {
    svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Put an in_progress ticket in place (the service API only starts work through claim / assign). */
  async function inProgress(extra: Record<string, unknown> = {}, daysAgo = 1): Promise<string> {
    const id = await make({ status: 'ready', ...extra }, daysAgo);
    await store.mutate(project.path, id, 'test', () => ({ fields: { status: 'in_progress', assignee: dev, workItemId: 'wi-1' }, log: ['started'] }));
    return id;
  }

  describe('auto-reconcile', () => {
    it('closes an in_progress ticket whose WorkItem is verified, and records why in the Log', async () => {
      const id = await inProgress();
      const wi = pool.put('wi-1', 'verified', { projectTicket: { projectPath: project.path, id } });
      chain.set('wi-1', { kind: 'success', wi });

      const r = await svc.runOnce();

      expect(r.changes).toEqual([expect.objectContaining({ ticketId: id, kind: 'closed' })]);
      const t = await ticketOf(id);
      expect(t.status).toBe('done');
      expect(t.log[t.log.length - 1]).toContain(`${C.ACTOR} · in_progress → done — ${C.REASON}: WorkItem wi-1 is verified`);
    });

    it('respects the done gate: ownerReview moves it to review, and a review waiting for the owner is left alone', async () => {
      const id = await inProgress({ ownerReview: true });
      const wi = pool.put('wi-1', 'done', { projectTicket: { projectPath: project.path, id } });
      chain.set('wi-1', { kind: 'success', wi });

      expect((await svc.runOnce()).changes[0]).toMatchObject({ kind: 'advanced' });
      expect((await ticketOf(id)).status).toBe('review');
      // Second sweep: nothing more to do, and no churn in the Log.
      const logLen = (await ticketOf(id)).log.length;
      expect((await svc.runOnce()).changes).toEqual([]);
      expect((await ticketOf(id)).log).toHaveLength(logLen);
    });

    it('closes a review ticket without ownerReview once its work is done', async () => {
      const id = await inProgress();
      await store.transition(project.path, id, 'review', 'test');
      const wi = pool.put('wi-1', 'verified');
      chain.set('wi-1', { kind: 'success', wi });
      await svc.runOnce();
      expect((await ticketOf(id)).status).toBe('done');
    });

    it('does nothing while a linked WorkItem is still live, or the chain is not settled', async () => {
      const id = await inProgress();
      const done = pool.put('wi-1', 'verified', { projectTicket: { projectPath: project.path, id } });
      chain.set('wi-1', { kind: 'success', wi: done });
      pool.put('wi-2', 'running', { projectTicket: { projectPath: project.path, id } });
      expect((await svc.runOnce()).changes).toEqual([]);
      expect((await ticketOf(id)).status).toBe('in_progress');

      pool.items.delete('wi-2');
      chain.set('wi-1', { kind: 'pending' });
      expect((await svc.runOnce()).changes).toEqual([]);
    });

    it('uses the linked WorkItems when the ticket has no workItemId, only if all are verified / done', async () => {
      const id = await inProgress();
      await store.mutate(project.path, id, 'test', () => ({ fields: { workItemId: null } }));
      pool.put('wi-a', 'verified', { projectTicket: { projectPath: project.path, id } });
      pool.put('wi-b', 'rejected', { projectTicket: { projectPath: project.path, id } });
      expect((await svc.runOnce()).changes).toEqual([]);
      pool.put('wi-b', 'done', { projectTicket: { projectPath: project.path, id } });
      expect((await svc.runOnce()).changes[0]).toMatchObject({ kind: 'closed' });
    });

    it('never touches ready / backlog tickets (a person may have reopened them)', async () => {
      const id = await make({ status: 'ready' }, 1);
      await store.mutate(project.path, id, 'test', () => ({ fields: { workItemId: 'wi-1' } }));
      const wi = pool.put('wi-1', 'verified', { projectTicket: { projectPath: project.path, id } });
      chain.set('wi-1', { kind: 'success', wi });
      expect((await svc.runOnce()).changes).toEqual([]);
      expect((await ticketOf(id)).status).toBe('ready');
    });
  });

  describe('orphan flag', () => {
    it('flags a ticket whose assignee was removed, without making it look fresh, and clears the flag when fixed', async () => {
      const id = await make({ status: 'ready' }, 20);
      await store.mutate(project.path, id, 'test', () => ({ fields: { assignee: 'think-tank-kai-75d30ac6' }, keepUpdatedAt: true }));
      const before = await ticketOf(id);

      const r = await svc.runOnce();
      expect(r.changes).toEqual([expect.objectContaining({ ticketId: id, kind: 'flagged' })]);
      const flagged = await ticketOf(id);
      expect(flagged.labels).toContain(C.ORPHAN_LABEL);
      expect(flagged.updatedAt).toBe(before.updatedAt);
      expect(flagged.log[flagged.log.length - 1]).toContain(`${C.REASON}: assignee think-tank-kai-75d30ac6 no longer exists`);

      // Idempotent.
      expect((await svc.runOnce()).changes).toEqual([]);

      // Reassigned to someone who exists: the flag goes away.
      await store.mutate(project.path, id, 'test', () => ({ fields: { assignee: dev } }));
      expect((await svc.runOnce()).changes[0]).toMatchObject({ kind: 'unflagged' });
      expect((await ticketOf(id)).labels).not.toContain(C.ORPHAN_LABEL);
    });
  });

  describe('stale review', () => {
    it('sends ONE batched item to the team lead for the team\'s stale tickets, and none for fresh ones', async () => {
      const a = await make({ status: 'in_progress', team: 't-app' }, 5);
      const b = await make({ status: 'backlog', team: 't-app' }, 30);
      await make({ status: 'backlog', team: 't-app' }, 2); // fresh
      await make({ status: 'ready', team: 't-app' }, 0); // fresh

      const r = await svc.runOnce();

      expect(r.reviewItems).toEqual([expect.objectContaining({ teamKey: 't-app', target: lead, tickets: 2 })]);
      const items = pool.reviewItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ type: C.REVIEW_WORK_ITEM_TYPE, owner: 'team_lead', target: lead, status: 'queued' });
      expect(items[0].metadata).toMatchObject({ requiresVerification: false });
      expect(items[0].briefMarkdown).toContain(`**${b}**`);
      expect(items[0].briefMarkdown).toContain(`**${a}**`);
    });

    it('sends nothing when no team has a stale ticket', async () => {
      await make({ status: 'ready', team: 't-app' }, 1);
      expect((await svc.runOnce()).reviewItems).toEqual([]);
      expect(pool.addToPool).not.toHaveBeenCalled();
    });

    it('cannot loop: no second item the same day, none while one is live, none within the ticket cooldown', async () => {
      await make({ status: 'backlog', team: 't-app' }, 30);
      expect((await svc.runOnce()).reviewItems).toHaveLength(1);

      // Hourly sweeps during the day: nothing new.
      for (let h = 1; h <= 23; h += 11) {
        clock = NOW0 + h * 60 * 60 * 1000;
        expect((await svc.runOnce()).reviewItems).toEqual([]);
      }

      // A day later, the lead finished the item but did not touch the ticket: the ticket cooldown (3 days) holds.
      const first = pool.reviewItems()[0];
      first.status = 'verified';
      clock = NOW0 + 1.5 * DAY;
      expect((await svc.runOnce()).reviewItems).toEqual([]);
      expect(pool.reviewItems()).toHaveLength(1);

      // After the cooldown the ticket is offered again, in a fresh item.
      clock = NOW0 + (C.REVIEW_COOLDOWN_DAYS + 0.5) * DAY;
      expect((await svc.runOnce()).reviewItems).toHaveLength(1);
      expect(pool.reviewItems()).toHaveLength(2);
    });

    it('does not stack a new item on one the lead has not finished', async () => {
      await make({ status: 'backlog', team: 't-app' }, 30);
      await svc.runOnce();
      // Four days on (past the cooldown), the old item is still being worked.
      pool.reviewItems()[0].status = 'running';
      clock = NOW0 + 4 * DAY;
      expect((await svc.runOnce()).reviewItems).toEqual([]);
      expect(pool.reviewItems()).toHaveLength(1);
    });

    it('replaces an item that sat queued for a day without being picked up', async () => {
      await make({ status: 'backlog', team: 't-app' }, 30);
      await svc.runOnce();
      const first = pool.reviewItems()[0];
      clock = NOW0 + 4 * DAY;
      expect((await svc.runOnce()).reviewItems).toHaveLength(1);
      expect(pool.cancelQueued).toHaveBeenCalledWith(first.id, expect.stringContaining('never picked up'));
      expect(pool.reviewItems().filter((w) => w.status === 'queued')).toHaveLength(1);
    });

    it('a ticket the lead touched is no longer stale and is not sent again', async () => {
      const id = await make({ status: 'backlog', team: 't-app' }, 30);
      await svc.runOnce();
      pool.reviewItems()[0].status = 'verified';
      clock = NOW0 + 5 * DAY;
      await store.appendLog(project.path, id, lead, 'still valid: waiting on design');
      clock = NOW0 + 6 * DAY;
      expect((await svc.runOnce()).reviewItems).toEqual([]);
    });

    it('goes to the orchestrator when the team has no lead', async () => {
      teams = [{ ...teams[0], members: [member('m-dev', dev)] }];
      await make({ status: 'backlog', team: 't-app' }, 30);
      const r = await svc.runOnce();
      expect(r.reviewItems[0]).toMatchObject({ target: 'crewly-orc' });
      expect(pool.reviewItems()[0]).toMatchObject({ owner: 'orchestrator', target: 'crewly-orc' });
    });

    it('does not wake a paused team', async () => {
      teams = [{ ...teams[0], paused: { pausedAt: new Date(NOW0 - DAY).toISOString(), by: 'owner', until: new Date(NOW0 + DAY).toISOString() } } as unknown as Team];
      await make({ status: 'backlog', team: 't-app' }, 30);
      expect((await svc.runOnce()).reviewItems).toEqual([]);
    });

    it('keeps its memory across restarts (same state file)', async () => {
      await make({ status: 'backlog', team: 't-app' }, 30);
      await svc.runOnce();
      pool.reviewItems()[0].status = 'verified';
      const again = new TicketHygieneService({
        tickets: store,
        pool,
        directory: { getTeams: async () => teams, getProjects: async () => [project] },
        followChain: async () => ({ kind: 'pending' }),
        stateFile: path.join(root, 'state.json'),
        logger: quiet(),
        now: () => new Date(NOW0 + 2 * 60 * 60 * 1000),
      });
      expect((await again.runOnce()).reviewItems).toEqual([]);
    });

    it('a failed enqueue is not remembered, so the next sweep retries', async () => {
      await make({ status: 'backlog', team: 't-app' }, 30);
      pool.addToPool.mockRejectedValueOnce(new Error('pool down'));
      expect((await svc.runOnce()).reviewItems).toEqual([]);
      expect((await svc.runOnce()).reviewItems).toHaveLength(1);
    });
  });
});
