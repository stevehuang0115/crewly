import React from 'react';
import { Plus, Clock, CheckCircle } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { EmptyState as UiEmptyState } from '@crewly/ui/EmptyState';

interface EmptyStateProps {
  type: 'active' | 'completed' | 'logs';
  onCreateMessage?: () => void;
}

/**
 * Empty states for the scheduled-messages tabs and the delivery log.
 *
 * @param props - Which list is empty, plus the create handler for the active list
 * @returns The empty state, or null for an unknown type
 */
export const EmptyState: React.FC<EmptyStateProps> = ({ type, onCreateMessage }) => {
  if (type === 'active') {
    return (
      <UiEmptyState
        className="py-16"
        icon={Clock}
        title="No active messages"
        description="Create your first scheduled message to send messages to teams and projects"
        action={
          <Button icon={Plus} onClick={onCreateMessage}>
            Create Scheduled Message
          </Button>
        }
      />
    );
  }

  if (type === 'completed') {
    return (
      <UiEmptyState
        className="py-16"
        icon={CheckCircle}
        title="No completed messages"
        description="Completed one-time messages and deactivated recurring messages will appear here"
      />
    );
  }

  if (type === 'logs') {
    return (
      <div className="text-center py-6">
        <p className="text-sm text-text-secondary-dark">No delivery logs yet</p>
      </div>
    );
  }

  return null;
};
