/**
 * Tests for WikiQueueService.
 *
 * Each test uses a fresh tmpdir for the queue root so cross-test state
 * doesn't leak. The service is exercised end-to-end against the real
 * filesystem — that's the whole point (queue durability across restarts).
 *
 * @module services/wiki/wiki-queue.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WikiQueueService } from './wiki-queue.service.js';

describe('WikiQueueService', () => {
  let root: string;
  let svc: WikiQueueService;
  const vaultA = '/abs/vault-a/.crewly/wiki';
  const vaultB = '/abs/vault-b/.crewly/wiki';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-queue-test-'));
    svc = new WikiQueueService(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const makeInput = (overrides: Partial<Parameters<typeof svc.add>[0]> = {}) => ({
    vaultPath: vaultA,
    queuedBy: 'crewly-orc',
    sourceType: 'user_chat' as const,
    sourceRef: 'chat:slack-x:msg-1',
    content: 'Anthropic SMB pilot signed at $799/month',
    reason: 'first paid SMB customer — concrete pricing validation',
    ...overrides,
  });

  describe('add', () => {
    it('persists a pending item with all required fields', async () => {
      const item = await svc.add(makeInput());
      expect(item.id).toMatch(/[0-9a-f-]{36}/);
      expect(item.status).toBe('pending');
      expect(item.queuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(item.vaultPath).toBe(vaultA);
      expect(item.reason).toContain('SMB');
    });

    it('survives a restart (singleton reset)', async () => {
      const a = await svc.add(makeInput());
      // Throw the in-memory service away — simulating a process restart.
      const fresh = new WikiQueueService(root);
      const round = await fresh.get(a.id);
      expect(round).not.toBeNull();
      expect(round?.content).toBe(a.content);
    });

    it('rejects relative vault paths', async () => {
      await expect(svc.add(makeInput({ vaultPath: 'relative/path' }))).rejects.toThrow(
        /absolute/,
      );
    });

    it('rejects empty content', async () => {
      await expect(svc.add(makeInput({ content: '   ' }))).rejects.toThrow(/empty/);
    });

    it('rejects empty reason — agents MUST justify why it is wiki-worthy', async () => {
      await expect(svc.add(makeInput({ reason: '   ' }))).rejects.toThrow(/reason/);
    });

    it('rejects oversize content', async () => {
      await expect(
        svc.add(makeInput({ content: 'x'.repeat(65 * 1024) })),
      ).rejects.toThrow(/exceeds/);
    });
  });

  describe('list / filter', () => {
    it('returns items newest-first', async () => {
      const a = await svc.add(makeInput({ sourceRef: 'a' }));
      await new Promise((r) => setTimeout(r, 5));
      const b = await svc.add(makeInput({ sourceRef: 'b' }));
      const list = await svc.list();
      expect(list[0].id).toBe(b.id);
      expect(list[1].id).toBe(a.id);
    });

    it('filters by vaultPath', async () => {
      await svc.add(makeInput({ vaultPath: vaultA, sourceRef: 'a' }));
      await svc.add(makeInput({ vaultPath: vaultB, sourceRef: 'b' }));
      const a = await svc.list({ vaultPath: vaultA });
      const b = await svc.list({ vaultPath: vaultB });
      expect(a.map((i) => i.sourceRef)).toEqual(['a']);
      expect(b.map((i) => i.sourceRef)).toEqual(['b']);
    });

    it('filters by status', async () => {
      const a = await svc.add(makeInput({ sourceRef: 'a' }));
      const b = await svc.add(makeInput({ sourceRef: 'b' }));
      await svc.claim(a.id, 'crewly-orc');
      const pending = await svc.list({ status: 'pending' });
      const claimed = await svc.list({ status: 'claimed' });
      expect(pending.map((i) => i.sourceRef)).toEqual(['b']);
      expect(claimed.map((i) => i.sourceRef)).toEqual(['a']);
    });

    it('honors limit', async () => {
      for (let i = 0; i < 5; i++) {
        await svc.add(makeInput({ sourceRef: `m-${i}` }));
      }
      const list = await svc.list({ limit: 2 });
      expect(list).toHaveLength(2);
    });
  });

  describe('claim → markProcessed lifecycle', () => {
    it('happy path: pending → claimed → processed', async () => {
      const a = await svc.add(makeInput());
      const claimed = await svc.claim(a.id, 'crewly-orc');
      expect(claimed.status).toBe('claimed');
      expect(claimed.claimedBy).toBe('crewly-orc');
      const processed = await svc.markProcessed(a.id, {
        ingested: true,
        pagesWritten: ['llm-curated/customers/anthropic.md'],
        targetPath: 'llm-curated/customers/anthropic.md',
        summary: 'merged into existing customers page',
      });
      expect(processed.status).toBe('processed');
      expect(processed.result?.pagesWritten).toContain(
        'llm-curated/customers/anthropic.md',
      );
    });

    it('refuses double-claim', async () => {
      const a = await svc.add(makeInput());
      await svc.claim(a.id, 'crewly-orc');
      await expect(svc.claim(a.id, 'another-agent')).rejects.toThrow(
        /only pending items can be claimed/,
      );
    });

    it('refuses markProcessed before claim', async () => {
      const a = await svc.add(makeInput());
      await expect(
        svc.markProcessed(a.id, { ingested: true, pagesWritten: ['x'] }),
      ).rejects.toThrow(/must be claimed first/);
    });

    it('refuses markProcessed on already-processed', async () => {
      const a = await svc.add(makeInput());
      await svc.claim(a.id, 'crewly-orc');
      await svc.markProcessed(a.id, { ingested: true, pagesWritten: ['x'] });
      await expect(
        svc.markProcessed(a.id, { ingested: true, pagesWritten: ['x'] }),
      ).rejects.toThrow(/must be claimed/);
    });
  });

  describe('markSkipped', () => {
    it('moves claimed → skipped with reason', async () => {
      const a = await svc.add(makeInput());
      await svc.claim(a.id, 'crewly-orc');
      const skipped = await svc.markSkipped(a.id, 'duplicate of customers/anthropic.md');
      expect(skipped.status).toBe('skipped');
      expect(skipped.result?.skipReason).toMatch(/duplicate/);
      expect(skipped.result?.ingested).toBe(false);
    });

    it('refuses skip without a reason — agents MUST say why', async () => {
      const a = await svc.add(makeInput());
      await svc.claim(a.id, 'crewly-orc');
      await expect(svc.markSkipped(a.id, '')).rejects.toThrow(/skipReason/);
    });

    it('refuses skip before claim', async () => {
      const a = await svc.add(makeInput());
      await expect(svc.markSkipped(a.id, 'meh')).rejects.toThrow(/must be claimed/);
    });
  });

  describe('getStats', () => {
    it('counts pending / claimed / processed / skipped', async () => {
      const a = await svc.add(makeInput({ sourceRef: 'a' }));
      const b = await svc.add(makeInput({ sourceRef: 'b' }));
      const c = await svc.add(makeInput({ sourceRef: 'c' }));
      const d = await svc.add(makeInput({ sourceRef: 'd' }));
      await svc.claim(a.id, 'orc');
      await svc.markProcessed(a.id, { ingested: true, pagesWritten: ['x'] });
      await svc.claim(b.id, 'orc');
      await svc.markSkipped(b.id, 'noise');
      await svc.claim(c.id, 'orc');
      // d stays pending

      const stats = await svc.getStats();
      expect(stats).toMatchObject({
        pending: 1,
        claimed: 1,
        processed: 1,
        skipped: 1,
        total: 4,
      });
    });

    it('scopes counts to vaultPath when provided', async () => {
      await svc.add(makeInput({ vaultPath: vaultA, sourceRef: 'a' }));
      await svc.add(makeInput({ vaultPath: vaultB, sourceRef: 'b1' }));
      await svc.add(makeInput({ vaultPath: vaultB, sourceRef: 'b2' }));
      const a = await svc.getStats(vaultA);
      const b = await svc.getStats(vaultB);
      expect(a.total).toBe(1);
      expect(b.total).toBe(2);
    });
  });

  describe('vault path normalisation (#914)', () => {
    it('stores the vault path without a trailing slash', async () => {
      const item = await svc.add(makeInput({ vaultPath: `${vaultA}/` }));
      expect(item.vaultPath).toBe(vaultA);
    });

    it('matches legacy items stored with a trailing slash against the discovered vault path', async () => {
      // Written by a build before normalisation: raw string had a trailing slash.
      await writeRaw({ id: 'legacy-1', vaultPath: `${vaultA}/`, queuedAt: new Date().toISOString() });
      const items = await svc.list({ vaultPath: vaultA, status: 'pending' });
      expect(items.map((i) => i.id)).toEqual(['legacy-1']);
    });

    it('lists oldest-first when asked', async () => {
      const a = await svc.add(makeInput({ sourceRef: 'a' }));
      await new Promise((r) => setTimeout(r, 5));
      await svc.add(makeInput({ sourceRef: 'b' }));
      const list = await svc.list({ order: 'oldest', limit: 1 });
      expect(list.map((i) => i.id)).toEqual([a.id]);
    });

    it('reports the oldest pending queuedAt in stats', async () => {
      await writeRaw({ id: 'old', queuedAt: '2026-05-23T00:00:00.000Z' });
      await writeRaw({ id: 'new', queuedAt: '2026-09-01T00:00:00.000Z' });
      await writeRaw({ id: 'done', queuedAt: '2026-01-01T00:00:00.000Z', status: 'processed' });
      const stats = await svc.getStats();
      expect(stats.oldestPendingQueuedAt).toBe('2026-05-23T00:00:00.000Z');
      expect((await svc.getStats('/abs/empty/.crewly/wiki')).oldestPendingQueuedAt).toBeNull();
    });
  });

  describe('sweep (#914)', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = Date.parse('2026-10-01T00:00:00.000Z');
    const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

    it('moves pending items older than the max age to dead-letter, keeping the record', async () => {
      await writeRaw({ id: 'ancient', queuedAt: ago(131) });
      await writeRaw({ id: 'recent', queuedAt: ago(2) });
      const out = await svc.sweep({ now: NOW, maxItemAgeMs: 30 * DAY });
      expect(out.expired.map((i) => i.id)).toEqual(['ancient']);
      expect(await svc.get('ancient')).toBeNull();
      const dead = JSON.parse(
        await fs.readFile(path.join(svc.getDeadLetterDir(), 'ancient.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(dead['content']).toBe('c');
      expect(dead['expireReason']).toMatch(/still pending after 131 days/);
      expect(dead['expiredAt']).toBe(new Date(NOW).toISOString());
      // The dead-letter folder is not read back as queue items.
      expect((await svc.list({ status: 'pending' })).map((i) => i.id)).toEqual(['recent']);
    });

    it('expires a claimed item older than the max age as well', async () => {
      await writeRaw({ id: 'stuck', queuedAt: ago(60), status: 'claimed', claimedBy: 'tl', claimedAt: ago(59) });
      const out = await svc.sweep({ now: NOW, maxItemAgeMs: 30 * DAY });
      expect(out.expired.map((i) => i.id)).toEqual(['stuck']);
    });

    it('releases a claim that was never processed or skipped back to pending', async () => {
      await writeRaw({ id: 'abandoned', queuedAt: ago(3), status: 'claimed', claimedBy: 'tl', claimedAt: ago(2) });
      await writeRaw({ id: 'active', queuedAt: ago(1), status: 'claimed', claimedBy: 'tl', claimedAt: new Date(NOW - 60_000).toISOString() });
      const out = await svc.sweep({ now: NOW, maxItemAgeMs: 30 * DAY, claimTimeoutMs: DAY });
      expect(out.releasedClaims).toEqual(['abandoned']);
      const released = await svc.get('abandoned');
      expect(released?.status).toBe('pending');
      expect(released?.claimedBy).toBeUndefined();
      expect((await svc.get('active'))?.status).toBe('claimed');
    });

    it('never touches processed or skipped items, however old', async () => {
      await writeRaw({ id: 'p', queuedAt: ago(400), status: 'processed' });
      await writeRaw({ id: 's', queuedAt: ago(400), status: 'skipped' });
      const out = await svc.sweep({ now: NOW, maxItemAgeMs: 30 * DAY });
      expect(out.expired).toEqual([]);
      expect((await svc.get('p'))?.status).toBe('processed');
      expect((await svc.get('s'))?.status).toBe('skipped');
    });

    it('reports pending backlog per normalised vault with its oldest item', async () => {
      await writeRaw({ id: 'a1', vaultPath: vaultA, queuedAt: ago(9) });
      await writeRaw({ id: 'a2', vaultPath: `${vaultA}/`, queuedAt: ago(1) });
      await writeRaw({ id: 'b1', vaultPath: vaultB, queuedAt: ago(4) });
      const out = await svc.sweep({ now: NOW, maxItemAgeMs: 30 * DAY });
      expect(out.backlog).toEqual([
        { vaultPath: vaultA, pending: 2, oldestQueuedAt: ago(9) },
        { vaultPath: vaultB, pending: 1, oldestQueuedAt: ago(4) },
      ]);
    });
  });

  /**
   * Write a queue item file directly — for items with a fixed `queuedAt`
   * or a shape an older build produced.
   */
  async function writeRaw(fields: Partial<Record<string, unknown>> & { id: string; queuedAt: string }): Promise<void> {
    const item = {
      vaultPath: vaultA,
      queuedBy: 'crewly-orc',
      sourceType: 'user_chat',
      sourceRef: 'ref',
      content: 'c',
      reason: 'r',
      status: 'pending',
      ...fields,
    };
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, `${fields.id}.json`), JSON.stringify(item), 'utf8');
  }

  describe('get', () => {
    it('returns null for unknown id', async () => {
      const x = await svc.get('00000000-0000-0000-0000-000000000000');
      expect(x).toBeNull();
    });
  });
});
