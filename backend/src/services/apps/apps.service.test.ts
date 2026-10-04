/**
 * Tests for AppsService — publish create vs reuse vs adopt, deleted app
 * replaced, rollback, notify card, data pass-through and validation.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppsCloudError, type AppsCloudClient } from './apps-cloud.client.js';
import { AppsRegistryService } from './apps-registry.service.js';
import { AppsService, appCardText, requireAppId } from './apps.service.js';

const ID = '28au74d9cj';
const ID2 = 'xyzabcdefg';
const FILES = [{ path: 'index.html', contentBase64: Buffer.from('<h1>x</h1>').toString('base64') }];

let home: string;
let registry: AppsRegistryService;
let request: jest.Mock;
let notifyCard: jest.Mock;
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
  notifyCard = jest.fn().mockResolvedValue({ ok: true });
  service = new AppsService({ client: { request } as unknown as AppsCloudClient, registry, notifyCard });
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

  it('adopts an explicit app id made elsewhere; the poller starts from the head', async () => {
    const out = await service.publish({ files: FILES, appId: ID2 }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ appId: ID2, created: false });
    expect(await registry.get(ID2)).toMatchObject({ agentSession: 'dev-ella', cursor: null });
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

  it('posts the Open-app card when asked, as the agent', async () => {
    const out = await service.publish({ files: FILES, name: 'Groceries', notify: true }, { agentSession: 'dev-ella' });
    expect(notifyCard).toHaveBeenCalledWith('dev-ella', `📱 Groceries · [Open app](https://apps.crewlyai.com/${ID})`);
    expect(out.notified).toBe(true);
  });

  it('reports a card that could not be delivered without failing the publish', async () => {
    notifyCard.mockResolvedValueOnce({ ok: false, error: 'no conversation' });
    const out = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(out).toMatchObject({ notified: false, notifyError: 'no conversation', version: 3 });

    notifyCard.mockRejectedValueOnce(new Error('slack down'));
    const out2 = await service.publish({ files: FILES, name: 'G', notify: true }, { agentSession: 'dev-ella' });
    expect(out2).toMatchObject({ notified: false, notifyError: 'slack down' });

    const owner = await service.publish({ files: FILES, appId: ID, notify: true }, {});
    expect(owner.notified).toBe(false);
    expect(owner.notifyError).toMatch(/Only an agent/);
  });

  it.each([
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
    await registry.upsert(ID, { name: 'G', currentVersion: 3 });
    const app = await service.rollback(ID, '2', { agentSession: 'dev-ella' });
    expect(request).toHaveBeenCalledWith('POST', `/apps/${ID}/rollback`, { body: { version: 2 }, agent: 'dev-ella' });
    expect(app.currentVersion).toBe(2);
    expect((await registry.get(ID))?.currentVersion).toBe(2);
    await expect(service.rollback(ID, 0, {})).rejects.toMatchObject({ status: 400 });
  });

  it('lists local apps without the cursor', async () => {
    await registry.upsert(ID, { name: 'G', cursor: 9 });
    const list = await service.list();
    expect(list[0]).toMatchObject({ appId: ID, name: 'G' });
    expect(list[0]).not.toHaveProperty('cursor');
  });

  it('passes data calls through with the agent attribution', async () => {
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

  it('validates ids, collections and data before calling Cloud', () => {
    expect(() => service.getDoc(ID, 'bad/coll', 'x', {})).toThrow(/collection/);
    expect(() => service.getDoc(ID, 'items', 'bad id', {})).toThrow(/docId/);
    expect(() => service.setDoc(ID, 'items', 'x', [1], {})).toThrow(/JSON object/);
    expect(() => service.updateDoc(ID, 'items', 'x', {}, 'abc', {})).toThrow(/ifRev/);
    expect(() => service.listDocs(ID, 'items', { limit: 9999 }, {})).toThrow(/limit/);
    expect(() => service.addDoc('nope', 'items', {}, {})).toThrow(/appId/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('appCardText cleans the name of link syntax', () => {
    expect(appCardText('My [app](evil)\n', ID)).toBe(`📱 My app evil · [Open app](https://apps.crewlyai.com/${ID})`);
    expect(appCardText('', ID)).toBe(`📱 App · [Open app](https://apps.crewlyai.com/${ID})`);
  });

  it('requireAppId accepts only P1-shaped ids', () => {
    expect(requireAppId(ID)).toBe(ID);
    expect(() => requireAppId('28au74d9c1')).toThrow();
    expect(() => requireAppId(undefined)).toThrow();
  });
});
