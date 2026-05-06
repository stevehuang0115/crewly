/**
 * Unit tests for the cleanup-stale-pool library.
 *
 * Exercises {@link classifyPoolForCleanup} with hand-rolled fixtures
 * so the stale rule, KEEP_LIST derivation (direct id, parent-WI,
 * parent-Request membership), and the today-vs-pre-cutoff bucketing
 * are all pinned.
 *
 * @module scripts/cleanup-stale-pool.lib.test
 */

import {
  classifyPoolForCleanup,
  type MinimalWorkItem,
} from './cleanup-stale-pool.lib.js';

const CUTOFF = '2026-05-06T00:00:00Z';
const PRE_CUTOFF = '2026-05-04T12:00:00Z';
const POST_CUTOFF = '2026-05-06T08:00:00Z';

function makeWi(overrides: Partial<MinimalWorkItem>): MinimalWorkItem {
  return {
    id: 'wi-' + Math.random().toString(36).slice(2, 8),
    status: 'queued',
    createdAt: PRE_CUTOFF,
    ...overrides,
  };
}

describe('classifyPoolForCleanup', () => {
  it('flags pre-cutoff items as stale when not in keep-list', () => {
    const items = [
      makeWi({ id: 'old-1', createdAt: PRE_CUTOFF }),
      makeWi({ id: 'old-2', createdAt: PRE_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, { cutoff: CUTOFF });
    expect(out.stale.map((w) => w.id).sort()).toEqual(['old-1', 'old-2']);
    expect(out.keptByAllowlist).toHaveLength(0);
    expect(out.keptToday).toHaveLength(0);
  });

  it('keeps post-cutoff items in keptToday (today\'s work)', () => {
    const items = [
      makeWi({ id: 'today-1', createdAt: POST_CUTOFF }),
      makeWi({ id: 'old-1', createdAt: PRE_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, { cutoff: CUTOFF });
    expect(out.keptToday.map((w) => w.id)).toEqual(['today-1']);
    expect(out.stale.map((w) => w.id)).toEqual(['old-1']);
  });

  it('keeps a hard-allow-listed id even if pre-cutoff', () => {
    const items = [
      makeWi({ id: 'umbrella', createdAt: PRE_CUTOFF }),
      makeWi({ id: 'old-1', createdAt: PRE_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, {
      cutoff: CUTOFF,
      keepIds: ['umbrella'],
    });
    expect(out.keptByAllowlist.map((w) => w.id)).toEqual(['umbrella']);
    expect(out.stale.map((w) => w.id)).toEqual(['old-1']);
  });

  it('keeps a child WI whose parentWorkItemId is allow-listed', () => {
    const items = [
      makeWi({ id: 'parent', createdAt: PRE_CUTOFF }),
      makeWi({ id: 'child-1', parentWorkItemId: 'parent', createdAt: PRE_CUTOFF }),
      makeWi({ id: 'orphan', createdAt: PRE_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, {
      cutoff: CUTOFF,
      keepIds: ['parent'],
    });
    const keptIds = out.keptByAllowlist.map((w) => w.id).sort();
    expect(keptIds).toEqual(['child-1', 'parent']);
    expect(out.stale.map((w) => w.id)).toEqual(['orphan']);
  });

  it('keeps a WI whose parentRequestId matches an allow-listed Request', () => {
    const items = [
      makeWi({ id: 'wi-of-req', parentRequestId: 'req-keep', createdAt: PRE_CUTOFF }),
      makeWi({ id: 'wi-of-req-2', requestId: 'req-keep', createdAt: PRE_CUTOFF }),
      makeWi({ id: 'unrelated-old', createdAt: PRE_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, {
      cutoff: CUTOFF,
      keepParentRequestIds: ['req-keep'],
    });
    expect(out.keptByAllowlist.map((w) => w.id).sort()).toEqual(['wi-of-req', 'wi-of-req-2']);
    expect(out.stale.map((w) => w.id)).toEqual(['unrelated-old']);
  });

  it('handles every status uniformly (cancelled, done, queued all subject to age)', () => {
    const statuses = ['queued', 'cancelled', 'done', 'done_by_worker', 'failed', 'blocked', 'running'];
    const items = statuses.map((s, i) =>
      makeWi({ id: `wi-${i}`, status: s, createdAt: PRE_CUTOFF }),
    );
    const out = classifyPoolForCleanup(items, { cutoff: CUTOFF });
    expect(out.stale).toHaveLength(statuses.length);
  });

  it('treats invalid createdAt as not-stale (NaN guard, errs on the safe side)', () => {
    const items = [makeWi({ id: 'broken', createdAt: 'not-a-date' })];
    const out = classifyPoolForCleanup(items, { cutoff: CUTOFF });
    expect(out.stale).toHaveLength(0);
    // Falls into the keptToday bucket because !isOld.
    expect(out.keptToday.map((w) => w.id)).toEqual(['broken']);
  });

  it('returns empty buckets for an empty pool', () => {
    const out = classifyPoolForCleanup([], { cutoff: CUTOFF });
    expect(out.stale).toHaveLength(0);
    expect(out.keptByAllowlist).toHaveLength(0);
    expect(out.keptToday).toHaveLength(0);
  });

  it('does not double-count a WI present in both seed sets (allowlist takes precedence)', () => {
    const items = [
      makeWi({ id: 'both', parentRequestId: 'req-keep', createdAt: PRE_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, {
      cutoff: CUTOFF,
      keepIds: ['both'],
      keepParentRequestIds: ['req-keep'],
    });
    expect(out.keptByAllowlist).toHaveLength(1);
    expect(out.keptToday).toHaveLength(0);
    expect(out.stale).toHaveLength(0);
  });

  it('preserves the brief\'s composite scenario (3 zombies + parked umbrella + today\'s WI)', () => {
    const items = [
      // 3 zombies aged 41h+ (createdAt ~2026-05-04)
      makeWi({ id: 'zombie-1', target: 'flopost-dex', createdAt: '2026-05-04T08:00:00Z' }),
      makeWi({ id: 'zombie-2', target: 'ce-vera', createdAt: '2026-05-04T09:00:00Z' }),
      makeWi({ id: 'zombie-3', target: 'stevesprompt-dev1', createdAt: '2026-05-04T10:00:00Z' }),
      // Parked umbrella (pre-cutoff but explicitly kept)
      makeWi({ id: 'umbrella-1', createdAt: PRE_CUTOFF }),
      // Today's WI (post-cutoff)
      makeWi({ id: 'today-1', createdAt: POST_CUTOFF }),
    ];
    const out = classifyPoolForCleanup(items, {
      cutoff: CUTOFF,
      keepIds: ['umbrella-1'],
    });
    expect(out.stale.map((w) => w.id).sort()).toEqual(['zombie-1', 'zombie-2', 'zombie-3']);
    expect(out.keptByAllowlist.map((w) => w.id)).toEqual(['umbrella-1']);
    expect(out.keptToday.map((w) => w.id)).toEqual(['today-1']);
  });
});
