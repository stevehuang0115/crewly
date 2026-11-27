/**
 * Tests for moving an agent between teams
 * (specs/2026-11-27-move-team-member.md). Team configs, prompt files and cron
 * stores are the real services over a temporary CREWLY_HOME.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageService } from '../core/storage.service.js';
import { CronTaskService } from '../workflow/cron-task.service.js';
import type { Team, TeamMember } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { Trigger } from '../../types/v2/trigger.types.js';
import { setTeamLead, getTeamLeadIds } from '../../utils/team.utils.js';
import { moveTeamMember, MoveRefusedError, type MemberRunState, type MoveMemberDeps } from './team-member-move.service.js';

const NOW = '2026-11-27T00:00:00.000Z';
const SESSION = 'ce-nova-aaaa1111';

const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'name'>): TeamMember => ({
  sessionName: `s-${over.id}`,
  role: 'developer',
  systemPrompt: '',
  agentStatus: 'inactive',
  workingStatus: 'idle',
  runtimeType: 'claude-code',
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const team = (id: string, name: string, members: TeamMember[], over: Partial<Team> = {}): Team => ({
  id,
  name,
  members,
  projectIds: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const workItem = (id: string, over: Partial<WorkItem>): WorkItem =>
  ({ id, status: 'queued', target: SESSION, metadata: { teamId: 'from' }, ...over }) as unknown as WorkItem;

const trigger = (id: string, over: Partial<Trigger>): Trigger =>
  ({ id, name: id, teamId: 'from', action: {}, createdBy: 'agent', ...over }) as unknown as Trigger;

describe('moveTeamMember', () => {
  let home: string;
  let storage: StorageService;
  let cron: CronTaskService;
  let items: WorkItem[];
  let triggers: Trigger[];
  let state: MemberRunState;
  let deps: MoveMemberDeps;
  let reassigned: Array<[string[], string, string]>;
  let sessionTeams: Array<[string, string]>;

  const nova = (): TeamMember =>
    member({
      id: 'm-nova',
      name: 'Nova',
      sessionName: SESSION,
      modelId: 'opus',
      reasoningEffort: 'high',
      systemPrompt: 'You are Nova, a developer on the Core team.',
    });
  const teamById = async (id: string): Promise<Team> => (await storage.getTeams()).find((t) => t.id === id) as Team;
  const ids = async (id: string): Promise<string[]> => (await teamById(id)).members.map((m) => m.id);
  const move = (over: Partial<Parameters<typeof moveTeamMember>[1]> = {}) =>
    moveTeamMember(deps, { fromTeamId: 'from', memberId: 'm-nova', toTeamId: 'to', ...over });
  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    const error = await promise.then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(MoveRefusedError);
    return (error as MoveRefusedError).code;
  };

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'move-member-'));
    StorageService.clearInstance();
    storage = new StorageService(home);
    cron = new CronTaskService(home);
    await storage.saveTeam(team('from', 'Core', [member({ id: 'm-lead', name: 'Ada', role: 'team-leader' }), nova()], { leaderIds: ['m-lead'] }));
    await storage.saveTeam(team('to', 'Growth', [member({ id: 'm-boss', name: 'Bo', role: 'team-leader' })], { leaderIds: ['m-boss'] }));
    items = [];
    triggers = [];
    state = 'stopped';
    reassigned = [];
    sessionTeams = [];
    deps = {
      storage,
      runState: async () => state,
      // The same code path set-team-lead uses; only its activity entry is skipped.
      makeLead: async (t, memberId) => {
        setTeamLead(t, memberId);
        await storage.saveTeam(t);
      },
      workItems: {
        getAllItems: async () => items,
        patchMetadata: async (id, key, value) => {
          const wi = items.find((i) => i.id === id);
          if (wi) wi.metadata = { ...wi.metadata, [key]: value };
          return wi ?? null;
        },
      },
      triggers: {
        list: () => triggers,
        moveToTeam: async (id, teamId) => {
          const t = triggers.find((x) => x.id === id);
          if (t) t.teamId = teamId;
          return Boolean(t);
        },
      },
      cron,
      decisions: {
        reassignTeam: async (sessions, from, to) => {
          reassigned.push([[...sessions], from, to]);
          return ['D-1'];
        },
      },
      sessionState: {
        setTeamId: (session, teamId) => {
          sessionTeams.push([session, teamId]);
          return true;
        },
      },
    };
  });

  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('moves the same entry: id, session, agent id, role and model settings', async () => {
    const result = await move();

    expect(await ids('from')).toEqual(['m-lead']);
    expect(await ids('to')).toEqual(['m-boss', 'm-nova']);
    const moved = (await teamById('to')).members[1];
    expect(moved).toMatchObject({
      id: 'm-nova',
      name: 'Nova',
      role: 'developer',
      sessionName: SESSION,
      agentId: SESSION,
      runtimeType: 'claude-code',
      modelId: 'opus',
      reasoningEffort: 'high',
    });
    expect(result.member.sessionName).toBe(SESSION);
    expect(result.restartRequired).toBe(false);
  });

  it('leaves the agent directory, keyed by session name, untouched', async () => {
    const memory = path.join(home, 'agents', SESSION, 'memory.json');
    fs.mkdirSync(path.dirname(memory), { recursive: true });
    fs.writeFileSync(memory, '{"keep":true}');

    await move();

    expect(fs.readFileSync(memory, 'utf-8')).toBe('{"keep":true}');
    expect(fs.readdirSync(path.join(home, 'agents'))).toEqual([SESSION]);
  });

  it('pins the agent id of a member stored without one, from the source team name', async () => {
    // A config written before agent ids existed: saveTeam would fill one in, so edit the file.
    const file = path.join(home, 'teams', 'from', 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Team;
    const stored = raw.members.find((m) => m.id === 'm-nova') as TeamMember;
    stored.sessionName = '';
    delete stored.agentId;
    fs.writeFileSync(file, JSON.stringify(raw));

    const result = await move();

    // Derived from "Core", the team it was created in, not from "Growth".
    expect(result.member.sessionName).toMatch(/^core-nova-/);
    expect((await teamById('to')).members[1].agentId).toBe(result.member.sessionName);
  });

  it('moves the prompt file and renames only the generated team sentence', async () => {
    await storage.saveMemberPrompt('from', 'm-nova', 'You are Nova, a developer on the Core team.\nAlways run the Core team checks.');

    await move();

    expect(await storage.getMemberPrompt('to', 'm-nova')).toBe('You are Nova, a developer on the Growth team.\nAlways run the Core team checks.');
    expect(await storage.getMemberPrompt('from', 'm-nova')).toBeNull();
  });

  it('retargets only the member\'s open work', async () => {
    items = [
      workItem('open', {}),
      workItem('done', { status: 'done' as WorkItem['status'] }),
      workItem('other-agent', { target: 's-m-lead' }),
      workItem('third-team', { metadata: { teamId: 'elsewhere' } }),
    ];

    const result = await move();

    expect(result.updated.workItems).toEqual(['open']);
    expect(items.map((i) => i.metadata?.['teamId'])).toEqual(['to', 'from', 'from', 'elsewhere']);
  });

  it('moves the member\'s followups and keeps the team\'s own schedules', async () => {
    items = [workItem('open', {})];
    triggers = [
      trigger('aimed', { action: { createWorkItem: { target: SESSION } } }),
      trigger('message', { action: { sendMessage: { target: SESSION, message: 'hi' } } }),
      trigger('own', { createdBySession: SESSION }),
      trigger('wakes', { action: { wakeWorkItemId: 'open' } }),
      trigger('for-lead', { createdBySession: SESSION, action: { sendMessage: { target: 's-m-lead', message: 'hi' } } }),
      trigger('spec', { managedBy: 'team-spec', action: { createWorkItem: { target: SESSION } } }),
    ];

    const result = await move();

    expect(result.updated.triggers).toEqual(['aimed', 'message', 'own', 'wakes']);
    expect(triggers.filter((t) => t.teamId === 'from').map((t) => t.id)).toEqual(['for-lead', 'spec']);
    expect(result.warnings.join('\n')).toContain('team schedule "spec"');
  });

  it('moves the member\'s cron tasks with the same ids', async () => {
    const mine = await cron.create({ cronExpression: '0 9 * * *', targetAgent: SESSION, targetTeamId: 'from', taskDescription: 'daily', createdBy: 'user' });
    const leads = await cron.create({ cronExpression: '0 9 * * *', targetAgent: 's-m-lead', targetTeamId: 'from', taskDescription: 'lead', createdBy: 'user' });

    const result = await move();

    expect(result.updated.cronTasks).toEqual([mine.id]);
    expect((await cron.getByTeam('to')).map((t) => [t.id, t.targetTeamId])).toEqual([[mine.id, 'to']]);
    expect((await cron.getByTeam('from')).map((t) => t.id)).toEqual([leads.id]);
  });

  it('updates decisions and session restore state under every name of the member', async () => {
    const result = await move();

    expect(reassigned).toEqual([[[SESSION, 'm-nova'], 'from', 'to']]);
    expect(sessionTeams).toEqual([[SESSION, 'to']]);
    expect(result.updated.decisions).toEqual(['D-1']);
    expect(result.updated.sessionState).toBe(true);
  });

  it('puts the member under the lead of a hierarchical target', async () => {
    const target = await teamById('to');
    target.hierarchical = true;
    await storage.saveTeam(target);

    await move();

    const after = await teamById('to');
    expect(after.members[1]).toMatchObject({ parentMemberId: 'm-boss', canDelegate: false });
    expect(after.members[0].subordinateIds).toEqual(['m-nova']);
  });

  it('asks for a restart when the member is running and idle', async () => {
    state = 'idle';
    expect((await move()).restartRequired).toBe(true);
  });

  it.each(['busy', 'starting'] as const)('refuses a member that is %s and changes nothing', async (running) => {
    state = running;
    expect(await refusal(move())).toBe('member_busy');
    expect(await ids('from')).toEqual(['m-lead', 'm-nova']);
    expect(await ids('to')).toEqual(['m-boss']);
  });

  it('refuses the source lead unless allowed', async () => {
    expect(await refusal(move({ memberId: 'm-lead' }))).toBe('member_is_lead');
    expect(await ids('from')).toEqual(['m-lead', 'm-nova']);

    const result = await move({ memberId: 'm-lead', allowLead: true });

    expect(await ids('from')).toEqual(['m-nova']);
    expect((await teamById('from')).leaderIds ?? []).not.toContain('m-lead');
    expect(result.warnings.join('\n')).toContain('has no lead now');
  });

  it('moves the source lead when the target already names it lead', async () => {
    const target = await teamById('to');
    target.leaderIds = ['m-lead'];
    deps.storage = {
      getTeams: async () => (await storage.getTeams()).map((t) => (t.id === 'to' && !t.members.some((m) => m.id === 'm-lead') ? { ...t, leaderIds: ['m-lead'] } : t)),
      saveTeam: (t) => storage.saveTeam(t),
      getMemberPrompt: (a, b) => storage.getMemberPrompt(a, b),
      removeMemberPrompt: (a, b) => storage.removeMemberPrompt(a, b),
    };

    await move({ memberId: 'm-lead' });

    expect(await ids('to')).toContain('m-lead');
  });

  describe('asLead', () => {
    /** Ada and Nova both lead Core, as two co-leads do. */
    const coLeads = async (): Promise<void> => {
      const source = await teamById('from');
      source.leaderIds = ['m-lead', 'm-nova'];
      await storage.saveTeam(source);
    };

    it('moves a co-lead into an empty team as its lead, without allowLead', async () => {
      await coLeads();
      await storage.saveTeam(team('new', 'Studio', []));

      const result = await move({ toTeamId: 'new', asLead: true });

      const created = await teamById('new');
      expect(created.leaderIds).toEqual(['m-nova']);
      expect(created.members).toEqual([expect.objectContaining({ id: 'm-nova', agentId: SESSION, canDelegate: true })]);
      expect(getTeamLeadIds(await teamById('from'))).toEqual(['m-lead']);
      expect(result.leadOfTarget).toBe(true);
      expect(result.warnings.join('\n')).toContain('"Core" is now led by Ada');
    });

    it('replaces the lead of a hierarchical target and keeps the hierarchy consistent', async () => {
      const target = await teamById('to');
      target.hierarchical = true;
      await storage.saveTeam(target);

      const result = await move({ asLead: true });

      const after = await teamById('to');
      const [boss, nova] = after.members;
      expect(after.leaderIds).toEqual(['m-nova']);
      expect(nova).toMatchObject({ canDelegate: true, hierarchyLevel: 1, subordinateIds: ['m-boss'] });
      expect(nova.parentMemberId).toBeUndefined();
      expect(boss).toMatchObject({ canDelegate: false, parentMemberId: 'm-nova', subordinateIds: [] });
      expect(result.warnings).toContain('Nova replaced Bo as lead of "Growth".');
    });

    it('still needs allowLead for the sole lead', async () => {
      expect(await refusal(move({ memberId: 'm-lead', asLead: true }))).toBe('member_is_lead');
      expect(await ids('from')).toEqual(['m-lead', 'm-nova']);

      const result = await move({ memberId: 'm-lead', asLead: true, allowLead: true });

      expect(result.leadOfTarget).toBe(true);
      expect((await teamById('to')).leaderIds).toEqual(['m-lead']);
    });

    it('still refuses a co-lead without asLead or allowLead', async () => {
      await coLeads();
      expect(await refusal(move())).toBe('member_is_lead');
    });

    it('keeps the move and says so when the lead change fails', async () => {
      deps.makeLead = async () => {
        throw new Error('disk full');
      };

      const result = await move({ asLead: true });

      expect(result.leadOfTarget).toBe(false);
      expect(await ids('to')).toContain('m-nova');
      expect(result.warnings.join('\n')).toContain('NOT made lead of "Growth" (disk full)');
    });

    it('leaves the lead alone without asLead', async () => {
      const result = await move();
      expect(result.leadOfTarget).toBe(false);
      expect((await teamById('to')).leaderIds).toEqual(['m-boss']);
    });
  });

  it('refuses the team it is already on, so a repeated move duplicates nothing', async () => {
    await move();

    expect(await refusal(move())).toBe('same_team');
    expect(await refusal(move({ fromTeamId: 'to' }))).toBe('same_team');
    expect(await ids('to')).toEqual(['m-boss', 'm-nova']);
  });

  it.each([
    ['source_not_found', { fromTeamId: 'nope' }],
    ['target_not_found', { toTeamId: 'nope' }],
    ['member_not_found', { memberId: 'nope' }],
    ['orchestrator', { toTeamId: 'orchestrator' }],
    ['orchestrator', { fromTeamId: 'orchestrator' }],
  ])('refuses with %s', async (code, input) => {
    expect(await refusal(move(input))).toBe(code);
    expect(await ids('from')).toEqual(['m-lead', 'm-nova']);
  });

  it('refuses an archived target', async () => {
    const target = await teamById('to');
    target.archived = true;
    await storage.saveTeam(target);

    expect(await refusal(move())).toBe('target_archived');
  });

  it('refuses a temporary member', async () => {
    const source = await teamById('from');
    source.members[1].temporary = { createdBy: 's-m-lead', createdAt: NOW, reason: 'busy', expiresAt: NOW };
    await storage.saveTeam(source);

    expect(await refusal(move())).toBe('member_is_temporary');
  });

  it('refuses when the target already holds the session', async () => {
    const target = await teamById('to');
    target.members.push(member({ id: 'm-twin', name: 'Twin', sessionName: SESSION }));
    await storage.saveTeam(target);

    expect(await refusal(move())).toBe('already_in_target');
  });

  it('undoes the target write when the source cannot be saved', async () => {
    const real = storage.saveTeam.bind(storage);
    jest.spyOn(storage, 'saveTeam').mockImplementation(async (t) => {
      if (t.id === 'from') throw new Error('disk full');
      await real(t);
    });

    await expect(move()).rejects.toThrow('Move failed, nothing changed: disk full');

    expect(await ids('from')).toEqual(['m-lead', 'm-nova']);
    expect(await ids('to')).toEqual(['m-boss']);
    expect(sessionTeams).toEqual([]);
  });

  it('says where the member is listed twice when the undo fails too', async () => {
    const real = storage.saveTeam.bind(storage);
    let writes = 0;
    jest.spyOn(storage, 'saveTeam').mockImplementation(async (t) => {
      writes += 1;
      if (writes > 1) throw new Error('disk full');
      await real(t);
    });

    await expect(move()).rejects.toThrow('may be listed in both teams. Remove it from "Growth"');
  });

  it('removes the member again when a stale write puts it back into the source', async () => {
    const stale = await teamById('from');
    const real = storage.saveTeam.bind(storage);
    let raced = false;
    jest.spyOn(storage, 'saveTeam').mockImplementation(async (t) => {
      await real(t);
      if (t.id === 'from' && !raced) {
        raced = true;
        await real(stale);
      }
    });

    await move();

    expect(await ids('from')).toEqual(['m-lead']);
    expect(await ids('to')).toEqual(['m-boss', 'm-nova']);
  });

  it('reports a record that could not be updated and keeps the move', async () => {
    deps.cron = { moveMemberTasks: async () => { throw new Error('unreadable'); } };

    const result = await move();

    expect(result.warnings).toContain('Could not update cron tasks: unreadable');
    expect(await ids('to')).toContain('m-nova');
  });

  it('serialises two moves of the same member', async () => {
    const [first, second] = await Promise.allSettled([move(), move()]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(await ids('to')).toEqual(['m-boss', 'm-nova']);
  });
});
