/**
 * Tests for #841 give-up metrics.
 */

import { computeGiveUpStats } from './give-up-stats.js';
import type { Team } from '../../../types/index.js';
import type { WorkItem } from '../../../types/v2/work-item.types.js';

const teams = [
  { id: 't1', name: 'One', members: [{ sessionName: 'dev-1' }, { sessionName: 'tl-1' }] },
  { id: 't2', name: 'Two', members: [{ sessionName: 'dev-2' }] },
] as unknown as Team[];

/**
 * Minimal WorkItem.
 *
 * @param id - Id
 * @param status - Status
 * @param target - Target session
 * @param metadata - Metadata
 * @returns WorkItem
 */
function wi(id: string, status: string, target: string, metadata?: Record<string, unknown>): WorkItem {
  return { id, status, target, metadata, type: 'delegate', owner: 'agent', title: id } as unknown as WorkItem;
}
const meta = (root: string) => ({ giveUp: { rootWorkItemId: root, rootTitle: 'r', maxRetries: 2, attempts: [] } });

describe('computeGiveUpStats', () => {
  const items = [
    wi('a', 'cancelled', 'dev-1', { stop: { decision: 'retry', category: 'feasibility' } }),
    wi('a:giveup:1', 'verified', 'dev-1', { ...meta('a'), stop: undefined }),
    wi('b', 'failed', 'dev-1', { stop: { decision: 'retry', category: 'feasibility' } }),
    wi('b:giveup:1', 'failed', 'dev-1', { ...meta('b'), stop: { decision: 'retry', category: 'feasibility' } }),
    wi('b:giveup:2', 'running', 'dev-1', meta('b')),
    wi('c', 'blocked', 'dev-2', { stop: { decision: 'escalate', category: 'legal' } }),
    wi('d', 'blocked', 'dev-2', { stop: { decision: 'escalate', category: 'legal' } }),
    wi('e', 'failed', 'dev-2', { stop: { decision: 'retry', category: 'feasibility' } }),
    wi('e:review:gave_up', 'queued', 'tl-2', meta('e')),
    wi('x', 'done', 'nobody', { stop: { decision: 'escalate', category: 'money' } }),
    wi('plain', 'done', 'dev-1'),
  ];

  it('counts give-ups, retries (by outcome), the success rate and escalations per team', () => {
    const r = computeGiveUpStats(items, teams);
    expect(r.examined).toBe(items.length);
    const t1 = r.teams.find((t) => t.teamId === 't1')!;
    expect(t1).toMatchObject({ giveUps: 3, retries: 3, retriesSucceeded: 1, retriesFailed: 1, retriesPending: 1, retrySuccessRate: 0.5, escalations: 0 });
    const t2 = r.teams.find((t) => t.teamId === 't2')!;
    // the review targets the lead but counts on the worker's team
    expect(t2).toMatchObject({ giveUps: 1, retries: 0, retrySuccessRate: null, escalations: 1, escalatedByCategory: { legal: 2 } });
    expect(r.teams.find((t) => t.teamId === 'unassigned')).toMatchObject({ escalatedByCategory: { money: 1 } });
  });

  it('filters to one team, and reports what it examined even when nothing matched', () => {
    expect(computeGiveUpStats(items, teams, 't2').teams.map((t) => t.teamId)).toEqual(['t2']);
    expect(computeGiveUpStats([], teams)).toEqual({ examined: 0, teams: [] });
  });

  it('metadata.teamId wins over the target lookup', () => {
    const r = computeGiveUpStats([wi('z', 'failed', 'dev-1', { teamId: 't2', stop: { decision: 'retry', category: 'feasibility' } })], teams);
    expect(r.teams.map((t) => t.teamId)).toEqual(['t2']);
  });
});
