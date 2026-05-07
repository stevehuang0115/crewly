/**
 * Tests for RequestService — CRUD operations for V3 Request entities.
 *
 * @module services/v3/request.service.test
 */

import {
  RequestService,
  setRequestServiceEventBus,
  RequestStillHasOpenChildrenError,
  type RequestPlan,
  type IWorkItemQueryable,
} from './request.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import { createWorkItem, type WorkItem, type WorkItemStatus } from '../../types/v2/work-item.types.js';

// Mock file I/O
const mockFiles = new Map<string, string>();

jest.mock('fs/promises', () => ({
  readdir: jest.fn().mockImplementation(async () => {
    const entries: string[] = [];
    for (const key of mockFiles.keys()) {
      const filename = key.split('/').pop() || '';
      if (filename.endsWith('.json')) entries.push(filename);
    }
    return entries;
  }),
}));

jest.mock('../../utils/file-io.utils.js', () => ({
  ensureDir: jest.fn().mockResolvedValue(undefined),
  atomicWriteJson: jest.fn().mockImplementation(async (filePath: string, data: unknown) => {
    mockFiles.set(filePath, JSON.stringify(data));
  }),
  safeReadJson: jest.fn().mockImplementation(async (filePath: string, fallback: unknown) => {
    const content = mockFiles.get(filePath);
    if (!content) return fallback;
    return JSON.parse(content);
  }),
}));

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

describe('RequestService', () => {
  beforeEach(() => {
    RequestService.resetInstance();
    mockFiles.clear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a Request with valid input', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const request = await service.create({
        sourceConversationItemId: 'conv-123',
        title: 'Deploy to staging',
        description: 'Deploy the current build to the staging environment',
        // Pin classification so the test asserts CRUD semantics, not the
        // auto-classify fallback (covered by its own test below).
        intentLevel: 'L1',
        intentCategory: 'other',
      });

      expect(request.id).toBeDefined();
      expect(request.title).toBe('Deploy to staging');
      expect(request.status).toBe('open');
      expect(request.priority).toBe('normal');
      expect(request.intentLevel).toBe('L1');
      expect(request.workItemIds).toEqual([]);
    });

    it('auto-classifies intent when caller omits intentLevel/intentCategory', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      // "Deploy ... staging environment" matches the L2 deploy/env trigger
      // and the deployment category. Without the auto-classify backstop,
      // this would default to L1+other and request-decompose.subscriber
      // would silently skip auto-decomposition — the original Slack→0WIs bug.
      const request = await service.create({
        sourceConversationItemId: 'conv-auto-classify',
        title: 'Deploy to staging',
        description: 'Deploy the current build to the staging environment',
      });

      expect(request.intentLevel).toBe('L2');
      expect(request.intentCategory).toBe('deployment');
    });

    it('preserves explicit intent values when caller provides them', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      // Caller knows better — e.g. an agent pre-classified upstream.
      // The service must NOT overwrite explicit values with the heuristic.
      const request = await service.create({
        sourceConversationItemId: 'conv-explicit',
        title: 'something',
        description: 'Deploy the current build to the staging environment',
        intentLevel: 'L1',
        intentCategory: 'communication',
      });

      expect(request.intentLevel).toBe('L1');
      expect(request.intentCategory).toBe('communication');
    });

    it('should throw on invalid input', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      await expect(
        service.create({
          sourceConversationItemId: '',
          title: '',
          description: 'test',
        }),
      ).rejects.toThrow('Invalid CreateRequestInput');
    });

    // -----------------------------------------------------------------------
    // INBOUND-1: request:created event publication
    // -----------------------------------------------------------------------

    describe('request:created event (INBOUND-1)', () => {
      /**
       * Build a fake EventBusService that captures publish() calls. The fake
       * implements only the surface RequestService touches — no inheritance
       * required.
       */
      function buildFakeBus(opts?: { throwOnPublish?: boolean }): {
        bus: EventBusService;
        published: AgentEvent[];
      } {
        const published: AgentEvent[] = [];
        const bus = {
          publish: jest.fn((event: AgentEvent) => {
            if (opts?.throwOnPublish) throw new Error('bus failure');
            published.push(event);
          }),
        } as unknown as EventBusService;
        return { bus, published };
      }

      afterEach(() => {
        // Clear any wired bus so suite-level isolation holds.
        setRequestServiceEventBus(null);
      });

      it('publishes request:created with the correct shape after save', async () => {
        const { bus, published } = buildFakeBus();
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        const request = await service.create({
          sourceConversationItemId: 'slack-C123-1',
          title: 'Help with Slack',
          description: 'A user message',
          tags: ['slack'],
        });

        expect(published).toHaveLength(1);
        const event = published[0];
        expect(event.type).toBe('request:created');
        expect(event.id).toBe(`request:created:${request.id}`);
        expect(event.requestId).toBe(request.id);
        expect(event.newValue).toBe('open');
        expect(event.previousValue).toBe('');
        expect(event.timestamp).toBe(request.createdAt);
        // changedField uses the existing 'taskStatus' enum member; spelled out
        // in publishCreatedEvent's inline comment to discourage churn.
        expect(event.changedField).toBe('taskStatus');
      });

      it('silently skips publish when no bus is wired', async () => {
        // No setRequestServiceEventBus call — wired bus stays null.
        const service = RequestService.getInstance('/tmp/test-project');
        const request = await service.create({
          sourceConversationItemId: 'conv-no-bus',
          title: 'No bus available',
          description: 'Should still persist',
        });

        // Persistence still succeeded.
        expect(request.id).toBeDefined();
        expect(request.status).toBe('open');
      });

      it('does not roll back the create when bus.publish throws', async () => {
        const { bus } = buildFakeBus({ throwOnPublish: true });
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        const request = await service.create({
          sourceConversationItemId: 'conv-publish-err',
          title: 'Publish will throw',
          description: 'But the Request must persist',
        });

        // The Request is persisted regardless of the publish failure.
        expect(request.id).toBeDefined();
        expect(request.status).toBe('open');
        const stored = await service.getById(request.id);
        expect(stored).not.toBeNull();
      });

      it('forwards missionId on the event when present on the Request', async () => {
        const { bus, published } = buildFakeBus();
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        await service.create({
          sourceConversationItemId: 'conv-mission',
          title: 'Mission-tied',
          description: 'Linked to a mission',
          missionId: 'mission-42',
        });

        expect(published[0].missionId).toBe('mission-42');
      });

      it('clears the wired bus when setRequestServiceEventBus(null) is called', async () => {
        const { bus, published } = buildFakeBus();
        setRequestServiceEventBus(bus);

        const service = RequestService.getInstance('/tmp/test-project');
        await service.create({
          sourceConversationItemId: 'conv-1',
          title: 'First',
          description: 'wired',
        });
        expect(published).toHaveLength(1);

        setRequestServiceEventBus(null);
        await service.create({
          sourceConversationItemId: 'conv-2',
          title: 'Second',
          description: 'unwired',
        });
        // No new publish — count stays at 1.
        expect(published).toHaveLength(1);
      });
    });
  });

  describe('getById', () => {
    it('should return null for non-existent request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const result = await service.getById('nonexistent-id');
      expect(result).toBeNull();
    });

    it('should return a previously created request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-456',
        title: 'Test request',
        description: 'A test request',
      });

      const found = await service.getById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.title).toBe('Test request');
    });
  });

  describe('update', () => {
    it('should update request status with valid transition', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-789',
        title: 'Update test',
        description: 'Testing updates',
      });

      const updated = await service.update(created.id, { status: 'ready' });
      expect(updated.status).toBe('ready');
    });

    it('should throw on invalid status transition', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-invalid',
        title: 'Invalid transition test',
        description: 'Testing invalid transition',
      });

      // Transition to done first (terminal state)
      await service.update(created.id, { status: 'done' });

      // done -> running is invalid
      await expect(
        service.update(created.id, { status: 'running' }),
      ).rejects.toThrow('Invalid status transition');
    });

    it('should set completedAt when transitioning to done', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-done',
        title: 'Done test',
        description: 'Testing done transition',
      });

      // Transition: open -> ready -> running -> done
      await service.update(created.id, { status: 'ready' });
      await service.update(created.id, { status: 'running' });
      const done = await service.update(created.id, { status: 'done' });

      expect(done.status).toBe('done');
      expect(done.completedAt).toBeDefined();
    });

    it('should throw when request not found', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      await expect(
        service.update('nonexistent-id', { title: 'nope' }),
      ).rejects.toThrow('Request not found');
    });
  });

  // ===========================================================================
  // P1 Bug C — Request → done lifecycle gate (Pool umbrella WI 72ca743a)
  // ===========================================================================

  describe('update — Request → done lifecycle gate (P1 Bug C)', () => {
    /**
     * Build a fake IWorkItemQueryable backed by an in-memory map. Mirrors
     * the production TaskPoolService.findWorkItem null-fallthrough idiom.
     */
    function buildFakePool(items: WorkItem[]): IWorkItemQueryable {
      const byId = new Map(items.map((wi) => [wi.id, wi]));
      return {
        findWorkItem: jest.fn(async (id: string) => byId.get(id) ?? null),
      };
    }

    /** Build a child WI with a specific status, linked to a Request. */
    function makeChild(requestId: string, status: WorkItemStatus): WorkItem {
      const wi = createWorkItem({
        type: 'delegate',
        owner: 'agent',
        target: 'agent-test',
        title: 'child WI',
        requestId,
      });
      // createWorkItem chooses initial status from inputs; force the test
      // status directly. Bypasses the production transition validator —
      // intentional for unit-level setup so we can stage every state.
      (wi as { status: WorkItemStatus }).status = status;
      return wi;
    }

    /**
     * Walk a Request from its initial `open` to `running`. Done lives only
     * directly off `running` per isValidRequestTransition.
     */
    async function walkToRunning(service: RequestService, requestId: string): Promise<void> {
      await service.update(requestId, { status: 'ready' });
      await service.update(requestId, { status: 'running' });
    }

    // -----------------------------------------------------------------------
    // AC1 — empty workItemIds: backward-compatible historical case
    // -----------------------------------------------------------------------
    it('AC1: should allow Request → done when workItemIds=[] (no children)', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      service.setTaskPoolService(buildFakePool([]));

      const created = await service.create({
        sourceConversationItemId: 'conv-ac1',
        title: 'AC1 — no children',
        description: 'Closing a Request with no children',
      });

      await walkToRunning(service, created.id);
      const done = await service.update(created.id, { status: 'done' });
      expect(done.status).toBe('done');
      expect(done.completedAt).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // AC2 — all children terminal: should succeed
    // -----------------------------------------------------------------------
    it.each([
      ['done'],
      ['verified'],
      ['cancelled'],
    ])('AC2: should allow Request → done when all children are %s (terminal)', async (status) => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: `conv-ac2-${status}`,
        title: `AC2 — ${status}`,
        description: 'Closing with all-terminal children',
      });

      const child1 = makeChild(created.id, status as WorkItemStatus);
      const child2 = makeChild(created.id, status as WorkItemStatus);
      await service.linkWorkItem(created.id, child1.id);
      await service.linkWorkItem(created.id, child2.id);
      service.setTaskPoolService(buildFakePool([child1, child2]));

      await walkToRunning(service, created.id);
      const done = await service.update(created.id, { status: 'done' });
      expect(done.status).toBe('done');
    });

    // -----------------------------------------------------------------------
    // AC3 — non-terminal child blocks closure
    // -----------------------------------------------------------------------
    it.each([
      ['queued'],
      ['running'],
      ['blocked'],
      ['proposed'],
      ['accepted'],
      ['done_by_worker'],
      ['escalated'],
      ['scheduled'],
      ['failed'],     // recoverable per WORK_ITEM_TRANSITIONS — must block
      ['rejected'],   // recoverable per WORK_ITEM_TRANSITIONS — must block
    ])('AC3: should refuse Request → done when child is %s (non-terminal)', async (status) => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: `conv-ac3-${status}`,
        title: `AC3 — ${status}`,
        description: 'Closing with non-terminal child',
      });

      const openChild = makeChild(created.id, status as WorkItemStatus);
      await service.linkWorkItem(created.id, openChild.id);
      service.setTaskPoolService(buildFakePool([openChild]));

      await walkToRunning(service, created.id);

      let caught: unknown;
      try {
        await service.update(created.id, { status: 'done' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestStillHasOpenChildrenError);
      const err = caught as RequestStillHasOpenChildrenError;
      expect(err.requestId).toBe(created.id);
      expect(err.openChildIds).toEqual([openChild.id]);
      expect(err.openChildCount).toBe(1);
      expect(err.message).toContain(created.id);
      expect(err.message).toContain(openChild.id);
    });

    // -----------------------------------------------------------------------
    // AC4 — mixed terminal + non-terminal children: still blocks
    // -----------------------------------------------------------------------
    it('AC4: should refuse Request → done with mixed terminal/non-terminal children', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-ac4',
        title: 'AC4 — mixed',
        description: 'Mixed-state children',
      });

      const doneChild = makeChild(created.id, 'done');
      const verifiedChild = makeChild(created.id, 'verified');
      const queuedChild = makeChild(created.id, 'queued');
      const runningChild = makeChild(created.id, 'running');
      for (const c of [doneChild, verifiedChild, queuedChild, runningChild]) {
        await service.linkWorkItem(created.id, c.id);
      }
      service.setTaskPoolService(
        buildFakePool([doneChild, verifiedChild, queuedChild, runningChild]),
      );

      await walkToRunning(service, created.id);

      let caught: unknown;
      try {
        await service.update(created.id, { status: 'done' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(RequestStillHasOpenChildrenError);
      const e = caught as RequestStillHasOpenChildrenError;
      expect(new Set(e.openChildIds)).toEqual(
        new Set([queuedChild.id, runningChild.id]),
      );
      expect(e.openChildCount).toBe(2);
    });

    // -----------------------------------------------------------------------
    // Edge: Request was NOT mutated when the gate refused
    // -----------------------------------------------------------------------
    it('should NOT mutate Request status when the gate refuses', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-no-mutate',
        title: 'No-mutation guarantee',
        description: 'Verifying the gate is fail-fast pre-mutation',
      });

      const queuedChild = makeChild(created.id, 'queued');
      await service.linkWorkItem(created.id, queuedChild.id);
      service.setTaskPoolService(buildFakePool([queuedChild]));
      await walkToRunning(service, created.id);

      await expect(
        service.update(created.id, { status: 'done' }),
      ).rejects.toBeInstanceOf(RequestStillHasOpenChildrenError);

      // Re-read from disk to confirm no partial mutation slipped through.
      const reloaded = await service.getById(created.id);
      expect(reloaded?.status).toBe('running');
      expect(reloaded?.completedAt).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Edge: gate is `done`-only — `cancelled` may proceed with open children
    // -----------------------------------------------------------------------
    it('should NOT gate Request → cancelled (only done is gated)', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-cancel',
        title: 'Cancel with open child',
        description: 'Cancellation may happen mid-flight',
      });

      const queuedChild = makeChild(created.id, 'queued');
      await service.linkWorkItem(created.id, queuedChild.id);
      service.setTaskPoolService(buildFakePool([queuedChild]));

      const cancelled = await service.update(created.id, { status: 'cancelled' });
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.completedAt).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // Edge: deleted/orphaned children (findWorkItem returns null) treated
    // as harmless — option-a graceful degrade ORC took on historical orphans.
    // -----------------------------------------------------------------------
    it('should treat findWorkItem→null (orphaned/purged child) as terminal', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-orphan',
        title: 'Orphan-handling',
        description: 'Children purged from pool should not deadlock close',
      });

      // Link two ids; pool returns null for both (purged).
      await service.linkWorkItem(created.id, 'orphan-1');
      await service.linkWorkItem(created.id, 'orphan-2');
      service.setTaskPoolService(buildFakePool([]));

      await walkToRunning(service, created.id);
      const done = await service.update(created.id, { status: 'done' });
      expect(done.status).toBe('done');
    });

    // -----------------------------------------------------------------------
    // Edge: graceful degrade when taskPoolService is not wired
    // -----------------------------------------------------------------------
    it('should degrade gracefully (close anyway, log warning) when pool not wired', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // intentionally NOT calling setTaskPoolService — emulate a code path
      // that runs before boot wiring (or a test scaffold).
      const created = await service.create({
        sourceConversationItemId: 'conv-unwired',
        title: 'Unwired gate',
        description: 'Pre-fix behavior preserved when pool unavailable',
      });

      const queuedChild = makeChild(created.id, 'queued');
      await service.linkWorkItem(created.id, queuedChild.id);

      await walkToRunning(service, created.id);
      const done = await service.update(created.id, { status: 'done' });
      // Pre-fix behavior: close succeeds even with non-terminal child,
      // because the gate has no pool to query.
      expect(done.status).toBe('done');
    });

    // -----------------------------------------------------------------------
    // Edge: setTaskPoolService(null) clears the wiring (test isolation)
    // -----------------------------------------------------------------------
    it('should allow setTaskPoolService(null) to clear the wiring', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const created = await service.create({
        sourceConversationItemId: 'conv-clear',
        title: 'Clear-wire test',
        description: 'null setter clears prior wiring',
      });

      const queuedChild = makeChild(created.id, 'queued');
      await service.linkWorkItem(created.id, queuedChild.id);

      // Wire then clear — should fall back to graceful-degrade path.
      service.setTaskPoolService(buildFakePool([queuedChild]));
      service.setTaskPoolService(null);

      await walkToRunning(service, created.id);
      const done = await service.update(created.id, { status: 'done' });
      expect(done.status).toBe('done');
    });
  });

  // ===========================================================================
  // RequestStillHasOpenChildrenError — error class shape
  // ===========================================================================

  describe('RequestStillHasOpenChildrenError', () => {
    it('should expose structured fields on the error instance', () => {
      const err = new RequestStillHasOpenChildrenError({
        requestId: 'req-1',
        openChildIds: ['wi-1', 'wi-2', 'wi-3'],
      });
      expect(err.requestId).toBe('req-1');
      expect(err.openChildIds).toEqual(['wi-1', 'wi-2', 'wi-3']);
      expect(err.openChildCount).toBe(3);
      expect(err.name).toBe('RequestStillHasOpenChildrenError');
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(RequestStillHasOpenChildrenError);
    });

    it('should singularize message when only one child is open', () => {
      const err = new RequestStillHasOpenChildrenError({
        requestId: 'req-1',
        openChildIds: ['wi-1'],
      });
      expect(err.message).toContain('1 child WorkItem still in non-terminal');
      expect(err.message).not.toContain('child WorkItems still');
    });

    it('should pluralize message when multiple children are open', () => {
      const err = new RequestStillHasOpenChildrenError({
        requestId: 'req-1',
        openChildIds: ['wi-1', 'wi-2'],
      });
      expect(err.message).toContain('2 child WorkItems still in non-terminal');
    });
  });

  describe('linkWorkItem', () => {
    it('should add workItemId to request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-link',
        title: 'Link test',
        description: 'Testing work item link',
      });

      const updated = await service.linkWorkItem(created.id, 'wi-123');
      expect(updated).not.toBeNull();
      expect(updated?.workItemIds).toContain('wi-123');
    });

    it('should not duplicate workItemId', async () => {
      const service = RequestService.getInstance('/tmp/test-project');

      const created = await service.create({
        sourceConversationItemId: 'conv-dedup',
        title: 'Dedup test',
        description: 'Testing dedup',
      });

      await service.linkWorkItem(created.id, 'wi-456');
      const updated = await service.linkWorkItem(created.id, 'wi-456');
      expect(updated?.workItemIds.filter((id) => id === 'wi-456')).toHaveLength(1);
    });

    it('should return null for non-existent request', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const result = await service.linkWorkItem('nonexistent', 'wi-789');
      expect(result).toBeNull();
    });
  });

  describe('plan', () => {
    it('should return empty tasks for short messages', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('.');
      expect(plan.tasks).toHaveLength(0);
      expect(plan.strategy).toBe('none');
      expect(plan.reasoning).toContain('too short');
    });

    it('should return tasks for 2-character messages (e.g. OK)', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('OK');
      expect(plan.tasks.length).toBeGreaterThan(0);
      expect(plan.strategy).not.toBe('none');
    });

    it('should return empty tasks for empty string', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('');
      expect(plan.tasks).toHaveLength(0);
      expect(plan.strategy).toBe('none');
    });

    it('should decompose build-type messages into 3 tasks', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // Needs to be complex: multiple action verbs or conjunctions
      const plan = await service.plan('Build a new authentication system with OAuth2 and then integrate it with the existing user database and session management');

      expect(plan.tasks).toHaveLength(3);
      expect(plan.strategy).toBe('build');
      expect(plan.tasks[0].title).toContain('Design');
      expect(plan.tasks[1].title).toContain('Implement');
      expect(plan.tasks[2].title).toContain('Test');
      expect(plan.reasoning).toContain('build');
    });

    it('should decompose fix-type messages into 3 tasks', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // Needs to be complex: "and then" + multiple verbs
      const plan = await service.plan('Fix the memory leak in the queue processor and then verify all dependent services are stable and review performance metrics');

      expect(plan.tasks).toHaveLength(3);
      expect(plan.strategy).toBe('fix');
      expect(plan.tasks[0].title).toContain('Investigate');
      expect(plan.tasks[1].title).toContain('Fix');
      expect(plan.tasks[2].title).toContain('Verify');
    });

    it('should decompose generic messages into plan/execute/review', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      // Needs to be complex and not match build/fix keywords
      const plan = await service.plan('Improve system performance by 30% and then optimize the reporting pipeline with weekly updates and alerting on regressions');

      expect(plan.tasks).toHaveLength(3);
      expect(plan.strategy).toBe('generic');
      expect(plan.tasks[0].title).toContain('Plan');
      expect(plan.tasks[1].title).toContain('Execute');
      expect(plan.tasks[2].title).toContain('Review');
    });

    it('should preserve the original message in the plan', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const msg = 'Create a dashboard with real-time metrics';
      const plan = await service.plan(msg);

      expect(plan.message).toBe(msg);
    });

    it('should include acceptance criteria on all tasks', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('Implement a search feature with autocomplete');

      for (const task of plan.tasks) {
        expect(task.acceptanceCriteria.length).toBeGreaterThan(0);
        expect(task.priority).toBeDefined();
      }
    });

    it('should trim whitespace from messages', async () => {
      const service = RequestService.getInstance('/tmp/test-project');
      const plan = await service.plan('   Build a new API   ');

      expect(plan.message).toBe('Build a new API');
      expect(plan.tasks.length).toBeGreaterThan(0);
    });
  });
});
