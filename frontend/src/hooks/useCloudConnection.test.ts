/**
 * Tests for useCloudConnection hook
 *
 * @module hooks/useCloudConnection.test
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useCloudConnection } from './useCloudConnection';
import type { CloudStatus } from '../types';

// Mock the api service
const mockGetCloudStatus = vi.fn();
const mockConnectToCloud = vi.fn();
const mockDisconnectFromCloud = vi.fn();

vi.mock('../services/api.service', () => ({
  apiService: {
    getCloudStatus: (...args: unknown[]) => mockGetCloudStatus(...args),
    connectToCloud: (...args: unknown[]) => mockConnectToCloud(...args),
    disconnectFromCloud: (...args: unknown[]) => mockDisconnectFromCloud(...args),
  },
}));

/** Creates a disconnected cloud status */
function disconnectedStatus(): CloudStatus {
  return { connected: false, tier: null, cloudUrl: null, status: 'disconnected' };
}

/** Creates a connected cloud status */
function connectedStatus(): CloudStatus {
  return { connected: true, tier: 'pro', cloudUrl: 'https://api.crewlyai.com', status: 'connected' };
}

describe('useCloudConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start in loading state', () => {
    mockGetCloudStatus.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useCloudConnection());

    expect(result.current.isLoading).toBe(true);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.tier).toBeNull();
  });

  it('should fetch status on mount and show disconnected state', async () => {
    mockGetCloudStatus.mockResolvedValue(disconnectedStatus());
    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.tier).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockGetCloudStatus).toHaveBeenCalledTimes(1);
  });

  it('should show connected state when cloud is connected', async () => {
    mockGetCloudStatus.mockResolvedValue(connectedStatus());
    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.tier).toBe('pro');
  });

  it('should handle status fetch failure gracefully', async () => {
    mockGetCloudStatus.mockRejectedValue(new Error('Network error'));
    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isConnected).toBe(false);
    expect(result.current.tier).toBeNull();
  });

  it('should connect successfully and update state', async () => {
    mockGetCloudStatus.mockResolvedValue(disconnectedStatus());
    mockConnectToCloud.mockResolvedValue({
      connected: true,
      tier: 'max',
      cloudUrl: 'https://api.crewlyai.com',
    });

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let success: boolean;
    await act(async () => {
      success = await result.current.connect('test-token');
    });

    expect(success!).toBe(true);
    expect(result.current.isConnected).toBe(true);
    expect(result.current.tier).toBe('max');
    expect(result.current.error).toBeNull();
    expect(mockConnectToCloud).toHaveBeenCalledWith('test-token', undefined);
  });

  it('should pass cloudUrl to connect when provided', async () => {
    mockGetCloudStatus.mockResolvedValue(disconnectedStatus());
    mockConnectToCloud.mockResolvedValue({
      connected: true,
      tier: 'pro',
      cloudUrl: 'https://custom.cloud.example',
    });

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    await act(async () => {
      await result.current.connect('token', 'https://custom.cloud.example');
    });

    expect(mockConnectToCloud).toHaveBeenCalledWith('token', 'https://custom.cloud.example');
  });

  it('should handle connect failure and set error', async () => {
    mockGetCloudStatus.mockResolvedValue(disconnectedStatus());
    mockConnectToCloud.mockRejectedValue(new Error('Invalid token'));

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let success: boolean;
    await act(async () => {
      success = await result.current.connect('bad-token');
    });

    expect(success!).toBe(false);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.error).toBe('Invalid token');
  });

  it('should disconnect successfully and reset state', async () => {
    mockGetCloudStatus.mockResolvedValue(connectedStatus());
    mockDisconnectFromCloud.mockResolvedValue(undefined);

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isConnected).toBe(true);

    let success: boolean;
    await act(async () => {
      success = await result.current.disconnect();
    });

    expect(success!).toBe(true);
    expect(result.current.isConnected).toBe(false);
    expect(result.current.tier).toBeNull();
  });

  it('should handle disconnect failure and set error', async () => {
    mockGetCloudStatus.mockResolvedValue(connectedStatus());
    mockDisconnectFromCloud.mockRejectedValue(new Error('Server error'));

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    let success: boolean;
    await act(async () => {
      success = await result.current.disconnect();
    });

    expect(success!).toBe(false);
    expect(result.current.error).toBe('Server error');
  });

  it('should track isActioning during connect', async () => {
    mockGetCloudStatus.mockResolvedValue(disconnectedStatus());

    let resolveConnect: (value: unknown) => void;
    mockConnectToCloud.mockReturnValue(new Promise((resolve) => {
      resolveConnect = resolve;
    }));

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    // Start connect — should set isActioning
    let connectPromise: Promise<boolean>;
    act(() => {
      connectPromise = result.current.connect('token');
    });

    await waitFor(() => {
      expect(result.current.isActioning).toBe(true);
    });

    // Resolve the connect
    await act(async () => {
      resolveConnect!({ connected: true, tier: 'pro', cloudUrl: 'https://api.crewlyai.com' });
      await connectPromise!;
    });

    expect(result.current.isActioning).toBe(false);
  });

  it('should refresh status when refresh is called', async () => {
    mockGetCloudStatus
      .mockResolvedValueOnce(disconnectedStatus())
      .mockResolvedValueOnce(connectedStatus());

    const { result } = renderHook(() => useCloudConnection());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isConnected).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.isConnected).toBe(true);
    expect(result.current.tier).toBe('pro');
    expect(mockGetCloudStatus).toHaveBeenCalledTimes(2);
  });
});
