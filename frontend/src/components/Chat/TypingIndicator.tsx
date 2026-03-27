/**
 * Typing Indicator Component
 *
 * Shows an animated indicator when the orchestrator is processing/typing.
 *
 * @module components/Chat/TypingIndicator
 */

import React from 'react';
import { Bot } from 'lucide-react';
import './TypingIndicator.css';

// =============================================================================
// Component
// =============================================================================

/**
 * Typing indicator shown when the orchestrator is processing a response.
 *
 * Displays an animated set of dots to indicate activity.
 *
 * @returns JSX element with typing indicator
 */
export const TypingIndicator: React.FC = () => {
  return (
    <div className="typing-indicator" data-testid="typing-indicator">
      <span className="sender-icon" aria-hidden="true">
        <Bot size={16} />
      </span>
      <span className="sender-name">Orchestrator</span>
      <div className="typing-dots" aria-label="Orchestrator is typing">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
};

export default TypingIndicator;
