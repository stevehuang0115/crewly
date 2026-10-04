/**
 * Tests for the digest block wiring (crewly#1083).
 */

import type { Team, TeamMember } from '../../types/index.js';
import type { TokenUsageEvent } from '../monitoring/token-usage.service.js';
import { leadShareDigestFor } from './lead-share.wiring.js';

const NOW = new Date(2026, 9, 4, 20, 0, 0);

describe('leadShareDigestFor', () => {
  const m = (over: Partial<TeamMember>) => ({ id: 'x', name: 'X', sessionName: 'x', role: 'developer', agentStatus: 'active', workingStatus: 'idle', ...over }) as TeamMember;
  const teams = [
    { id: 't-mkt', name: 'Marketing', leaderIds: ['e'], members: [m({ id: 'e', name: 'Ella', sessionName: 'mk-ella', role: 'team-leader' }), m({ id: 'l', name: 'Luna', sessionName: 'mk-luna' })] },
  ] as Team[];
  const ev = (cachedInput: number): TokenUsageEvent => ({ timestamp: new Date(NOW.getTime() - 60_000).toISOString(), agentId: 'x', input: 0, output: 0, cachedInput, model: 'claude-opus-5-5' }) as TokenUsageEvent;

  it('combines shares, today\'s nudges and kept work per team', async () => {
    const nudgeCounts = jest.fn(() => ({ total: { count: 5, followed: 3 }, day: { count: 2, followed: 1 } }));
    const keptWorkSince = jest.fn(() => [{ at: NOW.toISOString(), session: 'mk-ella', teamId: 't-mkt', reason: 'needs the brand Canva login', work: 'Poster' }]);
    const text = await leadShareDigestFor(NOW, {
      teams: async () => teams,
      forEachEvent: (visit) => {
        visit('mk-ella', ev(1_740_000));
        visit('mk-luna', ev(330_000));
      },
      delegation: { nudgeCounts, keptWorkSince },
    });
    expect(nudgeCounts).toHaveBeenCalledWith(['mk-ella'], NOW.getTime());
    expect(keptWorkSince).toHaveBeenCalledWith(expect.any(Number), { teamId: 't-mkt', sessions: ['mk-ella'] });
    expect(text).toContain('*Marketing* (Ella): 84% of 2.1M today');
    expect(text).toContain('nudged to delegate 2×, delegated after 1');
    expect(text).toContain('"needs the brand Canva login"');
  });

  it('is null when no team has anything to report', async () => {
    const text = await leadShareDigestFor(NOW, {
      teams: async () => teams,
      forEachEvent: () => undefined,
      delegation: { nudgeCounts: () => ({ total: { count: 0, followed: 0 }, day: { count: 0, followed: 0 } }), keptWorkSince: () => [] },
    });
    expect(text).toBeNull();
  });
});
