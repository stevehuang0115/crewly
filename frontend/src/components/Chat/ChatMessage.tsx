/**
 * Chat Message Component
 *
 * Displays an individual chat message with sender info and content.
 *
 * @module components/Chat/ChatMessage
 */

import React, { useState } from 'react';
import { ChatMessage as ChatMessageType } from '../../types/chat.types';
import { formatRelativeTime } from '../../utils/time';
import { segmentSensitiveData, REDACTED_CLASS } from '../../utils/security';
import { Avatar } from '../UI/Avatar';
import { Badge } from '../UI/Badge';
import { Button } from '../UI/Button';
import './ChatMessage.css';

// =============================================================================
// Types
// =============================================================================

interface ChatMessageProps {
  /** The message to display */
  message: ChatMessageType;
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get display name for a sender
 */
function getSenderName(message: ChatMessageType): string {
  if (message.from.name) return message.from.name;
  switch (message.from.type) {
    case 'user':
      return 'You';
    case 'orchestrator':
      return 'Orchestrator';
    case 'agent':
      return message.from.role ?? 'Agent';
    case 'system':
      return 'System';
    default:
      return 'Unknown';
  }
}

/**
 * Get icon label for a sender (text-based, no emoji)
 */
function getSenderIcon(message: ChatMessageType): string {
  switch (message.from.type) {
    case 'user':
      return 'U';
    case 'orchestrator':
      return 'O';
    case 'agent':
      return 'A';
    case 'system':
      return 'S';
    default:
      return 'C';
  }
}

/**
 * Get Tailwind classes for sender avatar background color based on type.
 *
 * @param message - Chat message to determine sender type
 * @returns Tailwind class string for avatar styling
 */
function getSenderAvatarClass(message: ChatMessageType): string {
  switch (message.from.type) {
    case 'user':
      return '!bg-primary text-white !border-0';
    case 'orchestrator':
      return '!bg-emerald-500 text-white !border-0';
    case 'agent':
      return '!bg-yellow-500 text-white !border-0';
    case 'system':
      return '!bg-gray-500 text-white !border-0';
    default:
      return '';
  }
}

/**
 * Render a text string with sensitive data masked and styled.
 * Splits text into normal and redacted segments for distinct rendering.
 *
 * @param text - Text that may contain sensitive data
 * @param keyPrefix - React key prefix for generated elements
 * @returns Array of React nodes with redacted placeholders styled
 */
function renderMaskedText(text: string, keyPrefix: string): React.ReactNode {
  const segments = segmentSensitiveData(text);
  return segments.map((seg, i) =>
    seg.type === 'redacted' ? (
      <span key={`${keyPrefix}-${i}`} className={REDACTED_CLASS} title="Sensitive data redacted">
        {seg.content}
      </span>
    ) : (
      <React.Fragment key={`${keyPrefix}-${i}`}>{seg.content}</React.Fragment>
    )
  );
}

/**
 * Format message content - basic markdown support with sensitive data masking.
 * All text segments are passed through the security masking pipeline before rendering.
 */
function formatContent(content: string): React.ReactNode {
  // Split by code blocks first
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, index) => {
    // Code block — mask sensitive data inside code blocks too
    if (part.startsWith('```') && part.endsWith('```')) {
      const codeContent = part.slice(3, -3);
      const firstLineEnd = codeContent.indexOf('\n');
      const language =
        firstLineEnd > 0 ? codeContent.slice(0, firstLineEnd).trim() : '';
      const code =
        firstLineEnd > 0 ? codeContent.slice(firstLineEnd + 1) : codeContent;

      return (
        <pre key={index} className="code-block" data-language={language}>
          <code>{renderMaskedText(code, `code-${index}`)}</code>
        </pre>
      );
    }

    // Regular text - apply inline formatting (with masking)
    return (
      <span key={index}>
        {formatInlineContent(part)}
      </span>
    );
  });
}

/**
 * Format inline content (bold, italic, inline code) with sensitive data masking.
 * Text segments that are not code or bold are passed through the masking pipeline.
 */
function formatInlineContent(text: string): React.ReactNode {
  // Split by inline code
  const parts = text.split(/(`[^`]+`)/g);

  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={index} className="inline-code">
          {renderMaskedText(part.slice(1, -1), `ic-${index}`)}
        </code>
      );
    }

    // Apply bold and italic
    const boldRegex = /\*\*([^*]+)\*\*/g;
    const boldParts = part.split(boldRegex);
    if (boldParts.length > 1) {
      return (
        <React.Fragment key={index}>
          {boldParts.map((boldPart, i) =>
            i % 2 === 1 ? (
              <strong key={`bold-${index}-${i}`}>{renderMaskedText(boldPart, `b-${index}-${i}`)}</strong>
            ) : (
              <React.Fragment key={`text-${index}-${i}`}>{renderMaskedText(boldPart, `t-${index}-${i}`)}</React.Fragment>
            )
          )}
        </React.Fragment>
      );
    }

    // Plain text — mask sensitive data
    return <React.Fragment key={index}>{renderMaskedText(part, `p-${index}`)}</React.Fragment>;
  });
}

// =============================================================================
// Component
// =============================================================================

/**
 * Individual chat message component.
 *
 * Displays message content with sender information, timestamp,
 * and optional raw output toggle.
 *
 * @param message - The chat message to display
 * @returns JSX element with message content
 */
export const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const [showRaw, setShowRaw] = useState(false);

  const isUser = message.from.type === 'user';
  const isSystem = message.from.type === 'system';
  const hasRawOutput = Boolean(message.metadata?.rawOutput);

  /**
   * Render message content based on type and state
   */
  const renderContent = () => {
    if (showRaw && message.metadata?.rawOutput) {
      return (
        <pre className="raw-output" data-testid="raw-output">
          {renderMaskedText(message.metadata.rawOutput, 'raw')}
        </pre>
      );
    }

    if (
      message.contentType === 'code' ||
      message.contentType === 'markdown' ||
      message.contentType === 'text'
    ) {
      return <div className="formatted-content">{formatContent(message.content)}</div>;
    }

    // Fallback: plain text with masking
    return <p>{renderMaskedText(message.content, 'plain')}</p>;
  };

  const classNames = [
    'chat-message',
    message.from.type,
    isUser ? 'user-message' : '',
    isSystem ? 'system-message' : '',
    message.status === 'error' ? 'error-status' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames} data-testid="chat-message">
      <div className="message-header">
        <Avatar
          src={getSenderIcon(message)}
          name={getSenderName(message)}
          size="sm"
          showRing={false}
          className={getSenderAvatarClass(message)}
        />
        <span className="sender-name">{getSenderName(message)}</span>
        <span className="message-time">{formatRelativeTime(message.timestamp)}</span>
        {hasRawOutput && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRaw(!showRaw)}
            title={showRaw ? 'Show formatted' : 'Show raw output'}
            aria-label={showRaw ? 'Show formatted' : 'Show raw output'}
            data-testid="toggle-raw-button"
            className="toggle-raw-btn"
          >
            {showRaw ? 'Fmt' : 'Raw'}
          </Button>
        )}
      </div>

      <div className="message-content">{renderContent()}</div>

      {(message.metadata?.skillUsed || message.metadata?.taskCreated || message.metadata?.responseTimeMs) && (
        <div className="message-metadata">
          {message.metadata?.skillUsed && (
            <span data-testid="skill-badge">
              <Badge variant="primary" size="sm" className="skill-badge gap-1.5">
                <span className="skill-badge-icon" aria-hidden="true">S</span>
                {message.metadata.skillUsed}
              </Badge>
            </span>
          )}
          {message.metadata?.taskCreated && (
            <span data-testid="task-badge">
              <Badge variant="warning" size="sm" className="task-badge gap-1.5">
                <span className="task-badge-icon" aria-hidden="true">T</span>
                {message.metadata.taskCreated}
              </Badge>
            </span>
          )}
          {message.metadata?.responseTimeMs && (
            <span data-testid="timing-badge">
              <Badge variant="default" size="sm" className="timing-badge">
                {message.metadata.responseTimeMs < 1000
                  ? `${message.metadata.responseTimeMs}ms`
                  : `${(message.metadata.responseTimeMs / 1000).toFixed(1)}s`}
              </Badge>
            </span>
          )}
        </div>
      )}

      {message.status === 'error' && (
        <div className="message-error" role="alert">
          Failed to deliver
        </div>
      )}
    </div>
  );
};

export default ChatMessage;
