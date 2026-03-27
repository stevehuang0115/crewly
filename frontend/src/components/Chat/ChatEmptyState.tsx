/**
 * Chat Empty State Component
 *
 * Welcome message shown when a conversation has no messages yet.
 * Displays a greeting and 4 suggestion bullets to guide the user.
 *
 * @module components/Chat/ChatEmptyState
 */

import React from 'react';

// =============================================================================
// Component
// =============================================================================

/**
 * Empty state with welcome message and suggestion list.
 *
 * Rendered by ChatPanel and ThreadDetailPanel when messages.length === 0.
 *
 * @returns JSX element with welcome heading and 4 suggestions
 */
export const ChatEmptyState: React.FC = () => (
  <div
    className="flex-1 flex justify-center items-center p-8"
    data-testid="empty-chat"
  >
    <div className="text-center max-w-sm">
      <h3 className="text-xl font-semibold text-text-primary-dark mb-3">
        Welcome to Crewly
      </h3>
      <p className="text-text-secondary-dark mb-4">
        Start a conversation with the Orchestrator.
      </p>
      <p className="text-text-secondary-dark mb-2">Try asking to:</p>
      <ul className="text-left text-text-secondary-dark space-y-2 pl-6 list-disc marker:text-primary">
        <li>Create a new project</li>
        <li>Assign a task to an agent</li>
        <li>Check project status</li>
        <li>Configure a team</li>
      </ul>
    </div>
  </div>
);

ChatEmptyState.displayName = 'ChatEmptyState';
