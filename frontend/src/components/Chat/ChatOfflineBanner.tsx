/**
 * Chat Offline Banner Component
 *
 * Warning banner displayed when the orchestrator is offline.
 * Uses the shared Alert component with a navigation button to the Dashboard.
 *
 * @module components/Chat/ChatOfflineBanner
 */

import React from 'react';
import { Alert } from '../UI/Alert';
import { Button } from '../UI/Button';
import { useNavigate } from 'react-router-dom';

// =============================================================================
// Types
// =============================================================================

interface ChatOfflineBannerProps {
  /** Custom offline message (falls back to a default string) */
  message?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Warning banner for orchestrator-offline state.
 *
 * Renders an Alert with variant="warning", a title of "Orchestrator Offline",
 * the provided message, and a Dashboard navigation button.
 *
 * @param message - Optional offline message text
 * @returns JSX element with warning alert and Dashboard button
 */
export const ChatOfflineBanner: React.FC<ChatOfflineBannerProps> = ({
  message,
}) => {
  const navigate = useNavigate();

  return (
    <div data-testid="orchestrator-offline-banner">
      <Alert variant="warning" title="Orchestrator Offline" className="mx-4 mt-2">
        <div className="flex items-center justify-between gap-4">
          <span>{message || 'The orchestrator is not running.'}</span>
          <Button variant="primary" size="sm" onClick={() => navigate('/')}>
            Dashboard
          </Button>
        </div>
      </Alert>
    </div>
  );
};

ChatOfflineBanner.displayName = 'ChatOfflineBanner';
