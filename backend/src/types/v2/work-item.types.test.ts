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
  checkTransitionPermission,
  normalizeTransitionActor,
  describeTransitionActor,
  getWorkItemReviewer,
  ForbiddenTransitionError,
  TRANSITION_ACTOR_ROLES,
  WORK_ITEM_REVIEWER_KEY,
  REVIEW_ESCALATED_TO_ORC_KEY,
  REVIEW_ESCALATED_TO_OWNER_KEY,
  isWorkItem,
  validateCreateWorkItemInput,
  createWorkItem,
  getTtlAnchorAt,
  LAST_REQUEUED_AT_METADATA_KEY,
  DISPOSITION_METADATA_KEY,
  isWorkItemDisposed,
  getWorkItemDisposition,
  WORK_ITEM_BLOCK_SOURCES,
  isExplicitlyBlocked,
} from './work-item.types.js';
import type { CreateWorkItemInput, WorkItem, TransitionActorInput } from './work-item.types.js';

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
    // #736 pin: `rejected` and `failed` are reachable stranding statuses with
    // NO terminal edge. Their lifecycle ends with a WorkItemDisposition stamp
    // (successor model, #740), not a status transition. If someone adds a
    // `→ cancelled` / `→ failed` edge here, the pruning rules regain an
    // illegal-correction surface (#733) and the disposition model becomes
    // ambiguous — change this test only together with that design.
    it('rejected and failed have queued as their only outbound edge (disposition, not transition, ends them)', () => {
      for (const stranding of ['rejected', 'failed'] as const) {
        const targets = WORK_ITEM_STATUSES.filter((to) => isValidWorkItemTransition(stranding, to));
        expect(targets).toEqual(['queued']);
        expect(TERMINAL_WORK_ITEM_STATUSES.has(stranding)).toBe(false);
      }
    });
    it('isWorkItemDisposed reads the successor stamp that ends a stranded item\'s lifecycle', () => {
      const undisposed: Pick<WorkItem, 'metadata'> = { metadata: {} };
      expect(isWorkItemDisposed(undisposed)).toBe(false);
      const succeeded: Pick<WorkItem, 'metadata'> = {
        metadata: {
          [DISPOSITION_METADATA_KEY]: {
            kind: 'succeeded_by',
            at: new Date().toISOString(),
            by: 'system',
            reason: 'retry cap 3 reached — escalated for review',
            successorWorkItemId: 'wi-1:review:max_retries',
          },
        },
      };
      expect(isWorkItemDisposed(succeeded)).toBe(true);
      expect(getWorkItemDisposition(succeeded)?.successorWorkItemId).toBe('wi-1:review:max_retries');
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
  // Transition Permissions — closed, item-aware gate (#813)
  // -----------------------------------------------------------------------
  describe('isTransitionPermitted / checkTransitionPermission', () => {
    /** Minimal WorkItem shape the gate reads. */
    const at = (
      status: WorkItem['status'],
      extra: { target?: string; metadata?: Record<string, unknown> } = {},
    ): Pick<WorkItem, 'status' | 'target' | 'metadata'> => ({ status, ...extra });

    const WORKER = 'dev-max';
    const LEAD = 'tl-sam';
    const OTHER_LEAD = 'tl-other';
    const awaitingReview = at('done_by_worker', { target: WORKER, metadata: { [WORK_ITEM_REVIEWER_KEY]: LEAD } });

    describe('closed table (deny by default)', () => {
      it('has a permission entry for every legal edge in WORK_ITEM_TRANSITIONS, and nothing else', () => {
        const legal: string[] = [];
        for (const from of WORK_ITEM_STATUSES) {
          for (const to of WORK_ITEM_TRANSITIONS[from]) legal.push(`${from}→${to}`);
        }
        // Report what was examined: an empty edge set would make this vacuous.
        expect(legal.length).toBe(26);
        const missing = legal.filter((k) => !TRANSITION_PERMISSIONS[k]);
        const extra = Object.keys(TRANSITION_PERMISSIONS).filter((k) => !legal.includes(k));
        expect({ examined: legal.length, missing, extra }).toEqual({ examined: 26, missing: [], extra: [] });
      });

      it('refuses an unlisted transition for every actor, system included', () => {
        const saved = TRANSITION_PERMISSIONS['queued→running'];
        delete TRANSITION_PERMISSIONS['queued→running'];
        try {
          for (const role of TRANSITION_ACTOR_ROLES) {
            const d = checkTransitionPermission(at('queued'), 'running', role);
            expect(d).toMatchObject({ allowed: false, reason: 'unlisted_transition' });
          }
        } finally {
          TRANSITION_PERMISSIONS['queued→running'] = saved;
        }
      });

      it('refuses a pair that is not an edge at all (e.g. verified → queued)', () => {
        expect(checkTransitionPermission(at('verified'), 'queued', 'system')).toMatchObject({
          allowed: false,
          reason: 'unlisted_transition',
        });
      });
    });

    describe('no default actor', () => {
      it.each([undefined, null, '', 'root'])('refuses a missing or unknown actor (%p)', (actor) => {
        expect(
          checkTransitionPermission(at('queued'), 'running', actor as unknown as TransitionActorInput),
        ).toMatchObject({ allowed: false, reason: 'missing_actor' });
      });

      it('refuses a missing actor on the verdict edge', () => {
        expect(isTransitionPermitted(awaitingReview, 'verified', undefined)).toBe(false);
      });
    });

    describe('system is listed, not a bypass', () => {
      it('may take the edges server code takes', () => {
        expect(isTransitionPermitted(at('queued'), 'running', 'system')).toBe(true);
        expect(isTransitionPermitted(at('running'), 'blocked', 'system')).toBe(true);
        expect(isTransitionPermitted(at('running'), 'failed', 'system')).toBe(true);
      });

      it('may never verify work', () => {
        expect(checkTransitionPermission(awaitingReview, 'verified', 'system')).toMatchObject({
          allowed: false,
          reason: 'role_not_permitted',
        });
      });

      it('may send work back (SLA escalation timeout)', () => {
        expect(isTransitionPermitted(awaitingReview, 'rejected', 'system')).toBe(true);
      });

      it('may not take agent-only edges (proposed → accepted)', () => {
        expect(isTransitionPermitted(at('proposed'), 'accepted', 'system')).toBe(false);
      });
    });

    describe('verdicts are identity-checked', () => {
      it('permits the recorded reviewer', () => {
        expect(isTransitionPermitted(awaitingReview, 'verified', { role: 'team_lead', session: LEAD })).toBe(true);
        expect(isTransitionPermitted(awaitingReview, 'rejected', { role: 'team_lead', session: LEAD })).toBe(true);
      });

      it('refuses a different team lead', () => {
        expect(
          checkTransitionPermission(awaitingReview, 'verified', { role: 'team_lead', session: OTHER_LEAD }),
        ).toMatchObject({ allowed: false, reason: 'not_reviewer' });
      });

      it('refuses the team_lead role with no session (a role claim is not an identity)', () => {
        expect(checkTransitionPermission(awaitingReview, 'verified', 'team_lead')).toMatchObject({
          allowed: false,
          reason: 'not_reviewer',
        });
      });

      it('refuses the worker, as agent and even when it claims team_lead', () => {
        expect(checkTransitionPermission(awaitingReview, 'verified', { role: 'agent', session: WORKER })).toMatchObject({
          allowed: false,
          reason: 'role_not_permitted',
        });
        expect(
          checkTransitionPermission(awaitingReview, 'verified', { role: 'team_lead', session: WORKER }),
        ).toMatchObject({ allowed: false, reason: 'self_review' });
      });

      it('refuses the worker even when it is somehow recorded as its own reviewer', () => {
        const selfReviewed = at('done_by_worker', { target: WORKER, metadata: { [WORK_ITEM_REVIEWER_KEY]: WORKER } });
        expect(checkTransitionPermission(selfReviewed, 'verified', { role: 'team_lead', session: WORKER })).toMatchObject({
          allowed: false,
          reason: 'self_review',
        });
      });

      it('refuses the orchestrator before escalation when a lead is the reviewer', () => {
        expect(
          checkTransitionPermission(awaitingReview, 'verified', { role: 'orchestrator', session: 'crewly-orc' }),
        ).toMatchObject({ allowed: false, reason: 'not_reviewer' });
      });

      it('permits the orchestrator once the review was escalated to it, or to the owner', () => {
        for (const key of [REVIEW_ESCALATED_TO_ORC_KEY, REVIEW_ESCALATED_TO_OWNER_KEY]) {
          const escalated = at('done_by_worker', {
            target: WORKER,
            metadata: { [WORK_ITEM_REVIEWER_KEY]: LEAD, [key]: '2026-09-26T00:00:00Z' },
          });
          expect(isTransitionPermitted(escalated, 'verified', { role: 'orchestrator', session: 'crewly-orc' })).toBe(true);
        }
      });

      it('permits the orchestrator when no reviewer is recorded', () => {
        expect(isTransitionPermitted(at('done_by_worker', { target: WORKER }), 'verified', 'orchestrator')).toBe(true);
      });

      it('permits the owner always', () => {
        expect(isTransitionPermitted(awaitingReview, 'verified', 'owner')).toBe(true);
      });

      it('explains the refusal', () => {
        const d = checkTransitionPermission(awaitingReview, 'verified', { role: 'team_lead', session: OTHER_LEAD });
        expect(d.allowed).toBe(false);
        if (!d.allowed) expect(d.detail).toContain(LEAD);
      });
    });

    describe('role gates carried over from TRANS-1', () => {
      it('only the agent accepts proposals', () => {
        expect(isTransitionPermitted(at('proposed'), 'accepted', 'agent')).toBe(true);
        expect(isTransitionPermitted(at('proposed'), 'accepted', 'orchestrator')).toBe(false);
      });
      it('only the agent reports done_by_worker and escalates', () => {
        expect(isTransitionPermitted(at('running'), 'done_by_worker', 'agent')).toBe(true);
        expect(isTransitionPermitted(at('running'), 'done_by_worker', 'system')).toBe(false);
        expect(isTransitionPermitted(at('running'), 'escalated', 'agent')).toBe(true);
      });
      it('keeps queued → running open to the roles that used it', () => {
        for (const role of ['agent', 'team_lead', 'orchestrator', 'system'] as const) {
          expect(isTransitionPermitted(at('queued'), 'running', role)).toBe(true);
        }
        expect(isTransitionPermitted(at('queued'), 'running', 'owner')).toBe(false);
      });
      it('only TL or orchestrator propose tasks', () => {
        expect(isTransitionPermitted(at('queued'), 'proposed', 'team_lead')).toBe(true);
        expect(isTransitionPermitted(at('queued'), 'proposed', 'orchestrator')).toBe(true);
        expect(isTransitionPermitted(at('queued'), 'proposed', 'agent')).toBe(false);
      });
      it('agents cannot re-queue rejected, failed, blocked or running items (self-revival)', () => {
        for (const from of ['rejected', 'failed', 'blocked', 'running'] as const) {
          expect(isTransitionPermitted(at(from), 'queued', 'agent')).toBe(false);
          expect(isTransitionPermitted(at(from), 'queued', 'team_lead')).toBe(true);
          expect(isTransitionPermitted(at(from), 'queued', 'orchestrator')).toBe(true);
          expect(isTransitionPermitted(at(from), 'queued', 'system')).toBe(true);
        }
      });
    });

    describe('actor helpers', () => {
      it('normalises a bare role and trims the session', () => {
        expect(normalizeTransitionActor('system')).toEqual({ role: 'system' });
        expect(normalizeTransitionActor({ role: 'agent', session: '  s1 ', via: 'x' })).toEqual({
          role: 'agent',
          session: 's1',
          via: 'x',
        });
        expect(normalizeTransitionActor({ role: 'agent', session: '   ' })).toEqual({ role: 'agent' });
      });
      it('describes actors for logs', () => {
        expect(describeTransitionActor(undefined)).toBe('(none)');
        expect(describeTransitionActor({ role: 'team_lead', session: 'sam', via: 'api' })).toBe('team_lead(sam)[api]');
      });
      it('reads the reviewer from metadata', () => {
        expect(getWorkItemReviewer({ metadata: { [WORK_ITEM_REVIEWER_KEY]: ' sam ' } })).toBe('sam');
        expect(getWorkItemReviewer({ metadata: {} })).toBeUndefined();
      });
      it('ForbiddenTransitionError carries the reason and names the actor', () => {
        const err = new ForbiddenTransitionError('wi-1', 'done_by_worker', 'verified', { role: 'system' }, {
          allowed: false,
          reason: 'role_not_permitted',
          detail: 'nope',
        });
        expect(err).toBeInstanceOf(Error);
        expect(err.reason).toBe('role_not_permitted');
        expect(err.message).toMatch(/^Forbidden transition for WorkItem wi-1: actor='system'/);
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

describe('isExplicitlyBlocked', () => {
  it('is true only for a blocked item whose block was explicit', () => {
    expect(isExplicitlyBlocked({ status: 'blocked', blockSource: WORK_ITEM_BLOCK_SOURCES.EXPLICIT })).toBe(true);
  });

  it('is false for a system block (no source) — the reconciler may recover it', () => {
    expect(isExplicitlyBlocked({ status: 'blocked' })).toBe(false);
  });

  it('is false once the item has left blocked, even with a stale source', () => {
    expect(isExplicitlyBlocked({ status: 'queued', blockSource: WORK_ITEM_BLOCK_SOURCES.EXPLICIT })).toBe(false);
  });
});
