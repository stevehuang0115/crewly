/**
 * Tests for the project tickets HTTP API (specs/2026-09-28-project-tickets.md §6).
 */
import express from 'express';
import request from 'supertest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createProjectTicketsMigrationRouter, createProjectTicketsRouter } from './project-tickets.routes.js';
import { projectTicketWorkflow } from './project-tickets.controller.js';
import { ProjectTicketService } from '../../services/project-tickets/project-ticket.service.js';
import { ProjectTicketWorkflowService, type ProjectTicketPool } from '../../services/project-tickets/project-ticket-workflow.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { ComponentLogger } from '../../services/core/logger.service.js';

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
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    ProjectTicketWorkflowService.setInstance(null);
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
});
