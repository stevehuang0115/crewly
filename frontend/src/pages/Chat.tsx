/**
 * Chat Page
 *
 * Thread-based chat interface with two-pane layout: thread list on the left,
 * thread detail on the right. Supports channel type filtering and new chat creation.
 *
 * @module pages/Chat
 */

import React, { useState, useCallback } from 'react';
import { useChat } from '../contexts/ChatContext';
import { ThreadListPanel } from '../components/Chat/ThreadListPanel';
import { ThreadDetailPanel } from '../components/Chat/ThreadDetailPanel';
import './Chat.css';

/**
 * Chat page component - thread-based orchestrator communication
 *
 * Features:
 * - Two-pane layout: thread list + thread detail
 * - Channel type filtering (All, Slack, Crewly, etc.)
 * - "+ New Chat" button to create conversations
 * - Responsive: single pane on mobile with toggle
 * - Real-time message updates via WebSocket
 *
 * @returns Chat page component
 */
export const Chat: React.FC = () => {
  const {
    conversations,
    currentConversation,
    selectConversation,
    createConversation,
    channelFilter,
    setChannelFilter,
  } = useChat();

  /** Mobile view state: 'list' or 'detail' */
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');

  /** Handle thread selection */
  const handleSelectThread = useCallback(
    async (conversationId: string) => {
      await selectConversation(conversationId);
      setMobileView('detail');
    },
    [selectConversation]
  );

  /** Handle back button on mobile */
  const handleBack = useCallback(() => {
    setMobileView('list');
  }, []);

  /** Handle creating a new chat conversation */
  const handleNewChat = useCallback(async () => {
    const conversation = await createConversation();
    if (conversation?.id) {
      await selectConversation(conversation.id);
      setMobileView('detail');
    }
  }, [createConversation, selectConversation]);

  return (
    <div className="chat-page thread-layout">
      <header className="chat-page-header">
        <h1>Chat with Orchestrator</h1>
        <p>Communicate with the Crewly orchestrator to manage projects and teams</p>
      </header>

      <div className="chat-page-content">
        <aside
          className={`chat-page-sidebar ${mobileView === 'list' ? 'mobile-visible' : 'mobile-hidden'}`}
        >
          <ThreadListPanel
            conversations={conversations}
            selectedConversationId={currentConversation?.id ?? null}
            onSelectThread={handleSelectThread}
            channelFilter={channelFilter}
            onChannelFilterChange={setChannelFilter}
            onNewChat={handleNewChat}
          />
        </aside>

        <main
          className={`chat-page-main ${mobileView === 'detail' ? 'mobile-visible' : 'mobile-hidden'}`}
        >
          <ThreadDetailPanel
            conversation={currentConversation}
            onBack={handleBack}
          />
        </main>
      </div>
    </div>
  );
};

export default Chat;
