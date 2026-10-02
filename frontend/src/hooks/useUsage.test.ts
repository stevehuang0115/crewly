/**
 * Tests for useUsage.
 *
 * @module hooks/useUsage.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { capsPatchFromDraft, useUsage } from './useUsage';
import { usageService } from '../services/usage.service';
import { M, makeCapsView, makeUsageStats } from '../test/usage.fixtures';

vi.mock('../services/usage.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/usage.service')>()),
  usageService: { stats: vi.fn(), caps: vi.fn(), setCaps: vi.fn(), boost: vi.fn(), endBoost: vi.fn() },
}));

const svc = vi.mocked(usageService);

describe('capsPatchFromDraft', () => {
  it('turns typed amounts into tokens; empty = off / back to the default', () => {
    expect(capsPatchFromDraft({ total: '200M', defaultAgent: '', teams: { t1: '50M', t2: '' }, agents: { a: '5M', b: '', c: 'No cap' } })).toEqual({
      totalCapTokens: 200 * M,
      defaultAgentCapTokens: null,
      teams: { t1: 50 * M, t2: null },
      agents: { a: 5 * M, b: 'default', c: null },
    });
  });

  it('rejects dollar amounts and junk', () => {
    expect(() => capsPatchFromDraft({ total: '', defaultAgent: '$5', teams: {}, agents: {} })).toThrow('Caps are token amounts like 5M or 500k, or empty for off.');
    expect(() => capsPatchFromDraft({ total: '', defaultAgent: '', teams: { t: 'lots' }, agents: {} })).toThrow('Team caps are token amounts');
    expect(() => capsPatchFromDraft({ total: '', defaultAgent: '', teams: {}, agents: { a: 'x' } })).toThrow('Agent caps are token amounts');
  });
});

describe('useUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.stats.mockResolvedValue(makeUsageStats());
    svc.caps.mockResolvedValue(makeCapsView());
  });

  it('loads stats and caps for the period', async () => {
    const { result } = renderHook(() => useUsage('7'));
    await waitFor(() => expect(result.current.stats).not.toBeNull());
    expect(svc.stats).toHaveBeenCalledWith(7, ['team', 'agent', 'runtime', 'workItem', 'model']);
    expect(svc.caps).toHaveBeenCalledWith(7);
    expect(result.current.lastUpdated).toBeInstanceOf(Date);
  });

  it('boosts, ends a boost and saves caps with a note, then reloads', async () => {
    svc.boost.mockResolvedValue({ id: 'b', target: '*', unlimited: true, until: '', createdAt: '' });
    svc.endBoost.mockResolvedValue({ id: 'b' });
    svc.setCaps.mockResolvedValue(makeCapsView().caps);
    const { result } = renderHook(() => useUsage('1'));
    await waitFor(() => expect(result.current.caps).not.toBeNull());

    await act(() => result.current.boost({ scope: 'all', unlimited: true }, 'Everyone'));
    expect(result.current.note).toBe('Everyone: no cap until midnight.');
    await act(() => result.current.endBoost('b'));
    expect(result.current.note).toBe('Boost ended.');
    let ok = false;
    await act(async () => {
      ok = await result.current.saveCaps({ total: '200M', defaultAgent: '8M', teams: {}, agents: {} });
    });
    expect(ok).toBe(true);
    expect(svc.setCaps).toHaveBeenCalledWith({ totalCapTokens: 200 * M, defaultAgentCapTokens: 8 * M });
    expect(svc.stats).toHaveBeenCalledTimes(4);
  });

  it('keeps a bad cap out of the server and reports why', async () => {
    const { result } = renderHook(() => useUsage('1'));
    await waitFor(() => expect(result.current.caps).not.toBeNull());
    let ok = true;
    await act(async () => {
      ok = await result.current.saveCaps({ total: '', defaultAgent: '$5', teams: {}, agents: {} });
    });
    expect(ok).toBe(false);
    expect(svc.setCaps).not.toHaveBeenCalled();
    expect(result.current.error).toBe('Caps are token amounts like 5M or 500k, or empty for off.');
  });
});
