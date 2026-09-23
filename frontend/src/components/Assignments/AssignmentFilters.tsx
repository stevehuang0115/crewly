import React from 'react';
import { FormSelect } from '@crewly/ui/Form';
import { AssignmentFiltersProps } from './types';

/**
 * Status + team filter selects for the assignments list.
 *
 * @param props - Current filter values, the assignments (for team names) and change handlers
 * @returns The filter controls
 */
export const AssignmentFilters: React.FC<AssignmentFiltersProps> = ({
  filterStatus,
  filterTeam,
  assignments,
  onStatusChange,
  onTeamChange,
}) => {
  const uniqueTeamNames = Array.from(new Set(assignments.map(a => a.teamName)));

  return (
    <div className="filter-controls flex flex-wrap items-center gap-2">
      <div className="w-40">
        <FormSelect
          aria-label="Filter by status"
          value={filterStatus}
          onChange={(e) => onStatusChange(e.target.value)}
        >
          <option value="all">All Status</option>
          <option value="todo">Todo</option>
          <option value="in-progress">In Progress</option>
          <option value="review">Review</option>
          <option value="done">Done</option>
        </FormSelect>
      </div>
      <div className="w-40">
        <FormSelect
          aria-label="Filter by team"
          value={filterTeam}
          onChange={(e) => onTeamChange(e.target.value)}
        >
          <option value="all">All Teams</option>
          {uniqueTeamNames.map(teamName => (
            <option key={teamName} value={teamName}>{teamName}</option>
          ))}
        </FormSelect>
      </div>
    </div>
  );
};
