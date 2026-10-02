/**
 * Settings › Security
 *
 * Built around approvals and blocks (owner, 2026-10-02): what agents asked
 * you to allow, what Crewly held for you, and how each ended, over the last
 * 7 days (or 30). Real data only, from `GET /api/security/approvals`:
 * decision cards (incl. sensitive publish / email / deploy / spend asks,
 * runtime Terms and spend-cap cards), held browser actions, WhatsApp replies
 * waiting for your go and Gmail sends held now. A count whose source keeps
 * no history says "Not tracked yet" — blocked commands, for one.
 *
 * Below the counts: the recent items as rows (what, which agent, outcome,
 * when), linked to their request or run where there is one. A quiet line
 * at the end keeps the agent isolation check.
 *
 * The former security score, isolation map and data-sovereignty report were
 * dropped (owner, 2026-10-02).
 *
 * @module components/Settings/SecurityTab
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { HelpCircle, RefreshCw } from 'lucide-react';
import { Alert, Button, CompactRow, IconButton, LoadingSpinner, SegmentedControl, ShowAll, StatusLabel, type StatusTone } from '@crewly/ui';
import { useApprovalActivity } from '../../hooks/useApprovalActivity';
import { usePtyStatus } from '../../hooks/usePtyStatus';
import { formatRelativeTimeCompact } from '../../utils/time';
import { LINKS, ROUTES } from '../../constants/routes.constants';
import type { ActivityCategory, ActivityItem, ActivityOutcome, ApprovalActivity } from '../../services/security.service';

/** Status word and tone per outcome. */
export const OUTCOME_LABEL: Record<ActivityOutcome, { label: string; tone: StatusTone }> = {
  approved: { label: 'Approved', tone: 'success' },
  denied: { label: 'Denied', tone: 'neutral' },
  answered: { label: 'Answered', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  waiting: { label: 'Waiting for you', tone: 'attention' },
  sent: { label: 'Sent', tone: 'success' },
  discarded: { label: 'Discarded', tone: 'neutral' },
};

/** What each category is called in a row's meta line. */
export const CATEGORY_LABEL: Record<ActivityCategory, string> = {
  question: 'Question',
  sensitive: 'Sensitive',
  browser: 'Browser action',
  runtime_terms: 'Runtime terms',
  spend_cap: 'Token cap',
  whatsapp: 'WhatsApp reply',
  gmail: 'Email send',
};

/**
 * Where a row links to, if anywhere.
 *
 * @param item - Activity item
 * @returns Path and label, or null
 */
export function itemLink(item: ActivityItem): { to: string; label: string } | null {
  if (item.requestId) return { to: LINKS.request(item.requestId), label: 'Open request' };
  if (item.workItemId) return { to: LINKS.run(item.workItemId), label: 'Open run' };
  if (item.outcome === 'waiting' && item.decisionId) return { to: ROUTES.dashboard, label: 'Answer' };
  return null;
}

/**
 * Meta line of a row.
 *
 * @param item - Activity item
 * @returns e.g. `Nova · Sensitive (publish) · 2h ago · "Yes, publish"`
 */
export function itemMeta(item: ActivityItem): string {
  const kind = item.category === 'sensitive' && item.sensitive ? `Sensitive (${item.sensitive})` : CATEGORY_LABEL[item.category];
  return [item.agent, kind, formatRelativeTimeCompact(item.at), item.answer && `"${item.answer}"`].filter(Boolean).join(' · ');
}

/** One count line. */
const CountRow: React.FC<{ label: string; value: React.ReactNode; help?: string; testId: string }> = ({ label, value, help, testId }) => (
  <div className="flex items-baseline justify-between gap-4 border-b border-border-soft py-3 last:border-b-0" data-testid={testId}>
    <span className="flex items-center gap-1.5 text-[15px] font-semibold text-text">
      {label}
      {help && (
        <span title={help} aria-label={help} className="inline-flex text-text-3">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      )}
    </span>
    <span className="text-right text-[13px] text-text-2">{value}</span>
  </div>
);

/** "Not tracked yet" with the reason as a tooltip. */
const NotTracked: React.FC<{ note?: string }> = ({ note }) => (
  <span title={note} className="text-text-3">
    Not tracked yet
  </span>
);

/**
 * The counts.
 *
 * @param props - Activity
 * @returns Rows
 */
export const ApprovalCounts: React.FC<{ data: ApprovalActivity }> = ({ data }) => {
  const o = data.outcomes;
  const b = data.browser;
  const s = data.sensitive;
  const t = data.runtimeTerms;
  const w = data.whatsapp;
  return (
    <section aria-label="Counts" className="border-y border-border-soft" data-testid="security-counts">
      <CountRow
        label="Actions blocked"
        testId="count-blocked"
        help={`Not recorded anywhere yet: ${data.blocked.sources.join(', ')}.`}
        value={data.blocked.tracked && data.blocked.counts ? data.blocked.counts.total : <NotTracked note={data.blocked.note} />}
      />
      <CountRow label="Approvals asked" testId="count-asked" value={<span className="text-[15px] font-semibold text-text">{data.asked}</span>} />
      <CountRow
        label="Outcomes"
        testId="count-outcomes"
        value={
          <>
            {o.approved} approved · {o.denied} denied{o.answered > 0 ? ` · ${o.answered} answered` : ''} · {o.expired} expired
            {o.withdrawn > 0 ? ` · ${o.withdrawn} withdrawn` : ''} ·{' '}
            <span className={o.waiting > 0 ? 'font-semibold text-attention' : undefined}>{o.waiting} still waiting</span>
          </>
        }
      />
      <CountRow
        label="Browser actions held"
        testId="count-browser"
        help={b.note}
        value={
          b.tracked && b.counts ? (
            `${b.counts.held} held · ${b.counts.approved} approved · ${b.counts.refused} refused${b.counts.expired ? ` · ${b.counts.expired} timed out` : ''}${b.counts.waiting ? ` · ${b.counts.waiting} waiting` : ''}`
          ) : (
            <NotTracked note={b.note} />
          )
        }
      />
      <CountRow
        label="Sensitive decisions"
        testId="count-sensitive"
        value={`${s.total}${s.total > 0 ? ` (publish ${s.publish} · email ${s.email} · deploy ${s.deploy} · spend ${s.spend})` : ''}`}
      />
      <CountRow
        label="Runtime terms consents"
        testId="count-terms"
        value={`${t.asked} asked · ${t.accepted} accepted · ${t.declined} declined${t.waiting ? ` · ${t.waiting} waiting` : ''}`}
      />
      {w.tracked && w.counts && (
        <CountRow
          label="WhatsApp replies held"
          testId="count-whatsapp"
          value={`${w.counts.held} held · ${w.counts.sent} sent · ${w.counts.discarded} discarded${w.counts.waiting ? ` · ${w.counts.waiting} waiting` : ''}`}
        />
      )}
      {(data.gmail.counts?.waiting ?? 0) > 0 && (
        <CountRow label="Emails held for you" testId="count-gmail" help={data.gmail.note} value={`${data.gmail.counts?.waiting} waiting`} />
      )}
    </section>
  );
};

/**
 * Settings › Security panel.
 *
 * @returns Panel
 */
export const SecurityTab: React.FC = () => {
  const [days, setDays] = useState<7 | 30>(7);
  const { data, loading, error, reload } = useApprovalActivity(days);
  const pty = usePtyStatus();

  return (
    <div className="flex max-w-3xl flex-col gap-8" data-testid="security-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-text">Approvals and blocks</h2>
          <p className="text-[13px] text-text-2">What agents asked you to allow, what was held for you, and how it ended.</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl<'7' | '30'>
            aria-label="Window"
            size="sm"
            value={String(days) as '7' | '30'}
            onChange={(v) => setDays(v === '30' ? 30 : 7)}
            options={[
              { value: '7', label: '7 days', 'data-testid': 'security-days-7' },
              { value: '30', label: '30 days', 'data-testid': 'security-days-30' },
            ]}
          />
          <IconButton icon={RefreshCw} aria-label="Refresh" title="Refresh" onClick={() => void reload()} />
        </div>
      </div>

      {error && (
        <Alert variant="error" size="sm">
          {error}{' '}
          <Button variant="link" size="xs" onClick={() => void reload()}>
            Retry
          </Button>
        </Alert>
      )}

      {!data ? (
        loading && <LoadingSpinner centered text="Loading approvals…" />
      ) : (
        <>
          <ApprovalCounts data={data} />

          <section aria-labelledby="security-recent-heading" className="flex flex-col" data-testid="security-recent">
            <h3 id="security-recent-heading" className="mb-1 text-[13px] font-semibold text-text-2">
              Recent
            </h3>
            {data.items.length === 0 ? (
              <p className="py-3 text-sm text-text-2">Nothing was asked or held in the last {data.days} days.</p>
            ) : (
              <ShowAll limit={5} data-testid="security-recent-list" className="border-y border-border-soft">
                {data.items.map((item) => {
                  const o = OUTCOME_LABEL[item.outcome];
                  const link = itemLink(item);
                  return (
                    <CompactRow
                      key={`${item.category}-${item.id}`}
                      data-testid={`security-item-${item.id}`}
                      className="px-0"
                      primary={item.title}
                      meta={itemMeta(item)}
                      trailing={
                        <StatusLabel tone={o.tone} size="sm">
                          {o.label}
                        </StatusLabel>
                      }
                      actions={
                        link
                          ? [
                              <Link key="open" to={link.to} className="text-[13px] font-semibold text-primary-text hover:underline">
                                {link.label}
                              </Link>,
                            ]
                          : undefined
                      }
                    />
                  );
                })}
              </ShowAll>
            )}
          </section>
        </>
      )}

      <p className="border-t border-border-soft pt-4 text-[13px] text-text-2" data-testid="security-isolation">
        Agent isolation:{' '}
        {pty.loading
          ? 'checking…'
          : pty.error
            ? 'could not load the running sessions'
            : `${pty.summary.isolatedCount} of ${pty.summary.totalAgents} agents run in their own session`}
      </p>
    </div>
  );
};

export default SecurityTab;
