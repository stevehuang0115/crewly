/**
 * Use Orchestrator Status Hook
 *
 * Custom hook for checking orchestrator status.
 * Used by Chat and other components to determine if orchestrator is active.
 *
 * @module hooks/useOrchestratorStatus
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { webSocketService } from '../services/websocket.service';
import type { LoginRequiredInfo } from '../types';

// =============================================================================
// Types
// =============================================================================

/**
 * Orchestrator status data from the API
 */
export interface OrchestratorStatus {
  /** Whether the orchestrator is active and ready */
  isActive: boolean;
  /** Current agent status (active, inactive, activating) */
  agentStatus: string | null;
  /** Human-readable status message */
  message: string;
  /** User-friendly offline message for display */
  offlineMessage: string | null;
  /** Pending runtime sign-in (url + device code) captured from the orchestrator's terminal */
  loginRequired?: LoginRequiredInfo | null;
}

/**
 * Return type for the useOrchestratorStatus hook
 */
export interface UseOrchestratorStatusResult {
  /** Current orchestrator status */
  status: OrchestratorStatus | null;
  /** Whether the status is being loaded */
  isLoading: boolean;
  /** Error message if status check failed */
  error: string | null;
  /** Function to manually refresh status */
  refresh: () => Promise<void>;
}

// =============================================================================
// Constants
// =============================================================================

/** API endpoint for orchestrator status */
const ORCHESTRATOR_STATUS_ENDPOINT = '/api/orchestrator/status';

/** Request timeout in milliseconds (5 seconds) */
const REQUEST_TIMEOUT = 5000;

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook to check and monitor orchestrator status.
 *
 * Fetches status once on mount and then relies on WebSocket events for real-time updates.
 * Falls back to a single re-fetch when the WebSocket reconnects.
 *
 * @returns Object with status, loading state, error, and refresh function
 *
 * @example
 * ```typescript
 * const { status, isLoading, error, refresh } = useOrchestratorStatus();
 *
 * if (isLoading) return <Loading />;
 * if (!status?.isActive) return <OrchestratorOffline message={status?.offlineMessage} />;
 * ```
 */
export function useOrchestratorStatus(): UseOrchestratorStatusResult {

  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track if component is mounted to prevent state updates after unmount
  const isMountedRef = useRef(true);
  // Track current request to prevent race conditions
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Fetch orchestrator status from the API
   */
  const fetchStatus = useCallback(async () => {
    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new abort controller for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await axios.get<{
        success: boolean;
        data: OrchestratorStatus;
        error?: string;
      }>(ORCHESTRATOR_STATUS_ENDPOINT, {
        signal: controller.signal,
        timeout: REQUEST_TIMEOUT,
      });

      // Only update state if component is still mounted
      if (!isMountedRef.current) return;

      if (response.data.success && response.data.data) {
        setStatus(response.data.data);
        setError(null);
      } else {
        setError(response.data.error || 'Failed to get orchestrator status');
      }
    } catch (err) {
      // Ignore aborted requests
      if (axios.isCancel(err)) return;

      // Only update state if component is still mounted
      if (!isMountedRef.current) return;

      // Don't set error for network errors - orchestrator might just be starting
      const errorMessage = err instanceof Error ? err.message : 'Unable to check orchestrator status';
      setError(errorMessage);
      // Set a default offline status
      setStatus({
        isActive: false,
        agentStatus: null,
        message: 'Unable to check orchestrator status',
        offlineMessage: 'The orchestrator is currently offline. Please start it from the Dashboard.',
      });
    } finally {
      // Only update state if component is still mounted
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  /**
   * Public refresh function for manual status refresh
   */
  const refresh = useCallback(async () => {
    setIsLoading(true);
    await fetchStatus();
  }, [fetchStatus]);

  // Initial fetch on mount and cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    fetchStatus();

    return () => {
      isMountedRef.current = false;
      // Cancel any pending request on unmount
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchStatus]);

  // Listen for WebSocket orchestrator status changes for real-time updates
  useEffect(() => {
    const handleOrchestratorStatusChange = (payload: {
      sessionName?: string;
      agentStatus?: string;
      status?: string;
      workingStatus?: string;
      running?: boolean;
    }) => {
      // Only update if component is still mounted
      if (!isMountedRef.current) return;

      // Normalize: different broadcasters use different field names.
      // Prefer agentStatus, fall back to status, then derive from running.
      const resolvedStatus = payload.agentStatus
        ?? payload.status
        ?? (payload.running === true ? 'active' : payload.running === false ? 'inactive' : undefined);

      // Map the WebSocket payload to our OrchestratorStatus format
      const isActive = resolvedStatus === 'active';
      // WebSocket payloads carry no sign-in detail; keep the last fetched
      // loginRequired while the orchestrator is still not active, and clear
      // it the moment it reports active (the sign-in evidently completed).
      setStatus((prev) => ({
        isActive,
        agentStatus: resolvedStatus || null,
        message: isActive
          ? 'Orchestrator is active and ready.'
          : resolvedStatus === 'starting' || resolvedStatus === 'started'
          ? 'Orchestrator is starting up. Please wait a moment and try again.'
          : 'Orchestrator is not running. Please start the orchestrator from the Dashboard.',
        offlineMessage: isActive
          ? null
          : 'The orchestrator is currently offline. Please start it from the Crewly dashboard.',
        loginRequired: isActive ? null : prev?.loginRequired ?? null,
      }));
      setIsLoading(false);
      setError(null);
    };

    // Re-fetch status when WebSocket reconnects (may have missed events while disconnected)
    const handleReconnect = () => {
      if (isMountedRef.current) {
        fetchStatus();
      }
    };

    webSocketService.on('orchestrator_status_changed', handleOrchestratorStatusChange);
    webSocketService.on('connected', handleReconnect);

    return () => {
      webSocketService.off('orchestrator_status_changed', handleOrchestratorStatusChange);
      webSocketService.off('connected', handleReconnect);
    };
  }, [fetchStatus]);

  return {
    status,
    isLoading,
    error,
    refresh,
  };
}

export default useOrchestratorStatus;
