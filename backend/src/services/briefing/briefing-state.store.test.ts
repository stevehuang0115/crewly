/**
 * Tests for the briefing state file.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BriefingStateStore } from './briefing-state.store.js';

describe('BriefingStateStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-store-'));
    file = path.join(dir, 'briefing-state.json');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('starts empty, then keeps what is written (mode 0600)', async () => {
    const store = new BriefingStateStore(file);
    expect(await store.read()).toEqual({ version: 1, items: {} });
    await store.update('d:D-1', () => ({ hiddenUntil: '2026-10-09T00:00:00.000Z' }));
    expect((await new BriefingStateStore(file).read()).items['d:D-1']).toEqual({ hiddenUntil: '2026-10-09T00:00:00.000Z' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('forgets an item when the updater returns null or an empty state', async () => {
    const store = new BriefingStateStore(file);
    await store.update('a', () => ({ later: true }));
    await store.update('a', () => null);
    await store.update('b', () => ({}));
    expect((await store.read()).items).toEqual({});
  });

  it('serialises concurrent updates', async () => {
    const store = new BriefingStateStore(file);
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.update(id, () => ({ later: true }))));
    expect(Object.keys((await store.read()).items).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('prunes items that are gone', async () => {
    const store = new BriefingStateStore(file);
    await store.update('keep', () => ({ later: true }));
    await store.update('gone', () => ({ later: true }));
    await store.prune(new Set(['keep']));
    expect(Object.keys((await store.read()).items)).toEqual(['keep']);
  });

  it('treats an unreadable file as empty', async () => {
    fs.writeFileSync(file, '{not json');
    expect(await new BriefingStateStore(file).read()).toEqual({ version: 1, items: {} });
  });
});
