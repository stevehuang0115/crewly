/**
 * Pending Logins Banner
 *
 * The one "an agent needs you to sign in" banner. Shown whenever an agent
 * session is parked on a runtime sign-in screen (`GET /api/oauth/pending`).
 * Each pending session gets a "Sign-in needed" chip whose panel exposes the
 * login URL and device code, so the owner can complete the login from any
 * page without hunting through terminals.
 *
 * Layout: rendered by `AppLayout` inside the main content column, in normal
 * flow above the page — not `position: fixed` over the whole viewport,
 * which used to put it under the sidebar and on top of the orchestrator
 * banner (two translucent layers of overlapping text). It wraps on narrow
 * widths.
 *
 * Self-clearing: the pending list is re-polled on an interval and on
 * focus / visibility; harness login state (`GET /api/harness`) is
 * re-checked too, and an entry whose harness finished a login after the
 * sign-in screen was detected is hidden right away (see
 * `utils/harness-login-marks`).
 *
 * Dismissal is keyed on the set of pending (session, url, code) triples and
 * persisted in localStorage: it lasts until that set changes.
 *
 * @module components/PendingLoginsBanner
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { usePendingLogins } from '../hooks/usePendingLogins';
import { harnessService } from '../services/harness.service';
import { SignInNeededChip } from './SignInNeededChip';
import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';
import { ORCHESTRATOR_SESSION } from '../utils/team-chat.utils';
import {
  isPendingLoginResolved,
  recordHarnessLoginStates,
  type ObservedLoginState,
} from '../utils/harness-login-marks';
import type { PendingLogin } from '../types';

/**
 * Stable key for a pending-login set so dismissal survives re-polls of the
 * same data but resets when a new sign-in appears.
 *
 * @param pending - Current pending list
 * @returns Key string
 */
export function pendingLoginsKey(pending: PendingLogin[]): string {
  return pending
    .map((p) => `${p.sessionName}|${p.url ?? ''}|${p.code ?? ''}`)
    .sort()
    .join(';');
}

/**
 * Read the persisted dismissed key (best-effort).
 *
 * @returns Dismissed key, or null
 */
function readDismissedKey(): string | null {
  try {
    return window.localStorage.getItem(SIGN_IN_CONSTANTS.DISMISSED_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist the dismissed key (best-effort).
 *
 * @param key - Key to store
 */
function writeDismissedKey(key: string): void {
  try {
    window.localStorage.setItem(SIGN_IN_CONSTANTS.DISMISSED_STORAGE_KEY, key);
  } catch {
    // Storage unavailable: dismissal lasts for this page view only.
  }
}

/**
 * Human label for a pending session.
 *
 * @param sessionName - PTY session name
 * @returns Label shown next to the chip
 */
export function pendingSessionLabel(sessionName: string): string {
  return sessionName === ORCHESTRATOR_SESSION ? `Orchestrator (${sessionName})` : sessionName;
}

/**
 * Harness login states, re-checked on an interval and on focus. Each fetch
 * also records logged-out → logged-in transitions.
 *
 * @param onTransition - Called when some harness just became logged in
 * @returns Latest state per harness id
 */
function useHarnessLoginStates(onTransition: () => void): Record<string, ObservedLoginState> {
  const [states, setStates] = useState<Record<string, ObservedLoginState>>({});

  const check = useCallback(async () => {
    try {
      const overview = await harnessService.getStatus();
      const next: Record<string, ObservedLoginState> = {};
      for (const h of overview.harnesses) next[h.id] = h.loginState;
      setStates(next);
      if (recordHarnessLoginStates(next).length > 0) onTransition();
    } catch {
      // Non-critical: keep the last known states.
    }
  }, [onTransition]);

  useEffect(() => {
    void check();
    const timer = setInterval(() => void check(), SIGN_IN_CONSTANTS.HARNESS_RECHECK_INTERVAL_MS);
    const onFocus = (): void => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [check]);

  return states;
}

/**
 * Global "agents need sign-in" banner. Renders nothing while loading, when
 * nothing unresolved is pending, or when the current set has been dismissed.
 */
export const PendingLoginsBanner: React.FC = () => {
  const { pending: rawPending, isLoading, refresh } = usePendingLogins();
  const onTransition = useCallback(() => void refresh(), [refresh]);
  const harnessStates = useHarnessLoginStates(onTransition);
  const [dismissedKey, setDismissedKey] = useState<string | null>(() => readDismissedKey());

  const pending = useMemo(
    () =>
      rawPending.filter(
        (p) => !isPendingLoginResolved(p.runtimeType, p.detectedAt, p.runtimeType ? harnessStates[p.runtimeType] : undefined),
      ),
    [rawPending, harnessStates],
  );
  const key = useMemo(() => pendingLoginsKey(pending), [pending]);

  if (isLoading || pending.length === 0 || dismissedKey === key) {
    return null;
  }

  /** Hide until the pending set changes. */
  const dismiss = (): void => {
    setDismissedKey(key);
    writeDismissedKey(key);
  };

  return (
    <div
      role="status"
      data-testid="pending-logins-banner"
      className="relative z-20 flex items-start justify-between gap-3 px-4 py-2.5 border-b bg-surface-dark border-amber-500/40 text-sm"
    >
      <div className="flex flex-1 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <KeyRound className="shrink-0 text-amber-400" size={18} aria-hidden />
        <span className="font-semibold text-amber-300">
          {pending.length === 1 ? '1 agent needs you to sign in' : `${pending.length} agents need you to sign in`}
        </span>
        <span className="text-text-secondary-dark">
          {pending.length === 1
            ? 'Its AI runtime is waiting for an account login.'
            : 'Their AI runtimes are waiting for an account login.'}
        </span>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {pending.map((p) => (
            <div key={p.sessionName} className="flex min-w-0 items-center gap-1.5 text-xs text-amber-200/90">
              <span className="font-mono break-all">{pendingSessionLabel(p.sessionName)}</span>
              <SignInNeededChip loginRequired={p} agentLabel={pendingSessionLabel(p.sessionName)} />
            </div>
          ))}
        </div>
      </div>
      <IconButton
        icon={X}
        size="xs"
        onClick={dismiss}
        className="shrink-0 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
        aria-label="Dismiss sign-in banner"
      />
    </div>
  );
};

export default PendingLoginsBanner;
