/**
 * Thread Preview Component
 *
 * A compact 2-row card showing a conversation thread summary in the thread list.
 * Features: agent avatar with role color, unread indicator, CSS line-clamp,
 * overflow menu (pin/archive/delete), and channel badge with visible label.
 *
 * @module components/Chat/ThreadPreview
 */

import React, { useState, useCallback } from 'react';
import { MoreVertical, Pin, Archive, Trash2 } from 'lucide-react';
import type { ChatConversation } from '../../types/chat.types';
import { ChannelBadge } from './ChannelBadge';
import { formatRelativeTime } from '../../utils/time';
import { maskSensitiveData } from '../../utils/security';
import './ThreadPreview.css';

// =============================================================================
// Constants
// =============================================================================

/**
 * Role-based avatar background colors.
 * Matches the pattern used in TeamMemberModal and TeamsGridCard.
 */
const ROLE_AVATAR_COLORS: Record<string, string> = {
  orchestrator: '#3b82f6',
  developer: '#10b981',
  pm: '#8b5cf6',
  'ux-designer': '#ec4899',
  'product-manager': '#8b5cf6',
  marketing: '#f59e0b',
  researcher: '#14b8a6',
  auditor: '#ef4444',
  'social-media-ops': '#f59e0b',
  default: '#6b7280',
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Strip system metadata tags from preview/title text.
 *
 * Removes patterns like:
 * - [Thread context file: ...]
 * - [Thread ...]  (any Thread-prefixed bracket tag)
 * - [T1], [T2], etc. (task reference tags)
 *
 * @param text - Raw text that may contain metadata tags
 * @returns Cleaned text with metadata tags removed
 */
function stripMetadata(text: string): string {
  return text
    .replace(/\[Thread[^\]]*\]/g, '')
    .replace(/\[T\d+\]/g, '')
    .trim();
}

/**
 * Get the avatar background color for an agent role.
 *
 * @param role - Agent role string (e.g., 'developer', 'orchestrator')
 * @returns Hex color string
 */
function getAvatarColor(role?: string): string {
  if (!role) return ROLE_AVATAR_COLORS.default;
  return ROLE_AVATAR_COLORS[role.toLowerCase()] ?? ROLE_AVATAR_COLORS.default;
}

/**
 * Get the first character of a name for the avatar fallback.
 *
 * @param name - Display name
 * @returns Uppercase first character, or '?' if empty
 */
function getAvatarInitial(name?: string): string {
  if (!name) return '?';
  return name.charAt(0).toUpperCase();
}

// =============================================================================
// Types
// =============================================================================

interface ThreadPreviewProps {
  /** The conversation to preview */
  conversation: ChatConversation;
  /** Whether this thread is currently selected */
  isActive: boolean;
  /** Callback when the thread is clicked */
  onClick: () => void;
  /** Callback when pin action is triggered */
  onPin?: (conversationId: string) => void;
  /** Callback when archive action is triggered */
  onArchive?: (conversationId: string) => void;
  /** Callback when delete action is triggered */
  onDelete?: (conversationId: string) => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Thread preview card with 2-row compact layout.
 *
 * Row 1: Avatar | Title | Time | Overflow menu
 * Row 2: Channel badge | Sender: preview (line-clamp:2) | Message count
 *
 * @param props - Component props
 * @returns JSX element with thread preview card
 */
export const ThreadPreview: React.FC<ThreadPreviewProps> = ({
  conversation,
  isActive,
  onClick,
  onPin,
  onArchive,
  onDelete,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);

  const channelType = conversation.channelType ?? 'crewly_chat';
  const rawTitle = conversation.title || conversation.lastMessage?.content?.slice(0, 60) || 'New conversation';
  const rawPreview = conversation.lastMessage?.content ?? '';
  const title = stripMetadata(maskSensitiveData(rawTitle));
  const preview = stripMetadata(maskSensitiveData(rawPreview));
  const senderName = conversation.lastMessage?.from?.name ?? conversation.lastMessage?.from?.type ?? '';
  const senderRole = conversation.lastMessage?.from?.role;
  const isUnread = (conversation.unreadCount ?? 0) > 0;

  /** Handle overflow menu toggle without triggering card click */
  const handleMenuToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen((prev) => !prev);
  }, []);

  /** Handle a menu action, closing the menu and calling the handler */
  const handleMenuAction = useCallback((e: React.MouseEvent, action?: (id: string) => void) => {
    e.stopPropagation();
    setMenuOpen(false);
    action?.(conversation.id);
  }, [conversation.id]);

  return (
    <div
      onClick={onClick}
      className={`thread-preview${isActive ? ' active' : ''}${isUnread ? ' unread' : ''}`}
      data-testid="thread-preview"
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/* Avatar — spans both rows */}
      <div
        className="thread-preview-avatar"
        style={{ backgroundColor: getAvatarColor(senderRole) }}
        aria-hidden="true"
      >
        {getAvatarInitial(senderName)}
      </div>

      {/* Row 1: Title + Time + Menu */}
      <div className="thread-preview-header">
        <span className="thread-preview-title">
          {title}
          {isUnread && <span className="thread-preview-unread-dot" aria-label="Unread messages" />}
        </span>
        <span className="thread-preview-time">
          {formatRelativeTime(conversation.updatedAt)}
        </span>
        <button
          className="thread-preview-menu-btn"
          onClick={handleMenuToggle}
          aria-label="Thread actions"
          aria-expanded={menuOpen}
          tabIndex={-1}
        >
          <MoreVertical size={14} />
        </button>
      </div>

      {/* Row 2: Channel badge + preview + count */}
      <div className="thread-preview-body-row">
        <span className="thread-preview-channel">
          <ChannelBadge channelType={channelType} showLabel />
        </span>
        <span className="thread-preview-body">
          {senderName && (
            <span className="thread-preview-sender">{senderName}: </span>
          )}
          <span className="thread-preview-content">{preview}</span>
        </span>
        {conversation.messageCount > 0 && (
          <span className="thread-preview-count">
            {conversation.messageCount}
          </span>
        )}
      </div>

      {/* Overflow menu dropdown */}
      {menuOpen && (
        <div className="thread-preview-menu" role="menu">
          <button
            className="thread-preview-menu-item"
            role="menuitem"
            onClick={(e) => handleMenuAction(e, onPin)}
          >
            <Pin size={12} /> Pin to top
          </button>
          <button
            className="thread-preview-menu-item"
            role="menuitem"
            onClick={(e) => handleMenuAction(e, onArchive)}
          >
            <Archive size={12} /> Archive
          </button>
          <button
            className="thread-preview-menu-item thread-preview-menu-item--danger"
            role="menuitem"
            onClick={(e) => handleMenuAction(e, onDelete)}
          >
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
};

export default ThreadPreview;
