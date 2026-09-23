/**
 * Sign-in Needed Chip
 *
 * A small warning chip rendered next to an agent (orchestrator status
 * banner, team member rows, team cards) whose runtime is parked on an
 * OAuth sign-in screen. Clicking it opens a compact panel with the login
 * URL as a link and the device code with a copy button, so the owner can
 * finish the sign-in without opening the terminal.
 *
 * @module components/SignInNeededChip
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Copy, Check, ExternalLink } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import type { LoginRequiredInfo } from '../types';
import { SIGN_IN_CONSTANTS } from '../constants/sign-in.constants';

export interface SignInNeededChipProps {
  /** The pending sign-in to surface */
  loginRequired: LoginRequiredInfo;
  /** Optional label naming the agent, shown in the panel title */
  agentLabel?: string;
  /** Extra classes for the chip button */
  className?: string;
  /** Where the panel opens relative to the chip */
  align?: 'left' | 'right';
}

/**
 * Copy text to the clipboard, falling back to a hidden textarea for
 * browsers without the async clipboard API.
 *
 * @param text - Text to copy
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }
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
}) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!loginRequired.code) return;
    await copyToClipboard(loginRequired.code);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), SIGN_IN_CONSTANTS.COPIED_FEEDBACK_MS);
  }, [loginRequired.code]);

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
              <code className="font-mono tracking-widest text-base" data-testid="sign-in-code">{loginRequired.code}</code>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                icon={copied ? Check : Copy}
                onClick={handleCopy}
                className={copied ? 'bg-green-500/10 text-green-400 hover:text-green-400' : ''}
                aria-label={copied ? 'Code copied' : 'Copy code to clipboard'}
              >
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          ) : (
            <div className="text-xs text-text-secondary-dark">No device code — the login completes in the browser.</div>
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
