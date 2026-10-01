/**
 * Sign-in Needed Chip
 *
 * A small warning chip rendered next to an agent (orchestrator status
 * banner, team member rows, team cards) whose runtime is parked on an
 * sign-in screen. Clicking it opens a compact panel.
 *
 * For a runtime Crewly can sign in itself (Claude Code, Codex) the panel
 * starts the same brokered login the Slack re-login uses: a "Sign in from
 * here" button, then the sign-in link, the one-time code (Codex) or a field
 * to paste the code the page shows (Claude). It works from a phone on the
 * LAN dashboard and never needs a terminal. When the backend already runs a
 * login for that runtime (the owner replied `login` on Slack) the panel
 * shows that same session. Other runtimes keep the captured URL / code.
 *
 * @module components/SignInNeededChip
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Copy, Check, ExternalLink, AlertCircle } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import type { LoginRequiredInfo } from '../types';
import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';
import { CLIPBOARD_CONSTANTS } from '../constants/clipboard.constants';
import { useCopyToClipboard } from '../hooks/useCopyToClipboard';
import { selectElementText } from '../utils/clipboard';
import { BrokerLoginPanel } from './Harness/BrokerLoginPanel';
import type { BrokerLoginMethodId, HarnessId } from '../types/harness.types';

/** Runtimes the backend can sign in itself, with their broker method and button label. */
const BROKER_LOGINS: Readonly<Record<string, { harnessId: HarnessId; method: BrokerLoginMethodId; label: string }>> = {
  'claude-code': { harnessId: 'claude-code', method: 'subscription', label: 'Sign in to Claude Code from here' },
  'codex-cli': { harnessId: 'codex-cli', method: 'device', label: 'Sign in to Codex from here' },
};

/**
 * The broker login for a runtime, if Crewly can run one.
 *
 * @param runtimeType - Runtime type of the agent
 * @returns Harness, method and label, or null
 */
export function brokerLoginFor(runtimeType: string | null | undefined): { harnessId: HarnessId; method: BrokerLoginMethodId; label: string } | null {
  return runtimeType ? BROKER_LOGINS[runtimeType] ?? null : null;
}

export interface SignInNeededChipProps {
  /** The pending sign-in to surface */
  loginRequired: LoginRequiredInfo;
  /** Optional label naming the agent, shown in the panel title */
  agentLabel?: string;
  /** Extra classes for the chip button */
  className?: string;
  /** Where the panel opens relative to the chip */
  align?: 'left' | 'right';
  /** Runtime of the agent (enables the in-place sign-in for Claude Code / Codex) */
  runtimeType?: string | null;
}

/**
 * Warning chip + popover panel for a pending runtime sign-in.
 *
 * @param props - Component props
 * @returns The chip, with the panel rendered while open
 */
export const SignInNeededChip: React.FC<SignInNeededChipProps> = ({
  loginRequired,
  agentLabel,
  className = '',
  align = 'left',
  runtimeType,
}) => {
  const broker = brokerLoginFor(runtimeType ?? (loginRequired as { runtimeType?: string | null }).runtimeType);
  // A device code on the agent's own screen (Codex) completes by itself, so
  // it stays visible; Claude's own screen wants a code typed into the
  // agent's terminal, which a phone cannot do — only the brokered sign-in.
  const showCaptured = !broker || (broker.harnessId === 'codex-cli' && Boolean(loginRequired.code));
  const [open, setOpen] = useState(false);
  const { status: copyStatus, copy } = useCopyToClipboard(SIGN_IN_CONSTANTS.COPIED_FEEDBACK_MS);
  const copied = copyStatus === 'copied';
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!loginRequired.code) return;
    await copy(loginRequired.code);
  }, [loginRequired.code, copy]);

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen((v) => !v);
  };

  const detectedAt = new Date(loginRequired.detectedAt);
  const detectedLabel = Number.isNaN(detectedAt.getTime()) ? null : detectedAt.toLocaleString();

  return (
    <div ref={rootRef} className="relative inline-flex" data-testid="sign-in-needed-chip" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="This agent is waiting for you to sign in"
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/40 hover:bg-amber-500/25 transition-colors ${className}`}
      >
        <KeyRound className="w-3 h-3" />
        {SIGN_IN_CONSTANTS.CHIP_LABEL}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Sign-in details"
          className={`absolute top-full mt-2 z-40 w-80 max-w-[90vw] rounded-xl border border-amber-500/30 bg-surface-dark shadow-xl p-3 text-sm text-left ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          <div className="font-semibold text-amber-300 mb-1">
            {agentLabel ? `${agentLabel} needs you to sign in` : 'Sign-in needed'}
          </div>
          {showCaptured && (
          <>
          <p className="text-text-secondary-dark text-xs mb-2">
            The agent&apos;s runtime is waiting on an account login. Open the link and enter the code.
          </p>

          {loginRequired.url ? (
            <a
              href={loginRequired.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-primary hover:underline break-all mb-2"
              data-testid="sign-in-url"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              <span>{loginRequired.url}</span>
            </a>
          ) : (
            <div className="text-xs text-text-secondary-dark mb-2">No login URL was captured — check the agent&apos;s terminal.</div>
          )}

          {loginRequired.code ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-background-dark border border-border-dark px-2 py-1.5">
              <code
                className="font-mono tracking-widest text-base select-all cursor-text break-all"
                data-testid="sign-in-code"
                onClick={(e) => selectElementText(e.currentTarget)}
              >
                {loginRequired.code}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon={copied ? Check : copyStatus === 'failed' ? AlertCircle : Copy}
                onClick={handleCopy}
                className={copied ? 'bg-green-500/10 text-green-400 hover:text-green-400' : ''}
                aria-label={copied ? 'Code copied' : 'Copy code to clipboard'}
                aria-live="polite"
              >
                {copied
                  ? CLIPBOARD_CONSTANTS.COPIED_LABEL
                  : copyStatus === 'failed'
                    ? CLIPBOARD_CONSTANTS.FAILED_LABEL
                    : CLIPBOARD_CONSTANTS.COPY_LABEL}
              </Button>
            </div>
          ) : (
            <div className="text-xs text-text-secondary-dark">No device code — the login completes in the browser.</div>
          )}
          </>
          )}

          {broker && (
            <div data-testid="sign-in-broker" className={showCaptured ? 'mt-3 pt-3 border-t border-border-dark' : ''}>
              <p className="text-text-secondary-dark text-xs mb-2">
                {showCaptured
                  ? 'Or let Crewly run the sign-in for you:'
                  : "The agent's runtime is signed out. Sign in here (your phone is fine) and the waiting agents pick up where they left off."}
              </p>
              <BrokerLoginPanel harnessId={broker.harnessId} method={broker.method} label={broker.label} cancelOnUnmount={false} />
            </div>
          )}

          {detectedLabel && (
            <div className="text-[11px] text-text-secondary-dark mt-2">Detected {detectedLabel}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default SignInNeededChip;
