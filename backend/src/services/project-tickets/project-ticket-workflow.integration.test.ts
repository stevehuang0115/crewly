/**
 * Integration: project tickets against the REAL TaskPoolService (temp pool
 * dir) — the claimed WorkItem is accepted by the pool, goes through the
 * normal worker-done → lead-verify path, and the ticket follows it.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { PoolStorage } from '../task-pool/pool-storage.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import { ProjectTicketService } from './project-ticket.service.js';
import { ProjectTicketWorkflowService } from './project-ticket-workflow.service.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

function member(id: string, sessionName: string, role = 'developer'): TeamMember {
  return { id, name: id, sessionName, role, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' } as TeamMember;
}

describe('project tickets × real task pool', () => {
  let root: string;
  let pool: TaskPoolService;
  let wf: ProjectTicketWorkflowService;
  let project: Project;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-wf-int-'));
    project = { id: 'p1', name: 'App', path: path.join(root, 'app'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    await fs.mkdir(project.path, { recursive: true });
    const teams: Team[] = [
      { id: 't1', name: 'App', members: [member('m-lead', 'tl-sam', 'team-leader'), member('m-dev', 'dev-ann')], projectIds: ['p1'], createdAt: '', updatedAt: '' },
    ];
    pool = new TaskPoolService(new PoolStorage({ dataDir: path.join(root, 'pool') }));
    wf = new ProjectTicketWorkflowService({
      tickets: new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' }),
      pool,
      directory: { getTeams: async () => teams, getProjects: async () => [project] },
      logger: quiet(),
    });
  });

  afterEach(async () => {
    await pool.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('claim → worker done → lead verifies → ticket done', async () => {
    const t = await wf.create('p1', { title: 'Export CSV', status: 'ready' }, {});
    const started = await wf.claim('p1', t.id, { session: 'dev-ann' });
    expect(started.claimed).toBe(true);
    expect((await pool.findWorkItem(started.workItem.id))?.status).toBe('running');

    // Worker completes: requiresVerification → done_by_worker; ticket stays in progress.
    await pool.completeItem(started.workItem.id, { summary: 'done' }, { role: 'agent', session: 'dev-ann' });
    expect((await pool.findWorkItem(started.workItem.id))?.status).toBe('done_by_worker');
    expect(await wf.syncTicket(project.path, t.id)).toBe('unchanged');

    // The lead reviews through the normal review item and verifies.
    const review = createWorkItem({
      id: `${started.workItem.id}:verify:${started.workItem.id}`,
      type: 'review',
      owner: 'team_lead',
      target: 'tl-sam',
      title: 'Verify',
      metadata: { verifyOf: started.workItem.id },
    });
    await pool.addToPool(review);
    await pool.claimFromPool('tl-sam');
    await pool.verifyItem(started.workItem.id, { role: 'team_lead', session: 'tl-sam' }, 'verified');

    await wf.onWorkItemEvent(review.id);
    const after = await wf.get('p1', t.id);
    expect(after.status).toBe('done');
    expect(after.workItemId).toBe(started.workItem.id);
  });

  it('owner cancels a running ticket → WorkItem cancelled and the agent is free to claim again', async () => {
    const a = await wf.create('p1', { title: 'A', status: 'ready' }, {});
    const b = await wf.create('p1', { title: 'B', status: 'ready' }, {});
    const started = await wf.claim('p1', a.id, { session: 'dev-ann' });
    await wf.transition('p1', a.id, 'cancelled', {});
    expect((await pool.findWorkItem(started.workItem.id))?.status).toBe('cancelled');
    const next = await wf.claimNextForAgent('dev-ann');
    expect(next?.ticket.id).toBe(b.id);
    expect(next?.claimed).toBe(true);
  });
});
