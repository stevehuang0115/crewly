/**
 * Tests for the team-lead delegation endpoints (crewly#1083).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Request, Response } from 'express';
import type { Team, TeamMember } from '../../types/index.js';
import { setCallerIdentity, type CallerIdentity } from '../../middleware/caller-identity.middleware.js';
import { markOwner } from '../../middleware/caller-identity.testing.js';
import { StorageService } from '../../services/core/storage.service.js';
import { TokenUsageService } from '../../services/monitoring/token-usage.service.js';
import { TlDelegationService } from '../../services/tl-delegation/tl-delegation.service.js';
import { getTeamLeadShare, recordLeadSelfWork } from './team-lead-share.controller.js';

const m = (over: Partial<TeamMember>) => ({ id: 'x', name: 'X', sessionName: 'x', role: 'developer', agentStatus: 'active', workingStatus: 'idle', ...over }) as TeamMember;
const TEAM = {
  id: 't-think',
  name: 'Think Tank',
  leaderIds: ['a'],
  members: [m({ id: 'a', name: 'Atlas', sessionName: 'tt-atlas', role: 'team-leader' }), m({ id: 's', name: 'Sage', sessionName: 'tt-sage' })],
} as Team;

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

function req(session: string | 'owner', over: Partial<Request> = {}): Request {
  const r = { headers: {}, params: { id: 't-think' }, body: {}, ...over } as unknown as Request;
  if (session === 'owner') markOwner(r);
  else setCallerIdentity(r, { kind: 'agent', via: 'agent-badge', session } as CallerIdentity);
  return r;
}

describe('team lead-share controller', () => {
  let dir: string;
  let delegation: TlDelegationService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ctl-'));
    delegation = new TlDelegationService({ leadContext: async () => null, statePath: path.join(dir, 's.json'), logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } as never });
    TlDelegationService.setInstance(delegation);
    jest.spyOn(StorageService, 'getInstance').mockReturnValue({ getTeams: async () => [TEAM] } as unknown as StorageService);
    jest.spyOn(TokenUsageService, 'getInstance').mockReturnValue({
      forEachEvent: (visit: (s: string, e: unknown) => void) => {
        const at = new Date(Date.now() - 60_000).toISOString();
        visit('tt-atlas', { timestamp: at, input: 0, output: 0, cachedInput: 3_000_000, model: 'claude-opus-5-5' });
        visit('tt-sage', { timestamp: at, input: 0, output: 0, cachedInput: 1_000_000, model: 'claude-opus-5-5' });
      },
    } as unknown as TokenUsageService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    TlDelegationService.setInstance(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET returns the lead share, nudges and kept work', async () => {
    delegation.recordKeptWork({ session: 'tt-atlas', teamId: 't-think', reason: 'needs the Vercel login', work: 'Deploy' });
    const r = res();
    await getTeamLeadShare(req('owner'), r);
    const body = r.body as { success: boolean; data: { row: { today: { share: number; flagged: boolean } }; keptWork: unknown[]; nudges: unknown } };
    expect(body.success).toBe(true);
    expect(body.data.row.today.share).toBe(0.75);
    expect(body.data.row.today.flagged).toBe(true);
    expect(body.data.keptWork).toHaveLength(1);
    expect(body.data.nudges).toEqual({ total: { count: 0, followed: 0 }, day: { count: 0, followed: 0 } });
  });

  it('GET 404s an unknown team', async () => {
    const r = res();
    await getTeamLeadShare(req('owner', { params: { id: 'nope' } } as Partial<Request>), r);
    expect(r.statusCode).toBe(404);
  });

  it('POST records kept work for the calling lead and its team', async () => {
    const r = res();
    await recordLeadSelfWork(req('tt-atlas', { body: { reason: 'needs the Vercel login', work: 'Deploy preview', workItemId: 'wi-1' } }), r);
    expect(r.statusCode).toBe(201);
    expect(delegation.keptWorkSince(0)).toEqual([expect.objectContaining({ session: 'tt-atlas', teamId: 't-think', reason: 'needs the Vercel login', workItemId: 'wi-1' })]);
  });

  it('POST needs an agent caller and both fields', async () => {
    const r1 = res();
    await recordLeadSelfWork(req('owner', { body: { reason: 'x', work: 'y' } }), r1);
    expect(r1.statusCode).toBe(400);
    const r2 = res();
    await recordLeadSelfWork(req('tt-atlas', { body: { reason: '  ', work: 'y' } }), r2);
    expect(r2.statusCode).toBe(400);
    expect(delegation.keptWorkSince(0)).toHaveLength(0);
  });
});
