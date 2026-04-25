/**
 * AgentStatusBadge — coloured dot + label for an agent's presence.
 *
 * Shared component used in both ChannelList rows and the thread header.
 * Accepts either an explicit status (for rendering offline rows without
 * hitting the API) or an agentId (+ optional channelId) and resolves
 * presence itself via `useAgentPresence`.
 *
 * @module components/AgentStatusBadge
 */

import type { AgentPresenceStatus } from '../types/chat.types';
import { useAgentPresence } from '../hooks/useAgentPresence';

export interface AgentStatusBadgeProps {
  /**
   * Explicit status. When supplied, the component renders it directly
   * without subscribing. Useful for the sidebar where `useChannels`
   * already supplies denormalized presence.
   */
  status?: AgentPresenceStatus;
  /** Resolve presence via API when `status` is not provided. */
  agentId?: string;
  /** Subscribe to a specific channel's WS for live updates. */
  channelId?: string;
  /** Hide the text label and render dot-only. */
  compact?: boolean;
  className?: string;
}

const STATUS_TEXT: Record<AgentPresenceStatus, string> = {
  online: 'Online',
  busy: 'Busy',
  offline: 'Offline',
};

const STATUS_DOT: Record<AgentPresenceStatus, string> = {
  online: 'bg-emerald-500',
  busy: 'bg-amber-400',
  offline: 'bg-slate-400',
};

const STATUS_TEXT_COLOR: Record<AgentPresenceStatus, string> = {
  online: 'text-emerald-600',
  busy: 'text-amber-600',
  offline: 'text-slate-500',
};

export function AgentStatusBadge({
  status,
  agentId,
  channelId,
  compact = false,
  className = '',
}: AgentStatusBadgeProps): JSX.Element {
  const resolved = useResolvedStatus({ status, agentId, channelId });

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      data-testid="agent-status-badge"
      data-status={resolved}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[resolved]}`}
      />
      {!compact && (
        <span className={`text-xs font-medium ${STATUS_TEXT_COLOR[resolved]}`}>
          {STATUS_TEXT[resolved]}
        </span>
      )}
      <span className="sr-only">{STATUS_TEXT[resolved]}</span>
    </span>
  );
}

/**
 * Resolve the status prop once. Calling `useAgentPresence` with a null
 * id is a no-op path inside the hook, so it's safe to always call it
 * (satisfies the Rules of Hooks).
 */
function useResolvedStatus(args: {
  status?: AgentPresenceStatus;
  agentId?: string;
  channelId?: string;
}): AgentPresenceStatus {
  const live = useAgentPresence(args.status ? null : args.agentId ?? null, args.channelId ?? null);
  return args.status ?? live.status;
}
