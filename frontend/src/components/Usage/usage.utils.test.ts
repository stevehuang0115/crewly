/**
 * Tests for the Usage page helpers.
 *
 * @module components/Usage/usage.utils.test
 */

import { describe, it, expect } from 'vitest';
import { agentCapLabel, barWidth, boostLabel, boostTargetName, runtimeLabel, shareLabel, teamCapLabel, workItemLink } from './usage.utils';

const M = 1_000_000;

describe('usage.utils', () => {
  it('teamCapLabel describes caps and boosts', () => {
    expect(teamCapLabel({ baseCapTokens: 50 * M, capTokens: 70 * M, extraTokens: 20 * M, unlimited: false })).toBe('70M cap (+20M today)');
    expect(teamCapLabel({ baseCapTokens: 50 * M, capTokens: 50 * M, extraTokens: 0, unlimited: false })).toBe('50M cap');
    expect(teamCapLabel({ baseCapTokens: null, capTokens: null, extraTokens: 0, unlimited: true })).toBe('Unlimited today');
    expect(teamCapLabel({ baseCapTokens: null, capTokens: null, extraTokens: 0, unlimited: false })).toBe('No cap');
    expect(teamCapLabel({ baseCapTokens: null, capTokens: null, extraTokens: 10 * M, unlimited: false })).toBe('No cap (+10M boost)');
  });

  it('agentCapLabel names where the cap comes from', () => {
    expect(agentCapLabel({ capTokens: 8 * M, capSource: 'default', unlimited: false, boosted: false })).toBe('8M cap (default)');
    expect(agentCapLabel({ capTokens: 5 * M, capSource: 'override', unlimited: false, boosted: true })).toBe('5M cap · boosted');
    expect(agentCapLabel({ capTokens: null, capSource: 'exempt', unlimited: false, boosted: false })).toBe('Not capped');
    expect(agentCapLabel({ capTokens: null, capSource: 'none', unlimited: true, boosted: true })).toBe('Unlimited today');
  });

  it('boost labels and targets', () => {
    expect(boostLabel({ unlimited: true })).toBe('Unlimited until midnight');
    expect(boostLabel({ extraTokens: 20 * M })).toBe('+20M until midnight');
    const teams = [{ teamId: 't1', name: 'CE' }];
    const agents = [{ session: 'ce-nova', name: 'Nova' }];
    expect(boostTargetName('*', teams, agents)).toBe('Everyone');
    expect(boostTargetName('team:t1', teams, agents)).toBe('CE');
    expect(boostTargetName('ce-nova', teams, agents)).toBe('Nova');
    expect(boostTargetName('gone', teams, agents)).toBe('gone');
  });

  it('points old work-item links at Tickets › Runs', () => {
    expect(workItemLink({ key: 'a', link: '/workitems/wi-1' })).toBe('/tickets/runs/wi-1');
    expect(workItemLink({ key: 'a', link: '/somewhere' })).toBe('/somewhere');
    expect(workItemLink({ key: 'a' })).toBeUndefined();
  });

  it('bars, shares and runtime labels', () => {
    expect(barWidth(5, 10)).toBe('50%');
    expect(barWidth(0, 10)).toBe('0%');
    expect(barWidth(1, 1000)).toBe('1%');
    expect(shareLabel(0.004)).toBe('<1%');
    expect(shareLabel(0.56)).toBe('56%');
    expect(runtimeLabel('codex-cli')).toBe('Codex');
    expect(runtimeLabel('mystery')).toBe('mystery');
  });
});
