/**
 * Tests for the usage API client.
 *
 * @module services/usage.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { boostAmount, compactTokens, parseTokenInput, tokens, usageService, USAGE_API } from './usage.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});

const ax = vi.mocked(axios);

describe('usageService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs stats with days and groupBy, and the caps view', async () => {
    ax.get.mockResolvedValue({ data: { success: true, data: { days: 7 } } });
    expect(await usageService.stats(7, ['team', 'agent'])).toEqual({ days: 7 });
    expect(ax.get).toHaveBeenCalledWith(USAGE_API.STATS, { params: { days: 7, groupBy: 'team,agent' } });
    await usageService.caps(1);
    expect(ax.get).toHaveBeenLastCalledWith(USAGE_API.CAPS, { params: { days: 1 } });
  });

  it('PUTs caps, POSTs a boost, DELETEs a boost', async () => {
    ax.put.mockResolvedValue({ data: { success: true, data: { defaultAgentCapTokens: 5_000_000 } } });
    ax.post.mockResolvedValue({ data: { success: true, data: { id: 'b1' } } });
    ax.delete.mockResolvedValue({ data: { success: true, data: { id: 'b1' } } });
    await usageService.setCaps({ teams: { t: 50_000_000 } });
    expect(ax.put).toHaveBeenCalledWith(USAGE_API.CAPS, { teams: { t: 50_000_000 } });
    await usageService.boost({ scope: 'team', id: 't', unlimited: true });
    expect(ax.post).toHaveBeenCalledWith(USAGE_API.BOOST, { scope: 'team', id: 't', unlimited: true });
    await usageService.endBoost('b1');
    expect(ax.delete).toHaveBeenCalledWith(`${USAGE_API.BOOST}/b1`);
  });

  it('surfaces the server error', async () => {
    ax.post.mockResolvedValue({ data: { success: false, error: 'Only the owner can do this' } });
    await expect(usageService.boost({ scope: 'all', unlimited: true })).rejects.toThrow('Only the owner can do this');
  });
});

describe('helpers', () => {
  it('formats tokens', () => {
    expect(compactTokens(12_400_000)).toBe('12.4M');
    expect(compactTokens(950)).toBe('950');
    expect(compactTokens(1_200_000_000)).toBe('1.2B');
    expect(tokens(20_000_000)).toBe('20M tokens');
  });
  it('parses token input', () => {
    expect(parseTokenInput('20M')).toBe(20_000_000);
    expect(parseTokenInput('500k tokens')).toBe(500_000);
    expect(parseTokenInput('2000万')).toBe(20_000_000);
    expect(parseTokenInput('')).toBeNull();
    expect(parseTokenInput('lots')).toBeUndefined();
    expect(parseTokenInput('$5')).toBeUndefined();
  });
  it('boostAmount rounds the cap up to a whole million (10M without a cap)', () => {
    expect(boostAmount(50_000_000)).toBe(50_000_000);
    expect(boostAmount(2_500_000)).toBe(3_000_000);
    expect(boostAmount(null)).toBe(10_000_000);
  });
});
