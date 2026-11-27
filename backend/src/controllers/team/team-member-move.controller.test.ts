/**
 * Tests for the move-member route (specs/2026-11-27-move-team-member.md):
 * who may call it, what reaches the service, how a refusal is answered and
 * how a member's run state is read.
 */

import type { Request, Response } from 'express';
import type { TeamMember } from '../../types/index.js';
import type { ApiContext } from '../types.js';

const moveTeamMember = jest.fn();
const sessionExists = jest.fn();
const isAgentBusy = jest.fn();
const rejectNonOwnerOrOrchestrator = jest.fn();

jest.mock('../../services/team/team-member-move.service.js', () => ({
  ...jest.requireActual('../../services/team/team-member-move.service.js'),
  moveTeamMember: (...args: unknown[]) => moveTeamMember(...args),
}));
jest.mock('../../services/activity/activity-log.service.js', () => ({
  recordActivity: jest.fn(),
  actorFromRequest: jest.fn(() => ({ type: 'agent', id: 'crewly-orc' })),
}));
jest.mock('../../middleware/caller-identity.middleware.js', () => ({
  rejectNonOwnerOrOrchestrator: (...args: unknown[]) => rejectNonOwnerOrOrchestrator(...args),
}));
jest.mock('../../services/session/index.js', () => ({
  getSessionBackendSync: () => ({ sessionExists }),
  getSessionStatePersistence: () => ({ setTeamId: jest.fn() }),
}));
jest.mock('../../services/agent/member-relaunch.js', () => ({ isAgentBusy: (...args: unknown[]) => isAgentBusy(...args) }));
jest.mock('../../services/task-pool/task-pool.service.js', () => ({ TaskPoolService: { getInstance: () => ({}) } }));
jest.mock('../../services/v3/trigger-engine.service.js', () => ({ TriggerEngine: { getInstance: () => ({}) } }));
jest.mock('../../services/workflow/cron-task.service.js', () => ({ CronTaskService: { getInstance: () => ({}) } }));
jest.mock('../../services/decisions/decision.service.js', () => ({ DecisionService: { getInstance: () => null } }));

import { recordActivity } from '../../services/activity/activity-log.service.js';
import { MoveRefusedError } from '../../services/team/team-member-move.service.js';
import { buildMoveDeps, memberRunState, moveTeamMemberHandler } from './team-member-move.controller.js';

const context = { storageService: {} } as unknown as ApiContext;

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  res.status.mockReturnValue(res);
  return res;
};

const call = async (body: unknown) => {
  const res = makeRes();
  await moveTeamMemberHandler.call(context, { params: { id: 'from', memberId: 'm1' }, body } as unknown as Request, res);
  return res;
};

beforeEach(() => {
  jest.clearAllMocks();
  rejectNonOwnerOrOrchestrator.mockReturnValue(false);
});

describe('POST /api/teams/:id/members/:memberId/move', () => {
  it('stops at a caller who is neither the owner nor the orchestrator', async () => {
    rejectNonOwnerOrOrchestrator.mockReturnValue(true);
    await call({ toTeamId: 'to' });
    expect(moveTeamMember).not.toHaveBeenCalled();
  });

  it('requires toTeamId', async () => {
    for (const body of [undefined, {}, { toTeamId: ' ' }, { toTeamId: 5 }]) {
      const res = await call(body);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(moveTeamMember).not.toHaveBeenCalled();
  });

  it('passes the move to the service, returns the result and logs it', async () => {
    const result = {
      member: { id: 'm1', name: 'Nova', role: 'developer', sessionName: 's-nova' },
      from: { id: 'from', name: 'Core' },
      to: { id: 'to', name: 'Growth' },
    };
    moveTeamMember.mockResolvedValue(result);

    const res = await call({ toTeamId: ' to ', allowLead: 'yes' });

    expect(moveTeamMember).toHaveBeenCalledWith(expect.anything(), { fromTeamId: 'from', memberId: 'm1', toTeamId: 'to', allowLead: false });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: result });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'team.member.moved',
      before: { teamId: 'from', team: 'Core', role: 'developer' },
      after: { teamId: 'to', team: 'Growth', role: 'developer' },
    }));
  });

  it('answers a refusal with its status, code and message', async () => {
    moveTeamMember.mockRejectedValue(new MoveRefusedError('member_busy', 'Nova is working right now.'));
    const res = await call({ toTeamId: 'to' });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'member_busy', error: 'Nova is working right now.' });
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('answers 500 with the reason when a write failed', async () => {
    moveTeamMember.mockRejectedValue(new Error('Move failed, nothing changed: disk full'));
    const res = await call({ toTeamId: 'to' });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Move failed, nothing changed: disk full' });
  });
});

describe('buildMoveDeps', () => {
  it('leaves decisions out when owner decisions are not set up', () => {
    expect(buildMoveDeps(context).decisions).toBeUndefined();
    expect(buildMoveDeps(context).storage).toBe(context.storageService);
  });
});

describe('memberRunState', () => {
  const state = (agentStatus: TeamMember['agentStatus'], workingStatus: TeamMember['workingStatus'] = 'idle') =>
    memberRunState({ agentStatus, workingStatus } as TeamMember, 's-nova');

  beforeEach(() => {
    sessionExists.mockReturnValue(true);
    isAgentBusy.mockResolvedValue(false);
  });

  it('is stopped without a session, whatever the stored working status says', async () => {
    sessionExists.mockReturnValue(false);
    expect(await state('inactive', 'in_progress')).toBe('stopped');
    expect(await state('suspended')).toBe('stopped');
  });

  it('is starting while the agent has not registered', async () => {
    expect(await state('started')).toBe('starting');
    sessionExists.mockReturnValue(false);
    expect(await state('activating')).toBe('starting');
    expect(await state('starting')).toBe('starting');
  });

  it('is busy while a turn runs, also without a terminal session (in-process runtime)', async () => {
    expect(await state('active', 'in_progress')).toBe('busy');
    isAgentBusy.mockResolvedValue(true);
    expect(await state('active')).toBe('busy');
    sessionExists.mockReturnValue(false);
    expect(await state('active', 'in_progress')).toBe('busy');
  });

  it('is idle when running and quiet', async () => {
    expect(await state('active')).toBe('idle');
  });
});
