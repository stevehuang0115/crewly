/**
 * Chat Sidebar Component
 *
 * Sidebar showing conversation list and management.
 *
 * @module components/Chat/ChatSidebar
 */

import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Trash2, FolderOpen, Users, Settings as SettingsIcon, MoreVertical } from 'lucide-react';
import { useChat } from '../../contexts/ChatContext';
import { ChatConversation } from '../../types/chat.types';
import { formatRelativeTime } from '../../utils/time';
import './ChatSidebar.css';

// =============================================================================
// Component
// =============================================================================

/**
 * Sidebar component showing conversation list and management.
 *
 * Features:
 * - Conversation search/filter
 * - New conversation button
 * - Context menu for archive/delete
 * - Active conversation highlighting
 *
 * @returns JSX element with chat sidebar
 */
export const ChatSidebar: React.FC = () => {
  const {
    conversations,
    currentConversation,
    selectConversation,
    createConversation,
    deleteConversation,
    archiveConversation,
  } = useChat();

  const [searchQuery, setSearchQuery] = useState('');
  const [showMenu, setShowMenu] = useState<string | null>(null);

  // Filter conversations by search query
  const filteredConversations = conversations.filter((conv) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      conv.title?.toLowerCase().includes(query) ||
      conv.lastMessage?.content.toLowerCase().includes(query)
    );
  });

  /**
   * Handle creating a new conversation
   */
  const handleNewChat = useCallback(async () => {
    await createConversation();
  }, [createConversation]);

  /**
   * Handle context menu toggle
   */
  const handleMenuToggle = useCallback(
    (e: React.MouseEvent, convId: string) => {
      e.stopPropagation();
      setShowMenu(showMenu === convId ? null : convId);
    },
    [showMenu]
  );

  /**
   * Handle delete conversation
   */
  const handleDelete = useCallback(
    async (convId: string) => {
      if (window.confirm('Delete this conversation?')) {
        await deleteConversation(convId);
      }
      setShowMenu(null);
    },
    [deleteConversation]
  );

  /**
   * Handle archive conversation
   */
  const handleArchive = useCallback(
    async (convId: string) => {
      await archiveConversation(convId);
      setShowMenu(null);
    },
    [archiveConversation]
  );

  /**
   * Close menu when clicking outside
   */
  const handleClickOutside = useCallback(() => {
    if (showMenu) {
      setShowMenu(null);
    }
  }, [showMenu]);

  /**
   * Render a single conversation item
   */
  const renderConversationItem = (conversation: ChatConversation) => {
    const isActive = currentConversation?.id === conversation.id;

    return (
      <div
        key={conversation.id}
        className={`conversation-item ${isActive ? 'active' : ''}`}
        onClick={() => selectConversation(conversation.id)}
        data-testid={`conversation-item-${conversation.id}`}
      >
        <div className="conversation-info">
          <h4 className="conversation-title">
            {conversation.title || 'Untitled Chat'}
          </h4>
          {conversation.lastMessage && (
            <p className="conversation-preview">
              {conversation.lastMessage.content}
            </p>
          )}
          <span className="conversation-time">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
        </div>

        <button
          className="menu-trigger"
          onClick={(e) => handleMenuToggle(e, conversation.id)}
          aria-label="Conversation options"
          data-testid={`menu-trigger-${conversation.id}`}
        >
          <MoreVertical size={14} />
        </button>

        {showMenu === conversation.id && (
          <div
            className="context-menu"
            data-testid={`context-menu-${conversation.id}`}
          >
            <button onClick={() => handleArchive(conversation.id)}>
              <Archive size={14} /> Archive
            </button>
            <button
              className="danger"
              onClick={() => handleDelete(conversation.id)}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside
      className="chat-sidebar"
      onClick={handleClickOutside}
      data-testid="chat-sidebar"
    >
      <div className="sidebar-header">
        <h3>Conversations</h3>
        <button
          className="new-chat-btn"
          onClick={handleNewChat}
          aria-label="Create new conversation"
          data-testid="new-chat-button"
        >
          + New Chat
        </button>
      </div>

      <div className="search-container">
        <input
          type="text"
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="search-input"
          data-testid="conversation-search"
          aria-label="Search conversations"
        />
      </div>

      <div className="conversations-list" data-testid="conversations-list">
        {filteredConversations.length === 0 ? (
          <div className="empty-list" data-testid="empty-conversations">
            {searchQuery
              ? 'No matching conversations'
              : 'No conversations yet'}
          </div>
        ) : (
          filteredConversations.map(renderConversationItem)
        )}
      </div>

      <div className="sidebar-footer">
        <nav className="quick-links">
          <Link to="/projects"><FolderOpen size={14} /> Projects</Link>
          <Link to="/teams"><Users size={14} /> Teams</Link>
          <Link to="/settings"><SettingsIcon size={14} /> Settings</Link>
        </nav>
      </div>
    </aside>
  );
};

export default ChatSidebar;
