/**
 * Chat Message Tests
 *
 * Tests for the ChatMessage component.
 *
 * @module components/Chat/ChatMessage.test
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect } from 'vitest';
import { ChatMessage } from './ChatMessage';
import type { ChatMessage as ChatMessageType } from '../../types/chat.types';

// Mock time utility
vi.mock('../../utils/time', () => ({
  formatRelativeTime: vi.fn(() => '5 minutes ago'),
}));

describe('ChatMessage', () => {
  const baseMessage: ChatMessageType = {
    id: 'msg-1',
    conversationId: 'conv-1',
    from: { type: 'user' },
    content: 'Hello world!',
    contentType: 'text',
    status: 'sent',
    timestamp: new Date().toISOString(),
  };

  describe('rendering', () => {
    it('renders the message', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByTestId('chat-message')).toBeInTheDocument();
    });

    it('renders message content', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByText('Hello world!')).toBeInTheDocument();
    });

    it('renders sender name', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByText('You')).toBeInTheDocument();
    });

    it('renders relative time', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByText('5 minutes ago')).toBeInTheDocument();
    });
  });

  describe('sender types', () => {
    it('shows "You" for user messages with Avatar', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByText('You')).toBeInTheDocument();
      // Avatar renders the sender initial in a div
      const avatar = screen.getByText('U');
      expect(avatar).toBeInTheDocument();
    });

    it('shows "Orchestrator" for orchestrator messages with Avatar', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        from: { type: 'orchestrator' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
      const avatar = screen.getByText('O');
      expect(avatar).toBeInTheDocument();
    });

    it('shows role for agent messages with Avatar', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        from: { type: 'agent', role: 'Developer' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('Developer')).toBeInTheDocument();
      const avatar = screen.getByText('A');
      expect(avatar).toBeInTheDocument();
    });

    it('shows "System" for system messages with Avatar', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        from: { type: 'system' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('System')).toBeInTheDocument();
      const avatar = screen.getByText('S');
      expect(avatar).toBeInTheDocument();
    });

    it('uses custom name when provided', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        from: { type: 'user', name: 'John' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('John')).toBeInTheDocument();
    });
  });

  describe('CSS classes', () => {
    it('has user-message class for user messages', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByTestId('chat-message')).toHaveClass('user-message');
    });

    it('has system-message class for system messages', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        from: { type: 'system' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByTestId('chat-message')).toHaveClass('system-message');
    });

    it('has sender type class', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.getByTestId('chat-message')).toHaveClass('user');
    });
  });

  describe('raw output toggle', () => {
    it('shows toggle button when rawOutput metadata exists', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        metadata: { rawOutput: 'raw terminal output' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByTestId('toggle-raw-button')).toBeInTheDocument();
    });

    it('does not show toggle button without rawOutput', () => {
      render(<ChatMessage message={baseMessage} />);
      expect(screen.queryByTestId('toggle-raw-button')).not.toBeInTheDocument();
    });

    it('toggles between formatted and raw content', async () => {
      const user = userEvent.setup();
      const msg: ChatMessageType = {
        ...baseMessage,
        metadata: { rawOutput: 'raw terminal output' },
      };
      render(<ChatMessage message={msg} />);

      // Initially shows formatted content
      expect(screen.queryByTestId('raw-output')).not.toBeInTheDocument();

      // Click toggle
      await user.click(screen.getByTestId('toggle-raw-button'));

      // Now shows raw output
      expect(screen.getByTestId('raw-output')).toBeInTheDocument();
      expect(screen.getByText('raw terminal output')).toBeInTheDocument();
    });
  });

  describe('metadata badges', () => {
    it('shows skill badge when skillUsed metadata exists', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        metadata: { skillUsed: 'code-review' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByTestId('skill-badge')).toBeInTheDocument();
      expect(screen.getByText('code-review')).toBeInTheDocument();
    });

    it('shows task badge when taskCreated metadata exists', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        metadata: { taskCreated: 'task-123' },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByTestId('task-badge')).toBeInTheDocument();
      expect(screen.getByText('task-123')).toBeInTheDocument();
    });

    it('shows timing badge when responseTimeMs metadata exists', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        metadata: { responseTimeMs: 450 },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByTestId('timing-badge')).toBeInTheDocument();
      expect(screen.getByText('450ms')).toBeInTheDocument();
    });

    it('formats timing badge in seconds for values >= 1000ms', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        metadata: { responseTimeMs: 2500 },
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('2.5s')).toBeInTheDocument();
    });
  });

  describe('error state', () => {
    it('shows error message for error status', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        status: 'error',
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('Failed to deliver')).toBeInTheDocument();
    });

    it('has error-status class', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        status: 'error',
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByTestId('chat-message')).toHaveClass('error-status');
    });
  });

  describe('markdown formatting', () => {
    it('renders inline code', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        content: 'Use `console.log` for debugging',
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('console.log')).toHaveClass('inline-code');
    });

    it('renders code blocks', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        content: '```javascript\nconst x = 1;\n```',
        contentType: 'markdown',
      };
      render(<ChatMessage message={msg} />);
      expect(screen.getByText('const x = 1;')).toBeInTheDocument();
    });

    it('renders bold text', () => {
      const msg: ChatMessageType = {
        ...baseMessage,
        content: 'This is **bold** text',
      };
      render(<ChatMessage message={msg} />);
      const boldEl = screen.getByText('bold');
      expect(boldEl.tagName.toLowerCase()).toBe('strong');
    });
  });
});
