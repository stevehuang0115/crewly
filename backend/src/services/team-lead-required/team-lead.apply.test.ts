/**
 * Tests for applyTeamLead.
 */
import type { Team } from '../../types/index.js';
import * as activity from '../activity/activity-log.service.js';
import { applyTeamLead } from './team-lead.apply.js';

/** A two-member team with no lead. */
function team(): Team {
  return {
    id: 't1',
    name: 'Flopost',
    members: [
      { id: 'm1', name: 'Pia', role: 'product-manager', sessionName: 'flopost-pia' },
      { id: 'm2', name: 'Dex', role: 'developer', sessionName: 'flopost-dex' },
    ],
  } as unknown as Team;
}

describe('applyTeamLead', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sets the lead, saves the team and logs the change', async () => {
    const record = jest.spyOn(activity, 'recordActivity').mockImplementation(() => undefined);
    const saveTeam = jest.fn(async () => undefined);
    const t = team();
    const result = await applyTeamLead({ storage: { saveTeam }, team: t, memberId: 'm1', actor: { type: 'owner', via: 'decision' } });
    expect(result).toEqual({ before: [], after: ['m1'], changed: true });
    expect(t.leaderIds).toEqual(['m1']);
    expect(t.members[0].canDelegate).toBe(true);
    expect(typeof (t as { updatedAt?: string }).updatedAt).toBe('string');
    expect(saveTeam).toHaveBeenCalledWith(t);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'team.lead.changed', actor: { type: 'owner', via: 'decision' }, after: { lead: 'Pia', memberId: 'm1', mode: 'set' } }),
    );
  });

  it('throws for a member that is not on the team, without saving', async () => {
    const saveTeam = jest.fn(async () => undefined);
    await expect(applyTeamLead({ storage: { saveTeam }, team: team(), memberId: 'nope', actor: { type: 'system' } })).rejects.toThrow(/not on team/);
    expect(saveTeam).not.toHaveBeenCalled();
  });
});
