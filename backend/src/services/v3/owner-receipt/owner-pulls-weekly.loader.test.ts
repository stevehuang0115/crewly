/**
 * Tests for the weekly owner-pulls loader (#1387).
 */

import type { OwnerDecision } from '../../../types/decision.types.js';
import type { Request } from '../../../types/v2/request.types.js';
import { createPullsWeeklyLoader } from './owner-pulls-weekly.loader.js';

const NOW = new Date('2026-09-27T12:00:00Z');
const ago = (days: number): string => new Date(NOW.getTime() - days * 86400000).toISOString();

const decision = (over: Partial<OwnerDecision>): OwnerDecision =>
  ({ id: 'D-1', question: 'q', options: [], defaultKey: 'a', deadline: ago(0), requestedBy: 'atlas', asker: 'atlas', status: 'resolved', createdAt: ago(1), updatedAt: ago(1), ...over }) as OwnerDecision;

describe('createPullsWeeklyLoader', () => {
  it('combines cards and open items (a carded question once), resolves teams, adds trace touches', async () => {
    const requests = [
      {
        id: 'r1',
        openItems: [
          { id: 'q1', type: 'question', text: 't', agent: 'vera', sourceMessageId: 'm', createdAt: ago(2), status: 'open' },
          { id: 'q2', type: 'question', text: 't', agent: 'vera', sourceMessageId: 'm', createdAt: ago(2), status: 'resolved' },
        ],
      },
    ] as unknown as Request[];
    const load = createPullsWeeklyLoader({
      listDecisions: async () => [decision({ id: 'D-1', teamId: 't1' }), decision({ id: 'D-2', requestRef: { requestId: 'r1', itemId: 'q2' }, kind: 'reply_question' })],
      listRequests: async () => requests,
      loadTeamIndex: async () => new Map([['atlas', 'Think Tank'], ['vera', 'CE']]),
      loadTeamNameById: async () => new Map([['t1', 'SteamFun']]),
      listTraceTouches: async () => [{ createdAt: ago(1), ownerTouches: 3 }],
    });
    const w = await load(NOW);
    // D-1 (SteamFun) + D-2 (carded, Think Tank) + q1 (open, CE); q2 is D-2's item.
    expect(w.thisWeek.total).toBe(3);
    expect(Object.fromEntries(w.thisWeek.byTeam.map((t) => [t.team, t.count]))).toEqual({ SteamFun: 1, 'Think Tank': 1, CE: 1 });
    expect(w.ownerTouches).toEqual({ thisWeek: 3, lastWeek: 0 });
  });

  it('adds agent-started DM posts, and keeps the pulls when the post log fails', async () => {
    const base = { listDecisions: async () => [decision({})], listRequests: async () => [], loadTeamIndex: async () => new Map([['ella', 'CE']]) };
    const load = createPullsWeeklyLoader({ ...base, listAgentPosts: async () => [{ at: ago(3), agent: 'ella', endsWithQuestion: false }] });
    const w = await load(NOW);
    expect(w.thisWeek.total).toBe(2);
    expect(w.thisWeek.byKind.fyi).toBe(1);
    const broken = createPullsWeeklyLoader({
      ...base,
      listAgentPosts: async () => {
        throw new Error('boom');
      },
    });
    expect((await broken(NOW)).thisWeek.total).toBe(1);
  });

  it('keeps the pulls when the trace read fails', async () => {
    const load = createPullsWeeklyLoader({
      listDecisions: async () => [decision({})],
      listRequests: async () => [],
      loadTeamIndex: async () => new Map(),
      listTraceTouches: async () => {
        throw new Error('boom');
      },
    });
    const w = await load(NOW);
    expect(w.thisWeek.total).toBe(1);
    expect(w.ownerTouches).toBeUndefined();
  });

  it('names the agents behind the pulls, and estimates the owner active minutes from message times only', async () => {
    const at = (days: number, min = 0): number => NOW.getTime() - days * 86400000 + min * 60000;
    const load = createPullsWeeklyLoader({
      listDecisions: async () => [decision({ asker: 'atlas', requestedBy: 'atlas' })],
      listRequests: async () => [],
      loadTeamIndex: async () => new Map([['atlas', 'CE']]),
      loadAgentNameIndex: async () => new Map([['atlas', 'Atlas']]),
      listAgentPosts: async () => [{ at: ago(3), agent: 'crewly-orc', endsWithQuestion: false }],
      // Two messages in one 5-minute bucket count once; one last week.
      listOwnerMessageTimes: async () => [at(1), at(1) + 60000, at(2), at(9)],
    });
    const w = await load(NOW);
    expect(w.thisWeek.bySource.map((x) => [x.agent, x.team, x.count])).toEqual([
      ['Atlas', 'CE', 1],
      ['Orchestrator', 'Unassigned', 1],
    ]);
    expect(w.ownerActiveMinutes).toEqual({ thisWeek: 10, lastWeek: 5 });
  });

  it('keeps the pulls when the owner message read fails', async () => {
    const load = createPullsWeeklyLoader({
      listDecisions: async () => [decision({})],
      listRequests: async () => [],
      loadTeamIndex: async () => new Map(),
      listOwnerMessageTimes: async () => {
        throw new Error('boom');
      },
    });
    const w = await load(NOW);
    expect(w.thisWeek.total).toBe(1);
    expect(w.ownerActiveMinutes).toBeUndefined();
  });
});
