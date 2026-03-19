/**
 * Tests for useRelayStatus hook
 *
 * @module hooks/useRelayStatus.test
 */

import { renderHook, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useRelayStatus } from './useRelayStatus';
import { apiService } from '../services/api.service';

vi.mock('../services/api.service', () => ({
  apiService: {
    getRelayStatus: vi.fn(),
  },
}));

describe('useRelayStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start in loading state', () => {
    vi.mocked(apiService.getRelayStatus).mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useRelayStatus());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.state).toBe('offline');
  });

  it('should map "registered" to "connected" state', async () => {
    vi.mocked(apiService.getRelayStatus).mockResolvedValue({ state: 'registered', sessionId: 'sess-1' });
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('connected');
    expect(result.current.label).toBe('Cloud Active');
    expect(result.current.sessionId).toBe('sess-1');
  });

  it('should map "paired" to "paired" state', async () => {
    vi.mocked(apiService.getRelayStatus).mockResolvedValue({ state: 'paired', sessionId: 'sess-2' });
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('paired');
    expect(result.current.label).toBe('Linked');
  });

  it('should map "connecting" to "connecting" state', async () => {
    vi.mocked(apiService.getRelayStatus).mockResolvedValue({ state: 'connecting', sessionId: null });
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('connecting');
    expect(result.current.label).toBe('Connecting...');
  });

  it('should map "error" to "error" state', async () => {
    vi.mocked(apiService.getRelayStatus).mockResolvedValue({ state: 'error', sessionId: null });
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('error');
    expect(result.current.label).toBe('Relay Error');
  });

  it('should map "disconnected" to "offline" state', async () => {
    vi.mocked(apiService.getRelayStatus).mockResolvedValue({ state: 'disconnected', sessionId: null });
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('offline');
    expect(result.current.label).toBe('Cloud Offline');
  });

  it('should fall back to offline on API error', async () => {
    vi.mocked(apiService.getRelayStatus).mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('offline');
    expect(result.current.sessionId).toBeNull();
  });

  it('should set up polling interval on mount', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    vi.mocked(apiService.getRelayStatus).mockReturnValue(new Promise(() => {}));

    renderHook(() => useRelayStatus());

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    setIntervalSpy.mockRestore();
  });

  it('should clear polling interval on unmount', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    vi.mocked(apiService.getRelayStatus).mockReturnValue(new Promise(() => {}));

    const { unmount } = renderHook(() => useRelayStatus());
    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it('should map unknown states to offline', async () => {
    vi.mocked(apiService.getRelayStatus).mockResolvedValue({ state: 'unknown-state', sessionId: null });
    const { result } = renderHook(() => useRelayStatus());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.state).toBe('offline');
  });
});
