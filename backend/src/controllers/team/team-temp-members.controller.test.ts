/**
 * Tests for the temporary-member / seat-request routes
 * (specs/2026-11-26-temp-members-seat-requests.md): the caller's session
 * and the team id reach the service, and a refusal keeps its status and code.
 */

import type { Request, Response } from 'express';
import { setTempMemberService, TempMemberError, type TempMemberService } from '../../services/temp-members/temp-member.service.js';
import { addTeamTempMember, getTeamTempMembers, removeTeamTempMember, requestTeamSeat } from './team-temp-members.controller.js';

jest.mock('../../services/activity/activity-log.service.js', () => ({
  recordActivity: jest.fn(),
  actorFromRequest: jest.fn(() => ({ type: 'agent', id: 'mkt-owen' })),
}));

import { recordActivity } from '../../services/activity/activity-log.service.js';

const makeRes = () => {
  const res = { status: jest.fn(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  res.status.mockReturnValue(res);
  return res;
};

const makeReq = (over: Partial<Request> = {}): Request =>
  ({ params: { id: 't1' }, body: {}, headers: { 'x-agent-session': 'mkt-owen' }, ...over }) as unknown as Request;

describe('team-temp-members controller', () => {
  let service: { status: jest.Mock; addTemp: jest.Mock; removeTemp: jest.Mock; requestSeat: jest.Mock };

  beforeEach(() => {
    service = { status: jest.fn(), addTemp: jest.fn(), removeTemp: jest.fn(), requestSeat: jest.fn() };
    setTempMemberService(service as unknown as TempMemberService);
    (recordActivity as jest.Mock).mockClear();
  });

  afterEach(() => setTempMemberService(null));

  it('answers 503 before the service runs', async () => {
    setTempMemberService(null);
    for (const handler of [getTeamTempMembers, addTeamTempMember, removeTeamTempMember, requestTeamSeat]) {
      const res = makeRes();
      await handler(makeReq(), res);
      expect(res.status).toHaveBeenCalledWith(503);
    }
  });

  it('GET returns the status view', async () => {
    service.status.mockResolvedValue({ teamId: 't1', headcount: { used: 0, limit: 2 }, members: [] });
    const res = makeRes();
    await getTeamTempMembers(makeReq(), res);
    expect(service.status).toHaveBeenCalledWith('t1');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { teamId: 't1', headcount: { used: 0, limit: 2 }, members: [] } });
  });

  it('POST temp-members passes the caller, the team and the fields, and logs the addition', async () => {
    const data = { member: { id: 'm1', name: 'Temp-Developer-1', role: 'developer' }, note: 'n' };
    service.addTemp.mockResolvedValue(data);
    const res = makeRes();
    await addTeamTempMember(makeReq({ body: { role: 'developer', reason: 'busy', name: 'Kai', workItemId: 'wi-1', modelId: 'opus' } }), res);
    expect(service.addTemp).toHaveBeenCalledWith('mkt-owen', 't1', { role: 'developer', reason: 'busy', name: 'Kai', workItemId: 'wi-1' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.member.added', after: expect.objectContaining({ temporary: true, reason: 'busy' }) }));
  });

  it('a refusal keeps its status, code and message', async () => {
    service.addTemp.mockRejectedValue(new TempMemberError(409, 'temp_headcount_full', 'used up (2 of 2)'));
    const res = makeRes();
    await addTeamTempMember(makeReq({ body: { role: 'developer', reason: 'busy' } }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'used up (2 of 2)', code: 'temp_headcount_full' });
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it('an unexpected error is a 500', async () => {
    service.requestSeat.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await requestTeamSeat(makeReq({ body: { role: 'developer', reason: 'x' } }), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'boom' });
  });

  it('DELETE passes the member reference, reason and force', async () => {
    service.removeTemp.mockResolvedValue({ removed: true, member: { id: 'm1', name: 'Temp-Developer-1', role: 'developer' } });
    const res = makeRes();
    await removeTeamTempMember(makeReq({ params: { id: 't1', member: 'Temp-Developer-1' }, body: { reason: 'done', force: 'yes' } }), res);
    expect(service.removeTemp).toHaveBeenCalledWith('mkt-owen', 't1', { member: 'Temp-Developer-1', reason: 'done', force: false });
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ action: 'team.member.removed' }));
  });

  it('POST seat-requests passes the caller and the request; no agent header = no caller', async () => {
    service.requestSeat.mockResolvedValue({ requested: true, decisionId: 'D-1' });
    const res = makeRes();
    await requestTeamSeat(makeReq({ body: { role: 'developer', reason: 'x', name: 'Kai' }, headers: {} }), res);
    expect(service.requestSeat).toHaveBeenCalledWith(undefined, 't1', { role: 'developer', reason: 'x', name: 'Kai' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { requested: true, decisionId: 'D-1' } });
  });
});
