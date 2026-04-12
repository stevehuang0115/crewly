/**
 * Thread List Panel Component
 *
 * Displays a scrollable list of conversation threads with channel filtering
 * and a "+ New Chat" button for creating new conversations.
 *
 * @module components/Chat/ThreadListPanel
 */

import React from 'react';
import { Plus } from 'lucide-react';
import type { ChatConversation, ChatChannelType } from '../../types/chat.types';
import { ChannelFilterBar } from './ChannelFilterBar';
import { ThreadPreview } from './ThreadPreview';
import './ThreadListPanel.css';

// =============================================================================
// Types
// =============================================================================

interface ThreadListPanelProps {
  /** All conversations */
  conversations: ChatConversation[];
  /** Currently selected conversation ID */
  selectedConversationId: string | null;
  /** Callback when a thread is selected */
  onSelectThread: (conversationId: string) => void;
  /** Active channel filter */
  channelFilter: ChatChannelType | null;
  /** Callback when channel filter changes */
  onChannelFilterChange: (filter: ChatChannelType | null) => void;
  /** Callback to create a new chat conversation */
  onNewChat?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Panel listing all conversation threads with channel filter bar and new chat button.
 *
 * Conversations are sorted by updatedAt desc. Respects channel filter.
 *
 * @param props - Component props
 * @returns JSX element with thread list panel
 */
export const ThreadListPanel: React.FC<ThreadListPanelProps> = ({
  conversations,
  selectedConversationId,
  onSelectThread,
  channelFilter,
  onChannelFilterChange,
  onNewChat,
}) => {
  /** Apply channel filter */
  const filteredConversations = channelFilter
    ? conversations.filter((c) => (c.channelType ?? 'crewly_chat') === channelFilter)
    : conversations;

  /** Sort by updatedAt desc */
  const sortedConversations = [...filteredConversations].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt)
  );

  return (
    <div className="thread-list-panel" data-testid="thread-list-panel">
      <div className="thread-list-header">
        <ChannelFilterBar
          activeFilter={channelFilter}
          onFilterChange={onChannelFilterChange}
          conversations={conversations}
        />
        {onNewChat && (
          <button
            onClick={onNewChat}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded-lg transition-colors flex-shrink-0"
            data-testid="new-chat-button"
            aria-label="Start a new chat"
          >
            <Plus className="h-4 w-4" />
            New Chat
          </button>
        )}
      </div>

      <div className="thread-list-scroll">
        {sortedConversations.length === 0 ? (
          <div className="thread-list-empty" data-testid="thread-list-empty">
            <p>
              {channelFilter
                ? 'No conversations for this channel.'
                : 'No conversations yet.'}
            </p>
          </div>
        ) : (
          sortedConversations.map((conversation) => (
            <ThreadPreview
              key={conversation.id}
              conversation={conversation}
              isActive={conversation.id === selectedConversationId}
              onClick={() => onSelectThread(conversation.id)}
            />
          ))
        )}
      </div>
    </div>
  );
};

export default ThreadListPanel;
