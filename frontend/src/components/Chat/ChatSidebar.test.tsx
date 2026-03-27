/**
 * Chat Sidebar Tests
 *
 * Tests for the ChatSidebar component.
 *
 * @module components/Chat/ChatSidebar.test
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatSidebar } from './ChatSidebar';
import { useChat } from '../../contexts/ChatContext';
import type { ChatConversation } from '../../types/chat.types';

// Mock the useChat hook
vi.mock('../../contexts/ChatContext', () => ({
  useChat: vi.fn(),
}));

// Mock time utility
vi.mock('../../utils/time', () => ({
  formatRelativeTime: vi.fn(() => '5 min ago'),
}));

const mockUseChat = useChat as jest.MockedFunction<typeof useChat>;

/**
 * Wrapper providing router context for Link components.
 */
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

describe('ChatSidebar', () => {
  const mockConversations: ChatConversation[] = [
    {
      id: 'conv-1',
      title: 'First Chat',
      participantIds: ['user'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isArchived: false,
      messageCount: 5,
      lastMessage: {
        content: 'Last message preview',
        timestamp: new Date().toISOString(),
        from: { type: 'user' },
      },
    },
    {
      id: 'conv-2',
      title: 'Second Chat',
      participantIds: ['user'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isArchived: false,
      messageCount: 3,
    },
  ];

  const mockSelectConversation = vi.fn();
  const mockCreateConversation = vi.fn();
  const mockDeleteConversation = vi.fn();
  const mockArchiveConversation = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChat.mockReturnValue({
      conversations: mockConversations,
      currentConversation: mockConversations[0],
      messages: [],
      isLoading: false,
      isSending: false,
      error: null,
      isTyping: false,
      sendMessage: vi.fn(),
      selectConversation: mockSelectConversation,
      createConversation: mockCreateConversation,
      deleteConversation: mockDeleteConversation,
      archiveConversation: mockArchiveConversation,
      clearConversation: vi.fn(),
      refreshMessages: vi.fn(),
      loadOlderMessages: vi.fn(),
      hasMoreMessages: false,
      isLoadingMore: false,
      clearError: vi.fn(),
      channelFilter: null,
      setChannelFilter: vi.fn(),
    });
  });

  describe('rendering', () => {
    it('renders the sidebar', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('chat-sidebar')).toBeInTheDocument();
    });

    it('renders header with title', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByText('Conversations')).toBeInTheDocument();
    });

    it('renders new chat button', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('new-chat-button')).toBeInTheDocument();
    });

    it('renders search input', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('conversation-search')).toBeInTheDocument();
    });

    it('renders conversations list', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('conversations-list')).toBeInTheDocument();
    });

    it('renders all conversations', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByText('First Chat')).toBeInTheDocument();
      expect(screen.getByText('Second Chat')).toBeInTheDocument();
    });

    it('renders quick links', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByText(/Projects/)).toBeInTheDocument();
      expect(screen.getByText(/Teams/)).toBeInTheDocument();
      expect(screen.getByText(/Settings/)).toBeInTheDocument();
    });
  });

  describe('conversation items', () => {
    it('shows last message preview', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByText('Last message preview')).toBeInTheDocument();
    });

    it('shows relative time', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getAllByText('5 min ago')).toHaveLength(2);
    });

    it('highlights active conversation', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      const activeItem = screen.getByTestId('conversation-item-conv-1');
      expect(activeItem).toHaveClass('active');
    });

    it('shows "Untitled Chat" for conversations without title', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        conversations: [{ ...mockConversations[0], title: undefined }],
      });

      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByText('Untitled Chat')).toBeInTheDocument();
    });
  });

  describe('new chat button', () => {
    it('calls createConversation when clicked', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('new-chat-button'));

      expect(mockCreateConversation).toHaveBeenCalled();
    });
  });

  describe('conversation selection', () => {
    it('calls selectConversation when conversation clicked', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('conversation-item-conv-2'));

      expect(mockSelectConversation).toHaveBeenCalledWith('conv-2');
    });
  });

  describe('search functionality', () => {
    it('filters conversations by title', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.type(screen.getByTestId('conversation-search'), 'First');

      expect(screen.getByText('First Chat')).toBeInTheDocument();
      expect(screen.queryByText('Second Chat')).not.toBeInTheDocument();
    });

    it('filters conversations by last message content', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.type(screen.getByTestId('conversation-search'), 'preview');

      expect(screen.getByText('First Chat')).toBeInTheDocument();
      expect(screen.queryByText('Second Chat')).not.toBeInTheDocument();
    });

    it('shows empty message when no matches', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.type(screen.getByTestId('conversation-search'), 'nonexistent');

      expect(screen.getByText('No matching conversations')).toBeInTheDocument();
    });

    it('case insensitive search', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.type(screen.getByTestId('conversation-search'), 'FIRST');

      expect(screen.getByText('First Chat')).toBeInTheDocument();
    });
  });

  describe('context menu', () => {
    it('shows menu trigger on conversation', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('menu-trigger-conv-1')).toBeInTheDocument();
    });

    it('opens context menu when trigger clicked', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('menu-trigger-conv-1'));

      expect(screen.getByTestId('context-menu-conv-1')).toBeInTheDocument();
    });

    it('shows archive and delete options', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('menu-trigger-conv-1'));

      expect(screen.getByText(/Archive/)).toBeInTheDocument();
      expect(screen.getByText(/Delete/)).toBeInTheDocument();
    });

    it('closes menu when clicking elsewhere', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('menu-trigger-conv-1'));
      expect(screen.getByTestId('context-menu-conv-1')).toBeInTheDocument();

      await user.click(screen.getByTestId('chat-sidebar'));
      expect(screen.queryByTestId('context-menu-conv-1')).not.toBeInTheDocument();
    });
  });

  describe('archive conversation', () => {
    it('calls archiveConversation when archive clicked', async () => {
      const user = userEvent.setup();
      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('menu-trigger-conv-1'));
      await user.click(screen.getByText(/Archive/));

      expect(mockArchiveConversation).toHaveBeenCalledWith('conv-1');
    });
  });

  describe('delete conversation', () => {
    it('calls deleteConversation when confirmed', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('menu-trigger-conv-1'));
      await user.click(screen.getByText(/Delete/));

      expect(mockDeleteConversation).toHaveBeenCalledWith('conv-1');
    });

    it('does not delete when cancelled', async () => {
      const user = userEvent.setup();
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      render(<ChatSidebar />, { wrapper: TestWrapper });

      await user.click(screen.getByTestId('menu-trigger-conv-1'));
      await user.click(screen.getByText(/Delete/));

      expect(mockDeleteConversation).not.toHaveBeenCalled();
    });
  });

  describe('empty state', () => {
    it('shows empty message when no conversations', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        conversations: [],
      });

      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('empty-conversations')).toBeInTheDocument();
      expect(screen.getByText('No conversations yet')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('has aria-label on new chat button', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('new-chat-button')).toHaveAttribute(
        'aria-label',
        'Create new conversation'
      );
    });

    it('has aria-label on search input', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('conversation-search')).toHaveAttribute(
        'aria-label',
        'Search conversations'
      );
    });

    it('has aria-label on menu trigger', () => {
      render(<ChatSidebar />, { wrapper: TestWrapper });
      expect(screen.getByTestId('menu-trigger-conv-1')).toHaveAttribute(
        'aria-label',
        'Conversation options'
      );
    });
  });
});
