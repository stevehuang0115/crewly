/**
 * Security Overview Page
 *
 * In-app security overview at /security route showing PTY isolation status,
 * approval audit log, and data sovereignty report. Per spec section 3.
 *
 * @module pages/SecurityOverview
 */

import React from 'react';
import { Shield, Monitor, HardDrive, FileCheck } from 'lucide-react';
import { usePtyStatus } from '../hooks/usePtyStatus';
import { useApprovalLog } from '../hooks/useApprovalLog';
import { useDataSovereignty, formatBytes } from '../hooks/useDataSovereignty';
import { PtyIsolationMap } from '../components/Security/PtyIsolationMap';
import { ApprovalAuditLog } from '../components/Security/ApprovalAuditLog';
import { DataSovereigntyReport } from '../components/Security/DataSovereigntyReport';

/** Status indicator colors */
const STATUS_COLORS: Record<string, string> = {
  healthy: 'text-emerald-400',
  secure: 'text-emerald-400',
  enforced: 'text-emerald-400',
  warning: 'text-amber-400',
  partial: 'text-amber-400',
  error: 'text-red-400',
  disabled: 'text-red-400',
  compromised: 'text-red-400',
};

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
 * Security Overview page component.
 *
 * Provides a security posture view with:
 * - 3 summary cards (PTY Status, Storage, Approvals)
 * - Live PTY Isolation Map
 * - Approval Audit Log with filtering and export
 * - Data Sovereignty Report
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
          <h1 className="text-2xl font-bold text-text-primary-dark">Security Overview</h1>
          <p className="text-sm text-text-secondary-dark">
            Your instance security posture at a glance
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="summary-cards">
        {/* PTY Status Card */}
        <div className="border border-border-dark rounded-lg bg-surface-dark p-6" data-testid="card-pty">
          <div className="flex items-center gap-2 mb-3">
            <Monitor size={18} className="text-blue-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-primary-dark">PTY Status</h3>
          </div>
          {ptyLoading ? (
            <div className="text-text-secondary-dark text-sm" role="status">Loading...</div>
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-text-secondary-dark">
                {ptySummary.totalAgents} agents
              </div>
              <div className="text-text-secondary-dark">
                {ptySummary.isolatedCount} isolated
              </div>
              <div className="text-text-secondary-dark">
                {ptySummary.sharedCount} shared
              </div>
              <div className={`text-xs font-medium uppercase tracking-wide mt-2 flex items-center gap-1 ${STATUS_COLORS[ptySummary.status]}`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${ptySummary.status === 'healthy' ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" />
                {STATUS_LABELS[ptySummary.status]}
              </div>
            </div>
          )}
        </div>

        {/* Storage Card */}
        <div className="border border-border-dark rounded-lg bg-surface-dark p-6" data-testid="card-storage">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive size={18} className="text-purple-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-primary-dark">Storage</h3>
          </div>
          {storageLoading ? (
            <div className="text-text-secondary-dark text-sm" role="status">Loading...</div>
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-text-secondary-dark">Local DB</div>
              <div className="text-text-secondary-dark">
                {formatBytes(storageSummary.totalLocalBytes)}
              </div>
              <div className="text-text-secondary-dark">
                {storageSummary.externalConnections} cloud
              </div>
              <div className={`text-xs font-medium uppercase tracking-wide mt-2 flex items-center gap-1 ${STATUS_COLORS[storageSummary.status]}`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${storageSummary.status === 'secure' ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" />
                {STATUS_LABELS[storageSummary.status]}
              </div>
            </div>
          )}
        </div>

        {/* Approvals Card */}
        <div className="border border-border-dark rounded-lg bg-surface-dark p-6" data-testid="card-approvals">
          <div className="flex items-center gap-2 mb-3">
            <FileCheck size={18} className="text-emerald-400" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-text-primary-dark">Approvals</h3>
          </div>
          {approvalLoading ? (
            <div className="text-text-secondary-dark text-sm" role="status">Loading...</div>
          ) : (
            <div className="space-y-1 text-sm">
              <div className="text-text-secondary-dark">
                {approvalSummary.totalToday} today
              </div>
              <div className="text-text-secondary-dark">
                {approvalSummary.deniedToday} denied
              </div>
              <div className="text-text-secondary-dark">
                {approvalSummary.bypassedToday} bypassed
              </div>
              <div className={`text-xs font-medium uppercase tracking-wide mt-2 flex items-center gap-1 ${STATUS_COLORS[approvalSummary.status]}`}>
                <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${approvalSummary.status === 'enforced' ? 'bg-emerald-400' : 'bg-amber-400'}`} aria-hidden="true" />
                {STATUS_LABELS[approvalSummary.status]}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Live PTY Isolation Map */}
      <PtyIsolationMap sessions={sessions} loading={ptyLoading} />

      {/* Approval Audit Log */}
      <ApprovalAuditLog
        events={filteredEvents}
        filter={filter}
        onFilterChange={setFilter}
        loading={approvalLoading}
      />

      {/* Data Sovereignty Report */}
      <DataSovereigntyReport
        entries={storageEntries}
        summary={storageSummary}
        loading={storageLoading}
      />
    </div>
  );
};

SecurityOverview.displayName = 'SecurityOverview';
