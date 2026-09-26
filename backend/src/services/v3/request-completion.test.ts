/**
 * Tests for request-completion — "has this Request actually been delivered?"
 *
 * The incident fixture mirrors Request d86b5faf (2026-09-26) as read back from
 * the live pool: auto-decomposed Plan/Execute/Review for the orchestrator, a
 * direct item for Ella, and the re-routed replacement 806dc528 that carried
 * the request id only in its title.
 */

import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';
import {
  collectRequestWorkItems,
  evaluateRequestCompletion,
  findSuccessorWorkItems,
  isBookkeepingWorkItem,
  isSupersededCancellation,
} from './request-completion.js';

const REQ = 'd86b5faf-4693-4941-aa9b-7216ffb90005';
const PLAN = '8249a788-1ea7-4687-ac1a-47d078a34afe';
const EXECUTE = '51f24f4c-e1ad-4cce-8359-e3e37526d147';
const REVIEW = '8e7466a2-f36c-4d8e-bfb9-60c880d6027e';
const ELLA = '673193ce-e5eb-45c1-b44d-9ade964fa352';
const REROUTED = '806dc528-acbf-4456-af51-5351fa48fada';
const DUP_REASON =
  'Duplicate/stale: Plan WI 8249a788 already re-routed this Request to Ella as WI 806dc528 with full G+O+E. This orchestrator-targeted item is redundant.';

/**
 * Builds a WorkItem with overrides.
 *
 * @param overrides - Fields to set
 * @returns WorkItem
 */
function wi(overrides: Partial<WorkItem>): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'orchestrator', title: 'Work', target: 'crewly-orc' }),
    ...overrides,
  };
}

/**
 * The incident pool at the moment the reconciler closed the Request
 * (03:49:08): Plan and Execute verified, Review and Ella's item cancelled as
 * duplicates, 806dc528 still running.
 *
 * @param reroutedStatus - Status of the re-routed replacement
 * @returns Pool snapshot
 */
function incidentPool(reroutedStatus: WorkItem['status'] = 'running'): WorkItem[] {
  const decomposed = { autoDecomposed: true, planStrategy: 'derived-from-RequestService.plan' };
  return [
    wi({ id: PLAN, requestId: REQ, title: 'Plan: Fake-door demand test', status: 'verified', metadata: decomposed }),
    wi({ id: EXECUTE, requestId: REQ, title: 'Execute: Fake-door demand test', status: 'verified', metadata: decomposed, dependsOn: [PLAN] }),
    wi({ id: REVIEW, requestId: REQ, title: 'Review: Fake-door demand test', status: 'cancelled', metadata: decomposed, cancelReason: DUP_REASON }),
    wi({ id: ELLA, requestId: REQ, title: 'Demand test: one-click deploy', status: 'cancelled', target: 'crewly-marketing-ella', cancelReason: DUP_REASON }),
    wi({
      id: REROUTED,
      title: `[Request ${REQ} | WorkItem ${PLAN}]\n\nGOAL: Create an execution plan`,
      status: reroutedStatus,
      target: 'crewly-marketing-ella',
    }),
    wi({ id: 'unrelated-1', title: 'Something else', status: 'running' }),
  ];
}

describe('isBookkeepingWorkItem', () => {
  it('reads the explicit decompositionPhase stamp', () => {
    expect(isBookkeepingWorkItem(wi({ metadata: { decompositionPhase: 'plan' } }))).toBe(true);
    expect(isBookkeepingWorkItem(wi({ metadata: { decompositionPhase: 'review' } }))).toBe(true);
    expect(isBookkeepingWorkItem(wi({ metadata: { decompositionPhase: 'execute' } }))).toBe(false);
  });

  it('falls back to Plan/Review title prefixes only for auto-decomposed items', () => {
    expect(isBookkeepingWorkItem(wi({ title: 'Plan: x', metadata: { autoDecomposed: true } }))).toBe(true);
    expect(isBookkeepingWorkItem(wi({ title: 'Review: x', metadata: { autoDecomposed: true } }))).toBe(true);
    expect(isBookkeepingWorkItem(wi({ title: 'Execute: x', metadata: { autoDecomposed: true } }))).toBe(false);
    // A hand-made "Review: PR #12" is the deliverable, not bookkeeping.
    expect(isBookkeepingWorkItem(wi({ title: 'Review: PR #12' }))).toBe(false);
  });

  it('treats SLA reply trackers as bookkeeping', () => {
    expect(isBookkeepingWorkItem(wi({ id: `request:${REQ}:respond_to_user` }))).toBe(true);
  });
});

describe('isSupersededCancellation', () => {
  it('recognises duplicate / re-routed cancel reasons', () => {
    expect(isSupersededCancellation(wi({ status: 'cancelled', cancelReason: DUP_REASON }))).toBe(true);
    expect(isSupersededCancellation(wi({ status: 'cancelled', cancelReason: 'Superseded by the new brief' }))).toBe(true);
  });

  it('recognises an explicit supersededBy stamp', () => {
    expect(isSupersededCancellation(wi({ status: 'cancelled', metadata: { supersededBy: ['x'] } }))).toBe(true);
  });

  it('is false for a plain cancel and for non-cancelled items', () => {
    expect(isSupersededCancellation(wi({ status: 'cancelled', cancelReason: 'owner changed their mind' }))).toBe(false);
    expect(isSupersededCancellation(wi({ status: 'verified', cancelReason: DUP_REASON }))).toBe(false);
  });
});

describe('findSuccessorWorkItems', () => {
  it('resolves an abbreviated id quoted in the cancel reason', () => {
    const pool = incidentPool();
    const review = pool.find((w) => w.id === REVIEW)!;
    const ids = findSuccessorWorkItems(review, pool).map((w) => w.id);
    expect(ids).toContain(REROUTED);
  });

  it('follows an explicit supersededBy and a succeeded_by disposition', () => {
    const next = wi({ id: 'next-1' });
    const other = wi({ id: 'next-2' });
    const byMeta = wi({ status: 'cancelled', metadata: { supersededBy: 'next-1' } });
    const byDisposition = wi({
      status: 'cancelled',
      metadata: {
        disposition: { kind: 'succeeded_by', at: 'now', by: 'system', reason: 'retry', successorWorkItemId: 'next-2' },
      },
    });
    expect(findSuccessorWorkItems(byMeta, [next, other, byMeta]).map((w) => w.id)).toEqual(['next-1']);
    expect(findSuccessorWorkItems(byDisposition, [next, other, byDisposition]).map((w) => w.id)).toEqual(['next-2']);
  });

  it('ignores ids in a reason that is not about superseding', () => {
    const pool = incidentPool();
    const plain = wi({ status: 'cancelled', cancelReason: `owner said no; see ${REROUTED.slice(0, 8)}` });
    expect(findSuccessorWorkItems(plain, [...pool, plain])).toEqual([]);
  });

  it('skips an ambiguous short id', () => {
    const a = wi({ id: 'abcdef12-0000-0000-0000-000000000001' });
    const b = wi({ id: 'abcdef12-0000-0000-0000-000000000002' });
    const cancelled = wi({ status: 'cancelled', cancelReason: 'duplicate of abcdef12' });
    expect(findSuccessorWorkItems(cancelled, [a, b, cancelled])).toEqual([]);
  });
});

describe('collectRequestWorkItems', () => {
  it('pulls in the re-routed item and nothing unrelated', () => {
    const ids = collectRequestWorkItems(REQ, incidentPool()).map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([PLAN, EXECUTE, REVIEW, ELLA, REROUTED]));
    expect(ids).not.toContain('unrelated-1');
  });

  it('follows successor chains transitively and survives cycles', () => {
    const a = wi({ id: 'aaaaaaaa-0000-0000-0000-000000000000', requestId: 'r1', status: 'cancelled', metadata: { supersededBy: 'b' } });
    const b = wi({ id: 'b', status: 'cancelled', metadata: { supersededBy: ['c', a.id] } });
    const c = wi({ id: 'c', status: 'running' });
    const ids = collectRequestWorkItems('r1', [a, b, c]).map((w) => w.id);
    expect(ids.sort()).toEqual([a.id, 'b', 'c'].sort());
  });

  it('does not adopt an item that belongs to another Request', () => {
    const other = wi({ requestId: 'another', title: `[Request ${REQ}] copy` });
    expect(collectRequestWorkItems(REQ, [other])).toEqual([]);
  });
});

describe('evaluateRequestCompletion', () => {
  it('incident: is NOT complete while the re-routed work is still running', () => {
    const result = evaluateRequestCompletion(collectRequestWorkItems(REQ, incidentPool('running')));
    expect(result.outcome).toBe('in_progress');
    expect(result.reason).toContain('806dc528=running');
  });

  it('incident, own items only (what the old code saw): Execute counts, but nothing hides behind the cancels', () => {
    // Without the successor the only deliverable is Execute; the cancelled
    // duplicates contribute nothing either way.
    const own = incidentPool().filter((w) => w.requestId === REQ);
    const result = evaluateRequestCompletion(own);
    expect(result.deliveredItems.map((w) => w.id)).toEqual([EXECUTE]);
  });

  it('incident: completes once the re-routed work is verified', () => {
    const result = evaluateRequestCompletion(collectRequestWorkItems(REQ, incidentPool('verified')));
    expect(result.outcome).toBe('complete');
    expect(result.deliveredItems.map((w) => w.id)).toEqual(expect.arrayContaining([EXECUTE, REROUTED]));
  });

  it('bookkeeping only: verified Plan + verified Review with Execute cancelled is not done', () => {
    const items = [
      wi({ title: 'Plan: x', status: 'verified', metadata: { autoDecomposed: true } }),
      wi({ title: 'Execute: x', status: 'cancelled', metadata: { autoDecomposed: true }, cancelReason: 'not needed' }),
      wi({ title: 'Review: x', status: 'verified', metadata: { decompositionPhase: 'review' } }),
    ];
    const result = evaluateRequestCompletion(items);
    expect(result.outcome).toBe('bookkeeping_only');
    expect(result.deliveredItems).toEqual([]);
  });

  it('cancelled duplicates never count as done work', () => {
    const items = [
      wi({ title: 'Plan: x', status: 'verified', metadata: { autoDecomposed: true } }),
      wi({ status: 'cancelled', cancelReason: 'Duplicate of the other item' }),
    ];
    expect(evaluateRequestCompletion(items).outcome).toBe('bookkeeping_only');
  });

  it('all cancelled → nothing_live', () => {
    const items = [wi({ status: 'cancelled' }), wi({ status: 'cancelled' })];
    expect(evaluateRequestCompletion(items).outcome).toBe('nothing_live');
  });

  it('done_by_worker is not delivered', () => {
    expect(evaluateRequestCompletion([wi({ status: 'done_by_worker' })]).outcome).toBe('in_progress');
  });

  it('a plain single deliverable that is done completes', () => {
    expect(evaluateRequestCompletion([wi({ status: 'done' })]).outcome).toBe('complete');
  });

  describe('reply-only Requests (SLA tracker is the whole deliverable)', () => {
    const trackerId = `request:${REQ}:respond_to_user`;

    it('a tracker the orc resolved by replying counts as delivered', () => {
      const tracker = wi({ id: trackerId, status: 'cancelled', metadata: { slaResolvedReason: 'orc_reply' } });
      expect(evaluateRequestCompletion([tracker]).outcome).toBe('complete');
    });

    it('a tracker retired because the Request was decomposed is not a reply', () => {
      const tracker = wi({ id: trackerId, status: 'cancelled', metadata: { slaResolvedReason: 'workitem_decompose' } });
      expect(evaluateRequestCompletion([tracker]).outcome).toBe('nothing_live');
    });

    it('a queued tracker is still pending', () => {
      expect(evaluateRequestCompletion([wi({ id: trackerId, status: 'queued' })]).outcome).toBe('in_progress');
    });

    it('with other work present, a replied tracker alone does not complete the Request', () => {
      const tracker = wi({ id: trackerId, status: 'cancelled', metadata: { slaResolvedReason: 'orc_reply' } });
      const plan = wi({ title: 'Plan: x', status: 'verified', metadata: { decompositionPhase: 'plan' } });
      expect(evaluateRequestCompletion([tracker, plan]).outcome).toBe('bookkeeping_only');
    });
  });
});
