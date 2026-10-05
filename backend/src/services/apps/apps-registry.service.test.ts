/**
 * Tests for AppsRegistryService — lookup order, upsert semantics, cursor and
 * deletion, persistence across instances.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AppsRegistryService } from './apps-registry.service.js';

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-registry-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('AppsRegistryService', () => {
  it('starts empty and persists entries to <home>/apps/registry.json', async () => {
    const reg = new AppsRegistryService(home);
    expect(await reg.list()).toEqual([]);

    await reg.upsert('aaaaaaaaaa', { name: 'Groceries', agentSession: 'dev-ella', source: '/w/groceries', currentVersion: 1, cursor: 0 });

    const raw = JSON.parse(await fs.readFile(path.join(home, 'apps', 'registry.json'), 'utf8'));
    expect(raw.apps.aaaaaaaaaa).toMatchObject({ name: 'Groceries', agentSession: 'dev-ella', url: 'https://apps.crewlyai.com/aaaaaaaaaa', cursor: 0 });
    expect(await new AppsRegistryService(home).get('aaaaaaaaaa')).toMatchObject({ name: 'Groceries' });
  });

  it('finds by explicit id, then same agent + source, then same agent + name', async () => {
    const reg = new AppsRegistryService(home);
    await reg.upsert('aaaaaaaaaa', { name: 'Groceries', agentSession: 'dev-ella', source: '/w/groceries' });
    await reg.upsert('bbbbbbbbbb', { name: 'Timer', agentSession: 'dev-ella', source: '/w/timer.html' });
    await reg.upsert('cccccccccc', { name: 'Groceries', agentSession: 'dev-bob', source: '/w/groceries' });

    expect((await reg.find({ appId: 'cccccccccc', agentSession: 'dev-ella' }))?.appId).toBe('cccccccccc');
    expect((await reg.find({ agentSession: 'dev-ella', source: '/w/timer.html', name: 'Groceries' }))?.appId).toBe('bbbbbbbbbb');
    expect((await reg.find({ agentSession: 'dev-ella', source: '/other', name: ' groceries ' }))?.appId).toBe('aaaaaaaaaa');
    expect((await reg.find({ agentSession: 'dev-bob', name: 'Timer' }))).toBeNull();
    expect((await reg.find({ agentSession: null, name: 'Groceries' }))).toBeNull();
    expect((await reg.find({ appId: 'zzzzzzzzzz' }))).toBeNull();
  });

  it('never matches a deleted app implicitly', async () => {
    const reg = new AppsRegistryService(home);
    await reg.upsert('aaaaaaaaaa', { name: 'Groceries', agentSession: 'dev-ella', source: '/w/g' });
    await reg.markDeleted('aaaaaaaaaa');

    expect(await reg.find({ agentSession: 'dev-ella', source: '/w/g' })).toBeNull();
    expect((await reg.get('aaaaaaaaaa'))?.deleted).toBe(true);
  });

  it('upsert keeps fields that are not given; agentSession null is stored', async () => {
    const reg = new AppsRegistryService(home);
    await reg.upsert('aaaaaaaaaa', { name: 'G', agentSession: 'dev-ella', source: '/s', cursor: 4 });
    const next = await reg.upsert('aaaaaaaaaa', { currentVersion: 2 });
    expect(next).toMatchObject({ name: 'G', agentSession: 'dev-ella', source: '/s', cursor: 4, currentVersion: 2 });

    expect((await reg.upsert('bbbbbbbbbb', { agentSession: null })).agentSession).toBeNull();
  });

  it('setProgress updates known apps only and skips unchanged values', async () => {
    const reg = new AppsRegistryService(home);
    await reg.upsert('aaaaaaaaaa', { name: 'G', cursor: 1 });
    await reg.setProgress('aaaaaaaaaa', 7, []);
    await reg.setProgress('nonexisting', 9, []);
    expect((await reg.get('aaaaaaaaaa'))?.cursor).toBe(7);
    expect(await reg.get('nonexisting')).toBeNull();

    const file = path.join(home, 'apps', 'registry.json');
    const before = (await fs.stat(file)).mtimeMs;
    await new Promise((r) => setTimeout(r, 15));
    await reg.setProgress('aaaaaaaaaa', 7, []);
    expect((await fs.stat(file)).mtimeMs).toBe(before);
  });

  it('setProgress stores the cursor and delivered seqs above it; setLastWake persists per recipient; upsert keeps both', async () => {
    const reg = new AppsRegistryService(home);
    await reg.upsert('aaaaaaaaaa', { name: 'G', cursor: 0 });
    await reg.setProgress('aaaaaaaaaa', 3, [5, 2, 4]);
    await reg.setLastWake('aaaaaaaaaa', 'dev-ella', 1234);
    await reg.upsert('aaaaaaaaaa', { currentVersion: 2 });
    const e = await new AppsRegistryService(home).get('aaaaaaaaaa');
    expect(e).toMatchObject({ cursor: 3, delivered: [4, 5], wakes: { 'dev-ella': 1234 }, currentVersion: 2 });

    await reg.setProgress('aaaaaaaaaa', 5, [4, 5]);
    expect((await reg.get('aaaaaaaaaa'))?.delivered).toBeUndefined();
    await reg.setProgress('missing', 1, []);
    expect(await reg.get('missing')).toBeNull();
  });

  it('setVisitorWakes persists the daily visitor-wake state; upsert keeps it', async () => {
    const reg = new AppsRegistryService(home);
    await reg.upsert('aaaaaaaaaa', { name: 'A' });
    await reg.setVisitorWakes('aaaaaaaaaa', { day: '2026-10-04', count: 20, skipped: 3 });
    await reg.setVisitorWakes('missing000', { day: '2026-10-04', count: 1, skipped: 0 });
    await reg.upsert('aaaaaaaaaa', { currentVersion: 4 });
    const again = new AppsRegistryService(home);
    expect((await again.get('aaaaaaaaaa'))?.visitorWakes).toEqual({ day: '2026-10-04', count: 20, skipped: 3 });
    expect(await again.get('missing000')).toBeNull();
  });

  it('serialises concurrent writes', async () => {
    const reg = new AppsRegistryService(home);
    await Promise.all(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc'].map((id) => reg.upsert(id, { name: id })));
    expect((await new AppsRegistryService(home).list()).map((e) => e.appId).sort()).toEqual(['aaaaaaaaaa', 'bbbbbbbbbb', 'cccccccccc']);
  });

  it('treats a corrupt file as empty', async () => {
    await fs.mkdir(path.join(home, 'apps'), { recursive: true });
    await fs.writeFile(path.join(home, 'apps', 'registry.json'), '{"nope": 1}');
    expect(await new AppsRegistryService(home).list()).toEqual([]);
  });

  it('keeps the @mention inbox position next to the apps, across a restart', async () => {
    const reg = new AppsRegistryService(home);
    expect(await reg.getMentionProgress()).toEqual({ cursor: null, delivered: [] });
    await reg.upsert('aaaaaaaaaa', { name: 'Groceries' });
    await reg.setMentionProgress(3, [7, 5, 2]);
    const again = new AppsRegistryService(home);
    expect(await again.getMentionProgress()).toEqual({ cursor: 3, delivered: [5, 7] });
    expect(await again.get('aaaaaaaaaa')).toMatchObject({ name: 'Groceries' });
    expect((await again.list()).map((e) => e.appId)).toEqual(['aaaaaaaaaa']);
  });
});
