/**
 * Team Utilities Tests
 *
 * @module utils/team.utils.test
 */

import { describe, it, expect } from 'vitest';
import { AVATAR_CHOICES, assignDefaultAvatars, getTeamLeadIds } from './team.utils';

describe('AVATAR_CHOICES', () => {
  it('should contain 6 avatar URLs', () => {
    expect(AVATAR_CHOICES).toHaveLength(6);
  });

  it('should contain picsum.photos URLs', () => {
    for (const url of AVATAR_CHOICES) {
      expect(url).toMatch(/^https:\/\/picsum\.photos\/seed\/\d+\/64$/);
    }
  });
});

describe('assignDefaultAvatars', () => {
  it('should assign avatars to members without one', () => {
    const members = [
      { name: 'Alice' },
      { name: 'Bob' },
    ];

    const result = assignDefaultAvatars(members);

    expect(result[0].avatar).toBe(AVATAR_CHOICES[0]);
    expect(result[1].avatar).toBe(AVATAR_CHOICES[1]);
  });

  it('should preserve existing avatars', () => {
    const members = [
      { name: 'Alice', avatar: 'custom.png' },
      { name: 'Bob' },
    ];

    const result = assignDefaultAvatars(members);

    expect(result[0].avatar).toBe('custom.png');
    expect(result[1].avatar).toBe(AVATAR_CHOICES[1]);
  });

  it('should cycle through choices when members exceed avatar count', () => {
    const members = Array.from({ length: 8 }, (_, i) => ({ name: `Member ${i}` }));

    const result = assignDefaultAvatars(members);

    expect(result[6].avatar).toBe(AVATAR_CHOICES[0]);
    expect(result[7].avatar).toBe(AVATAR_CHOICES[1]);
  });

  it('should return empty array for empty input', () => {
    expect(assignDefaultAvatars([])).toEqual([]);
  });

  it('should not mutate original array', () => {
    const members = [{ name: 'Alice' }];
    const result = assignDefaultAvatars(members);

    expect(result).not.toBe(members);
    expect(members[0]).not.toHaveProperty('avatar');
  });
});

describe('getTeamLeadIds', () => {
  const members = [
    { id: 'owen', role: 'tech-lead' },
    { id: 'vera', role: 'developer' },
    { id: 'nova', role: 'content-strategist' },
  ];

  it('uses explicit leaderIds first', () => {
    expect(getTeamLeadIds({ members, leaderIds: ['vera'] })).toEqual(['vera']);
  });

  it('falls back to the deprecated leaderId', () => {
    expect(getTeamLeadIds({ members, leaderId: 'nova' })).toEqual(['nova']);
  });

  it('falls back to lead roles, tech-lead included', () => {
    expect(getTeamLeadIds({ members })).toEqual(['owen']);
    expect(getTeamLeadIds({ members: [{ id: 'a', role: 'team-leader' }] })).toEqual(['a']);
  });

  it('ignores ids of members no longer on the team', () => {
    expect(getTeamLeadIds({ members, leaderIds: ['gone'] })).toEqual(['owen']);
  });

  it('returns nothing for a team without a lead', () => {
    expect(getTeamLeadIds({ members: [{ id: 'x', role: 'developer' }] })).toEqual([]);
  });
});
