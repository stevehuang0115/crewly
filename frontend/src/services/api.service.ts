/**
 * API Service - Centralized API client for Crewly backend.
 *
 * Provides methods for interacting with projects, teams, tickets, and tasks.
 * Includes caching and request deduplication for frequently accessed data.
 */

import axios from 'axios';
import { Project, Team, Ticket, ApiResponse, PreviousSession, TeamsBackupStatus, TeamsRestoreResult, QueueStatus, QueuedMessage, KnowledgeDocument, KnowledgeDocumentSummary, KnowledgeScope, CloudStatus, CloudConnectResult, SessionUsageSummary, TaskUsageSummary, ExpertSummary } from '../types';
import type { CronTask, CreateCronTaskRequest, UpdateCronTaskRequest, TeamAgentStatusFile } from '../types/cron-task.types';
import type { AuthTokenResponse, UserProfile, LicenseStatus } from '../types/auth.types';

/** Base URL for all API requests */
const API_BASE = '/api';

/** Cache TTL in milliseconds (2 minutes) */
const TEAMS_CACHE_TTL = 2 * 60 * 1000;

/**
 * Simple cache entry with TTL tracking
 */
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * API Service class providing centralized access to backend endpoints.
 *
 * Features:
 * - Type-safe API responses
 * - Caching for frequently accessed data (teams)
 * - Request deduplication to prevent concurrent duplicate requests
 * - Consistent error handling
 */
class ApiService {
  /** Teams cache for reducing redundant API calls */
  private teamsCache: CacheEntry<Team[]> | null = null;
  /** In-flight promise for request deduplication */
  private teamsCachePromise: Promise<Team[]> | null = null;
  /** In-flight promise for orchestrator setup deduplication */
  private setupOrchestratorPromise: Promise<{ success: boolean; message?: string; error?: string }> | null = null;

  // ============ Project Methods ============

  /**
   * Fetches all projects.
   *
   * @returns Promise resolving to array of projects
   * @throws Error if the request fails
   */
  async getProjects(): Promise<Project[]> {
    const response = await axios.get<ApiResponse<Project[]>>(`${API_BASE}/projects`);
    return response.data.data || [];
  }

  /**
   * Fetches a single project by ID.
   *
   * @param id - Project ID
   * @returns Promise resolving to the project
   * @throws Error if project not found or request fails
   */
  async getProject(id: string): Promise<Project> {
    const response = await axios.get<ApiResponse<Project>>(`${API_BASE}/projects/${id}`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Project not found');
    }
    return response.data.data;
  }

  /**
   * Creates a new project.
   *
   * @param path - File system path for the project
   * @param name - Optional project name (defaults to folder name)
   * @param description - Optional project description
   * @returns Promise resolving to the created project
   * @throws Error if creation fails
   */
  async createProject(path: string, name?: string, description?: string): Promise<Project> {
    const response = await axios.post<ApiResponse<Project>>(`${API_BASE}/projects`, {
      path,
      name,
      description
    });
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create project');
    }
    return response.data.data;
  }

  /**
   * Starts a project with the specified teams.
   *
   * @param projectId - ID of the project to start
   * @param teamIds - Array of team IDs to assign to the project
   * @returns Promise resolving to success message
   * @throws Error if start fails
   */
  async startProject(projectId: string, teamIds: string[]): Promise<{ message: string }> {
    const response = await axios.post<ApiResponse<unknown>>(`${API_BASE}/projects/${projectId}/start`, {
      teamIds
    });
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to start project');
    }
    return {
      message: response.data.message || 'Project started successfully'
    };
  }

  /**
   * Assigns teams to a project, organizing them by role.
   *
   * Converts team IDs to role-based assignments using the first member's role
   * as the team's primary role.
   *
   * @param projectId - ID of the project
   * @param teamIds - Array of team IDs to assign
   * @throws Error if assignment fails
   */
  async assignTeamsToProject(projectId: string, teamIds: string[]): Promise<void> {
    // Backend expects teamAssignments format based on integration tests
    // Convert team IDs to team assignments by role (get roles from team members)
    const teams = await this.getTeams();
    const teamAssignments: Record<string, string[]> = {};

    teamIds.forEach(teamId => {
      const team = teams.find(t => t.id === teamId);
      if (team && team.members.length > 0) {
        // Use the role of the first team member as the team's primary role
        const primaryRole = team.members[0].role;
        if (!teamAssignments[primaryRole]) {
          teamAssignments[primaryRole] = [];
        }
        teamAssignments[primaryRole].push(teamId);
      }
    });

    const response = await axios.post<ApiResponse<void>>(`${API_BASE}/projects/${projectId}/assign-teams`, {
      teamAssignments
    });
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to assign teams');
    }
  }

  // ============ Team Methods ============

  /**
   * Get all teams with caching and request deduplication.
   *
   * Caches results for 2 minutes to reduce redundant API calls.
   * Deduplicates concurrent requests to prevent multiple in-flight fetches.
   *
   * @param forceRefresh - If true, bypasses cache and fetches fresh data
   * @returns Promise resolving to array of teams
   */
  async getTeams(forceRefresh = false): Promise<Team[]> {
    // Check if cache is valid
    if (!forceRefresh && this.teamsCache) {
      const age = Date.now() - this.teamsCache.timestamp;
      if (age < TEAMS_CACHE_TTL) {
        return this.teamsCache.data;
      }
    }

    // If a request is already in flight, return the same promise (deduplication)
    if (this.teamsCachePromise) {
      return this.teamsCachePromise;
    }

    // Create new fetch promise
    this.teamsCachePromise = (async () => {
      try {
        const response = await axios.get<ApiResponse<Team[]>>(`${API_BASE}/teams`, { timeout: 15000 });
        const teams = response.data.data || [];

        // Update cache
        this.teamsCache = {
          data: teams,
          timestamp: Date.now(),
        };

        return teams;
      } finally {
        // Clear in-flight promise
        this.teamsCachePromise = null;
      }
    })();

    return this.teamsCachePromise;
  }

  /**
   * Invalidate the teams cache.
   *
   * Call this after creating, updating, or deleting teams to ensure
   * subsequent calls fetch fresh data.
   */
  invalidateTeamsCache(): void {
    this.teamsCache = null;
  }

  /**
   * Fetches a single team by ID.
   *
   * @param id - Team ID
   * @returns Promise resolving to the team
   * @throws Error if team not found or request fails
   */
  async getTeam(id: string): Promise<Team> {
    const response = await axios.get<ApiResponse<Team>>(`${API_BASE}/teams/${id}`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Team not found');
    }
    return response.data.data;
  }

  /**
   * Creates a new team.
   *
   * Automatically invalidates the teams cache after successful creation.
   *
   * @param team - Team data (without auto-generated fields)
   * @returns Promise resolving to the created team
   * @throws Error if creation fails
   */
  async createTeam(team: Omit<Team, 'id' | 'createdAt' | 'updatedAt' | 'sessionName'>): Promise<Team> {
    const response = await axios.post<ApiResponse<Team>>(`${API_BASE}/teams`, team);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create team');
    }
    this.invalidateTeamsCache();
    return response.data.data;
  }

  /**
   * Deletes a team.
   *
   * Automatically invalidates the teams cache after successful deletion.
   *
   * @param id - Team ID to delete
   * @throws Error if deletion fails
   */
  async deleteTeam(id: string): Promise<void> {
    const response = await axios.delete<ApiResponse<void>>(`${API_BASE}/teams/${id}`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to delete team');
    }
    this.invalidateTeamsCache();
  }

  /**
   * Unassigns a team from a project.
   *
   * @param projectId - ID of the project
   * @param teamId - ID of the team to unassign
   * @throws Error if unassignment fails
   */
  async unassignTeamFromProject(projectId: string, teamId: string): Promise<void> {
    const response = await axios.post<ApiResponse<void>>(`${API_BASE}/projects/${projectId}/unassign-team`, {
      teamId
    });
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to unassign team');
    }
  }

  /**
   * Starts a team by ID, resuming agents with stored session IDs when available.
   *
   * @param teamId - ID of the team to start
   * @throws Error if the start request fails
   */
  async startTeam(teamId: string): Promise<void> {
    await axios.post(`${API_BASE}/teams/${teamId}/start`, {});
  }

  /**
   * Stops all agents in a team.
   *
   * @param teamId - ID of the team to stop
   * @throws Error if the stop request fails
   */
  async stopTeam(teamId: string): Promise<void> {
    await axios.post(`${API_BASE}/teams/${teamId}/stop`, {});
  }

  /**
   * Updates an existing project's properties.
   *
   * @param id - Project ID
   * @param updates - Partial project data to update (e.g., status, name)
   * @returns Promise resolving to the updated project
   * @throws Error if update fails
   */
  async updateProject(id: string, updates: Partial<Omit<Project, 'id'>>): Promise<Project> {
    const response = await axios.patch<ApiResponse<Project>>(`${API_BASE}/projects/${id}`, updates);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to update project');
    }
    return response.data.data;
  }

  // ============ Orchestrator Methods ============

  /**
   * Setup the orchestrator with deduplication.
   *
   * If a setup request is already in flight, returns the same promise
   * instead of firing a duplicate POST. Prevents the 5-7x concurrent
   * calls observed on page load.
   *
   * @returns Object with success flag, optional message, and optional error
   */
  async setupOrchestrator(): Promise<{ success: boolean; message?: string; error?: string }> {
    // Return in-flight promise if setup is already running
    if (this.setupOrchestratorPromise) {
      return this.setupOrchestratorPromise;
    }

    this.setupOrchestratorPromise = (async () => {
      try {
        const response = await fetch(`${API_BASE}/orchestrator/setup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const result = await response.json();
        return {
          success: response.ok && result.success,
          message: result.message,
          error: result.error,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to setup orchestrator',
        };
      }
    })();

    try {
      return await this.setupOrchestratorPromise;
    } finally {
      this.setupOrchestratorPromise = null;
    }
  }

  // ============ Ticket Methods ============

  /**
   * Fetches all tickets for a project.
   *
   * @param projectId - Project ID
   * @returns Promise resolving to array of tickets
   */
  async getProjectTickets(projectId: string): Promise<Ticket[]> {
    const response = await axios.get<ApiResponse<Ticket[]>>(`${API_BASE}/projects/${projectId}/tickets`);
    return response.data.data || [];
  }

  /**
   * Creates a new ticket in a project.
   *
   * @param projectId - ID of the project
   * @param ticket - Ticket data (without auto-generated fields)
   * @returns Promise resolving to the created ticket
   * @throws Error if creation fails
   */
  async createTicket(projectId: string, ticket: Omit<Ticket, 'id' | 'createdAt' | 'updatedAt'>): Promise<Ticket> {
    const response = await axios.post<ApiResponse<Ticket>>(`${API_BASE}/projects/${projectId}/tickets`, ticket);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create ticket');
    }
    return response.data.data;
  }

  /**
   * Updates an existing ticket.
   *
   * @param id - Ticket ID
   * @param updates - Partial ticket data to update
   * @returns Promise resolving to the updated ticket
   * @throws Error if update fails
   */
  async updateTicket(id: string, updates: Partial<Ticket>): Promise<Ticket> {
    const response = await axios.patch<ApiResponse<Ticket>>(`${API_BASE}/tickets/${id}`, updates);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to update ticket');
    }
    return response.data.data;
  }

  /**
   * Deletes a ticket from a project.
   *
   * @param projectId - ID of the project
   * @param ticketId - ID of the ticket to delete
   * @throws Error if deletion fails
   */
  async deleteTicket(projectId: string, ticketId: string): Promise<void> {
    const response = await axios.delete<ApiResponse<void>>(`${API_BASE}/projects/${projectId}/tickets/${ticketId}`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to delete ticket');
    }
  }

  // ============ Session Resume Methods ============

  /**
   * Get previously running sessions that can be resumed.
   *
   * @returns Promise resolving to array of previous sessions
   */
  async getPreviousSessions(): Promise<{ sessions: PreviousSession[] }> {
    const response = await axios.get<ApiResponse<{ sessions: PreviousSession[] }>>(`${API_BASE}/sessions/previous`);
    return response.data.data || { sessions: [] };
  }

  /**
   * Dismiss previous sessions (clears persisted state).
   */
  async dismissPreviousSessions(): Promise<void> {
    await axios.post(`${API_BASE}/sessions/previous/dismiss`);
  }

  // ============ Intent Task Methods ============

  /**
   * Fetches aggregate intent task statistics.
   *
   * @returns Promise resolving to statistics with task counts by status, level, tokens, and cost
   */
  async getIntentTaskStatistics(): Promise<{
    totalTasks: number;
    byStatus: Record<string, number>;
    byLevel: Record<string, number>;
    totalTokens: number;
    totalCost: number;
    llmCost: number;
    skillCost: number;
    totalMessages: number;
  }> {
    const response = await axios.get<ApiResponse<{
      totalTasks: number;
      byStatus: Record<string, number>;
      byLevel: Record<string, number>;
      totalTokens: number;
      totalCost: number;
      llmCost: number;
      skillCost: number;
      totalMessages: number;
    }>>(`${API_BASE}/intent-tasks/statistics`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get intent task statistics');
    }
    return response.data.data;
  }

  // ============ Task Methods (from markdown files) ============

  /**
   * Fetches all tasks for a project.
   *
   * Tasks are parsed from markdown files in the project's tasks directory.
   * Note: Returns any[] as task structure is dynamic and parsed from markdown.
   *
   * @param projectId - Project ID
   * @returns Promise resolving to array of tasks
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getAllTasks(projectId: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await axios.get<ApiResponse<any[]>>(`${API_BASE}/projects/${projectId}/tasks`);
    return response.data.data || [];
  }

  /**
   * Fetches all milestones for a project.
   *
   * @param projectId - Project ID
   * @returns Promise resolving to array of milestones
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getMilestones(projectId: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await axios.get<ApiResponse<any[]>>(`${API_BASE}/projects/${projectId}/milestones`);
    return response.data.data || [];
  }

  /**
   * Fetches tasks filtered by status.
   *
   * @param projectId - Project ID
   * @param status - Task status to filter by (e.g., 'open', 'in_progress', 'done')
   * @returns Promise resolving to array of tasks with the specified status
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTasksByStatus(projectId: string, status: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await axios.get<ApiResponse<any[]>>(`${API_BASE}/projects/${projectId}/tasks/status/${status}`);
    return response.data.data || [];
  }

  /**
   * Fetches tasks filtered by milestone.
   *
   * @param projectId - Project ID
   * @param milestoneId - Milestone ID to filter by
   * @returns Promise resolving to array of tasks in the specified milestone
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTasksByMilestone(projectId: string, milestoneId: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await axios.get<ApiResponse<any[]>>(`${API_BASE}/projects/${projectId}/tasks/milestone/${milestoneId}`);
    return response.data.data || [];
  }

  // ============ Teams Backup Methods ============

  /**
   * Get backup status comparing current teams against backup file.
   *
   * @returns Promise resolving to backup status with mismatch flag
   */
  async getTeamsBackupStatus(): Promise<TeamsBackupStatus> {
    const response = await axios.get<ApiResponse<TeamsBackupStatus>>(`${API_BASE}/teams/backup/status`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get backup status');
    }
    return response.data.data;
  }

  /**
   * Restore teams from the backup file.
   *
   * @returns Promise resolving to restore result with count
   */
  async restoreTeamsFromBackup(): Promise<TeamsRestoreResult> {
    const response = await axios.post<ApiResponse<TeamsRestoreResult>>(`${API_BASE}/teams/backup/restore`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to restore from backup');
    }
    return response.data.data;
  }
  // ============ Message Queue Methods ============

  /**
   * Get the current queue status summary.
   *
   * @returns Promise resolving to queue status
   * @throws Error if the request fails
   */
  async getQueueStatus(): Promise<QueueStatus> {
    const response = await axios.get<ApiResponse<QueueStatus>>(`${API_BASE}/messaging/queue/status`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get queue status');
    }
    return response.data.data;
  }

  /**
   * Get all pending and processing messages in the queue.
   *
   * @returns Promise resolving to array of queued messages
   * @throws Error if the request fails
   */
  async getPendingMessages(): Promise<QueuedMessage[]> {
    const response = await axios.get<ApiResponse<QueuedMessage[]>>(`${API_BASE}/messaging/queue/messages`);
    return response.data.data || [];
  }

  /**
   * Cancel a pending message in the queue.
   *
   * @param messageId - ID of the message to cancel
   * @throws Error if cancellation fails
   */
  async cancelQueueMessage(messageId: string): Promise<void> {
    const response = await axios.delete<ApiResponse<void>>(`${API_BASE}/messaging/queue/messages/${messageId}`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to cancel message');
    }
  }

  /**
   * Clear all messages from the queue (pending + current processing).
   *
   * @throws Error if the request fails
   */
  async clearQueue(): Promise<void> {
    const response = await axios.delete<ApiResponse<{ clearedCount: number; cancelledCurrent: boolean }>>(`${API_BASE}/messaging/queue`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to clear queue');
    }
  }
  // ============ Knowledge Document Methods ============

  /**
   * Fetches knowledge documents with optional filtering.
   *
   * @param scope - 'global' or 'project'
   * @param projectPath - Required when scope is 'project'
   * @param category - Optional category filter
   * @param search - Optional search query
   * @returns Promise resolving to array of document summaries
   */
  async getKnowledgeDocuments(
    scope: KnowledgeScope = 'global',
    projectPath?: string,
    category?: string,
    search?: string,
  ): Promise<KnowledgeDocumentSummary[]> {
    const params: Record<string, string> = { scope };
    if (projectPath) params.projectPath = projectPath;
    if (category) params.category = category;
    if (search) params.search = search;

    const response = await axios.get<ApiResponse<KnowledgeDocumentSummary[]>>(
      `${API_BASE}/knowledge/documents`,
      { params },
    );
    return response.data.data || [];
  }

  /**
   * Fetches a single knowledge document by ID.
   *
   * @param id - Document ID
   * @param scope - Document scope
   * @param projectPath - Required when scope is 'project'
   * @returns Promise resolving to the document
   * @throws Error if document not found
   */
  async getKnowledgeDocument(
    id: string,
    scope: KnowledgeScope = 'global',
    projectPath?: string,
  ): Promise<KnowledgeDocument> {
    const params: Record<string, string> = { scope };
    if (projectPath) params.projectPath = projectPath;

    const response = await axios.get<ApiResponse<KnowledgeDocument>>(
      `${API_BASE}/knowledge/documents/${id}`,
      { params },
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Document not found');
    }
    return response.data.data;
  }

  /**
   * Creates a new knowledge document.
   *
   * @param doc - Document data
   * @returns Promise resolving to the created document ID
   * @throws Error if creation fails
   */
  async createKnowledgeDocument(doc: {
    title: string;
    content: string;
    category: string;
    scope: KnowledgeScope;
    projectPath?: string;
    tags?: string[];
    createdBy?: string;
  }): Promise<string> {
    const response = await axios.post<ApiResponse<{ id: string }>>(
      `${API_BASE}/knowledge/documents`,
      doc,
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create document');
    }
    return response.data.data.id;
  }

  /**
   * Updates an existing knowledge document.
   *
   * @param id - Document ID
   * @param updates - Partial document data to update
   * @throws Error if update fails
   */
  async updateKnowledgeDocument(
    id: string,
    updates: {
      title?: string;
      content?: string;
      category?: string;
      tags?: string[];
      scope: KnowledgeScope;
      projectPath?: string;
      updatedBy?: string;
    },
  ): Promise<void> {
    const response = await axios.put<ApiResponse<void>>(
      `${API_BASE}/knowledge/documents/${id}`,
      updates,
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to update document');
    }
  }

  /**
   * Deletes a knowledge document.
   *
   * @param id - Document ID
   * @param scope - Document scope
   * @param projectPath - Required when scope is 'project'
   * @throws Error if deletion fails
   */
  async deleteKnowledgeDocument(
    id: string,
    scope: KnowledgeScope = 'global',
    projectPath?: string,
  ): Promise<void> {
    const params: Record<string, string> = { scope };
    if (projectPath) params.projectPath = projectPath;

    const response = await axios.delete<ApiResponse<void>>(
      `${API_BASE}/knowledge/documents/${id}`,
      { params },
    );
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to delete document');
    }
  }

  /**
   * Fetches available knowledge categories for a given scope.
   *
   * @param scope - Document scope
   * @param projectPath - Required when scope is 'project'
   * @returns Promise resolving to array of category names
   */
  async getKnowledgeCategories(
    scope: KnowledgeScope = 'global',
    projectPath?: string,
  ): Promise<string[]> {
    const params: Record<string, string> = { scope };
    if (projectPath) params.projectPath = projectPath;

    const response = await axios.get<ApiResponse<string[]>>(
      `${API_BASE}/knowledge/categories`,
      { params },
    );
    return response.data.data || [];
  }
  // ============ Cloud Connection Methods ============

  /**
   * Get the current CrewlyAI Cloud connection status.
   *
   * @returns Promise resolving to cloud connection status
   * @throws Error if the request fails
   */
  async getCloudStatus(): Promise<CloudStatus> {
    const response = await axios.get<ApiResponse<CloudStatus>>(`${API_BASE}/cloud/status`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get cloud status');
    }
    return response.data.data;
  }

  /**
   * Connect to CrewlyAI Cloud with an API token.
   *
   * @param token - Cloud API authentication token
   * @param cloudUrl - Optional custom cloud API URL
   * @returns Promise resolving to connection result with tier info
   * @throws Error if connection fails (invalid token, network error)
   */
  async connectToCloud(token: string, cloudUrl?: string): Promise<CloudConnectResult> {
    const body: { token: string; cloudUrl?: string } = { token };
    if (cloudUrl) body.cloudUrl = cloudUrl;

    const response = await axios.post<ApiResponse<CloudConnectResult>>(`${API_BASE}/cloud/connect`, body);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to connect to cloud');
    }
    return response.data.data;
  }

  /**
   * Disconnect from CrewlyAI Cloud.
   *
   * @throws Error if disconnect fails
   */
  async disconnectFromCloud(): Promise<void> {
    const response = await axios.post<ApiResponse<void>>(`${API_BASE}/cloud/disconnect`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to disconnect from cloud');
    }
  }

  // ============ Auth Methods ============

  /**
   * Refresh access token using a refresh token.
   *
   * @param refreshToken - Valid refresh token
   * @returns Promise resolving to new auth tokens
   * @throws Error if refresh token is invalid or expired
   */
  async authRefresh(refreshToken: string): Promise<AuthTokenResponse> {
    const response = await axios.post<ApiResponse<AuthTokenResponse>>(`${API_BASE}/auth/refresh`, {
      refreshToken,
    });
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Token refresh failed');
    }
    return response.data.data;
  }

  /**
   * Get the current user's profile.
   *
   * @param accessToken - Valid access token
   * @returns Promise resolving to user profile
   * @throws Error if token is invalid or user not found
   */
  async authGetProfile(accessToken: string): Promise<UserProfile> {
    const response = await axios.get<ApiResponse<UserProfile>>(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get profile');
    }
    return response.data.data;
  }

  /**
   * Update the current user's profile.
   *
   * @param accessToken - Valid access token
   * @param updates - Profile fields to update
   * @returns Promise resolving to updated user profile
   * @throws Error if token is invalid or update fails
   */
  async authUpdateProfile(accessToken: string, updates: { displayName?: string }): Promise<UserProfile> {
    const response = await axios.put<ApiResponse<UserProfile>>(`${API_BASE}/auth/me`, updates, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to update profile');
    }
    return response.data.data;
  }

  /**
   * Get the current user's license/plan status.
   *
   * @param accessToken - Valid access token
   * @returns Promise resolving to license status with features
   * @throws Error if token is invalid or user not found
   */
  async authGetLicense(accessToken: string): Promise<LicenseStatus> {
    const response = await axios.get<ApiResponse<LicenseStatus>>(`${API_BASE}/auth/license`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get license status');
    }
    return response.data.data;
  }

  // ============ Cron Task Methods ============

  /**
   * Fetches all cron tasks, optionally filtered by target agent or enabled status.
   *
   * @param filter - Optional filters for targetAgent and enabled
   * @returns Promise resolving to array of cron tasks
   */
  async getCronTasks(filter?: { targetAgent?: string; enabled?: boolean }): Promise<CronTask[]> {
    const params: Record<string, string> = {};
    if (filter?.targetAgent) params.targetAgent = filter.targetAgent;
    if (filter?.enabled !== undefined) params.enabled = String(filter.enabled);

    const response = await axios.get<ApiResponse<CronTask[]>>(`${API_BASE}/cron-tasks`, { params });
    return response.data.data || [];
  }

  /**
   * Creates a new cron task.
   *
   * @param request - Cron task creation data
   * @returns Promise resolving to the created cron task
   * @throws Error if creation fails
   */
  async createCronTask(request: CreateCronTaskRequest): Promise<CronTask> {
    const response = await axios.post<ApiResponse<CronTask>>(`${API_BASE}/cron-tasks`, request);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create cron task');
    }
    return response.data.data;
  }

  /**
   * Updates an existing cron task.
   *
   * @param id - Cron task ID
   * @param updates - Fields to update
   * @returns Promise resolving to the updated cron task
   * @throws Error if update fails
   */
  async updateCronTask(id: string, updates: UpdateCronTaskRequest): Promise<CronTask> {
    const response = await axios.patch<ApiResponse<CronTask>>(`${API_BASE}/cron-tasks/${id}`, updates);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to update cron task');
    }
    return response.data.data;
  }

  /**
   * Deletes a cron task.
   *
   * @param id - Cron task ID to delete
   * @throws Error if deletion fails
   */
  async deleteCronTask(id: string): Promise<void> {
    const response = await axios.delete<ApiResponse<void>>(`${API_BASE}/cron-tasks/${id}`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to delete cron task');
    }
  }

  /**
   * Fetches agent heartbeat status from the team agent status file.
   *
   * @returns Promise resolving to the team agent status data
   * @throws Error if the request fails
   */
  async getAgentHeartbeats(): Promise<TeamAgentStatusFile> {
    const response = await axios.get<ApiResponse<TeamAgentStatusFile>>(`${API_BASE}/system/agent-status`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get agent heartbeats');
    }
    return response.data.data;
  }

  // ============ Payment Methods ============

  /**
   * Creates a Stripe Checkout Session for upgrading to a paid plan.
   *
   * @param planId - Plan to subscribe to ('starter', 'pro', 'max')
   * @param interval - Billing interval ('month' or 'year')
   * @param successUrl - URL to redirect to after successful payment
   * @param cancelUrl - URL to redirect to if payment is cancelled
   * @returns Checkout session URL and session ID
   * @throws Error if the request fails
   */
  async createCheckoutSession(
    planId: string,
    interval: 'month' | 'year',
    successUrl: string,
    cancelUrl: string
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const response = await axios.post<ApiResponse<{ checkoutUrl: string; sessionId: string }>>(
      `${API_BASE}/payment/checkout`,
      { planId, interval, successUrl, cancelUrl }
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create checkout session');
    }
    return response.data.data;
  }

  /**
   * Fetches the current subscription status for the authenticated user.
   *
   * @returns Subscription info including plan, status, and period
   * @throws Error if the request fails
   */
  async getSubscription(): Promise<{ plan: string; status: string; currentPeriodEnd: string | null }> {
    const response = await axios.get<ApiResponse<{ plan: string; status: string; currentPeriodEnd: string | null }>>(
      `${API_BASE}/payment/subscription`
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get subscription');
    }
    return response.data.data;
  }

  /**
   * Creates a Stripe Customer Portal session for managing subscriptions.
   *
   * @param returnUrl - URL to redirect back to after portal session
   * @returns Portal session URL
   * @throws Error if the request fails
   */
  async createPortalSession(returnUrl: string): Promise<{ portalUrl: string }> {
    const response = await axios.post<ApiResponse<{ portalUrl: string }>>(
      `${API_BASE}/payment/portal`,
      { returnUrl }
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create portal session');
    }
    return response.data.data;
  }

  // ============ Provisioning Methods ============

  /**
   * Trigger a new full-stack deployment (DigitalOcean droplet + Crewly OSS + Pro addon).
   *
   * @param config - Deployment configuration
   * @returns Deployment ID and status URL
   * @throws Error if the request fails
   */
  async createDeployment(config: {
    dropletName: string;
    region?: string;
    size?: string;
    apiKeys?: {
      anthropicApiKey?: string;
      googleApiKey?: string;
      crewlyCloudApiKey?: string;
    };
    customerId?: string;
    installPro?: boolean;
    registerCloud?: boolean;
  }): Promise<{ deploymentId: string; statusUrl: string }> {
    const response = await axios.post<{ deploymentId: string; message: string; statusUrl: string }>(
      `${API_BASE}/provisioning/deployments`,
      config
    );
    return { deploymentId: response.data.deploymentId, statusUrl: response.data.statusUrl };
  }

  /**
   * Get the current status of a deployment.
   *
   * @param deploymentId - The deployment to check
   * @returns Deployment status including phase, progress, and any errors
   * @throws Error if the deployment is not found
   */
  async getDeploymentStatus(deploymentId: string): Promise<{
    currentPhase: string;
    success: boolean;
    dropletId?: number;
    ipAddress?: string;
    error?: string;
  }> {
    const response = await axios.get(`${API_BASE}/provisioning/deployments/${deploymentId}/status`);
    return response.data;
  }

  /**
   * List all deployments, optionally filtered.
   *
   * @param filters - Optional filters for completion status or customer
   * @returns Array of deployment records
   */
  async listDeployments(filters?: {
    complete?: boolean;
    customerId?: string;
  }): Promise<{ deployments: Array<{ deploymentId: string; currentPhase: string; success: boolean }>; total: number }> {
    const params = new URLSearchParams();
    if (filters?.complete !== undefined) params.set('complete', String(filters.complete));
    if (filters?.customerId) params.set('customerId', filters.customerId);
    const response = await axios.get(`${API_BASE}/provisioning/deployments?${params.toString()}`);
    return response.data;
  }

  // ============ Relay Methods ============

  /**
   * Get the current relay client status (state and session info).
   *
   * @returns Promise resolving to relay status with client state
   * @throws Error if the request fails
   */
  async getRelayStatus(): Promise<{ state: string; sessionId: string | null }> {
    const response = await axios.get<ApiResponse<{ client: { state: string; sessionId: string | null } }>>(`${API_BASE}/relay/devices`);
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to get relay status');
    }
    return response.data.data.client;
  }

  // ============ Monitoring Methods ============

  /**
   * Fetches token usage data for all active agent sessions.
   *
   * @returns Promise resolving to array of session usage summaries
   */
  async getTokenUsage(): Promise<SessionUsageSummary[]> {
    const response = await axios.get<ApiResponse<SessionUsageSummary[]>>(`${API_BASE}/monitoring/token-usage`);
    return response.data.data || [];
  }

  /**
   * Fetches token usage data aggregated by task ID.
   *
   * @returns Promise resolving to array of per-task usage summaries
   */
  async getTokenUsageByTask(): Promise<TaskUsageSummary[]> {
    const response = await axios.get<ApiResponse<TaskUsageSummary[]>>(`${API_BASE}/monitoring/token-usage/by-task`);
    return response.data.data || [];
  }

  /**
   * Resets all token usage counters to zero.
   *
   * @throws Error if the reset request fails
   */
  async resetTokenUsage(): Promise<void> {
    const response = await axios.post<ApiResponse<void>>(`${API_BASE}/monitoring/token-usage/reset`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to reset token usage');
    }
  }

  // ---------------------------------------------------------------------------
  // V3 Pipeline APIs (Requests, WorkItems, Missions)
  // ---------------------------------------------------------------------------

  async getRequests(): Promise<unknown[]> {
    const response = await axios.get<ApiResponse<unknown>>(`${API_BASE}/requests`);
    const d = response.data.data as Record<string, unknown>;
    return (Array.isArray(d) ? d : (d?.data as unknown[]) || []) as unknown[];
  }

  async getRequest(id: string): Promise<unknown> {
    const response = await axios.get<ApiResponse<unknown>>(`${API_BASE}/requests/${id}`);
    if (!response.data.success || !response.data.data) throw new Error('Request not found');
    return response.data.data;
  }

  async updateRequest(id: string, updates: Record<string, unknown>): Promise<void> {
    const response = await axios.put<ApiResponse<unknown>>(`${API_BASE}/requests/${id}`, updates);
    if (!response.data.success) throw new Error(response.data.error || 'Failed to update request');
  }

  async getWorkItems(): Promise<unknown[]> {
    const response = await axios.get<ApiResponse<unknown[]>>(`${API_BASE}/task-pool/all`);
    return response.data.data || [];
  }

  async getWorkItem(id: string): Promise<unknown> {
    const response = await axios.get<ApiResponse<unknown>>(`${API_BASE}/task-pool/${id}`);
    if (!response.data.success || !response.data.data) throw new Error('Work item not found');
    return response.data.data;
  }

  async getWorkItemsByRequest(requestId: string): Promise<unknown[]> {
    const items = await this.getWorkItems();
    return (items as Array<Record<string, unknown>>).filter(i => i.requestId === requestId);
  }

  async getMissions(): Promise<unknown[]> {
    const response = await axios.get<ApiResponse<unknown[]>>(`${API_BASE}/missions`);
    const d = response.data.data;
    return Array.isArray(d) ? d : [];
  }

  async createMission(input: { objective: string; ownerTeamId: string; cadence?: string; successCriteria?: string[] }): Promise<unknown> {
    const response = await axios.post<ApiResponse<unknown>>(`${API_BASE}/missions`, input);
    return response.data.data;
  }

  async getMission(id: string): Promise<unknown> {
    const response = await axios.get<ApiResponse<unknown>>(`${API_BASE}/missions/${id}`);
    if (!response.data.success || !response.data.data) throw new Error('Mission not found');
    return response.data.data;
  }

  // ---------------------------------------------------------------------------
  // Trigger API
  // ---------------------------------------------------------------------------

  /**
   * Lists all triggers, optionally filtered by status.
   *
   * @param status - Optional status filter (active | paused | exhausted | cancelled)
   * @returns Promise resolving to array of triggers
   */
  async getTriggers(status?: string): Promise<import('../types/trigger.types').Trigger[]> {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    const response = await axios.get<ApiResponse<import('../types/trigger.types').Trigger[]>>(
      `${API_BASE}/triggers`,
      { params },
    );
    return response.data.data || [];
  }

  /**
   * Returns trigger engine health and counts.
   *
   * @returns Promise resolving to engine status summary
   */
  async getTriggerEngineStatus(): Promise<import('../types/trigger.types').TriggerEngineStatus> {
    const response = await axios.get<ApiResponse<import('../types/trigger.types').TriggerEngineStatus>>(
      `${API_BASE}/triggers/status`,
    );
    if (!response.data.data) throw new Error('Failed to get trigger status');
    return response.data.data;
  }

  /**
   * Creates a new trigger.
   *
   * @param input - Trigger creation data
   * @returns Promise resolving to the created trigger
   */
  async createTrigger(
    input: import('../types/trigger.types').CreateTriggerInput,
  ): Promise<import('../types/trigger.types').Trigger> {
    const response = await axios.post<ApiResponse<import('../types/trigger.types').Trigger>>(
      `${API_BASE}/triggers`,
      input,
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to create trigger');
    }
    return response.data.data;
  }

  /**
   * Pauses an active trigger.
   *
   * @param id - Trigger UUID
   * @returns Promise resolving to the updated trigger
   */
  async pauseTrigger(id: string): Promise<import('../types/trigger.types').Trigger> {
    const response = await axios.post<ApiResponse<import('../types/trigger.types').Trigger>>(
      `${API_BASE}/triggers/${id}/pause`,
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to pause trigger');
    }
    return response.data.data;
  }

  /**
   * Resumes a paused trigger.
   *
   * @param id - Trigger UUID
   * @returns Promise resolving to the updated trigger
   */
  async resumeTrigger(id: string): Promise<import('../types/trigger.types').Trigger> {
    const response = await axios.post<ApiResponse<import('../types/trigger.types').Trigger>>(
      `${API_BASE}/triggers/${id}/resume`,
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to resume trigger');
    }
    return response.data.data;
  }

  /**
   * Cancels a trigger permanently.
   *
   * @param id - Trigger UUID
   * @returns Promise resolving to the updated trigger
   */
  async cancelTrigger(id: string): Promise<import('../types/trigger.types').Trigger> {
    const response = await axios.post<ApiResponse<import('../types/trigger.types').Trigger>>(
      `${API_BASE}/triggers/${id}/cancel`,
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(response.data.error || 'Failed to cancel trigger');
    }
    return response.data.data;
  }

  /**
   * Lists active EventBus subscriptions.
   *
   * @returns Array of event subscriptions
   */
  async getEventSubscriptions(): Promise<import('../types/trigger.types').EventSubscription[]> {
    const response = await axios.get<ApiResponse<import('../types/trigger.types').EventSubscription[]>>(
      `${API_BASE}/events/subscriptions`,
    );
    return response.data.data || [];
  }

  /**
   * Deletes a trigger.
   *
   * @param id - Trigger UUID
   */
  async deleteTrigger(id: string): Promise<void> {
    const response = await axios.delete<ApiResponse<void>>(`${API_BASE}/triggers/${id}`);
    if (!response.data.success) {
      throw new Error(response.data.error || 'Failed to delete trigger');
    }
  }

  // ============ Expert Methods ============

  /**
   * Fetches all available expert profiles.
   *
   * @returns Promise resolving to array of expert summaries
   * @throws Error if the request fails
   */
  async getExperts(): Promise<ExpertSummary[]> {
    const response = await axios.get<ApiResponse<ExpertSummary[]>>(`${API_BASE}/experts`);
    return response.data.data || [];
  }
}

/** Singleton instance of the API service */
export const apiService = new ApiService();
