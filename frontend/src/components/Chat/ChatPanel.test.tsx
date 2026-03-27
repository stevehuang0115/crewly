/**
 * Chat Panel Tests
 *
 * Tests for the ChatPanel component.
 *
 * @module components/Chat/ChatPanel.test
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatPanel } from './ChatPanel';
import { useChat } from '../../contexts/ChatContext';
import { useOrchestratorStatus } from '../../hooks/useOrchestratorStatus';
import type { ChatMessage, ChatConversation } from '../../types/chat.types';

// Mock the useChat hook
vi.mock('../../contexts/ChatContext', () => ({
  useChat: vi.fn(),
}));

// Mock the useOrchestratorStatus hook
vi.mock('../../hooks/useOrchestratorStatus', () => ({
  useOrchestratorStatus: vi.fn(),
}));

// Mock the child components
vi.mock('./ChatMessage', () => ({
  ChatMessage: ({ message }: { message: ChatMessage }) => (
    <div data-testid="chat-message">{message.content}</div>
  ),
}));

vi.mock('./ChatInput', () => ({
  ChatInput: ({ disabled, disabledPlaceholder }: { disabled?: boolean; disabledPlaceholder?: string }) => (
    <div data-testid="chat-input" data-disabled={disabled} data-placeholder={disabledPlaceholder}>
      Chat Input
    </div>
  ),
}));

vi.mock('./TypingIndicator', () => ({
  TypingIndicator: () => <div data-testid="typing-indicator">Typing...</div>,
}));

vi.mock('./QueueStatusBar', () => ({
  QueueStatusBar: () => <div data-testid="queue-status-bar-mock" />,
}));

vi.mock('./ChatLoadingState', () => ({
  ChatLoadingState: ({ message }: { message?: string }) => (
    <div data-testid="chat-loading">{message ?? 'Loading...'}</div>
  ),
}));

vi.mock('./ChatErrorState', () => ({
  ChatErrorState: ({ error }: { error: string }) => (
    <div data-testid="chat-error">
      <span>Error: {error}</span>
      <button onClick={() => window.location.reload()}>Retry</button>
    </div>
  ),
}));

vi.mock('./ChatEmptyState', () => ({
  ChatEmptyState: () => (
    <div data-testid="empty-chat">
      <h3>Welcome to Crewly</h3>
      <p>Start a conversation with the Orchestrator.</p>
      <ul>
        <li>Create a new project</li>
        <li>Assign a task to an agent</li>
        <li>Check project status</li>
        <li>Configure a team</li>
      </ul>
    </div>
  ),
}));

vi.mock('./ChatOfflineBanner', () => ({
  ChatOfflineBanner: ({ message }: { message?: string }) => (
    <div data-testid="orchestrator-offline-banner">
      <span>{message}</span>
      <button onClick={() => {}}>Dashboard</button>
    </div>
  ),
}));

const mockUseChat = useChat as jest.MockedFunction<typeof useChat>;
const mockUseOrchestratorStatus = useOrchestratorStatus as jest.MockedFunction<typeof useOrchestratorStatus>;

/**
 * Wrapper component for router context
 */
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

describe('ChatPanel', () => {
  const mockConversation: ChatConversation = {
    id: 'conv-1',
    title: 'Test Conversation',
    participantIds: ['user'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isArchived: false,
    messageCount: 2,
  };

  const mockMessages: ChatMessage[] = [
    {
      id: 'msg-1',
      conversationId: 'conv-1',
      from: { type: 'user' },
      content: 'Hello!',
      contentType: 'text',
      status: 'sent',
      timestamp: new Date().toISOString(),
    },
    {
      id: 'msg-2',
      conversationId: 'conv-1',
      from: { type: 'orchestrator' },
      content: 'Hi there!',
      contentType: 'text',
      status: 'sent',
      timestamp: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChat.mockReturnValue({
      conversations: [mockConversation],
      currentConversation: mockConversation,
      messages: mockMessages,
      isLoading: false,
      isSending: false,
      error: null,
      isTyping: false,
      channelFilter: null,
      sendMessage: vi.fn(),
      selectConversation: vi.fn(),
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
      archiveConversation: vi.fn(),
      clearConversation: vi.fn(),
      refreshMessages: vi.fn(),
      loadOlderMessages: vi.fn(),
      hasMoreMessages: false,
      isLoadingMore: false,
      clearError: vi.fn(),
      setChannelFilter: vi.fn(),
    });

    // Default: orchestrator is active
    mockUseOrchestratorStatus.mockReturnValue({
      status: {
        isActive: true,
        agentStatus: 'active',
        message: 'Orchestrator is active and ready.',
        offlineMessage: null,
      },
      isLoading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  describe('normal state', () => {
    it('renders the chat panel', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
    });

    it('renders conversation title', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
    });

    it('renders message count', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('2 messages')).toBeInTheDocument();
    });

    it('renders all messages', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      const messages = screen.getAllByTestId('chat-message');
      expect(messages).toHaveLength(2);
    });

    it('renders chat input', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('chat-input')).toBeInTheDocument();
    });

    it('shows singular message text for 1 message', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        messages: [mockMessages[0]],
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('1 message')).toBeInTheDocument();
    });
  });

  describe('loading state', () => {
    it('shows loading spinner when loading with no messages', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        isLoading: true,
        messages: [],
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('chat-panel-loading')).toBeInTheDocument();
      expect(screen.getByText('Loading conversation...')).toBeInTheDocument();
    });

    it('does not show loading spinner when loading with messages', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        isLoading: true,
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.queryByTestId('chat-panel-loading')).not.toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message when error with no messages', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Failed to load',
        messages: [],
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('chat-panel-error')).toBeInTheDocument();
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });

    it('shows retry button on error', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Failed to load',
        messages: [],
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });

    it('does not show error when there are messages', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Some error',
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.queryByTestId('chat-panel-error')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows welcome message when no messages', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        messages: [],
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('empty-chat')).toBeInTheDocument();
      expect(screen.getByText('Welcome to Crewly')).toBeInTheDocument();
    });

    it('shows suggestions for what to ask', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        messages: [],
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('Create a new project')).toBeInTheDocument();
      expect(screen.getByText('Assign a task to an agent')).toBeInTheDocument();
      expect(screen.getByText('Check project status')).toBeInTheDocument();
      expect(screen.getByText('Configure a team')).toBeInTheDocument();
    });
  });

  describe('typing indicator', () => {
    it('shows typing indicator when isTyping is true', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        isTyping: true,
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('typing-indicator')).toBeInTheDocument();
    });

    it('does not show typing indicator when isTyping is false', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.queryByTestId('typing-indicator')).not.toBeInTheDocument();
    });
  });

  describe('default conversation title', () => {
    it('shows default title when no current conversation', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        currentConversation: null,
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('Chat with Orchestrator')).toBeInTheDocument();
    });

    it('shows default title when conversation has no title', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        currentConversation: { ...mockConversation, title: undefined },
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('Chat with Orchestrator')).toBeInTheDocument();
    });
  });

  describe('messages container', () => {
    it('renders messages container', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('messages-container')).toBeInTheDocument();
    });
  });

  describe('orchestrator offline state', () => {
    it('shows offline banner when orchestrator is inactive', () => {
      mockUseOrchestratorStatus.mockReturnValue({
        status: {
          isActive: false,
          agentStatus: 'inactive',
          message: 'Orchestrator is not running.',
          offlineMessage: 'The orchestrator is currently offline. Please start it from the Dashboard.',
        },
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByTestId('orchestrator-offline-banner')).toBeInTheDocument();
    });

    it('shows offline message in banner', () => {
      mockUseOrchestratorStatus.mockReturnValue({
        status: {
          isActive: false,
          agentStatus: 'inactive',
          message: 'Orchestrator is not running.',
          offlineMessage: 'The orchestrator is currently offline. Please start it from the Dashboard.',
        },
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(
        screen.getByText(/orchestrator is currently offline/i)
      ).toBeInTheDocument();
    });

    it('shows Dashboard button when offline', () => {
      mockUseOrchestratorStatus.mockReturnValue({
        status: {
          isActive: false,
          agentStatus: 'inactive',
          message: 'Orchestrator is not running.',
          offlineMessage: 'The orchestrator is currently offline. Please start it from the Dashboard.',
        },
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    it('disables chat input when orchestrator is offline', () => {
      mockUseOrchestratorStatus.mockReturnValue({
        status: {
          isActive: false,
          agentStatus: 'inactive',
          message: 'Orchestrator is not running.',
          offlineMessage: 'The orchestrator is currently offline.',
        },
        isLoading: false,
        error: null,
        refresh: vi.fn(),
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      const chatInput = screen.getByTestId('chat-input');
      expect(chatInput).toHaveAttribute('data-disabled', 'true');
    });

    it('does not show offline banner when orchestrator is active', () => {
      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.queryByTestId('orchestrator-offline-banner')).not.toBeInTheDocument();
    });

    it('does not show offline banner while status is loading', () => {
      mockUseOrchestratorStatus.mockReturnValue({
        status: null,
        isLoading: true,
        error: null,
        refresh: vi.fn(),
      });

      render(<ChatPanel />, { wrapper: TestWrapper });
      expect(screen.queryByTestId('orchestrator-offline-banner')).not.toBeInTheDocument();
    });
  });
});
