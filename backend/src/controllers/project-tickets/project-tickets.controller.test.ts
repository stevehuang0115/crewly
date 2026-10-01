/**
 * Tests for the project tickets HTTP API (specs/2026-09-28-project-tickets.md §6).
 */
import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createProjectTicketsMigrationRouter, createProjectTicketsRouter, createTicketAutopilotRouter } from './project-tickets.routes.js';
import { projectTicketWorkflow, ticketAutopilot } from './project-tickets.controller.js';
import { TicketAutopilotService } from '../../services/project-tickets/ticket-autopilot.service.js';
import { ProjectTicketService } from '../../services/project-tickets/project-ticket.service.js';
import { ProjectTicketWorkflowService, type ProjectTicketPool } from '../../services/project-tickets/project-ticket-workflow.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { ComponentLogger } from '../../services/core/logger.service.js';
import { DecisionService } from '../../services/decisions/decision.service.js';
import { DecisionStore } from '../../services/decisions/decision-store.js';
import { TicketThreadStore } from '../../services/decisions/ticket-thread-store.js';
import { createTicketDecisionHooks } from '../../services/decisions/decision.wiring.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

function member(id: string, sessionName: string, role = 'developer'): TeamMember {
  return { id, name: id, sessionName, role, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' } as TeamMember;
}

/** Items of the current fake pool (tests seed in-flight WorkItems here). */
let poolItems = new Map<string, WorkItem>();

function fakePool(): ProjectTicketPool {
  const items = new Map<string, WorkItem>();
  poolItems = items;
  return {
    addToPool: async (wi) => void items.set(wi.id, { ...wi }),
    claimSpecificItem: async (agent, id) => {
      const wi = items.get(id);
      if (!wi || wi.status !== 'queued') return null;
      wi.status = 'running';
      return { workItem: { ...wi } };
    },
    findWorkItem: async (id) => items.get(id) ?? null,
    getAllItems: async () => [...items.values()],
    cancelQueued: async (id) => void (items.get(id) && (items.get(id)!.status = 'cancelled')),
    transitionStatus: async (id, status) => {
      const wi = items.get(id);
      if (wi) wi.status = status;
      return wi ?? null;
    },
    releaseClaim: async () => undefined,
    mergeItemMetadata: async (id, patch) => {
      const wi = items.get(id);
      if (!wi) return null;
      wi.metadata = { ...(wi.metadata ?? {}), ...patch };
      return { ...wi };
    },
  };
}

describe('project tickets API', () => {
  let root: string;
  let project: Project;
  const app = express();
  app.use(express.json());
  app.use('/api/project-tickets', createProjectTicketsRouter());
  app.use('/api/project-tickets-migrate', createProjectTicketsMigrationRouter());
  app.use('/api/project-ticket-autopilot', createTicketAutopilotRouter());

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-pt-api-'));
    project = { id: 'p1', name: 'App', path: path.join(root, 'app'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    await fs.mkdir(project.path, { recursive: true });
    const teams: Team[] = [
      { id: 't1', name: 'App', members: [member('m-lead', 'tl-sam', 'team-leader'), member('m-dev', 'dev-ann')], projectIds: ['p1'], createdAt: '', updatedAt: '' },
    ];
    ProjectTicketWorkflowService.setInstance(
      new ProjectTicketWorkflowService({
        tickets: new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' }),
        pool: fakePool(),
        directory: { getTeams: async () => teams, getProjects: async () => [project] },
        logger: quiet(),
      }),
    );
    jest.spyOn(StorageService, 'getInstance').mockReturnValue({ getProjects: async () => [project] } as unknown as StorageService);
    const wf = ProjectTicketWorkflowService.getInstance()!;
    TicketAutopilotService.setInstance(
      new TicketAutopilotService({
        tickets: new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' }),
        pool: { addToPool: async () => undefined, getAllItems: async () => [], cancelQueued: async () => undefined },
        directory: {
          getTeams: async () => teams,
          getProjects: async () => [project],
          saveProject: async (p) => {
            project = p;
          },
        },
        workflow: wf,
        ledger: { getSessionUsageSince: () => ({ cost: 0 }) },
        notifyOwner: async () => true,
        stateFile: path.join(root, 'autopilot-state.json'),
        logger: quiet(),
      }),
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    ProjectTicketWorkflowService.setInstance(null);
    TicketAutopilotService.setInstance(null);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('registers the routes', () => {
    const stack = (createProjectTicketsRouter() as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
    expect(stack.filter((l) => l.route).map((l) => `${Object.keys(l.route!.methods)[0]} ${l.route!.path}`)).toEqual([
      'get /',
      'get /:project',
      'post /:project',
      'get /:project/:id',
      'post /:project/:id/update',
      'post /:project/:id/transition',
      'post /:project/:id/claim',
      'post /:project/:id/assign',
      'post /:project/:id/log',
      'post /:project/:id/link',
      'post /:project/:id/ask-owner',
    ]);
  });

  it('links an in-flight WorkItem (lead), refuses members and finished items', async () => {
    await request(app).post('/api/project-tickets/p1').send({ title: 'Deploy' });
    poolItems.set('wi-live', { id: 'wi-live', type: 'delegate', owner: 'team_lead', target: 'dev-ann', title: 'Deploy', status: 'running', createdAt: '', retryCount: 0, maxRetries: 3, inputTokens: 0, outputTokens: 0, cost: 0 });
    poolItems.set('wi-done', { ...poolItems.get('wi-live')!, id: 'wi-done', status: 'verified' });
    expect((await request(app).post('/api/project-tickets/p1/APP-1/link').set('X-Agent-Session', 'dev-ann').send({ workItemId: 'wi-live' })).status).toBe(403);
    expect((await request(app).post('/api/project-tickets/p1/APP-1/link').set('X-Agent-Session', 'tl-sam').send({ workItemId: 'wi-done' })).status).toBe(409);
    expect((await request(app).post('/api/project-tickets/p1/APP-1/link').set('X-Agent-Session', 'tl-sam').send({})).status).toBe(400);
    const res = await request(app).post('/api/project-tickets/p1/APP-1/link').set('X-Agent-Session', 'tl-sam').send({ workItemId: 'wi-live' });
    expect(res.status).toBe(200);
    expect(res.body.data.ticket).toMatchObject({ status: 'in_progress', assignee: 'dev-ann', workItemId: 'wi-live' });
    expect(poolItems.get('wi-live')!.metadata).toMatchObject({ projectTicket: { projectPath: project.path, id: 'APP-1' } });
  });

  it('owner creates, lists, reads, updates and moves a ticket', async () => {
    const created = await request(app).post('/api/project-tickets/p1').send({ title: 'Export CSV', acceptance: ['header row'], priority: 'P1' });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ id: 'APP-1', status: 'backlog', source: 'owner' });

    const list = await request(app).get('/api/project-tickets/p1?status=backlog');
    expect(list.body.data.tickets.map((t: { id: string }) => t.id)).toEqual(['APP-1']);
    expect(list.body.data.project).toMatchObject({ id: 'p1', name: 'App' });

    const byPath = await request(app).get(`/api/project-tickets/${encodeURIComponent(project.path)}/APP-1`);
    expect(byPath.body.data.body).toContain('## Log');

    const upd = await request(app).post('/api/project-tickets/p1/APP-1/update').send({ priority: 'P0', status: 'ready', note: 'go' });
    expect(upd.body.data).toMatchObject({ priority: 'P0', status: 'ready' });

    const moved = await request(app).post('/api/project-tickets/p1/APP-1/transition').send({ status: 'backlog' });
    expect(moved.body.data.status).toBe('backlog');
  });

  it('maps errors: unknown status 400, missing ticket 404, unknown project 404, outsider 403', async () => {
    await request(app).post('/api/project-tickets/p1').send({ title: 'x' });
    expect((await request(app).post('/api/project-tickets/p1/APP-1/transition').send({ status: 'open' })).status).toBe(400);
    expect((await request(app).get('/api/project-tickets/p1/APP-9')).status).toBe(404);
    expect((await request(app).get('/api/project-tickets/nope')).status).toBe(404);
    const outsider = await request(app).post('/api/project-tickets/p1').set('X-Agent-Session', 'stranger').send({ title: 'y' });
    expect(outsider.status).toBe(403);
    expect(outsider.body.success).toBe(false);
  });

  it('an agent claims with its session header; a lead assigns; members log', async () => {
    await request(app).post('/api/project-tickets/p1').send({ title: 'A', status: 'ready' });
    await request(app).post('/api/project-tickets/p1').send({ title: 'B' });
    const claim = await request(app).post('/api/project-tickets/p1/APP-1/claim').set('X-Agent-Session', 'dev-ann');
    expect(claim.status).toBe(200);
    expect(claim.body.data).toMatchObject({ claimed: true, ticket: { status: 'in_progress', assignee: 'dev-ann' } });
    expect((await request(app).post('/api/project-tickets/p1/APP-1/claim').set('X-Agent-Session', 'tl-sam')).status).toBe(409);

    const assign = await request(app).post('/api/project-tickets/p1/APP-2/assign').set('X-Agent-Session', 'tl-sam').send({ assignee: 'dev-ann' });
    expect(assign.body.data.ticket).toMatchObject({ status: 'in_progress', assignee: 'dev-ann' });
    expect((await request(app).post('/api/project-tickets/p1/APP-2/assign').set('X-Agent-Session', 'dev-ann').send({ assignee: 'tl-sam' })).status).toBe(403);

    const log = await request(app).post('/api/project-tickets/p1/APP-1/log').set('X-Agent-Session', 'dev-ann').send({ note: 'halfway' });
    expect(log.body.data.log.at(-1)).toContain('dev-ann · halfway');
  });

  it('lists across projects for a session, and for the owner', async () => {
    await request(app).post('/api/project-tickets/p1').send({ title: 'A' });
    const mine = await request(app).get('/api/project-tickets').set('X-Agent-Session', 'dev-ann');
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0].tickets).toHaveLength(1);
    const other = await request(app).get('/api/project-tickets?session=stranger');
    expect(other.body.data).toEqual([]);
    const owner = await request(app).get('/api/project-tickets');
    expect(owner.body.data[0].project.id).toBe('p1');
  });

  it('runs the v1 migration as a dry-run for the owner, refuses members', async () => {
    await fs.mkdir(path.join(project.path, '.crewly', 'tasks', 'm1', 'open'), { recursive: true });
    await fs.writeFile(path.join(project.path, '.crewly', 'tasks', 'm1', 'open', 'a.md'), '# Old task\n');
    expect((await request(app).post('/api/project-tickets-migrate/p1').set('X-Agent-Session', 'dev-ann').send({})).status).toBe(403);
    const dry = await request(app).post('/api/project-tickets-migrate/p1').send({});
    expect(dry.body.data).toMatchObject({ apply: false, toCreate: 1, created: 0 });
  });

  it('builds a default workflow when boot has not installed one', () => {
    ProjectTicketWorkflowService.setInstance(null);
    const wf = projectTicketWorkflow();
    expect(wf).toBeInstanceOf(ProjectTicketWorkflowService);
    expect(projectTicketWorkflow()).toBe(wf);
  });

  describe('ticket autopilot switch (owner / orchestrator only)', () => {
    it('lets the owner and the orchestrator read and switch it on; refuses the lead and members', async () => {
      for (const who of ['tl-sam', 'dev-ann', 'stranger']) {
        expect((await request(app).get('/api/project-ticket-autopilot/p1').set('X-Agent-Session', who)).status).toBe(403);
        expect((await request(app).post('/api/project-ticket-autopilot/p1').set('X-Agent-Session', who).send({ enabled: true })).status).toBe(403);
      }
      expect(project.ticketAutopilot).toBeUndefined();

      const off = await request(app).get('/api/project-ticket-autopilot/p1');
      expect(off.status).toBe(200);
      expect(off.body.data).toMatchObject({ settings: { enabled: false, maxInFlightPerMember: 1 }, driver: { session: 'tl-sam', source: 'team_lead' } });

      const on = await request(app).post('/api/project-ticket-autopilot/p1').set('X-Agent-Session', 'crewly-orc').send({ enabled: true, dailyBudgetUsd: 8 });
      expect(on.status).toBe(200);
      expect(on.body.data.settings).toMatchObject({ enabled: true, dailyBudgetUsd: 8 });
      expect(project.ticketAutopilot).toEqual({ enabled: true, dailyBudgetUsd: 8 });

      expect((await request(app).post('/api/project-ticket-autopilot/p1').send({ enabled: 'yes' })).status).toBe(400);
      expect((await request(app).post('/api/project-ticket-autopilot/p1').send({ driver: 'dev-ann' })).status).toBe(400);
      expect((await request(app).get('/api/project-ticket-autopilot/nope')).status).toBe(404);
    });

    it('ask-owner posts a structured decision as the assignee, rejects vague asks, clears', async () => {
      const tickets = new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' });
      const teams: Team[] = [
        { id: 't1', name: 'App', members: [member('m-lead', 'tl-sam', 'team-leader'), member('m-dev', 'dev-ann'), member('m-bo', 'dev-bo')], projectIds: ['p1'], createdAt: '', updatedAt: '' },
      ];
      const decisions = new DecisionService({
        store: new DecisionStore(path.join(root, 'decisions.json')),
        threads: new TicketThreadStore(path.join(root, 'threads.json')),
        slack: () => null,
        instanceId: () => 'inst-1',
        isOwner: () => true,
        identityOf: async () => ({}),
        teamChannelOf: async () => 'C0TEAM',
        teamOf: async () => 't1',
        ...createTicketDecisionHooks({ tickets, getTeams: async () => teams, workflow: projectTicketWorkflow() }),
        deliverToAgent: async () => true,
        logger: quiet(),
      });
      DecisionService.setInstance(decisions);
      try {
        await request(app).post('/api/project-tickets/p1').send({ title: 'Email the partners' });
        await tickets.mutate(project.path, 'APP-1', 'owner', () => ({ fields: { assignee: 'dev-ann' } }));
        const ask = { question: 'Send the draft to the 3 partners?', options: ['Send Monday — after the review', 'Hold'], default: 'Hold' };
        // A member who is neither lead nor assignee cannot ask.
        expect((await request(app).post('/api/project-tickets/p1/APP-1/ask-owner').set('X-Agent-Session', 'dev-bo').send(ask)).status).toBe(403);
        // The old one-line form is rejected with a helpful error.
        const vague = await request(app).post('/api/project-tickets/p1/APP-1/ask-owner').set('X-Agent-Session', 'tl-sam').send({ question: 'Send it?' });
        expect(vague.status).toBe(400);
        expect(vague.body.error).toMatch(/options are required/);
        // The lead asks; the assignee (not the lead, not the orc) owns the question.
        const asked = await request(app).post('/api/project-tickets/p1/APP-1/ask-owner').set('X-Agent-Session', 'tl-sam').send(ask);
        expect(asked.status).toBe(200);
        expect(asked.body.data.decision).toMatchObject({ id: 'D-1', asker: 'dev-ann', requestedBy: 'tl-sam', defaultKey: 'b', status: 'open' });
        expect(asked.body.data.ticket.labels).toContain('needs-owner');
        // The assignee itself may ask too.
        expect((await request(app).post('/api/project-tickets/p1/APP-1/ask-owner').set('X-Agent-Session', 'dev-ann').send(ask)).status).toBe(200);
        const cleared = await request(app).post('/api/project-tickets/p1/APP-1/ask-owner').set('X-Agent-Session', 'tl-sam').send({ clear: true, note: 'owner said yes' });
        expect(cleared.body.data.ticket.labels).not.toContain('needs-owner');
        expect(cleared.body.data.withdrawn).toBe(2);
        expect(await decisions.list('open')).toEqual([]);
      } finally {
        DecisionService.setInstance(null);
      }
    });

    it('builds a default autopilot when boot has not installed one', () => {
      TicketAutopilotService.setInstance(null);
      const svc = ticketAutopilot();
      expect(svc).toBeInstanceOf(TicketAutopilotService);
      expect(ticketAutopilot()).toBe(svc);
    });
  });
});
