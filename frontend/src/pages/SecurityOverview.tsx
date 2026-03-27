/**
 * Security Overview Page
 *
 * User-focused security posture dashboard. Shows the security score
 * and key metrics at a glance, with expandable detail sections for
 * power users who need deeper visibility.
 *
 * @module pages/SecurityOverview
 */

import React, { useState } from 'react';
import { Shield, Monitor, HardDrive, FileCheck, ChevronDown, ChevronRight } from 'lucide-react';
import { usePtyStatus } from '../hooks/usePtyStatus';
import { useApprovalLog } from '../hooks/useApprovalLog';
import { useDataSovereignty, formatBytes } from '../hooks/useDataSovereignty';
import { PtyIsolationMap } from '../components/Security/PtyIsolationMap';
import { ApprovalAuditLog } from '../components/Security/ApprovalAuditLog';
import { DataSovereigntyReport } from '../components/Security/DataSovereigntyReport';
import { SecurityScoreWidget } from '../components/Security/SecurityScoreWidget';
import { Card } from '../components/UI/Card';
import { StatusDot } from '../components/UI/StatusDot';
import { LoadingSpinner } from '../components/UI/LoadingSpinner';
import type { DotStatus } from '../components/UI/StatusDot';

/** Status indicator labels */
const STATUS_LABELS: Record<string, string> = {
  healthy: 'HEALTHY',
  secure: 'SECURE',
  enforced: 'ENFORCED',
  warning: 'WARNING',
  partial: 'PARTIAL',
  error: 'ERROR',
  disabled: 'DISABLED',
  compromised: 'COMPROMISED',
};

/**
 * Maps security-specific status strings to StatusDot DotStatus values.
 *
 * @param status - Security status string from hooks
 * @returns A DotStatus suitable for StatusDot
 */
function toDotStatus(status: string): DotStatus {
  switch (status) {
    case 'healthy':
    case 'secure':
    case 'enforced':
      return 'active';
    case 'warning':
    case 'partial':
      return 'waiting';
    case 'error':
    case 'disabled':
    case 'compromised':
      return 'error';
    default:
      return 'inactive';
  }
}

// =============================================================================
// Collapsible Section
// =============================================================================

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

/**
 * Collapsible detail section to keep the page clean by default.
 */
const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  icon,
  children,
  defaultOpen = false,
}) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-border-dark rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-4 py-3 bg-surface-dark hover:bg-surface-dark/80 transition-colors text-left"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        {icon}
        <span className="text-sm font-semibold text-text-primary-dark flex-1">{title}</span>
        {isOpen ? (
          <ChevronDown size={16} className="text-text-secondary-dark" />
        ) : (
          <ChevronRight size={16} className="text-text-secondary-dark" />
        )}
      </button>
      {isOpen && <div className="p-4 border-t border-border-dark">{children}</div>}
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

/**
 * Security Overview page component.
 *
 * Provides a clean security posture view with:
 * - Security Score Widget (always visible)
 * - 3 summary cards: PTY, Storage, Approvals (always visible)
 * - Expandable detail sections for advanced inspection
 *
 * @returns Security overview page element
 */
export const SecurityOverview: React.FC = () => {
  const { sessions, summary: ptySummary, loading: ptyLoading } = usePtyStatus();
  const {
    filteredEvents,
    summary: approvalSummary,
    filter,
    setFilter,
    loading: approvalLoading,
  } = useApprovalLog();
  const {
    entries: storageEntries,
    summary: storageSummary,
    loading: storageLoading,
  } = useDataSovereignty();

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Page Header */}
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-emerald-400" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-bold text-text-primary-dark">Security</h1>
          <p className="text-sm text-text-secondary-dark">
            Your instance security posture at a glance
          </p>
        </div>
      </div>

      {/* Security Score Widget */}
      <SecurityScoreWidget
        data={{
          ptyStatus: ptySummary.status,
          ptyTotalAgents: ptySummary.totalAgents,
          ptyIsolatedCount: ptySummary.isolatedCount,
          approvalStatus: approvalSummary.status,
          approvalsDeniedToday: approvalSummary.deniedToday,
          approvalsBypassedToday: approvalSummary.bypassedToday,
          storageStatus: storageSummary.status,
        }}
        loading={ptyLoading || approvalLoading || storageLoading}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="summary-cards">
        {/* PTY Status Card */}
        <Card padding="lg" data-testid="card-pty">
          <div className="flex items-center gap-2 mb-3">
            <Monitor size={18} className="text-blue-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-primary-dark">Agent Isolation</h3>
          </div>
          {ptyLoading ? (
            <LoadingSpinner size="sm" />
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-text-secondary-dark">
                {ptySummary.isolatedCount} of {ptySummary.totalAgents} agents isolated
              </div>
              <div className="text-xs font-medium uppercase tracking-wide mt-2 flex items-center gap-1.5">
                <StatusDot status={toDotStatus(ptySummary.status)} size="sm" />
                <span>{STATUS_LABELS[ptySummary.status]}</span>
              </div>
            </div>
          )}
        </Card>

        {/* Storage Card */}
        <Card padding="lg" data-testid="card-storage">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive size={18} className="text-purple-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-primary-dark">Data Storage</h3>
          </div>
          {storageLoading ? (
            <LoadingSpinner size="sm" />
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-text-secondary-dark">
                {formatBytes(storageSummary.totalLocalBytes)} stored locally
              </div>
              <div className="text-text-secondary-dark">
                {storageSummary.externalConnections} cloud connection{storageSummary.externalConnections !== 1 ? 's' : ''}
              </div>
              <div className="text-xs font-medium uppercase tracking-wide mt-2 flex items-center gap-1.5">
                <StatusDot status={toDotStatus(storageSummary.status)} size="sm" />
                <span>{STATUS_LABELS[storageSummary.status]}</span>
              </div>
            </div>
          )}
        </Card>

        {/* Approvals Card */}
        <Card padding="lg" data-testid="card-approvals">
          <div className="flex items-center gap-2 mb-3">
            <FileCheck size={18} className="text-emerald-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-primary-dark">Tool Approvals</h3>
          </div>
          {approvalLoading ? (
            <LoadingSpinner size="sm" />
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-text-secondary-dark">
                {approvalSummary.totalToday} reviewed today
              </div>
              {approvalSummary.deniedToday > 0 && (
                <div className="text-amber-400 text-xs">
                  {approvalSummary.deniedToday} denied
                </div>
              )}
              <div className="text-xs font-medium uppercase tracking-wide mt-2 flex items-center gap-1.5">
                <StatusDot status={toDotStatus(approvalSummary.status)} size="sm" />
                <span>{STATUS_LABELS[approvalSummary.status]}</span>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Expandable Detail Sections */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-text-secondary-dark uppercase tracking-wide">
          Detailed Reports
        </h3>

        <CollapsibleSection
          title="Agent Isolation Map"
          icon={<Monitor size={16} className="text-blue-400" />}
        >
          <PtyIsolationMap sessions={sessions} loading={ptyLoading} />
        </CollapsibleSection>

        <CollapsibleSection
          title="Approval Audit Log"
          icon={<FileCheck size={16} className="text-emerald-400" />}
        >
          <ApprovalAuditLog
            events={filteredEvents}
            filter={filter}
            onFilterChange={setFilter}
            loading={approvalLoading}
          />
        </CollapsibleSection>

        <CollapsibleSection
          title="Data Sovereignty Report"
          icon={<HardDrive size={16} className="text-purple-400" />}
        >
          <DataSovereigntyReport
            entries={storageEntries}
            summary={storageSummary}
            loading={storageLoading}
          />
        </CollapsibleSection>
      </div>
    </div>
  );
};

SecurityOverview.displayName = 'SecurityOverview';
