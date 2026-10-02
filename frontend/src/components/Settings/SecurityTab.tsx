/**
 * Settings › Security
 *
 * The former `/security` page (SecurityOverview) as a Settings panel, at the
 * simplified density (specs/2026-10-02-ui-redesign.md). Three checks, one
 * row each, then the agent isolation map behind a click.
 *
 * Only agent isolation reports real data (`GET /api/monitoring/pty-status`).
 * The approval audit log and the storage report used to fall back to sample
 * rows because `GET /api/approvals/audit` and `GET /api/system/storage`
 * don't exist; they now say "Not connected yet", and there is no overall
 * score until they do.
 *
 * @module components/Settings/SecurityTab
 */

import React from 'react';
import { FileCheck, HardDrive, Monitor } from 'lucide-react';
import { CollapsibleSection, CompactRow, StatusLabel } from '@crewly/ui';
import type { StatusTone } from '@crewly/ui';
import { usePtyStatus, type PtySummary } from '../../hooks/usePtyStatus';
import { PtyIsolationMap } from '../Security/PtyIsolationMap';

/** Status word and tone of the isolation check. */
const ISOLATION_STATUS: Record<PtySummary['status'], { label: string; tone: StatusTone }> = {
  healthy: { label: 'Healthy', tone: 'success' },
  warning: { label: 'Warning', tone: 'attention' },
  error: { label: 'Error', tone: 'danger' },
};

/** Quiet "not connected" label for checks with no backend endpoint. */
const NotConnected: React.FC<{ testId: string }> = ({ testId }) => (
  <StatusLabel tone="neutral" size="sm" data-testid={testId}>
    Not connected yet
  </StatusLabel>
);

/**
 * Settings › Security panel.
 *
 * @returns Panel
 */
export const SecurityTab: React.FC = () => {
  const { sessions, summary, loading, error } = usePtyStatus();
  const status = ISOLATION_STATUS[summary.status];
  const isolationLine = loading ? 'Checking…' : `${summary.isolatedCount} of ${summary.totalAgents} agents isolated`;

  return (
    <div className="max-w-3xl space-y-8" data-testid="security-tab">
      <p className="text-[13px] text-text-2" data-testid="security-score-note">
        No overall score yet: only agent isolation reports real data. Tool approvals and data storage are not connected.
      </p>

      <section aria-label="Security checks" className="border-y border-border-soft" data-testid="summary-cards">
        <CompactRow
          data-testid="card-pty"
          leading={<Monitor className="h-4 w-4 text-text-2" aria-hidden="true" />}
          primary="Agent isolation"
          meta={error ? 'Could not load the running sessions' : isolationLine}
          trailing={
            loading ? undefined : (
              <StatusLabel tone={error ? 'danger' : status.tone} size="sm" data-testid="isolation-status">
                {error ? 'Error' : status.label}
              </StatusLabel>
            )
          }
        />
        <CompactRow
          data-testid="card-approvals"
          leading={<FileCheck className="h-4 w-4 text-text-2" aria-hidden="true" />}
          primary="Tool approvals"
          meta="What agents asked to run, approved or denied today"
          trailing={<NotConnected testId="approvals-not-connected" />}
        />
        <CompactRow
          data-testid="card-storage"
          leading={<HardDrive className="h-4 w-4 text-text-2" aria-hidden="true" />}
          primary="Data storage"
          meta="Local storage size and cloud connections"
          trailing={<NotConnected testId="storage-not-connected" />}
        />
      </section>

      <CollapsibleSection title="Agent isolation map" summary="Live from running sessions: PTY, uptime, memory, access" unmountWhenClosed data-testid="isolation-map-section">
        <PtyIsolationMap sessions={sessions} loading={loading} />
      </CollapsibleSection>

      <CollapsibleSection title="Approval audit log and storage report" summary="Not connected yet" data-testid="security-not-connected-section">
        <div className="space-y-3 text-[13px] text-text-2">
          <p>
            <span className="font-semibold text-text">Approval audit log.</span> Every tool or command an agent asked to run (time, agent, command, reason for a
            denial, outcome), with a filter by agent and outcome. Waits for an approvals audit endpoint, which doesn&apos;t exist yet.
          </p>
          <p>
            <span className="font-semibold text-text">Data sovereignty report.</span> Where Crewly keeps data on this machine (memory, knowledge, sessions, teams,
            projects), its size, and whether any of it leaves. Waits for a storage endpoint, which doesn&apos;t exist yet.
          </p>
        </div>
      </CollapsibleSection>
    </div>
  );
};

export default SecurityTab;
