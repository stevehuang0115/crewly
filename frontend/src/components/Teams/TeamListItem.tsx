import React from 'react';
import { Users } from 'lucide-react';
import { Team } from '@/types';
import { OverflowMenu } from '@/components/UI/OverflowMenu';
import { MemberAvatar } from '@/components/common/MemberAvatar';

interface TeamListItemProps {
  team: Team;
  onClick?: () => void;
  onViewTeam?: (teamId: string) => void;
  onEditTeam?: (teamId: string) => void;
  onDeleteTeam?: (teamId: string) => void;
  /** Open this team's conversation in the consolidated chat. */
  onOpenChat?: (teamId: string) => void;
  /** Open this team's wiki vault. */
  onOpenWiki?: (teamId: string) => void;
  projectName?: string;
}

export const TeamListItem: React.FC<TeamListItemProps> = ({
  team,
  onClick,
  onViewTeam,
  onEditTeam,
  onDeleteTeam,
  onOpenChat,
  onOpenWiki,
  projectName
}) => {
  const members = team.members || [];
  const hasActiveMembers = members.some(member => member.agentStatus === 'active');

  return (
    <div className="flex items-center justify-between p-4 bg-surface-dark rounded-lg border border-border-dark hover:bg-background-dark hover:border-primary/50 transition-colors group">
      <div
        className="flex items-center gap-4 flex-grow cursor-pointer"
        onClick={onClick}
      >
        <div className="p-3 bg-background-dark rounded-lg border border-transparent group-hover:border-primary/20 transition-colors">
          <Users className="text-text-secondary-dark group-hover:text-primary transition-colors" />
        </div>
        <div className="flex items-center gap-3">
          <div>
            <p className="font-semibold text-text-primary-dark">{team.name}</p>
            <p className="text-sm text-text-secondary-dark">{projectName || (team.projectIds?.length > 0 ? team.projectIds.join(', ') : 'No Project')}</p>
          </div>
          {hasActiveMembers && (
            <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-500/10 text-green-400">
              Active
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-6">
        <div className="hidden md:flex -space-x-2">
          {members.slice(0, 4).map((member, index) => (
            <MemberAvatar
              key={member.id || index}
              name={member.name}
              avatar={member.avatar}
              size="sm"
              className="border-2 border-surface-dark"
            />
          ))}
          {members.length > 4 && (
            <div className="w-8 h-8 rounded-full border-2 border-surface-dark bg-background-dark flex items-center justify-center text-xs font-medium text-text-secondary-dark">
              +{members.length - 4}
            </div>
          )}
        </div>
        <div className="hidden sm:flex items-center gap-2 text-sm text-text-secondary-dark w-28">
          <Users className="text-base" />
          <span>{members.length} Members</span>
        </div>
        <div onClick={(e) => e.preventDefault()}>
          <OverflowMenu
            align="bottom-right"
            items={[
              ...(onViewTeam ? [{ label: 'View Team', onClick: () => onViewTeam(team.id) }] : []),
              ...(onEditTeam ? [{ label: 'Edit Team', onClick: () => onEditTeam(team.id) }] : []),
              ...(onOpenChat ? [{ label: 'Open Chat', onClick: () => onOpenChat(team.id) }] : []),
              ...(onOpenWiki ? [{ label: 'Open Wiki', onClick: () => onOpenWiki(team.id) }] : []),
              ...(onDeleteTeam ? [{ label: 'Delete Team', danger: true, onClick: () => onDeleteTeam(team.id) }] : [])
            ]}
          />
        </div>
      </div>
    </div>
  );
};

export default TeamListItem;
