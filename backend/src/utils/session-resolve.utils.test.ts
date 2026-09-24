/**
 * Tests for session-resolve utils.
 */

import { memberSuffixOf, resolveCurrentSession } from './session-resolve.utils.js';
import type { Team } from '../types/index.js';

/**
 * Minimal team.
 *
 * @param id - Team id
 * @param members - [memberId, sessionName] pairs
 * @returns Team
 */
function team(id: string, members: Array<[string, string]>): Team {
  return { id, name: id, members: members.map(([mid, s]) => ({ id: mid, name: mid, sessionName: s })) } as unknown as Team;
}

const teams = [
  team('mkt', [['45506487-1b63-4f81-a9fd-77053d69e181', 'crewly-marketing-dana-45506487'], ['e6a6b8ea-9a3f', 'crewly-marketing-ella-e6a6b8ea']]),
  team('tt', [['b4e166f6-2b85', 'think-tank-atlas-b4e166f6']]),
];

describe('memberSuffixOf', () => {
  it('reads the trailing 8-hex member fragment', () => {
    expect(memberSuffixOf('crewly-marketing-self-watch-scribe-45506487')).toBe('45506487');
    expect(memberSuffixOf('crewly-orc')).toBeNull();
  });
});

describe('resolveCurrentSession', () => {
  it('exact names resolve as-is', () => {
    expect(resolveCurrentSession('think-tank-atlas-b4e166f6', teams)).toMatchObject({ sessionName: 'think-tank-atlas-b4e166f6', teamId: 'tt', renamed: false });
  });

  it('a renamed member is found by its member id (the 2026-09-24 metrics trigger)', () => {
    expect(resolveCurrentSession('crewly-marketing-self-watch-scribe-45506487', teams)).toEqual({
      sessionName: 'crewly-marketing-dana-45506487',
      teamId: 'mkt',
      memberId: '45506487-1b63-4f81-a9fd-77053d69e181',
      renamed: true,
    });
  });

  it('unknown or ambiguous names resolve to nothing', () => {
    expect(resolveCurrentSession('gone-agent-deadbeef', teams)).toBeNull();
    expect(resolveCurrentSession('crewly-orc', teams)).toBeNull();
    const twins = [team('a', [['abcd1234-1', 'x-abcd1234']]), team('b', [['abcd1234-2', 'y-abcd1234']])];
    expect(resolveCurrentSession('old-abcd1234', twins)).toBeNull();
    expect(resolveCurrentSession('', teams)).toBeNull();
  });
});
