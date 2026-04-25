import { Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import type {
  CreateTeamRequestBody,
  StartTeamRequestBody,
  AddTeamMemberRequestBody,
  UpdateTeamMemberRequestBody,
  GetTeamMemberSessionQuery,
  ReportMemberReadyRequestBody,
  RegisterMemberStatusRequestBody,
  GenerateMemberContextQuery,
  UpdateTeamMemberRuntimeRequestBody,
  UpdateTeamRequestBody,
  TeamMemberUpdate,
  MutableTeamMember,
  MutableTeam,
} from '../request-types.js';
import { v4 as uuidv4 } from 'uuid';
import { Team, TeamMember, ApiResponse, ScheduledMessage } from '../../types/index.js';
import {
  ORCHESTRATOR_SESSION_NAME,
  ORCHESTRATOR_ROLE,
  RUNTIME_TYPES,
  NON_RECOVERABLE_ERROR_PATTERNS,
} from '../../constants.js';
import type { RuntimeType } from '../../constants.js';
import { CREWLY_CONSTANTS, AGENT_TIMEOUTS } from '../../constants.js';
import { updateAgentHeartbeat } from '../../services/agent/agent-heartbeat.service.js';
import { getSessionBackendSync, getSessionStatePersistence } from '../../services/session/index.js';
import { getSettingsService } from '../../services/settings/settings.service.js';
import { getTerminalGateway } from '../../websocket/terminal.gateway.js';
import { ActivityMonitorService } from '../../services/monitoring/activity-monitor.service.js';
import { MemoryService } from '../../services/memory/memory.service.js';
import {
  validateAgentRole,
  InvalidAgentRoleError,
} from '../../services/agent/agent-registration.service.js';
import { SubAgentMessageQueue } from '../../services/messaging/sub-agent-message-queue.service.js';
import { SUB_AGENT_QUEUE_CONSTANTS } from '../../constants.js';
import type { EventBusService } from '../../services/event-bus/event-bus.service.js';
import { getCriticalEventTypes } from '../../types/event-bus.types.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('TeamController');

/**
 * Module-level EventBusService instance, injected at startup.
 * Used to auto-subscribe the orchestrator to agent lifecycle events.
 */
let eventBusService: EventBusService | null = null;

/**
 * Set the EventBusService instance for auto-subscribing the orchestrator.
 * Called during server initialization in index.ts.
 *
 * @param service - The EventBusService instance
 */
export function setTeamControllerEventBusService(service: EventBusService): void {
  eventBusService = service;
}

// Session handoff: pushRecentSlackHistory has been replaced by
// SessionHandoffService.pushSessionSummary() which covers all channels
// (Slack, GChat, Chat UI) and sends a structured summary instead of raw lines.

/**
 * Get the default runtime type from user settings, falling back to CLAUDE_CODE.
 *
 * @returns The default runtime type configured in settings
 */
async function getDefaultRuntime(): Promise<TeamMember['runtimeType']> {
  try {
    const settings = await getSettingsService().getSettings();
    return settings.general.defaultRuntime || RUNTIME_TYPES.CLAUDE_CODE;
  } catch {
    return RUNTIME_TYPES.CLAUDE_CODE;
  }
}

/**
 * Check if the auditor is enabled in settings.
 * Used to conditionally include the auditor member in the orchestrator team.
 *
 * @returns True if the auditor is enabled
 */
async function isAuditorEnabled(): Promise<boolean> {
  try {
    const settings = await getSettingsService().getSettings();
    return settings.general.enableAuditor ?? false;
  } catch {
    return false;
  }
}

/**
 * Result of a team member start/stop operation
 */
interface TeamMemberOperationResult {
  success: boolean;
  memberName: string;
  memberId: string;
  sessionName: string | null;
  status: string;
  error?: string;
}

/**
 * Session creation result from agent registration service
 */
interface SessionCreationResult {
  success: boolean;
  sessionName?: string;
  error?: string;
}

/**
 * Current task information for team activity status
 */
interface CurrentTaskInfo {
  id: string;
  taskName: string;
  taskFilePath: string;
  assignedAt: string;
  status: string;
}

/**
 * Member activity status for team activity endpoint
 */
interface MemberActivityStatus {
  teamId: string;
  teamName: string;
  memberId: string;
  memberName: string;
  role: string;
  sessionName: string;
  agentStatus: string;
  workingStatus: string;
  lastActivityCheck: string;
  activityDetected: boolean;
  currentTask: CurrentTaskInfo | null;
  error?: string;
}

/**
 * Orchestrator status shape from storage service
 */
interface OrchestratorStatusInfo {
  agentStatus?: string;
  workingStatus?: string;
  runtimeType?: string;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Computes the lastActivity timestamp for a team.
 *
 * Takes the maximum of the team's own updatedAt and all members' updatedAt
 * timestamps. This represents the most recent agent status change or
 * team configuration update.
 *
 * @param team - The team object with members
 * @returns ISO timestamp of the most recent activity
 */
function computeTeamLastActivity(team: Team): string {
  let latest = team.updatedAt;

  for (const member of team.members) {
    if (member.updatedAt && member.updatedAt > latest) {
      latest = member.updatedAt;
    }
  }

  return latest;
}

/**
 * Augments a team object with the lastActivity field.
 *
 * @param team - The team to augment
 * @returns Team with lastActivity field added
 */
function withLastActivity(team: Team): Team & { lastActivity: string } {
  return {
    ...team,
    lastActivity: computeTeamLastActivity(team),
  };
}

/**
 * Build the virtual orchestrator Team object.
 *
 * The orchestrator is not stored in teams.json but surfaced as a virtual team
 * in the API. This helper eliminates the 3x duplication of the construction.
 *
 * @param actualAgentStatus - Resolved agent status (from session existence check)
 * @param orchestratorStatus - Persisted orchestrator status from storage
 * @param overrides - Optional field overrides (e.g. projectIds for updates)
 * @returns A Team object representing the orchestrator
 */
function buildOrchestratorTeam(
  actualAgentStatus: string,
  orchestratorStatus: OrchestratorStatusInfo | null,
  overrides?: Partial<Team>,
  inProcessRuntimeStatus?: Record<string, boolean>,
  options?: { auditorEnabled?: boolean }
): Team {
  const now = new Date().toISOString();

  // Resolve Assistant status: check in-process runtime active state
  const assistantInProcessActive = inProcessRuntimeStatus?.['crewly-orc-assistant'] ?? false;
  const assistantStatus = assistantInProcessActive
    ? CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE as TeamMember['agentStatus']
    : CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as TeamMember['agentStatus'];

  const members: TeamMember[] = [
    {
      id: 'orchestrator-member',
      name: 'Agentmux Orchestrator',
      sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
      role: 'orchestrator',
      systemPrompt: 'You are the Crewly Orchestrator responsible for coordinating teams and managing project workflows.',
      agentStatus: actualAgentStatus as TeamMember['agentStatus'],
      workingStatus: (orchestratorStatus?.workingStatus || CREWLY_CONSTANTS.WORKING_STATUSES.IDLE) as TeamMember['workingStatus'],
      runtimeType: (orchestratorStatus?.runtimeType || 'claude-code') as TeamMember['runtimeType'],
      createdAt: orchestratorStatus?.createdAt || now,
      updatedAt: orchestratorStatus?.updatedAt || now
    },
    {
      id: 'crewly-orc-assistant-member-001',
      name: 'Assistant',
      sessionName: 'crewly-orc-assistant',
      role: 'orchestrator',
      systemPrompt: 'Shadow orchestrator running in-process via Crewly Agent runtime (AI SDK)',
      agentStatus: assistantStatus,
      workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE as TeamMember['workingStatus'],
      runtimeType: 'crewly-agent' as TeamMember['runtimeType'],
      createdAt: '2026-03-11T02:00:00.000Z',
      updatedAt: now
    },
  ];

  // Only include auditor member when auditor is enabled (default: include for backward compat)
  if (options?.auditorEnabled !== false) {
    const auditorInProcessActive = inProcessRuntimeStatus?.['crewly-auditor'] ?? false;
    const auditorStatus = auditorInProcessActive
      ? CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE as TeamMember['agentStatus']
      : CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as TeamMember['agentStatus'];

    members.push({
      id: 'e5f6a7b8-9012-3cde-f456-auditor00001',
      name: 'Auditor',
      sessionName: 'crewly-auditor',
      role: 'auditor' as TeamMember['role'],
      systemPrompt: 'Autonomous quality observer — monitors all agents, detects problems, writes audit reports',
      agentStatus: auditorStatus,
      workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE as TeamMember['workingStatus'],
      runtimeType: 'claude-code' as TeamMember['runtimeType'],
      createdAt: '2026-03-11T02:10:00.000Z',
      updatedAt: now
    });
  }

  return {
    id: 'orchestrator',
    name: 'Orchestrator Team',
    description: 'System orchestrator for project management',
    members,
    projectIds: [],
    createdAt: orchestratorStatus?.createdAt || now,
    updatedAt: orchestratorStatus?.updatedAt || now,
    ...overrides,
  } as Team;
}

/**
 * Resolve the display agent status based on stored state and live session presence.
 *
 * When a PTY session is alive but the agent hasn't registered yet, we keep
 * the "started"/"starting" states instead of incorrectly elevating to "active".
 * Conversely, if the session has disappeared we immediately report "inactive"
 * regardless of the stored status to avoid stale UI.
 */
/**
 * Build a map of in-process runtime active states for orchestrator virtual members.
 *
 * @param agentRegistrationService - The agent registration service instance
 * @returns Record mapping session names to their active state
 */
function getInProcessRuntimeStatusMap(agentRegistrationService: { isInProcessRuntimeActive(sessionName: string): boolean }): Record<string, boolean> {
  const status: Record<string, boolean> = {};
  for (const sessionName of ['crewly-orc-assistant', 'crewly-auditor']) {
    status[sessionName] = agentRegistrationService.isInProcessRuntimeActive(sessionName);
  }
  return status;
}

function resolveAgentStatus(
  storedStatus: TeamMember['agentStatus'] | undefined,
  sessionExists: boolean,
  isInProcessActive = false
): TeamMember['agentStatus'] {
  // In-process runtimes have no PTY session, so sessionExists will be false.
  // When the runtime is active, trust the stored status or report as active.
  if (!sessionExists && isInProcessActive) {
    if (storedStatus && storedStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE) {
      return storedStatus;
    }
    return CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE as TeamMember['agentStatus'];
  }

  if (!sessionExists) {
    return CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as TeamMember['agentStatus'];
  }

  if (!storedStatus || storedStatus === CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE) {
    return CREWLY_CONSTANTS.AGENT_STATUSES.STARTED as TeamMember['agentStatus'];
  }

  return storedStatus;
}

/**
 * Core logic for starting a single team member
 * @param context - API context with services
 * @param team - The team containing the member
 * @param member - The team member to start
 * @param projectPath - Optional project path for the session
 * @returns Result of the start operation
 */
async function _startTeamMemberCore(
  context: ApiContext,
  team: Team,
  member: TeamMember,
  projectPath?: string
): Promise<TeamMemberOperationResult> {
  try {
    // Guard against members with no role — without this, undefined flows into
    // session creation, gets stringified to "undefined" in CREWLY_ROLE, and
    // produces the silent "empty Claude prompt" failure. Surface the misconfig
    // immediately so the operator can fix the team config (Bug #1).
    try {
      validateAgentRole(member.role, `_startTeamMemberCore[team=${team.id} member=${member.id}]`);
    } catch (err) {
      const errMessage = err instanceof InvalidAgentRoleError ? err.message
        : err instanceof Error ? err.message
        : String(err);
      logger.error('Refusing to start team member with invalid role', {
        teamId: team.id,
        memberId: member.id,
        memberName: member.name,
        receivedRole: member.role,
        error: errMessage,
      });
      // Reset agentStatus so we don't leave the member stuck in 'starting'
      try {
        const resetTeams = await context.storageService.getTeams();
        const resetTeam = resetTeams.find(t => t.id === team.id);
        const resetMember = resetTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;
        if (resetTeam && resetMember && resetMember.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTING) {
          resetMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
          resetMember.dropoutReason = 'invalid_role';
          resetMember.updatedAt = new Date().toISOString();
          await context.storageService.saveTeam(resetTeam);
        }
      } catch (resetErr) {
        logger.warn('Failed to reset member status after role validation failure', {
          memberId: member.id,
          error: resetErr instanceof Error ? resetErr.message : String(resetErr),
        });
      }
      return {
        success: false,
        memberName: member.name,
        memberId: member.id,
        sessionName: null,
        status: 'failed',
        error: errMessage,
      };
    }

    // Check if member already has an active session
    if (member.sessionName) {
      const sessions = await context.tmuxService.listSessions();
      const hasActiveSession = sessions.some(s => s.sessionName === member.sessionName);
      if (hasActiveSession) {
        // Handle synchronization issue: session exists but status might be inactive
        if (member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE) {
          try {
            // Try to check if the agent in the session is responsive
            const captureResult = await Promise.race([
              context.tmuxService.capturePane(member.sessionName, 5),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error('Agent check timeout')), 1000)
              )
            ]);

            // If we can capture output, the session is likely active
            if (captureResult && captureResult.length > 0) {
              // Load fresh team data to avoid race conditions
              const currentTeams = await context.storageService.getTeams();
              const currentTeam = currentTeams.find(t => t.id === team.id);
              const currentMember = currentTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;

              if (currentTeam && currentMember) {
                // Update status to active to sync with session state
                currentMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
                currentMember.workingStatus = currentMember.workingStatus || 'working';
                currentMember.updatedAt = new Date().toISOString();

                await context.storageService.saveTeam(currentTeam);
              }

              return {
                success: true,
                memberName: member.name,
                memberId: member.id,
                sessionName: member.sessionName,
                status: 'synchronized'
              };
            } else {
              // Session exists but appears zombie - kill it and proceed with new creation
              logger.warn('Cleaning up zombie session', { sessionName: member.sessionName });
              await context.tmuxService.killSession(member.sessionName).catch(() => {
                // Ignore errors if session doesn't exist
              });
              // Clear the session name and allow new session creation (but don't save yet)
              member.sessionName = '';
              (member as MutableTeamMember).updatedAt = new Date().toISOString();
            }
          } catch (error) {
            // If we can't check the session, assume it's zombie and clean it up
            logger.warn('Error checking session, treating as zombie', { sessionName: member.sessionName, error: error instanceof Error ? error.message : String(error) });
            await context.tmuxService.killSession(member.sessionName).catch(() => {
              // Ignore errors if session doesn't exist
            });
            // Clear the session name and allow new session creation (but don't save yet)
            member.sessionName = '';
            (member as MutableTeamMember).updatedAt = new Date().toISOString();
          }
        } else {
          // Session exists and agent status is active/activating/starting — skip this member
          // Restore the agentStatus to ACTIVE in storage (it may have been set to STARTING by the caller)
          const freshTeams = await context.storageService.getTeams();
          const freshTeam = freshTeams.find(t => t.id === team.id);
          const freshMember = freshTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;
          if (freshTeam && freshMember && freshMember.agentStatus !== CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE) {
            freshMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
            freshMember.updatedAt = new Date().toISOString();
            await context.storageService.saveTeam(freshTeam);
          }

          return {
            success: true,
            memberName: member.name,
            memberId: member.id,
            sessionName: member.sessionName,
            status: 'already_active',
          };
        }
      }
    }

    // Only prevent processing if member has BOTH active status AND an existing session
    // This allows newly 'activating' members (set by API endpoints) to proceed with session creation
    if (member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE && member.sessionName) {
      // Double-check that the session actually exists
      const sessions = await context.tmuxService.listSessions();
      const hasActiveSession = sessions.some(s => s.sessionName === member.sessionName);
      if (hasActiveSession) {
        return {
          success: false,
          memberName: member.name,
          memberId: member.id,
          sessionName: member.sessionName,
          status: member.agentStatus,
          error: `Team member is already active with session ${member.sessionName}`
        };
      } else {
        // Session doesn't exist, clear sessionName and allow new creation (but don't save yet)
        member.sessionName = '';
        (member as MutableTeamMember).updatedAt = new Date().toISOString();
      }
    }

    // Generate session name
    const teamSlug = team.name.toLowerCase().replace(/\s+/g, '-');
    const memberSlug = member.name.toLowerCase().replace(/\s+/g, '-');
    const memberIdSlug = member.id.substring(0, 8);
    const sessionName = `${teamSlug}-${memberSlug}-${memberIdSlug}`;

    // Load fresh team data before making any changes to avoid race conditions with MCP registration
    const currentTeams = await context.storageService.getTeams();
    const currentTeam = currentTeams.find(t => t.id === team.id);
    const currentMember = currentTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;

    if (!currentTeam || !currentMember) {
      return {
        success: false,
        memberName: member.name,
        memberId: member.id,
        sessionName: null,
        status: 'failed',
        error: 'Team or member not found during session creation'
      };
    }

    // Set sessionName in team member BEFORE creating session to avoid race condition
    // Use fresh team data to preserve any concurrent agentStatus updates
    currentMember.sessionName = sessionName;
    currentMember.workingStatus = currentMember.workingStatus || CREWLY_CONSTANTS.WORKING_STATUSES.IDLE;
    currentMember.updatedAt = new Date().toISOString();

    await context.storageService.saveTeam(currentTeam);

    // Use the unified agent registration service for team member creation with retry logic
    // This helps handle race conditions in tmux session creation
    const MAX_CREATION_RETRIES = 3;
    let createResult: SessionCreationResult = { success: false };
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= MAX_CREATION_RETRIES; attempt++) {
      createResult = await context.agentRegistrationService.createAgentSession({
        sessionName,
        role: currentMember.role,
        projectPath: projectPath,
        memberId: currentMember.id,
        teamId: team.id,
        runtimeType: (currentMember.runtimeType as RuntimeType) || undefined,
      });

      if (createResult.success) {
        break;
      }

      lastError = createResult.error;

      // Don't retry non-recoverable errors (e.g. missing CLI binary)
      if (lastError && NON_RECOVERABLE_ERROR_PATTERNS.some(p => lastError!.includes(p))) {
        logger.error('Non-recoverable error detected, skipping retries', { sessionName, lastError });
        break;
      }

      // If this isn't the last attempt, wait before retrying with exponential backoff
      if (attempt < MAX_CREATION_RETRIES) {
        const retryDelay = 1000 * attempt; // 1s, 2s exponential backoff
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }

    if (createResult.success) {
      // Initialize memory for this team member so remember/recall MCP tools work
      try {
        const memoryService = MemoryService.getInstance();
        await memoryService.initializeForSession(
          sessionName,
          currentMember.role,
          projectPath || process.cwd()
        );
      } catch (memError) {
        logger.warn('Failed to initialize memory', { sessionName, error: memError instanceof Error ? memError.message : String(memError) });
      }

      // #252: Start a watchdog timer to detect agents stuck in 'starting' state.
      // If agent hasn't registered (reached 'active' or 'started') within STARTING_WATCHDOG timeout,
      // reset to 'inactive' with a dropout reason so the orchestrator can take action.
      // NOTE (#288): Only STARTING agents are reset. STARTED means the agent process
      // launched and registered successfully — it should NOT be forcibly killed.
      setTimeout(async () => {
        try {
          const watchdogTeams = await context.storageService.getTeams();
          const watchdogTeam = watchdogTeams.find(t => t.id === team.id);
          const watchdogMember = watchdogTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;
          if (watchdogTeam && watchdogMember &&
              watchdogMember.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.STARTING) {
            logger.warn('Agent stuck in starting state — watchdog triggering reset (#252)', {
              sessionName,
              memberId: member.id,
              agentStatus: watchdogMember.agentStatus,
              timeoutMs: AGENT_TIMEOUTS.STARTING_WATCHDOG,
            });
            watchdogMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
            watchdogMember.dropoutReason = 'startup_timeout';
            watchdogMember.updatedAt = new Date().toISOString();
            await context.storageService.saveTeam(watchdogTeam);
          }
        } catch (watchdogError) {
          logger.error('Starting watchdog error', {
            sessionName,
            error: watchdogError instanceof Error ? watchdogError.message : String(watchdogError),
          });
        }
      }, AGENT_TIMEOUTS.STARTING_WATCHDOG).unref();

      // CRITICAL: Load fresh data again after session creation to preserve MCP registration updates
      const finalTeams = await context.storageService.getTeams();
      const finalTeam = finalTeams.find(t => t.id === team.id);
      const finalMember = finalTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;

      if (finalTeam && finalMember) {
        // Only update sessionName if needed, preserve all other fields including agentStatus
        const needsSessionUpdate = finalMember.sessionName !== (createResult.sessionName || sessionName);

        if (needsSessionUpdate) {
          finalMember.sessionName = createResult.sessionName || sessionName;
          finalMember.updatedAt = new Date().toISOString();

          await context.storageService.saveTeam(finalTeam);
        }

        return {
          success: true,
          memberName: finalMember.name,
          memberId: finalMember.id,
          sessionName: createResult.sessionName || sessionName,
          status: finalMember.agentStatus
        };
      } else {
        logger.error('Team or member not found after session creation', { teamId: team.id, memberId: member.id });
        return {
          success: false,
          memberName: member.name,
          memberId: member.id,
          sessionName: null,
          status: 'failed',
          error: 'Team or member not found after session creation'
        };
      }
    } else {
      // Load fresh data before updating failure status
      const failureTeams = await context.storageService.getTeams();
      const failureTeam = failureTeams.find(t => t.id === team.id);
      const failureMember = failureTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;

      if (failureTeam && failureMember) {
        // Reset to inactive if session creation failed
        failureMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
        failureMember.sessionName = '';
        failureMember.updatedAt = new Date().toISOString();
        await context.storageService.saveTeam(failureTeam);
      }

      logger.error('All session creation attempts failed', { retries: MAX_CREATION_RETRIES, memberName: member.name, lastError });
      return {
        success: false,
        memberName: member.name,
        memberId: member.id,
        sessionName: null,
        status: 'failed',
        error: lastError || createResult?.error || `Failed to create team member session after ${MAX_CREATION_RETRIES} attempts`
      };
    }
  } catch (error) {
    // Load fresh data before updating error status
    const errorTeams = await context.storageService.getTeams();
    const errorTeam = errorTeams.find(t => t.id === team.id);
    const errorMember = errorTeam?.members.find(m => m.id === member.id) as MutableTeamMember | undefined;

    if (errorTeam && errorMember) {
      // Reset to inactive if session creation failed
      errorMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
      errorMember.sessionName = '';
      errorMember.updatedAt = new Date().toISOString();
      await context.storageService.saveTeam(errorTeam);
    }

    logger.error('Error starting team member', { error: error instanceof Error ? error.message : String(error) });
    return {
      success: false,
      memberName: member.name,
      memberId: member.id,
      sessionName: null,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Core logic for stopping a single team member
 * @param context - API context with services
 * @param team - The team containing the member
 * @param member - The team member to stop
 * @returns Result of the stop operation
 */
async function _stopTeamMemberCore(
  context: ApiContext,
  team: Team,
  member: TeamMember
): Promise<TeamMemberOperationResult> {
  try {
    // Use the unified agent registration service for team member termination
    if (member.sessionName) {
      const stopResult = await context.agentRegistrationService.terminateAgentSession(
        member.sessionName,
        member.role
      );

      if (!stopResult.success) {
        logger.error('Failed to terminate team member session', { error: stopResult.error });
        return {
          success: false,
          memberName: member.name,
          memberId: member.id,
          sessionName: member.sessionName,
          status: 'failed',
          error: stopResult.error || 'Failed to stop team member session'
        };
      }
    }

    // Update team member status
    const oldSessionName = member.sessionName;
    const mutableMember = member as MutableTeamMember;
    mutableMember.sessionName = '';
    mutableMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
    mutableMember.workingStatus = CREWLY_CONSTANTS.WORKING_STATUSES.IDLE;
    // #235: Record manual stop as dropout reason
    (mutableMember as any).dropoutReason = 'manual';
    mutableMember.updatedAt = new Date().toISOString();
    await context.storageService.saveTeam(team);

    return {
      success: true,
      memberName: member.name,
      memberId: member.id,
      sessionName: oldSessionName,
      status: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
    };
  } catch (error) {
    logger.error('Error stopping team member', { error: error instanceof Error ? error.message : String(error) });
    return {
      success: false,
      memberName: member.name,
      memberId: member.id,
      sessionName: member.sessionName || null,
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Orchestrator reads agent status on-demand; no push subscriptions.

export async function createTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { name, description, members, projectPath, currentProject, projectIds, hierarchical, templateId, parentTeamId, mission, budget, qualityGate } = req.body as CreateTeamRequestBody;

    if (!name || !members || !Array.isArray(members) || members.length === 0) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields: name and members array'
      } as ApiResponse);
      return;
    }

    for (const member of members) {
      if (!member.name || !member.role || !member.systemPrompt) {
        res.status(400).json({
          success: false,
          error: 'All team members must have name, role, and systemPrompt'
        } as ApiResponse);
        return;
      }
    }

    // Validate hierarchical team requirements
    if (hierarchical) {
      const leaders = members.filter(m => m.role === 'team-leader' || m.canDelegate);
      if (leaders.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Hierarchical teams require at least one team-leader or member with canDelegate=true'
        } as ApiResponse);
        return;
      }
    }

    const existingTeams = await this.storageService.getTeams();
    if (existingTeams.find(t => t.name === name)) {
      res.status(409).json({
        success: false,
        error: `Team with name "${name}" already exists`
      } as ApiResponse);
      return;
    }

    // Validate parentTeamId references an existing team
    if (parentTeamId) {
      // Orchestrator is a system team and cannot be used as a parent
      if (parentTeamId === CREWLY_CONSTANTS.AGENT_IDS.ORCHESTRATOR_ID) {
        res.status(400).json({
          success: false,
          error: 'Cannot use Orchestrator Team as parent — it is a system team'
        } as ApiResponse);
        return;
      }

      const parentTeam = existingTeams.find(t => t.id === parentTeamId);
      if (!parentTeam) {
        res.status(400).json({
          success: false,
          error: `Parent team with id "${parentTeamId}" not found`
        } as ApiResponse);
        return;
      }
    }

    const teamId = uuidv4();
    const teamMembers: TeamMember[] = [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const memberId = uuidv4();

      const isLeaderRole = member.role === 'team-leader' || member.canDelegate === true;

      const teamMember: TeamMember = {
        id: memberId,
        name: member.name,
        sessionName: '',
        role: member.role,
        avatar: member.avatar,
        systemPrompt: member.systemPrompt,
        agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
        workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
        runtimeType: member.runtimeType || await getDefaultRuntime(),
        skillOverrides: member.skillOverrides || [],
        excludedRoleSkills: member.excludedRoleSkills || [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Hierarchy fields (only set for hierarchical teams)
        ...(hierarchical ? {
          hierarchyLevel: member.hierarchyLevel ?? (isLeaderRole ? 1 : 2),
          canDelegate: isLeaderRole,
          subordinateIds: [],
        } : {}),
      };

      teamMembers.push(teamMember);
    }

    // For hierarchical teams: wire up parent-child relationships
    let leaderId: string | undefined;
    let leaderIds: string[] | undefined;
    if (hierarchical) {
      // Collect all leaders (team-leader role or canDelegate)
      const leaders = teamMembers.filter(m => m.role === 'team-leader' || m.canDelegate);
      if (leaders.length > 0) {
        leaderIds = leaders.map(l => l.id);
        leaderId = leaderIds[0];

        // For single-leader teams, wire all workers under the one leader
        if (leaders.length === 1) {
          const leader = leaders[0];
          const workers = teamMembers.filter(m => m.id !== leader.id);
          leader.subordinateIds = workers.map(w => w.id);
          for (const worker of workers) {
            worker.parentMemberId = leader.id;
          }
        }
        // For multi-leader teams, subordinateIds are managed via parentMemberId on each worker
      }
    }

    const team: Team = {
      id: teamId,
      name,
      description: description || '',
      members: teamMembers,
      projectIds: projectIds || (currentProject ? [currentProject] : []),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(hierarchical ? { hierarchical: true, leaderId, leaderIds } : {}),
      ...(templateId ? { templateId } : {}),
      ...(parentTeamId ? { parentTeamId } : {}),
      ...(mission ? { mission } : {}),
      ...(budget ? { budget } : {}),
      ...(qualityGate ? { qualityGate } : {}),
    };

    await this.storageService.saveTeam(team);

    for (const member of teamMembers) {
      if (member.role === 'tpm') {
        // TPM uses file-based workflow (no duplicate messages)
      } else {
        this.schedulerService.scheduleDefaultCheckins(member.sessionName);
      }
    }

    res.status(201).json({
      success: true,
      data: team,
      message: 'Team created and sessions started successfully'
    } as ApiResponse<Team>);

  } catch (error) {
    logger.error('Error creating team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create team'
    } as ApiResponse);
  }
}

export async function getTeams(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    let teams = await this.storageService.getTeams();
    const orchestratorStatus = await this.storageService.getOrchestratorStatus();

    // #171: Filter out archived teams unless ?includeArchived=true
    const includeArchived = req.query?.includeArchived === 'true';
    if (!includeArchived) {
      teams = teams.filter(t => !t.archived);
    }

    // Check actual PTY session existence for accurate status
    const backend = getSessionBackendSync();
    const orchestratorSessionExists = backend?.sessionExists(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME) || false;

    const actualOrchestratorStatus = resolveAgentStatus(
      orchestratorStatus?.agentStatus as TeamMember['agentStatus'],
      orchestratorSessionExists
    );

    // Check in-process runtime status for virtual team members (Assistant, Auditor)
    const inProcessRuntimeStatus = getInProcessRuntimeStatusMap(this.agentRegistrationService);

    const auditorEnabled = await isAuditorEnabled();
    const orchestratorTeam = buildOrchestratorTeam(actualOrchestratorStatus, orchestratorStatus, undefined, inProcessRuntimeStatus, { auditorEnabled });

    // Load working status data from ActivityMonitorService
    let workingStatusData;
    try {
      const activityMonitor = ActivityMonitorService.getInstance();
      workingStatusData = await activityMonitor.getTeamWorkingStatus();
    } catch {
      // Non-fatal: fall back to teams.json workingStatus values
      workingStatusData = null;
    }

    // Also update status for team members based on actual session existence
    const teamsWithActualStatus = teams.map(team => ({
      ...team,
      members: team.members.map(member => {
        const memberSessionExists = backend?.sessionExists(member.sessionName) || false;
        const isInProcessActive = this.agentRegistrationService.isInProcessRuntimeActive(member.sessionName);
        const resolvedStatus = resolveAgentStatus(member.agentStatus, memberSessionExists, isInProcessActive);
        const resolvedWorkingStatus = workingStatusData?.teamMembers[member.sessionName]?.workingStatus || member.workingStatus || 'idle';
        return {
          ...member,
          agentStatus: resolvedStatus,
          workingStatus: resolvedWorkingStatus,
        };
      })
    }));

    const allTeams = [orchestratorTeam, ...teamsWithActualStatus].map(withLastActivity);
    res.json({
      success: true,
      data: allTeams,
      orchestrator: {
        ...orchestratorStatus,
        agentStatus: actualOrchestratorStatus
      }
  } as ApiResponse<Team[]>);
  } catch (error) {
    logger.error('Error getting teams', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve teams'
    } as ApiResponse);
  }
}

export async function getTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (id === 'orchestrator') {
      const orchestratorStatus = await this.storageService.getOrchestratorStatus();

      // Check actual PTY session existence for accurate status
      const backend = getSessionBackendSync();
      const orchestratorSessionExists = backend?.sessionExists(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME) || false;

      const actualOrchestratorStatus = resolveAgentStatus(
        orchestratorStatus?.agentStatus as TeamMember['agentStatus'],
        orchestratorSessionExists
      );

      const inProcessStatus = getInProcessRuntimeStatusMap(this.agentRegistrationService);
      const auditorEnabled = await isAuditorEnabled();
      const orchestratorTeam = buildOrchestratorTeam(actualOrchestratorStatus, orchestratorStatus, undefined, inProcessStatus, { auditorEnabled });
      res.json({ success: true, data: withLastActivity(orchestratorTeam) } as ApiResponse<Team & { lastActivity: string }>);
      return;
    }

    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id);
    if (!team) {
      res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse);
      return;
    }

    // Load working status data from ActivityMonitorService
    let workingStatusData;
    try {
      const activityMonitor = ActivityMonitorService.getInstance();
      workingStatusData = await activityMonitor.getTeamWorkingStatus();
    } catch {
      workingStatusData = null;
    }

    // Verify actual session existence for each member to avoid stale status
    const backend = getSessionBackendSync();
    if (backend) {
      for (const member of team.members) {
        if (member.sessionName) {
          const sessionExists = backend.sessionExists(member.sessionName);
          const resolvedStatus = resolveAgentStatus(member.agentStatus, sessionExists);
          (member as MutableTeamMember).agentStatus = resolvedStatus;
          if (!sessionExists) {
            (member as MutableTeamMember).sessionName = '';
          }
        }
        // Merge working status from ActivityMonitorService
        const liveWorkingStatus = workingStatusData?.teamMembers[member.sessionName]?.workingStatus;
        if (liveWorkingStatus) {
          (member as MutableTeamMember).workingStatus = liveWorkingStatus;
        }
      }
    }

    res.json({ success: true, data: withLastActivity(team) } as ApiResponse<Team & { lastActivity: string }>);
  } catch (error) {
    logger.error('Error getting team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to retrieve team' } as ApiResponse);
  }
}

export async function startTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { projectId } = req.body as StartTeamRequestBody;

    if (id === ORCHESTRATOR_ROLE) {
      res.status(400).json({
        success: false,
        error: 'Orchestrator is managed at system level. Use /orchestrator/setup endpoint instead.'
      } as ApiResponse);
      return;
    }

    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id) as MutableTeam | undefined;
    if (!team) {
      res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse);
      return;
    }

    const projects = await this.storageService.getProjects();
    let targetProjectId = projectId || team.projectIds[0];

    if (!targetProjectId) {
      res.status(400).json({ success: false, error: 'No project specified. Please select a project to assign this team to.' } as ApiResponse);
      return;
    }

    const assignedProject = projects.find(p => p.id === targetProjectId);
    if (!assignedProject) {
      res.status(400).json({ success: false, error: 'Selected project not found. Please check project selection.' } as ApiResponse);
      return;
    }

    // Update team's projectIds to persist the project assignment
    if (!team.projectIds.includes(targetProjectId)) {
      team.projectIds.push(targetProjectId);
    }
    team.updatedAt = new Date().toISOString();
    await this.storageService.saveTeam(team);

    let sessionsCreated = 0;
    let sessionsAlreadyRunning = 0;
    const results: TeamMemberOperationResult[] = [];

    // PHASE 2: Set inactive members to 'starting' for instant UI feedback
    // Skip members that are already active/started/starting to avoid interrupting running agents
    const NON_STARTABLE_STATUSES: Set<string> = new Set([
      CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
      CREWLY_CONSTANTS.AGENT_STATUSES.STARTED,
      CREWLY_CONSTANTS.AGENT_STATUSES.STARTING,
      CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING,
    ]);
    const alreadyActiveMembers = new Set<string>();
    for (const member of team.members) {
      if (NON_STARTABLE_STATUSES.has(member.agentStatus)) {
        alreadyActiveMembers.add(member.id);
      } else {
        const mutableMember = member as MutableTeamMember;
        mutableMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.STARTING;
        mutableMember.updatedAt = new Date().toISOString();
      }
    }
    await this.storageService.saveTeam(team);

    // Start each team member using the internal helper function (skip verified active members)
    for (const member of team.members) {
      // Fast-path: if the member was already active before PHASE 2, verify session and skip
      if (alreadyActiveMembers.has(member.id) && member.sessionName) {
        const sessions = await this.tmuxService.listSessions();
        const hasLiveSession = sessions.some(s => s.sessionName === member.sessionName);
        if (hasLiveSession) {
          sessionsAlreadyRunning++;
          results.push({
            memberName: member.name,
            sessionName: member.sessionName,
            status: 'already_running',
            success: true,
            memberId: member.id,
          });
          continue;
        }
        // Session doesn't exist despite active status — fall through to start it
      }

      const result = await _startTeamMemberCore(this, team, member, assignedProject.path);

      // Convert internal result to the expected format for the response
      const resultForResponse: TeamMemberOperationResult = {
        memberName: result.memberName,
        sessionName: result.sessionName,
        status: result.status === 'synchronized' ? 'already_running' : result.status,
        success: result.success,
        memberId: result.memberId
      };

      if (result.error) {
        resultForResponse.error = result.error;
      }

      // Count sessions for response
      if (result.success) {
        if (result.status === 'synchronized' || result.status === 'already_active') {
          sessionsAlreadyRunning++;
        } else if (result.status !== 'failed') {
          sessionsCreated++;
        }
      }

      results.push(resultForResponse);
    }

    // Note: Individual member sessions save their own status updates during registration
    // No need to save the team object here as it would overwrite the updated agentStatus
    // from MCP registration with stale data

    const responseMessage = `Team started. Created ${sessionsCreated} new sessions, ${sessionsAlreadyRunning} already running. Sessions are working in project: ${assignedProject.name}`;
    res.json({
      success: true,
      message: responseMessage,
      data: { sessionsCreated, sessionsAlreadyRunning, projectName: assignedProject.name, projectPath: assignedProject.path, results }
    } as ApiResponse);
  } catch (error) {
    logger.error('Error starting team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to start team' } as ApiResponse);
  }
}

export async function stopTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (id === 'orchestrator') {
      res.json({ success: true, message: 'Orchestrator session cannot be stopped as it manages the system', data: { sessionsStopped: 0, sessionsNotFound: 0, results: [] } } as ApiResponse);
      return;
    }
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id) as MutableTeam | undefined;
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }

    let sessionsStopped = 0; let sessionsNotFound = 0; const results: TeamMemberOperationResult[] = [];

    // Stop each team member using the internal helper function
    for (const member of team.members) {
      if (!member.sessionName) {
        // Handle members with no active session
        results.push({ memberName: member.name, memberId: member.id, sessionName: null, status: 'no_session', success: true });
        continue;
      }

      const result = await _stopTeamMemberCore(this, team, member);

      // Convert internal result to the expected format for the response
      const resultForResponse: TeamMemberOperationResult = {
        memberName: result.memberName,
        memberId: result.memberId,
        sessionName: result.sessionName,
        status: result.success ? 'stopped' : (result.status === 'failed' ? 'failed' : 'not_found'),
        success: result.success,
      };

      if (result.error) {
        resultForResponse.error = result.error;
      }

      // Count sessions for response
      if (result.success) {
        sessionsStopped++;
      } else if (result.status === 'not_found' || (result.error && result.error.includes('not found'))) {
        sessionsNotFound++;
        resultForResponse.status = 'not_found';
      }

      results.push(resultForResponse);
    }

    // Update team timestamp after all members have been processed
    team.updatedAt = new Date().toISOString();
    await this.storageService.saveTeam(team);

    if (this.messageSchedulerService) {
      try {
        const scheduledMessages = await this.storageService.getScheduledMessages();
        const teamMessages = scheduledMessages.filter(msg => msg.targetTeam === team.id);
        for (const message of teamMessages) {
          const mutableMessage = { ...message, isActive: false };
          await this.storageService.saveScheduledMessage(mutableMessage);
          this.messageSchedulerService.cancelMessage(message.id);
        }
      } catch (error) {
        logger.error('Error cancelling team scheduled messages', { error: error instanceof Error ? error.message : String(error) });
      }
    }
    res.json({ success: true, message: `Team stopped. Stopped ${sessionsStopped} sessions, ${sessionsNotFound} were already stopped.`, data: { sessionsStopped, sessionsNotFound, results } } as ApiResponse);
  } catch (error) {
    logger.error('Error stopping team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to stop team' } as ApiResponse);
  }
}

export async function getTeamWorkload(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id);
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const projects = await this.storageService.getProjects();
    let assignedTickets = 0; let completedTickets = 0;
    for (const project of projects) {
      const tickets = await this.storageService.getTickets(project.path, { assignedTo: id });
      assignedTickets += tickets.length;
      completedTickets += tickets.filter((t) => t.status === 'done').length;
    }
    res.json({ success: true, data: { teamId: id, teamName: team.name, assignedTickets, completedTickets, workloadPercentage: assignedTickets > 0 ? Math.round((completedTickets / assignedTickets) * 100) : 0 } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting team workload', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to retrieve team workload' } as ApiResponse);
  }
}

export async function deleteTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    if (id === 'orchestrator') {
      res.status(400).json({ success: false, error: 'Cannot delete the Orchestrator Team' } as ApiResponse);
      return;
    }
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id);
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }

    try {
      const orchestratorSession = CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME;
      const sessionExists = await this.tmuxService.sessionExists(orchestratorSession);
      if (sessionExists) {
        const sessionNames = team.members?.map(m => m.sessionName).filter(Boolean) || [];
        const orchestratorPrompt = `## Team Deletion Notification\n\nTeam **"${team.name}"** (ID: ${id}) is being deleted.\n\n### Sessions to be terminated:\n${sessionNames.length > 0 ? sessionNames.map(name => `- ${name}`).join('\n') : '- No active sessions'}\n\n### Team Details:\n- **Team Name**: ${team.name}\n- **Members**: ${team.members?.length || 0}\n- **Current Projects**: ${team.projectIds?.length ? team.projectIds.join(', ') : 'None'}\n\nThe orchestrator should be aware that these team members are no longer available for task delegation.\n\n---\n*Team deletion initiated by user request.*`;
        await this.tmuxService.sendMessage(orchestratorSession, orchestratorPrompt);
      }
    } catch (notificationError) {
      logger.warn('Failed to notify orchestrator about team deletion', { error: notificationError instanceof Error ? notificationError.message : String(notificationError) });
    }

    if (team.members && team.members.length > 0) {
      for (const member of team.members) {
        if (member.sessionName) {
          try {
            await this.tmuxService.killSession(member.sessionName);
            this.schedulerService.cancelAllChecksForSession(member.sessionName);
          } catch (error) {
            logger.warn('Failed to kill session for member', { memberName: member.name, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
    // Unset parentTeamId on any child teams referencing this team
    const childTeams = teams.filter(t => t.parentTeamId === id);
    for (const child of childTeams) {
      (child as MutableTeam).parentTeamId = undefined;
      (child as MutableTeam).updatedAt = new Date().toISOString();
      await this.storageService.saveTeam(child);
    }

    await this.storageService.deleteTeam(id);
    res.json({ success: true, message: 'Team terminated successfully' } as ApiResponse);
  } catch (error) {
    logger.error('Error deleting team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to terminate team' } as ApiResponse);
  }
}

export async function getTeamMemberSession(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const { lines = 50 } = req.query as GetTeamMemberSessionQuery;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const member = team.members?.find(m => m.id === memberId);
    if (!member) { res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse); return; }
    if (!member.sessionName) { res.status(400).json({ success: false, error: 'No active session for this team member' } as ApiResponse); return; }
    const output = await this.tmuxService.capturePane(member.sessionName, Number(lines));
    res.json({ success: true, data: { memberId: member.id, memberName: member.name, sessionName: member.sessionName, output, timestamp: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error getting team member session', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to get team member session' } as ApiResponse);
  }
}

export async function addTeamMember(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, role, avatar } = req.body as AddTeamMemberRequestBody;
    if (!name || !role) { res.status(400).json({ success: false, error: 'Name and role are required' } as ApiResponse); return; }
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id) as MutableTeam | undefined;
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const newMember: TeamMember = {
      id: `member-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: String(name).trim(),
      sessionName: '',
      role: role,
      avatar: avatar,
      systemPrompt: `You are ${name}, a ${role} on the ${team.name} team.`,
      agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
      workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
      runtimeType: await getDefaultRuntime(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    team.members.push(newMember as MutableTeamMember);
    team.updatedAt = new Date().toISOString();
    await this.storageService.saveTeam(team);
    res.json({ success: true, data: newMember, message: 'Team member added successfully' } as ApiResponse<TeamMember>);
  } catch (error) {
    logger.error('Error adding team member', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to add team member' } as ApiResponse);
  }
}

export async function updateTeamMember(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const updates = req.body as UpdateTeamMemberRequestBody;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId) as MutableTeam | undefined;
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const memberIndex = team.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) { res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse); return; }
    const updatedMember: MutableTeamMember = { ...team.members[memberIndex], ...updates, updatedAt: new Date().toISOString() };
    team.members[memberIndex] = updatedMember;
    team.updatedAt = new Date().toISOString();
    await this.storageService.saveTeam(team);
    res.json({ success: true, data: updatedMember, message: 'Team member updated successfully' } as ApiResponse<TeamMember>);
  } catch (error) {
    logger.error('Error updating team member', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to update team member' } as ApiResponse);
  }
}

export async function deleteTeamMember(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId) as MutableTeam | undefined;
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const memberIndex = team.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) { res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse); return; }
    const member = team.members[memberIndex];
    if (member.sessionName) {
      try { await this.tmuxService.killSession(member.sessionName); } catch (error) { logger.warn('Failed to kill tmux session', { sessionName: member.sessionName, error: error instanceof Error ? error.message : String(error) }); }
    }
    team.members.splice(memberIndex, 1);
    team.updatedAt = new Date().toISOString();
    await this.storageService.saveTeam(team);
    res.json({ success: true, message: 'Team member removed successfully' } as ApiResponse);
  } catch (error) {
    logger.error('Error deleting team member', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to delete team member' } as ApiResponse);
  }
}

/**
 * Start a virtual orchestrator team member (Assistant or Auditor).
 * These members are not persisted in teams.json — their team is built dynamically
 * by buildOrchestratorTeam(). The main orchestrator member is managed via /orchestrator/setup.
 *
 * @param context - API context with services
 * @param memberId - The member ID from the virtual orchestrator team
 * @param res - Express response object
 */
async function _startOrchestratorMember(
  context: ApiContext,
  memberId: string,
  res: Response
): Promise<void> {
  const inProcessStatus = getInProcessRuntimeStatusMap(context.agentRegistrationService);
  const orchestratorTeam = buildOrchestratorTeam(
    CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
    null,
    undefined,
    inProcessStatus
  );
  const member = orchestratorTeam.members.find(m => m.id === memberId);

  if (!member) {
    res.status(404).json({ success: false, error: 'Orchestrator team member not found' } as ApiResponse);
    return;
  }

  // Main orchestrator member is managed at system level
  if (memberId === 'orchestrator-member') {
    res.status(400).json({
      success: false,
      error: 'Orchestrator is managed at system level. Use /api/orchestrator/setup endpoint instead.'
    } as ApiResponse);
    return;
  }

  // Use project root (cwd) as the project path for orchestrator virtual members
  const projectPath = process.cwd();

  // Create the agent session via agentRegistrationService (handles both crewly-agent and claude-code runtimes)
  try {
    const createResult = await context.agentRegistrationService.createAgentSession({
      sessionName: member.sessionName,
      role: member.role,
      projectPath,
      memberId: member.id,
      teamId: 'orchestrator',
      runtimeType: (member.runtimeType as RuntimeType) || undefined,
    });

    if (createResult.success) {
      res.json({
        success: true,
        data: {
          memberId: member.id,
          sessionName: createResult.sessionName || member.sessionName,
          status: CREWLY_CONSTANTS.AGENT_STATUSES.STARTING
        },
        message: `Orchestrator member ${member.name} started successfully`
      } as ApiResponse);
    } else {
      res.status(500).json({
        success: false,
        error: createResult.error || `Failed to start orchestrator member ${member.name}`
      } as ApiResponse);
    }
  } catch (error) {
    logger.error('Error starting orchestrator member', { memberId, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start orchestrator member'
    } as ApiResponse);
  }
}

/**
 * Stop a virtual orchestrator team member (Assistant or Auditor).
 * These members are not persisted in teams.json — uses agentRegistrationService
 * to terminate the session without storage updates.
 *
 * @param context - API context with services
 * @param memberId - The member ID from the virtual orchestrator team
 * @param res - Express response object
 */
async function _stopOrchestratorMember(
  context: ApiContext,
  memberId: string,
  res: Response
): Promise<void> {
  const inProcessStatus = getInProcessRuntimeStatusMap(context.agentRegistrationService);
  const orchestratorTeam = buildOrchestratorTeam(
    CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
    null,
    undefined,
    inProcessStatus
  );
  const member = orchestratorTeam.members.find(m => m.id === memberId);

  if (!member) {
    res.status(404).json({ success: false, error: 'Orchestrator team member not found' } as ApiResponse);
    return;
  }

  // Main orchestrator member is managed at system level
  if (memberId === 'orchestrator-member') {
    res.status(400).json({
      success: false,
      error: 'Orchestrator is managed at system level. Use /api/orchestrator/setup endpoint instead.'
    } as ApiResponse);
    return;
  }

  try {
    const stopResult = await context.agentRegistrationService.terminateAgentSession(
      member.sessionName,
      member.role
    );

    if (stopResult.success) {
      res.json({
        success: true,
        data: {
          memberId: member.id,
          status: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
        },
        message: `Orchestrator member ${member.name} stopped successfully`
      } as ApiResponse);
    } else {
      res.status(500).json({
        success: false,
        error: stopResult.error || `Failed to stop orchestrator member ${member.name}`
      } as ApiResponse);
    }
  } catch (error) {
    logger.error('Error stopping orchestrator member', { memberId, error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop orchestrator member'
    } as ApiResponse);
  }
}

export async function startTeamMember(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;

    // Handle virtual orchestrator team members (not stored in teams.json)
    if (teamId === 'orchestrator') {
      await _startOrchestratorMember(this, memberId, res);
      return;
    }

    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) {
      res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse);
      return;
    }

    const member = team.members.find(m => m.id === memberId);
    if (!member) {
      res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse);
      return;
    }

    // Skip members that are already active to avoid interrupting running agents
    const skipStatuses: Set<string> = new Set([
      CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
      CREWLY_CONSTANTS.AGENT_STATUSES.STARTED,
      CREWLY_CONSTANTS.AGENT_STATUSES.STARTING,
      CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING,
    ]);
    if (skipStatuses.has(member.agentStatus) && member.sessionName) {
      // Verify the session actually exists before skipping
      const sessions = await this.tmuxService.listSessions();
      const hasLiveSession = sessions.some(s => s.sessionName === member.sessionName);
      if (hasLiveSession) {
        res.json({
          success: true,
          message: `Team member ${member.name} is already active`,
          data: {
            memberId: member.id,
            sessionName: member.sessionName,
            status: member.agentStatus
          }
        } as ApiResponse);
        return;
      }
    }

    // Set target member to 'starting' for instant UI feedback
    const mutableMember = member as MutableTeamMember;
    mutableMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.STARTING;
    mutableMember.updatedAt = new Date().toISOString();
    await this.storageService.saveTeam(team);

    // Get project path if team has a current project
    let projectPath: string | undefined;
    if (team.projectIds[0]) {
      const projects = await this.storageService.getProjects();
      const project = projects.find(p => p.id === team.projectIds[0]);
      projectPath = project?.path;
    }

    // Use the internal helper function to start the team member
    const result = await _startTeamMemberCore(this, team, member, projectPath);

    // Handle the result and respond appropriately
    if (result.success) {
      if (result.status === 'synchronized') {
        res.json({
          success: true,
          message: 'Agent status synchronized with active session',
          data: {
            memberId: result.memberId,
            sessionName: result.sessionName,
            status: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE
          }
        } as ApiResponse);
      } else {
        res.json({
          success: true,
          data: {
            memberId: result.memberId,
            sessionName: result.sessionName,
            status: result.status
          },
          message: `Team member ${result.memberName} started successfully`
        } as ApiResponse);
      }
    } else {
      if (result.status === 'already_active') {
        res.status(400).json({
          success: false,
          error: result.error || 'Team member already has an active session'
        } as ApiResponse);
      } else if (result.error?.includes('already')) {
        res.status(400).json({
          success: false,
          error: result.error
        } as ApiResponse);
      } else {
        res.status(500).json({
          success: false,
          error: result.error || 'Failed to start team member'
        } as ApiResponse);
      }
    }
  } catch (error) {
    logger.error('Error starting team member', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to start team member' } as ApiResponse);
  }
}

export async function stopTeamMember(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;

    // Handle virtual orchestrator team members (not stored in teams.json)
    if (teamId === 'orchestrator') {
      await _stopOrchestratorMember(this, memberId, res);
      return;
    }

    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) {
      res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse);
      return;
    }

    const member = team.members.find(m => m.id === memberId);
    if (!member) {
      res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse);
      return;
    }

    // Use the internal helper function to stop the team member
    const result = await _stopTeamMemberCore(this, team, member);

    // Handle the result and respond appropriately
    if (result.success) {
      res.json({
        success: true,
        data: {
          memberId: result.memberId,
          status: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
        },
        message: `Team member ${result.memberName} stopped successfully`
      } as ApiResponse);
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to stop team member'
      } as ApiResponse);
    }
  } catch (error) {
    logger.error('Error stopping team member', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to stop team member' } as ApiResponse);
  }
}

export async function reportMemberReady(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { sessionName, role, capabilities, readyAt } = req.body as ReportMemberReadyRequestBody;
    if (!sessionName || !role) { res.status(400).json({ success: false, error: 'sessionName and role are required' } as ApiResponse); return; }
    const teams = await this.storageService.getTeams();
    let memberFound = false;
    for (const team of teams) {
      for (const member of team.members) {
        if (member.sessionName === sessionName) {
          const mutableMember = member as MutableTeamMember;
          mutableMember.readyAt = readyAt || new Date().toISOString();
          mutableMember.capabilities = capabilities || [];
          memberFound = true;
          break;
        }
      }
      if (memberFound) {
        (team as MutableTeam).updatedAt = new Date().toISOString();
        await this.storageService.saveTeam(team);
        break;
      }
    }
    if (!memberFound) { logger.warn('Session not found in any team, but reporting ready anyway', { sessionName }); }
    res.json({ success: true, message: `Agent ${sessionName} reported ready with role ${role}`, data: { sessionName, role, capabilities, readyAt } } as ApiResponse);
  } catch (error) {
    logger.error('Error reporting member ready', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to report member ready' } as ApiResponse);
  }
}

/**
 * Tracks sessions that already received a handoff push this server lifecycle.
 * Prevents duplicate pushes when register_self is called multiple times
 * (e.g. on every heartbeat re-registration or conversation replay).
 */
const handoffPushedSessions = new Set<string>();

/**
 * Fire-and-forget session handoff: pushes session summary and resume notification
 * to the orchestrator after registration. Used by both the orchestrator's own
 * registration path and the virtual-team-member path to avoid duplication.
 *
 * Only fires ONCE per session per server lifecycle. Subsequent register_self
 * calls for the same session are skipped.
 */
/**
 * Clear the handoff guard for a session (call on session destroy/restart
 * so the next registration triggers a fresh handoff push).
 */
export function clearHandoffGuard(sessionName: string): void {
  handoffPushedSessions.delete(sessionName);
}

function fireSessionHandoff(agentRegistrationService: ApiContext['agentRegistrationService'], sessionName: string): void {
  if (handoffPushedSessions.has(sessionName)) {
    logger.debug('Skipping duplicate session handoff (already pushed this lifecycle)', { sessionName });
    return;
  }
  handoffPushedSessions.add(sessionName);

  import('../../services/session/session-handoff.service.js').then(({ SessionHandoffService }) => {
    const handoff = SessionHandoffService.getInstance();
    handoff.pushSessionSummary(agentRegistrationService, sessionName).catch(err => {
      logger.warn('Failed to push session summary on registration', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    handoff.pushResumeNotification(agentRegistrationService, sessionName).catch(err => {
      logger.warn('Failed to push resume notification on registration', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }).catch(() => { /* non-fatal */ });
}

export async function registerMemberStatus(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { sessionName, role, status, registeredAt, memberId, claudeSessionId } = req.body as RegisterMemberStatusRequestBody;

    // Update agent heartbeat (proof of life)
    try {
      await updateAgentHeartbeat(sessionName, memberId, CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);
    } catch {
      // Continue execution - heartbeat failures shouldn't break registration
    }

    if (!sessionName || !role) {
      res.status(400).json({ success: false, error: 'sessionName and role are required' } as ApiResponse);
      return;
    }

    // Handle orchestrator registration separately
    if (role === 'orchestrator' && sessionName === CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME) {
      try {
        await this.storageService.updateOrchestratorStatus(CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE);

        // Broadcast orchestrator status change via WebSocket for real-time UI updates
        const terminalGateway = getTerminalGateway();
        if (terminalGateway) {
          terminalGateway.broadcastOrchestratorStatus({
            sessionName,
            agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE,
            workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
          });
        }

        // NOTE: Orchestrator no longer auto-subscribes to agent lifecycle events.
        // The orchestrator can read team status on-demand via get-agent-status skill
        // instead of receiving push notifications, which become spam with many agents.

        // Architecture Upgrade Phase 6: Standing subscriptions for task workflow events
        // Orchestrator subscribes to task:verified (awareness), task:blocked, task:failed, team:all_tasks_done
        if (eventBusService) {
          const TTL_MINUTES = 60 * 24;
          for (const evtType of ['task:verified', 'task:blocked', 'task:failed', 'team:all_tasks_done'] as const) {
            try {
              eventBusService.subscribe({
                eventType: evtType,
                filter: {},
                subscriberSession: sessionName,
                oneShot: false,
                ttlMinutes: TTL_MINUTES,
              });
            } catch { /* non-fatal */ }
          }
          logger.info('Standing task subscriptions set up for orchestrator', { sessionName });
        }

        res.json({ success: true, message: `Orchestrator ${sessionName} registered as active`, sessionName } as ApiResponse);

        // Fire session handoff (summary + resume notification) after responding
        fireSessionHandoff(this.agentRegistrationService, sessionName);
        return;
      } catch (error) {
        logger.error('Error updating orchestrator status', { error: error instanceof Error ? error.message : String(error) });
        res.status(500).json({ success: false, error: 'Failed to update orchestrator status' } as ApiResponse);
        return;
      }
    }

    // Find the team member to update
    const teams = await this.storageService.getTeams();
    let targetTeamId: string | null = null;
    let targetMemberId: string | null = null;

    for (const team of teams) {
      for (const member of team.members) {
        const matchesId = memberId && member.id === memberId;
        const matchesSession = member.sessionName === sessionName;
        if (matchesId || matchesSession) {
          targetTeamId = team.id;
          targetMemberId = member.id;
          break;
        }
      }
      if (targetTeamId) break;
    }

    // If not found in regular teams, check orchestrator team members (virtual team not in getTeams())
    if (!targetTeamId || !targetMemberId) {
      const orchestratorStatus = await this.storageService.getOrchestratorStatus();
      const inProcessStatus = getInProcessRuntimeStatusMap(this.agentRegistrationService);
      const orchestratorTeam = buildOrchestratorTeam(
        orchestratorStatus?.agentStatus || CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
        orchestratorStatus,
        undefined,
        inProcessStatus
      );
      for (const member of orchestratorTeam.members) {
        const matchesId = memberId && member.id === memberId;
        const matchesSession = member.sessionName === sessionName;
        if (matchesId || matchesSession) {
          // Orchestrator team members are virtual — registration succeeds via heartbeat (already updated above)
          logger.info('registerMemberStatus: found orchestrator team member', { sessionName, memberId: member.id });

          if (claudeSessionId) {
            try {
              const persistence = getSessionStatePersistence();
              persistence.updateSessionId(sessionName, claudeSessionId);
            } catch (persistError) {
              logger.warn('Failed to persist claudeSessionId', { error: persistError instanceof Error ? persistError.message : String(persistError) });
            }
          }

          res.json({ success: true, message: `Agent ${sessionName} registered as active with role ${role}`, data: { sessionName, role, status: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE, registeredAt: registeredAt || new Date().toISOString() } } as ApiResponse);

          // Fire session handoff for orchestrator virtual team members
          fireSessionHandoff(this.agentRegistrationService, sessionName);
          return;
        }
      }

      logger.warn('registerMemberStatus: agent not found in any team', { sessionName, role, memberId });
      res.status(404).json({ success: false, error: `Agent with sessionName '${sessionName}' not found in any team` } as ApiResponse);
      return;
    }

    const freshTeams = await this.storageService.getTeams();
    const freshTeam = freshTeams.find(t => t.id === targetTeamId);

    if (freshTeam) {
      const freshMember = freshTeam.members.find(m => m.id === targetMemberId) as MutableTeamMember | undefined;
      if (freshMember) {
        freshMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE;
        freshMember.workingStatus = freshMember.workingStatus || CREWLY_CONSTANTS.WORKING_STATUSES.IDLE;
        freshMember.readyAt = registeredAt || new Date().toISOString();
        if (memberId && freshMember.id === memberId && !freshMember.sessionName) {
          freshMember.sessionName = sessionName;
        }
        (freshTeam as MutableTeam).updatedAt = new Date().toISOString();

        await this.storageService.saveTeam(freshTeam);
      }
    }

    // Store claudeSessionId for resume-on-restart support
    if (claudeSessionId) {
      try {
        const persistence = getSessionStatePersistence();
        persistence.updateSessionId(sessionName, claudeSessionId);
      } catch (persistError) {
        // Non-fatal: resume just won't work on next restart
        logger.warn('Failed to persist claudeSessionId', { error: persistError instanceof Error ? persistError.message : String(persistError) });
      }
    }

    // Architecture Upgrade Phase 6: Standing subscriptions for team members
    if (eventBusService && targetTeamId) {
      const TTL_MINUTES = 60 * 24;
      const member = freshTeam?.members.find(m => m.id === targetMemberId);
      const isTeamLead = member?.canDelegate === true;
      try {
        if (isTeamLead) {
          for (const evtType of ['task:done', 'task:blocked', 'task:failed', 'task:needs_clarification'] as const) {
            eventBusService.subscribe({
              eventType: evtType,
              filter: { teamId: targetTeamId },
              subscriberSession: sessionName,
              oneShot: false,
              ttlMinutes: TTL_MINUTES,
            });
          }
          logger.info('Standing task subscriptions set up for team-lead', { sessionName, teamId: targetTeamId });
        } else {
          eventBusService.subscribe({
            eventType: 'task:assigned' as any,
            filter: { sessionName },
            subscriberSession: sessionName,
            oneShot: false,
            ttlMinutes: TTL_MINUTES,
          });
          logger.info('Standing task subscription set up for executor', { sessionName });
        }
      } catch { /* non-fatal */ }
    }

    res.json({ success: true, message: `Agent ${sessionName} registered as active with role ${role}`, data: { sessionName, role, status: CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE, registeredAt: registeredAt || new Date().toISOString() } } as ApiResponse);

    // Push session handoff (summary + resume notification) for orchestrator re-registration
    if (sessionName === ORCHESTRATOR_SESSION_NAME) {
      fireSessionHandoff(this.agentRegistrationService, sessionName);
    }

    // Flush any queued messages for this sub-agent (fire-and-forget after response)
    const subAgentQueue = SubAgentMessageQueue.getInstance();
    if (subAgentQueue.hasPending(sessionName)) {
      const runtimeType = (freshTeam?.members.find(m => m.id === targetMemberId)?.runtimeType || RUNTIME_TYPES.CLAUDE_CODE) as RuntimeType;
      const queuedMessages = subAgentQueue.dequeueAll(sessionName);
      logger.info('Flushing queued messages', { count: queuedMessages.length, sessionName });

      // Deliver sequentially in the background
      (async () => {
        for (let i = 0; i < queuedMessages.length; i++) {
          const queuedMsg = queuedMessages[i];
          try {
            await this.agentRegistrationService.sendMessageToAgent(sessionName, queuedMsg.data, runtimeType);
            logger.info('Delivered queued message', { sessionName, queuedAt: new Date(queuedMsg.queuedAt).toISOString() });
          } catch (flushError) {
            logger.error('Failed to deliver queued message', { sessionName, error: flushError instanceof Error ? flushError.message : String(flushError) });
          }
          // Delay between messages to let the agent process each one
          if (i < queuedMessages.length - 1) {
            await new Promise(resolve => setTimeout(resolve, SUB_AGENT_QUEUE_CONSTANTS.FLUSH_INTER_MESSAGE_DELAY));
          }
        }
      })().catch(err => {
        logger.error('Queue flush failed', { sessionName, error: err instanceof Error ? err.message : String(err) });
      });
    }
  } catch (error) {
    logger.error('Error in registerMemberStatus', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to register member status' } as ApiResponse);
  }
}

export async function generateMemberContext(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const options = req.query as GenerateMemberContextQuery;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const member = team.members.find(m => m.id === memberId);
    if (!member) { res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse); return; }
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => Object.values(p.teams || {}).flat().includes(teamId));
    if (!project) { res.status(404).json({ success: false, error: 'No project found for this team' } as ApiResponse); return; }
    const contextLoader = new (await import('../../services/index.js')).ContextLoaderService(project.path);
    const contextPrompt = await contextLoader.generateContextPrompt(member, {
      includeFiles: options.includeFiles !== 'false',
      includeGitHistory: options.includeGitHistory !== 'false',
      includeTickets: options.includeTickets !== 'false'
    });
    res.json({ success: true, data: { teamId, memberId, memberName: member.name, contextPrompt, generatedAt: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error generating member context', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to generate member context' } as ApiResponse);
  }
}

export async function injectContextIntoSession(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const member = team.members.find(m => m.id === memberId);
    if (!member) { res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse); return; }
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => Object.values(p.teams || {}).flat().includes(teamId));
    if (!project) { res.status(404).json({ success: false, error: 'No project found for this team' } as ApiResponse); return; }
    const { ContextLoaderService } = await import('../../services/index.js');
    const contextLoader = new ContextLoaderService(project.path);
    const success = await contextLoader.injectContextIntoSession(member.sessionName, member, this.tmuxService);
    if (!success) { res.status(500).json({ success: false, error: 'Failed to inject context into session' } as ApiResponse); return; }
    res.json({ success: true, data: { teamId, memberId, memberName: member.name, sessionName: member.sessionName, contextInjected: true, injectedAt: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error injecting context into session', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to inject context into session' } as ApiResponse);
  }
}

export async function refreshMemberContext(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) { res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse); return; }
    const member = team.members.find(m => m.id === memberId);
    if (!member) { res.status(404).json({ success: false, error: 'Team member not found' } as ApiResponse); return; }
    const projects = await this.storageService.getProjects();
    const project = projects.find(p => Object.values(p.teams || {}).flat().includes(teamId));
    if (!project) { res.status(404).json({ success: false, error: 'No project found for this team' } as ApiResponse); return; }
    const { ContextLoaderService } = await import('../../services/index.js');
    const contextLoader = new ContextLoaderService(project.path);
    const contextPath = await contextLoader.refreshContext(member);
    res.json({ success: true, data: { teamId, memberId, memberName: member.name, contextPath, refreshedAt: new Date().toISOString() } } as ApiResponse);
  } catch (error) {
    logger.error('Error refreshing member context', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to refresh member context' } as ApiResponse);
  }
}

export async function getTeamActivityStatus(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const now = new Date().toISOString();
    const orchestratorRunning = await this.tmuxService.sessionExists(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
    const teams = await this.storageService.getTeams();
    const memberStatuses: MemberActivityStatus[] = [];
    const teamsToUpdate: Team[] = [];

    // Get current task assignments
    const inProgressTasks = await this.taskTrackingService.getAllInProgressTasks();
    const tasksByMember = new Map<string, CurrentTaskInfo>();
    inProgressTasks.forEach((task) => {
      tasksByMember.set(task.assignedTeamMemberId, {
        id: task.id,
        taskName: task.taskName,
        taskFilePath: task.taskFilePath,
        assignedAt: task.assignedAt,
        status: task.status
      });
    });

    // Process all teams with concurrency limit to prevent overwhelming the system
    const CONCURRENCY_LIMIT = 2; // Reduced to be more conservative
    const MAX_OUTPUT_SIZE = 1024; // Max 1KB per member terminal output

    for (let teamIndex = 0; teamIndex < teams.length; teamIndex += CONCURRENCY_LIMIT) {
      const teamBatch = teams.slice(teamIndex, teamIndex + CONCURRENCY_LIMIT);

      const teamPromises = teamBatch.map(async (team) => {
        let teamUpdated = false;

        for (const member of team.members) {
          const mutableMember = member as MutableTeamMember;
          if (member.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE && member.sessionName) {
            try {
              // Add timeout to prevent hanging
              const sessionExists = await Promise.race([
                this.tmuxService.sessionExists(member.sessionName),
                new Promise<boolean>((_, reject) =>
                  setTimeout(() => reject(new Error('Session check timeout')), 3000)
                )
              ]);

              if (!sessionExists) {
                mutableMember.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE;
                mutableMember.workingStatus = CREWLY_CONSTANTS.WORKING_STATUSES.IDLE;
                mutableMember.lastActivityCheck = now;
                // Clear terminal output to prevent memory leak
                delete mutableMember.lastTerminalOutput;
                teamUpdated = true;

                const currentTask = tasksByMember.get(member.id) || null;
                memberStatuses.push({
                  teamId: team.id,
                  teamName: team.name,
                  memberId: member.id,
                  memberName: member.name,
                  role: member.role,
                  sessionName: member.sessionName,
                  agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
                  workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
                  lastActivityCheck: now,
                  activityDetected: false,
                  currentTask
                });
                continue;
              }

              // Capture terminal output with strict timeout and size limit
              const currentOutput = await Promise.race([
                this.tmuxService.capturePane(member.sessionName, 15), // Reduced from 50 to 15 lines
                new Promise<string>((_, reject) =>
                  setTimeout(() => reject(new Error('Capture timeout')), 2000) // Shorter timeout
                )
              ]).catch(() => ''); // Return empty string on error/timeout

              // Strict size limiting to prevent memory issues
              const trimmedOutput = currentOutput.length > MAX_OUTPUT_SIZE
                ? '...' + currentOutput.substring(currentOutput.length - MAX_OUTPUT_SIZE + 3)
                : currentOutput;

              const previousOutput = mutableMember.lastTerminalOutput || '';
              const activityDetected = trimmedOutput !== previousOutput && trimmedOutput.trim() !== '';
              const newWorkingStatus = activityDetected ? 'in_progress' : CREWLY_CONSTANTS.WORKING_STATUSES.IDLE;

              if (member.workingStatus !== newWorkingStatus) {
                mutableMember.workingStatus = newWorkingStatus;
                teamUpdated = true;
              }

              mutableMember.lastActivityCheck = now;
              // Store only limited output to prevent memory leak
              mutableMember.lastTerminalOutput = trimmedOutput;

              const currentTask = tasksByMember.get(member.id) || null;
              memberStatuses.push({
                teamId: team.id,
                teamName: team.name,
                memberId: member.id,
                memberName: member.name,
                role: member.role,
                sessionName: member.sessionName,
                agentStatus: member.agentStatus,
                workingStatus: newWorkingStatus,
                lastActivityCheck: now,
                activityDetected,
                currentTask
              });

            } catch (error) {
              logger.error('Error checking activity for member', { memberId: member.id, error: error instanceof Error ? error.message : String(error) });
              // Clear terminal output on error to prevent memory leak
              delete mutableMember.lastTerminalOutput;

              const currentTask = tasksByMember.get(member.id) || null;
              memberStatuses.push({
                teamId: team.id,
                teamName: team.name,
                memberId: member.id,
                memberName: member.name,
                role: member.role,
                sessionName: member.sessionName,
                agentStatus: member.agentStatus,
                workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
                lastActivityCheck: now,
                activityDetected: false,
                error: error instanceof Error ? error.message : String(error),
                currentTask
              });
            }
          } else {
            const currentTask = tasksByMember.get(member.id) || null;
            memberStatuses.push({
              teamId: team.id,
              teamName: team.name,
              memberId: member.id,
              memberName: member.name,
              role: member.role,
              sessionName: member.sessionName || '',
              agentStatus: member.agentStatus || CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
              workingStatus: member.workingStatus || CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
              lastActivityCheck: mutableMember.lastActivityCheck || now,
              activityDetected: false,
              currentTask
            });
          }
        }

        if (teamUpdated) {
          teamsToUpdate.push(team);
        }
      });

      await Promise.all(teamPromises);
    }

    // Save only teams that were actually updated (more efficient than saving all teams)
    if (teamsToUpdate.length > 0) {
      const savePromises = teamsToUpdate.map(team => this.storageService.saveTeam(team));
      await Promise.all(savePromises);
    }

    res.json({
      success: true,
      data: {
        orchestrator: { running: orchestratorRunning, sessionName: orchestratorRunning ? CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME : null },
        teams,
        members: memberStatuses,
        checkedAt: now,
        totalMembers: memberStatuses.length,
        totalActiveMembers: memberStatuses.filter(m => m.agentStatus === CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE).length
      }
    } as ApiResponse);

  } catch (error) {
    logger.error('Error checking team activity status', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to check team activity status' } as ApiResponse);
  }
}

export async function updateTeamMemberRuntime(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { teamId, memberId } = req.params;
    const { runtimeType } = req.body as UpdateTeamMemberRuntimeRequestBody;

    if (!runtimeType || typeof runtimeType !== 'string') {
      res.status(400).json({
        success: false,
        error: 'runtimeType is required and must be a string'
      } as ApiResponse);
      return;
    }

    // Validate runtime type
    const validRuntimeTypes = Object.values(RUNTIME_TYPES);
    if (!validRuntimeTypes.includes(runtimeType)) {
      res.status(400).json({
        success: false,
        error: `Invalid runtime type. Must be one of: ${validRuntimeTypes.join(', ')}`
      } as ApiResponse);
      return;
    }

    // Special handling for orchestrator team
    if (teamId === 'orchestrator') {
      // Use the orchestrator-specific runtime update function
      await this.storageService.updateOrchestratorRuntimeType(runtimeType);

      // Get the updated orchestrator status to return
      const orchestratorStatus = await this.storageService.getOrchestratorStatus();
      const updatedMember: TeamMember = {
        id: 'orchestrator-member',
        name: 'Agentmux Orchestrator',
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        role: 'orchestrator',
        systemPrompt: 'You are the Crewly Orchestrator responsible for coordinating teams and managing project workflows.',
        agentStatus: orchestratorStatus?.agentStatus || CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
        workingStatus: orchestratorStatus?.workingStatus || CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
        runtimeType: runtimeType,
        createdAt: orchestratorStatus?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      res.json({
        success: true,
        data: updatedMember,
        message: `Orchestrator runtime updated to ${runtimeType}`
      } as ApiResponse<TeamMember>);
      return;
    }

    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === teamId) as MutableTeam | undefined;
    if (!team) {
      res.status(404).json({
        success: false,
        error: 'Team not found'
      } as ApiResponse);
      return;
    }

    const memberIndex = team.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      res.status(404).json({
        success: false,
        error: 'Team member not found'
      } as ApiResponse);
      return;
    }

    // Update the member's runtime type
    const updatedMember: MutableTeamMember = {
      ...team.members[memberIndex],
      runtimeType: runtimeType,
      updatedAt: new Date().toISOString()
    };

    team.members[memberIndex] = updatedMember;
    team.updatedAt = new Date().toISOString();

    await this.storageService.saveTeam(team);

    res.json({
      success: true,
      data: updatedMember,
      message: `Team member runtime updated to ${runtimeType}`
    } as ApiResponse<TeamMember>);

  } catch (error) {
    logger.error('Error updating team member runtime', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to update team member runtime'
    } as ApiResponse);
  }
}

/**
 * Updates team properties like assigned project
 */
export async function updateTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const updates = req.body as UpdateTeamRequestBody;

    if (!id) {
      res.status(400).json({
        success: false,
        error: 'Team ID is required'
      } as ApiResponse);
      return;
    }

    // Handle orchestrator team specially
    if (id === CREWLY_CONSTANTS.AGENT_IDS.ORCHESTRATOR_ID) {
      // Orchestrator is a system team — cannot have a parent
      if (updates.parentTeamId !== undefined && updates.parentTeamId !== null) {
        res.status(400).json({
          success: false,
          error: 'Cannot set parentTeamId on Orchestrator Team — it is a system team'
        } as ApiResponse);
        return;
      }

      // Orchestrator team is virtual and stored separately
      const orchestratorStatus = await this.storageService.getOrchestratorStatus();

      if (!orchestratorStatus) {
        res.status(404).json({
          success: false,
          error: 'Team not found'
        } as ApiResponse);
        return;
      }

      // For orchestrator, we currently cannot update the projectIds
      // because there's no method to save the full orchestrator status
      // Only status updates are supported through updateOrchestratorStatus
      // We'll simulate the update for the response but not persist it

      // The orchestrator team virtual response will include the projects
      // but it won't be persisted until we add the proper storage method

      // Return the virtual orchestrator team structure
      const inProcessStatus = getInProcessRuntimeStatusMap(this.agentRegistrationService);
      const orchestratorTeam = buildOrchestratorTeam(
        orchestratorStatus?.agentStatus || CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
        orchestratorStatus,
        { projectIds: updates.projectIds },
        inProcessStatus
      );

      res.json({
        success: true,
        data: orchestratorTeam,
        message: 'Team updated successfully'
      } as ApiResponse<Team>);
      return;
    }

    // Handle regular teams
    const teams = await this.storageService.getTeams();
    const teamIndex = teams.findIndex(t => t.id === id);

    if (teamIndex === -1) {
      res.status(404).json({
        success: false,
        error: 'Team not found'
      } as ApiResponse);
      return;
    }

    const team = teams[teamIndex] as MutableTeam;

    // Update allowed fields
    if (updates.projectIds !== undefined) {
      team.projectIds = updates.projectIds;
    }
    if (updates.name !== undefined) {
      team.name = updates.name;
    }
    if (updates.description !== undefined) {
      team.description = updates.description;
    }
    if (updates.hierarchical !== undefined) {
      team.hierarchical = updates.hierarchical;
      if (!updates.hierarchical) {
        // Disable hierarchy: clear leaderId, leaderIds, and member hierarchy fields
        team.leaderId = undefined;
        team.leaderIds = undefined;
        for (const m of team.members) {
          (m as any).parentMemberId = undefined;
          (m as any).hierarchyLevel = undefined;
          (m as any).canDelegate = undefined;
          (m as any).subordinateIds = undefined;
        }
      }
    }
    // Support leaderIds update (multi-TL)
    if (updates.leaderIds !== undefined && team.hierarchical) {
      team.leaderIds = updates.leaderIds;
      team.leaderId = updates.leaderIds[0]; // backward compat

      // Set hierarchy fields on each leader
      for (const lid of updates.leaderIds) {
        const leader = team.members.find(m => m.id === lid);
        if (leader) {
          (leader as any).hierarchyLevel = 1;
          (leader as any).canDelegate = true;
        }
      }

      // Workers: any member not in leaderIds and not orchestrator
      const leaderIdSet = new Set(updates.leaderIds);
      const workers = team.members.filter(m => !leaderIdSet.has(m.id) && m.role !== 'orchestrator');
      for (const worker of workers) {
        (worker as any).hierarchyLevel = 2;
        (worker as any).canDelegate = false;
        // Assign to first leader if no parentMemberId already set to a valid leader
        if (!worker.parentMemberId || !leaderIdSet.has(worker.parentMemberId)) {
          (worker as any).parentMemberId = updates.leaderIds[0];
        }
      }

      // Update subordinateIds on each leader
      for (const lid of updates.leaderIds) {
        const leader = team.members.find(m => m.id === lid);
        if (leader) {
          (leader as any).subordinateIds = workers
            .filter(w => w.parentMemberId === lid)
            .map(w => w.id);
        }
      }
    } else if (updates.leaderId !== undefined && team.hierarchical) {
      // Legacy single-leader update path
      team.leaderId = updates.leaderId;
      team.leaderIds = [updates.leaderId]; // keep in sync
      // Wire parent-child relationships for the new leader
      const leader = team.members.find(m => m.id === updates.leaderId);
      if (leader) {
        (leader as any).hierarchyLevel = 1;
        (leader as any).canDelegate = true;
        const workers = team.members.filter(m => m.id !== updates.leaderId && m.role !== 'orchestrator');
        (leader as any).subordinateIds = workers.map(w => w.id);
        for (const worker of workers) {
          (worker as any).parentMemberId = leader.id;
          (worker as any).hierarchyLevel = 2;
          (worker as any).canDelegate = false;
          (worker as any).subordinateIds = [];
        }
      }
    }

    // Update members if provided (from TeamModal edit)
    if (updates.members !== undefined && Array.isArray(updates.members)) {
      team.members = await Promise.all(updates.members.map(async (memberUpdate: TeamMemberUpdate) => {
        // Find existing member by name (since the modal doesn't send IDs)
        const existingMember = team.members.find(m => m.name === memberUpdate.name);

        if (existingMember) {
          return {
            ...existingMember,
            name: memberUpdate.name,
            role: memberUpdate.role,
            systemPrompt: memberUpdate.systemPrompt,
            runtimeType: memberUpdate.runtimeType || existingMember.runtimeType,
            avatar: memberUpdate.avatar || existingMember.avatar,
            skillOverrides: memberUpdate.skillOverrides || [],
            excludedRoleSkills: memberUpdate.excludedRoleSkills || [],
            updatedAt: new Date().toISOString()
          } as MutableTeamMember;
        } else {
          // New member
          return {
            id: uuidv4(),
            name: memberUpdate.name,
            role: memberUpdate.role,
            systemPrompt: memberUpdate.systemPrompt,
            agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
            workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
            runtimeType: memberUpdate.runtimeType || await getDefaultRuntime(),
            avatar: memberUpdate.avatar,
            skillOverrides: memberUpdate.skillOverrides || [],
            excludedRoleSkills: memberUpdate.excludedRoleSkills || [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          } as MutableTeamMember;
        }
      }));
    }

    // #171: Handle archive toggle
    if (updates.archived !== undefined) {
      team.archived = updates.archived;
      (team as MutableTeam).archivedAt = updates.archived ? new Date().toISOString() : undefined;
    }

    // #173: Handle org chart fields
    if (updates.mission !== undefined) {
      (team as MutableTeam).mission = updates.mission;
    }
    if (updates.budget !== undefined) {
      (team as MutableTeam).budget = updates.budget;
    }
    if (updates.qualityGate !== undefined) {
      (team as MutableTeam).qualityGate = updates.qualityGate;
    }

    // Handle parentTeamId updates
    if (updates.parentTeamId !== undefined) {
      if (updates.parentTeamId === null) {
        // Explicitly remove parent (make top-level)
        team.parentTeamId = undefined;
      } else {
        // Orchestrator is a system team and cannot be used as a parent
        if (updates.parentTeamId === CREWLY_CONSTANTS.AGENT_IDS.ORCHESTRATOR_ID) {
          res.status(400).json({
            success: false,
            error: 'Cannot use Orchestrator Team as parent — it is a system team'
          } as ApiResponse);
          return;
        }

        // Validate parent team exists and prevent self-reference / circular references
        if (updates.parentTeamId === id) {
          res.status(400).json({
            success: false,
            error: 'A team cannot be its own parent'
          } as ApiResponse);
          return;
        }

        const parentTeam = teams.find(t => t.id === updates.parentTeamId);
        if (!parentTeam) {
          res.status(400).json({
            success: false,
            error: `Parent team with id "${updates.parentTeamId}" not found`
          } as ApiResponse);
          return;
        }

        // Prevent circular reference: parent's parentTeamId must not be this team
        if (parentTeam.parentTeamId === id) {
          res.status(400).json({
            success: false,
            error: 'Circular parent reference detected'
          } as ApiResponse);
          return;
        }

        team.parentTeamId = updates.parentTeamId;
      }
    }

    // Update timestamp
    team.updatedAt = new Date().toISOString();

    await this.storageService.saveTeam(team);

    res.json({
      success: true,
      data: team,
      message: 'Team updated successfully'
    } as ApiResponse<Team>);

  } catch (error) {
    logger.error('Error updating team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({
      success: false,
      error: 'Failed to update team'
    } as ApiResponse);
  }
}

/**
 * Archive or unarchive a team (#171).
 * POST /:id/archive — sets archived=true.
 * Body: { archived?: boolean } — defaults to true. Pass false to unarchive.
 *
 * Archived teams are excluded from the default GET /teams listing
 * (pass ?includeArchived=true to include them).
 *
 * @param req - Express request with team ID in params
 * @param res - Express response
 */
export async function archiveTeam(this: ApiContext, req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { archived = true } = req.body as { archived?: boolean };

    if (!id) {
      res.status(400).json({ success: false, error: 'Team ID is required' } as ApiResponse);
      return;
    }

    if (id === CREWLY_CONSTANTS.AGENT_IDS.ORCHESTRATOR_ID || id === 'orchestrator') {
      res.status(400).json({ success: false, error: 'Cannot archive the Orchestrator team' } as ApiResponse);
      return;
    }

    const teams = await this.storageService.getTeams();
    const team = teams.find(t => t.id === id) as MutableTeam | undefined;

    if (!team) {
      res.status(404).json({ success: false, error: 'Team not found' } as ApiResponse);
      return;
    }

    team.archived = archived;
    (team as MutableTeam).archivedAt = archived ? new Date().toISOString() : undefined;
    team.updatedAt = new Date().toISOString();

    await this.storageService.saveTeam(team);

    logger.info(`Team ${archived ? 'archived' : 'unarchived'}`, { teamId: id, teamName: team.name });

    res.json({
      success: true,
      data: team,
      message: `Team ${archived ? 'archived' : 'unarchived'} successfully`
    } as ApiResponse<Team>);
  } catch (error) {
    logger.error('Error archiving team', { error: error instanceof Error ? error.message : String(error) });
    res.status(500).json({ success: false, error: 'Failed to archive team' } as ApiResponse);
  }
}
