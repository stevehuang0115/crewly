/**
 * Tests for ModelTierStore (crewly#1173).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ModelTierStore } from './model-tier.store.js';

describe('ModelTierStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tier-store-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('starts empty and persists updates', async () => {
    const store = ModelTierStore.inHome(dir);
    expect(await store.get('t1')).toEqual({ applied: [] });
    await store.update('t1', (s) => ({ ...s, lastReviewAt: '2026-10-08T00:00:00Z' }));
    const again = ModelTierStore.inHome(dir);
    expect((await again.get('t1')).lastReviewAt).toBe('2026-10-08T00:00:00Z');
    expect(Object.keys(await again.all())).toEqual(['t1']);
  });

  it('serialises concurrent updates', async () => {
    const store = ModelTierStore.inHome(dir);
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.update('t1', (s) => ({ ...s, applied: [...s.applied, { memberId: `m${i}` } as never] })),
      ),
    );
    expect((await store.get('t1')).applied).toHaveLength(5);
  });

  it('a failing mutation leaves the file as it was and later updates still run', async () => {
    const store = ModelTierStore.inHome(dir);
    await store.update('t1', (s) => ({ ...s, lastReviewAt: 'a' }));
    await expect(store.update('t1', () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await store.update('t1', (s) => ({ ...s, lastReviewTrigger: 'weekly' }));
    expect(await store.get('t1')).toMatchObject({ lastReviewAt: 'a', lastReviewTrigger: 'weekly' });
  });
});
