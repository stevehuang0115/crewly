/**
 * Tests for AppCollaboratorsService — an agent asks, only the owner's tap grants,
 * what is granted is decided from the caller's identity, and the grant is an owner call to Cloud.
 */

import { AppCollaboratorsService } from './app-collaborators.service.js';
import type { AppsCloudClient } from './apps-cloud.client.js';
import type { OwnerDecision } from '../../types/decision.types.js';

const ID = '28au74d9cj';
const ELLA = 'crewly-marketing-ella-e6a6b8ea';

let request: jest.Mock;
let askPrebuilt: jest.Mock;
let svc: AppCollaboratorsService;

const member = async (session: string) => (session === ELLA ? { session, name: 'Ella', team: 'Marketing' } : null);
const decisionFor = (subject: unknown, status: OwnerDecision['status'], chosenKey?: string) =>
  ({ id: 'D-1', kind: 'app_collaborator', status, chosenKey, appCollaborator: subject }) as unknown as OwnerDecision;

beforeEach(() => {
  request = jest.fn(async (method: string, path: string) => (method === 'GET' && path === `/apps/${ID}` ? { name: '科技早报' } : { collaborators: [] }));
  askPrebuilt = jest.fn().mockResolvedValue({ id: 'D-1' });
  svc = new AppCollaboratorsService({
    client: { request } as unknown as AppsCloudClient,
    directory: { member, leadsTeamOf: async () => false },
    instanceId: async () => 'inst-2',
    decisions: () => ({ askPrebuilt }),
    notifyAgent: jest.fn().mockResolvedValue(true),
  });
});

describe('request', () => {
  it('asks the owner for the caller\'s own team, and grants nothing yet', async () => {
    const r = await svc.request(ID, ELLA, { reason: 'write the morning briefing' });
    expect(r).toEqual({ requested: true, decisionId: 'D-1', for: 'the Marketing team' });
    const ask = askPrebuilt.mock.calls[0][0];
    expect(ask).toMatchObject({ kind: 'app_collaborator', asker: ELLA, defaultKey: 'b', sensitive: 'app_access' });
    expect(ask.appCollaborator).toEqual({ appId: ID, appName: '科技早报', kind: 'team', team: 'Marketing', instanceId: 'inst-2', askerSession: ELLA, askerName: 'Ella', reason: 'write the morning briefing' });
    expect(request.mock.calls.some((c) => c[0] === 'PUT')).toBe(false);
  });

  it('scope "agent" asks only for the caller', async () => {
    await svc.request(ID, ELLA, { scope: 'agent' });
    expect(askPrebuilt.mock.calls[0][0].appCollaborator).toMatchObject({ kind: 'agent', session: ELLA });
    expect(askPrebuilt.mock.calls[0][0].appCollaborator.team).toBeUndefined();
  });

  it('refuses the owner, an unknown caller, a bad scope and a bad app id', async () => {
    await expect(svc.request(ID, undefined, {})).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.request(ID, 'stranger-1', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.request(ID, ELLA, { scope: 'everyone' })).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.request('nope', ELLA, {})).rejects.toMatchObject({ code: 'validation' });
    expect(askPrebuilt).not.toHaveBeenCalled();
  });

  it('an app that is not this account\'s (Cloud 404) is not asked about', async () => {
    request.mockRejectedValueOnce(Object.assign(new Error('App not found.'), { status: 404, code: 'not_found' }));
    await expect(svc.request(ID, ELLA, {})).rejects.toMatchObject({ code: 'not_found' });
    expect(askPrebuilt).not.toHaveBeenCalled();
  });

  it('without decision cards it says so instead of pretending', async () => {
    const down = new AppCollaboratorsService({ client: { request } as unknown as AppsCloudClient, directory: { member, leadsTeamOf: async () => false }, instanceId: async () => 'inst-2', decisions: () => null, notifyAgent: jest.fn() });
    await expect(down.request(ID, ELLA, {})).rejects.toMatchObject({ status: 503 });
  });
});

describe('onSettled (the owner\'s answer)', () => {
  const subject = { appId: ID, appName: '科技早报', kind: 'team', team: 'Marketing', instanceId: 'inst-2', askerSession: ELLA, askerName: 'Ella' };

  it('Allow adds the collaborator in Cloud AS THE OWNER, bound to the stored instance, and tells the agent', async () => {
    const note = await svc.onSettled(decisionFor(subject, 'resolved', 'a'));
    const put = request.mock.calls.find((c) => c[0] === 'PUT')!;
    expect(put[1]).toBe(`/apps/${ID}/collaborators`);
    expect(put[2]).toMatchObject({ asOwner: true, body: { kind: 'team', team: 'Marketing', instanceId: 'inst-2' } });
    expect(note).toContain('added');
    expect(note).toContain('cannot republish');
  });

  it('NEGATIVE: Do not allow, the deadline default, expiry and cancel all leave Cloud untouched', async () => {
    for (const [status, key] of [['resolved', 'b'], ['defaulted', 'b'], ['expired', undefined], ['cancelled', undefined]] as const) {
      const note = await svc.onSettled(decisionFor(subject, status, key));
      expect(note).toContain('did not add');
    }
    expect(request.mock.calls.some((c) => c[0] === 'PUT')).toBe(false);
  });

  it('a decision without a subject is ignored; a failed grant is reported, not hidden', async () => {
    expect(await svc.onSettled(decisionFor(undefined, 'resolved', 'a'))).toBeNull();
    request.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500, code: 'http_500' }));
    const note = await svc.onSettled(decisionFor(subject, 'resolved', 'a'));
    expect(note).toContain('failed');
  });
});

describe('owner calls', () => {
  it('add defaults to this instance, remove validates the id, list is as the owner or as the asking agent', async () => {
    await svc.add(ID, { kind: 'agent', session: ELLA });
    expect(request.mock.calls[0][2]).toMatchObject({ asOwner: true, body: { kind: 'agent', session: ELLA, instanceId: 'inst-2' } });
    await expect(svc.remove(ID, '../x')).rejects.toMatchObject({ code: 'validation' });
    await svc.remove(ID, 'entry1');
    expect(request.mock.calls[1]).toEqual(['DELETE', `/apps/${ID}/collaborators/entry1`, { asOwner: true }]);
    await svc.list(ID);
    expect(request.mock.calls[2][2]).toEqual({ asOwner: true });
    await svc.list(ID, ELLA);
    expect(request.mock.calls[3][2]).toEqual({ agent: ELLA });
  });
});
