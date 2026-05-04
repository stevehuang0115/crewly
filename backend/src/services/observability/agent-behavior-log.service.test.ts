/**
 * Tests for `AgentBehaviorLogService`.
 *
 * Uses an in-memory SQLite DB so the suite stays hermetic and fast.
 *
 * @module services/observability/agent-behavior-log.service.test
 */

import {
  AgentBehaviorLogService,
} from './agent-behavior-log.service.js';
import {
  openObservabilityDatabase,
  type ObservabilityDatabase,
} from './observability-db.js';
import { BEHAVIOR_LOG_EVENT_TYPES } from './agent-behavior-log.types.js';

describe('AgentBehaviorLogService', () => {
  let db: ObservabilityDatabase;
  let svc: AgentBehaviorLogService;
  let nowCounter: number;

  beforeEach(() => {
    db = openObservabilityDatabase({
      inMemory: true,
      skipIntegrityCheck: true,
    });
    nowCounter = 1_700_000_000_000;
    svc = new AgentBehaviorLogService({
      db,
      now: () => ++nowCounter,
    });
  });

  afterEach(() => {
    svc.close();
    db.close();
  });

  describe('record() — agent.action', () => {
    it('inserts an action event with reason=actionType and JSON details', () => {
      const id = svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'crewly-orc',
        actionType: 'delegate',
        taskId: 'req-42',
        details: { recipient: 'sam' },
      });

      expect(id).toBeGreaterThan(0);

      const rows = svc.listRecent(10);
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.eventType).toBe('agent.action');
      expect(r.agent).toBe('crewly-orc');
      expect(r.reason).toBe('delegate');
      expect(r.taskId).toBe('req-42');
      expect(r.amount).toBe(0);
      expect(r.details).toEqual({ recipient: 'sam' });
    });

    it('handles missing optional fields gracefully', () => {
      const id = svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'a',
        actionType: 'implement',
      });
      expect(id).toBeGreaterThan(0);
      const r = svc.listRecent(1)[0]!;
      expect(r.taskId).toBe('');
      expect(r.details).toEqual({});
    });
  });

  describe('record() — agent.escalation', () => {
    it('writes escalating agent / target / reason correctly', () => {
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION,
        escalatingAgent: 'sam',
        escalatedTo: 'orchestrator',
        reason: 'design-decision',
        taskId: 'task-1',
        details: { kind: 'arch' },
      });
      const r = svc.listRecent(1)[0]!;
      expect(r.eventType).toBe('agent.escalation');
      expect(r.agent).toBe('sam');
      expect(r.subject).toBe('orchestrator');
      expect(r.reason).toBe('design-decision');
      expect(r.taskId).toBe('task-1');
      expect(r.details).toEqual({ kind: 'arch' });
    });
  });

  describe('record() — slack.delivery.failed', () => {
    it('captures thread, agent and reason', () => {
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.SLACK_DELIVERY_FAILED,
        agent: 'crewly-orc',
        thread: 'D0AC7NF5N7L:123.456',
        reason: 'no_reply_called',
      });
      const r = svc.listRecent(1)[0]!;
      expect(r.eventType).toBe('slack.delivery.failed');
      expect(r.agent).toBe('crewly-orc');
      expect(r.subject).toBe('D0AC7NF5N7L:123.456');
      expect(r.reason).toBe('no_reply_called');
    });
  });

  describe('record() — prompt.size.bytes', () => {
    it('stores byte count in amount', () => {
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES,
        agent: 'leo',
        bytes: 12_345,
        sessionId: 'sess-9',
      });
      const r = svc.listRecent(1)[0]!;
      expect(r.eventType).toBe('prompt.size.bytes');
      expect(r.agent).toBe('leo');
      expect(r.subject).toBe('sess-9');
      expect(r.amount).toBe(12_345);
    });

    it('floors fractional bytes and clamps negatives to zero', () => {
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES,
        agent: 'a',
        bytes: 7.9,
      });
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES,
        agent: 'b',
        bytes: -10,
      });
      const rows = svc.listRecent(10);
      // listRecent returns newest first
      const a = rows.find((r) => r.agent === 'a')!;
      const b = rows.find((r) => r.agent === 'b')!;
      expect(a.amount).toBe(7);
      expect(b.amount).toBe(0);
    });
  });

  describe('listRecent()', () => {
    it('orders newest first and respects the limit', () => {
      for (let i = 0; i < 5; i++) {
        svc.record({
          type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
          agent: 'a',
          actionType: 'implement',
          details: { i },
        });
      }
      const rows = svc.listRecent(3);
      expect(rows).toHaveLength(3);
      expect((rows[0]!.details as { i: number }).i).toBe(4);
      expect((rows[2]!.details as { i: number }).i).toBe(2);
    });

    it('filters by event type', () => {
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'a',
        actionType: 'implement',
      });
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION,
        escalatingAgent: 'a',
        escalatedTo: 'orc',
        reason: 'x',
      });
      const onlyEsc = svc.listRecent(
        10,
        BEHAVIOR_LOG_EVENT_TYPES.AGENT_ESCALATION,
      );
      expect(onlyEsc).toHaveLength(1);
      expect(onlyEsc[0]!.eventType).toBe('agent.escalation');
    });
  });

  describe('countByEvent()', () => {
    it('groups counts by event_type', () => {
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'a',
        actionType: 'implement',
      });
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'b',
        actionType: 'delegate',
      });
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.PROMPT_SIZE_BYTES,
        agent: 'a',
        bytes: 1,
      });
      const counts = svc.countByEvent();
      expect(counts['agent.action']).toBe(2);
      expect(counts['prompt.size.bytes']).toBe(1);
    });

    it('honours the sinceTs cutoff', () => {
      // First two events at timestamps 1_700_000_000_001 and ..002
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'a',
        actionType: 'implement',
      });
      svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'b',
        actionType: 'implement',
      });
      // Cutoff at 1_700_000_000_002 — only the second event counts.
      const counts = svc.countByEvent(1_700_000_000_002);
      expect(counts['agent.action']).toBe(1);
    });
  });

  describe('record() resilience', () => {
    it('returns null and does not throw on insert failure', () => {
      // Force a failure by closing the DB before record() runs.
      db.close();
      const id = svc.record({
        type: BEHAVIOR_LOG_EVENT_TYPES.AGENT_ACTION,
        agent: 'a',
        actionType: 'implement',
      });
      expect(id).toBeNull();
    });
  });
});
