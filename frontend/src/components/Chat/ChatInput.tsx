/**
 * Chat Input Component
 *
 * Text input for sending messages with auto-resize and keyboard shortcuts.
 *
 * @module components/Chat/ChatInput
 */

import React, { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { Send } from 'lucide-react';
import { useChat } from '../../contexts/ChatContext';
import { Button } from '../UI/Button';
import { Alert } from '../UI/Alert';
import './ChatInput.css';

// =============================================================================
// Types
// =============================================================================

/**
 * Props for ChatInput component
 */
interface ChatInputProps {
  /** Whether the input is disabled (e.g., orchestrator offline) */
  disabled?: boolean;
  /** Placeholder text when disabled */
  disabledPlaceholder?: string;
  /** Custom placeholder text (e.g., "Reply in thread...") */
  placeholder?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Chat input component with auto-resize and keyboard shortcuts.
 *
 * Features:
 * - Auto-resizing textarea
 * - Enter to send, Shift+Enter for new line
 * - Disabled state while sending or when orchestrator is offline
 * - Error display
 *
 * @param props - Component props
 * @returns JSX element with chat input
 */
export const ChatInput: React.FC<ChatInputProps> = ({
  disabled = false,
  disabledPlaceholder,
  placeholder: customPlaceholder,
}) => {
  const { sendMessage, isSending, error, clearError } = useChat();
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [input]);

  // Combined disabled state
  const isDisabled = disabled || isSending;

  /**
   * Handle form submission
   */
  const handleSubmit = async () => {
    if (!input.trim() || isDisabled) return;

    const message = input.trim();
    setInput('');
    clearError();

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    await sendMessage(message);
  };

  /**
   * Handle keyboard events for shortcuts
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Enter (without Shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /**
   * Handle input change
   */
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    if (error) {
      clearError();
    }
  };

  return (
    <div className="chat-input-container" data-testid="chat-input-container">
      {error && (
        <div data-testid="chat-input-error">
          <Alert variant="error" onClose={clearError} className="mx-1 mb-1">
            {error}
          </Alert>
        </div>
      )}

      <div className="input-wrapper">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            disabled && disabledPlaceholder
              ? disabledPlaceholder
              : customPlaceholder ?? 'Type a message... (Enter to send, Shift+Enter for new line)'
          }
          disabled={isDisabled}
          rows={1}
          className={`message-input ${disabled ? 'disabled-offline' : ''}`}
          data-testid="chat-message-input"
          aria-label="Message input"
        />

        <Button
          variant="primary"
          size="icon"
          icon={Send}
          loading={isSending}
          onClick={handleSubmit}
          disabled={!input.trim() || isDisabled}
          title={disabled ? 'Orchestrator offline' : 'Send message'}
          data-testid="chat-send-button"
          aria-label={isSending ? 'Sending message' : disabled ? 'Orchestrator offline' : 'Send message'}
        />
      </div>

      <div className="input-hints">
        <span>
          Press <kbd>Enter</kbd> to send
        </span>
        <span>
          <kbd>Shift</kbd> + <kbd>Enter</kbd> for new line
        </span>
      </div>
    </div>
  );
};

export default ChatInput;
