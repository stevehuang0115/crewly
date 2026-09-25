/**
 * useLoginSession Hook
 *
 * Drives one login-broker session: start (`POST /api/harness/:id/login`),
 * poll every 1.5s while not terminal, send pasted text, cancel.
 *
 * @module hooks/useLoginSession
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { harnessService } from '../services/harness.service';
import type { BrokerLoginMethodId, HarnessId, LoginSession } from '../types/harness.types';
import { isTerminalLoginState } from '../types/harness.types';
import { HARNESS_TIMING } from '../constants/harness.constants';

export interface UseLoginSessionResult {
  /** Current session (null before start / after reset) */
  session: LoginSession | null;
  /** Last request error */
  error: string | null;
  /** True while a start / input / cancel request is in flight */
  busy: boolean;
  /** Start a session with the given method */
  start: (method: BrokerLoginMethodId) => Promise<void>;
  /** Send text to the session; resolves true on success */
  sendInput: (text: string) => Promise<boolean>;
  /** Cancel the session */
  cancel: () => Promise<void>;
  /** Forget the session (back to the method picker) */
  reset: () => void;
}

/**
 * Login-broker session state for one harness.
 *
 * @param harnessId - Harness to log in to
 * @param onSucceeded - Called once when a session reaches `succeeded`
 * @returns {@link UseLoginSessionResult}
 */
export function useLoginSession(harnessId: HarnessId, onSucceeded?: () => void): UseLoginSessionResult {
  const [session, setSession] = useState<LoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped after a failed poll so polling retries on the next interval.
  const [pollRetry, setPollRetry] = useState(0);
  const onSucceededRef = useRef(onSucceeded);
  onSucceededRef.current = onSucceeded;
  const notifiedRef = useRef<string | null>(null);

  const start = useCallback(
    async (method: BrokerLoginMethodId) => {
      setBusy(true);
      setError(null);
      try {
        setSession(await harnessService.startLogin(harnessId, method));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [harnessId],
  );

  const sendInput = useCallback(
    async (text: string): Promise<boolean> => {
      if (!session) return false;
      setBusy(true);
      setError(null);
      try {
        const next = await harnessService.sendLoginInput(session.id, text);
        // No snapshot in the response: the next poll picks up the change.
        if (next) setSession(next);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  const cancel = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    try {
      const next = await harnessService.cancelLogin(session.id);
      setSession(next ?? { ...session, state: 'cancelled' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [session]);

  const reset = useCallback(() => {
    setSession(null);
    setError(null);
  }, []);

  // Poll while the session is live. Each new snapshot re-arms the timer.
  useEffect(() => {
    if (!session || isTerminalLoginState(session.state)) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = await harnessService.getLoginSession(session.id);
        if (cancelled) return;
        setSession(next);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPollRetry((n) => n + 1);
      }
    }, HARNESS_TIMING.LOGIN_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, pollRetry]);

  useEffect(() => {
    if (session?.state === 'succeeded' && notifiedRef.current !== session.id) {
      notifiedRef.current = session.id;
      onSucceededRef.current?.();
    }
  }, [session]);

  return { session, error, busy, start, sendInput, cancel, reset };
}
