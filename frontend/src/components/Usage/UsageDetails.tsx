/**
 * UsageDetails
 *
 * The collapsed "Details" of the Usage page: tokens by runtime (with cached
 * input), the period's input / cached / output split, and the work items
 * that used the most tokens, each linked to its run.
 *
 * @module components/Usage/UsageDetails
 */

import React from "react";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { ShowAll } from "@crewly/ui";
import { compactTokens, usd, type UsageStats } from "../../services/usage.service";
import { LINKS } from "../../constants/routes.constants";
import { runtimeLabel, shareLabel, workItemLink } from "./usage.utils";

/** Props of {@link UsageDetails}. */
export interface UsageDetailsProps {
  stats: UsageStats;
  /** Controlled open state */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Runtime and work-item breakdowns.
 *
 * @param props - {@link UsageDetailsProps}
 * @returns Collapsible section
 */
export const UsageDetails: React.FC<UsageDetailsProps> = ({
  stats,
  open,
  onOpenChange,
}) => {
  const runtimes = stats.groups.runtime ?? [];
  const work = stats.groups.workItem ?? [];
  return (
    <section
      className="flex flex-col border-t border-border-soft"
      data-testid="usage-details"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="usage-details-body"
        onClick={() => onOpenChange(!open)}
        className="flex min-w-0 items-center gap-2.5 py-4 text-left text-text"
      >
        <span className="text-[15px] font-semibold">Details</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-2">
          By runtime and by work item
        </span>
        {open ? (
          <ChevronDown
            className="h-4 w-4 shrink-0 text-text-2"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="h-4 w-4 shrink-0 text-text-2"
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div id="usage-details-body" className="flex flex-col gap-6 pb-5">
          <p className="text-[13px] text-text-2" data-testid="usage-split">
            {compactTokens(stats.totals.input)} input (
            {compactTokens(stats.totals.cachedInput)} cached) ·{" "}
            {compactTokens(stats.totals.output)} output ·{" "}
            {stats.totals.events.toLocaleString("en-US")} turns. Tokens = input
            (cached included) + output, from every runtime; subscription and API
            use count the same.
          </p>
          <section className="flex flex-col" data-testid="usage-runtimes">
            <h3 className="mb-1 text-[13px] font-semibold text-text-2">
              By runtime
            </h3>
            {runtimes.length === 0 && (
              <p className="py-2 text-sm text-text-2">
                No usage in this period.
              </p>
            )}
            {runtimes.map((r) => (
              <div
                key={r.key}
                className="flex items-baseline gap-2 border-t border-border-soft py-3"
                data-testid={`usage-runtime-${r.key}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-text">
                    {runtimeLabel(r.key)}
                  </span>
                  <span className="block text-[13px] text-text-2">
                    {compactTokens(r.cachedInput)} cached input
                  </span>
                </span>
                <span className="text-[13px] text-text-2">
                  {shareLabel(r.share)}
                </span>
                <span className="w-20 text-right text-[15px] font-semibold tabular-nums text-text">
                  {compactTokens(r.total)}
                </span>
                {r.costUsd !== undefined && (
                  <span className="w-16 text-right text-[13px] tabular-nums text-text-2">{usd(r.costUsd)}</span>
                )}
              </div>
            ))}
          </section>
          <section className="flex flex-col" data-testid="usage-workitems">
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <h3 className="text-[13px] font-semibold text-text-2">
                By work item
              </h3>
              <Link
                to={LINKS.runs()}
                className="text-[13px] font-semibold text-primary-text hover:underline"
              >
                All runs
              </Link>
            </div>
            {work.length === 0 && (
              <p className="py-2 text-sm text-text-2">
                No work item usage in this period.
              </p>
            )}
            <ShowAll limit={5} data-testid="usage-workitems-list">
              {work.map((w) => {
                const to = workItemLink(w);
                const who = [w.meta?.agent, w.meta?.team, w.meta?.status]
                  .filter((x): x is string => typeof x === "string")
                  .join(" · ");
                const body = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[15px] font-semibold text-text"
                        title={w.label}
                      >
                        {w.label}
                      </span>
                      {who && (
                        <span className="mt-0.5 block truncate text-[13px] text-text-2">
                          {who}
                        </span>
                      )}
                    </span>
                    <span className="text-[15px] font-semibold tabular-nums text-text">
                      {compactTokens(w.total)}
                    </span>
                    {w.costUsd !== undefined && (
                      <span className="w-16 text-right text-[13px] tabular-nums text-text-2">{usd(w.costUsd)}</span>
                    )}
                  </>
                );
                return to ? (
                  <Link
                    key={w.key}
                    to={to}
                    aria-label={w.label}
                    className="flex items-center gap-4 border-t border-border-soft py-3 hover:bg-surface-hover"
                    data-testid={`usage-workitem-${w.key}`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div
                    key={w.key}
                    className="flex items-center gap-4 border-t border-border-soft py-3"
                    data-testid={`usage-workitem-${w.key}`}
                  >
                    {body}
                  </div>
                );
              })}
            </ShowAll>
            <p className="mt-2 text-xs text-text-3">
              A work item counts its agent&apos;s tokens while it was open, so
              items that overlap in time show the same total.
            </p>
          </section>
        </div>
      )}
    </section>
  );
};

export default UsageDetails;
