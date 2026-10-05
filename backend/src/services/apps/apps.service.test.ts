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
  validatePublicRequest,
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
    // A teammate may use the data but not manage the app.
    await expect(service.versions(ID, { agentSession: 'team-a-bob' })).rejects.toMatchObject({ code: 'not_your_app' });
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
});
