/**
 * AgentStatusBadge — coloured dot + label for an agent's presence.
 *
 * Shared component used in both ChannelList rows and the thread header.
 * Accepts either an explicit status (for rendering offline rows without
 * hitting the API) or an agentId (+ optional channelId) and resolves
 * presence itself via `useAgentPresence`.
 *
 * Vocabulary (per Slack-like Team Chat design §8.1, sealed 2026-04-25):
 *  - **Crewly-native** (canonical, used by /api/chat presence stream):
 *    `online | busy | offline`
 *  - **Team-chat normalized** (used by Slack-like surfaces): `online |
 *    idle | inactive`
 *
 * Both vocabularies are accepted on the `status` prop. Internally they
 * collapse to a single resolved status used for dot/text rendering. This
 * keeps the existing ChannelList + thread-header usage intact while the
 * new WorkspaceRail / ConversationListPanel surfaces can pass the
 * Slack-style values directly without translation at the call site.
 *
 * @module components/AgentStatusBadge
 */

import type { AgentPresenceStatus } from '../types/chat.types';
import { useAgentPresence } from '../hooks/useAgentPresence';

/**
 * Public-facing presence vocabulary for the Slack-like surfaces. Wider
 * than `AgentPresenceStatus` (which is the wire-protocol type backed by
 * the chat API) — exists so design tokens can use the team-chat words
 * (`idle`, `inactive`) without forcing the wire types to grow.
 */
export type ChatPresenceStatus =
  | AgentPresenceStatus
  | 'idle'
  | 'inactive';

export interface AgentStatusBadgeProps {
  /**
   * Explicit status. Accepts both the wire vocabulary (`online | busy |
   * offline`) and the Slack-like team-chat vocabulary (`online | idle |
   * inactive`). When supplied, the component renders it directly without
   * subscribing.
   */
  status?: ChatPresenceStatus;
  /** Resolve presence via API when `status` is not provided. */
  agentId?: string;
  /** Subscribe to a specific channel's WS for live updates. */
  channelId?: string;
  /** Hide the text label and render dot-only. */
  compact?: boolean;
  className?: string;
}

/**
 * Canonical resolved status used for rendering. The visual treatment is
 * keyed off this short list so we never branch UI off two parallel
 * vocabularies. The mapping below is the single source of truth.
 */
type ResolvedStatus = 'online' | 'busy' | 'idle' | 'offline' | 'inactive';

/**
 * Map any accepted input to the canonical resolved status. New aliases
 * collapse to existing visual treatments where the meaning matches.
 */
const RESOLVE: Record<ChatPresenceStatus, ResolvedStatus> = {
  online: 'online',
  busy: 'busy',
  idle: 'idle',
  offline: 'offline',
  inactive: 'inactive',
};

const STATUS_TEXT: Record<ResolvedStatus, string> = {
  online: 'Online',
  busy: 'Busy',
  idle: 'Idle',
  offline: 'Offline',
  inactive: 'Inactive',
};

const STATUS_DOT: Record<ResolvedStatus, string> = {
  online: 'bg-emerald-400',
  busy: 'bg-amber-400',
  idle: 'bg-amber-400',
  offline: 'bg-gray-500',
  inactive: 'bg-gray-500',
};

const STATUS_TEXT_COLOR: Record<ResolvedStatus, string> = {
  online: 'text-emerald-400',
  busy: 'text-amber-400',
  idle: 'text-amber-400',
  offline: 'text-text-secondary-dark',
  inactive: 'text-text-secondary-dark',
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
 * (satisfies the Rules of Hooks). The output is collapsed via `RESOLVE`
 * so explicit Slack-style aliases produce the same canonical key as the
 * wire-vocabulary live status.
 */
function useResolvedStatus(args: {
  status?: ChatPresenceStatus;
  agentId?: string;
  channelId?: string;
}): ResolvedStatus {
  const live = useAgentPresence(args.status ? null : args.agentId ?? null, args.channelId ?? null);
  const raw: ChatPresenceStatus = args.status ?? live.status;
  return RESOLVE[raw];
}
