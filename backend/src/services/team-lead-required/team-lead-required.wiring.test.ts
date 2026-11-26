/**
 * Tests for the team-lead-required wiring.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { Team } from '../../types/index.js';
import * as activity from '../activity/activity-log.service.js';
import { getTeamLeadRequiredService, setTeamLeadRequiredService } from './team-lead-required.service.js';
import { startTeamLeadRequired } from './team-lead-required.wiring.js';

describe('startTeamLeadRequired', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lead-wiring-'));
    jest.spyOn(activity, 'recordActivity').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setTeamLeadRequiredService(null);
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('registers the team_lead handler, installs the service, and applies a pick through the set-lead path', async () => {
    const team = {
      id: 't1',
      name: 'Flopost',
      members: [
        { id: 'm1', name: 'Pia', role: 'product-manager', sessionName: 'flopost-pia' },
        { id: 'm2', name: 'Dex', role: 'developer', sessionName: 'flopost-dex' },
      ],
    } as unknown as Team;
    const saveTeam = jest.fn(async () => undefined);
    const invalidateTeams = jest.fn(async () => undefined);
    const register = jest.fn();
    const sendToAgent = jest.fn(async () => true);
    let asked: OwnerDecision | null = null;
    const decisions = {
      askSystem: jest.fn(async (input: { options: unknown[]; system: { key: string } }) => {
        asked = {
          id: 'D-1',
          kind: 'team_lead',
          system: input.system,
          status: 'open',
          options: (input.options as Array<{ label: string }>).map((o, i) => ({ key: 'abcde'[i], label: o.label })),
        } as unknown as OwnerDecision;
        return asked;
      }),
      get: jest.fn(async () => asked),
      cancelWhere: jest.fn(async () => 0),
    };
    const service = startTeamLeadRequired({
      crewlyHome: dir,
      decisions,
      sendToAgent,
      packageRoot: '/pkg',
      storage: { getTeams: async () => [team], saveTeam },
      invalidateTeams,
      register,
      startTimers: false,
    });
    expect(register).toHaveBeenCalledWith('team_lead', service);
    expect(getTeamLeadRequiredService()).toBe(service);

    await service.tick();
    expect(decisions.askSystem).toHaveBeenCalledTimes(1);
    await service.onSettled({ ...(asked as unknown as OwnerDecision), status: 'resolved', chosenKey: 'a' });
    expect(saveTeam).toHaveBeenCalledWith(expect.objectContaining({ leaderIds: ['m1'] }));
    expect(invalidateTeams).toHaveBeenCalledTimes(1);
    expect(activity.recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.lead.changed', actor: { type: 'owner', via: 'decision' } }));
    expect(sendToAgent).toHaveBeenCalledWith('flopost-pia', expect.stringContaining('/pkg/config/skills/team-leader/delegate-task/execute.sh'));
  });
});
