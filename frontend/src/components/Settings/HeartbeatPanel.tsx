/**
 * HeartbeatPanel Component
 *
 * Displays agent heartbeat status in a responsive card grid.
 * Shows connection state, working status, last active time, and role
 * for each agent across all teams.
 *
 * @module components/Settings/HeartbeatPanel
 */

import React from 'react';
import { Activity, RefreshCw, AlertCircle, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useAgentHeartbeat } from '../../hooks/useAgentHeartbeat';
import { Button } from '../UI/Button';
import type { AgentHeartbeatInfo } from '../../hooks/useAgentHeartbeat';
import type { TeamMember } from '../../types';

// ========================= Constants =========================

/** Status display configuration for agent connection states */
const STATUS_CONFIG: Record<TeamMember['agentStatus'], { label: string; color: string; bgColor: string }> = {
  active: { label: 'Active', color: 'text-green-400', bgColor: 'bg-green-500/10' },
  started: { label: 'Started', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  starting: { label: 'Starting', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10' },
  activating: { label: 'Activating', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10' },
  inactive: { label: 'Offline', color: 'text-gray-400', bgColor: 'bg-gray-500/10' },
  suspended: { label: 'Suspended', color: 'text-red-400', bgColor: 'bg-red-500/10' },
};

// ========================= Helpers =========================

/**
 * Formats an ISO timestamp to a relative time string for display.
 *
 * @param iso - ISO timestamp string or null
 * @returns Human-readable relative time
 */
function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// ========================= Sub-Components =========================

/**
 * Props for HeartbeatCard
 */
interface HeartbeatCardProps {
  agent: AgentHeartbeatInfo;
}

/**
 * Card displaying a single agent's heartbeat status.
 *
 * Shows agent name, role, team, connection status, working status,
 * and last active time with a color-coded status indicator.
 *
 * @param props - Agent heartbeat info
 * @returns Heartbeat card element
 */
const HeartbeatCard: React.FC<HeartbeatCardProps> = ({ agent }) => {
  const status = STATUS_CONFIG[agent.agentStatus];
  const isOnline = agent.agentStatus === 'active' || agent.agentStatus === 'started';

  return (
    <div className="border border-border-dark rounded-lg p-4 hover:bg-surface-dark/30 transition-colors">
      {/* Header: name + status badge */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full shrink-0 ${isOnline ? 'bg-green-400' : 'bg-gray-500'}`} />
          <span className="text-sm font-medium text-text-primary-dark truncate">{agent.name}</span>
        </div>
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${status.bgColor} ${status.color}`}>
          {status.label}
        </span>
      </div>

      {/* Details grid */}
      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Role</span>
          <span className="text-text-primary-dark capitalize">{agent.role}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Team</span>
          <span className="text-text-primary-dark truncate ml-2">{agent.teamName}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Working</span>
          <span className={agent.workingStatus === 'in_progress' ? 'text-yellow-400' : 'text-text-secondary-dark'}>
            {agent.workingStatus === 'in_progress' ? 'In Progress' : 'Idle'}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-secondary-dark">Runtime</span>
          <span className="text-text-primary-dark">{agent.runtimeType}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-text-secondary-dark">Connection</span>
          {isOnline ? (
            <Wifi className="w-3.5 h-3.5 text-green-400" />
          ) : (
            <WifiOff className="w-3.5 h-3.5 text-gray-500" />
          )}
        </div>
      </div>

      {/* Footer: last active time */}
      <div className="mt-3 pt-3 border-t border-border-dark flex justify-between text-xs">
        <span className="text-text-secondary-dark">Last active</span>
        <span className="text-text-secondary-dark">{formatRelativeTime(agent.lastActivityCheck ?? agent.readyAt)}</span>
      </div>
    </div>
  );
};

// ========================= Main Component =========================

/**
 * Panel displaying all agent heartbeat statuses in a responsive card grid.
 *
 * Shows a loading spinner while fetching, an error alert on failure,
 * and an empty state when no agents are found.
 *
 * @returns HeartbeatPanel component
 */
export const HeartbeatPanel: React.FC = () => {
  const { agents, isLoading, error, refresh } = useAgentHeartbeat();

  const activeCount = agents.filter(a => a.agentStatus === 'active' || a.agentStatus === 'started').length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-text-secondary-dark" />
        <span className="ml-2 text-sm text-text-secondary-dark">Loading heartbeat status...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20">
        <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
        <span className="text-sm text-red-400">{error}</span>
      </div>
    );
  }

  return (
    <div>
      {/* Section Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-text-secondary-dark" />
          <h3 className="text-lg font-semibold text-text-primary-dark">Agent Heartbeat</h3>
          <span className="text-xs text-text-secondary-dark bg-surface-dark px-2 py-0.5 rounded-full">
            {activeCount}/{agents.length} online
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} icon={RefreshCw}>
          Refresh
        </Button>
      </div>

      {agents.length === 0 ? (
        <div className="text-center py-12 text-text-secondary-dark">
          <Activity className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No agents found</p>
          <p className="text-xs mt-1 opacity-60">Agent heartbeats will appear when teams have members configured</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {agents.map((agent) => (
            <HeartbeatCard key={`${agent.teamId}-${agent.memberId}`} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
};

export default HeartbeatPanel;
