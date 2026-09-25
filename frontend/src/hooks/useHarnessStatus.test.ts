/**
 * Tests for useHarnessStatus.
 *
 * @module hooks/useHarnessStatus.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useHarnessStatus, sortHarnesses } from './useHarnessStatus';
import { harnessService } from '../services/harness.service';
import type { HarnessStatus } from '../types/harness.types';

vi.mock('../services/harness.service', () => ({
  harnessService: {
    getStatus: vi.fn(),
    setOrcHarness: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

/**
 * Build a harness.
 *
 * @param id - Harness id
 * @returns Status
 */
function h(id: HarnessStatus['id']): HarnessStatus {
  return {
    id,
    displayName: id,
    installed: true,
    version: '1',
    latestVersion: '1',
    updateAvailable: false,
    loginState: 'logged_in',
    loginSource: null,
    loginMethods: [],
  };
}

describe('sortHarnesses', () => {
  it('orders claude, codex, gemini', () => {
    expect(sortHarnesses([h('gemini-cli'), h('claude-code'), h('codex-cli')]).map((x) => x.id)).toEqual([
      'claude-code',
      'codex-cli',
      'gemini-cli',
    ]);
  });
});

describe('useHarnessStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the overview sorted', async () => {
    svc.getStatus.mockResolvedValue({ harnesses: [h('codex-cli'), h('claude-code')], orcHarness: null, systemTools: [] });
    const { result } = renderHook(() => useHarnessStatus());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.overview?.harnesses[0].id).toBe('claude-code');
  });

  it('reports load errors', async () => {
    svc.getStatus.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHarnessStatus());
    await waitFor(() => expect(result.current.error).toBe('offline'));
  });

  it('saves the orc harness', async () => {
    svc.getStatus.mockResolvedValue({ harnesses: [h('claude-code')], orcHarness: null, systemTools: [] });
    svc.setOrcHarness.mockResolvedValue('claude-code');
    const { result } = renderHook(() => useHarnessStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    let ok = false;
    await act(async () => {
      ok = await result.current.setOrcHarness('claude-code');
    });
    expect(ok).toBe(true);
    expect(result.current.overview?.orcHarness).toBe('claude-code');
  });

  it('replaces one harness in place', async () => {
    svc.getStatus.mockResolvedValue({ harnesses: [h('claude-code')], orcHarness: null, systemTools: [] });
    const { result } = renderHook(() => useHarnessStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.replaceHarness({ ...h('claude-code'), loginState: 'logged_out' }));
    expect(result.current.overview?.harnesses[0].loginState).toBe('logged_out');
  });
});
