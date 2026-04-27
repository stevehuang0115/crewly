/**
 * Tests for EventToWorkItemBridge (BRIDGE-1.4).
 *
 * Covers Arch Vetos V1 (idempotency), V2 (retry cap), V4 (TL fail-fast),
 * V5 (no Trigger entity — verified by absence in src), and V6/V9
 * (cron-recursion block + cron→event demote on retry).
 *
 * @module services/event-bus/event-to-workitem-bridge.test
 */

import { EventBusService } from './event-bus.service.js';
import {
  EventToWorkItemBridge,
  CronRecursionError,
  BridgeTeamLeadResolutionError,
  assertNoCronFromCron,
  BRIDGE_SUBSCRIBED_EVENTS,
} from './event-to-workitem-bridge.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';
import type {
  WorkItem,
  WorkItemType,
  WorkItemOwner,
  WorkItemStatus,
} from '../../types/v2/work-item.types.js';
import type { Mission } from '../../types/v2/mission.types.js';
import type { Team } from '../../types/index.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Build a real WorkItem fixture (Sam's reminder #2: real shape, not a mock).
 */
function buildWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-source-1',
    type: 'delegate' as WorkItemType,
    owner: 'agent' as WorkItemOwner,
    target: 'crewly-product-leo-member-n',
    title: 'Implement feature X',
    description: 'Some delegated work',
    status: 'running' as WorkItemStatus,
    createdAt: '2026-04-26T20:00:00.000Z',
    retryCount: 0,
    maxRetries: 3,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    metadata: {
      teamId: 'team-product',
      triggerSource: 'event',
    },
    ...overrides,
  };
}

function buildTeam(overrides: Partial<Team> = {}): Team {
  return {
    id: 'team-product',
    name: 'Crewly Product',
    description: 'Product team',
    members: [
      {
        id: 'tl-1',
        name: 'Sam',
        sessionName: 'crewly-product-sam',
        role: 'team-leader',
        systemPrompt: '',
        agentStatus: 'active',
        workingStatus: 'idle',
        runtimeType: 'claude-code',
        createdAt: '',
        updatedAt: '',
        hierarchyLevel: 1,
        canDelegate: true,
      } as Team['members'][number],
    ],
    projectIds: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function buildMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'mission-1',
    objective: 'Ship Crewly Pro 1.0',
    ownerTeamId: 'team-product',
    successCriteria: [],
    currentStrategy: 'iterative',
    activeProjectTaskIds: [],
    cadence: 'weekly',
    policy: {
      // Minimal valid policy — bridge tests don't exercise any policy gate
      taskCreation: 'free',
      reprioritization: 'free',
      taskClosure: 'free',
      stagingDeploy: 'requires_approval',
      productionDeploy: 'requires_approval',
      spendingMoney: 'requires_approval',
      userVisibleBehavior: 'requires_approval',
      replanning: 'free',
      phaseGateApproval: 'none',
      strictPhaseGate: false,
    },
    status: 'active',
    createdAt: '',
    updatedAt: '',
    learnings: [],
    ...overrides,
  } as Mission;
}

function buildEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'evt-1',
    type: 'task:done_by_worker',
    timestamp: '2026-04-27T01:00:00.000Z',
    teamId: 'team-product',
    teamName: 'Crewly Product',
    memberId: 'leo',
    memberName: 'Leo',
    sessionName: 'crewly-product-leo',
    previousValue: 'running',
    newValue: 'done_by_worker',
    changedField: 'taskStatus',
    workItemId: 'wi-source-1',
    ...overrides,
  };
}

/**
 * Build a fake TaskPoolService — only the methods bridge actually calls.
 * Tracks addToPool calls on a shared array so tests can assert deterministic-id.
 */
function buildFakeTaskPool(initial: WorkItem[] = []) {
  const items = new Map<string, WorkItem>();
  for (const wi of initial) items.set(wi.id, wi);
  const addCalls: WorkItem[] = [];

  return {
    addCalls,
    items,
    addToPool: jest.fn(async (wi: WorkItem) => {
      addCalls.push(wi);
      // Mirror real addToPool: dedup by id
      if (items.has(wi.id)) return;
      items.set(wi.id, wi);
    }),
    findWorkItem: jest.fn(async (id: string) => items.get(id) ?? null),
  };
}

function buildBridge({
  taskPool,
  loadMission,
  loadTeam,
  eventBus,
}: {
  taskPool: ReturnType<typeof buildFakeTaskPool>;
  loadMission?: (id: string) => Promise<Mission | null>;
  loadTeam?: (id: string) => Promise<Team | null>;
  eventBus?: EventBusService;
}) {
  const bus = eventBus ?? new EventBusService();
  return {
    bus,
    bridge: new EventToWorkItemBridge({
      eventBus: bus,
      // Cast: we only need the methods bridge actually uses
      taskPool: taskPool as unknown as import('../task-pool/task-pool.service.js').TaskPoolService,
      loadMission: loadMission ?? (async () => null),
      loadTeam: loadTeam ?? (async () => buildTeam()),
    }),
  };
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

describe('EventToWorkItemBridge', () => {
  // V5 sanity check at the metadata layer — the file is the source of truth
  // for which event types are subscribed; PR-time grep guards verify there's
  // no parallel Trigger entity in the same directory.
  it('BRIDGE_SUBSCRIBED_EVENTS exposes the 7 event types the brief lists', () => {
    expect(BRIDGE_SUBSCRIBED_EVENTS).toEqual([
      'task:done_by_worker',
      'task:rejected',
      'task:blocked',
      'team:all_tasks_done',
      'mission:review_due',
      'mission:stale',
      'mission:replanned',
    ]);
  });

  describe('start / stop lifecycle', () => {
    it('start() is idempotent — calling twice does not double-subscribe', async () => {
      const sourceWI = buildWorkItem();
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();
      bridge.start();

      bus.publish(buildEvent());
      // Drain microtasks
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      bridge.stop();
    });

    it('stop() detaches subscriptions — no further handler invocations', async () => {
      const sourceWI = buildWorkItem();
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();
      bridge.stop();

      bus.publish(buildEvent());
      await Promise.resolve();
      expect(taskPool.addCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // task:done_by_worker → verification WI for TL
  // -------------------------------------------------------------------------
  describe('task:done_by_worker handler', () => {
    it('creates a verification WI for the TL with deterministic id (V1)', async () => {
      const sourceWI = buildWorkItem();
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:done_by_worker' }));
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const verifyWI = taskPool.addCalls[0];
      expect(verifyWI.id).toBe(`${sourceWI.id}:verify:${sourceWI.id}`);
      expect(verifyWI.type).toBe('review');
      expect(verifyWI.owner).toBe('team_lead');
      expect(verifyWI.target).toBe('crewly-product-sam');
      // V1: idempotencyKey === id (documentary)
      expect(verifyWI.metadata?.idempotencyKey).toBe(verifyWI.id);
      // V6: triggerSource = 'event' on bridge-created WI
      expect(verifyWI.metadata?.triggerSource).toBe('event');
      bridge.stop();
    });

    it('replay of the same event does NOT create a duplicate verification WI (V1)', async () => {
      const sourceWI = buildWorkItem();
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:done_by_worker', id: 'evt-A' }));
      await bridge.flushPending();
      // Use a distinct sessionName so the EventBus's own publish-debounce doesn't
      // suppress the second publish; the bridge-side dedup is the contract under test.
      bus.publish(
        buildEvent({ type: 'task:done_by_worker', id: 'evt-B', sessionName: 'agent-other' }),
      );
      await bridge.flushPending();

      // addToPool was called twice (deterministic) but pool.items has one entry
      expect(taskPool.addCalls).toHaveLength(2);
      expect(taskPool.items.size).toBe(2); // sourceWI + 1 verify WI
      bridge.stop();
    });

    it('logs and skips when source WorkItem cannot be resolved', async () => {
      const taskPool = buildFakeTaskPool([]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:done_by_worker' }));
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(0);
      bridge.stop();
    });
  });

  // -------------------------------------------------------------------------
  // task:rejected → retry / escalation (V2)
  // -------------------------------------------------------------------------
  describe('task:rejected handler (V2 retry cap)', () => {
    it('first rejection creates a retry WI with retryCount=1', async () => {
      const sourceWI = buildWorkItem({ retryCount: 0 });
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:rejected' }));
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const retryWI = taskPool.addCalls[0];
      expect(retryWI.id).toBe(`${sourceWI.id}:retry:1`);
      expect(retryWI.retryCount).toBe(1);
      expect(retryWI.type).toBe(sourceWI.type); // same execution type
      expect(retryWI.target).toBe(sourceWI.target); // same worker
      expect(retryWI.metadata?.idempotencyKey).toBe(retryWI.id); // V1
      bridge.stop();
    });

    it('third rejection escalates to a review WI (V2 — does NOT enqueue a retry)', async () => {
      // Source WI has already been retried 3 times → retryCount >= cap
      const sourceWI = buildWorkItem({ retryCount: 3 });
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:rejected' }));
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const escalation = taskPool.addCalls[0];
      expect(escalation.id).toBe(`${sourceWI.id}:review:max_retries`);
      expect(escalation.type).toBe('review');
      expect(escalation.owner).toBe('team_lead');
      expect(escalation.target).toBe('crewly-product-sam');
      expect(escalation.metadata?.reviewReason).toBe('max_retries_exceeded');
      // V2 invariant: NO retry-shaped WI (id contains ':retry:')
      const retries = taskPool.addCalls.filter((wi) => wi.id.includes(':retry:'));
      expect(retries).toHaveLength(0);
      bridge.stop();
    });

    it('cron-sourced rejection demotes triggerSource on the retry WI (V6 / V9)', async () => {
      // Sam's reminder #2: real WorkItem fixture with metadata.triggerSource='cron'
      const sourceWI = buildWorkItem({
        retryCount: 0,
        metadata: { teamId: 'team-product', triggerSource: 'cron' },
      });
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:rejected' }));
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const retryWI = taskPool.addCalls[0];
      // V6 / V9 demote: cron → event
      expect(retryWI.metadata?.triggerSource).toBe('event');
      expect(retryWI.metadata?.triggerSource).not.toBe('cron');
      bridge.stop();
    });
  });

  // -------------------------------------------------------------------------
  // task:blocked → review WI for TL
  // -------------------------------------------------------------------------
  describe('task:blocked handler', () => {
    it('creates a task-blocked review WI for the TL (reviewReason=task_blocked)', async () => {
      const sourceWI = buildWorkItem({ status: 'blocked' });
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({ taskPool });
      bridge.start();

      bus.publish(buildEvent({ type: 'task:blocked' }));
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const reviewWI = taskPool.addCalls[0];
      expect(reviewWI.id).toBe(`${sourceWI.id}:review:blocked`);
      expect(reviewWI.type).toBe('review');
      expect(reviewWI.owner).toBe('team_lead');
      expect(reviewWI.metadata?.reviewReason).toBe('task_blocked');
      expect(reviewWI.metadata?.idempotencyKey).toBe(reviewWI.id);
      bridge.stop();
    });
  });

  // -------------------------------------------------------------------------
  // team:all_tasks_done → emit mission:review_due
  // -------------------------------------------------------------------------
  describe('team:all_tasks_done handler', () => {
    it('emits mission:review_due when mission is active', async () => {
      const mission = buildMission();
      const taskPool = buildFakeTaskPool([]);
      const { bridge, bus } = buildBridge({
        taskPool,
        loadMission: async () => mission,
      });

      const downstream = jest.fn();
      bus.onInProcess('mission:review_due', downstream);
      bridge.start();

      bus.publish(
        buildEvent({
          type: 'team:all_tasks_done',
          missionId: mission.id,
          workItemId: undefined,
        }),
      );
      await bridge.flushPending();

      // Downstream fired → bridge re-emitted as mission:review_due
      expect(downstream).toHaveBeenCalledTimes(1);
      const downstreamEvent = downstream.mock.calls[0][0] as AgentEvent;
      expect(downstreamEvent.type).toBe('mission:review_due');
      expect(downstreamEvent.missionId).toBe(mission.id);

      // And the chained mission:review_due handler created the review WI
      // (the bridge handler also fires for the emitted event)
      const reviewWIs = taskPool.addCalls.filter((wi) => wi.type === 'review');
      expect(reviewWIs.length).toBeGreaterThanOrEqual(1);
      bridge.stop();
    });

    it('does NOT emit mission:review_due for non-active mission', async () => {
      const mission = buildMission({ status: 'paused' });
      const taskPool = buildFakeTaskPool([]);
      const { bridge, bus } = buildBridge({
        taskPool,
        loadMission: async () => mission,
      });

      const downstream = jest.fn();
      bus.onInProcess('mission:review_due', downstream);
      bridge.start();

      bus.publish(
        buildEvent({
          type: 'team:all_tasks_done',
          missionId: mission.id,
          workItemId: undefined,
        }),
      );
      await bridge.flushPending();

      expect(downstream).not.toHaveBeenCalled();
      expect(taskPool.addCalls).toHaveLength(0);
      bridge.stop();
    });
  });

  // -------------------------------------------------------------------------
  // mission:* → review WI
  // -------------------------------------------------------------------------
  describe('mission:* handlers', () => {
    it('mission:review_due creates a review WI with REVIEW-1-compatible id', async () => {
      const mission = buildMission();
      const taskPool = buildFakeTaskPool([]);
      const { bridge, bus } = buildBridge({
        taskPool,
        loadMission: async () => mission,
      });
      bridge.start();

      bus.publish(
        buildEvent({
          type: 'mission:review_due',
          missionId: mission.id,
          workItemId: undefined,
        }),
      );
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const reviewWI = taskPool.addCalls[0];
      expect(reviewWI.id).toMatch(/^mission-1:review:\d{4}-\d{2}-\d{2}$/);
      expect(reviewWI.metadata?.reviewReason).toBe('scheduled_review');
      bridge.stop();
    });

    it('mission:stale creates a no_active_work review WI keyed on the day', async () => {
      const mission = buildMission();
      const taskPool = buildFakeTaskPool([]);
      const { bridge, bus } = buildBridge({
        taskPool,
        loadMission: async () => mission,
      });
      bridge.start();

      bus.publish(
        buildEvent({
          type: 'mission:stale',
          missionId: mission.id,
          workItemId: undefined,
        }),
      );
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const reviewWI = taskPool.addCalls[0];
      expect(reviewWI.id).toMatch(/^mission-1:review:stale:\d{4}-\d{2}-\d{2}$/);
      expect(reviewWI.metadata?.reviewReason).toBe('no_active_work');
      bridge.stop();
    });

    it('mission:replanned uses the event id in the review WI id (one-shot per replan)', async () => {
      const mission = buildMission();
      const taskPool = buildFakeTaskPool([]);
      const { bridge, bus } = buildBridge({
        taskPool,
        loadMission: async () => mission,
      });
      bridge.start();

      const eventId = 'replan-evt-42';
      bus.publish(
        buildEvent({
          id: eventId,
          type: 'mission:replanned',
          missionId: mission.id,
          workItemId: undefined,
        }),
      );
      await bridge.flushPending();

      expect(taskPool.addCalls).toHaveLength(1);
      const reviewWI = taskPool.addCalls[0];
      expect(reviewWI.id).toBe(`mission-1:review:replan:${eventId}`);
      bridge.stop();
    });
  });

  // -------------------------------------------------------------------------
  // V4 — TL fail-fast
  // -------------------------------------------------------------------------
  describe('V4: team-lead fail-fast', () => {
    it('throws BridgeTeamLeadResolutionError when team is unknown', async () => {
      const sourceWI = buildWorkItem();
      const taskPool = buildFakeTaskPool([sourceWI]);
      const { bridge, bus } = buildBridge({
        taskPool,
        loadTeam: async () => null, // no team resolvable
      });
      // Hook into the EE so we can observe the error
      const errors: unknown[] = [];
      bridge.start();
      bus.publish(buildEvent({ type: 'task:done_by_worker' }));

      // Drain microtasks so the safeDispatch's rethrow + EventBus's
      // .catch() fire and we can grab the rejected promise from the
      // bridge directly.
      await bridge.flushPending();

      // No WI was created because the TL resolution threw
      expect(taskPool.addCalls).toHaveLength(0);
      // Sanity: the actual error class is reachable via direct call too
      const direct = (
        bridge as unknown as {
          resolveTeamLeadSession: (wi: WorkItem) => Promise<string>;
        }
      ).resolveTeamLeadSession(sourceWI);
      await expect(direct).rejects.toBeInstanceOf(BridgeTeamLeadResolutionError);
      void errors;
      bridge.stop();
    });

    it('throws when team has no members at all', async () => {
      const sourceWI = buildWorkItem();
      const taskPool = buildFakeTaskPool([sourceWI]);
      const teamWithNoMembers = buildTeam({ members: [] });
      const { bridge } = buildBridge({
        taskPool,
        loadTeam: async () => teamWithNoMembers,
      });
      const direct = (
        bridge as unknown as {
          resolveTeamLeadSession: (wi: WorkItem) => Promise<string>;
        }
      ).resolveTeamLeadSession(sourceWI);
      await expect(direct).rejects.toBeInstanceOf(BridgeTeamLeadResolutionError);
    });
  });

  // -------------------------------------------------------------------------
  // V6 / V9 — assertNoCronFromCron
  // -------------------------------------------------------------------------
  describe('V6/V9: cron-recursion guard', () => {
    it('assertNoCronFromCron throws when source WI has triggerSource=cron', () => {
      // Sam's reminder #2: real WorkItem fixture, not a mock
      const cronSource = buildWorkItem({
        metadata: { teamId: 'team-product', triggerSource: 'cron' },
      });
      expect(() => assertNoCronFromCron(cronSource, 'schedule retry cron')).toThrow(
        CronRecursionError,
      );
    });

    it('assertNoCronFromCron is a no-op for event-sourced WI', () => {
      const eventSource = buildWorkItem({
        metadata: { teamId: 'team-product', triggerSource: 'event' },
      });
      expect(() => assertNoCronFromCron(eventSource, 'whatever')).not.toThrow();
    });

    it('assertNoCronFromCron is a no-op for manual-sourced WI', () => {
      const manualSource = buildWorkItem({
        metadata: { teamId: 'team-product', triggerSource: 'manual' },
      });
      expect(() => assertNoCronFromCron(manualSource, 'whatever')).not.toThrow();
    });
  });
});
