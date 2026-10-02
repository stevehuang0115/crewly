/**
 * TeamsView — the project page's Teams tab (redesign, simplify level).
 *
 * One compact row per assigned team: name, "3 members · lead Owen", status
 * as colour + word, and "⋯" for view / edit / open terminal / unassign.
 * "Assign team" sits under the list.
 *
 * @module components/ProjectDetail/TeamsView
 */

import React from 'react';
import { UserPlus, Users } from 'lucide-react';
import { Button, CompactRow, StatusLabel, type OverflowMenuItem } from '@crewly/ui';
import { EmptyState } from '@crewly/ui/EmptyState';
import type { Team } from '../../types';
import { getTeamLeadIds } from '../../utils/team.utils';
import { TeamsViewProps } from './types';

/**
 * Meta line for a team row: member count and lead.
 *
 * @param team - Team
 * @returns e.g. "3 members · lead Owen"
 */
export function teamMembersMeta(team: Team): string {
  const members = team.members ?? [];
  const leadIds = new Set(getTeamLeadIds(team));
  const lead = members.find((m) => leadIds.has(m.id));
  const count = `${members.length} member${members.length === 1 ? '' : 's'}`;
  return lead ? `${count} · lead ${lead.name}` : count;
}

const TeamsView: React.FC<TeamsViewProps> = ({
  assignedTeams,
  onUnassignTeam,
  openTerminalWithSession,
  onAssignTeam,
  onViewTeam,
  onEditTeam,
}) => {
  return (
    <section aria-labelledby="project-teams-h" data-testid="project-teams-view">
      <h3 id="project-teams-h" className="mb-1 text-[13px] font-semibold text-text-2">
        Teams working on this project
      </h3>

      {assignedTeams.length > 0 ? (
        <div className="border-t border-border-soft">
          {assignedTeams.map((team) => {
            const members = team.members ?? [];
            const isActive = members.some((m) => m.agentStatus === 'active');
            const withSession = members.find((m) => m.sessionName);
            const overflow: OverflowMenuItem[] = [
              ...(onViewTeam ? [{ label: 'View team', onClick: () => onViewTeam(team.id) }] : []),
              { label: 'Edit team', onClick: () => (onEditTeam ? onEditTeam(team.id) : onViewTeam?.(team.id)) },
              ...(withSession?.sessionName
                ? [{ label: 'Open terminal', onClick: () => openTerminalWithSession(withSession.sessionName) }]
                : []),
              { label: 'Unassign', danger: true, separator: true, onClick: () => onUnassignTeam(team.id, team.name) },
            ];
            return (
              <CompactRow
                key={team.id}
                className="px-0"
                data-testid={`project-team-${team.id}`}
                onClick={onViewTeam ? () => onViewTeam(team.id) : undefined}
                primary={team.name}
                meta={
                  <span title={members.map((m) => m.name).join(', ') || undefined}>{teamMembersMeta(team)}</span>
                }
                trailing={<StatusLabel tone={isActive ? 'success' : 'neutral'}>{isActive ? 'Active' : 'Idle'}</StatusLabel>}
                overflow={overflow}
                overflowLabel={`More actions for ${team.name}`}
              />
            );
          })}
        </div>
      ) : (
        <EmptyState
          className="empty-teams"
          icon={Users}
          title="No teams assigned"
          description="Assign teams to this project to start collaborative development."
        />
      )}

      {onAssignTeam && (
        <Button variant="secondary" size="sm" icon={UserPlus} onClick={onAssignTeam} className="mt-4">
          Assign team
        </Button>
      )}
    </section>
  );
};

export default TeamsView;
export { TeamsView };
