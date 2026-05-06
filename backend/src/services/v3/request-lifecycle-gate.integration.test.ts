/**
 * Request → done lifecycle gate integration test (P1 Bug C).
 *
 * Drives a Request through the **real** services to verify two things:
 *
 *   AC5 (F9 repro): pool 1 WI in queued + parent Request, attempt to close
 *   the Request to done → must REFUSE post-fix. Pre-fix this would have
 *   succeeded — that was the auditor's exact F9 fixture symptom on
 *   Request `ff54231a-02f3-4841-a74c-734a5aca9d09`.
 *
 *   AC6 (Bug B + Bug C composition): POST an L2 actionable Request → the
 *   auto-decompose subscriber populates workItemIds[] via the live event
 *   chain → attempt close-before-children-done → REFUSE → transition all
 *   children to terminal state → close Request → SUCCESS.
 *
 * Bug B (#467 merged 8bf58a11) made `Request.workItemIds[]` authoritative
 * on every addToPool. Bug C makes the closure honor that data. Without
 * Bug B's invariant, Bug C's gate would be useless (always-empty arrays
 * trivially bypass the gate). The composition test explicitly exercises
 * both.
 *
 * Mirrors the fixture pattern from request-decompose-auto.integration.test
 * (real services, fs-backed tmp CREWLY_HOME, isolated singletons) and
 * adds the Bug C wiring step (requestService.setTaskPoolService).
 *
 * @module services/v3/request-lifecycle-gate.integration.test
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RequestService,
  setRequestServiceEventBus,
  RequestStillHasOpenChildrenError,
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
import { createWorkItem } from '../../types/v2/work-item.types.js';

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
    path.join(os.tmpdir(), 'pipeline-bug-c-int-'),
  );
  const crewlyHome = path.join(tmpRoot, '.crewly');
  await fs.mkdir(crewlyHome, { recursive: true });
  const previousCrewlyHome = process.env.CREWLY_HOME;
  process.env.CREWLY_HOME = crewlyHome;

  RequestService.resetInstance();
  TaskPoolService.resetInstance();
  setRequestSlaSubscriber(null);
  setRequestDecomposeSubscriber(null);

  const bus = new EventBusService();
  const requestService = RequestService.getInstance(tmpRoot);
  const taskPool = TaskPoolService.getInstance();

  // Wire bus into producers.
  setRequestServiceEventBus(bus);
  taskPool.setEventBusService(bus);

  // Bug B (#467): TaskPool → Request linker so addToPool intrinsically
  // links new WIs into Request.workItemIds[].
  taskPool.setRequestService(requestService);

  // Bug C (this PR): Request → TaskPool queryable so the close-gate can
  // verify child terminal state.
  requestService.setTaskPoolService(taskPool);

  // Live SLA + auto-decompose subscribers (mirror production wiring).
  const slaSubscriber = new RequestSlaSubscriber({
    eventBus: bus,
    requestService,
    taskPool,
    orchestratorSession: 'test-orc',
  });
  slaSubscriber.start();
  setRequestSlaSubscriber(slaSubscriber);

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
      taskPool.setRequestService(null);
      requestService.setTaskPoolService(null);
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

/** Async predicate spinner with bounded attempts (mirror existing patterns). */
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

describe('Request → done lifecycle gate (P1 Bug C, integration)', () => {
  let fx: IntegrationFixture;

  beforeEach(async () => {
    fx = await buildFixture();
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  // -------------------------------------------------------------------------
  // AC5 — F9 fixture repro: queued WI + close attempt → must REFUSE post-fix
  // -------------------------------------------------------------------------

  it('AC5 (F9 repro): refuses Request → done while child WI is still queued', async () => {
    // Manually create a Request and addToPool a WI — this is the
    // pre-decompose-subscriber path that originally produced the F9 symptom.
    const created = await fx.requestService.create({
      title: 'F9 fixture repro',
      description: 'Request with a queued child WI in the pool',
      sourceConversationItemId: 'slack-F9-repro-1',
      priority: 'normal',
      tags: ['bug-c-repro'],
    });

    const wi = createWorkItem({
      type: 'delegate',
      owner: 'agent',
      target: 'agent-test',
      title: 'Some queued unit of work',
      requestId: created.id,
    });
    await fx.taskPool.addToPool(wi);

    // Bug B's intrinsic link populates workItemIds[] (no subscriber needed).
    // Wait for the link to settle in case the link runs after addToPool.
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return (r?.workItemIds.length ?? 0) > 0;
    });

    const linked = await fx.requestService.getById(created.id);
    expect(linked!.workItemIds).toContain(wi.id);

    // Walk Request to running so 'done' is a valid transition target.
    await fx.requestService.update(created.id, { status: 'ready' });
    await fx.requestService.update(created.id, { status: 'running' });

    // Attempt to close — pre-fix this would succeed (the F9 symptom).
    // Post-fix the gate must refuse.
    let caught: unknown;
    try {
      await fx.requestService.update(created.id, { status: 'done' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestStillHasOpenChildrenError);
    const e = caught as RequestStillHasOpenChildrenError;
    expect(e.requestId).toBe(created.id);
    expect(e.openChildIds).toContain(wi.id);

    // Confirm the Request was NOT mutated by the refused transition.
    const reloaded = await fx.requestService.getById(created.id);
    expect(reloaded?.status).toBe('running');
    expect(reloaded?.completedAt).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC6 — Bug B + Bug C composition: full chain
  // -------------------------------------------------------------------------

  it('AC6: POST L2 → decompose → close-before-done REFUSES → close-after-done SUCCEEDS', async () => {
    const created = await fx.requestService.create({
      title: 'Bug B+C composition test',
      description: 'Build a comprehensive feature that handles user authentication, persists state, and ships with end-to-end tests',
      sourceConversationItemId: 'slack-bug-c-composition-1',
      priority: 'normal',
      tags: ['bug-c-composition'],
      intentLevel: 'L2',
      intentCategory: 'code_change',
    });

    // Drain the auto-decompose + SLA subscribers.
    await fx.decomposeSubscriber.flushPending();
    await fx.slaSubscriber.flushPending();

    // Wait for workItemIds[] to populate (Bug B's intrinsic link +
    // SLA-subscriber's belt-and-suspenders link).
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return (r?.workItemIds.length ?? 0) > 0;
    });

    const decomposed = await fx.requestService.getById(created.id);
    expect(decomposed!.workItemIds.length).toBeGreaterThan(0);

    // Walk Request to running.
    await fx.requestService.update(created.id, { status: 'ready' });
    await fx.requestService.update(created.id, { status: 'running' });

    // Attempt close while children are in their initial (queued) state.
    let blockingError: unknown;
    try {
      await fx.requestService.update(created.id, { status: 'done' });
    } catch (err) {
      blockingError = err;
    }
    expect(blockingError).toBeInstanceOf(RequestStillHasOpenChildrenError);
    const blocking = blockingError as RequestStillHasOpenChildrenError;
    expect(blocking.openChildCount).toBe(decomposed!.workItemIds.length);

    // Now transition every child to a terminal state (done) via the pool's
    // production transition path so the state-machine guard fires.
    for (const wiId of decomposed!.workItemIds) {
      // queued → running → done is the simplest legal path.
      await fx.taskPool.transitionStatus(wiId, 'running', 'system');
      await fx.taskPool.transitionStatus(wiId, 'done', 'system');
    }

    // Close should now succeed.
    const done = await fx.requestService.update(created.id, { status: 'done' });
    expect(done.status).toBe('done');
    expect(done.completedAt).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Composition guard: Bug B's intrinsic link + Bug C's gate operate on the
  // same authoritative workItemIds[] — no race between addToPool and close.
  // -------------------------------------------------------------------------

  it('intrinsic link (Bug B) + gate (Bug C) reject close immediately after addToPool', async () => {
    const created = await fx.requestService.create({
      title: 'Race-condition guard',
      description: 'Closure attempted immediately after addToPool',
      sourceConversationItemId: 'slack-bug-c-race-1',
      priority: 'normal',
    });

    // Walk to running BEFORE adding the WI — verifies the gate fires on
    // the post-add state, not on a pre-add snapshot.
    await fx.requestService.update(created.id, { status: 'ready' });
    await fx.requestService.update(created.id, { status: 'running' });

    const wi = createWorkItem({
      type: 'delegate',
      owner: 'agent',
      target: 'agent-test',
      title: 'Late-bound child',
      requestId: created.id,
    });
    await fx.taskPool.addToPool(wi);

    // Bug B's intrinsic link is synchronous-after-addToPool; wait for it.
    await waitFor(async () => {
      const r = await fx.requestService.getById(created.id);
      return r?.workItemIds.includes(wi.id) ?? false;
    });

    await expect(
      fx.requestService.update(created.id, { status: 'done' }),
    ).rejects.toBeInstanceOf(RequestStillHasOpenChildrenError);
  });
});
