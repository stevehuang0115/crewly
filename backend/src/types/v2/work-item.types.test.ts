/**
 * Tests for V2 WorkItem Type Definitions
 *
 * @module types/v2/work-item.types.test
 */

import {
  WORK_ITEM_TYPES,
  WORK_ITEM_OWNERS,
  WORK_ITEM_STATUSES,
  TERMINAL_WORK_ITEM_STATUSES,
  SLA_TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_TRANSITIONS,
  TRANSITION_PERMISSIONS,
  DEFAULT_MAX_RETRIES,
  isValidWorkItemType,
  isValidWorkItemStatus,
  isValidWorkItemOwner,
  isValidWorkItemTransition,
  isTransitionPermitted,
  isWorkItem,
  validateCreateWorkItemInput,
  createWorkItem,
  getTtlAnchorAt,
  LAST_REQUEUED_AT_METADATA_KEY,
} from './work-item.types.js';
import type { CreateWorkItemInput, WorkItem } from './work-item.types.js';

describe('WorkItem Types', () => {
  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  describe('WORK_ITEM_TYPES', () => {
    it('should contain all 8 types', () => {
      expect(WORK_ITEM_TYPES).toHaveLength(8);
      expect(WORK_ITEM_TYPES).toContain('delegate');
      expect(WORK_ITEM_TYPES).toContain('project_task');
      expect(WORK_ITEM_TYPES).toContain('check');
      expect(WORK_ITEM_TYPES).toContain('notify');
      expect(WORK_ITEM_TYPES).toContain('cron_run');
      expect(WORK_ITEM_TYPES).toContain('review');
      expect(WORK_ITEM_TYPES).toContain('confirm');
      expect(WORK_ITEM_TYPES).toContain('reconcile');
    });
  });

  describe('WORK_ITEM_STATUSES', () => {
    it('should contain all 13 statuses', () => {
      expect(WORK_ITEM_STATUSES).toHaveLength(13);
      expect(WORK_ITEM_STATUSES).toContain('proposed');
      expect(WORK_ITEM_STATUSES).toContain('accepted');
      expect(WORK_ITEM_STATUSES).toContain('escalated');
      expect(WORK_ITEM_STATUSES).toContain('done_by_worker');
      expect(WORK_ITEM_STATUSES).toContain('verified');
      expect(WORK_ITEM_STATUSES).toContain('rejected');
    });
  });

  describe('TERMINAL_WORK_ITEM_STATUSES', () => {
    it('should contain done, verified, and cancelled', () => {
      expect(TERMINAL_WORK_ITEM_STATUSES.has('done')).toBe(true);
      expect(TERMINAL_WORK_ITEM_STATUSES.has('verified')).toBe(true);
      expect(TERMINAL_WORK_ITEM_STATUSES.has('cancelled')).toBe(true);
    });
    it('should have exactly 3 entries', () => {
      expect(TERMINAL_WORK_ITEM_STATUSES.size).toBe(3);
    });
  });

  describe('SLA_TERMINAL_WORK_ITEM_STATUSES (INBOUND-1.f2 N2 hoist)', () => {
    it('should contain all strict-terminal statuses + failed + rejected', () => {
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('done')).toBe(true);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('verified')).toBe(true);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('cancelled')).toBe(true);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('failed')).toBe(true);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('rejected')).toBe(true);
    });
    it('should have exactly 5 entries', () => {
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.size).toBe(5);
    });
    it('should be a strict superset of TERMINAL_WORK_ITEM_STATUSES', () => {
      for (const s of TERMINAL_WORK_ITEM_STATUSES) {
        expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has(s)).toBe(true);
      }
    });
    it('should NOT include non-terminal active-queue statuses', () => {
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('queued')).toBe(false);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('running')).toBe(false);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('blocked')).toBe(false);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('done_by_worker')).toBe(false);
      expect(SLA_TERMINAL_WORK_ITEM_STATUSES.has('escalated')).toBe(false);
    });
  });

  describe('DEFAULT_MAX_RETRIES', () => {
    it('should be 3', () => {
      expect(DEFAULT_MAX_RETRIES).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // Type Guards
  // -----------------------------------------------------------------------
  describe('isValidWorkItemType', () => {
    it('should return true for all valid types', () => {
      for (const t of WORK_ITEM_TYPES) {
        expect(isValidWorkItemType(t)).toBe(true);
      }
    });
    it('should return false for invalid types', () => {
      expect(isValidWorkItemType('unknown')).toBe(false);
      expect(isValidWorkItemType('')).toBe(false);
    });
  });

  describe('isValidWorkItemStatus', () => {
    it('should return true for all valid statuses', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemStatus(s)).toBe(true);
      }
    });
    it('should return false for invalid statuses', () => {
      expect(isValidWorkItemStatus('pending')).toBe(false);
    });
  });

  describe('isValidWorkItemOwner', () => {
    it('should return true for all valid owners', () => {
      for (const o of WORK_ITEM_OWNERS) {
        expect(isValidWorkItemOwner(o)).toBe(true);
      }
    });
    it('should return false for invalid owners', () => {
      expect(isValidWorkItemOwner('admin')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // State Machine Transitions
  // -----------------------------------------------------------------------
  describe('isValidWorkItemTransition', () => {
    it('should allow queued → running', () => {
      expect(isValidWorkItemTransition('queued', 'running')).toBe(true);
    });
    it('should allow queued → scheduled', () => {
      expect(isValidWorkItemTransition('queued', 'scheduled')).toBe(true);
    });
    it('should allow queued → cancelled', () => {
      expect(isValidWorkItemTransition('queued', 'cancelled')).toBe(true);
    });
    it('should allow scheduled → queued', () => {
      expect(isValidWorkItemTransition('scheduled', 'queued')).toBe(true);
    });
    it('should allow running → done', () => {
      expect(isValidWorkItemTransition('running', 'done')).toBe(true);
    });
    it('should allow running → failed', () => {
      expect(isValidWorkItemTransition('running', 'failed')).toBe(true);
    });
    it('should allow running → blocked', () => {
      expect(isValidWorkItemTransition('running', 'blocked')).toBe(true);
    });
    // TRANS-2: legalised for TaskPoolService.releaseBack (Reconciler abandon
    // and TL-initiated busy-release). Permission-gated in TRANSITION_PERMISSIONS.
    it('should allow running → queued (TRANS-2 releaseBack)', () => {
      expect(isValidWorkItemTransition('running', 'queued')).toBe(true);
    });
    it('should allow blocked → queued', () => {
      expect(isValidWorkItemTransition('blocked', 'queued')).toBe(true);
    });
    it('should allow failed → queued (retry)', () => {
      expect(isValidWorkItemTransition('failed', 'queued')).toBe(true);
    });
    it('should disallow done → any', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemTransition('done', s)).toBe(false);
      }
    });
    it('should disallow cancelled → any', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemTransition('cancelled', s)).toBe(false);
      }
    });
    it('should disallow queued → done (must go through running)', () => {
      expect(isValidWorkItemTransition('queued', 'done')).toBe(false);
    });

    // New acceptance/verification flow transitions
    it('should allow queued → proposed', () => {
      expect(isValidWorkItemTransition('queued', 'proposed')).toBe(true);
    });
    it('should allow proposed → accepted', () => {
      expect(isValidWorkItemTransition('proposed', 'accepted')).toBe(true);
    });
    it('should allow proposed → rejected', () => {
      expect(isValidWorkItemTransition('proposed', 'rejected')).toBe(true);
    });
    it('should allow accepted → running', () => {
      expect(isValidWorkItemTransition('accepted', 'running')).toBe(true);
    });
    it('should allow running → done_by_worker', () => {
      expect(isValidWorkItemTransition('running', 'done_by_worker')).toBe(true);
    });
    it('should allow running → escalated', () => {
      expect(isValidWorkItemTransition('running', 'escalated')).toBe(true);
    });
    it('should allow done_by_worker → verified', () => {
      expect(isValidWorkItemTransition('done_by_worker', 'verified')).toBe(true);
    });
    it('should allow done_by_worker → rejected', () => {
      expect(isValidWorkItemTransition('done_by_worker', 'rejected')).toBe(true);
    });
    it('should allow rejected → queued (re-queue)', () => {
      expect(isValidWorkItemTransition('rejected', 'queued')).toBe(true);
    });
    it('should allow escalated → queued', () => {
      expect(isValidWorkItemTransition('escalated', 'queued')).toBe(true);
    });
    it('should disallow verified → any (terminal)', () => {
      for (const s of WORK_ITEM_STATUSES) {
        expect(isValidWorkItemTransition('verified', s)).toBe(false);
      }
    });
  });

  describe('WORK_ITEM_TRANSITIONS completeness', () => {
    it('should have an entry for every status', () => {
      for (const status of WORK_ITEM_STATUSES) {
        expect(WORK_ITEM_TRANSITIONS).toHaveProperty(status);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Role-Based Transition Permissions
  // -----------------------------------------------------------------------
  describe('isTransitionPermitted', () => {
    it('should always permit system role', () => {
      expect(isTransitionPermitted('done_by_worker', 'verified', 'system')).toBe(true);
      expect(isTransitionPermitted('proposed', 'accepted', 'system')).toBe(true);
    });
    it('should permit agent to accept proposals', () => {
      expect(isTransitionPermitted('proposed', 'accepted', 'agent')).toBe(true);
    });
    it('should deny orchestrator from accepting proposals', () => {
      expect(isTransitionPermitted('proposed', 'accepted', 'orchestrator')).toBe(false);
    });
    it('should permit team_lead to verify worker output', () => {
      expect(isTransitionPermitted('done_by_worker', 'verified', 'team_lead')).toBe(true);
    });
    it('should deny agent from verifying their own output', () => {
      expect(isTransitionPermitted('done_by_worker', 'verified', 'agent')).toBe(false);
    });
    it('should permit agent to report done_by_worker', () => {
      expect(isTransitionPermitted('running', 'done_by_worker', 'agent')).toBe(true);
    });
    it('should permit agent to escalate', () => {
      expect(isTransitionPermitted('running', 'escalated', 'agent')).toBe(true);
    });
    it('should permit any role for transitions without explicit permissions', () => {
      // queued → running has no explicit permission entry
      expect(isTransitionPermitted('queued', 'running', 'agent')).toBe(true);
      expect(isTransitionPermitted('queued', 'running', 'orchestrator')).toBe(true);
    });
    it('should only allow TL or orchestrator to propose tasks', () => {
      expect(isTransitionPermitted('queued', 'proposed', 'team_lead')).toBe(true);
      expect(isTransitionPermitted('queued', 'proposed', 'orchestrator')).toBe(true);
      expect(isTransitionPermitted('queued', 'proposed', 'agent')).toBe(false);
    });

    // -------------------------------------------------------------------
    // TRANS-1 F-F: rejected→queued / failed→queued / blocked→queued are
    // restricted to TL/orchestrator/system. Agent self-revival is blocked.
    // -------------------------------------------------------------------

    describe('F-F: re-queue gates (rejected/failed/blocked → queued)', () => {
      it('blocks agent from re-queueing a rejected WorkItem (self-revival hazard)', () => {
        expect(isTransitionPermitted('rejected', 'queued', 'agent')).toBe(false);
      });

      it('allows team_lead to re-queue a rejected WorkItem', () => {
        expect(isTransitionPermitted('rejected', 'queued', 'team_lead')).toBe(true);
      });

      it('allows orchestrator to re-queue a rejected WorkItem', () => {
        expect(isTransitionPermitted('rejected', 'queued', 'orchestrator')).toBe(true);
      });

      it('allows system actor (Reconciler) to re-queue a rejected WorkItem', () => {
        expect(isTransitionPermitted('rejected', 'queued', 'system')).toBe(true);
      });

      it('blocks agent from re-queueing a failed WorkItem (BRIDGE-1 retry path is canonical)', () => {
        expect(isTransitionPermitted('failed', 'queued', 'agent')).toBe(false);
      });

      it('allows team_lead to re-queue a failed WorkItem', () => {
        expect(isTransitionPermitted('failed', 'queued', 'team_lead')).toBe(true);
      });

      it('blocks agent from re-queueing a blocked WorkItem', () => {
        expect(isTransitionPermitted('blocked', 'queued', 'agent')).toBe(false);
      });

      it('allows system actor for the dependency-resolution path (blocked → queued)', () => {
        expect(isTransitionPermitted('blocked', 'queued', 'system')).toBe(true);
      });

      // TRANS-2: running → queued is gated to the same set as the other
      // re-queue transitions. Agents cannot self-revive a claim they hold.
      it('blocks agent from re-queueing a running WorkItem (claim self-revival hazard)', () => {
        expect(isTransitionPermitted('running', 'queued', 'agent')).toBe(false);
      });

      it('allows team_lead to release a running WorkItem back to queued', () => {
        expect(isTransitionPermitted('running', 'queued', 'team_lead')).toBe(true);
      });

      it('allows orchestrator to release a running WorkItem back to queued', () => {
        expect(isTransitionPermitted('running', 'queued', 'orchestrator')).toBe(true);
      });

      it('allows system actor (Reconciler abandon path) to release running → queued', () => {
        expect(isTransitionPermitted('running', 'queued', 'system')).toBe(true);
      });
    });
  });

  // -----------------------------------------------------------------------
  // isWorkItem Type Guard
  // -----------------------------------------------------------------------
  describe('isWorkItem', () => {
    const validWorkItem: WorkItem = {
      id: 'wi-001',
      type: 'delegate',
      owner: 'agent',
      title: 'Test task',
      status: 'queued',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 3,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };

    it('should return true for a valid WorkItem', () => {
      expect(isWorkItem(validWorkItem)).toBe(true);
    });
    it('should return false for null', () => {
      expect(isWorkItem(null)).toBe(false);
    });
    it('should return false for non-object', () => {
      expect(isWorkItem(42)).toBe(false);
    });
    it('should return false for invalid type', () => {
      expect(isWorkItem({ ...validWorkItem, type: 'bogus' })).toBe(false);
    });
    it('should return false for invalid owner', () => {
      expect(isWorkItem({ ...validWorkItem, owner: 'nobody' })).toBe(false);
    });
    it('should return false for invalid status', () => {
      expect(isWorkItem({ ...validWorkItem, status: 'nope' })).toBe(false);
    });
    it('should return false for missing retryCount', () => {
      const { retryCount: _, ...incomplete } = validWorkItem;
      expect(isWorkItem(incomplete)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------
  describe('validateCreateWorkItemInput', () => {
    const validInput: CreateWorkItemInput = {
      type: 'delegate',
      owner: 'agent',
      title: 'Implement feature X',
      target: 'crewly-product-leo-member-n',
    };

    it('should return empty array for valid input', () => {
      expect(validateCreateWorkItemInput(validInput)).toEqual([]);
    });
    it('should error on invalid type', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, type: 'bogus' as 'delegate' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid owner', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, owner: 'nobody' as 'agent' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on empty title', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, title: '' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on invalid scheduledAt', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, scheduledAt: 'not-a-date' });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should error on negative maxRetries', () => {
      const errors = validateCreateWorkItemInput({ ...validInput, maxRetries: -1 });
      expect(errors.length).toBeGreaterThan(0);
    });
    it('should accept valid scheduledAt', () => {
      const errors = validateCreateWorkItemInput({
        ...validInput,
        scheduledAt: new Date().toISOString(),
      });
      expect(errors).toEqual([]);
    });

    // briefMarkdown — replaces .md task body in the V3 unification (PR #482).
    it('accepts briefMarkdown within the size cap', () => {
      const errors = validateCreateWorkItemInput({
        type: 'delegate',
        owner: 'agent',
        title: 'with brief',
        briefMarkdown: '# Step 1\nDo the thing.\n# Step 2\nReport back.',
      });
      expect(errors).toEqual([]);
    });

    it('rejects briefMarkdown that is not a string', () => {
      const errors = validateCreateWorkItemInput({
        type: 'delegate',
        owner: 'agent',
        title: 'bad type',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        briefMarkdown: 123 as any,
      });
      expect(errors.some((e) => e.includes('briefMarkdown'))).toBe(true);
    });

    it('rejects briefMarkdown exceeding the byte cap', () => {
      const oversize = 'a'.repeat(16 * 1024 + 1); // one byte over 16 KiB
      const errors = validateCreateWorkItemInput({
        type: 'delegate',
        owner: 'agent',
        title: 'too big',
        briefMarkdown: oversize,
      });
      expect(errors.some((e) => e.includes('briefMarkdown') && e.includes('exceeds'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Factory
  // -----------------------------------------------------------------------
  describe('createWorkItem', () => {
    const input: CreateWorkItemInput = {
      type: 'delegate',
      owner: 'agent',
      title: 'Implement TaskPoolService',
      target: 'crewly-product-leo-member-n',
      requestId: 'req-001',
    };

    it('should create a WorkItem with status queued', () => {
      const wi = createWorkItem(input);
      expect(wi.status).toBe('queued');
    });
    it('should set status to scheduled when scheduledAt is provided', () => {
      const wi = createWorkItem({
        ...input,
        scheduledAt: new Date(Date.now() + 60000).toISOString(),
      });
      expect(wi.status).toBe('scheduled');
    });
    it('should generate a UUID id', () => {
      const wi = createWorkItem(input);
      expect(wi.id).toMatch(/^[0-9a-f]{8}-/);
    });
    it('should honor a supplied deterministic id (idempotent occurrences)', () => {
      const wi = createWorkItem({ ...input, id: 'cron-task-7-2026-06-02T08:00:00.000Z' });
      expect(wi.id).toBe('cron-task-7-2026-06-02T08:00:00.000Z');
      const again = createWorkItem({ ...input, id: 'cron-task-7-2026-06-02T08:00:00.000Z' });
      expect(again.id).toBe(wi.id);
    });
    it('should default maxRetries to DEFAULT_MAX_RETRIES', () => {
      const wi = createWorkItem(input);
      expect(wi.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    });
    it('should respect custom maxRetries', () => {
      const wi = createWorkItem({ ...input, maxRetries: 5 });
      expect(wi.maxRetries).toBe(5);
    });
    it('should initialize retryCount to 0', () => {
      const wi = createWorkItem(input);
      expect(wi.retryCount).toBe(0);
    });
    it('should initialize token counts to 0', () => {
      const wi = createWorkItem(input);
      expect(wi.inputTokens).toBe(0);
      expect(wi.outputTokens).toBe(0);
      expect(wi.cost).toBe(0);
    });
    it('should set requestId from input', () => {
      const wi = createWorkItem(input);
      expect(wi.requestId).toBe('req-001');
    });
    it('should set target from input', () => {
      const wi = createWorkItem(input);
      expect(wi.target).toBe('crewly-product-leo-member-n');
    });

    it('should start in blocked status when dependsOn is non-empty', () => {
      const wi = createWorkItem({ ...input, dependsOn: ['wi-upstream-1'] });
      expect(wi.status).toBe('blocked');
      expect(wi.dependsOn).toEqual(['wi-upstream-1']);
    });

    it('should prefer blocked over scheduled when both are specified', () => {
      const wi = createWorkItem({
        ...input,
        dependsOn: ['wi-upstream-1'],
        scheduledAt: new Date(Date.now() + 60000).toISOString(),
      });
      expect(wi.status).toBe('blocked');
    });

    it('should ignore an empty dependsOn array', () => {
      const wi = createWorkItem({ ...input, dependsOn: [] });
      expect(wi.status).toBe('queued');
      expect(wi.dependsOn).toBeUndefined();
    });
  });

  describe('getTtlAnchorAt', () => {
    const base = { createdAt: '2026-01-01T00:00:00.000Z' };

    it('falls back to createdAt when the item has never been requeued', () => {
      expect(getTtlAnchorAt(base)).toBe(base.createdAt);
      expect(getTtlAnchorAt({ ...base, metadata: {} })).toBe(base.createdAt);
      expect(getTtlAnchorAt({ ...base, metadata: { other: 'x' } })).toBe(base.createdAt);
    });

    it('returns the requeue timestamp once one has been recorded', () => {
      const requeuedAt = '2026-01-05T12:00:00.000Z';
      expect(
        getTtlAnchorAt({
          ...base,
          metadata: { [LAST_REQUEUED_AT_METADATA_KEY]: requeuedAt },
        }),
      ).toBe(requeuedAt);
    });

    it('never mutates or reinterprets createdAt itself', () => {
      const wi = {
        ...base,
        metadata: { [LAST_REQUEUED_AT_METADATA_KEY]: '2026-01-05T12:00:00.000Z' },
      };
      getTtlAnchorAt(wi);
      expect(wi.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('ignores a non-string metadata value rather than trusting it', () => {
      // `metadata` is Record<string, unknown> and round-trips through storage,
      // so a wrong-typed value is reachable without a type error at the writer.
      for (const bad of [42, null, undefined, {}, ['2026-01-05T12:00:00.000Z']]) {
        expect(
          getTtlAnchorAt({ ...base, metadata: { [LAST_REQUEUED_AT_METADATA_KEY]: bad } }),
        ).toBe(base.createdAt);
      }
    });

    it('ignores an unparseable date rather than producing a NaN age', () => {
      // A NaN age would make `age > ttlMs` false forever, silently disabling
      // TTL for this item — a quiet failure, which is the mode we are trying
      // to get rid of. Fall back to a timestamp that definitely parses.
      expect(
        getTtlAnchorAt({ ...base, metadata: { [LAST_REQUEUED_AT_METADATA_KEY]: 'not-a-date' } }),
      ).toBe(base.createdAt);
      expect(
        Number.isNaN(
          new Date(
            getTtlAnchorAt({
              ...base,
              metadata: { [LAST_REQUEUED_AT_METADATA_KEY]: 'not-a-date' },
            }),
          ).getTime(),
        ),
      ).toBe(false);
    });
  });
});
