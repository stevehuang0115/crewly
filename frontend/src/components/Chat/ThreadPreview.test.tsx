/**
 * Thread Preview Tests
 *
 * Tests for the ThreadPreview component — 2-row compact card
 * with agent avatar, unread indicator, overflow menu, and CSS line-clamp.
 *
 * @module components/Chat/ThreadPreview.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ThreadPreview } from './ThreadPreview';
import type { ChatConversation } from '../../types/chat.types';

// Mock the ChannelBadge component
vi.mock('./ChannelBadge', () => ({
  ChannelBadge: ({ channelType, showLabel }: { channelType: string; showLabel?: boolean }) => (
    <span data-testid="channel-badge" data-channel={channelType} data-show-label={showLabel}>
      {channelType}
    </span>
  ),
}));

// Mock the formatRelativeTime utility
vi.mock('../../utils/time', () => ({
  formatRelativeTime: vi.fn(() => '5 minutes ago'),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  MoreVertical: ({ size }: { size: number }) => <span data-testid="icon-more-vertical">...</span>,
  Pin: ({ size }: { size: number }) => <span data-testid="icon-pin">pin</span>,
  Archive: ({ size }: { size: number }) => <span data-testid="icon-archive">archive</span>,
  Trash2: ({ size }: { size: number }) => <span data-testid="icon-trash">trash</span>,
}));

describe('ThreadPreview', () => {
  const mockConversation: ChatConversation = {
    id: 'conv-123',
    title: 'Test Thread',
    participantIds: ['user'],
    createdAt: '2026-03-08T00:00:00Z',
    updatedAt: '2026-03-08T00:00:00Z',
    isArchived: false,
    messageCount: 5,
    channelType: 'slack',
    lastMessage: {
      content: 'Hello world',
      timestamp: '2026-03-08T00:00:00Z',
      from: { type: 'user', name: 'Sam', role: 'developer' },
    },
  };

  const mockOnClick = vi.fn();
  const mockOnPin = vi.fn();
  const mockOnArchive = vi.fn();
  const mockOnDelete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Title rendering ──────────────────────────────────────────

  describe('title rendering', () => {
    it('renders the conversation title', () => {
      render(
        <ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />
      );
      expect(screen.getByText('Test Thread')).toBeInTheDocument();
    });

    it('falls back to last message content when title is missing', () => {
      const noTitle: ChatConversation = {
        ...mockConversation,
        title: undefined,
        lastMessage: { content: 'Fallback message', timestamp: '2026-03-08T00:00:00Z', from: { type: 'user', name: 'Sam' } },
      };
      render(<ThreadPreview conversation={noTitle} isActive={false} onClick={mockOnClick} />);
      const titleEl = screen.getByTestId('thread-preview').querySelector('.thread-preview-title');
      expect(titleEl).toHaveTextContent('Fallback message');
    });

    it('shows "New conversation" when no title and no last message', () => {
      const empty: ChatConversation = { ...mockConversation, title: undefined, lastMessage: undefined };
      render(<ThreadPreview conversation={empty} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByText('New conversation')).toBeInTheDocument();
    });
  });

  // ── Agent avatar ─────────────────────────────────────────────

  describe('agent avatar', () => {
    it('renders avatar with sender initial', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      const avatar = screen.getByTestId('thread-preview').querySelector('.thread-preview-avatar');
      expect(avatar).toHaveTextContent('S');
    });

    it('applies role-based color to avatar', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      const avatar = screen.getByTestId('thread-preview').querySelector('.thread-preview-avatar');
      // developer = #10b981
      expect(avatar).toHaveStyle({ backgroundColor: '#10b981' });
    });

    it('uses gray default color when role is unknown', () => {
      const unknownRole: ChatConversation = {
        ...mockConversation,
        lastMessage: { content: 'Hi', timestamp: '2026-03-08T00:00:00Z', from: { type: 'agent', name: 'Zara', role: 'analyst' } },
      };
      render(<ThreadPreview conversation={unknownRole} isActive={false} onClick={mockOnClick} />);
      const avatar = screen.getByTestId('thread-preview').querySelector('.thread-preview-avatar');
      expect(avatar).toHaveStyle({ backgroundColor: '#6b7280' });
    });

    it('shows ? when no sender at all', () => {
      const noSender: ChatConversation = {
        ...mockConversation,
        lastMessage: undefined,
      };
      render(<ThreadPreview conversation={noSender} isActive={false} onClick={mockOnClick} />);
      const avatar = screen.getByTestId('thread-preview').querySelector('.thread-preview-avatar');
      expect(avatar).toHaveTextContent('?');
    });

    it('falls back to sender type initial when name is missing', () => {
      const noName: ChatConversation = {
        ...mockConversation,
        lastMessage: { content: 'Hi', timestamp: '2026-03-08T00:00:00Z', from: { type: 'agent' } },
      };
      render(<ThreadPreview conversation={noName} isActive={false} onClick={mockOnClick} />);
      const avatar = screen.getByTestId('thread-preview').querySelector('.thread-preview-avatar');
      expect(avatar).toHaveTextContent('A');
    });
  });

  // ── Channel badge ────────────────────────────────────────────

  describe('channel badge', () => {
    it('renders ChannelBadge with showLabel=true', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      const badge = screen.getByTestId('channel-badge');
      expect(badge).toHaveAttribute('data-channel', 'slack');
      expect(badge).toHaveAttribute('data-show-label', 'true');
    });

    it('defaults to crewly_chat when channelType is undefined', () => {
      const noChannel: ChatConversation = { ...mockConversation, channelType: undefined };
      render(<ThreadPreview conversation={noChannel} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByTestId('channel-badge')).toHaveAttribute('data-channel', 'crewly_chat');
    });
  });

  // ── Message count ────────────────────────────────────────────

  describe('message count', () => {
    it('shows message count as a pill badge', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      const count = screen.getByTestId('thread-preview').querySelector('.thread-preview-count');
      expect(count).toHaveTextContent('5');
    });

    it('does not show count when messageCount is 0', () => {
      const zeroMsg: ChatConversation = { ...mockConversation, messageCount: 0 };
      render(<ThreadPreview conversation={zeroMsg} isActive={false} onClick={mockOnClick} />);
      const count = screen.getByTestId('thread-preview').querySelector('.thread-preview-count');
      expect(count).toBeNull();
    });
  });

  // ── Relative time ────────────────────────────────────────────

  describe('relative time', () => {
    it('shows the formatted relative time', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    });
  });

  // ── Unread state ─────────────────────────────────────────────

  describe('unread state', () => {
    it('adds unread class when unreadCount > 0', () => {
      const unread: ChatConversation = { ...mockConversation, unreadCount: 3 };
      render(<ThreadPreview conversation={unread} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByTestId('thread-preview')).toHaveClass('unread');
    });

    it('shows unread dot when unreadCount > 0', () => {
      const unread: ChatConversation = { ...mockConversation, unreadCount: 1 };
      render(<ThreadPreview conversation={unread} isActive={false} onClick={mockOnClick} />);
      const dot = screen.getByTestId('thread-preview').querySelector('.thread-preview-unread-dot');
      expect(dot).toBeInTheDocument();
    });

    it('does not show unread dot when unreadCount is 0', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      const dot = screen.getByTestId('thread-preview').querySelector('.thread-preview-unread-dot');
      expect(dot).toBeNull();
    });

    it('does not add unread class when unreadCount is undefined', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByTestId('thread-preview')).not.toHaveClass('unread');
    });
  });

  // ── Active state ─────────────────────────────────────────────

  describe('active state', () => {
    it('has active class when isActive is true', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={true} onClick={mockOnClick} />);
      expect(screen.getByTestId('thread-preview')).toHaveClass('active');
    });

    it('does not have active class when isActive is false', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByTestId('thread-preview')).not.toHaveClass('active');
    });

    it('sets aria-pressed based on isActive', () => {
      const { rerender } = render(
        <ThreadPreview conversation={mockConversation} isActive={true} onClick={mockOnClick} />
      );
      expect(screen.getByTestId('thread-preview')).toHaveAttribute('aria-pressed', 'true');
      rerender(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByTestId('thread-preview')).toHaveAttribute('aria-pressed', 'false');
    });
  });

  // ── Click handling ───────────────────────────────────────────

  describe('click handling', () => {
    it('calls onClick when the thread preview is clicked', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      fireEvent.click(screen.getByTestId('thread-preview'));
      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });

    it('calls onClick on Enter key press', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      fireEvent.keyDown(screen.getByTestId('thread-preview'), { key: 'Enter' });
      expect(mockOnClick).toHaveBeenCalledTimes(1);
    });
  });

  // ── Overflow menu ────────────────────────────────────────────

  describe('overflow menu', () => {
    it('does not show menu by default', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('shows menu when menu button is clicked', () => {
      render(
        <ThreadPreview
          conversation={mockConversation}
          isActive={false}
          onClick={mockOnClick}
          onPin={mockOnPin}
          onArchive={mockOnArchive}
          onDelete={mockOnDelete}
        />
      );
      const menuBtn = screen.getByLabelText('Thread actions');
      fireEvent.click(menuBtn);
      expect(screen.getByRole('menu')).toBeInTheDocument();
    });

    it('does not trigger card onClick when menu button is clicked', () => {
      render(
        <ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} onPin={mockOnPin} />
      );
      fireEvent.click(screen.getByLabelText('Thread actions'));
      expect(mockOnClick).not.toHaveBeenCalled();
    });

    it('calls onPin with conversation id when Pin is clicked', () => {
      render(
        <ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} onPin={mockOnPin} />
      );
      fireEvent.click(screen.getByLabelText('Thread actions'));
      fireEvent.click(screen.getByText('Pin to top'));
      expect(mockOnPin).toHaveBeenCalledWith('conv-123');
    });

    it('calls onArchive with conversation id when Archive is clicked', () => {
      render(
        <ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} onArchive={mockOnArchive} />
      );
      fireEvent.click(screen.getByLabelText('Thread actions'));
      fireEvent.click(screen.getByText('Archive'));
      expect(mockOnArchive).toHaveBeenCalledWith('conv-123');
    });

    it('calls onDelete with conversation id when Delete is clicked', () => {
      render(
        <ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} onDelete={mockOnDelete} />
      );
      fireEvent.click(screen.getByLabelText('Thread actions'));
      fireEvent.click(screen.getByText('Delete'));
      expect(mockOnDelete).toHaveBeenCalledWith('conv-123');
    });

    it('closes menu after action is taken', () => {
      render(
        <ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} onPin={mockOnPin} />
      );
      fireEvent.click(screen.getByLabelText('Thread actions'));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Pin to top'));
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  // ── Sender name in preview ───────────────────────────────────

  describe('last message preview', () => {
    it('shows sender name with colon', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByText('Sam:')).toBeInTheDocument();
    });

    it('shows message content in preview body', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });
  });

  // ── data-testid ──────────────────────────────────────────────

  describe('data-testid', () => {
    it('has data-testid="thread-preview"', () => {
      render(<ThreadPreview conversation={mockConversation} isActive={false} onClick={mockOnClick} />);
      expect(screen.getByTestId('thread-preview')).toBeInTheDocument();
    });
  });
});
