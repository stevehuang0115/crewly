/**
 * Thread Detail Panel Component
 *
 * Shows all messages for a selected conversation/thread with fixed scroll behavior.
 * Evolved from ChatPanel with corrected scroll-to-bottom using requestAnimationFrame.
 *
 * @module components/Chat/ThreadDetailPanel
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useChat } from '../../contexts/ChatContext';
import { useOrchestratorStatus } from '../../hooks/useOrchestratorStatus';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { TypingIndicator } from './TypingIndicator';
import { QueueStatusBar } from './QueueStatusBar';
import { ChannelBadge } from './ChannelBadge';
import { ChatLoadingState } from './ChatLoadingState';
import { ChatErrorState } from './ChatErrorState';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatOfflineBanner } from './ChatOfflineBanner';
import { ArrowLeft, ChevronDown } from 'lucide-react';
import type { ChatConversation, ChatMessage as ChatMessageType } from '../../types/chat.types';
import './ThreadDetailPanel.css';

// =============================================================================
// Message Filtering
// =============================================================================

/**
 * Terminal artifact patterns that should be hidden from chat display.
 * These are Claude Code / Gemini CLI UI elements that leak into messages.
 */
const TERMINAL_ARTIFACT_PATTERNS = [
  /^[\s⏺❯▸▶►›»─━┄┅┈┉╌╍═│┃┆┇┊┋╎╏║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬╭╮╰╯\s]*$/,
  /bypass permissions on/i,
  /shift\+tab to cycle/i,
  /esc to interrupt/i,
  /^\s*▸▸\s/,
  /\[Thread context file:.*\]/,
];

/**
 * Check if a message is a terminal artifact that should be hidden.
 *
 * @param content - Message content to check
 * @returns True if the content is a terminal UI artifact
 */
function isTerminalArtifact(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return true;
  return TERMINAL_ARTIFACT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Filter messages for chat display:
 * - Only show user and orchestrator messages (hide agent/system)
 * - Hide messages that are purely terminal UI artifacts
 *
 * @param messages - All messages in the conversation
 * @returns Filtered messages suitable for chat display
 */
function filterDisplayMessages(messages: ChatMessageType[]): ChatMessageType[] {
  return messages.filter((msg) => {
    // Only show user and orchestrator messages
    if (msg.from.type !== 'user' && msg.from.type !== 'orchestrator') {
      return false;
    }
    // Hide terminal artifact messages
    if (isTerminalArtifact(msg.content)) {
      return false;
    }
    return true;
  });
}

// =============================================================================
// Types
// =============================================================================

interface ThreadDetailPanelProps {
  /** Currently selected conversation (null = no selection) */
  conversation: ChatConversation | null;
  /** Callback for back button (mobile) */
  onBack?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Thread detail panel showing messages for the selected conversation.
 *
 * Features:
 * - Fixed scroll: uses requestAnimationFrame + scrollIntoView
 * - Scroll-to-bottom floating button when user scrolls up
 * - Channel badge in header
 * - Thread-aware ChatInput placeholder
 *
 * @param props - Component props
 * @returns JSX element with thread detail panel
 */
export const ThreadDetailPanel: React.FC<ThreadDetailPanelProps> = ({
  conversation,
  onBack,
}) => {
  const { messages: rawMessages, isLoading, error, isTyping, hasMoreMessages, isLoadingMore, loadOlderMessages } = useChat();
  const messages = filterDisplayMessages(rawMessages);
  const { status: orchestratorStatus, isLoading: statusLoading } = useOrchestratorStatus();

  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  /**
   * Scroll to the bottom of the messages container.
   * Uses requestAnimationFrame to ensure DOM has painted before scrolling.
   */
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      lastMessageRef.current?.scrollIntoView({ behavior: 'auto' });
    });
  }, []);

  /** Auto-scroll when new messages arrive */
  useEffect(() => {
    scrollToBottom();
  }, [messages, isTyping, scrollToBottom]);

  /** Track scroll position: show/hide scroll-to-bottom + trigger load-more at top */
  const handleScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    setShowScrollButton(distanceFromBottom > 100);

    // Load older messages when scrolled near the top
    if (container.scrollTop < 50 && hasMoreMessages && !isLoadingMore) {
      const prevScrollHeight = container.scrollHeight;
      loadOlderMessages().then(() => {
        // Preserve scroll position after prepending older messages
        requestAnimationFrame(() => {
          const newScrollHeight = container.scrollHeight;
          container.scrollTop = newScrollHeight - prevScrollHeight;
        });
      });
    }
  }, [hasMoreMessages, isLoadingMore, loadOlderMessages]);

  const isOrchestratorOffline =
    !statusLoading && orchestratorStatus && !orchestratorStatus.isActive;
  const channelType = conversation?.channelType ?? 'crewly_chat';

  // No conversation selected
  if (!conversation) {
    return (
      <div className="thread-detail-panel empty" data-testid="thread-detail-empty">
        <div className="thread-detail-empty-state">
          <h3>Select a thread</h3>
          <p>Choose a conversation from the list to view messages.</p>
        </div>
      </div>
    );
  }

  // Loading state
  if (isLoading && messages.length === 0) {
    return (
      <div className="thread-detail-panel loading" data-testid="thread-detail-loading">
        <ChatLoadingState message="Loading messages..." />
      </div>
    );
  }

  // Error state (only show if no messages)
  if (error && messages.length === 0) {
    return (
      <div className="thread-detail-panel error" data-testid="thread-detail-error">
        <ChatErrorState error={error} />
      </div>
    );
  }

  return (
    <div className="thread-detail-panel" data-testid="thread-detail-panel">
      <header className="thread-detail-header">
        {onBack && (
          <button
            className="thread-detail-back"
            onClick={onBack}
            aria-label="Back to thread list"
            data-testid="thread-detail-back"
          >
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="thread-detail-header-info">
          <h2>{conversation.title ?? 'Chat with Orchestrator'}</h2>
          <div className="thread-detail-header-meta">
            <ChannelBadge channelType={channelType} />
          </div>
        </div>
      </header>

      <QueueStatusBar />

      {isOrchestratorOffline && (
        <ChatOfflineBanner
          message={orchestratorStatus?.offlineMessage || orchestratorStatus?.message}
        />
      )}

      <div
        className="messages-container"
        ref={messagesContainerRef}
        onScroll={handleScroll}
        data-testid="messages-container"
      >
        {isLoadingMore && (
          <div className="load-more-spinner" data-testid="load-more-spinner">
            <div className="spinner spinner-sm" />
            <span>Loading older messages...</span>
          </div>
        )}

        {messages.length === 0 ? (
          <ChatEmptyState />
        ) : (
          <>
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
          </>
        )}

        {isTyping && <TypingIndicator />}

        <div ref={lastMessageRef} className="messages-end" />
      </div>

      {showScrollButton && (
        <button
          className="scroll-to-bottom-btn"
          onClick={scrollToBottom}
          aria-label="Scroll to bottom"
          data-testid="scroll-to-bottom"
        >
          <ChevronDown size={16} />
        </button>
      )}

      <ChatInput
        disabled={isOrchestratorOffline}
        disabledPlaceholder="Orchestrator is offline. Start it from the Dashboard to chat."
        placeholder="Reply in thread..."
      />
    </div>
  );
};

export default ThreadDetailPanel;
