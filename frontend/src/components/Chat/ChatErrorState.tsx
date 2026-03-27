/**
 * Chat Error State Component
 *
 * Shared error display for chat panels. Shows an Alert with the error
 * message and a Retry button that reloads the page.
 *
 * @module components/Chat/ChatErrorState
 */

import React from 'react';
import { Alert } from '../UI/Alert';
import { Button } from '../UI/Button';
import { RefreshCw } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

interface ChatErrorStateProps {
  /** Error message to display */
  error: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Centered error state for chat panels.
 *
 * Renders an Alert component with the error text and a primary Retry button
 * that triggers a full page reload.
 *
 * @param error - Error message string to display
 * @returns JSX element with error alert and retry button
 */
export const ChatErrorState: React.FC<ChatErrorStateProps> = ({ error }) => (
  <div
    className="flex items-center justify-center h-full p-8"
    data-testid="chat-error"
  >
    <div className="text-center max-w-xs">
      <Alert variant="error" className="mb-4">
        Error: {error}
      </Alert>
      <Button
        variant="primary"
        icon={RefreshCw}
        onClick={() => window.location.reload()}
      >
        Retry
      </Button>
    </div>
  </div>
);

ChatErrorState.displayName = 'ChatErrorState';
