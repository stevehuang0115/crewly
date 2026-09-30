import React from 'react';
import { TeamMemberRow } from './TeamMemberRow';
import { MembersListProps } from './types';
import { getTeamLeadIds } from '../../utils/team.utils';

export const MembersList: React.FC<MembersListProps> = ({
  team,
  teamId,
  onUpdateMember,
  onDeleteMember,
  onStartMember,
  onStopMember,
  onViewTerminal,
  onViewAgent,
  isStartingTeam,
  onMakeLead,
}) => {
  const leadIds = new Set(getTeamLeadIds(team ?? {}));
  return (
    <div className="space-y-4">
      {team?.members?.map((member) => (
        <TeamMemberRow
          key={member.id}
          member={member}
          teamId={teamId}
          onStart={onStartMember}
          onStop={onStopMember}
          onViewTerminal={onViewTerminal}
          onViewAgent={onViewAgent}
          isStartingTeam={isStartingTeam}
          isLead={leadIds.has(member.id)}
          onMakeLead={member.role === 'orchestrator' ? undefined : onMakeLead}
        />
      ))}
      {!team?.members?.length && (
        <div className="empty-state">
          <p>No team members yet. Add members to get started.</p>
        </div>
      )}
    </div>
  );
};
