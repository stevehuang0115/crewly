/**
 * Type definitions for API request bodies and query parameters
 *
 * These interfaces replace `any` type assertions in controller files,
 * providing compile-time type safety for incoming HTTP requests.
 */

import type { TeamMember, TeamMemberRole, Project, TeamBudget, TeamQualityGate } from '../types/index.js';

// =============================================================================
// Project Controller Request Types
// =============================================================================

/**
 * Request body for creating a new project
 */
export interface CreateProjectRequestBody {
  path: string;
  name?: string;
  description?: string;
}

/**
 * Request body for starting a project with team assignments
 */
export interface StartProjectRequestBody {
  teamIds: string[];
}

/**
 * Request body for assigning teams to a project
 */
export interface AssignTeamsRequestBody {
  teamAssignments?: Record<string, string[]>;
}

/**
 * Request body for unassigning a team from a project
 */
export interface UnassignTeamRequestBody {
  teamId: string;
}

/**
 * Query parameters for getting project files
 */
export interface GetProjectFilesQuery {
  depth?: string;
  includeDotFiles?: string;
}

/**
 * Query parameters for getting file content
 */
export interface GetFileContentQuery {
  filePath?: string;
}

/**
 * Query parameters for getting crewly markdown files
 */
export interface GetAgentmuxMarkdownFilesQuery {
  projectPath?: string;
}

/**
 * Request body for saving a markdown file
 */
export interface SaveMarkdownFileRequestBody {
  projectPath: string;
  filePath: string;
  content: string;
}

/**
 * Request body for creating a spec file
 */
export interface CreateSpecFileRequestBody {
  fileName: string;
  content: string;
}

/**
 * Query parameters for getting spec file content
 */
export interface GetSpecFileContentQuery {
  fileName?: string;
}

/**
 * Query parameters for project context options
 */
export interface ProjectContextOptionsQuery {
  includeFiles?: string;
  includeGitHistory?: string;
  includeTickets?: string;
  maxFileSize?: string;
  fileExtensions?: string;
}

// =============================================================================
// Team Controller Request Types
// =============================================================================

/**
 * Request body for creating a new team member during team creation
 */
export interface CreateTeamMemberInput {
  name: string;
  role: TeamMemberRole;
  systemPrompt: string;
  runtimeType?: TeamMember['runtimeType'];
  avatar?: string;
  skillOverrides?: string[];
  excludedRoleSkills?: string[];
  /** Owner-declared skill tags (normalised server-side) */
  skills?: string[];
  /** Whether this member can delegate tasks (for hierarchical teams). */
  canDelegate?: boolean;
  /** Hierarchy level override (auto-set if not provided). */
  hierarchyLevel?: number;
}

/**
 * Request body for creating a new team
 */
export interface CreateTeamRequestBody {
  name: string;
  description?: string;
  members: CreateTeamMemberInput[];
  projectPath?: string;
  currentProject?: string; // Legacy: converted to projectIds on creation
  projectIds?: string[];
  /** Whether this team uses hierarchical management (TL -> Workers). */
  hierarchical?: boolean;
  /** Template ID to create team from. */
  templateId?: string;
  /** Parent team ID for organization grouping. */
  parentTeamId?: string;
  /** Team mission statement (#173). */
  mission?: string;
  /** Token/cost budget configuration (#173). */
  budget?: TeamBudget;
  /** Quality gate configuration for task review (#173). */
  qualityGate?: TeamQualityGate;
}

/**
 * Request body for starting a team
 */
export interface StartTeamRequestBody {
  projectId?: string;
}

/**
 * Request body for adding a new team member
 */
export interface AddTeamMemberRequestBody {
  name: string;
  role: TeamMemberRole;
  avatar?: string;
  /** Whether this member can delegate tasks (for hierarchical teams). */
  canDelegate?: boolean;
  /** Hierarchy level override. */
  hierarchyLevel?: number;
  /** Parent member ID (for hierarchical teams). */
  parentMemberId?: string;
}

/**
 * Request body for updating a team member
 * Allows partial updates of TeamMember fields
 */
export interface UpdateTeamMemberRequestBody {
  name?: string;
  role?: TeamMember['role'];
  avatar?: string;
  systemPrompt?: string;
  runtimeType?: TeamMember['runtimeType'];
}

/**
 * Query parameters for getting team member session output
 */
export interface GetTeamMemberSessionQuery {
  lines?: string | number;
}

/**
 * Request body for reporting a member as ready
 */
export interface ReportMemberReadyRequestBody {
  sessionName: string;
  role: string;
  capabilities?: string[];
  readyAt?: string;
}

/**
 * Request body for registering member status (MCP registration)
 */
export interface RegisterMemberStatusRequestBody {
  sessionName: string;
  role: string;
  status?: string;
  registeredAt?: string;
  memberId?: string;
  /** Claude conversation/session ID for resuming on restart */
  claudeSessionId?: string;
}

/**
 * Query parameters for generating member context
 */
export interface GenerateMemberContextQuery {
  includeFiles?: string;
  includeGitHistory?: string;
  includeTickets?: string;
}

/**
 * Request body for updating team member runtime type
 */
export interface UpdateTeamMemberRuntimeRequestBody {
  runtimeType: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'opencode-cli' | 'crewly-agent';
}

/**
 * Member update data in team update request
 */
export interface TeamMemberUpdate {
  name: string;
  role: string;
  systemPrompt: string;
  runtimeType?: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'opencode-cli' | 'crewly-agent';
  avatar?: string;
  skillOverrides?: string[];
  excludedRoleSkills?: string[];
  /** Owner-declared skill tags (normalised server-side) */
  skills?: string[];
}

/**
 * Request body for updating team properties
 */
export interface UpdateTeamRequestBody {
  name?: string;
  description?: string;
  projectIds?: string[];
  members?: TeamMemberUpdate[];
  /** Toggle hierarchical team management */
  hierarchical?: boolean;
  /** @deprecated Use `leaderIds` instead. */
  leaderId?: string;
  /** Member IDs of the team leaders (supports multiple TLs). */
  leaderIds?: string[];
  /** Parent team ID for organization grouping. */
  parentTeamId?: string | null;
  /** Whether this team is archived (#171). */
  archived?: boolean;
  /** Team mission statement (#173). */
  mission?: string;
  /** Token/cost budget configuration (#173). */
  budget?: TeamBudget;
  /** Quality gate configuration for task review (#173). */
  qualityGate?: TeamQualityGate;
}

// =============================================================================
// Helper type for TeamMember with mutable timestamp fields
// =============================================================================

/**
 * TeamMember with updatedAt as a writable property
 * Used internally when modifying team member records
 */
export interface MutableTeamMember extends Omit<TeamMember, 'updatedAt'> {
  updatedAt: string;
  lastTerminalOutput?: string;
  lastActivityCheck?: string;
  readyAt?: string;
  capabilities?: string[];
}

/**
 * Team with mutable timestamp and optional extension fields
 */
export interface MutableTeam {
  id: string;
  name: string;
  description?: string;
  members: MutableTeamMember[];
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
  hierarchical?: boolean;
  leaderId?: string;
  leaderIds?: string[];
  templateId?: string;
  parentTeamId?: string;
  archived?: boolean;
  archivedAt?: string;
  mission?: string;
  budget?: TeamBudget;
  qualityGate?: TeamQualityGate;
}

/**
 * Project with mutable fields for internal updates
 * Used when modifying project records directly without using ProjectModel
 */
export interface MutableProject extends Omit<Project, 'updatedAt'> {
  updatedAt: string;
  description?: string;
}
