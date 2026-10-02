/**
 * Integration: the ticket autopilot against the REAL TaskPoolService (temp
 * pool dir) and the real ticket workflow — autopilot on → a triage item for
 * the lead → the lead makes tickets ready / assigns → members get the work →
 * the lead completes the triage → nothing left to triage.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { PoolStorage } from '../task-pool/pool-storage.js';
import { ProjectTicketService } from './project-ticket.service.js';
import { ProjectTicketWorkflowService } from './project-ticket-workflow.service.js';
import { TicketAutopilotService } from './ticket-autopilot.service.js';
import type { ComponentLogger } from '../core/logger.service.js';
import type { Project, Team, TeamMember } from '../../types/index.js';

const quiet = (): ComponentLogger =>
  ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as unknown as ComponentLogger;

function member(id: string, sessionName: string, role = 'developer'): TeamMember {
  return { id, name: id, sessionName, role, systemPrompt: '', agentStatus: 'active', workingStatus: 'idle', runtimeType: 'claude-code', createdAt: '', updatedAt: '' } as TeamMember;
}

describe('ticket autopilot × real task pool', () => {
  let root: string;
  let pool: TaskPoolService;
  let wf: ProjectTicketWorkflowService;
  let autopilot: TicketAutopilotService;
  let project: Project;
  let teams: Team[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-autopilot-int-'));
    project = { id: 'p-ce', name: 'CE', path: path.join(root, 'ce'), teams: {}, status: 'active', createdAt: '', updatedAt: '' };
    await fs.mkdir(project.path, { recursive: true });
    teams = [
      {
        id: 't-ce',
        name: 'CE',
        members: [member('m-lead', 'ce-owen', 'team-leader'), member('m-ann', 'ce-ann'), member('m-bo', 'ce-bo')],
        projectIds: ['p-ce'],
        createdAt: '',
        updatedAt: '',
      },
    ];
    pool = new TaskPoolService(new PoolStorage({ dataDir: path.join(root, 'pool') }));
    const directory = {
      getTeams: async () => teams,
      getProjects: async () => [project],
      saveProject: async (p: Project) => {
        project = p;
      },
    };
    wf = new ProjectTicketWorkflowService({
      tickets: new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' }),
      pool,
      directory,
      logger: quiet(),
    });
    autopilot = new TicketAutopilotService({
      tickets: new ProjectTicketService({ logger: quiet(), ensureTracked: async () => 'tracked' }),
      pool,
      directory,
      workflow: wf,
      ledger: { getSessionUsageSince: () => ({ totalTokens: 0 }) },
      notifyOwner: async () => true,
      stateFile: path.join(root, 'state.json'),
      logger: quiet(),
    });
    autopilot.start(0);
  });

  afterEach(async () => {
    autopilot.stop();
    await pool.destroy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('autopilot on → triage for the lead → lead readies and assigns → members work → triage done', async () => {
    const email = await wf.create('p-ce', { title: 'Partner email draft', priority: 'P1' }, {});
    const faq = await wf.create('p-ce', { title: 'FAQ page' }, {});
    const idea = await wf.create('p-ce', { title: 'Idea from a worker' }, { session: 'ce-ann' });

    // Off: nothing happens.
    expect(await autopilot.tick()).toEqual([]);

    await autopilot.updateSettings('p-ce', { enabled: true }, { session: 'crewly-orc' });
    const [ev] = await autopilot.tick();
    expect(ev.decision).toEqual({ action: 'triage' });
    const triage = (await pool.getAllItems()).filter((wi) => wi.type === 'ticket_triage');
    expect(triage).toHaveLength(1);
    expect(triage[0]).toMatchObject({ target: 'ce-owen', status: 'queued', metadata: { requiresVerification: false } });
    expect(triage[0].briefMarkdown).toContain(`${idea.id} · P2 · backlog`);
    expect(triage[0].briefMarkdown).toContain('worker-created — review first');

    // The lead picks up the triage item (AutoClaim / dispatch path).
    expect(await pool.claimSpecificItem('ce-owen', triage[0].id)).not.toBeNull();

    // Lead decisions: assign one, make one ready, ask the owner about the email, cancel the idea.
    const assigned = await wf.assign('p-ce', faq.id, 'ce-ann', { session: 'ce-owen' });
    expect(assigned.workItem).toMatchObject({ type: 'project_task', target: 'ce-ann', status: 'queued' });
    await wf.askOwner('p-ce', email.id, { session: 'ce-owen' }, { question: 'Send the draft to the 3 partners?' });
    await wf.transition('p-ce', idea.id, 'cancelled', { session: 'ce-owen' }, 'out of scope');
    const extra = await wf.create('p-ce', { title: 'Split: FAQ images', status: 'ready' }, { session: 'ce-owen' });

    // Members get the work: the assigned one is queued for ce-ann (dispatch
    // wakes her), the ready one is picked up by the next idle member.
    expect(await pool.claimSpecificItem('ce-ann', assigned.workItem!.id)).not.toBeNull();
    const picked = await wf.claimNextForAgent('ce-bo');
    expect(picked).toMatchObject({ claimed: true, ticket: { id: extra.id, status: 'in_progress', assignee: 'ce-bo' } });

    // The lead completes the triage (no verification) — nothing is left to triage.
    await pool.completeItem(triage[0].id, { summary: 'FAQ → ann, email → owner, idea cancelled' }, { role: 'agent', session: 'ce-owen' }); // the complete endpoint maps any agent session (a lead too) to 'agent'
    expect((await pool.findWorkItem(triage[0].id))?.status).toBe('done');
    const [again] = await autopilot.tick();
    expect(again.decision).toEqual({ action: 'skip', reason: 'nothing_to_triage' });
  });
});
