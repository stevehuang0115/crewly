import React from 'react';
import { Monitor } from 'lucide-react';
import { Card } from '@crewly/ui/Card';
import { EmptyState } from '@crewly/ui/EmptyState';
import { EmptyTerminalStateProps } from './types';

/**
 * Placeholder shown when no team terminal is selected.
 *
 * @param props - Extra classes for the empty state
 * @returns The empty-terminal card
 */
export const EmptyTerminalState: React.FC<EmptyTerminalStateProps> = ({
  className = ''
}) => {
  return (
    <Card padding="none" className="shadow-md">
      <EmptyState
        icon={Monitor}
        title="No terminal selected"
        description="Select a team from the Teams tab to view its terminal."
        className={className}
      />
    </Card>
  );
};
