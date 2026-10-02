/**
 * Tests for useRuntimeFallback.
 *
 * @module hooks/useRuntimeFallback.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isTestRunning, useRuntimeFallback } from './useRuntimeFallback';
import { runtimeFallbackService, type RuntimeFallbackState } from '../services/runtime-fallback.service';
import { apiService } from '../services/api.service';

vi.mock('../services/runtime-fallback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/runtime-fallback.service')>()),
  runtimeFallbackService: { getState: vi.fn(), updateSettings: vi.fn(), startSmokeTest: vi.fn(), getSmokeTest: vi.fn() },
}));
vi.mock('../services/api.service', () => ({ apiService: { getTeams: vi.fn() } }));

const svc = vi.mocked(runtimeFallbackService);
const api = vi.mocked(apiService);

const state: RuntimeFallbackState = {
  settings: { enabled: true, chain: ['claude-code'], memberChains: {}, orcFollows: true, crewlyAgentModel: 'm', probeIntervalMinutes: 15 },
  runtimes: [{ runtime: 'claude-code', label: 'Claude Code', selectable: true, exhausted: false }],
  exhausted: [],
  overrides: [],
};

describe('useRuntimeFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    svc.getState.mockResolvedValue(state);
    api.getTeams.mockResolvedValue([{ id: 't', name: 'Core', members: [{ id: 'orchestrator-member', name: 'Orc' }, { id: 'm1', name: 'Ella' }] }] as never);
  });

  it('loads the state and the agents that can get their own order (not the orc)', async () => {
    const { result } = renderHook(() => useRuntimeFallback());
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await waitFor(() => expect(result.current.members).toEqual([{ id: 'm1', label: 'Ella (Core)' }]));
    expect(result.current.labelOf('claude-code')).toBe('Claude Code');
    expect(result.current.memberName('m1')).toBe('Ella (Core)');
    expect(result.current.dirty).toBe(false);
  });

  it('tracks a dirty draft, discards it, and saves it', async () => {
    svc.updateSettings.mockImplementation(async (patch) => ({ ...state, settings: { ...state.settings, ...patch } }));
    const { result } = renderHook(() => useRuntimeFallback());
    await waitFor(() => expect(result.current.draft).not.toBeNull());
    act(() => result.current.setDraft({ ...state.settings, orcFollows: false }));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.discard());
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setDraft({ ...state.settings, enabled: false }));
    await act(() => result.current.save());
    expect(svc.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(result.current.dirty).toBe(false);
  });

  it('runs a smoke test until it is done', async () => {
    svc.startSmokeTest.mockResolvedValue({ jobId: 'j', runtime: 'claude-code', state: 'running', startedAt: '' });
    svc.getSmokeTest.mockResolvedValue({ jobId: 'j', runtime: 'claude-code', state: 'done', startedAt: '', result: { runtime: 'claude-code', passed: true, steps: [], durationMs: 1000 } });
    const { result } = renderHook(() => useRuntimeFallback(5));
    await waitFor(() => expect(result.current.state).not.toBeNull());
    await act(() => result.current.runTest('claude-code'));
    expect(isTestRunning(result.current.tests['claude-code'])).toBe(true);
    await waitFor(() => expect(isTestRunning(result.current.tests['claude-code'])).toBe(false));
  });

  it('keeps the load error', async () => {
    svc.getState.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useRuntimeFallback());
    await waitFor(() => expect(result.current.error).toBe('down'));
  });
});
