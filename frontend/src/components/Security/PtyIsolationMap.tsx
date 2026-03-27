/**
 * PTY Isolation Map — Live visualization of agent PTY isolation
 *
 * Shows each running agent session as a node with PTY info, demonstrating
 * that every agent runs in its own isolated PTY with no lateral access.
 * Per spec section 3.3.
 *
 * @module components/Security/PtyIsolationMap
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Monitor, X as XIcon } from 'lucide-react';
import type { PtySessionInfo } from '../../hooks/usePtyStatus';
import { Card } from '../UI/Card';
import { StatusDot } from '../UI/StatusDot';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import type { DotStatus } from '../UI/StatusDot';

/** Props for PtyIsolationMap */
export interface PtyIsolationMapProps {
  /** List of PTY session entries */
  sessions: PtySessionInfo[];
  /** Whether data is still loading */
  loading: boolean;
}

/** Agent border colors — primary blue variants for consistency */
const AGENT_COLORS = [
  'border-primary',
  'border-primary/80',
  'border-primary/60',
  'border-primary/50',
  'border-primary/40',
];

/**
 * Formats uptime seconds into a human-readable string.
 *
 * @param seconds - Uptime in seconds, or null if unavailable
 * @returns Formatted string like "2h14m" or "N/A"
 */
function formatUptime(seconds: number | null): string {
  if (seconds === null) return 'N/A';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

/**
 * Formats bytes into a human-readable string.
 *
 * @param bytes - Memory usage in bytes, or null if unavailable
 * @returns Formatted string like "128MB" or "N/A"
 */
function formatMemory(bytes: number | null): string {
  if (bytes === null) return 'N/A';
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

/**
 * Renders the live PTY isolation map showing each agent session
 * as an isolated node with PTY details and blocked cross-access indicators.
 *
 * @param props - PtyIsolationMapProps
 * @returns PTY isolation map element
 */
export const PtyIsolationMap: React.FC<PtyIsolationMapProps> = ({ sessions, loading }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);

  const toggleExpand = () => setIsExpanded((prev) => !prev);

  const handleSessionClick = (sessionName: string) => {
    setExpandedSession((prev) => (prev === sessionName ? null : sessionName));
  };

  const handleSessionKeyDown = (e: React.KeyboardEvent, sessionName: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSessionClick(sessionName);
    }
  };

  return (
    <Card padding="none" aria-labelledby="pty-map-heading" role="region">
      {/* Header */}
      <button
        type="button"
        onClick={toggleExpand}
        className="flex items-center justify-between w-full px-6 py-4 text-left"
        aria-expanded={isExpanded}
        aria-controls="pty-map-content"
      >
        <h2 id="pty-map-heading" className="text-lg font-semibold text-text-primary-dark flex items-center gap-2">
          <Monitor size={20} aria-hidden="true" className="text-primary" />
          PTY Isolation Map
        </h2>
        {isExpanded ? (
          <ChevronUp size={20} className="text-text-secondary-dark" aria-hidden="true" />
        ) : (
          <ChevronDown size={20} className="text-text-secondary-dark" aria-hidden="true" />
        )}
      </button>

      {/* Content */}
      {isExpanded && (
        <div id="pty-map-content" className="px-6 pb-6">
          {loading ? (
            <LoadingSpinner size="sm" text="Loading PTY sessions..." />
          ) : sessions.length === 0 ? (
            <div className="text-text-secondary-dark text-sm py-4">No active agent sessions</div>
          ) : (
            <div
              role="img"
              aria-label={`PTY isolation map showing ${sessions.length} isolated agent sessions with no lateral access between them`}
            >
              {sessions.map((session, index) => (
                <div key={session.sessionName}>
                  {/* Agent Node */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSessionClick(session.sessionName)}
                    onKeyDown={(e) => handleSessionKeyDown(e, session.sessionName)}
                    className={`flex items-start gap-4 p-4 rounded-lg border-l-4 bg-zinc-900/50 cursor-pointer hover:bg-zinc-800/50 transition-colors ${AGENT_COLORS[index % AGENT_COLORS.length]}`}
                    aria-expanded={expandedSession === session.sessionName}
                    data-testid={`pty-node-${session.sessionName}`}
                  >
                    {/* Agent Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-text-primary-dark text-sm">
                          {session.agentName}
                        </span>
                        <span className="text-xs text-text-secondary-dark">({session.role})</span>
                        <span className="inline-flex items-center gap-1 text-xs">
                          <StatusDot
                            status={session.agentStatus === 'active' ? 'active' : 'inactive'}
                            size="sm"
                          />
                          <span className={session.agentStatus === 'active' ? 'text-emerald-400' : 'text-text-secondary-dark'}>
                            {session.agentStatus === 'active' ? 'Active' : session.agentStatus}
                          </span>
                        </span>
                      </div>
                      <div className="text-xs text-text-secondary-dark">
                        working: {session.workingStatus}
                      </div>
                    </div>

                    {/* PTY Details */}
                    <div className="text-xs text-text-secondary-dark font-mono space-y-0.5 text-right flex-shrink-0">
                      <div>PTY pid:{session.ptyPid ?? 'N/A'}</div>
                      <div>mem: {formatMemory(session.memoryUsage)}</div>
                      <div>uptime: {formatUptime(session.uptimeSeconds)}</div>
                    </div>

                    {/* Scope Details */}
                    <div className="text-xs text-text-secondary-dark font-mono space-y-0.5 text-right flex-shrink-0">
                      <div>fs: {session.fsScope}</div>
                      <div>net: {session.netScope}</div>
                    </div>
                  </div>

                  {/* Expanded session details */}
                  {expandedSession === session.sessionName && (
                    <div className="ml-4 p-3 bg-zinc-900/30 rounded-b-lg border-l border-border-dark text-xs text-text-secondary-dark font-mono">
                      <div>Session: {session.sessionName}</div>
                      <div>Process ID: {session.ptyPid ?? 'Not available'}</div>
                      <div>Memory: {formatMemory(session.memoryUsage)}</div>
                      <div>Filesystem: {session.fsScope} (sandboxed)</div>
                      <div>Network: {session.netScope} only</div>
                    </div>
                  )}

                  {/* Cross-access blocked indicator */}
                  {index < sessions.length - 1 && (
                    <div className="flex items-center gap-2 py-2 pl-6" aria-hidden="true">
                      <div className="w-px h-4 bg-border-dark" />
                      <XIcon size={12} className="text-red-400" />
                      <span className="text-xs text-text-secondary-dark">(no lateral access)</span>
                    </div>
                  )}
                </div>
              ))}

              {/* Legend */}
              <div className="flex items-center gap-4 mt-4 pt-3 border-t border-border-dark text-xs text-text-secondary-dark">
                <span className="flex items-center gap-1">
                  <StatusDot status="active" size="sm" />
                  Active
                </span>
                <span className="flex items-center gap-1">
                  <StatusDot status="inactive" size="sm" />
                  Inactive
                </span>
                <span className="flex items-center gap-1">
                  <XIcon size={10} className="text-red-400" aria-hidden="true" />
                  No cross-session access
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};

PtyIsolationMap.displayName = 'PtyIsolationMap';
