/**
 * Use Relay Status Hook
 *
 * Polls the relay client status at a regular interval and maps backend
 * relay states to the Cloud Bar display states defined in the UX spec
 * (docs/okr/relay-ux-design.md section 3.1).
 *
 * @module hooks/useRelayStatus
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { apiService } from '../services/api.service';
import { CLOUD_TOKEN_KEY } from '../constants/cloud.constants';

// ========================= Types =========================

/** Cloud Bar display states per UX spec section 3.1 */
export type CloudBarState = 'connected' | 'paired' | 'connecting' | 'error' | 'offline';

/**
 * Return type for the useRelayStatus hook
 */
export interface UseRelayStatusResult {
  /** Current Cloud Bar display state */
  state: CloudBarState;
  /** Display label for the current state */
  label: string;
  /** Backend session ID when connected, null otherwise */
  sessionId: string | null;
  /** Whether the initial fetch is still in progress */
  isLoading: boolean;
}

// ========================= Constants =========================

/** Polling interval for relay status in milliseconds (5 seconds) */
const POLL_INTERVAL_MS = 5000;

/** Maps backend relay states to Cloud Bar display states */
const STATE_MAP: Record<string, CloudBarState> = {
  registered: 'connected',
  paired: 'paired',
  connecting: 'connecting',
  error: 'error',
  disconnected: 'offline',
};

/** Maps Cloud Bar states to display labels per UX spec */
const STATE_LABELS: Record<CloudBarState, string> = {
  connected: 'Cloud Active',
  paired: 'Linked',
  connecting: 'Connecting...',
  error: 'Relay Error',
  offline: 'Cloud Offline',
};

// ========================= Hook =========================

/**
 * Hook for polling relay client status and mapping to Cloud Bar states.
 *
 * Fetches status on mount, then polls every 5 seconds. Maps the backend
 * RelayClientState ('disconnected' | 'connecting' | 'registered' | 'paired' | 'error')
 * to Cloud Bar display states.
 *
 * @returns Object with Cloud Bar state, label, sessionId, and loading flag
 *
 * @example
 * ```typescript
 * const { state, label, isLoading } = useRelayStatus();
 * // state: 'connected' | 'paired' | 'connecting' | 'error' | 'offline'
 * ```
 */
export function useRelayStatus(): UseRelayStatusResult {
  const [state, setState] = useState<CloudBarState>('offline');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isMountedRef = useRef(true);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await apiService.getRelayStatus();
      if (isMountedRef.current) {
        let mappedState = STATE_MAP[status.state] ?? 'offline';
        // If relay is offline but user has a cloud token, show connected
        if (mappedState === 'offline' && localStorage.getItem(CLOUD_TOKEN_KEY)) {
          mappedState = 'connected';
        }
        setState(mappedState);
        setSessionId(status.sessionId);
      }
    } catch {
      if (isMountedRef.current) {
        // If relay fetch fails but user has a cloud token, show connected
        if (localStorage.getItem(CLOUD_TOKEN_KEY)) {
          setState('connected');
        } else {
          setState('offline');
        }
        setSessionId(null);
      }
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    const init = async () => {
      await fetchStatus();
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    };

    init();

    const intervalId = setInterval(fetchStatus, POLL_INTERVAL_MS);

    return () => {
      isMountedRef.current = false;
      clearInterval(intervalId);
    };
  }, [fetchStatus]);

  return {
    state,
    label: STATE_LABELS[state],
    sessionId,
    isLoading,
  };
}

export default useRelayStatus;
