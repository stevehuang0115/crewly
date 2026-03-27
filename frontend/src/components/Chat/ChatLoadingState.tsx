/**
 * Chat Loading State Component
 *
 * Shared loading indicator for chat panels. Displays a centered spinner
 * with configurable message text, using the LoadingSpinner UI component.
 *
 * @module components/Chat/ChatLoadingState
 */

import React from 'react';
import { LoadingSpinner } from '../UI/LoadingSpinner';

// =============================================================================
// Types
// =============================================================================

interface ChatLoadingStateProps {
  /** Loading message text displayed below the spinner */
  message?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Centered loading state for chat panels.
 *
 * @param message - Text displayed below the spinner (default: "Loading...")
 * @returns JSX element with centered spinner and label
 */
export const ChatLoadingState: React.FC<ChatLoadingStateProps> = ({
  message = 'Loading...',
}) => (
  <div
    className="flex flex-col items-center justify-center h-full gap-3"
    data-testid="chat-loading"
  >
    <LoadingSpinner size="lg" text={message} />
  </div>
);

ChatLoadingState.displayName = 'ChatLoadingState';
