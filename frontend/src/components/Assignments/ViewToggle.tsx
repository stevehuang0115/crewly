import React from 'react';
import { FolderOpen, Users } from 'lucide-react';
import { SegmentedControl } from '@crewly/ui/SegmentedControl';
import { ViewToggleProps } from './types';

/**
 * Projects / Teams view switch for the assignments page.
 *
 * @param props - Current view mode, the lists (for counts) and the change handler
 * @returns The segmented view switch
 */
export const ViewToggle: React.FC<ViewToggleProps> = ({
  viewMode,
  assignedProjects,
  assignedTeams,
  onViewModeChange,
}) => {
  return (
    <SegmentedControl
      className="view-toggle"
      aria-label="Assignments view"
      options={[
        { value: 'projects', label: `Projects (${assignedProjects.length})`, icon: FolderOpen },
        { value: 'teams', label: `Teams (${assignedTeams.length})`, icon: Users },
      ]}
      value={viewMode}
      onChange={onViewModeChange}
    />
  );
};
