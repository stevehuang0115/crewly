/**
 * ChannelList — sidebar of agent-bound channels for the current user.
 *
 * Shared package component: lives once here, imported by OSS frontend
 * and Portal.
 *
 * Behavior:
 *  - Calls `useChannels()` to load; shows loading + error states
 *  - Highlights the active channel
 *  - Renders `AgentStatusBadge` per row
 *
 * Styling uses Tailwind utility classes. Consumer apps must include
 * this package in their tailwind `content` glob — see package
 * integration notes (Week 2).
 *
 * @module components/ChannelList
 */

import type { Channel } from '../types/chat.types';
import { useChannels } from '../hooks/useChannels';
import { AgentStatusBadge } from './AgentStatusBadge';

export interface ChannelListProps {
  activeChannelId?: string | null;
  onSelectChannel?(channel: Channel): void;
  className?: string;
}

export function ChannelList({
  activeChannelId = null,
  onSelectChannel,
  className = '',
}: ChannelListProps): JSX.Element {
  const { channels, loading, error, refresh } = useChannels();

  return (
    <aside
      className={`flex h-full w-64 flex-col border-r border-border-dark bg-surface-dark ${className}`}
      aria-label="Channel list"
    >
      <div className="flex items-center justify-between border-b border-border-dark px-4 py-3">
        <h2 className="text-sm font-semibold text-text-primary-dark">Channels</h2>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-xs text-text-secondary-dark hover:text-text-primary-dark"
        >
          Refresh
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && <ChannelListSkeleton />}
        {error && <ChannelListError onRetry={() => void refresh()} message={error.message} />}
        {!loading && !error && channels.length === 0 && <ChannelListEmpty />}
        {!loading && !error && channels.length > 0 && (
          <ul role="list" className="divide-y divide-border-dark">
            {channels.map((channel) => (
              <li key={channel.id}>
                <button
                  type="button"
                  onClick={() => onSelectChannel?.(channel)}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-background-dark ${
                    activeChannelId === channel.id
                      ? 'bg-primary/10'
                      : ''
                  }`}
                >
                  <div className="flex-1 overflow-hidden">
                    <div className="truncate text-sm font-medium text-text-primary-dark">
                      {channel.name}
                    </div>
                    {channel.purpose && (
                      <div className="truncate text-xs text-text-secondary-dark">
                        {channel.purpose}
                      </div>
                    )}
                  </div>
                  <AgentStatusBadge
                    status={channel.presence}
                    agentId={channel.agentSession}
                    channelId={channel.id}
                    compact
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

function ChannelListSkeleton(): JSX.Element {
  return (
    <div className="p-4 text-sm text-text-secondary-dark" role="status" aria-live="polite">
      Loading channels…
    </div>
  );
}

function ChannelListEmpty(): JSX.Element {
  return (
    <div className="p-4 text-sm text-text-secondary-dark">
      No channels yet. Bind an agent to start a conversation.
    </div>
  );
}

function ChannelListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="p-4 text-sm text-red-400" role="alert">
      <div className="mb-2">Failed to load channels: {message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="text-xs underline hover:no-underline"
      >
        Retry
      </button>
    </div>
  );
}
