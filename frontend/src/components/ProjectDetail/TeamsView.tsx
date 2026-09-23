import React from 'react';
import { Users, UserPlus, FolderOpen } from 'lucide-react';
import { Team } from '../../types';
import { TeamsViewProps } from './types';
import { OverflowMenu } from '@crewly/ui/OverflowMenu';
import { Badge } from '@crewly/ui/Badge';
import { EmptyState } from '@crewly/ui/EmptyState';

const TeamsView: React.FC<TeamsViewProps> = ({ 
  assignedTeams, 
  onUnassignTeam, 
  openTerminalWithSession,
  onAssignTeam,
  projectName,
  onViewTeam,
  onEditTeam
}) => {
  return (
    <div className="teams-view">
      <div className="teams-header">
        <h3 className="text-xl font-semibold">Assigned Teams</h3>
        <p className="teams-description">Teams currently working on this project</p>
      </div>
      
      {assignedTeams.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {assignedTeams.map((team) => {
            const isActive = team.members.some(m => m.agentStatus === 'active');
            const firstAvatar = team.members[0]?.avatar;
            const memberAvatars = team.members.slice(0, 3);
            const extraCount = Math.max(team.members.length - 3, 0);
            return (
              <div key={team.id} className="bg-surface-dark border border-border-dark rounded-xl p-5 hover:border-primary/50 transition-colors relative">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h4 className="text-lg font-semibold">{team.name}</h4>
                    <div className="mt-2 space-y-2 text-sm">
                      <div className="flex items-center gap-2 text-text-secondary-dark">
                        <Users className="w-4 h-4" />
                        <span>{team.members.length} Members</span>
                      </div>
                      {projectName && (
                        <div className="flex items-center gap-2 text-text-secondary-dark">
                          <FolderOpen className="w-4 h-4" />
                          <span>Project: {projectName}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <Badge variant={isActive ? 'success' : 'default'}>{isActive ? 'active' : 'inactive'}</Badge>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                  {memberAvatars.map((m, idx) => (
                    m.avatar ? (
                      (m.avatar.startsWith('http') || m.avatar.startsWith('data:')) ? (
                        <img key={m.id}
                          src={m.avatar}
                          alt={m.name}
                          className="w-8 h-8 rounded-full ring-2 ring-surface-dark object-cover"
                          title={m.name}
                          style={{ marginLeft: idx === 0 ? 0 : -6 }}
                        />
                      ) : (
                        <div key={m.id}
                          className="w-8 h-8 rounded-full bg-background-dark border border-border-dark flex items-center justify-center ring-2 ring-surface-dark"
                          title={m.name}
                          style={{ marginLeft: idx === 0 ? 0 : -6 }}
                        >{m.avatar}</div>
                      )
                    ) : (
                      <div key={m.id}
                        className="w-8 h-8 rounded-full bg-background-dark border border-border-dark flex items-center justify-center ring-2 ring-surface-dark"
                        title={m.name}
                        style={{ marginLeft: idx === 0 ? 0 : -6 }}
                      >{m.name.charAt(0).toUpperCase()}</div>
                    )
                  ))}
                  {extraCount > 0 && (
                    <div className="w-8 h-8 rounded-full bg-background-dark border border-border-dark flex items-center justify-center text-xs text-text-secondary-dark ring-2 ring-surface-dark" style={{ marginLeft: -6 }}>+{extraCount}</div>
                  )}
                  </div>
                  <OverflowMenu
                    align="bottom-right"
                    items={[
                      { label: 'Edit Team', onClick: () => (onEditTeam ? onEditTeam(team.id) : onViewTeam && onViewTeam(team.id)) },
                      { label: 'View Team', onClick: () => onViewTeam && onViewTeam(team.id) },
                      { label: 'Open Terminal', onClick: () => {
                          const memberWithSession = team.members.find(m => m.sessionName);
                          if (memberWithSession?.sessionName) openTerminalWithSession(memberWithSession.sessionName);
                        }
                      },
                      { label: 'Unassign', danger: true, onClick: () => onUnassignTeam(team.id, team.name) }
                    ]}
                  />
                </div>
              </div>
            );
          })}

          {/* Assign new team tile */}
          <button
            type="button"
            onClick={onAssignTeam}
            className="flex items-center justify-center p-6 rounded-xl border-2 border-dashed border-border-dark hover:border-primary/50 hover:text-primary transition-colors text-text-secondary-dark"
          >
            <div className="flex flex-col items-center">
              <UserPlus className="w-10 h-10 mb-2" />
              <span className="font-medium">Assign New Team</span>
            </div>
          </button>
        </div>
      ) : (
        <EmptyState
          className="empty-teams"
          icon={Users}
          title="No teams assigned"
          description="Assign teams to this project to start collaborative development."
        />
      )}
    </div>
  );
};

export default TeamsView;
export { TeamsView };
