/**
 * UsageBarList
 *
 * A ranked list of token totals as thin bars ("Top agents", "Teams"): one
 * line per row (name, a quiet sub-label, the total) over a 4px bar scaled to
 * the largest row. The first five rows show, the rest behind "Show all N".
 * Tapping a row shows its input / cached / output split inline (it is the
 * hover text too), so phones get it as well.
 *
 * @module components/Usage/UsageBarList
 */

import React, { useState } from 'react';
import { ShowAll } from '@crewly/ui';
import { compactTokens, usd } from '../../services/usage.service';
import { barWidth } from './usage.utils';

/** One bar. */
export interface UsageBar {
  key: string;
  name: string;
  /** Quiet text after the name (team, runtime, cap) */
  sub?: string;
  /** Attention text after the name ("Stopped until midnight") */
  alert?: string;
  total: number;
  /** Hover text: the input / cached / output split */
  detail?: string;
  /** Estimated API-equivalent cost (USD); shown beside the tokens when given */
  cost?: number;
}

/** Props of {@link UsageBarList}. */
export interface UsageBarListProps {
  title: string;
  rows: UsageBar[];
  /** Shown when there are no rows */
  emptyText?: string;
  /** Rows before "Show all" (default 5) */
  limit?: number;
  /** Prefix of the row test ids */
  testIdPrefix: string;
}

/**
 * Ranked bars.
 *
 * @param props - {@link UsageBarListProps}
 * @returns Section
 */
export const UsageBarList: React.FC<UsageBarListProps> = ({ title, rows, emptyText = 'No usage in this period.', limit = 5, testIdPrefix }) => {
  const max = rows.reduce((m, r) => Math.max(m, r.total), 0);
  const [open, setOpen] = useState<string | null>(null);
  const headingId = `${testIdPrefix}-heading`;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col" data-testid={testIdPrefix}>
      <h2 id={headingId} className="mb-1 text-[13px] font-semibold text-text-2">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-text-2">{emptyText}</p>
      ) : (
        <ShowAll limit={limit} data-testid={`${testIdPrefix}-list`}>
          {rows.map((r) => (
            <div key={r.key} className="flex flex-col py-3" title={r.detail} data-testid={`${testIdPrefix}-${r.key}`}>
              <button
                type="button"
                className="flex w-full flex-col gap-2 text-left disabled:cursor-default"
                disabled={!r.detail}
                aria-expanded={r.detail ? open === r.key : undefined}
                aria-controls={r.detail ? `${testIdPrefix}-${r.key}-split` : undefined}
                onClick={() => setOpen((cur) => (cur === r.key ? null : r.key))}
              >
                <span className="flex w-full min-w-0 items-baseline gap-2">
                  <span className="truncate text-[15px] font-semibold text-text">{r.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-2">
                    {r.alert && <span className="font-semibold text-attention">{r.alert}</span>}
                    {r.alert && r.sub ? ' · ' : ''}
                    {r.sub}
                  </span>
                  <span className="text-[15px] font-semibold tabular-nums text-text">{compactTokens(r.total)}</span>
                  {r.cost !== undefined && (
                    <span className="w-16 text-right text-[13px] tabular-nums text-text-2" data-testid={`${testIdPrefix}-${r.key}-cost`}>
                      {usd(r.cost)}
                    </span>
                  )}
                </span>
                <span className="block h-1 w-full rounded-full bg-surface-2" aria-hidden="true">
                  <span className="block h-1 rounded-full bg-text-3" style={{ width: barWidth(r.total, max) }} />
                </span>
              </button>
              {r.detail && open === r.key && (
                <p id={`${testIdPrefix}-${r.key}-split`} className="mt-2 text-[13px] text-text-2" data-testid={`${testIdPrefix}-${r.key}-split`}>
                  {r.detail}
                </p>
              )}
            </div>
          ))}
        </ShowAll>
      )}
    </section>
  );
};

export default UsageBarList;
