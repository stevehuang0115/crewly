/**
 * API Service - Centralized API client for Crewly backend.
 *
 * Provides methods for interacting with projects, teams, tickets, and tasks.
 * Includes caching and request deduplication for frequently accessed data.
 */

import axios from 'axios';
import { Project, Team, Ticket, ApiResponse, PreviousSession, TeamsBackupStatus, TeamsRestoreResult, QueueStatus, QueuedMessage, KnowledgeDocument, KnowledgeDocumentSummary, KnowledgeScope, CloudStatus, CloudConnectResult } from '../types';
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
}

/** Singleton instance of the API service */
export const apiService = new ApiService();
