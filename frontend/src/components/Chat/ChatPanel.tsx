/**
 * Chat Panel Component
 *
 * Main chat panel displaying conversation messages and input.
 *
 * @module components/Chat/ChatPanel
 */

import React, { useRef, useEffect } from 'react';
import { useChat } from '../../contexts/ChatContext';
import { useOrchestratorStatus } from '../../hooks/useOrchestratorStatus';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { TypingIndicator } from './TypingIndicator';
import { QueueStatusBar } from './QueueStatusBar';
import { ChatLoadingState } from './ChatLoadingState';
import { ChatErrorState } from './ChatErrorState';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatOfflineBanner } from './ChatOfflineBanner';
import { maskSensitiveData } from '../../utils/security';
import './ChatPanel.css';

// =============================================================================
// Component
// =============================================================================

/**
 * Main chat panel component displaying conversation messages.
 *
 * Features:
 * - Auto-scroll to new messages
 * - Loading and error states
 * - Empty state with suggestions
 * - Typing indicator
 *
 * @returns JSX element with chat panel
 */
export const ChatPanel: React.FC = () => {
  const { messages, isLoading, error, isTyping, currentConversation } = useChat();
  const { status: orchestratorStatus, isLoading: statusLoading } = useOrchestratorStatus();

  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  // Loading state
  if (isLoading && messages.length === 0) {
    return (
      <div className="chat-panel loading" data-testid="chat-panel-loading">
        <ChatLoadingState message="Loading conversation..." />
      </div>
    );
  }

  // Error state (only show if no messages)
  if (error && messages.length === 0) {
    return (
      <div className="chat-panel error" data-testid="chat-panel-error">
        <ChatErrorState error={error} />
      </div>
    );
  }

  // Determine if orchestrator is offline
  const isOrchestratorOffline = !statusLoading && orchestratorStatus && !orchestratorStatus.isActive;

  return (
    <div className="chat-panel" data-testid="chat-panel">
      <header className="chat-header">
        <h2>{maskSensitiveData(currentConversation?.title ?? 'Chat with Orchestrator')}</h2>
        <span className="message-count">
          {messages.length} {messages.length === 1 ? 'message' : 'messages'}
        </span>
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
        data-testid="messages-container"
      >
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

        <div className="messages-end" />
      </div>

      <ChatInput
        disabled={isOrchestratorOffline}
        disabledPlaceholder="Orchestrator is offline. Start it from the Dashboard to chat."
      />
    </div>
  );
};

export default ChatPanel;
