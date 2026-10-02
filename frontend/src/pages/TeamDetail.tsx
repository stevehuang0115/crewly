/**
 * Team page (`/teams/:id`, specs/2026-10-02-ui-redesign.md §Teams,
 * approved sample `simple/TeamDetail`).
 *
 * One job: who is on this crew and what each one is doing.
 * - Header: name, status, the team's goal sentence; Chat (and Start while
 *   idle) with stop / wiki / edit / change project / delete in "⋯".
 * - Members: one line each ("Owen — lead — working on CE-81") with Message
 *   (or Start) and "⋯" (make lead, view agent, terminal, stop, remove).
 * - Sub-teams, when it has any.
 * - "More" (collapsed): goals, norms & SOPs, project, cron jobs, live feed,
 *   recent activity and, for hierarchical teams, the hierarchy view.
 *
 * `?edit=true` opens the Edit team dialog (the lists' "Edit team" link).
 *
 * @module pages/TeamDetail
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Team, TeamMember, TeamMemberStatusChangeEvent } from '../types/index';
import { useTerminal } from '../contexts/TerminalContext';
import { StartTeamModal } from '../components/StartTeamModal';
import { TeamModal } from '../components/Modals/TeamModal';
import { TeamHeader, TeamStatus, AgentDetailModal, TeamObjectives } from '../components/TeamDetail';
import type { TeamMission } from '../components/TeamDetail/TeamObjectives';
import { TeamMemberLine } from '../components/TeamDetail/TeamMemberLine';
import { HierarchyDashboard } from '../components/Hierarchy';
import { ExecutionFeed } from '../components/ExecutionFeed';
import { useAlert, useConfirm } from '@crewly/ui/Dialog';
import { Button, CollapsibleSection, CompactRow, FormSelect, StatusLabel } from '@crewly/ui';
import { webSocketService } from '../services/websocket.service';
import { apiService } from '../services/api.service';
import { assignDefaultAvatars, getTeamLeadIds } from '../utils/team.utils';
import { TEAM_QUERY_PARAM, agentChatLink } from '../utils/team-chat.utils';
import { DASHBOARD_CALLER_HEADERS } from '../constants/caller.constants';
import { LINKS, ROUTES } from '../constants/routes.constants';
import { useProjects } from '../hooks/useProjects';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { CronJobPanel } from '@/components/Settings/CronJobPanel';

/** A sub-heading inside the "More" section. */
const MoreHeading: React.FC<{ children: React.ReactNode; id?: string }> = ({ children, id }) => (
  <h3 id={id} className="mb-2 text-[13px] font-semibold text-text-2">{children}</h3>
);

export const TeamDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
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
  /** This team's goals (undefined while loading; [] when none or on error) */
  const [teamMissions, setTeamMissions] = useState<TeamMission[] | undefined>(undefined);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const { projectOptions } = useProjects();
  const { showSuccess, showError, showWarning, AlertComponent } = useAlert();
  const { showConfirm, ConfirmComponent } = useConfirm();

  // This team's goals: the header sentence and the "More" list.
  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const all = (await apiService.getMissions()) as TeamMission[];
        if (!cancelled) setTeamMissions((Array.isArray(all) ? all : []).filter((m) => m && m.ownerTeamId === id));
      } catch {
        if (!cancelled) setTeamMissions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // "Edit team" links from the lists arrive as ?edit=true.
  useEffect(() => {
    if (searchParams.get('edit') !== 'true' || !team) return;
    const isOrc = team.id === 'orchestrator' || team.name === 'Orchestrator Team';
    if (!isOrc) setShowEditTeamModal(true);
    const next = new URLSearchParams(searchParams);
    next.delete('edit');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, team]);

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
        // Regular team member start. Marked as a dashboard action so the
        // backend knows the owner asked for it (not the orchestrator), and
        // does not hold it for chat approval (#775).
        const response = await fetch(`/api/teams/${id}/members/${memberId}/start`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...DASHBOARD_CALLER_HEADERS,
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

  /**
   * Make a member the team lead (POST /api/teams/:id/lead). Works on any
   * team — no hierarchical mode needed.
   *
   * @param memberId - Member to make lead
   */
  const handleMakeLead = async (memberId: string) => {
    try {
      const response = await fetch(`/api/teams/${id}/lead`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...DASHBOARD_CALLER_HEADERS },
        body: JSON.stringify({ memberId }),
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok) {
        fetchTeamData();
      } else {
        showError(result.error || 'Failed to change the team lead');
      }
    } catch (error) {
      console.error('Error changing team lead:', error);
      showError('Failed to change the team lead');
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



  /** Ask, then remove a member from the team. */
  const handleRemoveMember = (member: TeamMember) => {
    showConfirm(
      `Remove ${member.name} from the team?\n\nTheir terminal session is stopped and they are removed from "${team?.name}".`,
      () => handleDeleteMember(member.id),
      { type: 'warning', title: 'Remove member', confirmText: 'Remove', cancelText: 'Cancel' },
    );
  };

  /**
   * Message one member: a DM with that agent (`agentChatLink`, `/team-chat?agent=<session>`). A member
   * without a session falls back to the team conversation.
   */
  const handleMessage = (member: TeamMember) => {
    if (!team) return;
    if (member.sessionName) {
      navigate(agentChatLink(member.sessionName));
      return;
    }
    const isOrc = team.id === 'orchestrator' || team.name === 'Orchestrator Team';
    navigate(isOrc ? ROUTES.chat : `${ROUTES.chat}?${TEAM_QUERY_PARAM}=${team.id}`);
  };

  /** "⋯ › Change project": open More with the project picker. */
  const openProjectPicker = () => {
    setMoreOpen(true);
    setEditingProject(true);
  };

  const sortedMissions = useMemo(
    () => (teamMissions ? [...teamMissions].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1)) : undefined),
    [teamMissions],
  );

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

  const isOrc = team.id === 'orchestrator' || team.name === 'Orchestrator Team';
  const leadIds = new Set(getTeamLeadIds(team));
  const members = team.members ?? [];
  const headGoal = sortedMissions === undefined ? undefined : sortedMissions[0] ? { id: sortedMissions[0].id, objective: sortedMissions[0].objective } : null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <TeamHeader
        team={team}
        teamStatus={getTeamStatus()}
        orchestratorSessionActive={orchestratorSessionActive}
        onStartTeam={handleStartTeam}
        onStopTeam={handleStopTeam}
        onViewTerminal={handleViewTerminal}
        onDeleteTeam={handleDeleteTeam}
        onEditTeam={handleOpenEditTeam}
        onOpenChat={() => navigate(`${ROUTES.chat}?${TEAM_QUERY_PARAM}=${team.id}`)}
        onOpenWiki={() => navigate(`${ROUTES.wiki}?${TEAM_QUERY_PARAM}=${team.id}`)}
        onChangeProject={openProjectPicker}
        goal={headGoal}
        moreGoals={Math.max((sortedMissions?.length ?? 0) - 1, 0)}
        onOpenGoal={(goalId) => navigate(LINKS.goal(goalId))}
        onSetGoal={() => navigate(LINKS.goals())}
        isStoppingTeam={stopTeamLoading}
        isStartingTeam={startTeamLoading}
      />

      <div className="flex flex-col gap-8">
        {/* Who's working on what */}
        <section aria-labelledby="team-members-h" data-testid="team-members">
          <h2 id="team-members-h" className="mb-1 text-[13px] font-semibold text-text-2">
            {isOrc ? 'Orchestrator' : "Who's working on what"}
          </h2>
          {members.map((member) => (
            <TeamMemberLine
              key={member.id}
              member={member}
              isLead={leadIds.has(member.id)}
              isStartingTeam={startTeamLoading}
              onStart={handleStartMember}
              onStop={handleStopMember}
              onMakeLead={isOrc || member.role === 'orchestrator' ? undefined : handleMakeLead}
              onViewAgent={handleViewAgent}
              onViewTerminal={handleViewMemberTerminal}
              onMessage={handleMessage}
              onRemove={isOrc ? undefined : handleRemoveMember}
            />
          ))}
          {members.length === 0 && (
            <p className="border-t border-border-soft py-4 text-sm text-text-2">No team members yet. Add members to get started.</p>
          )}
        </section>

        {/* Sub-teams */}
        {subTeams.length > 0 && (
          <section aria-labelledby="team-subteams-h">
            <h2 id="team-subteams-h" className="mb-1 text-[13px] font-semibold text-text-2">Sub-Teams ({subTeams.length})</h2>
            <div className="border-t border-border-soft">
              {subTeams.map((subTeam) => {
                const hasActive = subTeam.members?.some((m) => m.agentStatus === 'active');
                const n = subTeam.members?.length || 0;
                return (
                  <CompactRow
                    key={subTeam.id}
                    className="px-0"
                    data-testid={`sub-team-${subTeam.id}`}
                    onClick={() => navigate(LINKS.team(subTeam.id))}
                    primary={subTeam.name}
                    meta={[subTeam.description, `${n} member${n !== 1 ? 's' : ''}`].filter(Boolean).join(' · ')}
                    trailing={<StatusLabel tone={hasActive ? 'success' : 'neutral'}>{hasActive ? 'Active' : 'Idle'}</StatusLabel>}
                  />
                );
              })}
            </div>
          </section>
        )}

        {/* Everything else, one click away */}
        <CollapsibleSection
          title="More"
          summary={isOrc ? 'Goals, norms & SOPs, cron jobs, live feed' : 'Goals, project, norms & SOPs, cron jobs, live feed, recent activity'}
          open={moreOpen}
          onOpenChange={setMoreOpen}
          unmountWhenClosed
          data-testid="team-more"
        >
          <div className="flex flex-col gap-8">
            <TeamObjectives teamId={id!} missions={teamMissions} />

            {!isOrc && (
              <section aria-labelledby="team-project-h" data-testid="team-project">
                <MoreHeading id="team-project-h">Project</MoreHeading>
                {editingProject ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <FormSelect
                      aria-label="Assigned project"
                      value={team.projectIds?.[0] || ''}
                      onChange={(e) => {
                        void handleProjectChange(e.target.value || null);
                        setEditingProject(false);
                      }}
                      className="max-w-xs"
                    >
                      <option value="">No project assigned</option>
                      {projectOptions.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </FormSelect>
                    <Button variant="ghost" size="xs" onClick={() => setEditingProject(false)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    {team.projectIds?.[0] ? (
                      <button
                        type="button"
                        className="font-semibold text-text hover:underline underline-offset-2"
                        onClick={() => navigate(LINKS.project(team.projectIds[0]))}
                      >
                        {projectName || team.projectIds[0]}
                      </button>
                    ) : (
                      <span className="text-attention">No project assigned</span>
                    )}
                    <Button variant="link" size="xs" onClick={() => setEditingProject(true)} aria-label="Change project">
                      {team.projectIds?.[0] ? 'Change' : 'Assign a project'}
                    </Button>
                  </div>
                )}
              </section>
            )}

            <section aria-labelledby="team-cron-h">
              <MoreHeading id="team-cron-h">Cron jobs</MoreHeading>
              <CronJobPanel teamId={id} compact />
            </section>

            <section aria-labelledby="team-feed-h">
              <MoreHeading id="team-feed-h">Live feed</MoreHeading>
              <ExecutionFeed teamId={id} maxEvents={100} />
            </section>

            {!isOrc && (
              <section aria-labelledby="team-activity-h">
                <MoreHeading id="team-activity-h">Recent activity</MoreHeading>
                <p className="text-sm text-text-2">No recent activity.</p>
              </section>
            )}

            {team.hierarchical && (
              <section aria-labelledby="team-hierarchy-h">
                <MoreHeading id="team-hierarchy-h">Hierarchy</MoreHeading>
                <HierarchyDashboard team={team} onMemberClick={handleViewAgent} />
              </section>
            )}
          </div>
        </CollapsibleSection>
      </div>

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
