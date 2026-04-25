/**
 * Tests for the lost-dispatch detector — POST-SEALED amendment for
 * Cases #5/#6/#7.
 *
 * @module services/team-health/lost-dispatch-detector.test
 */

import {
  detectLostDispatches,
  describeLostDispatchEvidence,
} from './lost-dispatch-detector.js';
import { DEFAULT_LOST_DISPATCH, type LostDispatchConfig, type AgentWorkingStatus } from './team-health-types.js';
import { createWorkItem } from '../../types/v2/index.js';
import type { WorkItem } from '../../types/v2/index.js';
import type { AgentHealth } from '../reconciler/reconcile-rules.js';

const NOW = new Date('2026-04-25T19:30:00.000Z');

function makeWi(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({ type: 'delegate', owner: 'agent', title: id, target: 'agent-1' }),
    id,
    ...overrides,
  };
}

function makeHealth(session: string, lastSeenAtMs: number): Map<string, AgentHealth & { workingStatus?: AgentWorkingStatus }> {
  return new Map([[session, {
    sessionName: session,
    status: 'active',
    lastSeenAt: new Date(lastSeenAtMs).toISOString(),
  }]]);
}

describe('detectLostDispatches', () => {
  it('returns empty when disabled', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 5 * 60 * 1000),
      NOW,
      { ...DEFAULT_LOST_DISPATCH, enabled: false },
    );
    expect(out.size).toBe(0);
  });

  it('flags a proposed WorkItem when target was alive after dispatch', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 5 * 60 * 1000),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.has('w1')).toBe(true);
  });

  it('flags an accepted WorkItem with same shape', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'accepted',
      createdAt: new Date(NOW.getTime() - 45 * 60 * 1000).toISOString(),
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 10 * 60 * 1000),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.has('w1')).toBe(true);
  });

  it('does NOT flag a too-fresh dispatch (< T1)', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(), // 5 min — below 10 min T1
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 1 * 60 * 1000),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.size).toBe(0);
  });

  it('does NOT flag if agent has not been seen since dispatch', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    // lastSeen BEFORE dispatch ⇒ agent might have been offline since.
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 60 * 60 * 1000),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.size).toBe(0);
  });

  it('does NOT flag when WorkItem already moved to running', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'accepted',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
      startedAt: new Date(NOW.getTime() - 25 * 60 * 1000).toISOString(),
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 5 * 60 * 1000),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.size).toBe(0);
  });

  it('does NOT flag if postRestartGraceMs not yet exceeded', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    // postRestartGraceMs default = 60s. Set lastSeen 30s after createdAt.
    const lastSeenMs = NOW.getTime() - 30 * 60 * 1000 + 30 * 1000;
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', lastSeenMs),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.size).toBe(0);
  });

  it('skips WorkItems with no target', () => {
    const wi = makeWi('w1', {
      target: undefined,
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const out = detectLostDispatches([wi], new Map(), NOW, DEFAULT_LOST_DISPATCH);
    expect(out.size).toBe(0);
  });

  it('skips terminal-status WorkItems implicitly via status filter', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'done',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime()),
      NOW,
      DEFAULT_LOST_DISPATCH,
    );
    expect(out.size).toBe(0);
  });

  it('respects custom T1Ms', () => {
    const cfg: LostDispatchConfig = { ...DEFAULT_LOST_DISPATCH, T1Ms: 60 * 60 * 1000 };
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(), // 30 min — below 60 min
    });
    const out = detectLostDispatches(
      [wi],
      makeHealth('a1', NOW.getTime() - 5 * 60 * 1000),
      NOW,
      cfg,
    );
    expect(out.size).toBe(0);
  });
});

describe('describeLostDispatchEvidence', () => {
  it('produces a multi-line evidence string', () => {
    const wi = makeWi('w1', {
      target: 'a1',
      status: 'proposed',
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const out = describeLostDispatchEvidence(
      wi,
      makeHealth('a1', NOW.getTime() - 5 * 60 * 1000),
    );
    expect(out).toContain('dispatched at');
    expect(out).toContain('alive at');
  });
});
