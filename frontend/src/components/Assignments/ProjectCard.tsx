import React from 'react';
import { FolderOpen, Users, Clock, UserMinus, Activity } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { ProjectCardProps } from './types';

export const ProjectCard: React.FC<ProjectCardProps> = ({
  project,
  teams,
  onMemberClick,
  onOrchestratorClick,
  onUnassignTeam,
}) => {
  const projectTeams = teams.filter(team => team.projectIds?.includes(project.id));

  return (
    <div key={project.id} className="assignment-card project-card">
      <div className="assignment-header">
        <div className="project-info">
          <FolderOpen size={20} />
          <h3>{project.name}</h3>
        </div>
        <div className={`status-badge project-status-${project.status}`}>
          {project.status}
        </div>
      </div>
      <p className="assignment-description">{project.description}</p>
      <div className="assignment-meta">
        <div className="project-teams">
          <Users size={14} />
          <span>{projectTeams.length} team{projectTeams.length !== 1 ? 's' : ''} assigned</span>
        </div>
        <div className="project-path">
          <Clock size={14} />
          <span>{new Date(project.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
      {projectTeams.length > 0 && (
        <div className="project-teams-list">
          {projectTeams.map(team => (
            <div key={team.id} className="team-with-members">
              <div className="team-header-item">
                <span
                  className="team-chip clickable"
                  onClick={() => onOrchestratorClick()}
                  title="Click to view orchestrator terminal"
                >
                  <div className="team-avatar-small">
                    {team.members.length > 0 && team.members[0].avatar ? (
                      team.members[0].avatar.startsWith('http') || team.members[0].avatar.startsWith('data:') ? (
                        <img src={team.members[0].avatar} alt={team.name} className="w-4 h-4 rounded-full object-cover" />
                      ) : (
                        <span className="text-xs">{team.members[0].avatar}</span>
                      )
                    ) : (
                      <span className="text-xs">{team.name.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <span className={`status-dot status-${team.members.some(m => m.agentStatus === 'active') ? 'active' : 'inactive'}`}></span>
                  {team.name} ({team.members.length} members)
                </span>
                <IconButton
                  icon={UserMinus}
                  variant="danger-ghost"
                  size="sm"
                  className="unassign-team-btn small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onUnassignTeam(team.id, team.name, project.id);
                  }}
                  title="Unassign team from project"
                  aria-label="Unassign team from project"
                />
              </div>
              {team.members.length > 0 && (
                <div className="team-members-tree">
                  {team.members.map(member => (
                    <div
                      key={member.id}
                      className="member-tree-item clickable"
                      onClick={() => onMemberClick(member.id, member.name, team.id)}
                      title={`Click to view ${member.name}'s terminal`}
                    >
                      <div className="member-avatar-tiny">
                        {member.avatar ? (
                          member.avatar.startsWith('http') || member.avatar.startsWith('data:') ? (
                            <img src={member.avatar} alt={member.name} className="w-3 h-3 rounded-full object-cover" />
                          ) : (
                            <span className="text-xs">{member.avatar}</span>
                          )
                        ) : (
                          <span className="text-xs">{member.name.charAt(0).toUpperCase()}</span>
                        )}
                      </div>
                      <span className={`member-status-dot status-${member.agentStatus}`}></span>
                      <span className="member-name">{member.name}</span>
                      <span className="member-role">({member.role})</span>
                      {member.sessionName && (
                        <span className="session-indicator" title={`Session: ${member.sessionName}`}>
                          <Activity size={12} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};