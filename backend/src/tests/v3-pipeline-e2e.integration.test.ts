/**
 * V3 Pipeline End-to-End Integration Test
 *
 * Validates the long-line autonomy outcome from spec
 * 2026-05-06-task-management-v1-deprecation.md: V3 Request/WorkItem is the
 * sole operational backbone, restart recovers via the pool, and autonomous
 * progression is driven by `agent:idle` events + the user-tunable tick.
 *
 * Two acceptance scenarios — each protects a regression that PR #490 / #491
 * fixed:
 *
 * 1. **Request → decompose → claim → dispatch** (PR #490).
 *    A new Request fires `request:created`. The decompose subscriber plans
 *    + queues WorkItems with `target=undefined`. AgentAutoClaim picks the
 *    best-scoring one for an idle agent and **must** push a
 *    `[CREWLY-DISPATCH]` write to that session's terminal — without this,
 *    auto-claimed WIs sit in `running` with no executor (the silent freeze
 *    PR #490 closed).
 *
 * 2. **Mission decomposition → dependency unblock** (PR #491).
 *    A two-step phase with B depending on A. After A reaches terminal
 *    success, B **must** auto-promote `blocked → queued` because the canonical
 *    `wi.dependsOn` field is now what the pool's resolver reads. Pre-fix
 *    the field-write went to `metadata._blockedBy`, which the live resolver
 *    never consulted — mission would silently freeze on phase 1.
 *
 * Wiring: real services + real bus + real filesystem (under tmpdir CREWLY_HOME).
 * Only network egress is mocked — `axios.post` to `/api/terminal/:s/write`
 * (the dispatch HTTP call) is intercepted so tests don't require a live
 * backend.
 *
 * @module tests/v3-pipeline-e2e.integration.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock axios BEFORE any module that captures it (workitem-dispatch.subscriber).
const mockAxiosPost = jest.fn<(...args: unknown[]) => Promise<{ status: number; data: unknown }>>().mockResolvedValue({ status: 200, data: { ok: true } });
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockAxiosPost(...args) },
}));

import {
  RequestService,
  setRequestServiceEventBus,
} from '../services/v3/request.service.js';
import { TaskPoolService } from '../services/task-pool/task-pool.service.js';
import { EventBusService } from '../services/event-bus/event-bus.service.js';
import {
  RequestDecomposeSubscriber,
  setRequestDecomposeSubscriber,
} from '../services/v3/request-decompose.subscriber.js';
import { WorkItemDispatchSubscriber } from '../services/v3/workitem-dispatch.subscriber.js';
import { AgentAutoClaimService } from '../services/v3/agent-auto-claim.service.js';
import { LoggerService } from '../services/core/logger.service.js';
import {
  createWorkItem,
  type WorkItem,
} from '../types/v2/work-item.types.js';
import type { AgentHealth } from '../services/reconciler/reconcile-rules.js';

// =============================================================================
// Suite-wide setup: silence logger noise so failures stand out.
// =============================================================================

beforeEach(() => {
  const noop = (..._args: unknown[]) => {};
  const stub = { info: noop, debug: noop, warn: noop, error: noop };
  jest
    .spyOn(LoggerService.prototype as unknown as { createComponentLogger: () => unknown }, 'createComponentLogger')
    .mockReturnValue(stub as unknown as ReturnType<LoggerService['createComponentLogger']>);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// =============================================================================
// Fixture
// =============================================================================

interface E2EFixture {
  tmpRoot: string;
  bus: EventBusService;
  requestService: RequestService;
  taskPool: TaskPoolService;
  decomposeSubscriber: RequestDecomposeSubscriber;
  dispatchSubscriber: WorkItemDispatchSubscriber;
  autoClaim: AgentAutoClaimService;
  cleanup: () => Promise<void>;
}

/**
 * Build a fully-wired V3 pipeline against an isolated tmp dir.
 *
 * @param agentHealthMap - Provides the AutoClaim score input. Defaults to
 *   one healthy `dev-1` agent capable of taking any item.
 */
async function buildFixture(
  agentHealthMap: Map<string, AgentHealth> = new Map([
    // `role` is set so `computeAgentScore` returns skillMatch=25 (no tag
    // match but a known role), clearing the MIN_SCORE_THRESHOLD=15 gate.
    // Without it the bare agent scores 10 and AutoClaim filters out
    // every item — manifesting as zero dispatch HTTP calls.
    ['dev-1', { sessionName: 'dev-1', status: 'active', role: 'developer', activeWorkItemCount: 0 }],
  ]),
): Promise<E2EFixture> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'v3-pipeline-e2e-'));
  const crewlyHome = path.join(tmpRoot, '.crewly');
  await fs.mkdir(crewlyHome, { recursive: true });
  const previousCrewlyHome = process.env.CREWLY_HOME;
  process.env.CREWLY_HOME = crewlyHome;

  // Reset all singletons so each test gets fresh state.
  RequestService.resetInstance();
  TaskPoolService.resetInstance();
  WorkItemDispatchSubscriber.resetInstance();
  AgentAutoClaimService.resetInstance();
  setRequestDecomposeSubscriber(null);

  const bus = new EventBusService();
  const requestService = RequestService.getInstance(tmpRoot);
  const taskPool = TaskPoolService.getInstance();

  // Wire pub/sub so producers fire events the subscribers care about.
  setRequestServiceEventBus(bus);
  taskPool.setEventBusService(bus);

  // Decompose subscriber — listens for request:created.
  const decomposeSubscriber = new RequestDecomposeSubscriber({
    eventBus: bus,
    requestService,
    taskPool,
  });
  decomposeSubscriber.start();
  setRequestDecomposeSubscriber(decomposeSubscriber);

  // Dispatch subscriber — listens for workitem:queued. The HTTP call is
  // mocked at module level (axios.post above).
  const dispatchSubscriber = WorkItemDispatchSubscriber.getInstance();
  dispatchSubscriber.initialize(bus);
  dispatchSubscriber.start();

  // AutoClaim — listens for agent:idle / task:done events. We give it an
  // explicit health provider that returns the test agent map.
  const autoClaim = AgentAutoClaimService.getInstance();
  autoClaim.initialize(bus, async () => agentHealthMap);
  await autoClaim.start();

  return {
    tmpRoot,
    bus,
    requestService,
    taskPool,
    decomposeSubscriber,
    dispatchSubscriber,
    autoClaim,
    cleanup: async () => {
      autoClaim.stop();
      decomposeSubscriber.stop();
      // WorkItemDispatchSubscriber has no stop() — `resetInstance` clears
      // the subscriber + its event listener references. The underlying
      // EventBus instance is also dropped at end-of-fixture.
      setRequestDecomposeSubscriber(null);
      setRequestServiceEventBus(null);
      taskPool.setEventBusService(null);
      RequestService.resetInstance();
      TaskPoolService.resetInstance();
      WorkItemDispatchSubscriber.resetInstance();
      AgentAutoClaimService.resetInstance();
      mockAxiosPost.mockClear();
      if (previousCrewlyHome === undefined) {
        delete process.env.CREWLY_HOME;
      } else {
        process.env.CREWLY_HOME = previousCrewlyHome;
      }
      await fs.rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Spin the microtask queue until `predicate()` is true or attempts run out.
 * The pipeline's wiring is event-driven — pub/sub handlers resolve through
 * microtasks, so we need to yield after each significant action.
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  attempts = 50,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await predicate()) return;
    await new Promise<void>((res) => {
      const t = setTimeout(res, 10);
      t.unref?.();
    });
  }
}

/** Find dispatch HTTP calls targeting a given session name. */
function dispatchCallsFor(sessionName: string): unknown[][] {
  return mockAxiosPost.mock.calls.filter((call) => {
    const url = call[0];
    return typeof url === 'string' && url.includes(`/api/terminal/${encodeURIComponent(sessionName)}/write`);
  });
}

// =============================================================================
// Scenario 1: Request → decompose → claim → dispatch (PR #490 regression)
// =============================================================================

describe('V3 pipeline E2E', () => {
  describe('Request → decompose → claim → dispatch', () => {
    it('lands [CREWLY-DISPATCH] on the worker session after auto-decompose + auto-claim', async () => {
      const fixture = await buildFixture();
      try {
        // 1) Orchestrator-equivalent: create an L2 code_change Request.
        //    The decompose subscriber's filter accepts this combination.
        const request = await fixture.requestService.create({
          sourceConversationItemId: 'slack-msg-001',
          title: 'Build the foo feature end-to-end',
          description:
            'Implement the foo feature with API + tests. This is a multi-step build task ' +
            'spanning backend changes and verification — long enough to cross the plan() ' +
            'minimum-length gate.',
          intentLevel: 'L2',
          intentCategory: 'code_change',
          priority: 'high',
        });

        // 2) Auto-decompose runs on the request:created event. Wait for at
        //    least one WorkItem to land in the pool with this requestId.
        await waitFor(async () => {
          const items = await fixture.taskPool.getAllItems();
          return items.some((wi) => wi.requestId === request.id);
        });
        const decomposed = (await fixture.taskPool.getAllItems()).filter(
          (wi) => wi.requestId === request.id,
        );
        expect(decomposed.length).toBeGreaterThan(0);
        // Auto-decompose intentionally leaves target unset (orc decides
        // assignment during fan-out; AutoClaim is the picker).
        for (const wi of decomposed) {
          expect(wi.target).toBeUndefined();
        }

        // 3) Trigger the autonomy loop. Production fires this on the agent's
        //    activity-monitor signal; we just publish the event the subscriber
        //    listens to.
        fixture.bus.publish({
          id: 'evt-idle-1',
          type: 'agent:idle',
          timestamp: new Date().toISOString(),
          teamId: 't',
          teamName: 't',
          memberId: 'm',
          memberName: 'm',
          sessionName: 'dev-1',
          previousValue: 'in_progress',
          newValue: 'idle',
          changedField: 'workingStatus',
        });

        // 4) AutoClaim → claimSpecificItem flips one WI to running, sets
        //    target=dev-1, then hands off to dispatchTo() which axios.posts
        //    to /api/terminal/dev-1/write. Wait for that call.
        await waitFor(() => dispatchCallsFor('dev-1').length > 0);
        const calls = dispatchCallsFor('dev-1');
        expect(calls.length).toBeGreaterThanOrEqual(1);

        // 5) The dispatched payload carries the [CREWLY-DISPATCH] marker.
        const body = calls[0][1] as { data?: string; mode?: string };
        expect(body.data).toContain('[CREWLY-DISPATCH]');
        expect(body.mode).toBe('message');

        // 6) The auto-claimed WI is now running with target=dev-1.
        const finalItems = await fixture.taskPool.getAllItems();
        const claimedRunning = finalItems.find(
          (wi) => wi.requestId === request.id && wi.status === 'running' && wi.target === 'dev-1',
        );
        expect(claimedRunning).toBeDefined();
      } finally {
        await fixture.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Mission decomposition → dependency unblock (PR #491 regression)
  // ---------------------------------------------------------------------------

  describe('Mission decomposition → dependency unblock', () => {
    it('auto-promotes B from blocked → queued when A reaches terminal success, then AutoClaim picks B', async () => {
      const fixture = await buildFixture();
      try {
        // 1) Seed the pool with a 2-step mission phase: A (queued) and B
        //    (blocked, depends on A). We construct WIs directly to mirror
        //    what mission-executor.processDecomposition emits — the canonical
        //    fix from PR #491 is `wi.dependsOn = [A.id]`, NOT
        //    `metadata._blockedBy`.
        // `requiresVerification: false` skips the delegate-default
        // verification path so `completeItem` reaches terminal `done`
        // directly (instead of stopping at `done_by_worker` waiting for
        // a TL verdict). The unblock contract under test fires on
        // terminal success, so this keeps the test focused on the
        // dependency-resolution path PR #491 fixed without dragging the
        // verify-pipeline into scope.
        const wiA = createWorkItem({
          type: 'delegate',
          owner: 'orchestrator',
          title: 'Phase 1A: design schema',
          description: 'Step A',
          missionId: 'mission-e2e-1',
          metadata: { requiresVerification: false },
        });
        await fixture.taskPool.addToPool(wiA);

        const wiB: WorkItem = createWorkItem({
          type: 'delegate',
          owner: 'orchestrator',
          title: 'Phase 1B: implement API',
          description: 'Step B (depends on A)',
          missionId: 'mission-e2e-1',
          dependsOn: [wiA.id],
          metadata: { requiresVerification: false },
        });
        // The factory sets status='blocked' when dependsOn is non-empty, but
        // assert it for the contract this test is protecting.
        expect(wiB.status).toBe('blocked');
        expect(wiB.dependsOn).toEqual([wiA.id]);
        await fixture.taskPool.addToPool(wiB);

        // 2) Worker takes A then reports done via the V3 completion lifecycle.
        //    Production flow: queued → claim → running → done. We inline
        //    that here. Internally: completeItem → resolveBlockedDependents(A.id)
        //    → finds B has dependsOn including A.id → flips B to queued.
        const claimResult = await fixture.taskPool.claimSpecificItem('dev-1', wiA.id);
        expect(claimResult).not.toBeNull();
        await fixture.taskPool.completeItem(wiA.id, { summary: 'A finished' });

        // 3) Verify B is now queued (not blocked). This is the PR #491 fix.
        await waitFor(async () => {
          const updatedB = await fixture.taskPool.findWorkItem(wiB.id);
          return updatedB?.status === 'queued';
        });
        const updatedB = await fixture.taskPool.findWorkItem(wiB.id);
        expect(updatedB?.status).toBe('queued');

        // 4) Trigger AutoClaim — B should be the only queued item left.
        mockAxiosPost.mockClear();
        fixture.bus.publish({
          id: 'evt-idle-2',
          type: 'agent:idle',
          timestamp: new Date().toISOString(),
          teamId: 't',
          teamName: 't',
          memberId: 'm',
          memberName: 'm',
          sessionName: 'dev-1',
          previousValue: 'in_progress',
          newValue: 'idle',
          changedField: 'workingStatus',
        });

        // 5) Dispatch fires for B.
        await waitFor(() => dispatchCallsFor('dev-1').length > 0);
        const calls = dispatchCallsFor('dev-1');
        expect(calls.length).toBeGreaterThanOrEqual(1);

        const body = calls[0][1] as { data?: string };
        expect(body.data).toContain('[CREWLY-DISPATCH]');
        expect(body.data).toContain(wiB.title);

        // 6) Final state — B is running, A is done.
        const finalA = await fixture.taskPool.findWorkItem(wiA.id);
        const finalB = await fixture.taskPool.findWorkItem(wiB.id);
        expect(finalA?.status).toBe('done');
        expect(finalB?.status).toBe('running');
        expect(finalB?.target).toBe('dev-1');
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
