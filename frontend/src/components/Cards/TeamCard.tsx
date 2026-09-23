import React from 'react';
import { Users, FolderOpen, User } from 'lucide-react';
import { Team, TeamMember } from '@/types';
import { useTerminal } from '@/contexts/TerminalContext';
import { Card } from '@crewly/ui/Card';

interface TeamCardProps {
  team: Team;
  onMemberClick?: (member: TeamMember) => void;
  onClick?: () => void;
}

export const TeamCard: React.FC<TeamCardProps> = ({
  team,
  onMemberClick,
  onClick
}) => {
  const { openTerminalWithSession } = useTerminal();
  const lastActivity = new Date(team.updatedAt).toLocaleDateString();
  const members = team.members || [];

  const handleMemberClick = (e: React.MouseEvent, member: TeamMember) => {
    e.stopPropagation(); // Prevent team card click
    
    // If member has active session, open terminal with that session
    if (member.sessionName) {
      openTerminalWithSession(member.sessionName);
    } else if (onMemberClick) {
      // Fallback to existing member click handler if no session
      onMemberClick(member);
    }
  };


  return (
    <Card
      padding="lg"
      interactive={!!onClick}
      className="transition-all hover:shadow-lg hover:border-primary/50 flex flex-col h-full"
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <h3 className="font-bold text-xl text-white mb-2">{team.name}</h3>
        </div>
      </div>

      {team.description && (
        <p className="text-sm text-text-secondary-dark mb-4">
          {team.description}
        </p>
      )}


      {team.projectIds?.length > 0 && (
        <div className="flex items-center gap-2 mb-4 text-sm text-text-secondary-dark">
          <FolderOpen className="h-4 w-4" />
          <span title={team.projectIds.join(', ')}>
            {team.projectIds.length === 1 ? team.projectIds[0] : `${team.projectIds.length} projects`}
          </span>
        </div>
      )}

      {members.length > 0 && (
        <div className="mt-auto pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center -space-x-2">
              {members.slice(0, 3).map((member) => {
                // Get initials from member name as fallback
                const initials = member.name
                  .split(' ')
                  .map(word => word.charAt(0).toUpperCase())
                  .join('')
                  .slice(0, 2);

                return (
                  <div
                    key={member.id}
                    className={`w-10 h-10 rounded-full border-2 border-surface-dark flex items-center justify-center text-sm font-bold text-white shadow-lg overflow-hidden transition-colors ${member.sessionName ? 'cursor-pointer hover:bg-primary/20 hover:text-primary' : ''}`}
                    onClick={(e) => handleMemberClick(e, member)}
                    title={member.sessionName ?
                      `${member.name} (${member.role}) - Active session: ${member.sessionName} (Click to open terminal)` :
                      `${member.name} (${member.role}) - No active session`
                    }
                  >
                    {member.avatar ? (
                      member.avatar.startsWith('http') || member.avatar.startsWith('data:') ? (
                        <img src={member.avatar} alt={member.name} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-sm">{member.avatar}</span>
                      )
                    ) : (
                      <div className="w-full h-full bg-gradient-to-br from-primary/20 to-primary/40 flex items-center justify-center">
                        {initials}
                      </div>
                    )}
                  </div>
                );
              })}
              {members.length > 3 && (
                <div className="w-10 h-10 rounded-full bg-background-dark border-2 border-surface-dark flex items-center justify-center text-sm font-medium text-text-secondary-dark shadow-lg">
                  +{members.length - 3}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
