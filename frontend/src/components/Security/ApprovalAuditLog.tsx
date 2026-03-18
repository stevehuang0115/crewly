/**
 * Approval Audit Log — Time-ordered feed of tool approval events
 *
 * Displays approval events with risk badges, filter controls, and CSV export.
 * Per spec section 3.4.
 *
 * @module components/Security/ApprovalAuditLog
 */

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronUp,
  FileCheck,
  Download,
  Filter,
} from 'lucide-react';
import type { ApprovalEvent, ApprovalOutcome, ApprovalLogFilter } from '../../hooks/useApprovalLog';

/** Props for ApprovalAuditLog */
export interface ApprovalAuditLogProps {
  /** List of filtered approval events */
  events: ApprovalEvent[];
  /** Current filter */
  filter: ApprovalLogFilter;
  /** Update filter callback */
  onFilterChange: (filter: ApprovalLogFilter) => void;
  /** Whether data is still loading */
  loading: boolean;
}

/** Badge config per outcome type */
const OUTCOME_BADGES: Record<ApprovalOutcome, { label: string; className: string; icon: string }> = {
  auto: { label: 'Auto', className: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', icon: '✅' },
  approved: { label: 'Approved', className: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30', icon: '✅' },
  denied: { label: 'Denied', className: 'bg-red-500/10 text-red-400 border-red-500/20', icon: '🔴' },
  sop_block: { label: 'SOP Block', className: 'bg-amber-500/10 text-amber-400 border-amber-500/20', icon: '⚠️' },
};

/** Number of events to show initially */
const INITIAL_DISPLAY_COUNT = 10;

/**
 * Formats an ISO timestamp to a time string (HH:MM:SS).
 *
 * @param isoString - ISO timestamp
 * @returns Formatted time string
 */
function formatTime(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Exports approval events as a CSV download.
 *
 * @param events - Events to export
 */
function exportCsv(events: ApprovalEvent[]): void {
  const headers = ['Timestamp', 'Agent', 'Tool/Command', 'Outcome', 'Risk Level', 'Reason'];
  const rows = events.map((e) => [
    e.timestamp,
    e.agentName,
    e.toolName,
    e.outcome,
    e.riskLevel,
    e.reason || '',
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.map((c) => `"${c}"`).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `approval-audit-${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Renders the approval audit log with time-ordered events, risk badges,
 * filter controls, and CSV export.
 *
 * @param props - ApprovalAuditLogProps
 * @returns Approval audit log element
 */
export const ApprovalAuditLog: React.FC<ApprovalAuditLogProps> = ({
  events,
  filter,
  onFilterChange,
  loading,
}) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [displayCount, setDisplayCount] = useState(INITIAL_DISPLAY_COUNT);

  const displayedEvents = useMemo(
    () => events.slice(0, displayCount),
    [events, displayCount]
  );

  const uniqueAgents = useMemo(
    () => Array.from(new Set(events.map((e) => e.agentName))),
    [events]
  );

  const toggleExpand = () => setIsExpanded((prev) => !prev);

  const handleFilterAgent = (agent: string | undefined) => {
    onFilterChange({ ...filter, agent });
    setShowFilterMenu(false);
  };

  const handleFilterOutcome = (outcome: ApprovalOutcome | undefined) => {
    onFilterChange({ ...filter, outcome });
    setShowFilterMenu(false);
  };

  const handleExport = () => {
    exportCsv(events);
  };

  const handleLoadMore = () => {
    setDisplayCount((prev) => prev + INITIAL_DISPLAY_COUNT);
  };

  return (
    <section aria-labelledby="audit-log-heading" className="border border-border-dark rounded-lg bg-surface-dark">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <button
          type="button"
          onClick={toggleExpand}
          className="flex items-center gap-2 text-left flex-1"
          aria-expanded={isExpanded}
          aria-controls="audit-log-content"
        >
          <h2 id="audit-log-heading" className="text-lg font-semibold text-text-primary-dark flex items-center gap-2">
            <FileCheck size={20} aria-hidden="true" className="text-emerald-400" />
            Approval Audit Log
          </h2>
          {isExpanded ? (
            <ChevronUp size={20} className="text-text-secondary-dark" aria-hidden="true" />
          ) : (
            <ChevronDown size={20} className="text-text-secondary-dark" aria-hidden="true" />
          )}
        </button>

        {isExpanded && (
          <div className="flex items-center gap-2">
            {/* Filter Button */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowFilterMenu((prev) => !prev)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary-dark border border-border-dark rounded-md hover:bg-zinc-800 transition-colors"
                aria-label="Filter events"
                data-testid="filter-button"
              >
                <Filter size={14} aria-hidden="true" />
                Filter
                {(filter.agent || filter.outcome) && (
                  <span className="ml-1 w-1.5 h-1.5 rounded-full bg-primary" aria-label="Filter active" />
                )}
              </button>

              {/* Filter Dropdown */}
              {showFilterMenu && (
                <div
                  className="absolute right-0 top-full mt-1 w-48 bg-zinc-800 border border-border-dark rounded-md shadow-lg z-10"
                  role="menu"
                  data-testid="filter-menu"
                >
                  <div className="p-2">
                    <div className="text-xs font-semibold text-text-secondary-dark mb-1 px-2">By Agent</div>
                    <button
                      type="button"
                      onClick={() => handleFilterAgent(undefined)}
                      className="w-full text-left px-2 py-1 text-xs text-text-primary-dark hover:bg-zinc-700 rounded"
                      role="menuitem"
                    >
                      All Agents
                    </button>
                    {uniqueAgents.map((agent) => (
                      <button
                        key={agent}
                        type="button"
                        onClick={() => handleFilterAgent(agent)}
                        className={`w-full text-left px-2 py-1 text-xs hover:bg-zinc-700 rounded ${
                          filter.agent === agent ? 'text-primary' : 'text-text-primary-dark'
                        }`}
                        role="menuitem"
                      >
                        {agent}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-border-dark p-2">
                    <div className="text-xs font-semibold text-text-secondary-dark mb-1 px-2">By Outcome</div>
                    <button
                      type="button"
                      onClick={() => handleFilterOutcome(undefined)}
                      className="w-full text-left px-2 py-1 text-xs text-text-primary-dark hover:bg-zinc-700 rounded"
                      role="menuitem"
                    >
                      All Outcomes
                    </button>
                    {(Object.keys(OUTCOME_BADGES) as ApprovalOutcome[]).map((outcome) => (
                      <button
                        key={outcome}
                        type="button"
                        onClick={() => handleFilterOutcome(outcome)}
                        className={`w-full text-left px-2 py-1 text-xs hover:bg-zinc-700 rounded ${
                          filter.outcome === outcome ? 'text-primary' : 'text-text-primary-dark'
                        }`}
                        role="menuitem"
                      >
                        {OUTCOME_BADGES[outcome].icon} {OUTCOME_BADGES[outcome].label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Export Button */}
            <button
              type="button"
              onClick={handleExport}
              className="flex items-center gap-1 px-3 py-1.5 text-xs text-text-secondary-dark border border-border-dark rounded-md hover:bg-zinc-800 transition-colors"
              aria-label="Export as CSV"
              data-testid="export-button"
            >
              <Download size={14} aria-hidden="true" />
              Export
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      {isExpanded && (
        <div id="audit-log-content" className="px-6 pb-6">
          {loading ? (
            <div className="text-text-secondary-dark text-sm py-4" role="status">Loading audit events...</div>
          ) : events.length === 0 ? (
            <div className="text-text-secondary-dark text-sm py-4">No approval events recorded</div>
          ) : (
            <>
              {/* Events Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm" role="table">
                  <thead>
                    <tr className="border-b border-border-dark">
                      <th scope="col" className="text-left py-2 pr-4 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">Time</th>
                      <th scope="col" className="text-left py-2 pr-4 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">Agent</th>
                      <th scope="col" className="text-left py-2 pr-4 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">Tool / Command</th>
                      <th scope="col" className="text-right py-2 text-xs font-medium text-text-secondary-dark uppercase tracking-wide">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedEvents.map((event) => {
                      const badge = OUTCOME_BADGES[event.outcome];
                      return (
                        <tr
                          key={event.id}
                          className="border-b border-border-dark/50 hover:bg-zinc-800/30 transition-colors"
                          data-testid={`audit-row-${event.id}`}
                        >
                          <td className="py-2.5 pr-4 font-mono text-xs text-text-secondary-dark whitespace-nowrap">
                            {formatTime(event.timestamp)}
                          </td>
                          <td className="py-2.5 pr-4 text-text-primary-dark whitespace-nowrap">
                            {event.agentName}
                          </td>
                          <td className="py-2.5 pr-4 font-mono text-xs text-text-secondary-dark">
                            {event.toolName}
                            {event.reason && (
                              <span className="block text-xs text-zinc-500 mt-0.5" title={event.reason}>
                                {event.reason}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 text-right">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${badge.className}`}
                            >
                              <span aria-hidden="true">{badge.icon}</span>
                              {badge.label}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Load More */}
              {events.length > displayCount && (
                <div className="mt-3 text-center">
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    className="text-xs text-primary hover:text-primary/80 transition-colors"
                    data-testid="load-more-button"
                  >
                    Showing {displayCount} of {events.length} events — Load more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
};

ApprovalAuditLog.displayName = 'ApprovalAuditLog';
