/**
 * Task Pool Service Tests
 *
 * @module services/task-pool/task-pool.service.test
 */

import { TaskPoolService, WorkItemClaimedError } from './task-pool.service.js';
import { PoolStorage } from './pool-storage.js';
import { createWorkItem } from '../../types/v2/work-item.types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock LoggerService
jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'task-pool-test-'));
}

function makeWorkItem(overrides?: Record<string, unknown>) {
  return createWorkItem({
    type: 'delegate',
    owner: 'agent',
    title: 'Test task',
    target: 'agent-1',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskPoolService', () => {
  let service: TaskPoolService;
  let storage: PoolStorage;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    storage = new PoolStorage({ dataDir: tempDir });
    service = new TaskPoolService(storage);
  });

  afterEach(async () => {
    TaskPoolService.resetInstance();
    await service.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // addToPool
  // -----------------------------------------------------------------------

  describe('addToPool', () => {
    it('adds a queued WorkItem to the pool', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      const items = await service.getAllItems();
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(wi.id);
    });

    it('rejects non-queued items', async () => {
      const wi = makeWorkItem();
      wi.status = 'running';

      await expect(service.addToPool(wi)).rejects.toThrow(
        "status must be 'queued'",
      );
    });

    it('rejects invalid WorkItem objects', async () => {
      const invalid = { id: 'x' } as any;
      await expect(service.addToPool(invalid)).rejects.toThrow('Invalid WorkItem');
    });

    it('skips duplicate items silently', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.addToPool(wi); // duplicate

      const items = await service.getAllItems();
      expect(items).toHaveLength(1);
    });

    it('accepts a blocked WorkItem (waiting on deps)', async () => {
      const wi = makeWorkItem({ dependsOn: ['upstream-1'] });
      // makeWorkItem builds via createWorkItem, so dependsOn → blocked
      expect(wi.status).toBe('blocked');

      await service.addToPool(wi);
      const items = await service.getAllItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('blocked');
    });

    // ---------------------------------------------------------------------
    // INBOUND-1.f1: workitem:queued publish hook
    // ---------------------------------------------------------------------

    describe('workitem:queued publish (INBOUND-1.f1)', () => {
      it('publishes workitem:queued with workItemId + requestId + missionId when EventBus is wired', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem({ requestId: 'req-99', missionId: 'm-7' });
        await service.addToPool(wi);

        expect(publishCalls).toHaveLength(1);
        expect(publishCalls[0].type).toBe('workitem:queued');
        expect(publishCalls[0].workItemId).toBe(wi.id);
        expect(publishCalls[0].requestId).toBe('req-99');
        expect(publishCalls[0].missionId).toBe('m-7');
        // Deterministic event id keyed on the WI id (dedup contract).
        expect(publishCalls[0].id).toBe(`workitem:queued:${wi.id}`);
        expect(publishCalls[0].newValue).toBe(wi.status);
      });

      it('does NOT publish workitem:queued when no EventBus is wired (legacy/test path)', async () => {
        // No setEventBusService — eventBus stays null, addToPool must not throw.
        const wi = makeWorkItem();
        await expect(service.addToPool(wi)).resolves.toBeUndefined();
      });

      it('does NOT publish workitem:queued when addToPool short-circuits on a duplicate id', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem({ requestId: 'req-dup' });
        await service.addToPool(wi);
        await service.addToPool(wi); // duplicate id — short-circuits

        expect(publishCalls).toHaveLength(1);
      });

      it('omits requestId/missionId when the WI does not carry them', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem(); // no requestId, no missionId
        await service.addToPool(wi);

        expect(publishCalls).toHaveLength(1);
        expect(publishCalls[0].requestId).toBeUndefined();
        expect(publishCalls[0].missionId).toBeUndefined();
        expect(publishCalls[0].workItemId).toBe(wi.id);
      });

      it('isolates EventBus.publish errors from the pool mutation (storage commit wins)', async () => {
        const fakeBus = {
          publish: jest.fn(() => {
            throw new Error('bus blew up');
          }),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem();
        await expect(service.addToPool(wi)).resolves.toBeUndefined();

        // Pool mutation committed even though publish threw.
        const items = await service.getAllItems();
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(wi.id);
      });
    });

    // ---------------------------------------------------------------------
    // P1 Bug B: intrinsic Request.workItemIds[] backfill
    //
    // Pool umbrella WorkItem 72ca743a-3a66-4d0e-a6cf-1a861f849dbd.
    //
    // Pre-fix, addToPool stored requestId on the WI but did NOT push the
    // WI id into Request.workItemIds[] — that link only happened via
    // downstream subscribers (request-sla.subscriber on workitem:queued,
    // V3DataService on task:delegated), both of which require the caller
    // to have gone through the standard event chain. Manual / programmatic
    // / cron / orchestrator-script callers bypassed those subscribers and
    // left Requests with empty workItemIds[].
    //
    // The fix: addToPool now invokes a wired `linkWorkItem` on every
    // successful enqueue. linkWorkItem is idempotent (short-circuits on
    // duplicate id) so subscriber-driven linking remains as
    // belt-and-suspenders. These tests pin the contract.
    // ---------------------------------------------------------------------
    describe('intrinsic Request link (P1 Bug B)', () => {
      function makeFakeLinker() {
        const calls: Array<{ requestId: string; workItemId: string }> = [];
        const linker = {
          linkWorkItem: jest.fn(async (requestId: string, workItemId: string) => {
            calls.push({ requestId, workItemId });
            return null;
          }),
        };
        return { linker, calls };
      }

      it('calls linkWorkItem(requestId, workItemId) once when wi.requestId is set', async () => {
        const { linker, calls } = makeFakeLinker();
        service.setRequestService(linker as any);

        const wi = makeWorkItem({ requestId: 'req-bug-b-1' });
        await service.addToPool(wi);

        expect(linker.linkWorkItem).toHaveBeenCalledTimes(1);
        expect(calls[0]).toEqual({ requestId: 'req-bug-b-1', workItemId: wi.id });
      });

      it('does NOT call linkWorkItem when wi.requestId is NOT set', async () => {
        const { linker } = makeFakeLinker();
        service.setRequestService(linker as any);

        const wi = makeWorkItem(); // no requestId
        await service.addToPool(wi);

        expect(linker.linkWorkItem).not.toHaveBeenCalled();
      });

      it('isolates linkWorkItem failures (addToPool still succeeds, warn-logged)', async () => {
        const linker = {
          linkWorkItem: jest.fn(async () => {
            throw new Error('linker blew up — db down');
          }),
        };
        service.setRequestService(linker as any);

        const wi = makeWorkItem({ requestId: 'req-fail' });

        // CRITICAL: addToPool must NOT re-throw — pool mutation is the
        // source of truth, link is best-effort.
        await expect(service.addToPool(wi)).resolves.toBeUndefined();

        // Pool mutation committed even though link threw.
        const items = await service.getAllItems();
        expect(items).toHaveLength(1);
        expect(items[0].id).toBe(wi.id);
        expect(linker.linkWorkItem).toHaveBeenCalledTimes(1);
      });

      it('does not double-link on duplicate addToPool calls (storage dedup short-circuits)', async () => {
        const { linker } = makeFakeLinker();
        service.setRequestService(linker as any);

        const wi = makeWorkItem({ requestId: 'req-dup-link' });
        await service.addToPool(wi);
        await service.addToPool(wi); // duplicate id — storage short-circuits at line 206

        // The duplicate addToPool returns early BEFORE the link call,
        // so linkWorkItem is invoked exactly once. Even if it were called
        // twice, the production linkWorkItem itself short-circuits on
        // duplicate workItemId (request.service.ts:328) — pinned in a
        // belt-and-suspenders test below.
        expect(linker.linkWorkItem).toHaveBeenCalledTimes(1);
      });

      it('does NOT call linkWorkItem when no RequestService is wired (legacy/test path)', async () => {
        // No setRequestService — requestService stays null, addToPool
        // must not throw and the linker call must be skipped silently.
        const wi = makeWorkItem({ requestId: 'req-no-linker' });
        await expect(service.addToPool(wi)).resolves.toBeUndefined();

        const items = await service.getAllItems();
        expect(items).toHaveLength(1);
      });

      it('coexists with EventBus publish (both linker and bus invoked, in order)', async () => {
        // Pin the belt-and-suspenders contract: a caller that goes
        // through the request:created event chain still triggers BOTH
        // the intrinsic link (this fix) AND the subscriber-driven link
        // (downstream of workitem:queued). The downstream link is
        // exercised in production via request-sla.subscriber.ts:1153,
        // not invoked here, but we pin the publish ordering.
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        const { linker } = makeFakeLinker();

        service.setEventBusService(fakeBus);
        service.setRequestService(linker as any);

        const wi = makeWorkItem({ requestId: 'req-coexist' });
        await service.addToPool(wi);

        // Both fired
        expect(linker.linkWorkItem).toHaveBeenCalledTimes(1);
        expect(publishCalls).toHaveLength(1);
        expect(publishCalls[0].requestId).toBe('req-coexist');

        // Ordering: linker BEFORE publish, so a subscriber that loads the
        // Request synchronously after seeing workitem:queued will already
        // observe the intrinsic link. (Subscribers re-link idempotently
        // anyway, but ordering is documented.)
        const linkOrder = (linker.linkWorkItem as jest.Mock).mock.invocationCallOrder[0];
        const publishOrder = fakeBus.publish.mock.invocationCallOrder[0];
        expect(linkOrder).toBeLessThan(publishOrder);
      });

      it('integration repro: ORC 322e7fd3 case — direct addToPool populates Request.workItemIds[]', async () => {
        // Mimic the exact failure mode from ORC's bug report: a Request
        // exists, then a caller directly invokes taskPool.addToPool
        // outside the request:created event chain (no SLA subscriber, no
        // V3DataService). PRE-FIX: workItemIds stays empty. POST-FIX:
        // the intrinsic link populates it.
        //
        // We use a FAKE Request store keyed on requestId — simpler than
        // standing up the full RequestService / persistence stack and
        // pins the wire contract that matters: linkWorkItem produces the
        // observed mutation on the Request side.
        const fakeRequestStore = new Map<string, { id: string; workItemIds: string[] }>();
        fakeRequestStore.set('req-322e7fd3', {
          id: 'req-322e7fd3',
          workItemIds: [], // empty — the bug condition
        });

        const linker = {
          linkWorkItem: jest.fn(async (requestId: string, workItemId: string) => {
            const req = fakeRequestStore.get(requestId);
            if (!req) return null;
            // Idempotency: short-circuit on duplicate id (mirrors
            // request.service.ts:328).
            if (!req.workItemIds.includes(workItemId)) {
              req.workItemIds.push(workItemId);
            }
            return req;
          }),
        };
        service.setRequestService(linker as any);

        // PRE-FIX assertion baseline
        expect(fakeRequestStore.get('req-322e7fd3')!.workItemIds).toEqual([]);

        // Direct addToPool — bypasses any event subscribers
        const wi = makeWorkItem({ requestId: 'req-322e7fd3' });
        await service.addToPool(wi);

        // POST-FIX: intrinsic link populated workItemIds
        const after = fakeRequestStore.get('req-322e7fd3')!;
        expect(after.workItemIds).toHaveLength(1);
        expect(after.workItemIds).toContain(wi.id);

        // Subscriber-driven re-link (simulated): calling linkWorkItem
        // again with the same ids is a no-op due to the includes() guard.
        // This pins the belt-and-suspenders idempotency contract.
        await linker.linkWorkItem('req-322e7fd3', wi.id);
        const afterSecondLink = fakeRequestStore.get('req-322e7fd3')!;
        expect(afterSecondLink.workItemIds).toHaveLength(1); // still 1
      });
    });
  });

  // -----------------------------------------------------------------------
  // Dependency resolution (auto-unblock)
  // -----------------------------------------------------------------------

  describe('dependency resolution', () => {
    it('promotes a blocked dependent to queued when its single dep completes', async () => {
      const upstream = makeWorkItem({ type: 'cron_run', title: 'upstream' });
      await service.addToPool(upstream);

      const downstream = makeWorkItem({
        type: 'cron_run',
        title: 'downstream',
        dependsOn: [upstream.id],
      });
      await service.addToPool(downstream);

      // Claim + complete upstream — should auto-unblock downstream
      const claim = await service.claimFromPool('agent-a');
      expect(claim!.workItem.id).toBe(upstream.id);
      await service.completeItem(upstream.id);

      const items = await service.getAllItems();
      const after = items.find((wi) => wi.id === downstream.id)!;
      expect(after.status).toBe('queued');
    });

    it('keeps the dependent blocked until ALL deps complete', async () => {
      const depA = makeWorkItem({ type: 'cron_run', title: 'dep-a' });
      const depB = makeWorkItem({ type: 'cron_run', title: 'dep-b' });
      await service.addToPool(depA);
      await service.addToPool(depB);

      const downstream = makeWorkItem({
        type: 'cron_run',
        title: 'downstream',
        dependsOn: [depA.id, depB.id],
      });
      await service.addToPool(downstream);

      // Complete only depA first
      await service.claimFromPool('agent-a');
      await service.completeItem(depA.id);

      let items = await service.getAllItems();
      expect(items.find((wi) => wi.id === downstream.id)!.status).toBe('blocked');

      // Now complete depB — downstream should unblock
      await service.claimFromPool('agent-b');
      await service.completeItem(depB.id);

      items = await service.getAllItems();
      expect(items.find((wi) => wi.id === downstream.id)!.status).toBe('queued');
    });

    it('does not touch dependents that list a different upstream', async () => {
      const otherUpstream = makeWorkItem({ type: 'cron_run', title: 'other' });
      const unrelatedDownstream = makeWorkItem({
        type: 'cron_run',
        title: 'unrelated',
        dependsOn: ['some-other-id'],
      });
      await service.addToPool(otherUpstream);
      await service.addToPool(unrelatedDownstream);

      await service.claimFromPool('agent-a');
      await service.completeItem(otherUpstream.id);

      const items = await service.getAllItems();
      expect(items.find((wi) => wi.id === unrelatedDownstream.id)!.status).toBe(
        'blocked',
      );
    });
  });

  // -----------------------------------------------------------------------
  // claimFromPool
  // -----------------------------------------------------------------------

  describe('claimFromPool', () => {
    it('claims the oldest available item (FIFO)', async () => {
      const wi1 = makeWorkItem({ title: 'First' });
      const wi2 = makeWorkItem({ title: 'Second' });
      // Ensure wi1 is older
      wi1.createdAt = new Date(Date.now() - 10000).toISOString();
      wi2.createdAt = new Date().toISOString();

      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo');
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('First');
      expect(result!.workItem.status).toBe('running');
      expect(result!.claim.agentId).toBe('agent-leo');
    });

    it('returns null when pool is empty', async () => {
      const result = await service.claimFromPool('agent-leo');
      expect(result).toBeNull();
    });

    it('returns null when all items are claimed', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const result = await service.claimFromPool('agent-max');
      expect(result).toBeNull();
    });

    it('prevents agent from claiming when they already have a claim', async () => {
      const wi1 = makeWorkItem({ title: 'First' });
      const wi2 = makeWorkItem({ title: 'Second' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      await service.claimFromPool('agent-leo');
      const second = await service.claimFromPool('agent-leo');
      expect(second).toBeNull();
    });

    it('filters by type', async () => {
      const wi1 = makeWorkItem({ type: 'delegate', title: 'Delegate' });
      const wi2 = makeWorkItem({ type: 'check', title: 'Check' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo', {
        types: ['check'],
      });
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('Check');
    });

    it('filters by owner', async () => {
      const wi1 = makeWorkItem({ owner: 'agent', title: 'Agent task' });
      const wi2 = makeWorkItem({ owner: 'system', title: 'System task' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo', {
        owner: 'system',
      });
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('System task');
    });

    it('filters by missionId', async () => {
      const wi1 = makeWorkItem({ title: 'No mission' });
      const wi2 = makeWorkItem({ title: 'With mission' });
      wi2.missionId = 'mission-123';
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const result = await service.claimFromPool('agent-leo', {
        missionId: 'mission-123',
      });
      expect(result).not.toBeNull();
      expect(result!.workItem.title).toBe('With mission');
    });

    it('throws on empty agentId', async () => {
      await expect(service.claimFromPool('')).rejects.toThrow('agentId is required');
    });

    it('serializes concurrent claims so only one agent wins a given WorkItem', async () => {
      // Single queued item — two agents race to claim it concurrently.
      const wi = makeWorkItem({ title: 'Contested' });
      await service.addToPool(wi);

      const [a, b] = await Promise.all([
        service.claimFromPool('agent-a'),
        service.claimFromPool('agent-b'),
      ]);

      // Exactly one of the two must have won.
      const winners = [a, b].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.workItem.id).toBe(wi.id);

      // Storage must reflect a single active claim, not two.
      const snapshot = await service.getPoolStatus();
      expect(snapshot.claimed).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // releaseBack
  // -----------------------------------------------------------------------

  describe('releaseBack', () => {
    it('releases a claimed item back to queued', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.releaseBack(wi.id, 'agent busy');

      const items = await service.getAvailableItems();
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('queued');
      expect(items[0].retryCount).toBe(1);
    });

    it('throws when item not found', async () => {
      await expect(service.releaseBack('ghost', 'test')).rejects.toThrow(
        'WorkItem not found',
      );
    });

    it('throws when item is not running', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      await expect(service.releaseBack(wi.id, 'test')).rejects.toThrow(
        "status must be 'running'",
      );
    });

    it('allows another agent to claim after release', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      await service.releaseBack(wi.id, 'busy');

      const result = await service.claimFromPool('agent-max');
      expect(result).not.toBeNull();
      expect(result!.claim.agentId).toBe('agent-max');
    });
  });

  // -----------------------------------------------------------------------
  // completeItem
  // -----------------------------------------------------------------------

  describe('completeItem (facade — VERIF-1 routing)', () => {
    it('routes a non-delegate item through completeSimpleItem (status → done)', async () => {
      const wi = makeWorkItem({ type: 'cron_run' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id, { output: 'success' });

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done');
      expect(items[0].completedAt).toBeDefined();
      expect(items[0].result).toEqual({ output: 'success' });
    });

    it('routes a delegate item through submitForVerification (status → done_by_worker)', async () => {
      // delegate items default to "requires verification" so the worker's
      // implicit completeItem call should park the item in done_by_worker
      // and wake the TL — never auto-advance to done.
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id, { output: 'draft' });

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done_by_worker');
      expect(items[0].result).toEqual({ output: 'draft' });
    });

    it('respects metadata.requiresVerification=false on a delegate item (F-H — review WIs do not self-verify)', async () => {
      // F-H: REVIEW-1's review WorkItems are themselves the verification
      // step, so they MUST opt out of the delegate-default to avoid a
      // TL-self-verification loop. This is the explicit override path.
      const wi = makeWorkItem({
        type: 'delegate',
        metadata: { requiresVerification: false },
      });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id);

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done');
    });

    it('respects metadata.requiresVerification=true on a non-delegate item (explicit opt-in)', async () => {
      const wi = makeWorkItem({
        type: 'cron_run',
        metadata: { requiresVerification: true },
      });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.completeItem(wi.id);

      const items = await service.getAllItems();
      expect(items[0].status).toBe('done_by_worker');
    });

    it('throws when item not found', async () => {
      await expect(service.completeItem('ghost')).rejects.toThrow(
        'WorkItem not found',
      );
    });

    it('throws when item is not running (delegate path surfaces TRANS-1 invalid-transition error)', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);

      // queued → done_by_worker is rejected by the state machine
      await expect(service.completeItem(wi.id)).rejects.toThrow(
        /Invalid status transition/,
      );
    });

    it('throws when item is not running (simple path surfaces TRANS-1 invalid-transition error)', async () => {
      const wi = makeWorkItem({ type: 'cron_run' });
      await service.addToPool(wi);

      await expect(service.completeItem(wi.id)).rejects.toThrow(
        /Invalid status transition/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // submitForVerification (VERIF-1)
  // -----------------------------------------------------------------------

  describe('submitForVerification', () => {
    it('transitions running → done_by_worker for an agent actor', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const updated = await service.submitForVerification(wi.id, 'agent', { output: 'draft' });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('done_by_worker');
      expect(updated!.completedAt).toBeDefined();
      expect(updated!.result).toEqual({ output: 'draft' });
    });

    it('releases the active claim with endReason="submitted_for_verification"', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.submitForVerification(wi.id, 'agent');

      const active = await service.getActiveClaims();
      // The submitted item's claim is released — no longer active
      expect(active).toHaveLength(0);
    });

    it('rejects a non-agent actor (e.g. team_lead self-submission) via TRANS-1 actor gate', async () => {
      // TRANSITION_PERMISSIONS limits running→done_by_worker to 'agent'.
      // A TL trying to submit on a worker's behalf must throw.
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await expect(service.submitForVerification(wi.id, 'team_lead'))
        .rejects.toThrow(/Forbidden transition.*actor='team_lead'/);
    });

    it('rejects when the item is not in running status (state-machine gate)', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);

      await expect(service.submitForVerification(wi.id, 'agent'))
        .rejects.toThrow(/Invalid status transition/);
    });

    // ---------------------------------------------------------------------
    // F1-BRIDGE-1: task:done_by_worker publish hook
    // ---------------------------------------------------------------------

    describe('task:done_by_worker publish (F1-BRIDGE-1)', () => {
      it('publishes task:done_by_worker exactly once per successful submit, with workItemId + correlation fields', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem({ type: 'delegate', requestId: 'req-42', missionId: 'm-9' });
        await service.addToPool(wi);
        await service.claimFromPool('agent-leo');

        await service.submitForVerification(wi.id, 'agent', { output: 'draft' });

        // 1 workitem:queued (from addToPool) + 1 task:done_by_worker
        const doneEvents = publishCalls.filter((e) => e.type === 'task:done_by_worker');
        expect(doneEvents).toHaveLength(1);
        expect(doneEvents[0].workItemId).toBe(wi.id);
        expect(doneEvents[0].requestId).toBe('req-42');
        expect(doneEvents[0].missionId).toBe('m-9');
        expect(doneEvents[0].previousValue).toBe('running');
        expect(doneEvents[0].newValue).toBe('done_by_worker');
        // Deterministic event id keyed on the WI id (dedup contract — mirrors workitem:queued)
        expect(doneEvents[0].id).toBe(`task:done_by_worker:${wi.id}`);
      });

      it('does NOT publish task:done_by_worker when the transition throws (state-machine gate)', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem({ type: 'delegate' });
        await service.addToPool(wi);
        // Skip claimFromPool so the WI stays in `queued`, not `running` —
        // submitForVerification must throw on the invalid transition, and
        // the publisher must NEVER fire on a rolled-back transition.
        await expect(service.submitForVerification(wi.id, 'agent'))
          .rejects.toThrow(/Invalid status transition/);

        const doneEvents = publishCalls.filter((e) => e.type === 'task:done_by_worker');
        expect(doneEvents).toHaveLength(0);
      });

      it('does NOT publish task:done_by_worker when no EventBus is wired (legacy/test path)', async () => {
        const wi = makeWorkItem({ type: 'delegate' });
        await service.addToPool(wi);
        await service.claimFromPool('agent-leo');

        // No setEventBusService — eventBus stays null, submitForVerification must not throw.
        await expect(
          service.submitForVerification(wi.id, 'agent', { output: 'draft' }),
        ).resolves.not.toBeNull();
      });

      it('isolates EventBus.publish errors from the verification transition (state commit wins)', async () => {
        const fakeBus = {
          publish: jest.fn((event: any) => {
            // Only blow up on task:done_by_worker so the addToPool publish
            // (workitem:queued) does not throw and dirty the setup phase.
            if (event.type === 'task:done_by_worker') {
              throw new Error('bus blew up');
            }
          }),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem({ type: 'delegate' });
        await service.addToPool(wi);
        await service.claimFromPool('agent-leo');

        const updated = await service.submitForVerification(wi.id, 'agent', { output: 'draft' });

        // Transition committed even though the bus threw.
        expect(updated).not.toBeNull();
        expect(updated!.status).toBe('done_by_worker');
      });
    });
  });

  // -----------------------------------------------------------------------
  // completeSimpleItem (VERIF-1)
  // -----------------------------------------------------------------------

  describe('completeSimpleItem', () => {
    it('transitions running → done for an agent actor', async () => {
      const wi = makeWorkItem({ type: 'cron_run' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const updated = await service.completeSimpleItem(wi.id, 'agent', { output: 'tick' });

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('done');
      expect(updated!.completedAt).toBeDefined();
      expect(updated!.result).toEqual({ output: 'tick' });
    });

    it('promotes blocked dependents whose deps are now satisfied', async () => {
      const upstream = makeWorkItem({ type: 'cron_run' });
      const downstream = makeWorkItem({ type: 'cron_run', dependsOn: [upstream.id] });
      await service.addToPool(upstream);
      await service.addToPool(downstream);
      // downstream starts blocked because upstream is not yet terminal
      const downstreamBefore = (await service.getAllItems()).find((wi) => wi.id === downstream.id);
      expect(downstreamBefore?.status).toBe('blocked');

      await service.claimFromPool('agent-leo');
      await service.completeSimpleItem(upstream.id, 'agent');

      const downstreamAfter = (await service.getAllItems()).find((wi) => wi.id === downstream.id);
      expect(downstreamAfter?.status).toBe('queued');
    });

    it('accepts the "system" actor (Reconciler path bypasses actor check)', async () => {
      const wi = makeWorkItem({ type: 'reconcile' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const updated = await service.completeSimpleItem(wi.id, 'system');

      expect(updated!.status).toBe('done');
    });
  });

  // -----------------------------------------------------------------------
  // verifyItem (VERIF-1)
  // -----------------------------------------------------------------------

  describe('verifyItem', () => {
    /**
     * Drives a WorkItem through `running → done_by_worker` so the verify
     * tests can exercise the verdict transitions in isolation.
     */
    async function makeAwaitingVerification(opts?: { type?: 'delegate' | 'cron_run' }) {
      const wi = makeWorkItem({ type: opts?.type ?? 'delegate' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      await service.submitForVerification(wi.id, 'agent', { output: 'draft' });
      return wi;
    }

    it('transitions done_by_worker → verified for a team_lead actor', async () => {
      const wi = await makeAwaitingVerification();

      const updated = await service.verifyItem(wi.id, 'team_lead', 'verified');

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('verified');
    });

    it('transitions done_by_worker → rejected for a team_lead actor with a reviewer comment', async () => {
      const wi = await makeAwaitingVerification();

      const updated = await service.verifyItem(wi.id, 'team_lead', 'rejected', 'Output incomplete');

      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('rejected');
      // Reviewer comment surfaced via the existing `error` field — see JSDoc
      expect(updated!.error).toBe('Output incomplete');
    });

    it('rejects an agent actor calling verifyItem (workers cannot self-verify)', async () => {
      const wi = await makeAwaitingVerification();

      await expect(service.verifyItem(wi.id, 'agent', 'verified'))
        .rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('rejects an invalid verdict before touching the state machine', async () => {
      const wi = await makeAwaitingVerification();

      await expect(
        service.verifyItem(wi.id, 'team_lead', 'cancelled' as 'verified'),
      ).rejects.toThrow(/Invalid verdict/);
    });

    it('promotes blocked dependents on verified (terminal-success unblocks waiters)', async () => {
      const upstream = makeWorkItem({ type: 'delegate' });
      const downstream = makeWorkItem({ type: 'cron_run', dependsOn: [upstream.id] });
      await service.addToPool(upstream);
      await service.addToPool(downstream);
      await service.claimFromPool('agent-leo');
      await service.submitForVerification(upstream.id, 'agent');

      await service.verifyItem(upstream.id, 'team_lead', 'verified');

      const downstreamAfter = (await service.getAllItems()).find((wi) => wi.id === downstream.id);
      expect(downstreamAfter?.status).toBe('queued');
    });

    it('rejects a verdict on an item that is not in done_by_worker (state-machine gate)', async () => {
      const wi = makeWorkItem({ type: 'delegate' });
      await service.addToPool(wi);
      // never claimed / submitted — still queued

      await expect(service.verifyItem(wi.id, 'team_lead', 'verified'))
        .rejects.toThrow(/Invalid status transition/);
    });

    // ---------------------------------------------------------------------
    // F1-BRIDGE-1: task:rejected publish hook
    // ---------------------------------------------------------------------

    describe('task:rejected publish (F1-BRIDGE-1)', () => {
      it('publishes task:rejected exactly once on a rejected verdict, with workItemId + correlation fields', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        // Wire the bus AFTER the setup helper so we don't capture the
        // workitem:queued + task:done_by_worker events from the seeding
        // submitForVerification call. We're isolating the verifyItem
        // publish here.
        const wi = await makeAwaitingVerification();
        service.setEventBusService(fakeBus);

        await service.verifyItem(wi.id, 'team_lead', 'rejected', 'Output incomplete');

        const rejectEvents = publishCalls.filter((e) => e.type === 'task:rejected');
        expect(rejectEvents).toHaveLength(1);
        expect(rejectEvents[0].workItemId).toBe(wi.id);
        expect(rejectEvents[0].previousValue).toBe('done_by_worker');
        expect(rejectEvents[0].newValue).toBe('rejected');
        // Deterministic event id (dedup contract).
        expect(rejectEvents[0].id).toBe(`task:rejected:${wi.id}`);
      });

      it('does NOT publish task:rejected on the verified branch (success path is bridge-silent)', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        const wi = await makeAwaitingVerification();
        service.setEventBusService(fakeBus);

        await service.verifyItem(wi.id, 'team_lead', 'verified');

        const rejectEvents = publishCalls.filter((e) => e.type === 'task:rejected');
        expect(rejectEvents).toHaveLength(0);
      });

      it('does NOT publish task:rejected when the transition throws (state-machine gate)', async () => {
        const publishCalls: any[] = [];
        const fakeBus = {
          publish: jest.fn((event: any) => publishCalls.push(event)),
        } as any;
        service.setEventBusService(fakeBus);

        const wi = makeWorkItem({ type: 'delegate' });
        await service.addToPool(wi);
        // Never claimed / submitted — verifyItem on a queued item must throw.
        await expect(service.verifyItem(wi.id, 'team_lead', 'rejected'))
          .rejects.toThrow(/Invalid status transition/);

        const rejectEvents = publishCalls.filter((e) => e.type === 'task:rejected');
        expect(rejectEvents).toHaveLength(0);
      });

      it('does NOT publish task:rejected when no EventBus is wired (legacy/test path)', async () => {
        const wi = await makeAwaitingVerification();
        // No setEventBusService — eventBus stays null, verifyItem must not throw.
        await expect(
          service.verifyItem(wi.id, 'team_lead', 'rejected', 'no-bus-test'),
        ).resolves.not.toBeNull();
      });

      it('isolates EventBus.publish errors from the rejection transition (state commit wins)', async () => {
        const fakeBus = {
          publish: jest.fn((event: any) => {
            if (event.type === 'task:rejected') {
              throw new Error('bus blew up');
            }
          }),
        } as any;
        const wi = await makeAwaitingVerification();
        service.setEventBusService(fakeBus);

        const updated = await service.verifyItem(
          wi.id,
          'team_lead',
          'rejected',
          'reviewer comment',
        );

        // Transition committed even though the bus threw.
        expect(updated).not.toBeNull();
        expect(updated!.status).toBe('rejected');
      });
    });
  });

  // -----------------------------------------------------------------------
  // failItem
  // -----------------------------------------------------------------------

  describe('failItem', () => {
    it('marks item as failed with error', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.failItem(wi.id, 'agent crashed');

      const items = await service.getAllItems();
      expect(items[0].status).toBe('failed');
      expect(items[0].error).toBe('agent crashed');
    });

    it('throws when item not found', async () => {
      await expect(service.failItem('ghost', 'error')).rejects.toThrow(
        'WorkItem not found',
      );
    });
  });

  // -----------------------------------------------------------------------
  // getPoolStatus
  // -----------------------------------------------------------------------

  describe('getPoolStatus', () => {
    it('returns correct snapshot for empty pool', async () => {
      const status = await service.getPoolStatus();
      expect(status.total).toBe(0);
      expect(status.available).toBe(0);
      expect(status.claimed).toBe(0);
      expect(status.avgWaitTimeMs).toBe(0);
    });

    it('counts available and claimed correctly', async () => {
      const wi1 = makeWorkItem({ title: 'One' });
      const wi2 = makeWorkItem({ title: 'Two' });
      const wi3 = makeWorkItem({ title: 'Three' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);
      await service.addToPool(wi3);

      await service.claimFromPool('agent-leo');

      const status = await service.getPoolStatus();
      expect(status.total).toBe(3);
      expect(status.available).toBe(2);
      expect(status.claimed).toBe(1);
    });

    it('computes average wait time', async () => {
      const wi = makeWorkItem();
      wi.createdAt = new Date(Date.now() - 5000).toISOString();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const status = await service.getPoolStatus();
      expect(status.avgWaitTimeMs).toBeGreaterThan(0);
    });

    it('breaks down by type and status', async () => {
      const wi1 = makeWorkItem({ type: 'delegate' });
      const wi2 = makeWorkItem({ type: 'check' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const status = await service.getPoolStatus();
      expect(status.byType['delegate']).toBe(1);
      expect(status.byType['check']).toBe(1);
      expect(status.byStatus['queued']).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // getAvailableItems
  // -----------------------------------------------------------------------

  describe('getAvailableItems', () => {
    it('returns only unclaimed queued items', async () => {
      const wi1 = makeWorkItem({ title: 'Available' });
      const wi2 = makeWorkItem({ title: 'Claimed' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);
      await service.claimFromPool('agent-leo');

      const available = await service.getAvailableItems();
      expect(available).toHaveLength(1);
    });

    it('respects filters', async () => {
      const wi1 = makeWorkItem({ type: 'delegate' });
      const wi2 = makeWorkItem({ type: 'check' });
      await service.addToPool(wi1);
      await service.addToPool(wi2);

      const available = await service.getAvailableItems({ types: ['check'] });
      expect(available).toHaveLength(1);
      expect(available[0].type).toBe('check');
    });
  });

  // -----------------------------------------------------------------------
  // Singleton
  // -----------------------------------------------------------------------

  describe('singleton', () => {
    it('returns same instance', () => {
      const a = TaskPoolService.getInstance();
      const b = TaskPoolService.getInstance();
      expect(a).toBe(b);
      TaskPoolService.resetInstance();
    });

    it('resets instance', () => {
      const a = TaskPoolService.getInstance();
      TaskPoolService.resetInstance();
      const b = TaskPoolService.getInstance();
      expect(a).not.toBe(b);
      TaskPoolService.resetInstance();
    });
  });

  // -----------------------------------------------------------------------
  // P1 1ffffb84(a) — removeFromPool (bulk-DELETE entry)
  // -----------------------------------------------------------------------

  describe('removeFromPool (P1 1ffffb84 component a)', () => {
    it('removes an unclaimed WorkItem from the pool', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      const result = await service.removeFromPool(wi.id);
      expect(result.removed).toBe(true);
      expect(result.workItem?.id).toBe(wi.id);
      expect(result.hadActiveClaim).toBe(false);

      // Item is gone from disk + memory.
      const after = await service.findWorkItem(wi.id);
      expect(after).toBeNull();
    });

    it('is idempotent on a missing id (returns reason=not_found)', async () => {
      const result = await service.removeFromPool('does-not-exist');
      expect(result.removed).toBe(false);
      expect(result.reason).toBe('not_found');
      expect(result.workItem).toBeUndefined();
    });

    it('is idempotent on second call after a successful delete', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      const first = await service.removeFromPool(wi.id);
      expect(first.removed).toBe(true);

      const second = await service.removeFromPool(wi.id);
      expect(second.removed).toBe(false);
      expect(second.reason).toBe('not_found');
    });

    it('refuses to delete a claimed WorkItem without force (throws WorkItemClaimedError)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const claim = await service.claimFromPool('agent-leo');
      expect(claim).not.toBeNull();

      let caught: unknown;
      try {
        await service.removeFromPool(wi.id);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(WorkItemClaimedError);
      const e = caught as WorkItemClaimedError;
      expect(e.workItemId).toBe(wi.id);
      expect(e.claimedBy).toBe('agent-leo');
      expect(e.claimId).toBe(claim!.claim.id);

      // No mutation: WI still exists with active claim.
      const stillThere = await service.findWorkItem(wi.id);
      expect(stillThere).not.toBeNull();
      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(1);
    });

    it('deletes a claimed WorkItem when force=true (revokes claim)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const claim = await service.claimFromPool('agent-leo');
      expect(claim).not.toBeNull();

      const result = await service.removeFromPool(wi.id, { force: true });
      expect(result.removed).toBe(true);
      expect(result.hadActiveClaim).toBe(true);

      // WI gone, active claims drained.
      expect(await service.findWorkItem(wi.id)).toBeNull();
      const activeClaims = await service.getActiveClaims();
      expect(activeClaims).toHaveLength(0);
    });

    it('exposes structured fields on WorkItemClaimedError', () => {
      const err = new WorkItemClaimedError({
        workItemId: 'wi-1',
        claimId: 'claim-1',
        claimedBy: 'agent-x',
      });
      expect(err.workItemId).toBe('wi-1');
      expect(err.claimId).toBe('claim-1');
      expect(err.claimedBy).toBe('agent-x');
      expect(err.name).toBe('WorkItemClaimedError');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(WorkItemClaimedError);
      expect(err.message).toContain('wi-1');
      expect(err.message).toContain('claim-1');
      expect(err.message).toContain('agent-x');
    });
  });

  // -----------------------------------------------------------------------
  // getActiveClaims (V3 integration)
  // -----------------------------------------------------------------------

  describe('getActiveClaims', () => {
    it('returns active claims after claiming', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].agentId).toBe('agent-leo');
      expect(claims[0].status).toBe('active');
    });

    it('returns empty when no claims', async () => {
      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(0);
    });

    it('excludes released claims', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      await service.completeItem(wi.id);

      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // updateItemStatus (V3 integration — used by Reconciler)
  // -----------------------------------------------------------------------

  describe('updateItemStatus', () => {
    it('updates running item to blocked', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');

      await service.updateItemStatus(wi.id, 'blocked');

      const items = await service.getAllItems();
      const updated = items.find(i => i.id === wi.id);
      expect(updated!.status).toBe('blocked');
    });

    it('throws for nonexistent item', async () => {
      await expect(service.updateItemStatus('ghost-id', 'blocked'))
        .rejects.toThrow('WorkItem not found');
    });

    it('throws for invalid transition', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);

      // queued → done is not a valid direct transition
      await expect(service.updateItemStatus(wi.id, 'done'))
        .rejects.toThrow('Invalid status transition');
    });
  });

  // -----------------------------------------------------------------------
  // markClaimExpiring (V3 integration — used by Reconciler)
  // -----------------------------------------------------------------------

  describe('markClaimExpiring', () => {
    it('marks an active claim as expiring', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const result = await service.claimFromPool('agent-leo');
      expect(result).not.toBeNull();

      await service.markClaimExpiring(result!.claim.id);

      // Claim should now be 'expiring' — verify via getActiveClaims
      // (expiring claims are still considered active for reconciliation)
      const claims = await service.getActiveClaims();
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('expiring');
    });
  });

  // =========================================================================
  // TRANS-1: transitionStatus + role-based permission enforcement (V3)
  // =========================================================================

  describe('transitionStatus — TRANS-1 V3 enforcement', () => {
    /**
     * Helper: add a WorkItem to the pool and claim it so it reaches 'running'
     * status, mirroring the steady-state of an in-flight task. Used by the
     * verification gate tests.
     */
    async function makeRunning(): Promise<{ id: string; agent: string }> {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const result = await service.claimFromPool('agent-test');
      expect(result).not.toBeNull();
      return { id: result!.workItem.id, agent: 'agent-test' };
    }

    it('throws when WorkItem does not exist', async () => {
      await expect(
        service.transitionStatus('does-not-exist', 'done', 'system'),
      ).rejects.toThrow(/WorkItem not found/);
    });

    it('throws on illegal state-machine transition (e.g. done → running)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-test');
      // Drive to terminal 'done' first via the legitimate path.
      await service.transitionStatus(wi.id, 'done', 'system');
      // Now attempt to revert — disallowed by WORK_ITEM_TRANSITIONS.
      await expect(
        service.transitionStatus(wi.id, 'running', 'system'),
      ).rejects.toThrow(/Invalid status transition/);
    });

    it('agent CANNOT verify their own work (running → verified blocked for agent)', async () => {
      const { id } = await makeRunning();
      // Move to done_by_worker via agent — this is allowed.
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      // Attempt agent self-verification — must throw.
      await expect(
        service.transitionStatus(id, 'verified', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('team_lead CAN verify worker output (done_by_worker → verified)', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      const verified = await service.transitionStatus(id, 'verified', 'team_lead');
      expect(verified).not.toBeNull();
      expect(verified!.status).toBe('verified');
    });

    it('team_lead CAN reject worker output with custom mutator carrying the error', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      const rejected = await service.transitionStatus(id, 'rejected', 'team_lead', (wi) => {
        wi.error = 'Did not meet acceptance criteria';
      });
      expect(rejected!.status).toBe('rejected');
      expect(rejected!.error).toBe('Did not meet acceptance criteria');
    });

    // -----------------------------------------------------------------------
    // F-F: rejected → queued is gated to TL/orchestrator/system only
    // -----------------------------------------------------------------------

    it('F-F: agent CANNOT self-revive a rejected WorkItem (rejected → queued)', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      // Attempt agent self-revival — must throw per F-F.
      await expect(
        service.transitionStatus(id, 'queued', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('F-F: team_lead CAN re-queue a rejected WorkItem', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      const requeued = await service.transitionStatus(id, 'queued', 'team_lead');
      expect(requeued!.status).toBe('queued');
    });

    it('F-F: orchestrator CAN re-queue a rejected WorkItem', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      const requeued = await service.transitionStatus(id, 'queued', 'orchestrator');
      expect(requeued!.status).toBe('queued');
    });

    it('F-F: system actor (Reconciler) CAN re-queue a rejected WorkItem', async () => {
      const { id } = await makeRunning();
      await service.transitionStatus(id, 'done_by_worker', 'agent');
      await service.transitionStatus(id, 'rejected', 'team_lead');
      const requeued = await service.transitionStatus(id, 'queued', 'system');
      expect(requeued!.status).toBe('queued');
    });

    it('F-F: agent CANNOT self-revive a failed WorkItem (failed → queued)', async () => {
      const { id } = await makeRunning();
      // Move to failed via the existing failItem path.
      await service.failItem(id, 'simulated failure');
      // Attempt agent self-revival — must throw per F-F.
      await expect(
        service.transitionStatus(id, 'queued', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });

    it('system actor passes through any legal transition (Reconciler exemption)', async () => {
      const { id } = await makeRunning();
      // Reconciler stuck-running corrective: running → blocked.
      const blocked = await service.transitionStatus(id, 'blocked', 'system');
      expect(blocked!.status).toBe('blocked');
    });

    // -----------------------------------------------------------------------
    // mutator atomicity
    // -----------------------------------------------------------------------

    it('mutator runs atomically with the status update', async () => {
      const { id } = await makeRunning();
      const updated = await service.transitionStatus(id, 'done', 'system', (wi) => {
        wi.result = { reportPath: '/tmp/done.md' };
        wi.cost = 0.42;
      });
      expect(updated!.status).toBe('done');
      expect(updated!.result).toEqual({ reportPath: '/tmp/done.md' });
      expect(updated!.cost).toBe(0.42);
      expect(updated!.completedAt).toBeDefined();
    });

    it('refreshes startedAt on transition into running', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const before = new Date().toISOString();
      const updated = await service.transitionStatus(wi.id, 'running', 'system');
      expect(updated!.status).toBe('running');
      expect(updated!.startedAt).toBeDefined();
      expect(updated!.startedAt! >= before).toBe(true);
    });
  });

  // =========================================================================
  // TRANS-1: updateItemStatus actor-role gate (Reconciler legacy entry)
  // =========================================================================

  describe('updateItemStatus — TRANS-1 V3 actor gate', () => {
    it('defaults actorRole to "system" when omitted (Reconciler default)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      // No third arg — defaults to system per backwards compat.
      await service.updateItemStatus(wi.id, 'running');
      const items = await service.getAvailableItems();
      // Legacy callers continue to work unchanged.
      expect(items.find((x) => x.id === wi.id)).toBeUndefined(); // no longer queued
    });

    it('rejects an agent attempting an unauthorised transition via updateItemStatus', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-test');
      // agent moves to done_by_worker (allowed).
      await service.updateItemStatus(wi.id, 'done_by_worker', 'agent');
      // agent now attempts to verify themselves — must throw.
      await expect(
        service.updateItemStatus(wi.id, 'verified', 'agent'),
      ).rejects.toThrow(/Forbidden transition.*actor='agent'/);
    });
  });

  // =========================================================================
  // TRANS-2: internal call sites route through transitionStatus(actor='system')
  //
  // Each test wraps `transitionStatus` on the prototype (so calls dispatched
  // via `this.transitionStatus` from sibling methods like
  // `completeSimpleItem` → `resolveBlockedDependents` are also captured) and
  // asserts the expected (workItemId, newStatus, actorRole) tuple appears.
  // This is the compile-time guard against a future contributor silently
  // restoring a direct `storage.updateWorkItem` mutation that would bypass
  // the V3 actor gate.
  // =========================================================================

  describe('TRANS-2: internal sites route through transitionStatus(actor="system")', () => {
    /**
     * Patch `transitionStatus` on the TaskPoolService prototype so every
     * invocation is captured as a tuple of [workItemId, newStatus, actorRole].
     * Patching the prototype (rather than a single instance own-property) is
     * required because some internal callers (e.g. `resolveBlockedDependents`)
     * dispatch through `this.transitionStatus` from sibling methods, and
     * Jest's `spyOn(instance, 'method')` mock with `mockImplementation` does
     * not always intercept those dispatches. The original implementation is
     * still invoked unchanged so tests assert the call shape AND end-to-end
     * behaviour together.
     */
    function spyTransitionStatus(): {
      calls: Array<[string, string, string]>;
      restore: () => void;
    } {
      const calls: Array<[string, string, string]> = [];
      const proto = TaskPoolService.prototype as TaskPoolService;
      const original = proto.transitionStatus;
      proto.transitionStatus = async function (
        this: TaskPoolService,
        workItemId: string,
        newStatus: Parameters<TaskPoolService['transitionStatus']>[1],
        actorRole: Parameters<TaskPoolService['transitionStatus']>[2],
        mutator?: Parameters<TaskPoolService['transitionStatus']>[3],
      ) {
        calls.push([workItemId, newStatus, actorRole]);
        return original.call(this, workItemId, newStatus, actorRole, mutator);
      };
      return {
        calls,
        restore: () => {
          proto.transitionStatus = original;
        },
      };
    }

    it('claimFromPool calls transitionStatus(queued→running, system)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const { calls, restore } = spyTransitionStatus();
      try {
        const result = await service.claimFromPool('agent-leo');
        expect(result).not.toBeNull();
        expect(calls).toContainEqual([wi.id, 'running', 'system']);
      } finally {
        restore();
      }
    });

    it('claimSpecificItem calls transitionStatus(queued→running, system)', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      const { calls, restore } = spyTransitionStatus();
      try {
        const result = await service.claimSpecificItem('agent-leo', wi.id);
        expect(result).not.toBeNull();
        expect(calls).toContainEqual([wi.id, 'running', 'system']);
      } finally {
        restore();
      }
    });

    it('releaseBack from running calls transitionStatus(running→queued, system) with retryCount bump', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      const { calls, restore } = spyTransitionStatus();
      try {
        await service.releaseBack(wi.id, 'agent busy');
        expect(calls).toContainEqual([wi.id, 'queued', 'system']);

        // Verify side-effect mutator ran atomically with the status flip.
        const items = await service.getAllItems();
        const released = items.find((i) => i.id === wi.id)!;
        expect(released.status).toBe('queued');
        expect(released.retryCount).toBe(1);
        expect(released.startedAt).toBeUndefined();
      } finally {
        restore();
      }
    });

    it('releaseBack from blocked preserves target via mutator', async () => {
      const wi = makeWorkItem({ target: 'agent-leo' });
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      // Force the running item to blocked so releaseBack hits the
      // blocked → queued branch (which already had a TRANS-1 permission
      // entry; this test confirms the same path now flows through the
      // shared transitionStatus helper).
      await service.updateItemStatus(wi.id, 'blocked');
      const { calls, restore } = spyTransitionStatus();
      try {
        await service.releaseBack(wi.id, 'dependency stalled');
        expect(calls).toContainEqual([wi.id, 'queued', 'system']);

        const items = await service.getAllItems();
        const released = items.find((i) => i.id === wi.id)!;
        expect(released.status).toBe('queued');
        // Target preserved for the previously-blocked path so the same
        // agent can re-claim via target filter.
        expect(released.target).toBe('agent-leo');
      } finally {
        restore();
      }
    });

    it('resolveBlockedDependents calls transitionStatus(blocked→queued, system)', async () => {
      const upstream = makeWorkItem({ type: 'cron_run', title: 'upstream' });
      await service.addToPool(upstream);
      const downstream = makeWorkItem({
        type: 'cron_run',
        title: 'downstream',
        dependsOn: [upstream.id],
      });
      await service.addToPool(downstream);
      // Drive the upstream to running so it can complete.
      await service.claimFromPool('agent-a');

      const { calls, restore } = spyTransitionStatus();
      try {
        await service.completeItem(upstream.id);
        // The resolver fires inside completeSimpleItem after the
        // upstream completes; we expect a blocked→queued promotion for
        // the downstream item with system actor.
        expect(calls).toContainEqual([downstream.id, 'queued', 'system']);
      } finally {
        restore();
      }
    });

    it('failItem calls transitionStatus(running→failed, system) with error in mutator', async () => {
      const wi = makeWorkItem();
      await service.addToPool(wi);
      await service.claimFromPool('agent-leo');
      const { calls, restore } = spyTransitionStatus();
      try {
        await service.failItem(wi.id, 'agent crashed');
        expect(calls).toContainEqual([wi.id, 'failed', 'system']);

        const items = await service.getAllItems();
        const failed = items.find((i) => i.id === wi.id)!;
        expect(failed.status).toBe('failed');
        expect(failed.error).toBe('agent crashed');
        expect(failed.completedAt).toBeDefined();
      } finally {
        restore();
      }
    });
  });

  // -----------------------------------------------------------------------
  // P1 1ffffb84 component (b): atomic-transition invariant
  //
  // The b7840fe8 partial-write bug: WorkItem b7840fe8 was observed in
  // pool.json with status='queued' AND completedAt='2026-05-06T00:47:59Z'
  // AND retryCount=1 AND no startedAt/target — fingerprint of the
  // `failed -> queued` retry path leaving a stale completedAt from the
  // prior terminal trip.
  //
  // Root cause: transitionStatus + updateItemStatus only SET completedAt
  // on terminal landings; non-terminal landings (queued, blocked, ...)
  // had no else branch to CLEAR it. So `rejected -> queued`,
  // `failed -> queued`, and `running -> queued` (releaseBack) all left
  // disagreeing fields.
  //
  // Fix invariant: completedAt is set IFF status in {done, failed,
  // verified, done_by_worker, rejected}. Pinned by these tests.
  // -----------------------------------------------------------------------
  describe('atomic transition invariant (P1 1ffffb84 component b)', () => {
    async function makeFailedWi() {
      const wi = makeWorkItem({ requestId: 'req-bug-fix' });
      await service.addToPool(wi);
      await service.transitionStatus(wi.id, 'running', 'system');
      await service.transitionStatus(wi.id, 'failed', 'system', (m) => {
        m.error = 'simulated upstream failure';
      });
      const after = await service.findWorkItem(wi.id);
      expect(after?.status).toBe('failed');
      expect(after?.completedAt).toBeDefined();
      return wi;
    }

    it('transitionStatus(failed -> queued) atomically clears completedAt (BRIDGE-1 retry path)', async () => {
      const wi = await makeFailedWi();
      await service.transitionStatus(wi.id, 'queued', 'system');
      const after = await service.findWorkItem(wi.id);
      expect(after?.status).toBe('queued');
      // CRITICAL: pre-fix this would have been the failed-state timestamp,
      // post-fix the explicit else branch clears it atomically.
      expect(after?.completedAt).toBeUndefined();
    });

    it('transitionStatus(rejected -> queued) atomically clears completedAt (TL re-queue path)', async () => {
      const wi = makeWorkItem({ requestId: 'req-rejected' });
      await service.addToPool(wi);
      await service.transitionStatus(wi.id, 'running', 'system');
      await service.transitionStatus(wi.id, 'done_by_worker', 'agent', (m) => {
        m.result = { ok: true };
      });
      await service.transitionStatus(wi.id, 'rejected', 'team_lead', (m) => {
        m.error = 'TL did not accept';
      });
      const rejected = await service.findWorkItem(wi.id);
      expect(rejected?.status).toBe('rejected');
      expect(rejected?.completedAt).toBeDefined();

      await service.transitionStatus(wi.id, 'queued', 'team_lead');

      const after = await service.findWorkItem(wi.id);
      expect(after?.status).toBe('queued');
      expect(after?.completedAt).toBeUndefined();
    });

    it('transitionStatus(queued -> running) clears stale completedAt on re-claim', async () => {
      const wi = await makeFailedWi();
      await service.transitionStatus(wi.id, 'queued', 'system');
      const beforeClaim = await service.findWorkItem(wi.id);
      expect(beforeClaim?.completedAt).toBeUndefined();

      await service.transitionStatus(wi.id, 'running', 'system');

      const after = await service.findWorkItem(wi.id);
      expect(after?.status).toBe('running');
      expect(after?.startedAt).toBeDefined();
      expect(after?.completedAt).toBeUndefined();
    });

    it('atomicity: invalid transition throws and BOTH status + completedAt remain unchanged', async () => {
      const wi = await makeFailedWi();
      const before = await service.findWorkItem(wi.id);
      const beforeStatus = before!.status;
      const beforeCompletedAt = before!.completedAt;

      await expect(
        service.transitionStatus(wi.id, 'done', 'system'),
      ).rejects.toThrow(/Invalid status transition/);

      const after = await service.findWorkItem(wi.id);
      expect(after?.status).toBe(beforeStatus);
      expect(after?.completedAt).toBe(beforeCompletedAt);
    });

    it('integration repro (b7840fe8 timeline): running -> failed -> queued ends with completedAt cleared', async () => {
      const wi = makeWorkItem({ requestId: 'req-b7840fe8-repro' });
      await service.addToPool(wi);

      await service.transitionStatus(wi.id, 'running', 'system');
      const running = await service.findWorkItem(wi.id);
      expect(running?.startedAt).toBeDefined();
      expect(running?.completedAt).toBeUndefined();

      await service.transitionStatus(wi.id, 'failed', 'system', (m) => {
        m.error = 'simulated';
      });
      const failed = await service.findWorkItem(wi.id);
      expect(failed?.status).toBe('failed');
      expect(failed?.completedAt).toBeDefined();

      await service.transitionStatus(wi.id, 'queued', 'system');

      const after = await service.findWorkItem(wi.id);
      // POST-FIX assertion — pre-fix this would carry the failed-state
      // timestamp, matching b7840fe8's exact shape.
      expect(after?.status).toBe('queued');
      expect(after?.completedAt).toBeUndefined();
    });

    it('updateItemStatus path also enforces the invariant on non-terminal landings', async () => {
      const wi = makeWorkItem({ requestId: 'req-update-item' });
      await service.addToPool(wi);
      await service.updateItemStatus(wi.id, 'running');
      await service.updateItemStatus(wi.id, 'failed');
      const failed = await service.findWorkItem(wi.id);
      expect(failed?.completedAt).toBeDefined();

      await service.updateItemStatus(wi.id, 'queued');
      const requeued = await service.findWorkItem(wi.id);
      expect(requeued?.status).toBe('queued');
      expect(requeued?.completedAt).toBeUndefined();
    });

    it('coverage: every retry/re-queue source clears completedAt when reaching queued', async () => {
      const sources: Array<{
        name: string;
        actor: 'system' | 'team_lead';
        build: () => Promise<{ id: string }>;
      }> = [
        {
          name: 'failed -> queued',
          actor: 'system',
          build: async () => {
            const w = makeWorkItem({ requestId: 'cov-failed' });
            await service.addToPool(w);
            await service.transitionStatus(w.id, 'running', 'system');
            await service.transitionStatus(w.id, 'failed', 'system');
            return w;
          },
        },
        {
          name: 'rejected -> queued',
          actor: 'team_lead',
          build: async () => {
            const w = makeWorkItem({ requestId: 'cov-rejected' });
            await service.addToPool(w);
            await service.transitionStatus(w.id, 'running', 'system');
            await service.transitionStatus(w.id, 'done_by_worker', 'agent');
            await service.transitionStatus(w.id, 'rejected', 'team_lead');
            return w;
          },
        },
        {
          name: 'running -> queued (releaseBack-equivalent)',
          actor: 'system',
          build: async () => {
            const w = makeWorkItem({ requestId: 'cov-running' });
            await service.addToPool(w);
            await service.transitionStatus(w.id, 'running', 'system');
            return w;
          },
        },
      ];

      for (const s of sources) {
        const w = await s.build();
        await service.transitionStatus(w.id, 'queued', s.actor);
        const after = await service.findWorkItem(w.id);
        expect(after?.status).toBe('queued');
        expect(after?.completedAt).toBeUndefined();
      }
    });
  });
});
