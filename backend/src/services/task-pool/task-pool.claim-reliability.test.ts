/**
 * Claim reliability tests (Paperclip delta §4 item 4): self-explaining refusals,
 * a separate review slot, and orphaned-claim recovery.
 *
 * @module services/task-pool/task-pool.claim-reliability.test
 */

import { TaskPoolService } from './task-pool.service.js';
import { PoolStorage } from './pool-storage.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import { detectExpiredClaims } from '../reconciler/reconcile-rules.js';
import { DEFAULT_LEASE_DURATION_MS, DEFAULT_GRACE_PERIOD_MS } from '../../types/v2/claim.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

/** Build a queued WorkItem targeted at an agent. */
function wi(overrides: Record<string, unknown> = {}) {
  return createWorkItem({ type: 'delegate', owner: 'agent', title: 'T', metadata: { reviewer: 'tl' }, ...overrides });
}

describe('TaskPoolService claim reliability', () => {
  let dir: string;
  let service: TaskPoolService;
  let storage: PoolStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-rel-'));
    storage = new PoolStorage({ dataDir: dir });
    service = new TaskPoolService(storage);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    TaskPoolService.resetInstance();
    await service.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe('item 1: refusal names the real reason and the blocking item', () => {
    it('reports slot_occupied with the id of the running item', async () => {
      const running = wi({ target: 'tl' });
      const queued = wi({ target: 'tl' });
      await service.addToPool(running);
      await service.addToPool(queued);
      await service.claimSpecificItem('tl', running.id);

      expect(await service.claimSpecificItem('tl', queued.id)).toBeNull();
      const why = await service.explainClaimRefusal('tl', queued.id);
      expect(why.code).toBe('slot_occupied');
      expect(why.blockingWorkItemId).toBe(running.id);
      expect(why.message).toContain(running.id);
    });

    it('reports not_found for an unknown id', async () => {
      expect((await service.explainClaimRefusal('tl', 'nope')).code).toBe('not_found');
    });

    it('reports target_mismatch, already_claimed and not_queued distinctly', async () => {
      const other = wi({ target: 'leo' });
      await service.addToPool(other);
      expect((await service.explainClaimRefusal('tl', other.id)).code).toBe('target_mismatch');
      await service.claimSpecificItem('leo', other.id);
      expect((await service.explainClaimRefusal('tl', other.id)).code).toBe('already_claimed');
    });
  });

  describe('item 2: a review item has its own claim slot', () => {
    it('lets an agent claim a review item while a delegate is running', async () => {
      const delegate = wi({ target: 'tl' });
      const review = wi({ type: 'review', target: 'tl' });
      await service.addToPool(delegate);
      await service.addToPool(review);
      await service.claimSpecificItem('tl', delegate.id);

      const got = await service.claimSpecificItem('tl', review.id);
      expect(got?.workItem.id).toBe(review.id);
    });

    it('claimFromPool hands a queued review to an agent already holding a delegate', async () => {
      const delegate = wi({ target: 'tl' });
      const review = wi({ type: 'review', target: 'tl' });
      await service.addToPool(delegate);
      await service.claimFromPool('tl');
      await service.addToPool(review);
      const got = await service.claimFromPool('tl', { types: ['delegate', 'review'] });
      expect(got?.workItem.id).toBe(review.id);
      expect(got?.alreadyHeld).toBeFalsy();
    });

    it('still allows only one item per slot (second delegate refused)', async () => {
      const a = wi({ target: 'tl' });
      const b = wi({ target: 'tl' });
      await service.addToPool(a);
      await service.addToPool(b);
      await service.claimSpecificItem('tl', a.id);
      expect(await service.claimSpecificItem('tl', b.id)).toBeNull();
    });

    it('two review items are not claimable at once', async () => {
      const r1 = wi({ type: 'review', target: 'tl' });
      const r2 = wi({ type: 'review', target: 'tl' });
      await service.addToPool(r1);
      await service.addToPool(r2);
      await service.claimSpecificItem('tl', r1.id);
      expect(await service.claimSpecificItem('tl', r2.id)).toBeNull();
    });
  });

  describe('item 5: orphaned claim is recovered, once', () => {
    it('agent dies -> lease + grace expire -> item is queued again, not duplicated', async () => {
      const item = wi({ target: 'leo' });
      await service.addToPool(item);
      const first = await service.claimSpecificItem('leo', item.id);
      expect(first).not.toBeNull();

      // Session dies: it can no longer claim, and never heartbeats.
      const t0 = Date.now();
      const nowSpy = jest.spyOn(Date, 'now');

      // Lease expires -> reconciler marks the claim expiring.
      nowSpy.mockReturnValue(t0 + DEFAULT_LEASE_DURATION_MS + 1000);
      let claims = await service.getClaimService().getActiveClaims();
      const r1 = detectExpiredClaims(claims);
      expect(r1.expiringIds).toEqual([first!.claim.id]);
      await service.getClaimService().markExpiring(r1.expiringIds);

      // Grace exceeded -> revoke + release.
      nowSpy.mockReturnValue(t0 + DEFAULT_LEASE_DURATION_MS + DEFAULT_GRACE_PERIOD_MS + 5000);
      claims = (await service.getClaimService().scanExpiredClaims()).graceExceeded;
      const r2 = detectExpiredClaims(claims.map((c) => ({ ...c })));
      expect(r2.revokedIds).toEqual([first!.claim.id]);
      await service.revokeAndRelease(first!.claim.id, 'grace exceeded');
      // A second reconcile tick must be harmless (no duplicate requeue).
      await service.revokeAndRelease(first!.claim.id, 'grace exceeded').catch(() => undefined);
      nowSpy.mockRestore();

      const all = await storage.getWorkItems();
      const same = all.filter((w) => w.id === item.id);
      expect(same).toHaveLength(1);
      expect(same[0].status).toBe('queued');
      expect(same[0].target).toBe('leo');
      expect((await service.getClaimService().getActiveClaims())).toHaveLength(0);

      // Restarted agent re-claims: exactly one new active claim.
      const again = await service.claimFromPool('leo');
      expect(again?.workItem.id).toBe(item.id);
      expect(again?.claim.id).not.toBe(first!.claim.id);
      expect(await service.getClaimService().getActiveClaims()).toHaveLength(1);
    });
  });
});
