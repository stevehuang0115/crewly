/**
 * Tests for the undelivered-delegation notice.
 *
 * @module services/reconciler/undelivered-delegation-notice.test
 */

import { DIRECT_DELIVERY_CONSTANTS, RECONCILER_WAKE_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import {
  buildUndeliveredDelegationNotice,
  findUndeliveredDelegations,
  surfaceUndeliveredDelegation,
} from './undelivered-delegation-notice.js';

const NOW = Date.parse('2026-11-14T20:20:00.000Z');
const LEAD = 'steamfun-fern-4309bcb5';
const MEMBER = 'steamfun-fern-2-member-1';
const AFTER = RECONCILER_WAKE_CONSTANTS.UNDELIVERED_DELEGATION_NOTICE_AFTER_MS;

/** A delegated WorkItem created `ageMs` ago. */
function delegation(ageMs: number, overrides: Partial<WorkItem> = {}, metadata: Record<string, unknown> = {}): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'team_lead', title: 'Add a Google Drive option to the upload screen', target: MEMBER }),
    id: 'wi-1',
    createdAt: new Date(NOW - ageMs).toISOString(),
    metadata: { directDelivery: true, delegatedBy: LEAD, ...metadata },
    ...overrides,
  };
}

describe('findUndeliveredDelegations', () => {
  it('reports a delegation still queued past the threshold whose brief never reached the target', () => {
    const found = findUndeliveredDelegations([delegation(AFTER + 1_000)], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ delegator: LEAD, target: MEMBER });
    expect(found[0].waitedMs).toBe(AFTER + 1_000);
  });

  it('says nothing before the threshold', () => {
    expect(findUndeliveredDelegations([delegation(AFTER - 1_000)], NOW)).toEqual([]);
  });

  it('says nothing once the brief reached the running session', () => {
    const wi = delegation(AFTER * 3, {}, { [DIRECT_DELIVERY_CONSTANTS.DELIVERED_AT_KEY]: new Date(NOW - 1000).toISOString() });
    expect(findUndeliveredDelegations([wi], NOW)).toEqual([]);
  });

  it('says it once: an item already reported is skipped', () => {
    const wi = delegation(AFTER * 3, {}, { [RECONCILER_WAKE_CONSTANTS.UNDELIVERED_DELEGATION_NOTICED_AT_KEY]: new Date(NOW).toISOString() });
    expect(findUndeliveredDelegations([wi], NOW)).toEqual([]);
  });

  it('ignores work that is not queued, has no target, no delegator, or delegates to itself', () => {
    const items = [
      delegation(AFTER * 2, { id: 'running', status: 'running' }),
      delegation(AFTER * 2, { id: 'untargeted', target: undefined }),
      delegation(AFTER * 2, { id: 'no-delegator' }, { delegatedBy: undefined }),
      delegation(AFTER * 2, { id: 'self' }, { delegatedBy: MEMBER }),
    ];
    expect(findUndeliveredDelegations(items, NOW)).toEqual([]);
  });

  it('leaves very old items to the stalled-work rules', () => {
    const old = delegation(RECONCILER_WAKE_CONSTANTS.UNDELIVERED_DELEGATION_NOTICE_MAX_AGE_MS + 60_000);
    expect(findUndeliveredDelegations([old], NOW)).toEqual([]);
  });
});

describe('buildUndeliveredDelegationNotice', () => {
  it('goes to the delegator and names the item and the target', () => {
    const [d] = findUndeliveredDelegations([delegation(7 * 60_000)], NOW);
    const review = buildUndeliveredDelegationNotice(d, 'not running', { id: 'team-sf' } as Team, new Date(NOW));
    expect(review.id).toBe('wi-1:review:undelivered_delegation');
    expect(review.type).toBe('review');
    expect(review.target).toBe(LEAD);
    expect(review.title).toContain(MEMBER);
    expect(review.description).toContain('wi-1');
    expect(review.description).toContain(MEMBER);
    expect(review.description).toContain('has not been delivered');
    expect(review.description).toContain('is not running');
    expect(review.description).toContain('7 min');
    expect(review.metadata).toMatchObject({ reviewReason: 'undelivered_delegation', sourceWorkItemId: 'wi-1', teamId: 'team-sf' });
    // The notice itself is not a delegation: it can never be reported in turn.
    expect(findUndeliveredDelegations([{ ...review, createdAt: new Date(NOW - AFTER * 2).toISOString() }], NOW)).toEqual([]);
  });
});

describe('surfaceUndeliveredDelegation', () => {
  it('queues the review and stamps the delegated item so it is said once', async () => {
    const added: WorkItem[] = [];
    const stamps: Array<[string, Record<string, unknown>]> = [];
    const [d] = findUndeliveredDelegations([delegation(6 * 60_000)], NOW);
    const review = await surfaceUndeliveredDelegation(d, undefined, {
      loadTeams: async () => [{ id: 'team-sf', members: [{ sessionName: MEMBER }] } as unknown as Team],
      addToPool: async (wi) => void added.push(wi),
      stamp: async (id, patch) => void stamps.push([id, patch]),
      now: () => new Date(NOW),
    });
    expect(added).toEqual([review]);
    expect(review.metadata?.teamId).toBe('team-sf');
    expect(stamps).toEqual([['wi-1', { [RECONCILER_WAKE_CONSTANTS.UNDELIVERED_DELEGATION_NOTICED_AT_KEY]: new Date(NOW).toISOString() }]]);
  });
});
