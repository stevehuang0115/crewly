/**
 * UsageBarList
 *
 * A ranked list of token totals as thin bars ("Top agents", "Teams"): one
 * line per row (name, a quiet sub-label, the total) over a 4px bar scaled to
 * the largest row. The first five rows show, the rest behind "Show all N".
 *
 * @module components/Usage/UsageBarList
 */

import React from 'react';
import { ShowAll } from '@crewly/ui';
import { compactTokens } from '../../services/usage.service';
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
            <div key={r.key} className="flex flex-col gap-2 py-3" title={r.detail} data-testid={`${testIdPrefix}-${r.key}`}>
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[15px] font-semibold text-text">{r.name}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-2">
                  {r.alert && <span className="font-semibold text-attention">{r.alert}</span>}
                  {r.alert && r.sub ? ' · ' : ''}
                  {r.sub}
                </span>
                <span className="text-[15px] font-semibold tabular-nums text-text">{compactTokens(r.total)}</span>
              </div>
              <div className="h-1 rounded-full bg-surface-2" aria-hidden="true">
                <div className="h-1 rounded-full bg-text-3" style={{ width: barWidth(r.total, max) }} />
              </div>
            </div>
          ))}
        </ShowAll>
      )}
    </section>
  );
};

export default UsageBarList;
