/**
 * MatchReportBlock — sidebar block for the 4-tier Match Report.
 *
 * **W1**: empty-state shell + types only — full implementation lands
 * W3 with B7 (the deterministic match algorithm) and F3 (the inline
 * chat card). The populated variant renders the four tiers as
 * collapsible sections with workflow chips. We render a minimal
 * populated body now so stories can demo the block once Sam's mock
 * fixture lands; full styling happens W3.
 *
 * Spec ref: §5.3 Match Report UX, §12.2 row F2/F3.
 *
 * @module components/Onboarding/v2-5/blocks/MatchReportBlock
 */

import type { ReactNode } from 'react';
import type {
  HirableWorkflow,
  MatchReport,
  OutOfScopeEntry,
  RoadmapEntry,
} from '../../../../types/onboarding-blueprint.types';
import { BlueprintBlock } from './BlueprintBlock';

export interface MatchReportBlockProps {
  /** Match Report payload, or `undefined` for empty state. */
  report?: MatchReport;
}

/**
 * Render the Match Report sidebar block.
 *
 * @param report - 4-tier classification. When `undefined`, renders
 *   the empty-state placeholder.
 *
 * @example
 * ```tsx
 * <MatchReportBlock report={blueprint.matchReport} />
 * ```
 */
export function MatchReportBlock({
  report,
}: MatchReportBlockProps): ReactNode {
  const isPopulated = report != null && hasAnyTier(report);
  return (
    <BlueprintBlock
      blockId="match-report"
      title="Match Report"
      isPopulated={isPopulated}
      emptyHint="We'll show your 4-tier Match Report once you tell us what you want help with."
    >
      {isPopulated ? <FilledBody report={report!} /> : null}
    </BlueprintBlock>
  );
}

function hasAnyTier(r: MatchReport): boolean {
  return (
    r.autonomous.length +
      r.collaborative.length +
      r.roadmap.length +
      r.outOfScope.length >
    0
  );
}

interface FilledBodyProps {
  report: MatchReport;
}

/**
 * Minimal populated layout for W1. W3 will replace this with the
 * polished design once Mia's hi-fi lands.
 */
function FilledBody({ report }: FilledBodyProps): ReactNode {
  return (
    <div
      data-testid="match-report-filled"
      className="flex flex-col gap-3 text-sm"
    >
      <Tier
        testId="match-report-autonomous"
        emoji="✅"
        label="Autonomous"
        items={report.autonomous}
      />
      <Tier
        testId="match-report-collaborative"
        emoji="🤝"
        label="Collaborative"
        items={report.collaborative}
      />
      <RoadmapTier items={report.roadmap} />
      <OutOfScopeTier items={report.outOfScope} />
    </div>
  );
}

interface TierProps {
  testId: string;
  emoji: string;
  label: string;
  items: HirableWorkflow[];
}

function Tier({ testId, emoji, label, items }: TierProps): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-700">
        <span aria-hidden="true">{emoji}</span> {label}
      </div>
      <ul className="ml-1 mt-1 list-disc space-y-1 pl-4">
        {items.map((w) => (
          <li key={w.workflowId} data-testid={`${testId}-${w.workflowId}`}>
            {w.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RoadmapTier({ items }: { items: RoadmapEntry[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-testid="match-report-roadmap">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-700">
        <span aria-hidden="true">⏳</span> Roadmap
      </div>
      <ul className="ml-1 mt-1 list-disc space-y-1 pl-4">
        {items.map((entry, i) => (
          <li
            key={`${entry.workflow}-${i}`}
            data-testid={`match-report-roadmap-${i}`}
          >
            {entry.workflow}
            {entry.eta ? <span className="text-gray-500"> · {entry.eta}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OutOfScopeTier({ items }: { items: OutOfScopeEntry[] }): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-testid="match-report-out-of-scope">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-700">
        <span aria-hidden="true">❌</span> Out of Scope
      </div>
      <ul className="ml-1 mt-1 list-disc space-y-1 pl-4">
        {items.map((entry, i) => (
          <li
            key={`${entry.task}-${i}`}
            data-testid={`match-report-out-of-scope-${i}`}
          >
            {entry.task}
            {entry.workaround ? (
              <span className="text-gray-500"> · workaround: {entry.workaround}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default MatchReportBlock;
