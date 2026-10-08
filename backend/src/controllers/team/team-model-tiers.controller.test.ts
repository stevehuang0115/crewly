/**
 * Tests for the model-tier endpoints (crewly#1173): owner-only settings,
 * owner-or-lead review, the lead's proposals.
 */

import type { Request, Response } from 'express';
import { setCallerIdentity, type CallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { markOwner } from '../../middleware/caller-identity.testing.js';
import { ModelTierError, setModelTierService, type ModelTierService } from '../../services/model-tiers/model-tier.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { getTeamModelTiers, proposeTierChange, startTeamModelTierReview, updateTeamModelTiers } from './team-model-tiers.controller.js';

type TestRes = Response & { statusCode: number; body: unknown };

function res(): TestRes {
  const r = { statusCode: 200, body: undefined as unknown } as unknown as TestRes;
  const self = r as unknown as Record<string, unknown>;
  self.status = jest.fn((code: number) => {
    r.statusCode = code;
    return r;
  });
  self.json = jest.fn((body: unknown) => {
    r.body = body;
    return r;
  });
  return r;
}

function req(identity: 'owner' | string | null, over: Partial<Request> = {}): Request {
  const r = { headers: {}, params: { id: 't1' }, body: {}, ...over } as unknown as Request;
  if (identity === 'owner') markOwner(r);
  else if (identity) {
    setCallerIdentity(r, { kind: 'agent', via: 'agent-badge', session: identity } as CallerIdentity);
  } else setCallerIdentity(r, { kind: 'anonymous', via: 'none' } as unknown as CallerIdentity);
  return r;
}

describe('team model-tier controller', () => {
  const service = {
    settings: jest.fn(),
    updateSettings: jest.fn(),
    startReview: jest.fn(),
    propose: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    setModelTierService(service as unknown as ModelTierService);
    jest.spyOn(StorageService, 'getInstance').mockReturnValue({
      getTeams: async () => [
        {
          id: 't1',
          name: 'Marketing',
          leaderIds: ['m-owen'],
          members: [
            { id: 'm-owen', name: 'Owen', sessionName: 'mkt-owen', role: 'team-leader' },
            { id: 'm-ella', name: 'Ella', sessionName: 'mkt-ella', role: 'developer' },
          ],
        },
      ],
    } as unknown as StorageService);
  });
  afterAll(() => setModelTierService(null));

  it('GET returns the settings', async () => {
    service.settings.mockResolvedValue({ teamId: 't1', optimizeUsage: true });
    const r = res();
    await getTeamModelTiers(req('mkt-ella'), r);
    expect(r.body).toEqual({ success: true, data: { teamId: 't1', optimizeUsage: true } });
  });

  it('PUT is owner-only and passes the toggle through', async () => {
    service.updateSettings.mockResolvedValue({ optimizeUsage: true });
    const r = res();
    await updateTeamModelTiers(req('owner', { body: { optimizeUsage: true, memberTiers: { 'm-ella': 'weak' } } }), r);
    expect(service.updateSettings).toHaveBeenCalledWith('t1', { optimizeUsage: true, tierModels: undefined, memberTiers: { 'm-ella': 'weak' } });
    expect(r.statusCode).toBe(200);

    const agent = res();
    await updateTeamModelTiers(req('mkt-owen', { body: { optimizeUsage: true } }), agent);
    expect(agent.statusCode).toBe(403);
    const anon = res();
    await updateTeamModelTiers(req(null, { body: { optimizeUsage: true } }), anon);
    expect(anon.statusCode).toBe(401);
    expect(service.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('maps service errors to their status', async () => {
    service.updateSettings.mockRejectedValue(new ModelTierError(400, 'optimizeUsage is true or false'));
    const r = res();
    await updateTeamModelTiers(req('owner', { body: { optimizeUsage: 'yes' } }), r);
    expect(r.statusCode).toBe(400);
    expect(r.body).toEqual({ success: false, error: 'optimizeUsage is true or false' });
  });

  it('review: the owner or the team lead, not another member', async () => {
    service.startReview.mockResolvedValue({ reviewId: 'TR-1', lead: 'Owen', delivered: true });
    const owner = res();
    await startTeamModelTierReview(req('owner'), owner);
    expect(owner.statusCode).toBe(200);
    const lead = res();
    await startTeamModelTierReview(req('mkt-owen'), lead);
    expect(lead.statusCode).toBe(200);
    const worker = res();
    await startTeamModelTierReview(req('mkt-ella'), worker);
    expect(worker.statusCode).toBe(403);
    expect(service.startReview).toHaveBeenCalledTimes(2);
    expect(service.startReview).toHaveBeenCalledWith('t1', 'on_demand');
  });

  it('proposals pass the calling agent and the body', async () => {
    service.propose.mockResolvedValue({ added: 'change' });
    const r = res();
    await proposeTierChange(req('mkt-owen', { body: { member: 'Ella', tier: 'weak', reason: 'polls' } }), r);
    expect(service.propose).toHaveBeenCalledWith('mkt-owen', { member: 'Ella', tier: 'weak', reason: 'polls' });
    expect(r.body).toEqual({ success: true, data: { added: 'change' } });
  });

  it('503 before the service runs', async () => {
    setModelTierService(null);
    const r = res();
    await getTeamModelTiers(req('owner'), r);
    expect(r.statusCode).toBe(503);
  });
});
