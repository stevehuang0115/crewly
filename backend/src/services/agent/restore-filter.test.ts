import { RESTORE_MAX_ITEM_AGE_MS, sessionsToRestore, sessionsWithWorkInHand } from './restore-filter.js';

const NOW = Date.parse('2026-09-23T23:00:00Z');
const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
const old = new Date(NOW - RESTORE_MAX_ITEM_AGE_MS - 1000).toISOString();

describe('sessionsWithWorkInHand', () => {
  it('counts only statuses where the agent itself has something to do', () => {
    const got = sessionsWithWorkInHand(
      [
        { status: 'running', target: 'a', updatedAt: recent },
        { status: 'queued', target: 'b', updatedAt: recent },
        { status: 'rejected', target: 'c', updatedAt: recent },
        { status: 'verified', target: 'd', updatedAt: recent },
        { status: 'done_by_worker', target: 'e', updatedAt: recent },
        { status: 'blocked', target: 'f', updatedAt: recent },
        { status: 'failed', target: 'g', updatedAt: recent },
        { status: 'scheduled', target: 'h', updatedAt: recent },
      ],
      NOW,
    );
    expect([...got].sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores stale items and items without a target', () => {
    const got = sessionsWithWorkInHand(
      [
        { status: 'queued', target: 'stale', updatedAt: old },
        { status: 'running' },
        { status: 'accepted', target: 'fresh', createdAt: recent },
      ],
      NOW,
    );
    expect([...got]).toEqual(['fresh']);
  });

  it('keeps an item with no timestamps (cannot prove it is stale)', () => {
    expect([...sessionsWithWorkInHand([{ status: 'proposed', target: 'x' }], NOW)]).toEqual(['x']);
  });
});

describe('sessionsToRestore', () => {
  it('adds sessions with an interrupted turn even when they have no work item', () => {
    const got = sessionsToRestore([{ status: 'running', target: 'a', updatedAt: recent }], ['ella', 'a'], NOW);
    expect([...got].sort()).toEqual(['a', 'ella']);
  });

  it('ignores empty names and behaves like sessionsWithWorkInHand without interruptions', () => {
    const items = [
      { status: 'queued', target: 'b', updatedAt: recent },
      { status: 'verified', target: 'c', updatedAt: recent },
    ];
    expect([...sessionsToRestore(items, [''], NOW)]).toEqual(['b']);
    expect([...sessionsToRestore(items, [], NOW)]).toEqual([...sessionsWithWorkInHand(items, NOW)]);
  });
});
