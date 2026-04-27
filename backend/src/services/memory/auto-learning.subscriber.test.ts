/**
 * Tests for AutoLearningSubscriber (LEARN-1).
 *
 * Covers:
 *   - one recordLearning per mapped event (per category)
 *   - templated summary content (entity, transition, resolver, mission/team, ts)
 *   - V1 idempotency: replayed event produces a single learning
 *   - skip path for events without an identifying key
 *   - skip path for events with no category mapping
 *   - error isolation: a rejected recordLearning is logged, not propagated
 *   - lifecycle: start/stop is idempotent; stop detaches all subscriptions
 *   - V7 / V9 self-checks: subscriber exports zero new event-class symbols
 *
 * @module services/memory/auto-learning.subscriber.test
 */

import { EventBusService } from '../event-bus/event-bus.service.js';
import {
  AutoLearningSubscriber,
  AUTO_LEARNING_AGENT_ID,
  AUTO_LEARNING_AGENT_ROLE,
  LEARN_SUBSCRIBED_EVENTS,
} from './auto-learning.subscriber.js';
import type { AutoLearningTag } from './auto-learning.subscriber.js';
import type { IMemoryService, LearningParams } from './memory.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';

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
 * Build a real-shaped AgentEvent. Every test that exercises a handler uses
 * this so the Sam-rule "real shape, not a partial mock" holds.
 */
function buildEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: 'evt-1',
    type: 'task:verified',
    timestamp: '2026-04-27T13:00:00.000Z',
    teamId: 'team-product',
    teamName: 'Crewly Product',
    memberId: 'mem-leo',
    memberName: 'Leo',
    sessionName: 'crewly-product-leo-member-n',
    previousValue: 'running',
    newValue: 'verified',
    changedField: 'taskStatus',
    workItemId: 'wi-source-1',
    missionId: 'mission-1',
    ...overrides,
  };
}

/**
 * In-memory fake of {@link IMemoryService}. Captures every recordLearning
 * call so tests can assert on the recorded shape and count without going
 * near the disk.
 */
function buildFakeMemoryService(): {
  service: IMemoryService;
  recorded: LearningParams[];
  rejectNext: (err?: Error) => void;
} {
  const recorded: LearningParams[] = [];
  let nextRejection: Error | null = null;

  const service: IMemoryService = {
    remember: jest.fn(),
    recall: jest.fn(),
    getFullContext: jest.fn(),
    initializeForSession: jest.fn(),
    getAgentMemoryService: jest.fn(),
    getProjectMemoryService: jest.fn(),
    recordLearning: jest.fn(async (params: LearningParams) => {
      if (nextRejection) {
        const err = nextRejection;
        nextRejection = null;
        throw err;
      }
      recorded.push(params);
    }),
  } as unknown as IMemoryService;

  return {
    service,
    recorded,
    rejectNext: (err?: Error) => {
      nextRejection = err ?? new Error('simulated recordLearning failure');
    },
  };
}

/** Convenience: build a subscriber wired to the given fake. */
function buildSubscriber(memoryService: IMemoryService, eventBus: EventBusService) {
  return new AutoLearningSubscriber({
    eventBus,
    memoryService,
    projectPath: '/fake/project',
    dedupCapacity: 100,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoLearningSubscriber', () => {
  let bus: EventBusService;
  let subscriber: AutoLearningSubscriber;
  let memory: ReturnType<typeof buildFakeMemoryService>;

  beforeEach(() => {
    bus = new EventBusService();
    memory = buildFakeMemoryService();
    subscriber = buildSubscriber(memory.service, bus);
    subscriber.start();
  });

  afterEach(() => {
    subscriber.stop();
    bus.cleanup();
  });

  // -------------------------------------------------------------------------
  // Subscription contract
  // -------------------------------------------------------------------------

  describe('subscription contract', () => {
    it('subscribes to exactly the five LEARN_SUBSCRIBED_EVENTS', () => {
      // Pinned by the closed-set rationale on LEARN_SUBSCRIBED_EVENTS (Arch
      // N1, 2026-04-27): this list is the canonical, closed set. Length and
      // ordering are part of the contract — adding a member without updating
      // this assertion fails CI, which forces the future contributor to also
      // update the EVENT_CATEGORY_MAP and add per-event dispatch coverage.
      expect(LEARN_SUBSCRIBED_EVENTS).toHaveLength(5);
      expect(LEARN_SUBSCRIBED_EVENTS).toEqual([
        'task:verified',
        'task:done',
        'task:rejected',
        'task:failed',
        'mission:replanned',
      ]);
    });

    it('start() is idempotent — calling twice does not double-subscribe', async () => {
      // Second start() should be a no-op; otherwise the same event would
      // produce two learnings.
      subscriber.start();
      bus.publish(buildEvent({ type: 'task:verified' }));
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(1);
    });

    it('stop() detaches all subscriptions', async () => {
      subscriber.stop();
      bus.publish(buildEvent({ type: 'task:verified' }));
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(0);
    });

    it('stop() is idempotent — calling twice does not throw', () => {
      subscriber.stop();
      expect(() => subscriber.stop()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Per-event category mapping (LEARN-1 acceptance criteria)
  // -------------------------------------------------------------------------

  describe('event → category mapping', () => {
    const cases: Array<{ type: AgentEvent['type']; tag: AutoLearningTag }> = [
      { type: 'task:verified', tag: 'pattern' },
      { type: 'task:done', tag: 'pattern' },
      { type: 'task:rejected', tag: 'gotcha' },
      { type: 'task:failed', tag: 'gotcha' },
      { type: 'mission:replanned', tag: 'sop_update' },
    ];

    it.each(cases)('$type → records learning tagged [$tag]', async ({ type, tag }) => {
      bus.publish(buildEvent({ id: `evt-${type}`, type, workItemId: `wi-${type}` }));
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(1);
      expect(memory.recorded[0].learning.startsWith(`[${tag}] `)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Templated summary content
  // -------------------------------------------------------------------------

  describe('templated summary', () => {
    it('includes WorkItem id, transition, team/mission/resolver, timestamp', async () => {
      bus.publish(
        buildEvent({
          type: 'task:rejected',
          workItemId: 'wi-42',
          previousValue: 'running',
          newValue: 'rejected',
          teamId: 'team-X',
          missionId: 'mission-Y',
          sessionName: 'crewly-product-leo',
          timestamp: '2026-04-27T14:30:00.000Z',
        }),
      );
      await subscriber.flushPending();

      const learning = memory.recorded[0].learning;
      expect(learning).toContain('[gotcha]');
      expect(learning).toContain('[[WorkItem-wi-42]]');
      expect(learning).toContain('task:rejected');
      expect(learning).toContain('running→rejected');
      expect(learning).toContain('team=team-X');
      expect(learning).toContain('mission=mission-Y');
      expect(learning).toContain('resolver=crewly-product-leo');
      expect(learning).toContain('timestamp=2026-04-27T14:30:00.000Z');
    });

    it('uses Mission entity prefix and missionId for mission:replanned', async () => {
      bus.publish(
        buildEvent({
          type: 'mission:replanned',
          // mission events typically have no workItemId
          workItemId: undefined,
          missionId: 'mission-Z',
          newValue: 'replanned',
          previousValue: '',
        }),
      );
      await subscriber.flushPending();
      const learning = memory.recorded[0].learning;
      expect(learning).toContain('[sop_update]');
      expect(learning).toContain('[[Mission-mission-Z]]');
    });

    it('records under the system identity, not the resolver session', async () => {
      bus.publish(buildEvent({ type: 'task:verified', sessionName: 'some-resolver' }));
      await subscriber.flushPending();
      expect(memory.recorded[0].agentId).toBe(AUTO_LEARNING_AGENT_ID);
      expect(memory.recorded[0].agentRole).toBe(AUTO_LEARNING_AGENT_ROLE);
      expect(memory.recorded[0].projectPath).toBe('/fake/project');
    });

    it('passes workItemId as relatedTask for task:* events', async () => {
      bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-task-link' }));
      await subscriber.flushPending();
      expect(memory.recorded[0].relatedTask).toBe('wi-task-link');
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency (Arch Veto V1)
  // -------------------------------------------------------------------------

  describe('idempotency (V1)', () => {
    it('replayed task event with same workItemId does NOT double-record', async () => {
      const event = buildEvent({ type: 'task:verified', id: 'evt-A', workItemId: 'wi-1' });
      bus.publish(event);
      // Same event, different envelope id (replay)
      bus.publish({ ...event, id: 'evt-A-replay' });
      await subscriber.flushPending();

      expect(memory.recorded).toHaveLength(1);
      expect(subscriber.dedupSize).toBe(1);
    });

    it('different workItemIds in the same event type produce separate learnings', async () => {
      // sessionName must vary or the EventBus's (type,sessionName) debounce
      // suppresses the second publish within the dedup window.
      bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-1', sessionName: 's-A' }));
      bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-2', sessionName: 's-B' }));
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(2);
      expect(subscriber.dedupSize).toBe(2);
    });

    it('same workItemId in different event types produces separate learnings', async () => {
      // A WorkItem can be both 'task:done' AND later 'task:verified' — those
      // are distinct lifecycle moments and each warrants its own learning.
      // Different event types bypass the bus's (type,sessionName) dedup.
      bus.publish(buildEvent({ type: 'task:done', workItemId: 'wi-1' }));
      bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-1' }));
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(2);
    });

    it('mission:replanned dedupes on missionId + eventId, not just missionId', async () => {
      // Two distinct replans on the same mission → two learnings. Vary
      // sessionName to bypass the EventBus (type,sessionName) debounce.
      bus.publish(
        buildEvent({
          type: 'mission:replanned',
          id: 'replan-1',
          missionId: 'mission-1',
          workItemId: undefined,
          sessionName: 's-A',
        }),
      );
      bus.publish(
        buildEvent({
          type: 'mission:replanned',
          id: 'replan-2',
          missionId: 'mission-1',
          workItemId: undefined,
          sessionName: 's-B',
        }),
      );
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(2);
    });

    it('LRU cap is respected — exceeding capacity evicts oldest keys', async () => {
      const tightSub = new AutoLearningSubscriber({
        eventBus: bus,
        memoryService: memory.service,
        projectPath: '/fake/project',
        dedupCapacity: 2, // tiny cap to exercise eviction
      });
      tightSub.start();
      try {
        // Three different keys → cap=2 evicts the first. Stop the parent
        // subscriber so only `tightSub` records (avoids double-counting), and
        // vary sessionName to bypass the bus's (type,sessionName) debounce.
        subscriber.stop();
        bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-A', sessionName: 's-A' }));
        bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-B', sessionName: 's-B' }));
        bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-C', sessionName: 's-C' }));
        await tightSub.flushPending();
        expect(tightSub.dedupSize).toBe(2);
        // Replay 'A' — should be re-recorded because A was evicted from the cap=2 set.
        bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-A', sessionName: 's-D' }));
        await tightSub.flushPending();
        // 3 from initial + 1 from re-record = 4 total recordLearning calls.
        expect(memory.recorded).toHaveLength(4);
      } finally {
        tightSub.stop();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases — events that should NOT record
  // -------------------------------------------------------------------------

  describe('skip paths', () => {
    it('task event without workItemId/taskId is skipped', async () => {
      bus.publish(
        buildEvent({
          type: 'task:verified',
          workItemId: undefined,
          taskId: undefined,
        }),
      );
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(0);
    });

    it('mission event without missionId is skipped', async () => {
      bus.publish(
        buildEvent({
          type: 'mission:replanned',
          missionId: undefined,
          workItemId: undefined,
        }),
      );
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(0);
    });

    it('task event uses taskId fallback when workItemId is absent', async () => {
      bus.publish(
        buildEvent({
          type: 'task:verified',
          workItemId: undefined,
          taskId: 'legacy-task-id',
        }),
      );
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(1);
      expect(memory.recorded[0].relatedTask).toBe('legacy-task-id');
    });

    it('events the subscriber is not subscribed to do nothing', async () => {
      // 'task:submitted' is not in LEARN_SUBSCRIBED_EVENTS — no recording.
      bus.publish(buildEvent({ type: 'task:submitted' }));
      await subscriber.flushPending();
      expect(memory.recorded).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Error isolation
  // -------------------------------------------------------------------------

  describe('error isolation', () => {
    it('a rejected recordLearning is caught — does not throw to publisher', async () => {
      memory.rejectNext(new Error('disk full'));
      // bus.publish must not throw. Handler's logger.error captures the failure.
      expect(() => bus.publish(buildEvent({ type: 'task:verified' }))).not.toThrow();
      await subscriber.flushPending();
      // The dedup key was still added so a subsequent retry of the same event
      // is suppressed (matches BRIDGE-1's V1 semantics — safe replay > correctness).
      expect(subscriber.dedupSize).toBe(1);
    });

    it('a synchronous handler throw does not prevent later events from recording', async () => {
      memory.rejectNext(new Error('transient'));
      // Vary sessionName to bypass the bus's (type,sessionName) debounce.
      bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-1', sessionName: 's-A' }));
      bus.publish(buildEvent({ type: 'task:verified', workItemId: 'wi-2', sessionName: 's-B' }));
      await subscriber.flushPending();
      // wi-1 failed (rejection), wi-2 must still have been recorded.
      expect(memory.recorded.map((p) => p.relatedTask)).toEqual(['wi-2']);
    });
  });

  // -------------------------------------------------------------------------
  // Veto self-checks (V7, V9)
  // -------------------------------------------------------------------------

  describe('Arch veto self-checks', () => {
    it('exports no new event-class symbol (V7) — only the subscriber + tag type', () => {
      // If a future contributor adds `class LearningEvent` or `interface
      // LearningEvent` to this module, this spec must catch it. We assert
      // the module's named exports stay on the allowlist.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('./auto-learning.subscriber.js') as Record<string, unknown>;
      const exported = Object.keys(mod).sort();
      expect(exported).toEqual(
        [
          'AUTO_LEARNING_AGENT_ID',
          'AUTO_LEARNING_AGENT_ROLE',
          'AutoLearningSubscriber',
          'DEDUP_LRU_CAPACITY',
          'LEARN_SUBSCRIBED_EVENTS',
        ].sort(),
      );
    });

    it('does not inject a new memory scope (V9) — uses recordLearning, not remember', async () => {
      bus.publish(buildEvent({ type: 'task:verified' }));
      await subscriber.flushPending();
      // The fake records LearningParams (no scope/category fields). Asserting
      // its shape catches a future contributor wiring the subscriber to the
      // unified `remember` operation (which does take scope) — that would be
      // a V9 leak vector.
      const recorded = memory.recorded[0] as unknown as Record<string, unknown>;
      expect('scope' in recorded).toBe(false);
      expect('category' in recorded).toBe(false);
    });
  });
});
