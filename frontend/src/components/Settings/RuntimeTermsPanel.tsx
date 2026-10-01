/**
 * Settings → Runtimes → Terms of Service
 *
 * Some runtimes (Antigravity CLI) show their vendor's Terms of Service on
 * first launch. Crewly never accepts them for the owner: it asks with a
 * Slack card (DM from this machine's Crewly Orc), and the same three choices
 * are offered here inline. "Accept terms…" posts the card and opens the
 * choices; "Check" launches the runtime once and reads its first screen.
 *
 * specs/2026-10-01-runtime-terms-consent.md
 *
 * @module components/Settings/RuntimeTermsPanel
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileCheck, RefreshCw, Search } from 'lucide-react';
import { Alert, Button } from '@crewly/ui';
import { runtimeFallbackService, type RuntimeTermsView, type TermsChoice } from '../../services/runtime-fallback.service';

/** How often the panel refreshes while Crewly is accepting. */
const ACCEPTING_POLL_MS = 3000;

/**
 * Status line of a runtime's Terms.
 *
 * @param v - View
 * @returns Text and tone
 */
export function termsStatus(v: RuntimeTermsView): { text: string; tone: 'ok' | 'warn' | 'muted' } {
  switch (v.status) {
    case 'accepted':
      return {
        text: `Accepted${v.dataSharing === true ? ' · data sharing on' : v.dataSharing === false ? ' · data sharing off' : ''}`,
        tone: 'ok',
      };
    case 'pending':
      return { text: 'Waiting for your answer (a card is in your Slack DM from Crewly Orc)', tone: 'warn' };
    case 'accepting':
      return { text: 'Accepting… then running the runtime test', tone: 'muted' };
    case 'declined':
      return { text: v.blockedReason ?? 'Terms not accepted', tone: 'warn' };
    case 'failed':
      return { text: v.blockedReason ?? 'The setup stopped', tone: 'warn' };
    default:
      return { text: 'Not seen on this machine yet (shown on its first launch)', tone: 'muted' };
  }
}

const TONE_CLASS: Record<'ok' | 'warn' | 'muted', string> = {
  ok: 'text-emerald-400',
  warn: 'text-yellow-400',
  muted: 'text-text-secondary-dark',
};

/** Props. */
export interface RuntimeTermsPanelProps {
  /** Poll interval while accepting (tests shorten it) */
  pollMs?: number;
}

/**
 * Terms consent per runtime, with the inline choices.
 *
 * @param props - Props
 * @returns Panel (nothing when no runtime has a Terms flow)
 */
export const RuntimeTermsPanel: React.FC<RuntimeTermsPanelProps> = ({ pollMs = ACCEPTING_POLL_MS }) => {
  const [views, setViews] = useState<RuntimeTermsView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await runtimeFallbackService.getTerms();
      setViews(next);
      setError(null);
      if (timer.current) clearTimeout(timer.current);
      if (next.some((v) => v.status === 'accepting')) timer.current = setTimeout(() => void load(), pollMs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [pollMs]);

  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  const run = async (runtime: string, action: () => Promise<string>): Promise<void> => {
    setBusy((b) => ({ ...b, [runtime]: true }));
    try {
      const note = await action();
      setNotes((n) => ({ ...n, [runtime]: note }));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [runtime]: false }));
      await load();
    }
  };

  const askAgain = (runtime: string): Promise<void> =>
    run(runtime, async () => {
      await runtimeFallbackService.requestTerms(runtime);
      setOpen((o) => ({ ...o, [runtime]: true }));
      return 'A card was also sent to your Slack DM from Crewly Orc. Answer there or here.';
    });

  const check = (runtime: string): Promise<void> =>
    run(runtime, async () => {
      const out = await runtimeFallbackService.probeTerms(runtime);
      if (out.outcome === 'terms') {
        setOpen((o) => ({ ...o, [runtime]: true }));
        return 'It shows its Terms screen. A card was sent to your Slack DM; answer there or here.';
      }
      if (out.outcome === 'ready') return 'It opened straight to its prompt: its Terms are already accepted on this machine.';
      if (out.outcome === 'blocked') return 'It asked for an account sign-in instead. Check its Gemini API key under Sign in.';
      return 'Its first screen could not be recognised.';
    });

  const answer = (runtime: string, choice: TermsChoice): Promise<void> =>
    run(runtime, async () => {
      await runtimeFallbackService.answerTerms(runtime, choice);
      setOpen((o) => ({ ...o, [runtime]: false }));
      return choice === 'decline'
        ? "Not accepted. It is skipped by the fallback order until you change your mind."
        : 'Accepting now. The result and the runtime test are posted in the Slack card thread.';
    });

  if (!views) {
    return error ? (
      <Alert variant="error" size="sm">
        {error}{' '}
        <button type="button" className="underline" onClick={() => void load()}>
          Retry
        </button>
      </Alert>
    ) : null;
  }
  if (views.length === 0) return null;

  return (
    <div className="space-y-3" data-testid="runtime-terms-panel">
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
      {views.map((v) => {
        const status = termsStatus(v);
        const isBusy = Boolean(busy[v.runtime]) || v.status === 'accepting';
        return (
          <div key={v.runtime} className="space-y-2 rounded-lg border border-border-dark p-3" data-testid={`runtime-terms-${v.runtime}`}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="text-sm font-medium text-text-primary-dark">{v.label}</div>
                <div className={`text-xs ${TONE_CLASS[status.tone]}`} data-testid={`runtime-terms-status-${v.runtime}`}>
                  {status.text}
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button type="button" size="sm" variant="ghost" icon={Search} disabled={isBusy} onClick={() => void check(v.runtime)}>
                  Check
                </Button>
                <Button type="button" size="sm" variant="secondary" icon={FileCheck} disabled={isBusy} onClick={() => void askAgain(v.runtime)}>
                  Accept terms…
                </Button>
              </div>
            </div>
            {notes[v.runtime] && <p className="text-xs text-text-secondary-dark">{notes[v.runtime]}</p>}
            {open[v.runtime] && (
              <div className="space-y-2 rounded bg-background-dark p-3 text-xs text-text-secondary-dark" data-testid={`runtime-terms-choices-${v.runtime}`}>
                <p>{v.info.summary}</p>
                <p>
                  {v.info.links.map((l, i) => (
                    <React.Fragment key={l.url}>
                      {i > 0 && ' · '}
                      <a href={l.url} target="_blank" rel="noreferrer" className="text-primary underline">
                        {l.label}
                      </a>
                    </React.Fragment>
                  ))}
                </p>
                <div>
                  <p className="font-medium text-text-primary-dark">A separate item, pre-checked on the screen:</p>
                  <blockquote className="mt-1 border-l-2 border-border-dark pl-2 italic">{v.info.dataItem}</blockquote>
                </div>
                <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                  {v.choices.map((c) => (
                    <Button
                      key={c.choice}
                      type="button"
                      size="sm"
                      variant={c.choice === 'decline' ? 'ghost' : 'secondary'}
                      disabled={isBusy}
                      onClick={() => void answer(v.runtime, c.choice)}
                    >
                      {c.label}
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div>
        <Button type="button" size="sm" variant="ghost" icon={RefreshCw} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
    </div>
  );
};
