/**
 * UsageByModel
 *
 * "By model" on the Usage page: each model (Claude Opus vs Sonnet vs
 * DeepSeek vs Codex/GPT vs Gemini…) with its tokens — input, cached, output —
 * and its estimated API-equivalent cost. Five rows, then "Show all". Usage
 * whose model was not recorded sits under "Unknown model"; a model priced at
 * the default rate is marked "≈".
 *
 * Data: `GET /api/system/usage?groupBy=model`.
 *
 * @module components/Usage/UsageByModel
 */

import React from 'react';
import { ShowAll } from '@crewly/ui';
import { compactTokens, usd, type UsageRow } from '../../services/usage.service';
import { runtimeLabel, shareLabel } from './usage.utils';

/** Props of {@link UsageByModel}. */
export interface UsageByModelProps {
  rows: UsageRow[];
}

/**
 * Quiet line of a model row: family, runtime and the token split.
 *
 * @param r - Model row
 * @returns e.g. "Claude Opus · Claude Code · 12M input (11M cached) · 1M output"
 */
export function modelMeta(r: UsageRow): string {
  const family = typeof r.meta?.family === 'string' && r.meta.family !== 'Unknown' ? r.meta.family : '';
  const runtime = typeof r.meta?.runtime === 'string' ? runtimeLabel(r.meta.runtime) : '';
  return [family, runtime, `${compactTokens(r.input)} input (${compactTokens(r.cachedInput)} cached)`, `${compactTokens(r.output)} output`]
    .filter(Boolean)
    .join(' · ');
}

/**
 * By-model breakdown.
 *
 * @param props - {@link UsageByModelProps}
 * @returns Section
 */
export const UsageByModel: React.FC<UsageByModelProps> = ({ rows }) => (
  <section aria-labelledby="usage-models-heading" className="flex flex-col" data-testid="usage-models">
    <h2 id="usage-models-heading" className="mb-1 text-[13px] font-semibold text-text-2">
      By model
    </h2>
    {rows.length === 0 ? (
      <p className="py-3 text-sm text-text-2">No usage in this period.</p>
    ) : (
      <ShowAll limit={5} data-testid="usage-models-list">
        {rows.map((r) => {
          const defaultRate = r.meta?.rate === 'default';
          return (
            <div key={r.key} className="flex items-center gap-3 border-t border-border-soft py-3" data-testid={`usage-model-${r.key}`}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-text">{r.label}</span>
                <span className="mt-0.5 block truncate text-[13px] text-text-2">{modelMeta(r)}</span>
              </span>
              <span className="text-[13px] text-text-2">{shareLabel(r.share)}</span>
              <span className="w-20 text-right text-[15px] font-semibold tabular-nums text-text">{compactTokens(r.total)}</span>
              <span
                className="w-16 text-right text-[13px] tabular-nums text-text-2"
                title={defaultRate ? 'No price listed for this model: estimated at a default rate' : undefined}
                data-testid={`usage-model-${r.key}-cost`}
              >
                {defaultRate ? '≈' : ''}
                {usd(r.costUsd)}
              </span>
            </div>
          );
        })}
      </ShowAll>
    )}
  </section>
);

export default UsageByModel;
