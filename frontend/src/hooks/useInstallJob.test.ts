/**
 * Tests for useInstallJob (polling with fake timers).
 *
 * @module hooks/useInstallJob.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInstallJob } from './useInstallJob';
import { harnessService } from '../services/harness.service';

vi.mock('../services/harness.service', () => ({
  harnessService: {
    startInstall: vi.fn(),
    getInstallJob: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

describe('useInstallJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('polls every second until the job finishes', async () => {
    svc.startInstall.mockResolvedValue('j1');
    svc.getInstallJob
      .mockResolvedValueOnce({ state: 'running', log: 'step 1', usedUserPrefix: false })
      .mockResolvedValueOnce({ state: 'succeeded', log: 'step 1\ndone', usedUserPrefix: true });
    const onFinished = vi.fn();
    const { result } = renderHook(() => useInstallJob('claude-code', onFinished));

    await act(async () => {
      await result.current.start();
    });
    expect(svc.startInstall).toHaveBeenCalledWith('claude-code');
    expect(result.current.running).toBe(true);
    expect(svc.getInstallJob).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(svc.getInstallJob).toHaveBeenCalledTimes(1);
    expect(result.current.job?.log).toBe('step 1');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.job?.state).toBe('succeeded');
    expect(result.current.running).toBe(false);
    expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ state: 'succeeded', usedUserPrefix: true }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(svc.getInstallJob).toHaveBeenCalledTimes(2);
  });

  it('reports a start error', async () => {
    svc.startInstall.mockRejectedValue(new Error('npm missing'));
    const { result } = renderHook(() => useInstallJob('codex-cli'));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBe('npm missing');
    expect(result.current.running).toBe(false);
  });

  it('stops and reports when a poll fails', async () => {
    svc.startInstall.mockResolvedValue('j1');
    svc.getInstallJob.mockRejectedValue(new Error('gone'));
    const { result } = renderHook(() => useInstallJob('codex-cli'));
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.error).toBe('gone');
    expect(result.current.job?.state).toBe('failed');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(svc.getInstallJob).toHaveBeenCalledTimes(1);
  });
});
