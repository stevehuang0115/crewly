import React, { useState, useEffect, useCallback } from 'react';
import { Project, Team, Ticket } from '../types';
import { apiService } from '../services/api.service';
import { useTerminal } from '../contexts/TerminalContext';
import { webSocketService } from '../services/websocket.service';
import {
  AssignmentFilters,
  ViewToggle,
  AssignmentsList,
  Assignment,
  OrchestratorCommand,
  EnhancedTeamMember
} from '../components/Assignments';
import { EnhancedAssignmentsList } from '../components/Assignments/EnhancedAssignmentsList';
import { useAlert, useConfirm } from '@crewly/ui/Dialog';
import { Button, Card } from '@crewly/ui';

export const Assignments: React.FC = () => {
  const { openTerminalWithSession } = useTerminal();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [enhancedMembers, setEnhancedMembers] = useState<EnhancedTeamMember[]>([]);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterTeam, setFilterTeam] = useState<string>('all');
  const [viewMode, setViewMode] = useState<'projects' | 'teams' | 'enhanced'>('enhanced');
  const { showSuccess, showError, AlertComponent } = useAlert();
  const { showConfirm, ConfirmComponent } = useConfirm();

  /**
   * Handles team activity updates received via WebSocket.
   * Updates the enhanced members state with new activity data.
   *
   * @param activityData - The activity data containing updated member information
   */
  const handleTeamActivityUpdate = useCallback((activityData: any) => {
    // Update enhanced members data
    if (activityData.members) {
      setEnhancedMembers(activityData.members);
    }
  }, []);

  /**
   * Fetches project data from the API and updates the projects state.
   * Logs errors to console if the request fails.
   */
  const loadProjects = useCallback(async () => {
    try {
      const projectsData = await apiService.getProjects();
      setProjects(projectsData);
    } catch (error) {
      console.error('Error loading projects:', error);
    }
  }, []);

  /**
   * Fetches team data from the API and updates the teams state.
   * Logs errors to console if the request fails.
   */
  const loadTeams = useCallback(async () => {
    try {
      const teamsData = await apiService.getTeams();
      setTeams(teamsData);
    } catch (error) {
      console.error('Error loading teams:', error);
    }
  }, []);

  /**
   * Fetches assignment data from the API and updates the assignments state.
   * Logs errors to console if the request fails.
   */
  const fetchAssignments = useCallback(async () => {
    try {
      const response = await fetch('/api/assignments');
      if (response.ok) {
        const assignmentsData = await response.json();
        setAssignments(assignmentsData);
      }
    } catch (error) {
      console.error('Error fetching assignments:', error);
    }
  }, []);

  /**
   * Placeholder for fetching enhanced team data.
   * Currently handled via WebSocket events for real-time updates.
   */
  const fetchEnhancedTeamData = useCallback(async () => {
    // Note: This function is now handled by WebSocket events
    // Initial data will be populated via WebSocket team_activity_updated events
  }, []);

  /**
   * Loads all data required for the assignments page.
   * Fetches assignments, projects, teams, and enhanced team data in parallel.
   */
  const loadData = useCallback(async () => {
    await Promise.all([
      fetchAssignments(),
      loadProjects(),
      loadTeams(),
      fetchEnhancedTeamData()
    ]);
  }, [fetchAssignments, loadProjects, loadTeams, fetchEnhancedTeamData]);

  /**
   * Initializes WebSocket connection for real-time team activity monitoring.
   * Sets up event listeners for team activity updates.
   */
  const initializeWebSocket = useCallback(async () => {
    try {
      if (!webSocketService.isConnected()) {
        await webSocketService.connect();
      }

      // Listen for team activity updates
      webSocketService.on('team_activity_updated', handleTeamActivityUpdate);
    } catch (error) {
      console.error('Failed to initialize WebSocket for team activity:', error);
    }
  }, [handleTeamActivityUpdate]);

  useEffect(() => {
    loadData();
    initializeWebSocket();

    return () => {
      // Clean up WebSocket listeners
      webSocketService.off('team_activity_updated', handleTeamActivityUpdate);
    };
  }, [loadData, initializeWebSocket, handleTeamActivityUpdate]);


  /**
   * Handles click on a team member to open their terminal session.
   * Generates the session name based on team and member names.
   *
   * @param memberId - The unique identifier of the team member
   * @param memberName - The display name of the team member
   * @param teamId - The unique identifier of the team
   */
  const handleMemberClick = useCallback((memberId: string, memberName: string, teamId: string) => {
    // Generate session name to match backend logic: team.name + member.name (lowercase, spaces to hyphens)
    const team = teams.find(t => t.id === teamId);
    if (team) {
      const teamNameFormatted = team.name.replace(/\s+/g, '-').toLowerCase();
      const memberNameFormatted = memberName.replace(/\s+/g, '-').toLowerCase();
      const sessionName = `${teamNameFormatted}-${memberNameFormatted}`;
      openTerminalWithSession(sessionName);
    }
  }, [teams, openTerminalWithSession]);

  /**
   * Handles click on the orchestrator to open the orchestrator terminal session.
   */
  const handleOrchestratorClick = useCallback(() => {
    openTerminalWithSession('crewly-orc');
  }, [openTerminalWithSession]);

  /**
   * Updates the status of an assignment.
   *
   * @param assignmentId - The unique identifier of the assignment
   * @param newStatus - The new status to set for the assignment
   */
  const updateAssignmentStatus = useCallback(async (assignmentId: string, newStatus: Assignment['status']) => {
    try {
      const response = await fetch(`/api/assignments/${assignmentId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: newStatus }),
      });

      if (response.ok) {
        setAssignments(prev =>
          prev.map(assignment =>
            assignment.id === assignmentId
              ? { ...assignment, status: newStatus }
              : assignment
          )
        );
        if (selectedAssignment?.id === assignmentId) {
          setSelectedAssignment(prev => prev ? { ...prev, status: newStatus } : null);
        }
      }
    } catch (error) {
      console.error('Error updating assignment:', error);
    }
  }, [selectedAssignment?.id]);

  /**
   * Handles unassigning a team from a project.
   * Shows a confirmation dialog before executing the unassign operation.
   *
   * @param teamId - The unique identifier of the team to unassign
   * @param teamName - The display name of the team (for confirmation message)
   * @param projectId - The unique identifier of the project (optional)
   */
  const handleUnassignTeam = useCallback(async (teamId: string, teamName: string, projectId?: string) => {
    if (!projectId) return;
    const doUnassign = async () => {
      try {
      // Send unassign command to orchestrator to delete terminal sessions
      const response = await fetch('/api/orchestrator/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: `unassign_team ${teamId} ${projectId}` }),
      });

      if (!response.ok) {
        throw new Error('Failed to execute orchestrator command');
      }

      // Unassign team from project
      await apiService.unassignTeamFromProject(projectId, teamId);

      // Reload data to reflect changes
      await loadData();

      showSuccess(`Team "${teamName}" has been unassigned and their terminal sessions have been terminated.`);
      } catch (error) {
        console.error('Failed to unassign team:', error);
        showError('Failed to unassign team: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    };
    showConfirm(
      `Unassign "${teamName}" from their project?\n\n• The team's terminal sessions will be deleted\n• The team remains available to assign again`,
      doUnassign,
      { title: 'Unassign Team', confirmText: 'Unassign', cancelText: 'Cancel', type: 'warning' }
    );
  }, [loadData, showSuccess, showError, showConfirm]);


  const assignedProjects = projects.filter(project =>
    teams.some(team => team.projectIds?.includes(project.id))
  );

  const assignedTeams = teams.filter(team => team.projectIds?.length > 0);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Assignments</h2>
          <p className="text-sm text-text-secondary-dark mt-1">Track and manage project assignments and team orchestration</p>
        </div>
      </div>

      {/* Projects & Teams Panel - Full Width */}
      <Card padding="none">
        <div className="flex items-center justify-between p-5 border-b border-border-dark">
          <h3 className="text-xl font-semibold">Active Projects & Teams</h3>
          <div className="flex items-center gap-3">
            <Button
              variant={viewMode === 'enhanced' ? 'primary' : 'outline'}
              size="sm"
              aria-pressed={viewMode === 'enhanced'}
              onClick={() => setViewMode('enhanced')}
            >
              Task View
            </Button>
            <ViewToggle
              viewMode={viewMode === 'enhanced' ? 'projects' : viewMode}
              assignedProjects={assignedProjects}
              assignedTeams={assignedTeams}
              onViewModeChange={(mode) => setViewMode(mode === 'projects' ? 'enhanced' : mode)}
            />
          </div>
        </div>

          {viewMode !== 'enhanced' && (
            <AssignmentFilters
              filterStatus={filterStatus}
              filterTeam={filterTeam}
              assignments={assignments}
              onStatusChange={setFilterStatus}
              onTeamChange={setFilterTeam}
            />
          )}

          {viewMode === 'enhanced' ? (
            <div className="p-5">
              <EnhancedAssignmentsList
                projects={projects}
                teams={teams}
                enhancedMembers={enhancedMembers}
                onMemberClick={handleMemberClick}
              />
            </div>
          ) : (
            <div className="p-5">
              <AssignmentsList
                viewMode={viewMode}
                assignedProjects={assignedProjects}
                assignedTeams={assignedTeams}
                teams={teams}
                projects={projects}
                onMemberClick={handleMemberClick}
                onOrchestratorClick={handleOrchestratorClick}
                onUnassignTeam={handleUnassignTeam}
              />
            </div>
          )}
      </Card>
      <AlertComponent />
      <ConfirmComponent />
    </div>
  );
};
