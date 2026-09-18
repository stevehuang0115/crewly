/**
 * Use Pending Logins Hook Tests
 *
 * @module hooks/usePendingLogins.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { usePendingLogins } from './usePendingLogins';
import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';

vi.mock('axios', () => ({
  default: { get: vi.fn() },
  get: vi.fn(),
}));
const mockedGet = axios.get as ReturnType<typeof vi.fn>;

const entry = {
  sessionName: 'crewly-orc',
  runtimeType: 'codex',
  url: 'https://auth.openai.com/device',
  code: 'FBVZ-MJHKK',
  detectedAt: '2026-09-18T10:00:00.000Z',
  notifiedAt: null,
};

describe('usePendingLogins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the pending list on mount from the pending endpoint', async () => {
    mockedGet.mockResolvedValue({ data: { success: true, data: [entry], count: 1 } });

    const { result } = renderHook(() => usePendingLogins());
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(mockedGet).toHaveBeenCalledWith(
      SIGN_IN_CONSTANTS.PENDING_ENDPOINT,
      expect.objectContaining({ timeout: SIGN_IN_CONSTANTS.PENDING_REQUEST_TIMEOUT_MS }),
    );
    expect(result.current.pending).toEqual([entry]);
  });

  it('polls on the given interval', async () => {
    vi.useFakeTimers();
    mockedGet.mockResolvedValue({ data: { success: true, data: [] } });

    renderHook(() => usePendingLogins(1000));
    expect(mockedGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockedGet).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockedGet).toHaveBeenCalledTimes(4);
  });

  it('keeps the last known list when a poll fails', async () => {
    mockedGet.mockResolvedValueOnce({ data: { success: true, data: [entry] } });
    const { result } = renderHook(() => usePendingLogins());
    await waitFor(() => expect(result.current.pending).toEqual([entry]));

    mockedGet.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.pending).toEqual([entry]);
    expect(result.current.isLoading).toBe(false);
  });

  it('ignores a malformed success payload', async () => {
    mockedGet.mockResolvedValue({ data: { success: true, data: 'nope' } });
    const { result } = renderHook(() => usePendingLogins());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.pending).toEqual([]);
  });
});
