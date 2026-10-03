/**
 * Tests for the signal digest store: ids that survive a reload, update under
 * the lock, copies that cannot leak mutations, and pruning.
 *
 * @module services/signal-digest/signal-digest-store.test
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SIGNAL_DIGEST_CONSTANTS } from '../../constants.js';
import type { SignalDigest } from '../../types/signal-digest.types.js';
import { SignalDigestStore } from './signal-digest-store.js';

const draft = (site = 's', status: 'open' | 'do' = 'open'): Omit<SignalDigest, 'id' | 'createdAt' | 'updatedAt'> => ({
  site,
  asker: 'tl-owen',
  items: [{ n: 1, key: 'k', source: 'gsc', signal: 's', proposal: 'p', expectedEffect: 'e', effort: 'S', status }],
});

describe('SignalDigestStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signal-digests-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('assigns SD-1, SD-2 and keeps counting after a reload', async () => {
    const store = SignalDigestStore.inHome(dir);
    expect((await store.create(draft())).id).toBe('SD-1');
    expect((await store.create(draft())).id).toBe('SD-2');
    const again = SignalDigestStore.inHome(dir);
    expect((await again.list()).map((d) => d.id)).toEqual(expect.arrayContaining(['SD-1', 'SD-2']));
    expect((await again.create(draft())).id).toBe('SD-3');
  });

  it('update changes a copy under the lock; null leaves it alone; returned copies are independent', async () => {
    let t = Date.parse('2026-10-03T00:00:00Z');
    const store = new SignalDigestStore(path.join(dir, 'x.json'), () => new Date(t));
    const d = await store.create(draft());
    d.items[0].status = 'skip';
    expect((await store.get(d.id))?.items[0].status).toBe('open');
    t += 1000;
    const updated = await store.update(d.id, (cur) => {
      cur.items[0].status = 'do';
      return cur;
    });
    expect(updated?.items[0].status).toBe('do');
    expect(updated?.updatedAt).toBe(new Date(t).toISOString());
    expect(await store.update(d.id, () => null)).toBeNull();
    expect(await store.update('SD-99', (cur) => cur)).toBeNull();
  });

  it('list filters and sorts newest first', async () => {
    let t = Date.parse('2026-10-01T00:00:00Z');
    const store = new SignalDigestStore(path.join(dir, 'x.json'), () => new Date((t += 1000)));
    await store.create(draft('a'));
    await store.create(draft('b'));
    await store.create(draft('a'));
    expect((await store.list()).map((d) => d.id)).toEqual(['SD-3', 'SD-2', 'SD-1']);
    expect((await store.list((d) => d.site === 'a')).map((d) => d.id)).toEqual(['SD-3', 'SD-1']);
  });

  it('prune drops old settled digests and keeps old ones still open', async () => {
    let t = Date.parse('2026-01-01T00:00:00Z');
    const store = new SignalDigestStore(path.join(dir, 'x.json'), () => new Date(t));
    await store.create(draft('a', 'do'));
    await store.create(draft('b', 'open'));
    t += SIGNAL_DIGEST_CONSTANTS.KEEP_MS + 1;
    await store.create(draft('c', 'do'));
    expect(await store.prune()).toBe(1);
    expect((await store.list()).map((d) => d.site).sort()).toEqual(['b', 'c']);
  });
});
