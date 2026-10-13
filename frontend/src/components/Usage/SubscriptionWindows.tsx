/**
 * SubscriptionWindows
 *
 * "Subscription windows" on the Usage page: what the Claude plan has spent
 * inside the rolling windows Anthropic bills, counted from every Claude Code
 * session on this machine — the owner's own included, which never enter the
 * ledger yet draw on the same subscription.
 *
 * The section deliberately shows **tokens spent, not quota left**. Anthropic
 * publishes no figure for the remaining allowance of a Pro/Max plan, so a
 * percentage would be invented. The one real percentage comes from a refusal,
 * which is shown separately as a fact with its own timestamp.
 *
 * Data: `GET /api/system/usage/claude-window`.
 *
 * @module components/Usage/SubscriptionWindows
 */

import React from 'react';
import { AlertTriangle, Clock } from 'lucide-react';
import { compactTokens, type ClaudeLimitEvent, type ClaudeWindowReport, type ClaudeWindowUsage } from '../../services/usage.service';

/** Props of {@link SubscriptionWindows}. */
export interface SubscriptionWindowsProps {
  report: ClaudeWindowReport | null;
  /** Clock, injected by tests */
  now?: () => Date;
}

/** Help text under the heading. */
export const WINDOW_HELP =
  'Tokens spent inside the windows your Claude plan is billed against, from every Claude Code session on this machine — including your own, which the ledger never counts. Cache reads are left out: they are most of the raw tokens and a fraction of the cost.';

/**
 * How long until a moment, in words.
 *
 * @param iso - Target time
 * @param now - Current time
 * @returns e.g. "in 2h 10m", "now"
 *
 * @example
 * ```ts
 * untilLabel('2026-10-12T12:00:00Z', new Date('2026-10-12T10:30:00Z')); // 'in 1h 30m'
 * ```
 */
export function untilLabel(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `in ${hours}h ${minutes % 60}m` : `in ${minutes}m`;
}

/**
 * Quiet line under a window's tokens.
 *
 * @param window - One window
 * @returns e.g. "73 turns · 146 input · 48K output · 733K cache writes"
 */
export function windowMeta(window: ClaudeWindowUsage): string {
  return [
    `${window.turns} ${window.turns === 1 ? 'turn' : 'turns'}`,
    `${compactTokens(window.input)} input`,
    `${compactTokens(window.output)} output`,
    `${compactTokens(window.cacheWrite)} cache writes`,
    `${compactTokens(window.cachedInput)} cache reads (not counted)`,
  ].join(' · ');
}

/**
 * The sentence describing the last time Anthropic refused a request.
 *
 * @param limit - The refusal
 * @param now - Current time
 * @returns A sentence, or null when the plan has never been refused here
 */
export function limitSentence(limit: ClaudeLimitEvent | null, now: Date): string | null {
  if (!limit) return null;

  const when = new Date(limit.at).toLocaleString();
  const window = limit.rateLimitType ? limit.rateLimitType.replace(/_/g, '-') : 'rate';
  // A reset already in the past says nothing useful — and "reset now" reads
  // like the window is reopening this second when it reopened last night.
  const pending = limit.resetsAt !== null && new Date(limit.resetsAt).getTime() > now.getTime();
  const reset = pending ? `, reset ${untilLabel(limit.resetsAt as string, now)}` : '';
  const used = limit.utilization['5h'] ?? limit.utilization.five_hour;
  const utilisation = typeof used === 'number' ? ` at ${Math.round(used * 100)}% of the window` : '';

  return `Last refused ${when} on the ${window} limit${utilisation}${reset}.`;
}

/**
 * Subscription window section.
 *
 * @param props - {@link SubscriptionWindowsProps}
 * @returns Section, or nothing while the report is still loading
 */
export const SubscriptionWindows: React.FC<SubscriptionWindowsProps> = ({ report, now = () => new Date() }) => {
  if (!report) return null;

  const at = now();
  const limit = limitSentence(report.lastLimit, at);

  return (
    <section className="space-y-3" aria-labelledby="subscription-windows-heading">
      <div>
        <h2 id="subscription-windows-heading" className="text-sm font-medium">
          Subscription windows
        </h2>
        <p className="text-xs text-muted-foreground">{WINDOW_HELP}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {report.windows.map((window) => (
          <div key={window.id} className="rounded-lg border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-muted-foreground">{window.label}</span>
              <span className="text-lg font-semibold tabular-nums">{compactTokens(window.billable)}</span>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{windowMeta(window)}</p>
            {window.partial && (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3 shrink-0" />
                At least this much: a transcript was too large to read in full.
              </p>
            )}
          </div>
        ))}
      </div>

      {limit && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5 shrink-0" />
          {limit}
          {report.estimatedFiveHourCapacity !== null &&
            ` That put the 5-hour window at roughly ${compactTokens(report.estimatedFiveHourCapacity)} tokens.`}
        </p>
      )}
    </section>
  );
};
