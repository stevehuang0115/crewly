import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Users, Clock } from 'lucide-react';
import { Team, TeamMember, TeamMemberStatusChangeEvent } from '../types/index';
import { useTerminal } from '../contexts/TerminalContext';
import { StartTeamModal } from '../components/StartTeamModal';
import { TeamModal } from '../components/Modals/TeamModal';
import { TeamHeader, TeamOverview, TeamStatus, AgentDetailModal } from '../components/TeamDetail';
import { HierarchyDashboard } from '../components/Hierarchy';
import { ExecutionFeed } from '../components/ExecutionFeed';
import { useAlert, useConfirm } from '../components/UI/Dialog';
import { webSocketService } from '../services/websocket.service';
import { apiService } from '../services/api.service';
import { assignDefaultAvatars } from '../utils/team.utils';
import { LoadingSpinner } from '@/components/UI/LoadingSpinner';
import { CronJobPanel } from '@/components/Settings/CronJobPanel';

export const TeamDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { openTerminalWithSession } = useTerminal();
  const [team, setTeam] = useState<Team | null>(null);
  // Terminal functionality moved to centralized TerminalPanel
  const [loading, setLoading] = useState(true);
  const [orchestratorSessionActive, setOrchestratorSessionActive] = useState(false);
  const [showStartTeamModal, setShowStartTeamModal] = useState(false);
  const [showEditTeamModal, setShowEditTeamModal] = useState(false);
  const [showAgentDetailModal, setShowAgentDetailModal] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<TeamMember | null>(null);
  const [startTeamLoading, setStartTeamLoading] = useState(false);
  const [stopTeamLoading, setStopTeamLoading] = useState(false);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [subTeams, setSubTeams] = useState<Team[]>([]);
  const { showSuccess, showError, showWarning, AlertComponent } = useAlert();
  const { showConfirm, ConfirmComponent } = useConfirm();

  /**
   * Handle team member status change event from WebSocket.
   * Updates the team member's agentStatus in the local state.
   */
  const handleTeamMemberStatusChange = useCallback((data: TeamMemberStatusChangeEvent) => {
    // Only update if this event is for our team
    if (data.teamId === id) {
      setTeam(prevTeam => {
        if (!prevTeam) return prevTeam;
        return {
          ...prevTeam,
          members: prevTeam.members.map(member => {
            if (member.id === data.memberId || member.sessionName === data.sessionName) {
              return { ...member, agentStatus: data.agentStatus };
            }
            return member;
          }),
        };
      });
    }
  }, [id]);

  /**
   * Handle orchestrator status change event from WebSocket.
   * Updates the orchestrator session active state.
   */
  const handleOrchestratorStatusChange = useCallback((data: {
    sessionName: string;
    agentStatus: string;
  }) => {
    // Update orchestrator session active state based on agentStatus
    if (id === 'orchestrator' || team?.name === 'Orchestrator Team') {
      setOrchestratorSessionActive(data.agentStatus === 'active');
    }
  }, [id, team?.name]);

  useEffect(() => {
    if (id) {
      fetchTeamData();
      // Check orchestrator session status if this is the orchestrator team
      if (id === 'orchestrator' || (team?.name === 'Orchestrator Team')) {
        checkOrchestratorSession();
      }
    }
  }, [id, team?.name]);

  /**
   * Subscribe to WebSocket events for real-time status updates.
   */
  useEffect(() => {
    // Subscribe to status change events
    webSocketService.on('team_member_status_changed', handleTeamMemberStatusChange);
    webSocketService.on('orchestrator_status_changed', handleOrchestratorStatusChange);

    // Cleanup on unmount
    return () => {
      webSocketService.off('team_member_status_changed', handleTeamMemberStatusChange);
      webSocketService.off('orchestrator_status_changed', handleOrchestratorStatusChange);
    };
  }, [handleTeamMemberStatusChange, handleOrchestratorStatusChange]);

  useEffect(() => {
    if (team?.projectIds?.length > 0) {
      fetchProjectData(team.projectIds[0]);
    } else {
      setProjectName(null);
      setProjectPath(null);
    }
  }, [team?.projectIds]);

  /**
   * Fetch sub-teams (child teams) for the current team.
   */
  useEffect(() => {
    if (id) {
      fetchSubTeams();
    }
  }, [id]);

  const fetchSubTeams = async () => {
    try {
      const allTeams = await apiService.getTeams();
      const children = allTeams.filter(t => t.parentTeamId === id);
      setSubTeams(children);
    } catch (error) {
      console.error('Error fetching sub-teams:', error);
      setSubTeams([]);
    }
  };

  // Terminal output handled by centralized WebSocket system

  const fetchTeamData = async () => {
    try {
      const response = await fetch(`/api/teams/${id}`);
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data) {
          // Migrate team members to include default avatars if missing
          const migratedTeam = {
            ...result.data,
            members: assignDefaultAvatars(result.data.members),
          };

          setTeam(migratedTeam);
        }
      }
    } catch (error) {
      console.error('Error fetching team data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Terminal fetching logic removed - using centralized WebSocket system

  const checkOrchestratorSession = async () => {
    try {
      const response = await fetch('/api/terminal/sessions');
      if (response.ok) {
        const result = await response.json();
        if (result.success && result.data) {
          const hasOrcSession = result.data.some((session: any) =>
            session.sessionName === 'crewly-orc'
          );
          setOrchestratorSessionActive(hasOrcSession);
        }
      }
    } catch (error) {
      console.error('Error checking orchestrator session:', error);
      setOrchestratorSessionActive(false);
    }
  };

  const fetchProjectData = async (projectId: string) => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const result = await response.json();
        const projectsData = result.success ? (result.data || []) : (result || []);
        const project = projectsData.find((p: any) => p.id === projectId);
        setProjectName(project ? project.name : projectId);
        setProjectPath(project ? project.path : null);
      } else {
        setProjectName(projectId);
        setProjectPath(null);
      }
    } catch (error) {
      console.error('Error fetching project data:', error);
      setProjectName(projectId);
      setProjectPath(null);
    }
  };

  const handleStartTeam = async () => {
    // For orchestrator, start directly without showing the modal
    const isOrchestrator = team?.id === 'orchestrator' || team?.name === 'Orchestrator Team';
    if (isOrchestrator) {
      setStartTeamLoading(true);
      try {
        const result = await apiService.setupOrchestrator();

        if (result.success) {
          fetchTeamData();
          showSuccess(result.message || 'Orchestrator started successfully!');
        } else {
          showError(result.error || 'Failed to start orchestrator');
        }
      } catch (error) {
        console.error('Error starting orchestrator:', error);
        showError('Error starting orchestrator. Please try again.');
      } finally {
        setStartTeamLoading(false);
      }
      return;
    }

    // For regular teams, show the modal
    setShowStartTeamModal(true);
  };

  const handleStartTeamSubmit = async (projectId: string) => {
    setStartTeamLoading(true);
    try {
      const response = await fetch(`/api/teams/${id}/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectId,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        setShowStartTeamModal(false);
        fetchTeamData();
        // Terminal functionality moved to centralized WebSocket system
        // Show success message
        showSuccess(result.message || 'Team started successfully!');
      } else {
        showError(result.error || 'Failed to start team');
      }
    } catch (error) {
      console.error('Error starting team:', error);
      showError('Error starting team. Please try again.');
    } finally {
      setStartTeamLoading(false);
    }
  };

  const handleOpenEditTeam = () => {
    setShowEditTeamModal(true);
  };

  const handleEditTeamSubmit = async (teamData: any) => {
    if (!team) return;
    try {
      const response = await fetch(`/api/teams/${team.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(teamData),
      });
      if (response.ok) {
        fetchTeamData();
        setShowEditTeamModal(false);
      } else {
        const err = await response.json();
        showError(err.error || 'Failed to update team');
      }
    } catch (e) {
      console.error('Error updating team:', e);
      showError('Failed to update team');
    }
  };

  const handleStopTeam = async () => {
    setStopTeamLoading(true);
    try {
      // Special handling for orchestrator team
      if (team?.id === 'orchestrator' || team?.name === 'Orchestrator Team') {
        const response = await fetch('/api/orchestrator/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          fetchTeamData();
          checkOrchestratorSession();
        } else {
          const result = await response.json();
          showError(result.error || 'Failed to stop orchestrator');
        }
      } else {
        // Regular team stop
        const response = await fetch(`/api/teams/${id}/stop`, {
          method: 'POST',
        });
        if (response.ok) {
          fetchTeamData();
        }
      }
    } catch (error) {
      console.error('Error stopping team:', error);
    } finally {
      setStopTeamLoading(false);
    }
  };

  const handleDeleteTeam = async () => {
    if (!team) return;

    // Prevent deletion of orchestrator team
    if (team.id === 'orchestrator' || team.name === 'Orchestrator Team') {
      showWarning('The Orchestrator Team cannot be deleted as it is required for system operations.');
      return;
    }

    const executeDelete = async () => {
      try {
      // First stop the team to ensure sessions are terminated
      await fetch(`/api/teams/${id}/stop`, {
        method: 'POST',
      });

      // Then delete the team (this will also cleanup terminal sessions)
      const response = await fetch(`/api/teams/${id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        }
      });

      if (response.ok) {
        // Navigate back to teams page
        navigate('/teams');
      } else {
        const error = await response.text();
        showError('Failed to delete team: ' + error);
      }
    } catch (error) {
      console.error('Error deleting team:', error);
      showError('Failed to delete team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
    };

    showConfirm(
      `Are you sure you want to delete team "${team.name}"?\n\nThis will:\n• Delete the team and all its members\n• Kill all associated terminal sessions\n• Remove all team data permanently\n\nThis action cannot be undone.`,
      executeDelete,
      { type: 'error', title: 'Delete Team', confirmText: 'Delete', cancelText: 'Cancel' }
    );
  };

  const getTeamStatus = (): TeamStatus => {
    // For Orchestrator Team, check both terminal session AND member agentStatus.
    // orchestratorSessionActive checks if a PTY session exists, while agentStatus
    // reflects the agent's registered state (e.g. 'active' after MCP registration).
    if (team?.id === 'orchestrator' || team?.name === 'Orchestrator Team') {
      const orchestratorMember = team?.members?.[0];
      const memberActive = orchestratorMember?.agentStatus === 'active'
        || orchestratorMember?.agentStatus === 'started';
      return (orchestratorSessionActive || memberActive) ? 'active' : 'idle';
    }

    // For other teams, check if any members have active sessions
    const hasActiveSessions = team?.members?.some(m => m.sessionName);
    if (hasActiveSessions) {
      return 'active';
    }

    // No active sessions, team is idle
    return 'idle';
  };

  const handleViewTerminal = () => {
    // For Orchestrator Team, open terminal with crewly-orc session
    if (team?.id === 'orchestrator' || team?.name === 'Orchestrator Team') {
      openTerminalWithSession('crewly-orc');
    }
  };

  const handleViewMemberTerminal = (member: TeamMember) => {
    // Open terminal for specific team member session
    if (member.sessionName) {
      openTerminalWithSession(member.sessionName);
    }
  };

  const handleViewAgent = (member: TeamMember) => {
    setSelectedAgent(member);
    setShowAgentDetailModal(true);
  };

  const handleAddMember = async (member: { name: string; role: string }) => {
    if (!member.name.trim() || !member.role.trim()) {
      showWarning('Please fill in both name and role');
      return;
    }

    try {
      const response = await fetch(`/api/teams/${id}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(member),
      });

      if (response.ok) {
        fetchTeamData();
      } else {
        const error = await response.text();
        showError('Failed to add member: ' + error);
      }
    } catch (error) {
      console.error('Error adding member:', error);
      showError('Failed to add member');
    }
  };

  const handleUpdateMember = async (memberId: string, updates: Partial<TeamMember>) => {
    try {
      // If updating runtime type, use the specific runtime endpoint
      if ('runtimeType' in updates && updates.runtimeType) {
        const response = await fetch(`/api/teams/${id}/members/${memberId}/runtime`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ runtimeType: updates.runtimeType }),
        });

        if (response.ok) {
          fetchTeamData();
          return;
        } else {
          const result = await response.json();
          showError('Failed to update member runtime: ' + (result.error || 'Unknown error'));
          return;
        }
      }

      // For other updates, use the general member update endpoint
      const response = await fetch(`/api/teams/${id}/members/${memberId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updates),
      });

      if (response.ok) {
        fetchTeamData();
      } else {
        const error = await response.text();
        showError('Failed to update member: ' + error);
      }
    } catch (error) {
      console.error('Error updating member:', error);
      showError('Failed to update member');
    }
  };

  const handleDeleteMember = async (memberId: string) => {
    try {
      const response = await fetch(`/api/teams/${id}/members/${memberId}`, {
        method: 'DELETE',
      });

      if (response.ok) {
        fetchTeamData();
      } else {
        const error = await response.text();
        showError('Failed to remove member: ' + error);
      }
    } catch (error) {
      console.error('Error removing member:', error);
      showError('Failed to remove member');
    }
  };

  const handleStartMember = async (memberId: string) => {
    try {
      // Special handling for orchestrator team
      if (team?.id === 'orchestrator' || team?.name === 'Orchestrator Team') {
        const result = await apiService.setupOrchestrator();

        if (result.success) {
          // Refresh team data and orchestrator session status
          fetchTeamData();
          checkOrchestratorSession();
        } else {
          showError(result.error || 'Failed to setup orchestrator');
        }
      } else {
        // Regular team member start
        const response = await fetch(`/api/teams/${id}/members/${memberId}/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const result = await response.json();

        if (response.ok) {
          // Refresh team data to show updated status
          fetchTeamData();
        } else {
          showError(result.error || 'Failed to start team member');
        }
      }
    } catch (error) {
      console.error('Error starting team member:', error);
      showError('Error starting team member. Please try again.');
    }
  };

  const handleStopMember = async (memberId: string) => {
    try {
      // Special handling for orchestrator team
      if (team?.id === 'orchestrator' || team?.name === 'Orchestrator Team') {
        const response = await fetch('/api/orchestrator/stop', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const result = await response.json();

        if (response.ok) {
          // Refresh team data and orchestrator session status
          fetchTeamData();
          checkOrchestratorSession();
        } else {
          showError(result.error || 'Failed to stop orchestrator');
        }
      } else {
        // Regular team member stop
        const response = await fetch(`/api/teams/${id}/members/${memberId}/stop`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        });

        const result = await response.json();

        if (response.ok) {
          // Refresh team data to show updated status
          fetchTeamData();
        } else {
          showError(result.error || 'Failed to stop team member');
        }
      }
    } catch (error) {
      console.error('Error stopping team member:', error);
      showError('Error stopping team member. Please try again.');
    }
  };

  const handleProjectChange = async (projectId: string | null) => {
    try {
      const response = await fetch(`/api/teams/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          projectIds: projectId ? [projectId] : []
        }),
      });

      if (response.ok) {
        // Refresh team data to reflect the change
        await fetchTeamData();
      } else {
        const result = await response.json();
        showError(result.error || 'Failed to update team project');
      }
    } catch (error) {
      console.error('Error updating team project:', error);
      showError('Error updating team project. Please try again.');
    }
  };



  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <LoadingSpinner size="xl" text="Loading team details..." />
      </div>
    );
  }

  if (!team) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-16">
        <div className="text-center">
          <h2 className="text-2xl font-bold mb-4">Team not found</h2>
          <p className="text-text-secondary-dark">The requested team could not be found.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center gap-3 text-sm text-text-secondary-dark mb-1">
        <Link to="/teams" className="hover:text-primary">Teams</Link>
        <span className="text-text-secondary-dark">/</span>
        <span className="text-text-primary-dark">{team.name}</span>
      </div>
      <TeamHeader
        team={team}
        teamStatus={getTeamStatus()}
        orchestratorSessionActive={orchestratorSessionActive}
        onStartTeam={handleStartTeam}
        onStopTeam={handleStopTeam}
        onViewTerminal={handleViewTerminal}
        onDeleteTeam={handleDeleteTeam}
        onEditTeam={handleOpenEditTeam}
        isStoppingTeam={stopTeamLoading}
        isStartingTeam={startTeamLoading}
      />

      {/* Hierarchy Dashboard — show tree view and stats for hierarchical teams */}
      {team.hierarchical && (
        <div className="mb-6">
          <HierarchyDashboard
            team={team}
            onMemberClick={handleViewAgent}
          />
        </div>
      )}

      <TeamOverview
        team={team}
        teamId={id!}
        projectName={projectName}
        onUpdateMember={handleUpdateMember}
        onDeleteMember={handleDeleteMember}
        onStartMember={handleStartMember}
        onStopMember={handleStopMember}
        onProjectChange={handleProjectChange}
        onViewTerminal={handleViewMemberTerminal}
        onViewAgent={handleViewAgent}
        isStartingTeam={startTeamLoading}
      />

      {/* Execution Feed — real-time agent activity for this team */}
      <div className="mt-6">
        <ExecutionFeed teamId={id} maxEvents={100} />
      </div>

      {/* Team Cron Jobs */}
      <div className="mt-6">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="w-5 h-5 text-text-secondary-dark" />
          <h3 className="text-lg font-semibold">Cron Jobs</h3>
        </div>
        <CronJobPanel teamId={id} compact />
      </div>

      {/* Sub-teams section */}
      {subTeams.length > 0 && (
        <div className="mt-8">
          <h3 className="text-xl font-semibold mb-4">Sub-Teams ({subTeams.length})</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {subTeams.map(subTeam => {
              const hasActive = subTeam.members?.some(m => m.agentStatus === 'active');
              return (
                <div
                  key={subTeam.id}
                  className="bg-surface-dark border border-border-dark rounded-xl p-5 hover:border-primary/50 transition-colors cursor-pointer"
                  onClick={() => navigate(`/teams/${subTeam.id}`)}
                  data-testid={`sub-team-${subTeam.id}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-lg font-semibold">{subTeam.name}</div>
                    {hasActive && (
                      <span className="px-2 py-1 text-xs font-medium rounded-full bg-green-500/10 text-green-400">
                        Active
                      </span>
                    )}
                  </div>
                  {subTeam.description && (
                    <p className="text-sm text-text-secondary-dark mb-3">{subTeam.description}</p>
                  )}
                  <div className="flex items-center gap-2 text-sm text-text-secondary-dark">
                    <Users className="w-4 h-4" />
                    <span>{subTeam.members?.length || 0} member{(subTeam.members?.length || 0) !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Start Team Modal */}
      <StartTeamModal
        isOpen={showStartTeamModal}
        onClose={() => setShowStartTeamModal(false)}
        onStartTeam={handleStartTeamSubmit}
        team={team}
        loading={startTeamLoading}
      />

      {/* Edit Team Modal (reuses TeamModal) */}
      {showEditTeamModal && (
        <TeamModal
          isOpen={showEditTeamModal}
          onClose={() => setShowEditTeamModal(false)}
          onSubmit={handleEditTeamSubmit}
          team={team}
        />
      )}

      {/* Agent Detail Modal */}
      {showAgentDetailModal && selectedAgent && (
        <AgentDetailModal
          member={selectedAgent}
          onClose={() => {
            setShowAgentDetailModal(false);
            setSelectedAgent(null);
          }}
          isEditable={!selectedAgent.agentStatus || selectedAgent.agentStatus === 'inactive'}
          onSave={handleUpdateMember}
        />
      )}

      {/* Global alert/confirm dialogs */}
      <AlertComponent />
      <ConfirmComponent />
    </div>
  );
};
