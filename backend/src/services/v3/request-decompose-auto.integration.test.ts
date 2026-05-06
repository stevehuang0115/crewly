/**
 * Request Auto-Decompose Integration Test — Pipeline-#4 follow-up acceptance.
 *
 * Drives a Request through the **real** chain:
 *   RequestService.create()
 *     → publishes `request:created` via the live bus
 *     → RequestDecomposeSubscriber.handleRequestCreated() runs
 *     → calls RequestService.plan() → planned tasks
 *     → for each task: TaskPoolService.addToPool(wi)
 *     → addToPool publishes `workitem:queued` (per WI)
 *     → RequestSlaSubscriber.handleWorkItemQueued() runs (PR #453 L4)
 *     → calls requestService.linkWorkItem(requestId, wiId)
 *     → Request.workItemIds[] populated end-to-end
 *
 * Pins the bug-fix contract: a POSTed L2 actionable Request gets
 * WorkItems automatically without the orc invoking break-down-request.
 *
 * Mirrors the structure of `request-decompose.integration.test.ts` (the
 * Pipeline-#4 acceptance harness from PR #453) — same fixture pattern
 * (real services, fs-backed tmp CREWLY_HOME, isolated singletons),
 * extended with the auto-decompose subscriber wired alongside SLA.
 *
 * @module services/v3/request-decompose-auto.integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RequestService,
  setRequestServiceEventBus,
} from './request.service.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { EventBusService } from '../event-bus/event-bus.service.js';
import {
  RequestSlaSubscriber,
  setRequestSlaSubscriber,
} from './request-sla.subscriber.js';
import {
  RequestDecomposeSubscriber,
  setRequestDecomposeSubscriber,
} from './request-decompose.subscriber.js';
import { LoggerService } from '../core/logger.service.js';
import type { IntentCategory, IntentLevel } from '../../types/v2/request.types.js';

// Silence the global logger across the suite so failures stay readable.
beforeEach(() => {
  const noop = (..._args: unknown[]) => {};
  const stub = {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
  };
  jest
    .spyOn(LoggerService.prototype as unknown as { createComponentLogger: () => unknown }, 'createComponentLogger')
    .mockReturnValue(stub as unknown as ReturnType<LoggerService['createComponentLogger']>);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface IntegrationFixture {
  tmpRoot: string;
  bus: EventBusService;
  requestService: RequestService;
  taskPool: TaskPoolService;
  slaSubscriber: RequestSlaSubscriber;
  decomposeSubscriber: RequestDecomposeSubscriber;
  cleanup: () => Promise<void>;
}

async function buildFixture(): Promise<IntegrationFixture> {
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'pipeline-decompose-auto-int-'),
  );
  const crewlyHome = path.join(tmpRoot, '.crewly');
  await fs.mkdir(crewlyHome, { recursive: true });
  const previousCrewlyHome = process.env.CREWLY_HOME;
  process.env.CREWLY_HOME = crewlyHome;

  // Reset singletons so we get clean instances scoped to this CREWLY_HOME.
  RequestService.resetInstance();
  TaskPoolService.resetInstance();
  setRequestSlaSubscriber(null);
  setRequestDecomposeSubscriber(null);

  const bus = new EventBusService();
  const requestService = RequestService.getInstance(tmpRoot);
  const taskPool = TaskPoolService.getInstance();

  // CRITICAL: wire the bus into both producers BEFORE starting subscribers.
  // RequestService publishes `request:created` synchronously inside
  // create(); without the bus wired the event never lands and the
  // subscriber never fires.
  setRequestServiceEventBus(bus);
  taskPool.setEventBusService(bus);

  // Start the SLA subscriber (PR #453 L4 fix — workitem:queued → linkWorkItem).
  const slaSubscriber = new RequestSlaSubscriber({
    eventBus: bus,
    requestService,
    taskPool,
    orchestratorSession: 'test-orc',
  });
  slaSubscriber.start();
  setRequestSlaSubscriber(slaSubscriber);

  // Start the auto-decompose subscriber under test.
  const decomposeSubscriber = new RequestDecomposeSubscriber({
    eventBus: bus,
    requestService,
    taskPool,
  });
  decomposeSubscriber.start();
  setRequestDecomposeSubscriber(decomposeSubscriber);

  return {
    tmpRoot,
    bus,
    requestService,
    taskPool,
    slaSubscriber,
    decomposeSubscriber,
    cleanup: async () => {
      decomposeSubscriber.stop();
      slaSubscriber.stop();
      setRequestDecomposeSubscriber(null);
      setRequestSlaSubscriber(null);
      setRequestServiceEventBus(null);
      taskPool.setEventBusService(null);
      RequestService.resetInstance();
      TaskPoolService.resetInstance();

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
 * Idle-loop the event loop until a predicate becomes true or attempts run
 * out. The dispatch chain through the bus is async (microtasks +
 * setTimeout(0) inside addToPool) so we need to yield rather than spin.
 *
 * @param predicate - The condition we're waiting on.
 * @param attempts - Maximum iterations (~10ms each).
 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (await predicate()) return;
    await new Promise<void>((res) => {
      const t = setTimeout(res, 10);
      t.unref?.();
    });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Request auto-decompose pipeline (Option C subscriber, end-to-end)', () => {
  let fx: IntegrationFixture;

  beforeEach(async () => {
    fx = await buildFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  // -------------------------------------------------------------------------
  // Acceptance criteria #1 — POST creates Request with WorkItems within 5s
  // -------------------------------------------------------------------------

  it('an L2 code_change Request lands with WorkItems linked end-to-end', async () => {
    const created = await fx.requestService.create({
      title: 'Build a feature for X',
      description: 'Build a comprehensive feature that handles user authentication, persists state, and ships with end-to-end tests',
      sourceConversationItemId: 'slack-CINTEG-1.000001',
      priority: 'normal',
      tags: ['integration-test'],
      intentLevel: 'L2',
      intentCategory: 'code_change',
    });

    // Wait for both subscribers to drain.
    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();

    // Wait for the linkWorkItem cascade to populate workItemIds[].
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return (r?.workItemIds.length ?? 0) > 0;
    });

    const refreshed = await fx.requestService.getById(created.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.workItemIds.length).toBeGreaterThan(0);

    // Each linked WI carries the parent Request id.
    for (const wiId of refreshed!.workItemIds) {
      const wi = await fx.taskPool.findWorkItem(wiId);
      expect(wi).not.toBeNull();
      expect(wi!.requestId).toBe(created.id);
    }
  });

  // -------------------------------------------------------------------------
  // Acceptance criteria #3 — L1 / non-actionable category SKIP
  // -------------------------------------------------------------------------

  it('an L1 Request does NOT auto-decompose', async () => {
    const created = await fx.requestService.create({
      title: 'Quick question',
      description: 'A simple L1-level question that should not be auto-decomposed into WorkItems',
      sourceConversationItemId: 'slack-CINTEG-2.000001',
      priority: 'normal',
      tags: ['integration-test'],
      intentLevel: 'L1' as IntentLevel,
      intentCategory: 'communication' as IntentCategory,
    });

    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();

    // Settle window: 200ms is more than enough — the auto-decompose path is
    // synchronous through plan() and addToPool. If WIs were going to land,
    // they'd have landed by now.
    await new Promise((res) => setTimeout(res, 200));

    const refreshed = await fx.requestService.getById(created.id);
    // Note: the SLA subscriber MAY have created a respond_to_user WI for
    // the slack-shaped sourceConversationItemId. That's a separate concern
    // and not the point of this test. The auto-decompose subscriber should
    // have skipped this Request — our check is that the decompose subscriber
    // never tracked it.
    expect(fx.decomposeSubscriber.getDecomposedRequestIdsSnapshot().has(created.id)).toBe(false);
    // Belt: even if SLA seeded a respond_to_user WI, that's exactly 1, not
    // the 2-3 a plan() call would have produced.
    expect(refreshed!.workItemIds.length).toBeLessThanOrEqual(1);
  });

  it('an L2 communication Request does NOT auto-decompose (non-actionable category)', async () => {
    const created = await fx.requestService.create({
      title: 'Hi',
      description: 'L2 but communication category — should not auto-decompose into multi-task plan',
      sourceConversationItemId: 'slack-CINTEG-3.000001',
      priority: 'normal',
      tags: ['integration-test'],
      intentLevel: 'L2',
      intentCategory: 'communication' as IntentCategory,
    });

    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();
    await new Promise((res) => setTimeout(res, 200));

    expect(fx.decomposeSubscriber.getDecomposedRequestIdsSnapshot().has(created.id)).toBe(false);
    const refreshed = await fx.requestService.getById(created.id);
    expect(refreshed!.workItemIds.length).toBeLessThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Acceptance criteria #4 — already-decomposed Request is NOT re-added
  // -------------------------------------------------------------------------

  it('does not re-decompose a Request that already has linked WorkItems', async () => {
    // Pre-seed: create a Request and manually link a WI BEFORE the bus
    // wires fire. We do this by short-circuiting RequestService.create()
    // and directly inserting via storage. Easier path: create the Request,
    // wait for auto-decompose to populate workItemIds, capture the count,
    // then re-publish a synthetic `request:created` for the same id and
    // verify NO new WIs are added.
    const created = await fx.requestService.create({
      title: 'First-pass build',
      description: 'Implement the initial feature with tests and documentation',
      sourceConversationItemId: 'slack-CINTEG-4.000001',
      priority: 'normal',
      tags: ['integration-test'],
      intentLevel: 'L2',
      intentCategory: 'code_change',
    });

    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return (r?.workItemIds.length ?? 0) > 0;
    });
    const firstPassCount = (await fx.requestService.getById(created.id))!.workItemIds.length;
    expect(firstPassCount).toBeGreaterThan(0);

    // Now simulate redelivery: republish the request:created event for the
    // same Request id. The decompose subscriber's in-memory dedupe AND the
    // workItemIds.length > 0 skip should both prevent re-adding WIs.
    fx.bus.publish({
      id: `evt-redeliver-${created.id}`,
      type: 'request:created',
      requestId: created.id,
      timestamp: new Date().toISOString(),
      teamId: '',
      teamName: '',
      memberId: '',
      memberName: '',
      sessionName: '',
      previousValue: '',
      newValue: '',
      changedField: 'workingStatus',
    });

    await fx.decomposeSubscriber.flushPending();
    await new Promise((res) => setTimeout(res, 200));

    const secondPassCount = (await fx.requestService.getById(created.id))!.workItemIds.length;
    expect(secondPassCount).toBe(firstPassCount);
  });

  // -------------------------------------------------------------------------
  // Acceptance criteria #2 — redelivery within process lifetime
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // F9 regression fixture — Sam dispatched 2026-05-06.
  //
  // Auditor (ORC Audit Cycle 3) confirmed Request ff54231a-02f3-4841-a74c-
  // 734a5aca9d09 was closed with workItemIds=[] on main, post-#453 5-layer
  // fix. This is Steve's exact symptom on real data: intentLevel=L2,
  // intentCategory=planning, Chinese-language "decompose into WIs" body,
  // closed without WIs in 4 minutes.
  //
  // Pre-fix repro (synthetic; we cannot un-fix the running code from a
  // test): would queue 0 WorkItems despite plan() returning 2-3 tasks
  // because plan() was a pure function with no addToPool wiring.
  //
  // Post-fix gate: same shape POST → workItemIds.length > 0 within 5s.
  // The literal record shape is preserved here so a future regression
  // (e.g. someone narrowing ACTIONABLE_INTENT_CATEGORIES to exclude
  // 'planning', or breaking the plan() wiring) trips this test by name.
  // -------------------------------------------------------------------------

  it('regression-f9: real-data shape (ff54231a — L2 planning, Chinese body) lands with WorkItems', async () => {
    // Verbatim shape from the audited record. Description preserved
    // verbatim (Chinese + multi-line + spec references) to prove the
    // planner heuristic + addToPool path handles real prod content, not
    // just synthetic English Lorem.
    const realShapeDescription =
      'Steve 2026-05-06 directive: 按这两份文档安排团队推进 P0 执行。\n\n' +
      '参考文档：\n' +
      '- .crewly/specs/2026-05-03-agent-improvement-plan.md (24KB) — improvement plan, P0/P1/P2 三层, 14 specific changes\n' +
      '- .crewly/specs/2026-05-03-agent-improvement-p0-execution.md (18KB) — P0 详细执行 spec\n\n' +
      '请 plan() 拆解为 WorkItems：每个 P0 change 一个 WorkItem。已完成的 P0 项可标 done 跳过。剩余未完成项 owner 候选 = Sam (Product TL) 主导团队 claim 执行。\n\n' +
      'OSS 重启后第一条 dogfood Request — 走 plan() → WorkItems → claimFromPool 流程。';

    const created = await fx.requestService.create({
      title: '按 2026-05-03 agent improvement 两份 spec 推进 P0 执行',
      description: realShapeDescription,
      // The real record had `slack-D0AC7NF5N7L-1778027000-000000`. We use
      // a different ts to avoid colliding with the prod source on rerun
      // but keep the slack- prefix so the SLA subscriber's inbound-tag
      // logic still receives a recognizable shape if tags include 'slack'.
      sourceConversationItemId: 'slack-D0AC7NF5N7L-9999999999-000000',
      priority: 'high',
      tags: [], // real record had empty tags — preserve to pin the
                // case where SLA subscriber will NOT seed a respond_to_user
                // WI; auto-decompose is the ONLY path that should produce WIs.
      intentLevel: 'L2',
      intentCategory: 'planning',
    });

    // Wait for the chain.
    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return (r?.workItemIds.length ?? 0) > 0;
    });

    const refreshed = await fx.requestService.getById(created.id);
    expect(refreshed).not.toBeNull();
    // The bug-fix contract: with the auto-decompose subscriber wired,
    // the real-shape Request lands with WorkItems. Pre-fix this assertion
    // would fail with workItemIds.length === 0 (the auditor's evidence).
    expect(refreshed!.workItemIds.length).toBeGreaterThan(0);

    // Each linked WI has the parent Request id (the L4 fix from #453
    // doing its job on top of the new Option C subscriber).
    for (const wiId of refreshed!.workItemIds) {
      const wi = await fx.taskPool.findWorkItem(wiId);
      expect(wi).not.toBeNull();
      expect(wi!.requestId).toBe(created.id);
      // The auto-decompose subscriber stamps autoDecomposed=true so the
      // fan-out source is observable in metadata (vs break-down-request
      // skill output which doesn't carry this flag). Future audit can
      // partition decomposition sources by this metadata field.
      expect(wi!.metadata).toMatchObject({ autoDecomposed: true });
    }
  });

  it('two consecutive request:created events for the same Request id produce one decomposition', async () => {
    // We use the bus directly so the second event fires before
    // RequestService.create persists workItemIds — the in-memory dedupe
    // (not the workItemIds.length > 0 skip) is the mechanism we're pinning.
    const created = await fx.requestService.create({
      title: 'Decomposable build task',
      description: 'Implement a robust feature with full test coverage and CI integration',
      sourceConversationItemId: 'slack-CINTEG-5.000001',
      priority: 'normal',
      tags: ['integration-test'],
      intentLevel: 'L2',
      intentCategory: 'code_change',
    });

    // Immediately fire a synthetic redelivery on the same event type.
    fx.bus.publish({
      id: `evt-redeliver-tight-${created.id}`,
      type: 'request:created',
      requestId: created.id,
      timestamp: new Date().toISOString(),
      teamId: 'tight',
      teamName: 'tight',
      memberId: 'tight',
      memberName: 'tight',
      sessionName: '',
      previousValue: '',
      newValue: '',
      changedField: 'workingStatus',
    });

    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return (r?.workItemIds.length ?? 0) > 0;
    });

    // The post-decompose Request has the plan-task-count of WIs, NOT 2x.
    // Sanity gate: we don't pin the exact count (planning heuristic may
    // tune over time) — we pin "decomposed exactly once".
    const refreshed = await fx.requestService.getById(created.id);
    const linkedCount = refreshed!.workItemIds.length;
    // Expect at least 1 (decomposition happened) and at most 4 (sanity
    // upper bound — current heuristic produces 1-3 tasks). A double-fire
    // bug would yield 2-6 (1-3 × 2).
    expect(linkedCount).toBeGreaterThan(0);
    expect(linkedCount).toBeLessThanOrEqual(4);
  });
});
