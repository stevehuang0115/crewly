/**
 * HeartbeatPanel Component
 *
 * Agent heartbeat in Settings › System: one quiet row per agent (online
 * first, five shown, the rest behind "Show all"), with its status word,
 * role, team, runtime, whether it is working and when it was last active.
 *
 * @module components/Settings/HeartbeatPanel
 */

import React from 'react';
import { Activity, RefreshCw, AlertCircle } from 'lucide-react';
import { formatRelativeTimeCompact } from '../../utils/time';
import { useAgentHeartbeat } from '../../hooks/useAgentHeartbeat';
import { Button } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { ShowAll } from '@crewly/ui/ShowAll';
import { StatusLabel, type StatusTone } from '@crewly/ui/StatusLabel';
import type { AgentHeartbeatInfo } from '../../hooks/useAgentHeartbeat';
import type { TeamMember } from '../../types';

// ========================= Constants =========================

/** Status word and tone per agent connection state. */
const STATUS_CONFIG: Record<TeamMember['agentStatus'], { label: string; tone: StatusTone }> = {
  active: { label: 'Active', tone: 'success' },
  started: { label: 'Started', tone: 'success' },
  starting: { label: 'Starting', tone: 'attention' },
  activating: { label: 'Activating', tone: 'attention' },
  inactive: { label: 'Offline', tone: 'neutral' },
  suspended: { label: 'Suspended', tone: 'neutral' },
};

// ========================= Helpers =========================

/**
 * Wrapper for HeartbeatPanel: returns "Never" for null, otherwise compact relative time.
 *
 * @param iso - ISO timestamp string or null
 * @returns Human-readable relative time
 */
function formatHeartbeatTime(iso: string | null): string {
  if (!iso) return 'Never';
  return formatRelativeTimeCompact(iso);
}

/**
 * Whether an agent is connected.
 *
 * @param agent - Heartbeat info
 * @returns True when active or started
 */
function isOnline(agent: AgentHeartbeatInfo): boolean {
  return agent.agentStatus === 'active' || agent.agentStatus === 'started';
}

// ========================= Sub-Components =========================

/**
 * One agent's heartbeat as a row.
 *
 * @param props - Agent heartbeat info
 * @returns Row
 */
const HeartbeatRow: React.FC<{ agent: AgentHeartbeatInfo }> = ({ agent }) => {
  const status = STATUS_CONFIG[agent.agentStatus];
  const working = agent.workingStatus === 'in_progress';
  return (
    <div className="flex items-center gap-3 border-b border-border-soft py-3 last:border-b-0" data-testid={`heartbeat-row-${agent.memberId}`}>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold text-text">{agent.name}</div>
        <div className="truncate text-[13px] text-text-2">
          <span className="capitalize">{agent.role}</span> · <span>{agent.teamName}</span> · <span>{agent.runtimeType}</span> ·{' '}
          <span className={working ? 'text-attention' : undefined}>{working ? 'In Progress' : 'Idle'}</span> · last active{' '}
          <span>{formatHeartbeatTime(agent.lastActivityCheck ?? agent.readyAt)}</span>
        </div>
      </div>
      <StatusLabel tone={status.tone} size="sm" title={isOnline(agent) ? 'Connected' : 'Not connected'}>
        {status.label}
      </StatusLabel>
    </div>
  );
};

// ========================= Main Component =========================

/**
 * Agent heartbeat list, online agents first.
 *
 * @returns HeartbeatPanel component
 */
export const HeartbeatPanel: React.FC = () => {
  const { agents, isLoading, error, refresh } = useAgentHeartbeat();

  const activeCount = agents.filter(isOnline).length;
  const ordered = [...agents.filter(isOnline), ...agents.filter((a) => !isOnline(a))];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadingSpinner size="sm" text="Loading heartbeat status..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-danger-soft p-4" role="alert">
        <AlertCircle className="h-5 w-5 shrink-0 text-danger" />
        <span className="text-sm text-danger">{error}</span>
      </div>
    );
  }

  return (
    <section aria-labelledby="heartbeat-heading">
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="heartbeat-heading" className="text-[15px] font-semibold text-text">
            Agent Heartbeat
          </h2>
          <p className="text-[13px] text-text-2">
            <span>{activeCount}/{agents.length} online</span> · online first
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={refresh} icon={RefreshCw}>
          Refresh
        </Button>
      </div>

      {agents.length === 0 ? (
        <div className="py-12 text-center text-text-2">
          <Activity className="mx-auto mb-3 h-10 w-10 opacity-40" />
          <p className="text-sm">No agents found</p>
          <p className="mt-1 text-xs text-text-3">Agent heartbeats will appear when teams have members configured</p>
        </div>
      ) : (
        <ShowAll limit={5} data-testid="heartbeat-list">
          {ordered.map((agent) => (
            <HeartbeatRow key={`${agent.teamId}-${agent.memberId}`} agent={agent} />
          ))}
        </ShowAll>
      )}
    </section>
  );
};

export default HeartbeatPanel;
