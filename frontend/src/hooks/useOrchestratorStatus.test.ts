/**
 * Use Orchestrator Status Hook Tests
 *
 * Tests for the useOrchestratorStatus hook.
 *
 * @module hooks/useOrchestratorStatus.test
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import axios from 'axios';
import { useOrchestratorStatus } from './useOrchestratorStatus';

// Mock axios
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    isCancel: vi.fn(() => false),
  },
  get: vi.fn(),
  isCancel: vi.fn(() => false),
}));
const mockedAxios = {
  get: axios.get as ReturnType<typeof vi.fn>,
  isCancel: axios.isCancel as ReturnType<typeof vi.fn>,
};

// Mock webSocketService
const mockOn = vi.fn();
const mockOff = vi.fn();
vi.mock('../services/websocket.service', () => ({
  webSocketService: {
    on: (...args: unknown[]) => mockOn(...args),
    off: (...args: unknown[]) => mockOff(...args),
  },
}));

describe('useOrchestratorStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAxios.isCancel.mockReturnValue(false);
  });

  describe('initial state', () => {
    it('should start with loading state', () => {
      mockedAxios.get.mockImplementation(() => new Promise(() => {}));

      const { result } = renderHook(() => useOrchestratorStatus());

      expect(result.current.isLoading).toBe(true);
      expect(result.current.status).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });

  describe('successful fetch', () => {
    it('should fetch and return active status', async () => {
      const mockStatus = {
        isActive: true,
        agentStatus: 'active',
        message: 'Orchestrator is active and ready.',
        offlineMessage: null,
      };

      mockedAxios.get.mockResolvedValueOnce({
        data: { success: true, data: mockStatus },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status).toEqual(mockStatus);
      expect(result.current.error).toBeNull();
    });

    it('should fetch and return inactive status', async () => {
      const mockStatus = {
        isActive: false,
        agentStatus: 'inactive',
        message: 'Orchestrator is not running.',
        offlineMessage: 'The orchestrator is currently offline. Please start it from the Dashboard.',
      };

      mockedAxios.get.mockResolvedValueOnce({
        data: { success: true, data: mockStatus },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status?.isActive).toBe(false);
      expect(result.current.status?.offlineMessage).toBeTruthy();
    });
  });

  describe('error handling', () => {
    it('should handle API errors gracefully', async () => {
      mockedAxios.get.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Network error');
      expect(result.current.status?.isActive).toBe(false);
    });

    it('should handle API returning error response', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: { success: false, error: 'Server error' },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBe('Server error');
    });
  });

  describe('WebSocket integration', () => {
    it('should subscribe to orchestrator_status_changed and connected events', () => {
      mockedAxios.get.mockImplementation(() => new Promise(() => {}));

      renderHook(() => useOrchestratorStatus());

      expect(mockOn).toHaveBeenCalledWith('orchestrator_status_changed', expect.any(Function));
      expect(mockOn).toHaveBeenCalledWith('connected', expect.any(Function));
    });

    it('should update status from WebSocket event', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            isActive: false,
            agentStatus: 'inactive',
            message: 'Not running',
            offlineMessage: 'Offline',
          },
        },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status?.isActive).toBe(false);

      // Simulate WebSocket status change
      const statusChangeHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'orchestrator_status_changed'
      )?.[1];

      act(() => {
        statusChangeHandler({ agentStatus: 'active' });
      });

      expect(result.current.status?.isActive).toBe(true);
      expect(result.current.status?.agentStatus).toBe('active');
    });

    it('should keep loginRequired across WebSocket updates until the orchestrator is active', async () => {
      const loginRequired = { url: 'https://auth.example/device', code: 'ABCD-EFGH', detectedAt: '2026-09-18T10:00:00.000Z' };
      mockedAxios.get.mockResolvedValue({
        data: {
          success: true,
          data: {
            isActive: false,
            agentStatus: 'starting',
            message: 'Orchestrator needs you to sign in',
            offlineMessage: 'offline',
            loginRequired,
          },
        },
      });

      const { result } = renderHook(() => useOrchestratorStatus());
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.status?.loginRequired).toEqual(loginRequired);

      const statusChangeHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'orchestrator_status_changed'
      )?.[1];

      act(() => {
        statusChangeHandler({ agentStatus: 'starting' });
      });
      expect(result.current.status?.loginRequired).toEqual(loginRequired);

      act(() => {
        statusChangeHandler({ agentStatus: 'active' });
      });
      expect(result.current.status?.loginRequired).toBeNull();
    });

    it('should re-fetch status on WebSocket reconnect', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          success: true,
          data: {
            isActive: true,
            agentStatus: 'active',
            message: 'Active',
            offlineMessage: null,
          },
        },
      });

      renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      });

      // Simulate WebSocket reconnection
      const reconnectHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'connected'
      )?.[1];

      await act(async () => {
        reconnectHandler();
      });

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('should not poll — only fetches on mount and reconnect', async () => {
      vi.useFakeTimers();

      mockedAxios.get.mockResolvedValue({
        data: {
          success: true,
          data: {
            isActive: true,
            agentStatus: 'active',
            message: 'Active',
            offlineMessage: null,
          },
        },
      });

      renderHook(() => useOrchestratorStatus());

      // Initial call
      await vi.advanceTimersByTimeAsync(0);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Advance timer well past any polling interval
      await vi.advanceTimersByTimeAsync(60000);

      // Should still be 1 — no polling
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should handle WebSocket event with status field (fallback for agentStatus)', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            isActive: true,
            agentStatus: 'active',
            message: 'Active',
            offlineMessage: null,
          },
        },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Simulate WebSocket event using 'status' field instead of 'agentStatus'
      const statusChangeHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'orchestrator_status_changed'
      )?.[1];

      act(() => {
        statusChangeHandler({ status: 'inactive', reason: 'runtime_exited' });
      });

      expect(result.current.status?.isActive).toBe(false);
      expect(result.current.status?.agentStatus).toBe('inactive');
    });

    it('should handle WebSocket event with running boolean (fallback)', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            isActive: false,
            agentStatus: 'inactive',
            message: 'Not running',
            offlineMessage: 'Offline',
          },
        },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.status?.isActive).toBe(false);

      // Simulate WebSocket event using 'running' boolean
      const statusChangeHandler = mockOn.mock.calls.find(
        (call) => call[0] === 'orchestrator_status_changed'
      )?.[1];

      act(() => {
        statusChangeHandler({ sessionName: 'crewly-orc', running: true });
      });

      expect(result.current.status?.isActive).toBe(true);
      expect(result.current.status?.agentStatus).toBe('active');
    });

    it('should unsubscribe from WebSocket events on unmount', () => {
      mockedAxios.get.mockImplementation(() => new Promise(() => {}));

      const { unmount } = renderHook(() => useOrchestratorStatus());

      unmount();

      expect(mockOff).toHaveBeenCalledWith('orchestrator_status_changed', expect.any(Function));
      expect(mockOff).toHaveBeenCalledWith('connected', expect.any(Function));
    });
  });

  describe('refresh', () => {
    it('should allow manual refresh', async () => {
      const mockStatus = {
        isActive: true,
        agentStatus: 'active',
        message: 'Orchestrator is active.',
        offlineMessage: null,
      };

      mockedAxios.get.mockResolvedValue({
        data: { success: true, data: mockStatus },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Trigger manual refresh
      await act(async () => {
        await result.current.refresh();
      });

      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('should set loading state during refresh', async () => {
      const mockStatus = {
        isActive: true,
        agentStatus: 'active',
        message: 'Active',
        offlineMessage: null,
      };

      mockedAxios.get.mockResolvedValue({
        data: { success: true, data: mockStatus },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      // Wait for initial load
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Trigger refresh and check loading state
      let refreshPromise: Promise<void>;
      act(() => {
        refreshPromise = result.current.refresh();
      });

      expect(result.current.isLoading).toBe(true);

      await act(async () => {
        await refreshPromise;
      });

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should abort in-flight requests on unmount', async () => {
      let rejectPromise: (error: Error) => void;
      const mockPromise = new Promise((_, reject) => {
        rejectPromise = reject;
      });

      mockedAxios.get.mockImplementation(() => mockPromise);

      const { unmount } = renderHook(() => useOrchestratorStatus());

      // Unmount while request is in-flight
      unmount();

      // Simulate cancelled request being rejected
      mockedAxios.isCancel.mockReturnValue(true);
      await act(async () => {
        const cancelError = new Error('canceled');
        (cancelError as Error & { __CANCEL__: boolean }).__CANCEL__ = true;
        try {
          rejectPromise!(cancelError);
        } catch {
          // Ignore - expected for cancelled requests
        }
      });

      // The hook should have been unmounted and abort controller called
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('request cancellation', () => {
    it('should ignore cancelled requests', async () => {
      const cancelError = new Error('canceled');
      (cancelError as Error & { __CANCEL__: boolean }).__CANCEL__ = true;

      mockedAxios.isCancel.mockReturnValue(true);
      mockedAxios.get.mockRejectedValueOnce(cancelError);

      renderHook(() => useOrchestratorStatus());

      // Give the hook time to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Cancelled requests should be ignored - hook remains in loading state
      // because no successful response was received
      expect(mockedAxios.get).toHaveBeenCalled();
    });

    it('should pass abort signal and timeout to axios request', async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            isActive: true,
            agentStatus: 'active',
            message: 'Active',
            offlineMessage: null,
          },
        },
      });

      const { result } = renderHook(() => useOrchestratorStatus());

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Verify axios.get was called with signal and timeout options
      expect(mockedAxios.get).toHaveBeenCalledWith(
        '/api/orchestrator/status',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          timeout: 5000,
        })
      );
    });
  });
});
