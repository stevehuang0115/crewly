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

  describe('get', () => {
    it('returns null for unknown id', async () => {
      const x = await svc.get('00000000-0000-0000-0000-000000000000');
      expect(x).toBeNull();
    });
  });
});
