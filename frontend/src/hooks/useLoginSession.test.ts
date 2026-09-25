/**
 * Tests for useLoginSession (polling with fake timers).
 *
 * @module hooks/useLoginSession.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLoginSession } from './useLoginSession';
import { harnessService } from '../services/harness.service';
import type { LoginSession } from '../types/harness.types';

vi.mock('../services/harness.service', () => ({
  harnessService: {
    startLogin: vi.fn(),
    getLoginSession: vi.fn(),
    sendLoginInput: vi.fn(),
    cancelLogin: vi.fn(),
  },
}));

const svc = vi.mocked(harnessService);

/**
 * Build a session.
 *
 * @param overrides - Fields to override
 * @returns Session
 */
function s(overrides: Partial<LoginSession> = {}): LoginSession {
  return {
    id: 's1',
    harnessId: 'claude-code',
    method: 'subscription',
    state: 'starting',
    url: null,
    userCode: null,
    needsInput: false,
    message: null,
    screen: null,
    startedAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('useLoginSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('polls every 1.5s until terminal and notifies success once', async () => {
    svc.startLogin.mockResolvedValue(s());
    svc.getLoginSession
      .mockResolvedValueOnce(s({ state: 'awaiting_user', url: 'https://auth' }))
      .mockResolvedValueOnce(s({ state: 'succeeded' }));
    const onSucceeded = vi.fn();
    const { result } = renderHook(() => useLoginSession('claude-code', onSucceeded));

    await act(async () => {
      await result.current.start('subscription');
    });
    expect(svc.startLogin).toHaveBeenCalledWith('claude-code', 'subscription');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1499);
    });
    expect(svc.getLoginSession).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.session?.url).toBe('https://auth');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.session?.state).toBe('succeeded');
    expect(onSucceeded).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(svc.getLoginSession).toHaveBeenCalledTimes(2);
    expect(onSucceeded).toHaveBeenCalledTimes(1);
  });

  it('keeps polling after a transient poll error', async () => {
    svc.startLogin.mockResolvedValue(s({ state: 'awaiting_user' }));
    svc.getLoginSession.mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce(s({ state: 'verifying' }));
    const { result } = renderHook(() => useLoginSession('claude-code'));
    await act(async () => {
      await result.current.start('subscription');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.error).toBe('blip');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(result.current.session?.state).toBe('verifying');
    expect(result.current.error).toBeNull();
  });

  it('sends input and applies a returned snapshot', async () => {
    svc.startLogin.mockResolvedValue(s({ state: 'awaiting_user', needsInput: true }));
    svc.sendLoginInput.mockResolvedValue(s({ state: 'verifying' }));
    const { result } = renderHook(() => useLoginSession('claude-code'));
    await act(async () => {
      await result.current.start('subscription');
    });
    let ok = false;
    await act(async () => {
      ok = await result.current.sendInput('CODE#123');
    });
    expect(ok).toBe(true);
    expect(svc.sendLoginInput).toHaveBeenCalledWith('s1', 'CODE#123');
    expect(result.current.session?.state).toBe('verifying');
  });

  it('marks cancelled when the cancel response has no session', async () => {
    svc.startLogin.mockResolvedValue(s({ state: 'awaiting_user' }));
    svc.cancelLogin.mockResolvedValue(null);
    const { result } = renderHook(() => useLoginSession('codex-cli'));
    await act(async () => {
      await result.current.start('device');
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(result.current.session?.state).toBe('cancelled');
    act(() => result.current.reset());
    expect(result.current.session).toBeNull();
  });

  it('reports a start error', async () => {
    svc.startLogin.mockRejectedValue(new Error('not installed'));
    const { result } = renderHook(() => useLoginSession('codex-cli'));
    await act(async () => {
      await result.current.start('device');
    });
    expect(result.current.error).toBe('not installed');
    expect(result.current.session).toBeNull();
  });
});
