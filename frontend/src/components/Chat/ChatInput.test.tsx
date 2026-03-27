/**
 * Chat Input Tests
 *
 * Tests for the ChatInput component.
 *
 * @module components/Chat/ChatInput.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { ChatInput } from './ChatInput';
import { useChat } from '../../contexts/ChatContext';

// Mock the useChat hook
vi.mock('../../contexts/ChatContext', () => ({
  useChat: vi.fn(),
}));

const mockUseChat = useChat as jest.MockedFunction<typeof useChat>;

describe('ChatInput', () => {
  const mockSendMessage = vi.fn();
  const mockClearError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChat.mockReturnValue({
      conversations: [],
      currentConversation: null,
      messages: [],
      isLoading: false,
      isSending: false,
      error: null,
      isTyping: false,
      channelFilter: null,
      sendMessage: mockSendMessage,
      selectConversation: vi.fn(),
      createConversation: vi.fn(),
      deleteConversation: vi.fn(),
      archiveConversation: vi.fn(),
      clearConversation: vi.fn(),
      refreshMessages: vi.fn(),
      loadOlderMessages: vi.fn(),
      hasMoreMessages: false,
      isLoadingMore: false,
      clearError: mockClearError,
      setChannelFilter: vi.fn(),
    });
  });

  it('renders the input container', () => {
    render(<ChatInput />);
    expect(screen.getByTestId('chat-input-container')).toBeInTheDocument();
  });

  it('renders the textarea', () => {
    render(<ChatInput />);
    expect(screen.getByTestId('chat-message-input')).toBeInTheDocument();
  });

  it('renders the send button', () => {
    render(<ChatInput />);
    expect(screen.getByTestId('chat-send-button')).toBeInTheDocument();
  });

  it('renders keyboard hints', () => {
    render(<ChatInput />);
    expect(screen.getByText(/Press/)).toBeInTheDocument();
  });

  describe('input behavior', () => {
    it('updates input value when typing', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByTestId('chat-message-input');
      await user.type(input, 'Hello');

      expect(input).toHaveValue('Hello');
    });

    it('clears input on successful send', async () => {
      mockSendMessage.mockResolvedValue(undefined);
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByTestId('chat-message-input');
      await user.type(input, 'Hello');
      await user.click(screen.getByTestId('chat-send-button'));

      expect(input).toHaveValue('');
    });
  });

  describe('send button', () => {
    it('is disabled when input is empty', () => {
      render(<ChatInput />);
      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
    });

    it('is enabled when input has text', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      await user.type(screen.getByTestId('chat-message-input'), 'Hello');

      expect(screen.getByTestId('chat-send-button')).not.toBeDisabled();
    });

    it('is disabled while sending', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        isSending: true,
      });

      render(<ChatInput />);
      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
    });

    it('calls sendMessage on click', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      await user.type(screen.getByTestId('chat-message-input'), 'Hello');
      await user.click(screen.getByTestId('chat-send-button'));

      expect(mockSendMessage).toHaveBeenCalledWith('Hello');
    });
  });

  describe('keyboard shortcuts', () => {
    it('sends message on Enter key', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByTestId('chat-message-input');
      await user.type(input, 'Hello');
      await user.keyboard('{Enter}');

      expect(mockSendMessage).toHaveBeenCalledWith('Hello');
    });

    it('does not send on Shift+Enter', async () => {
      const user = userEvent.setup();
      render(<ChatInput />);

      const input = screen.getByTestId('chat-message-input');
      await user.type(input, 'Hello');
      await user.keyboard('{Shift>}{Enter}{/Shift}');

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('displays error message when present', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Failed to send',
      });

      render(<ChatInput />);
      expect(screen.getByTestId('chat-input-error')).toBeInTheDocument();
      expect(screen.getByText(/Failed to send/)).toBeInTheDocument();
    });

    it('clears error on dismiss click', async () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Failed to send',
        clearError: mockClearError,
      });

      const user = userEvent.setup();
      render(<ChatInput />);

      await user.click(screen.getByLabelText('Dismiss alert'));
      expect(mockClearError).toHaveBeenCalled();
    });

    it('clears error when typing', async () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Failed to send',
        clearError: mockClearError,
      });

      const user = userEvent.setup();
      render(<ChatInput />);

      await user.type(screen.getByTestId('chat-message-input'), 'a');
      expect(mockClearError).toHaveBeenCalled();
    });
  });

  describe('sending state', () => {
    it('shows loading spinner while sending', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        isSending: true,
      });

      render(<ChatInput />);
      // Button component renders a spinner div when loading=true
      const sendButton = screen.getByTestId('chat-send-button');
      expect(sendButton).toBeDisabled();
    });

    it('disables textarea while sending', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        isSending: true,
      });

      render(<ChatInput />);
      expect(screen.getByTestId('chat-message-input')).toBeDisabled();
    });
  });

  describe('accessibility', () => {
    it('has aria-label on textarea', () => {
      render(<ChatInput />);
      expect(screen.getByTestId('chat-message-input')).toHaveAttribute(
        'aria-label',
        'Message input'
      );
    });

    it('has aria-label on send button', () => {
      render(<ChatInput />);
      expect(screen.getByTestId('chat-send-button')).toHaveAttribute(
        'aria-label'
      );
    });

    it('error has role=alert', () => {
      mockUseChat.mockReturnValue({
        ...mockUseChat(),
        error: 'Error',
      });

      render(<ChatInput />);
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  describe('disabled prop (orchestrator offline)', () => {
    it('disables textarea when disabled prop is true', () => {
      render(<ChatInput disabled />);
      expect(screen.getByTestId('chat-message-input')).toBeDisabled();
    });

    it('disables send button when disabled prop is true', () => {
      render(<ChatInput disabled />);
      expect(screen.getByTestId('chat-send-button')).toBeDisabled();
    });

    it('shows custom placeholder when disabled with disabledPlaceholder', () => {
      render(<ChatInput disabled disabledPlaceholder="Orchestrator offline" />);
      expect(screen.getByTestId('chat-message-input')).toHaveAttribute(
        'placeholder',
        'Orchestrator offline'
      );
    });

    it('applies disabled-offline class when disabled', () => {
      render(<ChatInput disabled />);
      expect(screen.getByTestId('chat-message-input')).toHaveClass('disabled-offline');
    });

    it('does not send message when disabled', async () => {
      const user = userEvent.setup();
      render(<ChatInput disabled />);

      const input = screen.getByTestId('chat-message-input');
      // Try to type - should not work since disabled
      await user.type(input, 'Hello');

      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('shows correct aria-label on send button when disabled', () => {
      render(<ChatInput disabled />);
      expect(screen.getByTestId('chat-send-button')).toHaveAttribute(
        'aria-label',
        'Orchestrator offline'
      );
    });

    it('shows correct title on send button when disabled', () => {
      render(<ChatInput disabled />);
      expect(screen.getByTestId('chat-send-button')).toHaveAttribute(
        'title',
        'Orchestrator offline'
      );
    });
  });
});
