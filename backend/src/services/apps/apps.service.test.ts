/**
 * Tests for AppsService — publish create vs reuse vs adopt, deleted app
 * replaced, rollback, notify card, data pass-through and validation.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppsCloudError, type AppsCloudClient } from './apps-cloud.client.js';
import { AppsRegistryService } from './apps-registry.service.js';
import {
  AppsService,
  PUBLIC_PAUSED_MESSAGE,
  appCardText,
  blockedPublicNameWord,
  plainAppUrl,
  requireAppId,
  requireCollectionList,
  requireTtlDays,
  threadMentions,
  validatePublicRequest,
  parseOwnerSpec,
  isOwnerMember,
  type OwnerTargets,
} from './apps.service.js';

const ID = '28au74d9cj';
const ID2 = 'xyzabcdefg';
const FILES = [{ path: 'index.html', contentBase64: Buffer.from('<h1>x</h1>').toString('base64') }];

let home: string;
let registry: AppsRegistryService;
let request: jest.Mock;
let cards: { ownerDm: jest.Mock; postToOwnerDm: jest.Mock; postReply: jest.Mock };
let sameTeam: jest.Mock;
let service: AppsService;

const appView = (appId: string, name = 'Groceries', currentVersion = 1) => ({
  appId,
  name,
  slug: null,
  url: `https://apps.crewlyai.com/${appId}`,
  currentVersion,
  latestVersion: currentVersion,
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-svc-'));
  registry = new AppsRegistryService(home);
  request = jest.fn(async (method: string, p: string, opts?: { body?: { name?: string; version?: number } }) => {
    if (method === 'POST' && p === '/apps') return appView(ID, opts?.body?.name);
    if (method === 'GET' && /^\/apps\/[a-z0-9]{10}$/.test(p)) return appView(p.slice(6));
    if (method === 'PATCH') return appView(p.slice(6), opts?.body?.name);
    if (method === 'POST' && p.endsWith('/versions')) return { version: 3, entry: 'index.html', files: 1, totalBytes: 10, note: null, createdAt: 't', current: true };
    if (method === 'POST' && p.endsWith('/rollback')) return appView(p.split('/')[2], 'Groceries', opts?.body?.version);
    return { ok: true, method, p, opts };
  });
  // Default: no owner DM, so cards carry the plain URL (the P2 behaviour).
  cards = { ownerDm: jest.fn().mockResolvedValue(null), postToOwnerDm: jest.fn().mockResolvedValue({ ok: true }), postReply: jest.fn().mockResolvedValue({ ok: true }) };
  sameTeam = jest.fn(async (a: string, b: string) => [a, b].every((x) => x.startsWith('team-a-')));
  service = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards, sameTeam });
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('AppsService thumbnails', () => {
  it('schedules a thumbnail after a publish and after a rollback, and a failing scheduler never fails the publish', async () => {
    const schedule = jest.fn();
    const svc = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards, thumbnails: { schedule } });
    await svc.publish({ files: FILES, name: 'Groceries', source: '/w/g' }, { agentSession: 'dev-ella' });
    expect(schedule).toHaveBeenCalledWith(ID, 'dev-ella');
    await svc.rollback(ID, 1, {});
    expect(schedule).toHaveBeenLastCalledWith(ID, undefined);
    schedule.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(svc.publish({ files: FILES, source: '/w/g' }, { agentSession: 'dev-ella' })).resolves.toMatchObject({ appId: ID });
  });
});

describe('AppsService.publish', () => {
  it('creates an app the first time and records it for the agent, cursor at 0', async () => {
    const out = await service.publish({ files: FILES, name: 'Groceries', source: '/w/groceries', note: 'first' }, { agentSession: 'dev-ella' });

    expect(out).toEqual({ appId: ID, name: 'Groceries', url: `https://apps.crewlyai.com/${ID}`, version: 3, created: true, notified: false });
    expect(request).toHaveBeenCalledWith('POST', '/apps', { body: { name: 'Groceries' }, agent: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/versions`, { body: { files: FILES, note: 'first' }, agent: 'dev-ella' });
    expect(await registry.get(ID)).toMatchObject({ agentSession: 'dev-ella', source: '/w/groceries', currentVersion: 3, cursor: 0 });
  });

  it('names a new app after the source when no name is given', async () => {
    await service.publish({ files: FILES, source: '/w/timer.html' }, { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('POST', '/apps', { body: { name: 'timer' }, agent: 'dev-ella' });
  });

  it('republishes the same source to the same app without creating one', async () => {
    await registry.upsert(ID, { name: 'Groceries', agentSession: 'dev-ella', source: '/w/groceries', cursor: 12 });

    const out = await service.publish({ files: FILES, source: '/w/groceries' }, { agentSession: 'dev-ella' });

    expect(out.created).toBe(false);
    expect(out.appId).toBe(ID);
    expect(request.mock.calls.filter(([m, p]) => m === 'POST' && p === '/apps')).toHaveLength(0);
    expect((await registry.get(ID))?.cursor).toBe(12);
  });

  it("does not reuse another agent's app by name", async () => {
    await registry.upsert(ID2, { name: 'Groceries', agentSession: 'dev-bob', source: '/w/bob' });
    const out = await service.publish({ files: FILES, name: 'Groceries' }, { agentSession: 'dev-ella' });
    expect(out.created).toBe(true);
  });

  it('renames an existing app when a different name is given', async () => {
    await registry.upsert(ID, { name: 'Groceries', agentSession: 'dev-ella', source: '/w/g' });
    const out = await service.publish({ files: FILES, source: '/w/g', name: 'Weekly shop' }, { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('PATCH', `/apps/${ID}`, { body: { name: 'Weekly shop' }, agent: 'dev-ella' });
    expect(out.name).toBe('Weekly shop');
  });

  it('lets the owner adopt an app made elsewhere; the poller starts from the head', async () => {
    const out = await service.publish({ files: FILES, appId: ID2 }, {});
    expect(out).toMatchObject({ appId: ID2, created: false });
    expect(await registry.get(ID2)).toMatchObject({ agentSession: null, cursor: null });
  });

  it("refuses an agent publishing to an app it did not publish (unknown or another agent's)", async () => {
    await expect(service.publish({ files: FILES, appId: ID2 }, { agentSession: 'dev-ella' })).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    await registry.upsert(ID2, { name: 'Bob', agentSession: 'dev-bob' });
    await expect(service.publish({ files: FILES, appId: ID2 }, { agentSession: 'dev-ella' })).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    expect(request).not.toHaveBeenCalled();
  });

  it('lets the publisher republish by explicit id', async () => {
    await registry.upsert(ID2, { name: 'G', agentSession: 'dev-ella' });
    await expect(service.publish({ files: FILES, appId: ID2 }, { agentSession: 'dev-ella' })).resolves.toMatchObject({ appId: ID2 });
  });

  it('publishes a new app when the recorded one was deleted in Cloud', async () => {
    await registry.upsert(ID2, { name: 'Old', agentSession: 'dev-ella', source: '/w/g' });
    request.mockImplementationOnce(async () => {
      throw new AppsCloudError(404, 'not_found', 'App not found.');
    });
    const out = await service.publish({ files: FILES, source: '/w/g', name: 'Old' }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ appId: ID, created: true });
    expect((await registry.get(ID2))?.deleted).toBe(true);
  });

  it('an owner publish keeps the recorded agent', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    await service.publish({ files: FILES, appId: ID }, {});
    expect((await registry.get(ID))?.agentSession).toBe('dev-ella');
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/versions`, expect.objectContaining({ agent: undefined }));
  });

  it('without an owner DM, posts the plain Open-app card where the agent talks with the owner', async () => {
    const out = await service.publish({ files: FILES, name: 'Groceries', notify: true }, { agentSession: 'dev-ella' });
    expect(cards.postReply).toHaveBeenCalledWith('dev-ella', `📱 Groceries · [Open app](https://apps.crewlyai.com/${ID})`);
    expect(cards.postToOwnerDm).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([, p]) => String(p).includes('open-links'))).toBe(false);
    expect(out).toMatchObject({ notified: true, card: 'plain', cardPlace: 'conversation', linkError: expect.stringMatching(/No DM with the owner/) });
  });

  it('reports a card that could not be delivered without failing the publish', async () => {
    cards.postReply.mockResolvedValueOnce({ ok: false, error: 'no conversation' });
    const out = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ notified: false, notifyError: 'no conversation', version: 3 });

    cards.postReply.mockRejectedValueOnce(new Error('slack down'));
    const out2 = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(out2).toMatchObject({ notified: false, notifyError: 'slack down' });

    // An owner publish of an app no agent published: nobody to post as.
    const owner = await service.publish({ files: FILES, appId: ID2, notify: true }, {});
    expect(owner.notified).toBe(false);
    expect(owner.notifyError).toMatch(/Only an agent/);
  });

  it.each([
    [{ files: FILES, publicRequest: { publicRead: ['bad/name'] } }, /not a collection name/],
    [{ files: FILES, publicRequest: {} }, /at least one collection/],
    [{ files: [] }, /non-empty array/],
    [{ files: [{ path: '../x', contentBase64: '' }] }, /relative path/],
    [{ files: [{ path: '/etc/passwd', contentBase64: '' }] }, /relative path/],
    [{ files: [{ path: 'a.html' }] }, /contentBase64/],
    [{ files: FILES, appId: 'NOT-AN-ID' }, /10-character/],
    [{ files: FILES, name: 'x'.repeat(81) }, /80 characters/],
  ])('rejects a bad request %#', async (input, msg) => {
    await expect(service.publish(input, { agentSession: 'dev-ella' })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(msg) });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('AppsService other operations', () => {
  it('rolls back and records the current version', async () => {
    await registry.upsert(ID, { name: 'G', currentVersion: 3, agentSession: 'dev-ella' });
    const app = await service.rollback(ID, '2', { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/rollback`, { body: { version: 2 }, agent: 'dev-ella' });
    expect(app.currentVersion).toBe(2);
    expect((await registry.get(ID))?.currentVersion).toBe(2);
    await expect(service.rollback(ID, 0, {})).rejects.toMatchObject({ status: 400 });
    await expect(service.rollback(ID, 1, { agentSession: 'dev-bob' })).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(service.versions(ID, { agentSession: 'dev-bob' })).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(service.rollback(ID, 1, {})).resolves.toBeTruthy();
  });

  it('data: publisher and its team yes, other agents no, owner always', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'team-a-ella' });
    await expect(service.getDoc(ID, 'items', 'x', { agentSession: 'team-a-ella' })).resolves.toBeTruthy();
    await expect(service.getDoc(ID, 'items', 'x', { agentSession: 'team-a-bob' })).resolves.toBeTruthy();
    await expect(service.setDoc(ID, 'items', 'x', {}, { agentSession: 'team-b-eve' })).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    await expect(service.getDoc(ID, 'items', 'x', {})).resolves.toBeTruthy();
    await expect(service.getDoc(ID2, 'items', 'x', { agentSession: 'team-a-ella' })).rejects.toMatchObject({ code: 'not_your_app' });
    // A teammate may also manage the app (owner 2026-10-05).
    await expect(service.versions(ID, { agentSession: 'team-a-bob' })).resolves.toBeTruthy();
    await expect(service.versions(ID2, { agentSession: 'team-a-ella' })).rejects.toMatchObject({ code: 'not_your_app' });
  });

  it("lists the caller's own apps (owner: all) without poller state", async () => {
    await registry.upsert(ID, { name: 'G', cursor: 9, agentSession: 'dev-ella' });
    await registry.upsert(ID2, { name: 'B', agentSession: 'dev-bob' });
    const all = await service.list();
    expect(all.map((a) => a.appId).sort()).toEqual([ID, ID2].sort());
    expect(all[0]).not.toHaveProperty('cursor');
    expect((await service.list({ agentSession: 'dev-ella' })).map((a) => a.appId)).toEqual([ID]);
  });

  it('passes data calls through with the agent attribution', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    const who = { agentSession: 'dev-ella' };
    await service.listDocs(ID, 'items', { limit: '50', after: 'abc' }, who);
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/data/items`, { query: { limit: 50, after: 'abc' }, agent: 'dev-ella' });
    await service.getDoc(ID, 'items', 'a:b', who);
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/data/items/a%3Ab`, { agent: 'dev-ella' });
    await service.setDoc(ID, 'items', 'milk', { done: true }, who);
    expect(request).toHaveBeenLastCalledWith('PUT', `/apps/${ID}/data/items/milk`, { body: { data: { done: true } }, agent: 'dev-ella' });
    await service.updateDoc(ID, 'items', 'milk', { done: false }, 4, who);
    expect(request).toHaveBeenLastCalledWith('PATCH', `/apps/${ID}/data/items/milk`, { body: { data: { done: false }, ifRev: 4 }, agent: 'dev-ella' });
    await service.updateDoc(ID, 'items', 'milk', { done: false }, undefined, who);
    expect(request).toHaveBeenLastCalledWith('PATCH', `/apps/${ID}/data/items/milk`, { body: { data: { done: false } }, agent: 'dev-ella' });
    await service.addDoc(ID, 'items', { name: 'eggs' }, who);
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/data/items`, { body: { data: { name: 'eggs' } }, agent: 'dev-ella' });
    await service.deleteDoc(ID, 'items', 'milk', who);
    expect(request).toHaveBeenLastCalledWith('DELETE', `/apps/${ID}/data/items/milk`, { agent: 'dev-ella' });
    await service.versions(ID, who);
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/versions`, { agent: 'dev-ella' });
  });

  it('validates ids, collections and data before calling Cloud', async () => {
    await expect(service.getDoc(ID, 'bad/coll', 'x', {})).rejects.toThrow(/collection/);
    await expect(service.getDoc(ID, 'items', 'bad id', {})).rejects.toThrow(/docId/);
    await expect(service.getDoc(ID, 'items', '..', {})).rejects.toThrow(/docId/);
    await expect(service.deleteDoc(ID, 'items', '.', {})).rejects.toThrow(/docId/);
    await expect(service.listDocs(ID, '..', {}, {})).rejects.toThrow(/collection/);
    await expect(service.listDocs(ID, '.', {}, {})).rejects.toThrow(/collection/);
    await expect(service.setDoc(ID, 'items', 'x', [1], {})).rejects.toThrow(/JSON object/);
    await expect(service.updateDoc(ID, 'items', 'x', {}, 'abc', {})).rejects.toThrow(/ifRev/);
    await expect(service.listDocs(ID, 'items', { limit: 9999 }, {})).rejects.toThrow(/limit/);
    await expect(service.addDoc('nope', 'items', {}, {})).rejects.toThrow(/appId/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('appCardText cleans the name of link syntax', () => {
    expect(appCardText('My [app](evil)\n', plainAppUrl(ID))).toBe(`📱 My app evil · [Open app](https://apps.crewlyai.com/${ID})`);
    expect(appCardText('', plainAppUrl(ID))).toBe(`📱 App · [Open app](https://apps.crewlyai.com/${ID})`);
  });

  it('requireAppId accepts only P1-shaped ids', () => {
    expect(requireAppId(ID)).toBe(ID);
    expect(() => requireAppId('28au74d9c1')).toThrow();
    expect(() => requireAppId(undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// P3 (specs/2026-10-04-crewly-apps-p3.md)
// ---------------------------------------------------------------------------

const TOKEN = 'tok_SECRET_abc123';
const signed = (appId = ID) => `https://apps.crewlyai.com/${appId}?k=${TOKEN}`;

describe('P3: signed open-link card', () => {
  beforeEach(() => {
    cards.ownerDm.mockResolvedValue('dm-ella');
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (method === 'POST' && /\/open-links$/.test(p)) return { linkId: 'lnk_1', url: signed(p.split('/')[2]), expiresAt: '2026-10-11T00:00:00.000Z' };
      if (method === 'DELETE' && /\/open-links/.test(p)) return { revoked: true };
      return base(method, p, opts);
    });
  });

  it('mints a fresh link and posts the signed card to the owner DM only; the result never carries the token', async () => {
    const out = await service.publish({ files: FILES, name: 'Groceries', notify: true }, { agentSession: 'dev-ella' });

    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/open-links`, { body: {}, agent: 'dev-ella' });
    expect(cards.postToOwnerDm).toHaveBeenCalledWith('dev-ella', 'dm-ella', `📱 Groceries · [Open app](${signed()})`);
    expect(cards.postReply).not.toHaveBeenCalled();
    expect(out).toEqual({
      appId: ID,
      name: 'Groceries',
      url: `https://apps.crewlyai.com/${ID}`,
      version: 3,
      created: true,
      notified: true,
      card: 'signed',
      cardPlace: 'owner-dm',
      linkId: 'lnk_1',
      linkExpiresAt: '2026-10-11T00:00:00.000Z',
    });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('falls back to the plain card when minting fails (old Cloud, error)', async () => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (/\/open-links$/.test(p)) throw new AppsCloudError(404, 'http_404', 'Crewly Apps request failed (404).');
      return base(method, p, opts);
    });
    const out = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(cards.postToOwnerDm).not.toHaveBeenCalled();
    expect(cards.postReply).toHaveBeenCalledWith('dev-ella', `📱 G · [Open app](https://apps.crewlyai.com/${ID})`);
    expect(out).toMatchObject({ notified: true, card: 'plain', linkError: expect.stringMatching(/Could not mint a signed link/) });
  });

  it.each([
    [{ linkId: 'l1', url: 'https://evil.example/28au74d9cj?k=x' }],
    [{ linkId: 'l1', url: 'https://apps.crewlyai.com/xyzabcdefg?k=x' }],
    [{ linkId: 'l1', url: 'https://apps.crewlyai.com/28au74d9cj' }],
    [{ linkId: 'l 1', url: signed() }],
    [null],
  ])('treats an unusable minted link as a failed mint %#', async (minted) => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => (/\/open-links$/.test(p) && method === 'POST' ? minted : base(method, p, opts)));
    const out = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(cards.postToOwnerDm).not.toHaveBeenCalled();
    expect(out).toMatchObject({ card: 'plain', linkError: expect.stringMatching(/usable open-link/) });
  });

  it('revokes the minted link when the DM does not take the card, then posts the plain card', async () => {
    cards.postToOwnerDm.mockResolvedValueOnce({ ok: false, error: 'dm gone' });
    const out = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('DELETE', `/apps/${ID}/open-links/lnk_1`, { agent: 'dev-ella' });
    expect(cards.postReply).toHaveBeenCalled();
    expect(out).toMatchObject({ notified: true, card: 'plain', linkError: expect.stringMatching(/dm gone/) });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('share: mints and posts without publishing; agent only for its own apps, owner for any (as the recorded agent)', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    const out = await service.share(ID, { ttlDays: '14' }, { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/open-links`, { body: { ttlDays: 14 }, agent: 'dev-ella' });
    expect(request.mock.calls.some(([m, p]) => m === 'POST' && String(p).endsWith('/versions'))).toBe(false);
    expect(out).toMatchObject({ appId: ID, url: `https://apps.crewlyai.com/${ID}`, notified: true, card: 'signed', visibility: 'private', publicRequestPending: false });
    expect(JSON.stringify(out)).not.toContain(TOKEN);

    await expect(service.share(ID, {}, { agentSession: 'dev-bob' })).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    await expect(service.share(ID, { ttlDays: 31 }, { agentSession: 'dev-ella' })).rejects.toMatchObject({ status: 400 });
    await expect(service.share(ID, { ttlDays: 0 }, {})).rejects.toMatchObject({ status: 400 });

    cards.postToOwnerDm.mockClear();
    await service.share(ID, {}, {});
    expect(cards.ownerDm).toHaveBeenLastCalledWith('dev-ella');
    expect(cards.postToOwnerDm).toHaveBeenCalledWith('dev-ella', 'dm-ella', expect.any(String));
  });

  it('share: the card tells the owner about a pending public request', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) =>
      method === 'GET' && p === `/apps/${ID}`
        ? { ...appView(ID), visibility: 'private', publicRequest: { publicRead: ['items'], publicSubmit: ['votes'], note: 'n', requestedBy: 'dev-ella', requestedAt: 't' } }
        : base(method, p, opts),
    );
    const out = await service.share(ID, {}, { agentSession: 'dev-ella' });
    expect(out.publicRequestPending).toBe(true);
    const text = cards.postToOwnerDm.mock.calls[0][2] as string;
    expect(text).toContain('Waiting for you: a request to make this app public');
    expect(text).toContain('read items; submit to votes');
    expect(text).toContain('Open the app to approve or decline it.');
  });

  it('links / revoke: pass through, never a token, ownership enforced', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (method === 'GET' && p.endsWith('/open-links')) {
        return [{ linkId: 'lnk_1', createdAt: 'c', expiresAt: 'e', revokedAt: null, lastUsedAt: null, uses: 2, active: true, createdBy: { kind: 'agent', id: 'dev-ella' }, url: signed(), token: TOKEN }];
      }
      if (method === 'DELETE' && p.endsWith('/open-links')) return { revoked: 3 };
      return base(method, p, opts);
    });
    const who = { agentSession: 'dev-ella' };
    const links = await service.links(ID, who);
    expect(links).toEqual([{ linkId: 'lnk_1', createdAt: 'c', expiresAt: 'e', revokedAt: null, lastUsedAt: null, uses: 2, active: true, createdBy: 'agent:dev-ella' }]);
    expect(JSON.stringify(links)).not.toContain(TOKEN);
    await expect(service.revokeLink(ID, 'lnk_1', who)).resolves.toEqual({ revoked: true });
    expect(request).toHaveBeenLastCalledWith('DELETE', `/apps/${ID}/open-links/lnk_1`, { agent: 'dev-ella' });
    await expect(service.revokeLinks(ID, who)).resolves.toEqual({ revoked: 3 });
    await expect(service.revokeLink(ID, '../x', who)).rejects.toMatchObject({ status: 400 });
    for (const call of [() => service.links(ID, { agentSession: 'team-a-bob' }), () => service.revokeLink(ID, 'lnk_1', { agentSession: 'x' }), () => service.revokeLinks(ID, { agentSession: 'x' })]) {
      await expect(call()).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    }
    await expect(service.links(ID, {})).resolves.toHaveLength(1);
  });
});

describe('P3: public requests', () => {
  const pendingView = { publicRead: ['items', 'stats'], publicSubmit: ['votes'], note: 'poll', requestedBy: 'dev-ella', requestedAt: 't' };

  beforeEach(async () => {
    cards.ownerDm.mockResolvedValue('dm-ella');
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (method === 'POST' && p.endsWith('/visibility-request')) return { visibility: 'private', publicRequest: pendingView };
      if (method === 'DELETE' && p.endsWith('/visibility-request')) return { visibility: 'private', publicRequest: null };
      if (method === 'POST' && p.endsWith('/make-private')) return { visibility: 'private' };
      if (method === 'POST' && p.endsWith('/open-links')) return { linkId: 'lnk_2', url: signed(p.split('/')[2]), expiresAt: 'e' };
      return base(method, p, opts);
    });
  });

  it('records the request, says the owner approves it in the app, and posts the signed card', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella' });
    const out = await service.requestPublic(ID, { publicRead: 'items, stats,items', publicSubmit: ['votes'], note: ' poll ' }, { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/visibility-request`, { body: { publicRead: ['items', 'stats'], publicSubmit: ['votes'], note: 'poll' }, agent: 'dev-ella' });
    expect(out).toMatchObject({ appId: ID, visibility: 'private', publicRequest: pendingView, message: expect.stringMatching(/^Requested: the owner approves it by opening the app\./), notified: true, card: 'signed' });
    expect(cards.postToOwnerDm.mock.calls[0][2]).toContain('read items, stats; submit to votes');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    // Nothing on the agent API path makes an app public.
    expect(request.mock.calls.every(([, p]) => !/make-public|visibility$/.test(String(p)))).toBe(true);
  });

  it('validates collection names and counts', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella' });
    const who = { agentSession: 'dev-ella' };
    await expect(service.requestPublic(ID, { publicRead: ['ok', 'no.dots'] }, who)).rejects.toMatchObject({ status: 400 });
    await expect(service.requestPublic(ID, { publicSubmit: Array.from({ length: 21 }, (_, i) => `c${i}`) }, who)).rejects.toThrow(/at most 20/);
    await expect(service.requestPublic(ID, {}, who)).rejects.toThrow(/at least one collection/);
    await expect(service.requestPublic(ID, { publicRead: ['a'], note: 'x'.repeat(501) }, who)).rejects.toThrow(/note/);
    await expect(service.requestPublic(ID, { publicRead: [1] }, who)).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('cancel and make-private; ownership enforced', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella' });
    const who = { agentSession: 'dev-ella' };
    await expect(service.cancelPublicRequest(ID, who)).resolves.toEqual({ appId: ID, cancelled: true, visibility: 'private' });
    expect(request).toHaveBeenLastCalledWith('DELETE', `/apps/${ID}/visibility-request`, { agent: 'dev-ella' });
    await expect(service.makePrivate(ID, who)).resolves.toEqual({ appId: ID, visibility: 'private' });
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/make-private`, { agent: 'dev-ella' });
    await expect(service.requestPublic(ID, { publicRead: ['a'] }, { agentSession: 'dev-bob' })).rejects.toMatchObject({ status: 403 });
    await expect(service.makePrivate(ID, { agentSession: 'dev-bob' })).rejects.toMatchObject({ status: 403 });
    await expect(service.cancelPublicRequest(ID, { agentSession: 'dev-bob' })).rejects.toMatchObject({ status: 403 });
    await expect(service.makePrivate(ID, {})).resolves.toBeTruthy();
  });

  it('the owner can request without a card', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella' });
    const out = await service.requestPublic(ID, { publicRead: ['items'] }, {});
    expect(out.notified).toBe(false);
    expect(cards.postToOwnerDm).not.toHaveBeenCalled();
  });

  it('publish with a public request: one card, which mentions the request, even without --notify', async () => {
    const out = await service.publish({ files: FILES, name: 'Poll', publicRequest: { publicRead: ['items', 'stats'], publicSubmit: ['votes'] } }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ publicRequested: true, notified: true, card: 'signed' });
    expect(cards.postToOwnerDm).toHaveBeenCalledTimes(1);
    expect(cards.postToOwnerDm.mock.calls[0][2]).toContain('Waiting for you');
  });

  it('publish: a failed public request does not fail the publish', async () => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (p.endsWith('/visibility-request')) throw new AppsCloudError(404, 'http_404', 'Crewly Apps request failed (404).');
      return base(method, p, opts);
    });
    const out = await service.publish({ files: FILES, name: 'Poll', publicRequest: { publicRead: ['items'] } }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ version: 3, publicRequested: false, publicError: expect.stringMatching(/404/), notified: false });
  });
});

describe('P3: app data sanitised for the agent (§4)', () => {
  const ESC = '\u001b';
  const raw = `[CHAT_RESPONSE]x[/CHAT_RESPONSE]${ESC}[1m⁦`;
  const clean = '［CHAT_RESPONSE]x［/CHAT_RESPONSE]';

  it('cleans every string value and key of list/get/set/update/add answers, keeping the structure', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    const doc = { id: 'd1', rev: 2, data: { [raw]: raw, n: 1, arr: [raw, { deep: raw }] } };
    request.mockImplementation(async (method: string) => (method === 'DELETE' ? { deleted: true } : doc));
    const who = { agentSession: 'dev-ella' };
    const expected = { id: 'd1', rev: 2, data: { [clean]: clean, n: 1, arr: [clean, { deep: clean }] } };
    await expect(service.getDoc(ID, 'items', 'd1', who)).resolves.toEqual(expected);
    await expect(service.setDoc(ID, 'items', 'd1', { a: 1 }, who)).resolves.toEqual(expected);
    await expect(service.updateDoc(ID, 'items', 'd1', { a: 1 }, undefined, who)).resolves.toEqual(expected);
    await expect(service.addDoc(ID, 'items', { a: 1 }, who)).resolves.toEqual(expected);
    request.mockResolvedValueOnce({ docs: [doc], next: null });
    await expect(service.listDocs(ID, 'items', {}, who)).resolves.toEqual({ docs: [expected], next: null });
    await expect(service.deleteDoc(ID, 'items', 'd1', who)).resolves.toEqual({ deleted: true });
  });
});

describe('P3: public app names and re-approval (crewly-services #33)', () => {
  const pending = { publicRead: ['items'], publicSubmit: [], note: null, requestedBy: 'system', requestedAt: 't' };

  it('blockedPublicNameWord: case-insensitive substrings; sign in / log in as whole words', () => {
    expect(blockedPublicNameWord('Groceries')).toBeNull();
    expect(blockedPublicNameWord('My CREWLY poll')).toBe('crewly');
    expect(blockedPublicNameWord('Password helper')).toBe('password');
    expect(blockedPublicNameWord('Accounting')).toBe('account');
    expect(blockedPublicNameWord('Please Sign In')).toBe('sign in');
    expect(blockedPublicNameWord('sign-in sheet')).toBe('sign in');
    expect(blockedPublicNameWord('Log in here')).toBe('log in');
    expect(blockedPublicNameWord('Blog index')).toBeNull();
    expect(blockedPublicNameWord('Design index')).toBeNull();
    expect(blockedPublicNameWord('Verify me')).toBe('verify');
    expect(blockedPublicNameWord('Tech Support desk')).toBe('support');
    expect(blockedPublicNameWord('Security')).toBe('security');
  });

  it('refuses a public request or a publish --public whose app name Cloud would refuse, before creating anything', async () => {
    await expect(
      service.publish({ files: FILES, name: 'Crewly Login', publicRequest: { publicRead: ['items'] } }, { agentSession: 'dev-ella' }),
    ).rejects.toMatchObject({ status: 400, code: 'validation', message: expect.stringMatching(/may not contain "crewly"/) });
    await expect(
      service.publish({ files: FILES, source: '/w/password-reset', publicRequest: { publicRead: ['items'] } }, { agentSession: 'dev-ella' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();

    // Without --public the name is fine.
    await expect(service.publish({ files: FILES, name: 'Crewly Login' }, { agentSession: 'dev-ella' })).resolves.toMatchObject({ created: true });

    // requestPublic checks the app's current name in Cloud.
    await registry.upsert(ID2, { name: 'x', agentSession: 'dev-ella' });
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) =>
      method === 'GET' && p === `/apps/${ID2}` ? appView(ID2, 'Account settings') : base(method, p, opts),
    );
    await expect(service.requestPublic(ID2, { publicRead: ['items'] }, { agentSession: 'dev-ella' })).rejects.toThrow(/may not contain "account"/);
    expect(request.mock.calls.some(([m, p]) => m === 'POST' && String(p).endsWith('/visibility-request'))).toBe(false);
  });

  it('publish of a public app reports publicPaused when Cloud took it private pending re-approval', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella', source: '/w/poll' });
    let published = false;
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (method === 'GET' && p === `/apps/${ID}`) {
        return published ? { ...appView(ID, 'Poll'), visibility: 'private', publicRequest: pending } : { ...appView(ID, 'Poll'), visibility: 'public', publicRequest: null };
      }
      if (method === 'POST' && p.endsWith('/versions')) published = true;
      return base(method, p, opts);
    });
    const out = await service.publish({ files: FILES, source: '/w/poll' }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ publicPaused: true, publicPausedMessage: PUBLIC_PAUSED_MESSAGE });
    expect(PUBLIC_PAUSED_MESSAGE).toMatch(/re-approves/);
  });

  it('publish of a private app does not re-read it or report publicPaused', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella', source: '/w/poll' });
    const out = await service.publish({ files: FILES, source: '/w/poll' }, { agentSession: 'dev-ella' });
    expect(out).not.toHaveProperty('publicPaused');
    expect(request.mock.calls.filter(([m, p]) => m === 'GET' && p === `/apps/${ID}`)).toHaveLength(1);
  });

  it('rollback of a public app reports publicPaused', async () => {
    await registry.upsert(ID, { name: 'Poll', agentSession: 'dev-ella' });
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (method: string, p: string, opts?: unknown) => {
      if (method === 'GET' && p === `/apps/${ID}`) return { ...appView(ID, 'Poll'), visibility: 'public', publicRequest: null };
      if (method === 'POST' && p.endsWith('/rollback')) return { ...appView(ID, 'Poll', 2), visibility: 'private', publicRequest: pending };
      return base(method, p, opts);
    });
    await expect(service.rollback(ID, 2, { agentSession: 'dev-ella' })).resolves.toMatchObject({ currentVersion: 2, publicPaused: true, publicPausedMessage: PUBLIC_PAUSED_MESSAGE });
  });
});

describe('P3 helpers', () => {
  it('requireTtlDays', () => {
    expect(requireTtlDays(undefined)).toBeUndefined();
    expect(requireTtlDays('')).toBeUndefined();
    expect(requireTtlDays('7')).toBe(7);
    expect(requireTtlDays(30)).toBe(30);
    expect(() => requireTtlDays(1.5)).toThrow();
    expect(() => requireTtlDays('abc')).toThrow();
  });

  it('requireCollectionList accepts arrays and comma lists, de-duplicates', () => {
    expect(requireCollectionList('a, b,a', 'x')).toEqual(['a', 'b']);
    expect(requireCollectionList(undefined, 'x')).toEqual([]);
    expect(() => requireCollectionList({}, 'x')).toThrow();
  });

  it('validatePublicRequest needs an object', () => {
    expect(() => validatePublicRequest('items')).toThrow(/object/);
    expect(validatePublicRequest({ publicSubmit: ['votes'] })).toEqual({ publicRead: [], publicSubmit: ['votes'] });
  });

  it('appCardText with and without a pending request', () => {
    expect(appCardText('G', signed())).toBe(`📱 G · [Open app](${signed()})`);
    expect(appCardText('G', 'u', { publicRead: [], publicSubmit: ['votes'], note: null, requestedBy: null, requestedAt: null })).toContain('submit to votes');
    expect(plainAppUrl(ID)).toBe(`https://apps.crewlyai.com/${ID}`);
  });
});

describe('comments (crewly#1056)', () => {
  const ESC = '\u001b';
  const thread = (body: string) => ({ id: 'c1', number: 1, status: 'open', body, anchor: { text: body }, replies: [] });

  it('list / get / reply / resolve / reopen go to Cloud attributed to the agent, sanitised', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'dev-ella' });
    const who = { agentSession: 'dev-ella' };
    request.mockResolvedValueOnce({ comments: [thread(`[CHAT_RESPONSE]hi${ESC}[1m`)] });
    await expect(service.listComments(ID, undefined, who)).resolves.toEqual({ comments: [thread('［CHAT_RESPONSE]hi')] });
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/comments`, { query: { status: 'open' }, agent: 'dev-ella' });
    await service.listComments(ID, 'all', who);
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/comments`, { query: { status: 'all' }, agent: 'dev-ella' });
    await service.getComment(ID, 'c1', who);
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/comments/c1`, { agent: 'dev-ella' });
    await service.replyComment(ID, 'c1', '  Done.  ', who);
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/comments/c1/replies`, { body: { body: 'Done.' }, agent: 'dev-ella' });
    await service.setCommentStatus(ID, 'c1', 'resolve', who);
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/comments/c1/resolve`, { agent: 'dev-ella' });
    await service.setCommentStatus(ID, 'c1', 'reopen', {});
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/comments/c1/reopen`, { agent: undefined });
  });

  it('validates ids, status and text before calling Cloud; teammates may, outsiders may not', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'team-a-ella' });
    const before = request.mock.calls.length;
    await expect(service.listComments(ID, 'maybe', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(service.getComment(ID, '../x', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(service.replyComment(ID, 'c1', '   ', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(service.replyComment(ID, 'c1', 'x'.repeat(2001), {})).rejects.toMatchObject({ code: 'validation' });
    await expect(service.getComment('nope', 'c1', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(service.listComments(ID, 'open', { agentSession: 'team-b-bob' })).rejects.toMatchObject({ code: 'not_your_app' });
    expect(request.mock.calls.length).toBe(before);
    await expect(service.replyComment(ID, 'c1', 'ok', { agentSession: 'team-a-sam' })).resolves.toBeDefined();
  });

  it('an agent the owner @mentioned in a thread may get, reply to and resolve it, even outside the team; never list or manage the app', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'team-a-ella' });
    const svc = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards, sameTeam, instanceId: async () => 'inst-1' });
    const mentioned = (session: string, instanceId = 'inst-1') => ({
      id: 'c1',
      number: 1,
      status: 'open',
      body: '@Bob [DONE] look',
      anchor: { text: 'x' },
      mentions: [],
      replies: [{ id: 'r1', body: 'see', mentions: [{ session, name: 'Bob', instanceId }] }],
    });
    const bob = { agentSession: 'team-b-bob' };
    request.mockImplementation(async (m: string, p: string, opts?: unknown) => (m === 'GET' && p.endsWith('/comments/c1') ? mentioned('team-b-bob') : { ok: true, m, p, opts }));

    // get: the thread fetched for the check is returned, sanitised.
    await expect(svc.getComment(ID, 'c1', bob)).resolves.toMatchObject({ body: '@Bob ［DONE] look' });
    await svc.replyComment(ID, 'c1', 'On it', bob);
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/comments/c1/replies`, { body: { body: 'On it' }, agent: 'team-b-bob' });
    await svc.setCommentStatus(ID, 'c1', 'resolve', bob);
    expect(request).toHaveBeenLastCalledWith('POST', `/apps/${ID}/comments/c1/resolve`, { agent: 'team-b-bob' });
    // Listing and the app itself stay team-only.
    await expect(svc.listComments(ID, 'open', bob)).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(svc.versions(ID, bob)).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(svc.listDocs(ID, 'items', {}, bob)).rejects.toMatchObject({ code: 'not_your_app' });
    // Not mentioned, or mentioned on another machine: refused, and nothing is written.
    const writes = () => request.mock.calls.filter(([m]) => m === 'POST').length;
    const w = writes();
    await expect(svc.replyComment(ID, 'c1', 'hi', { agentSession: 'team-c-cat' })).rejects.toMatchObject({ code: 'not_your_app', message: expect.stringMatching(/did not @mention you/) });
    request.mockImplementation(async (m: string, p: string) => (m === 'GET' && p.endsWith('/comments/c1') ? mentioned('team-b-bob', 'inst-2') : { ok: true }));
    await expect(svc.setCommentStatus(ID, 'c1', 'resolve', bob)).rejects.toMatchObject({ code: 'not_your_app' });
    expect(writes()).toBe(w);
    // An app this machine never published (cross-machine mention): same rule.
    request.mockImplementation(async (m: string, p: string) => (m === 'GET' && p.endsWith('/comments/c1') ? mentioned('team-b-bob') : { ok: true }));
    await expect(svc.replyComment(ID2, 'c1', 'On it', bob)).resolves.toEqual({ ok: true });
  });

  it('threadMentions: comment or reply, this instance only (or any when unknown)', () => {
    const t = { mentions: [{ session: 'a', instanceId: 'i1' }], replies: [{ mentions: [{ session: 'b' }] }] };
    expect(threadMentions(t, 'a', 'i1')).toBe(true);
    expect(threadMentions(t, 'a', 'i2')).toBe(false);
    expect(threadMentions(t, 'a', null)).toBe(true);
    expect(threadMentions(t, 'b', 'i9')).toBe(true);
    expect(threadMentions(t, 'c', 'i1')).toBe(false);
    expect(threadMentions(null, 'a', 'i1')).toBe(false);
  });

  it('a publish pushes the roster in the background (a failure never fails the publish)', async () => {
    const pushIfChanged = jest.fn().mockRejectedValue(new Error('offline'));
    const svc = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards, roster: { pushIfChanged } });
    await expect(svc.publish({ files: FILES, name: 'Groceries', source: '/w/g' }, { agentSession: 'dev-ella' })).resolves.toMatchObject({ appId: ID });
    expect(pushIfChanged).toHaveBeenCalledTimes(1);
  });
});

describe('AppsService.transfer', () => {
  const MILO = 'edu-game-milo-13e8d3ca';
  const ATLAS = 'think-tank-atlas-b4e166f6';
  let directory: { member: jest.Mock; leadsTeamOf: jest.Mock };
  let notifyAgent: jest.Mock;
  let svc: AppsService;

  beforeEach(async () => {
    directory = {
      member: jest.fn(async (s: string) => (s === MILO || s === ATLAS || s === 'think-tank-lead-aaaaaaaa' ? { session: s, name: s, team: 'T' } : null)),
      leadsTeamOf: jest.fn(async (lead: string) => lead === 'think-tank-lead-aaaaaaaa'),
    };
    notifyAgent = jest.fn().mockResolvedValue(true);
    svc = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards, sameTeam, directory, notifyAgent });
    await registry.upsert(ID, { name: 'AZ', agentSession: ATLAS, source: '/w/az' });
  });

  it('the owner transfers: Cloud first, then the registry; both agents are told how to publish', async () => {
    const r = await svc.transfer(ID, MILO, {});
    expect(r).toMatchObject({ appId: ID, publisher: MILO, previous: ATLAS, changed: true, notified: [MILO, ATLAS] });
    expect(request).toHaveBeenCalledWith('PUT', `/apps/${ID}/publisher`, { body: { session: MILO }, agent: undefined });
    expect((await registry.get(ID))!.agentSession).toBe(MILO);
    const [toNew, toOld] = notifyAgent.mock.calls;
    expect(toNew).toEqual([MILO, expect.stringContaining(`publish-app --app ${ID} --dir <your project directory>`), true]);
    expect(toNew[1]).toContain('/w/az');
    expect(toOld).toEqual([ATLAS, expect.stringContaining(`transferred to ${MILO}`), false]);
  });

  it('after a transfer the old team loses manage rights and the new team gains them', async () => {
    await svc.transfer(ID, MILO, {});
    await expect(svc.assertPublisher(ID, { agentSession: ATLAS })).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(svc.assertPublisher(ID, { agentSession: MILO })).resolves.toBeUndefined();
    await expect(svc.assertPublisher(ID, {})).resolves.toBeUndefined();
  });

  it('the current publisher, the lead of its team and the orchestrator may transfer; other agents may not', async () => {
    await expect(svc.transfer(ID, MILO, { agentSession: 'edu-game-iva-11111111' })).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    await expect(svc.transfer(ID, MILO, { agentSession: 'think-tank-lead-aaaaaaaa' })).resolves.toMatchObject({ changed: true });
    await registry.setPublisher(ID, ATLAS);
    await expect(svc.transfer(ID, MILO, { agentSession: ATLAS })).resolves.toMatchObject({ changed: true });
    await registry.setPublisher(ID, ATLAS);
    await expect(svc.transfer(ID, MILO, { agentSession: 'crewly-orc' })).resolves.toMatchObject({ changed: true });
  });

  it('does not tell the agent that made the transfer', async () => {
    const r = await svc.transfer(ID, MILO, { agentSession: ATLAS });
    expect(r.notified).toEqual([MILO]);
  });

  it('refuses a target that is not a member of an active team (nothing changes)', async () => {
    await expect(svc.transfer(ID, 'nobody-1', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.transfer(ID, 'crewly-orc', {})).rejects.toMatchObject({ code: 'validation' });
    await expect(svc.transfer(ID, 12, {})).rejects.toMatchObject({ code: 'validation' });
    expect((await registry.get(ID))!.agentSession).toBe(ATLAS);
    expect(request).not.toHaveBeenCalledWith('PUT', expect.anything(), expect.anything());
  });

  it('transferring to the current publisher changes and tells no one', async () => {
    const r = await svc.transfer(ID, ATLAS, {});
    expect(r).toMatchObject({ changed: false, notified: [] });
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it('keeps the registry unchanged when Cloud refuses', async () => {
    request.mockRejectedValueOnce(new AppsCloudError(404, 'not_found', 'App not found.'));
    await expect(svc.transfer(ID, MILO, {})).rejects.toMatchObject({ status: 404 });
    expect((await registry.get(ID))!.agentSession).toBe(ATLAS);
    expect(notifyAgent).not.toHaveBeenCalled();
  });

  it('an unknown or deleted app is 404; a failing notifier does not fail the transfer', async () => {
    await expect(svc.transfer(ID2, MILO, {})).rejects.toMatchObject({ status: 404 });
    notifyAgent.mockRejectedValue(new Error('down'));
    await expect(svc.transfer(ID, MILO, {})).resolves.toMatchObject({ changed: true, notified: [] });
    await registry.markDeleted(ID);
    await expect(svc.transfer(ID, ATLAS, {})).rejects.toMatchObject({ status: 404 });
  });

  it('without a directory every transfer is refused', async () => {
    const bare = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards });
    await expect(bare.transfer(ID, MILO, {})).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('AppsService collaborators (the owner let another team work in an app)', () => {
  const ELLA = 'crewly-marketing-ella-e6a6b8ea';
  const BOB = 'crewly-sales-bob-1';
  let list: Array<{ kind: string; who: string; instanceId: string }>;
  let svc: AppsService;

  beforeEach(() => {
    list = [{ kind: 'team', who: 'Marketing', instanceId: 'inst-2' }];
    request.mockImplementation(async (m: string, p: string) => {
      if (m === 'GET' && p === `/apps/${ID}/collaborators`) return { collaborators: list, enforced: true };
      return { docs: [], next: null };
    });
    const teamOf: Record<string, string> = { [ELLA]: 'Marketing', [BOB]: 'Sales' };
    svc = new AppsService({
      client: { request } as unknown as AppsCloudClient,
      registry,
      cards,
      sameTeam: async () => false,
      directory: { member: async (s) => (teamOf[s] ? { session: s, name: s, team: teamOf[s] } : null), leadsTeamOf: async () => false },
      instanceId: async () => 'inst-2',
    });
  });

  it('a collaborator team member reads and writes data of an app that is NOT in this machine\'s registry (published elsewhere)', async () => {
    expect(await registry.get(ID)).toBeFalsy();
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).resolves.toBeDefined();
    await expect(svc.addDoc(ID, 'items', { qty: 1 }, { agentSession: ELLA })).resolves.toBeDefined();
  });

  it('NEGATIVE: a team that is not listed is still refused', async () => {
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: BOB })).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(svc.addDoc(ID, 'items', { qty: 1 }, { agentSession: BOB })).rejects.toMatchObject({ code: 'not_your_app' });
  });

  it('NEGATIVE: an entry for another instance does not match, and a single-agent entry covers only that agent', async () => {
    list = [{ kind: 'team', who: 'Marketing', instanceId: 'inst-9' }];
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
    list = [{ kind: 'agent', who: BOB, instanceId: 'inst-2' }];
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: BOB })).resolves.toBeDefined();
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
  });

  it('removing the collaborator takes effect on the very next call (no cache)', async () => {
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).resolves.toBeDefined();
    list = [];
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
  });

  it('fails closed when Cloud is down or does not know the app', async () => {
    request.mockRejectedValue(Object.assign(new Error('x'), { status: 404, code: 'not_found' }));
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
    request.mockRejectedValue(Object.assign(new Error('x'), { status: 502, code: 'network' }));
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
  });

  it('data only: a collaborator cannot republish, roll back, or publish with an explicit --app id', async () => {
    await expect(svc.assertPublisher(ID, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(svc.rollback(ID, 1, { agentSession: ELLA })).rejects.toMatchObject({ code: 'not_your_app' });
    await expect(svc.publish({ files: FILES, appId: ID }, { agentSession: ELLA })).rejects.toMatchObject({ status: 403, code: 'not_your_app' });
    expect(request.mock.calls.filter((c) => c[0] === 'POST')).toHaveLength(0);
  });

  it('the owner and the publisher\'s team need no Cloud lookup', async () => {
    await registry.upsert(ID, { name: 'G', agentSession: 'pub-1' });
    await svc.assertDataAccess(ID, {});
    await svc.assertDataAccess(ID, { agentSession: 'pub-1' });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('AppsService owner (crewly-services apps/SPEC.md §15)', () => {
  const ELLA = 'crewly-info-ella-e6a6b8ea';
  const KAI = 'crewly-dev-kai-11111111';
  const targets: OwnerTargets = {
    agent: async (ref) => (['kai', KAI].includes(ref.toLowerCase()) ? { session: KAI, name: 'Kai' } : null),
    team: async (ref) => (ref.toLowerCase() === 'dev' ? { id: 't-dev', name: 'Dev' } : null),
    channel: async (ref) => (['#daily-brief', 'daily-brief', 'huddle-1'].includes(ref) ? { id: 'huddle-1', name: 'daily-brief' } : null),
  };
  let pushIfChanged: jest.Mock;
  let svc: AppsService;

  beforeEach(() => {
    pushIfChanged = jest.fn().mockResolvedValue(true);
    request.mockImplementation(async (m: string, p: string, opts?: { body?: Record<string, unknown> }) => {
      if (p === `/apps/${ID}/owner` && m === 'PUT') return { appId: ID, owner: { kind: opts?.body?.['kind'], explicit: true }, previous: null };
      if (p === `/apps/${ID}/owner`) return { appId: ID, owner: { kind: 'agent', explicit: false, session: ELLA, name: 'Ella', instanceId: 'inst-1' } };
      return {};
    });
    svc = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, cards, instanceId: async () => 'inst-1', ownerTargets: targets, roster: { pushIfChanged } });
  });

  it('parseOwnerSpec: agent / team / channel / #name / default; anything else is a validation error', () => {
    expect(parseOwnerSpec('channel:#daily-brief')).toEqual({ kind: 'channel', ref: '#daily-brief' });
    expect(parseOwnerSpec('#daily-brief')).toEqual({ kind: 'channel', ref: '#daily-brief' });
    expect(parseOwnerSpec({ owner: 'Team:Dev' })).toEqual({ kind: 'team', ref: 'Dev' });
    expect(parseOwnerSpec('agent:Kai')).toEqual({ kind: 'agent', ref: 'Kai' });
    expect(parseOwnerSpec('DEFAULT')).toEqual({ kind: 'default' });
    for (const bad of ['', 'room:x', 'channel:', 42, null, { owner: 1 }]) expect(() => parseOwnerSpec(bad)).toThrow(AppsCloudError);
  });

  it('an agent sets a channel owner: resolved here, bound to this instance, roster pushed first, called as that agent', async () => {
    await svc.setOwner(ID, { owner: 'channel:#daily-brief' }, { agentSession: ELLA });
    expect(pushIfChanged).toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('PUT', `/apps/${ID}/owner`, { body: { kind: 'channel', channelId: 'huddle-1', instanceId: 'inst-1' }, agent: ELLA });
  });

  it('the owner sets a team; default needs no lookup; unknown names are 400 before Cloud is called', async () => {
    await svc.setOwner(ID, 'team:dev', {});
    expect(request).toHaveBeenLastCalledWith('PUT', `/apps/${ID}/owner`, { body: { kind: 'team', teamId: 't-dev', instanceId: 'inst-1' }, asOwner: true });
    await svc.setOwner(ID, 'default', { agentSession: ELLA });
    expect(request).toHaveBeenLastCalledWith('PUT', `/apps/${ID}/owner`, { body: { kind: 'default' }, agent: ELLA });
    request.mockClear();
    await expect(svc.setOwner(ID, 'channel:#nope', { agentSession: ELLA })).rejects.toMatchObject({ status: 400 });
    await expect(svc.setOwner(ID, 'agent:nobody', {})).rejects.toMatchObject({ status: 400 });
    expect(request).not.toHaveBeenCalled();
  });

  it('a refusal from Cloud (not an owner agent) reaches the caller unchanged', async () => {
    request.mockRejectedValueOnce(new AppsCloudError(403, 'forbidden', "Only the app's owner agents can change who owns it."));
    await expect(svc.setOwner(ID, 'agent:kai', { agentSession: 'someone-else-1' })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('getOwner asks Cloud as the caller', async () => {
    expect((await svc.getOwner(ID, { agentSession: KAI })).owner).toMatchObject({ kind: 'agent', session: ELLA });
    expect(request).toHaveBeenLastCalledWith('GET', `/apps/${ID}/owner`, { agent: KAI });
  });

  it('an owner agent adds an agent collaborator by name (Cloud decides whether the caller may)', async () => {
    await svc.addAgentCollaborator(ID, 'Kai', { agentSession: ELLA });
    expect(request).toHaveBeenLastCalledWith('PUT', `/apps/${ID}/collaborators`, { body: { kind: 'agent', session: KAI, instanceId: 'inst-1' }, agent: ELLA });
    await expect(svc.addAgentCollaborator(ID, 'ghost', { agentSession: ELLA })).rejects.toMatchObject({ status: 400 });
  });

  it('members of the owning team / channel on this instance may use the app\'s data and comments (implicit collaborators)', async () => {
    let owner: Record<string, unknown> = { kind: 'channel', explicit: true, channelId: 'huddle-1', name: '#daily-brief', instanceId: 'inst-1', members: [KAI] };
    request.mockImplementation(async (m: string, p: string) => {
      if (p === `/apps/${ID}/collaborators`) return { collaborators: [], enforced: false, owner };
      return { docs: [], next: null };
    });
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: KAI })).resolves.toBeDefined();
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: 'crewly-x-other-00000000' })).rejects.toMatchObject({ code: 'not_your_app' });
    owner = { ...owner, instanceId: 'inst-9' };
    await expect(svc.listDocs(ID, 'items', {}, { agentSession: KAI })).rejects.toMatchObject({ code: 'not_your_app' });
    expect(isOwnerMember({ kind: 'agent', explicit: true, session: KAI, name: 'Kai', instanceId: 'inst-1' }, KAI, 'inst-1')).toBe(true);
    expect(isOwnerMember(null, KAI, 'inst-1')).toBe(false);
  });
});
