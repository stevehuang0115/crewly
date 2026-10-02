/**
 * Tests for the spend API client.
 *
 * @module services/spend.service.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { parseCapInput, spendService, SPEND_API, usd } from './spend.service';

vi.mock('axios', async (importOriginal) => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: vi.fn(), put: vi.fn(), post: vi.fn() } };
});

const ax = vi.mocked(axios);

describe('spendService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GETs the spend view for a window', async () => {
    ax.get.mockResolvedValue({ data: { success: true, data: { today: '2026-10-02' } } });
    expect(await spendService.get(7)).toEqual({ today: '2026-10-02' });
    expect(ax.get).toHaveBeenCalledWith(SPEND_API.SPEND, { params: { days: 7 } });
  });

  it('PUTs caps and POSTs a raise', async () => {
    ax.put.mockResolvedValue({ data: { success: true, data: { defaultAgentCapUsd: 5 } } });
    ax.post.mockResolvedValue({ data: { success: true, data: { session: 'crewly-orc', capUsd: 10 } } });
    await spendService.setCaps({ defaultAgentCapUsd: 5 });
    expect(ax.put).toHaveBeenCalledWith(SPEND_API.CAPS, { defaultAgentCapUsd: 5 });
    expect(await spendService.raise('crewly-orc', 10)).toEqual({ session: 'crewly-orc', capUsd: 10 });
    expect(ax.post).toHaveBeenCalledWith(SPEND_API.RAISE, { session: 'crewly-orc', capUsd: 10 });
  });

  it('surfaces the server error', async () => {
    ax.put.mockResolvedValue({ data: { success: false, error: 'Only the owner can do this' } });
    await expect(spendService.setCaps({})).rejects.toThrow('Only the owner can do this');
  });
});

describe('helpers', () => {
  it('usd', () => {
    expect(usd(5)).toBe('$5.00');
    expect(usd(0.004)).toBe('$0.00');
  });
  it('parseCapInput', () => {
    expect(parseCapInput('')).toBeNull();
    expect(parseCapInput(' $5 ')).toBe(5);
    expect(parseCapInput('2.345')).toBe(2.35);
    expect(parseCapInput('0')).toBeUndefined();
    expect(parseCapInput('lots')).toBeUndefined();
  });
});
