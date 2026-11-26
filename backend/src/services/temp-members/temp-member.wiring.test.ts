/**
 * Tests for the temporary-member wiring: registers the `team_seat` card
 * handler, installs the running service, and adds / removes members through
 * the team controller's own paths
 * (specs/2026-11-26-temp-members-seat-requests.md).
 */

import * as os from 'os';
import type { ApiContext } from '../../controllers/types.js';
import type { Team } from '../../types/index.js';
import { getTempMemberService, setTempMemberService } from './temp-member.service.js';
import { createMemberOps, lastPtyActivityAt, startTempMembers, type MemberPaths } from './temp-member.wiring.js';

describe('startTempMembers', () => {
  afterEach(() => {
    getTempMemberService()?.stop();
    setTempMemberService(null);
  });

  it('registers the team_seat handler and installs the service', () => {
    const register = jest.fn();
    const decisions = { askPrebuilt: jest.fn(), get: jest.fn() };
    const service = startTempMembers({ crewlyHome: os.tmpdir(), decisions: decisions as never, sendToAgent: jest.fn(), apiContext: () => ({}) as ApiContext, register });
    expect(register).toHaveBeenCalledWith('team_seat', service);
    expect(getTempMemberService()).toBe(service);
  });
});

describe('createMemberOps', () => {
  const makeTeam = (): Team =>
    ({
      id: 't1',
      name: 'Marketing',
      members: [
        { id: 'm-run', name: 'Temp-Developer-1', sessionName: 'mkt-temp-1', role: 'developer' },
        { id: 'm-off', name: 'Temp-Developer-2', sessionName: '', role: 'developer' },
      ],
    }) as unknown as Team;

  const make = () => {
    const team = makeTeam();
    const calls: string[] = [];
    const saveTeam = jest.fn(async () => undefined);
    const context = { storageService: { getTeams: async () => [team], saveTeam } } as unknown as ApiContext;
    const paths: MemberPaths = {
      addMemberToTeam: jest.fn(async (_c, t, input) => {
        calls.push(`add:${input.name}`);
        const m = { id: 'm-new', sessionName: '', ...input } as never;
        t.members.push(m);
        return m;
      }),
      stopTeamMemberGracefully: jest.fn(async (_c, _t, m) => {
        calls.push(`stop:${m.id}`);
        return { success: true };
      }),
      removeMemberFromTeam: jest.fn(async (_c, t, id) => {
        calls.push(`remove:${id}`);
        const i = t.members.findIndex((m) => m.id === id);
        return i === -1 ? null : t.members.splice(i, 1)[0];
      }),
    };
    const invalidate = jest.fn(async () => undefined);
    return { team, calls, paths, invalidate, saveTeam, ops: createMemberOps({ apiContext: () => context, memberPaths: async () => paths, invalidate }) };
  };

  it('adds through the controller\'s add path with the temporary record', async () => {
    const { ops, paths, team, invalidate } = make();
    const temporary = { createdBy: 'mkt-owen', createdAt: 'a', reason: 'r', expiresAt: 'b' };
    const added = await ops.addMember('t1', { name: 'Temp-QA-1', role: 'qa', temporary });
    expect(paths.addMemberToTeam).toHaveBeenCalledWith(expect.anything(), team, { name: 'Temp-QA-1', role: 'qa', temporary });
    expect(added).toMatchObject({ id: 'm-new', name: 'Temp-QA-1' });
    expect(invalidate).toHaveBeenCalled();
    await expect(ops.addMember('nope', { name: 'x', role: 'qa' })).rejects.toThrow('Team not found');
  });

  it('stops a running member first, then removes it through the remove path', async () => {
    const { ops, calls, team } = make();
    await expect(ops.removeMember('t1', 'm-run')).resolves.toBe(true);
    expect(calls).toEqual(['stop:m-run', 'remove:m-run']);
    expect(team.members.map((m) => m.id)).toEqual(['m-off']);
  });

  it('does not stop a member that is not running, and still removes after a failed stop', async () => {
    const { ops, calls, paths } = make();
    await expect(ops.removeMember('t1', 'm-off')).resolves.toBe(true);
    expect(calls).toEqual(['remove:m-off']);
    (paths.stopTeamMemberGracefully as jest.Mock).mockRejectedValueOnce(new Error('terminate failed'));
    await expect(ops.removeMember('t1', 'm-run')).resolves.toBe(true);
  });

  it('answers false for an unknown team or member', async () => {
    const { ops, calls } = make();
    await expect(ops.removeMember('nope', 'm-run')).resolves.toBe(false);
    await expect(ops.removeMember('t1', 'nope')).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('saves a team and drops the cached list', async () => {
    const { ops, team, saveTeam, invalidate } = make();
    await ops.saveTeam(team);
    expect(saveTeam).toHaveBeenCalledWith(team);
    expect(invalidate).toHaveBeenCalled();
  });
});

describe('lastPtyActivityAt', () => {
  it('is null for a session that never printed', () => {
    expect(lastPtyActivityAt('never-started-session')).toBeNull();
  });
});
