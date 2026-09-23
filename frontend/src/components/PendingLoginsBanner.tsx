/**
 * Pending Logins Banner
 *
 * App-wide banner shown whenever any agent session is parked on a runtime
 * sign-in screen (polled from `GET /api/oauth/pending` once a minute). Each
 * pending session gets a "Sign-in needed" chip whose panel exposes the
 * login URL and device code, so the owner can complete the login from any
 * page without hunting through terminals.
 *
 * Dismissal is keyed on the set of pending (session, url, code) triples: a
 * new sign-in re-shows the banner even after an earlier one was dismissed.
 *
 * @module components/PendingLoginsBanner
 */

import React, { useMemo, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { usePendingLogins } from '../hooks/usePendingLogins';
import { SignInNeededChip } from './SignInNeededChip';
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
 * Global "agents need sign-in" banner. Renders nothing while loading, when
 * the list is empty, or when the current set has been dismissed.
 */
export const PendingLoginsBanner: React.FC = () => {
  const { pending, isLoading } = usePendingLogins();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const key = useMemo(() => pendingLoginsKey(pending), [pending]);

  if (isLoading || pending.length === 0 || dismissedKey === key) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="pending-logins-banner"
      className="fixed top-0 inset-x-0 z-50 flex items-center justify-between gap-3 px-4 py-2.5 border-b bg-amber-500/15 border-amber-500/40 backdrop-blur-sm"
    >
      <div className="flex items-center gap-3 min-w-0 flex-wrap">
        <KeyRound className="shrink-0 text-amber-400" size={18} />
        <span className="font-semibold text-amber-300 text-sm">
          {pending.length === 1 ? '1 agent needs you to sign in' : `${pending.length} agents need you to sign in`}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          {pending.map((p) => (
            <div key={p.sessionName} className="flex items-center gap-1 text-xs text-amber-200/90">
              <span className="font-mono">{p.sessionName}</span>
              <SignInNeededChip loginRequired={p} agentLabel={p.sessionName} />
            </div>
          ))}
        </div>
      </div>
      <IconButton
        icon={X}
        size="xs"
        onClick={() => setDismissedKey(key)}
        className="shrink-0 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
        aria-label="Dismiss sign-in banner"
      />
    </div>
  );
};

export default PendingLoginsBanner;
