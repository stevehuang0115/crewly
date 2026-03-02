import { StorageService } from '../core/storage.service.js';
import { getSessionBackendSync, createSessionBackend, type ISessionBackend } from '../session/index.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { AgentHeartbeatService } from '../agent/agent-heartbeat.service.js';
import { writeFile, readFile, rename, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { CREWLY_CONSTANTS, CONTINUATION_CONSTANTS, AGENT_IDENTITY_CONSTANTS, RUNTIME_EXIT_CONSTANTS, PTY_CONSTANTS, type WorkingStatus } from '../../constants.js';
import { stripAnsiCodes } from '../../utils/terminal-output.utils.js';
import { OrchestratorRestartService } from '../orchestrator/orchestrator-restart.service.js';
import { PtyActivityTrackerService } from '../agent/pty-activity-tracker.service.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent } from '../../types/event-bus.types.js';

/**
 * Team Working Status File Structure
 * Tracks ONLY workingStatus (idle vs in_progress) based on terminal activity
 * agentStatus is now managed by AgentHeartbeatService via MCP calls
 */
export interface TeamWorkingStatusFile {
  /** Orchestrator working status */
  orchestrator: {
    sessionName: string;
    workingStatus: WorkingStatus;
    lastActivityCheck: string;
    updatedAt: string;
  };
  /** Team member working statuses indexed by sessionName */
  teamMembers: Record<string, {
    sessionName: string;
    teamMemberId: string;
    workingStatus: WorkingStatus;
    lastActivityCheck: string;
    updatedAt: string;
  }>;
  /** File metadata */
  metadata: {
    lastUpdated: string;
    version: string;
  };
}

/**
 * Activity Monitor Service - NEW ARCHITECTURE
 *
 * Responsibilities:
 * - Track ONLY workingStatus (idle vs in_progress) based on terminal activity
 * - Create and manage teamWorkingStatus.json file
 * - Integrate with AgentHeartbeatService for stale agent detection
 * - Remove ALL agentStatus management (now owned by AgentHeartbeatService)
 *
 * Key Changes:
 * - No more agentStatus updates to teams.json
 * - Simple activity detection: output changed = in_progress, else = idle
 * - Integration with stale detection (30-minute threshold)
 * - Separate teamWorkingStatus.json file for working statuses
 */
export class ActivityMonitorService {
  private static instance: ActivityMonitorService;
  private logger: ComponentLogger;
  private storageService: StorageService;
  private _sessionBackend: ISessionBackend | null = null;
  private agentHeartbeatService: AgentHeartbeatService;
  private intervalId: NodeJS.Timeout | null = null;
  private readonly POLLING_INTERVAL = 120000; // 2 minutes
  private lastTerminalOutputs: Map<string, string> = new Map();
  private readonly MAX_OUTPUT_SIZE = 512; // 512 bytes max per output
  private readonly ACTIVITY_CHECK_TIMEOUT = 6000; // 6 second timeout per check
  private lastCleanup: number = Date.now();
  private crewlyHome: string;
  private teamWorkingStatusFile: string;
  private eventBusService: EventBusService | null = null;
  /** Tracks when each session entered in_progress (epoch ms) */
  private busyTransitionTimestamps: Map<string, number> = new Map();
  /** Tracks which sessions have had their agent:busy event emitted */
  private busyEventEmitted: Set<string> = new Set();

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('ActivityMonitor');
    this.storageService = StorageService.getInstance();
    this.agentHeartbeatService = AgentHeartbeatService.getInstance();
    this.crewlyHome = join(homedir(), CREWLY_CONSTANTS.PATHS.CREWLY_HOME);
    this.teamWorkingStatusFile = join(this.crewlyHome, 'teamWorkingStatus.json');
  }

  /**
   * Get the session backend, lazily initializing if needed.
   */
  private async getBackend(): Promise<ISessionBackend> {
    if (!this._sessionBackend) {
      this._sessionBackend = getSessionBackendSync();
      if (!this._sessionBackend) {
        this._sessionBackend = await createSessionBackend('pty');
      }
    }
    return this._sessionBackend;
  }

  /**
   * Get the session backend synchronously (may return null if not initialized).
   */
  private get sessionBackend(): ISessionBackend | null {
    if (!this._sessionBackend) {
      this._sessionBackend = getSessionBackendSync();
    }
    return this._sessionBackend;
  }

  public static getInstance(): ActivityMonitorService {
    if (!ActivityMonitorService.instance) {
      ActivityMonitorService.instance = new ActivityMonitorService();
    }
    return ActivityMonitorService.instance;
  }

  /**
   * Inject the EventBusService for direct event publishing on status transitions.
   *
   * @param service - The EventBusService instance
   */
  setEventBusService(service: EventBusService): void {
    this.eventBusService = service;
  }

  /**
   * Build an AgentEvent for a working status transition.
   *
   * @param type - The event type ('agent:busy' or 'agent:idle')
   * @param timestamp - ISO timestamp for the event
   * @param identity - Agent identity fields (team/member/session)
   * @param previousValue - The previous working status
   * @param newValue - The new working status
   * @returns A fully-formed AgentEvent
   */
  private buildAgentEvent(
    type: AgentEvent['type'],
    timestamp: string,
    identity: { teamId: string; teamName: string; memberId: string; memberName: string; sessionName: string },
    previousValue: string,
    newValue: string,
  ): AgentEvent {
    return {
      id: crypto.randomUUID(),
      type,
      timestamp,
      teamId: identity.teamId,
      teamName: identity.teamName,
      memberId: identity.memberId,
      memberName: identity.memberName,
      sessionName: identity.sessionName,
      previousValue,
      newValue,
      changedField: 'workingStatus',
    } as AgentEvent;
  }

  /**
   * Handle duration-gated event emission for a session status transition.
   * Suppresses spurious idle→busy→idle cycles by requiring a minimum
   * busy duration (MIN_BUSY_DURATION_MS) before emitting events.
   *
   * @param key - Unique key for tracking (e.g. 'orchestrator' or session name)
   * @param newStatus - The new working status
   * @param previousStatus - The previous working status
   * @param statusChanged - Whether the status actually changed this poll
   * @param identity - Agent identity fields for building the event
   * @param now - ISO timestamp for the event
   */
  private handleDurationGatedEmission(
    key: string,
    newStatus: WorkingStatus,
    previousStatus: WorkingStatus,
    statusChanged: boolean,
    identity: { teamId: string; teamName: string; memberId: string; memberName: string; sessionName: string },
    now: string,
  ): void {
    if (statusChanged && newStatus === 'in_progress') {
      if (!this.busyTransitionTimestamps.has(key)) {
        this.busyTransitionTimestamps.set(key, Date.now());
      }
    }

    if (statusChanged) {
      const busyStart = this.busyTransitionTimestamps.get(key);
      const elapsed = busyStart != null ? Date.now() - busyStart : 0;

      if (newStatus === 'in_progress') {
        if (elapsed >= PTY_CONSTANTS.MIN_BUSY_DURATION_MS && !this.busyEventEmitted.has(key) && this.eventBusService) {
          this.busyEventEmitted.add(key);
          this.eventBusService.publish(this.buildAgentEvent('agent:busy', now, identity, previousStatus, newStatus));
        }
      } else {
        if (elapsed >= PTY_CONSTANTS.MIN_BUSY_DURATION_MS && this.busyEventEmitted.has(key) && this.eventBusService) {
          this.eventBusService.publish(this.buildAgentEvent('agent:idle', now, identity, previousStatus, newStatus));
        }
        this.busyTransitionTimestamps.delete(key);
        this.busyEventEmitted.delete(key);
      }
    } else if (newStatus === 'in_progress' && this.busyTransitionTimestamps.has(key) && !this.busyEventEmitted.has(key)) {
      // Still in_progress across polls — check if deferred busy event can now be emitted
      const busyStart = this.busyTransitionTimestamps.get(key)!;
      if (Date.now() - busyStart >= PTY_CONSTANTS.MIN_BUSY_DURATION_MS && this.eventBusService) {
        this.busyEventEmitted.add(key);
        this.eventBusService.publish(this.buildAgentEvent('agent:busy', now, identity, 'idle', 'in_progress'));
      }
    }
  }

  public startPolling(): void {
    if (this.intervalId) {
      this.logger.warn('Activity monitoring already running');
      return;
    }

    this.logger.info('Starting activity monitoring with 2-minute intervals (NEW ARCHITECTURE: workingStatus only)');
    
    // Run immediately first
    this.performActivityCheck();
    
    // Set up recurring polling
    this.intervalId = setInterval(() => {
      this.performActivityCheck();
    }, this.POLLING_INTERVAL);
  }

  public stopPolling(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      this.logger.info('Activity monitoring stopped');
    }
  }

  private async performActivityCheck(): Promise<void> {
    try {
      // Add timeout protection for entire activity check
      await Promise.race([
        this.performActivityCheckInternal(),
        new Promise<void>((_, reject) => 
          setTimeout(() => reject(new Error('Activity check timeout')), this.ACTIVITY_CHECK_TIMEOUT)
        )
      ]);
      
      // Perform periodic cleanup
      this.performPeriodicCleanup();
      
    } catch (error) {
      this.logger.error('Error during activity check', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * NEW ARCHITECTURE: Simplified activity checking
   *
   * This method now:
   * 1. Detects stale agents via AgentHeartbeatService (30-minute threshold)
   * 2. Checks terminal activity for working status (ONLY)
   * 3. Updates teamWorkingStatus.json (separate from teams.json)
   * 4. Removes ALL agentStatus logic (handled by AgentHeartbeatService)
   */
  private async performActivityCheckInternal(): Promise<void> {
    const now = new Date().toISOString();

    try {
      // Step 1: Detect stale agents and mark dead ones as inactive
      const staleThreshold = CONTINUATION_CONSTANTS.DETECTION.STALE_THRESHOLD_MINUTES;
      const staleAgents = await this.agentHeartbeatService.detectStaleAgents(staleThreshold);
      if (staleAgents.length > 0) {
        this.logger.debug('Detected stale agents for potential inactivity', {
          staleAgents,
          thresholdMinutes: staleThreshold
        });

        // Batch-check stale agents and mark dead ones as inactive.
        // We read teams ONCE, update all dead members in memory, and save
        // each modified team ONCE — instead of calling updateAgentStatus()
        // per agent which does a full getTeams()+saveTeam() each time,
        // flooding the libuv thread pool with I/O.
        try {
          const backend = await this.getBackend();
          const heartbeats = await this.agentHeartbeatService.getAllAgentHeartbeats();

          // Collect dead session names first
          const deadSessions = new Set<string>();
          for (const agentId of staleAgents) {
            let sessionName: string | undefined;
            if (agentId === 'orchestrator') {
              sessionName = heartbeats.orchestrator?.sessionName;
            } else {
              sessionName = heartbeats.teamMembers[agentId]?.sessionName;
            }
            if (!sessionName) continue;

            const sessionAlive = backend.sessionExists(sessionName);
            if (!sessionAlive) {
              this.logger.debug('Marking stale agent as inactive (session dead)', {
                agentId,
                sessionName
              });
              deadSessions.add(sessionName);
              // Update heartbeat file so detectStaleAgents stops re-detecting this agent
              await this.agentHeartbeatService.updateAgentHeartbeat(
                sessionName,
                agentId === AGENT_IDENTITY_CONSTANTS.ORCHESTRATOR.ID ? undefined : agentId,
                CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
              );
            } else if (agentId === AGENT_IDENTITY_CONSTANTS.ORCHESTRATOR.ID) {
              this.logger.debug('Orchestrator is stale but auto-restart is disabled', {
                sessionName,
              });
            }
          }

          // Update orchestrator if dead
          if (deadSessions.has(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME)) {
            await this.storageService.updateAgentStatus(
              CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
              CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE
            );
            deadSessions.delete(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
          }

          // Batch-update team members: read teams once, save each modified team once
          if (deadSessions.size > 0) {
            const teams = await this.storageService.getTeams();
            const modifiedTeams = new Set<string>();

            for (const team of teams) {
              for (const member of team.members || []) {
                if (deadSessions.has(member.sessionName)) {
                  member.agentStatus = CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE as any;
                  member.updatedAt = new Date().toISOString();
                  modifiedTeams.add(team.id);
                }
              }
            }

            // Save each modified team once (sequentially to avoid lock contention)
            for (const team of teams) {
              if (modifiedTeams.has(team.id)) {
                await this.storageService.saveTeam(team);
              }
            }
          }
        } catch (cleanupError) {
          this.logger.error('Error during stale agent cleanup', {
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          });
        }
      }

      // Step 2: Load current working status file
      const workingStatusData = await this.loadTeamWorkingStatusFile();
      let hasChanges = false;

      // Step 3: Check orchestrator working status
      const backend = await this.getBackend();
      const orchestratorRunning = await Promise.race([
        Promise.resolve(backend.sessionExists(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME)),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Orchestrator check timeout')), 1000)
        )
      ]).catch(() => false);

      if (orchestratorRunning) {
        const orchestratorOutput = await this.getTerminalOutput(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
        const previousOutput = this.lastTerminalOutputs.get('orchestrator') || '';
        const outputChanged = orchestratorOutput !== previousOutput && orchestratorOutput.trim() !== '';

        // Bridge to PtyActivityTracker so idle/heartbeat checks detect activity
        // even when no WebSocket clients are connected
        if (outputChanged) {
          PtyActivityTrackerService.getInstance().recordActivity(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME);
        }

        const newWorkingStatus: WorkingStatus = outputChanged ? 'in_progress' : 'idle';
        const orchKey = 'orchestrator';
        const previousStatus = workingStatusData.orchestrator.workingStatus;
        const statusChanged = previousStatus !== newWorkingStatus;

        if (statusChanged) {
          workingStatusData.orchestrator.workingStatus = newWorkingStatus;
          workingStatusData.orchestrator.lastActivityCheck = now;
          workingStatusData.orchestrator.updatedAt = now;
          hasChanges = true;

          this.logger.info('Orchestrator working status updated', {
            sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
            newWorkingStatus,
            outputChanged
          });
        }

        this.handleDurationGatedEmission(orchKey, newWorkingStatus, previousStatus, statusChanged, {
          teamId: 'orchestrator',
          teamName: 'Orchestrator',
          memberId: AGENT_IDENTITY_CONSTANTS.ORCHESTRATOR.ID,
          memberName: 'Orchestrator',
          sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        }, now);

        this.lastTerminalOutputs.set('orchestrator', orchestratorOutput);
      } else {
        // Orchestrator not running, set to idle
        if (workingStatusData.orchestrator.workingStatus !== 'idle') {
          workingStatusData.orchestrator.workingStatus = 'idle';
          workingStatusData.orchestrator.lastActivityCheck = now;
          workingStatusData.orchestrator.updatedAt = now;
          hasChanges = true;
        }
      }

      // Step 4: Check team member working statuses
      const teams = await this.storageService.getTeams();

      for (const team of teams) {
        for (const member of team.members) {
          if (member.sessionName) {
            try {
              // Check if session exists
              const sessionExists = await Promise.race([
                Promise.resolve(backend.sessionExists(member.sessionName)),
                new Promise<boolean>((_, reject) =>
                  setTimeout(() => reject(new Error('Session check timeout')), 500)
                )
              ]).catch(() => false);

              if (!sessionExists) {
                // Session doesn't exist, set to idle
                const memberKey = member.sessionName;
                if (!workingStatusData.teamMembers[memberKey]) {
                  workingStatusData.teamMembers[memberKey] = {
                    sessionName: member.sessionName,
                    teamMemberId: member.id,
                    workingStatus: 'idle',
                    lastActivityCheck: now,
                    updatedAt: now
                  };
                  hasChanges = true;
                } else if (workingStatusData.teamMembers[memberKey].workingStatus !== 'idle') {
                  workingStatusData.teamMembers[memberKey].workingStatus = 'idle';
                  workingStatusData.teamMembers[memberKey].lastActivityCheck = now;
                  workingStatusData.teamMembers[memberKey].updatedAt = now;
                  hasChanges = true;
                }

                this.lastTerminalOutputs.delete(memberKey);
                this.busyTransitionTimestamps.delete(memberKey);
                this.busyEventEmitted.delete(memberKey);
                continue;
              }

              // Get terminal output and check for activity
              const currentOutput = await this.getTerminalOutput(member.sessionName);
              const previousOutput = this.lastTerminalOutputs.get(member.sessionName) || '';
              const outputChanged = currentOutput !== previousOutput && currentOutput.trim() !== '';
              const newWorkingStatus: WorkingStatus = outputChanged ? 'in_progress' : 'idle';

              // Update working status if changed
              const memberKey = member.sessionName;
              if (!workingStatusData.teamMembers[memberKey]) {
                workingStatusData.teamMembers[memberKey] = {
                  sessionName: member.sessionName,
                  teamMemberId: member.id,
                  workingStatus: newWorkingStatus,
                  lastActivityCheck: now,
                  updatedAt: now
                };
                hasChanges = true;
              } else {
                const previousMemberStatus = workingStatusData.teamMembers[memberKey].workingStatus;
                const memberStatusChanged = previousMemberStatus !== newWorkingStatus;

                if (memberStatusChanged) {
                  workingStatusData.teamMembers[memberKey].workingStatus = newWorkingStatus;
                  workingStatusData.teamMembers[memberKey].lastActivityCheck = now;
                  workingStatusData.teamMembers[memberKey].updatedAt = now;
                  hasChanges = true;

                  this.logger.info('Team member working status updated', {
                    teamId: team.id,
                    memberId: member.id,
                    memberName: member.name,
                    sessionName: member.sessionName,
                    newWorkingStatus,
                    outputChanged
                  });
                }

                this.handleDurationGatedEmission(memberKey, newWorkingStatus, previousMemberStatus, memberStatusChanged, {
                  teamId: team.id,
                  teamName: team.name,
                  memberId: member.id,
                  memberName: member.name,
                  sessionName: member.sessionName,
                }, now);
              }

              this.lastTerminalOutputs.set(member.sessionName, currentOutput);

            } catch (error) {
              this.logger.error('Error checking member working status', {
                teamId: team.id,
                memberId: member.id,
                memberName: member.name,
                sessionName: member.sessionName,
                error: error instanceof Error ? error.message : String(error)
              });
            }
          }
        }
      }

      // Step 5: Save changes if any
      if (hasChanges) {
        workingStatusData.metadata.lastUpdated = now;
        await this.saveTeamWorkingStatusFile(workingStatusData);
        this.logger.debug('Updated teamWorkingStatus.json with activity changes');
      }

    } catch (error) {
      this.logger.error('Error during activity check', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Load teamWorkingStatus.json file with proper initialization
   */
  private async loadTeamWorkingStatusFile(): Promise<TeamWorkingStatusFile> {
    try {
      if (!existsSync(this.teamWorkingStatusFile)) {
        const defaultData = this.createDefaultTeamWorkingStatusFile();
        await this.saveTeamWorkingStatusFile(defaultData);
        this.logger.info('Created new teamWorkingStatus.json file');
        return defaultData;
      }

      const content = await readFile(this.teamWorkingStatusFile, 'utf-8');
      const data = JSON.parse(content) as TeamWorkingStatusFile;

      // Validate structure
      if (!data.orchestrator || !data.teamMembers || !data.metadata) {
        this.logger.warn('Invalid teamWorkingStatus.json structure, reinitializing');
        const defaultData = this.createDefaultTeamWorkingStatusFile();
        await this.saveTeamWorkingStatusFile(defaultData);
        return defaultData;
      }

      return data;
    } catch (error) {
      this.logger.error('Failed to load teamWorkingStatus.json, creating new file', {
        error: error instanceof Error ? error.message : String(error)
      });
      const defaultData = this.createDefaultTeamWorkingStatusFile();
      await this.saveTeamWorkingStatusFile(defaultData);
      return defaultData;
    }
  }

  /**
   * Save teamWorkingStatus.json file with atomic write
   */
  private async saveTeamWorkingStatusFile(data: TeamWorkingStatusFile): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    const tempFile = `${this.teamWorkingStatusFile}.tmp`;

    try {
      // Write to temp file first, then rename (atomic operation)
      await writeFile(tempFile, content, 'utf-8');
      await rename(tempFile, this.teamWorkingStatusFile);
    } catch (error) {
      // Clean up temp file if something went wrong
      try {
        await unlink(tempFile);
      } catch {}
      throw error;
    }
  }

  /**
   * Create default teamWorkingStatus.json structure
   */
  private createDefaultTeamWorkingStatusFile(): TeamWorkingStatusFile {
    const now = new Date().toISOString();
    return {
      orchestrator: {
        sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
        workingStatus: 'idle',
        lastActivityCheck: now,
        updatedAt: now
      },
      teamMembers: {},
      metadata: {
        lastUpdated: now,
        version: '1.0.0'
      }
    };
  }

  /**
   * Cleanup old terminal outputs and perform garbage collection
   */
  private performPeriodicCleanup(): void {
    const now = Date.now();

    // Clean up every 2 minutes
    if (now - this.lastCleanup > 2 * 60 * 1000) {
      // Limit the size of lastTerminalOutputs Map to prevent memory leaks
      if (this.lastTerminalOutputs.size > 50) {
        const entries = Array.from(this.lastTerminalOutputs.entries());
        this.lastTerminalOutputs.clear();

        // Keep only the most recent 25 entries
        const recentEntries = entries.slice(-25);
        for (const [key, value] of recentEntries) {
          this.lastTerminalOutputs.set(key, value);
        }
      }

      this.lastCleanup = now;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        this.logger.debug('Performed periodic cleanup with garbage collection', {
          mapSize: this.lastTerminalOutputs.size
        });
      } else {
        this.logger.debug('Performed periodic cleanup', {
          mapSize: this.lastTerminalOutputs.size
        });
      }
    }
  }

  /**
   * Get terminal output with size limits for activity detection
   */
  private async getTerminalOutput(sessionName: string): Promise<string> {
    try {
      const backend = await this.getBackend();
      const output = await Promise.race([
        Promise.resolve(backend.captureOutput(sessionName, 5)), // 5 lines only
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Capture timeout')), 500)
        )
      ]);

      // Strip ANSI escape codes so TUI re-renders (spinners, cursor
      // repositioning) don't register as meaningful output changes.
      const cleaned = stripAnsiCodes(output).trim();

      // Limit output size to prevent memory issues
      return cleaned.length > this.MAX_OUTPUT_SIZE
        ? cleaned.substring(cleaned.length - this.MAX_OUTPUT_SIZE)
        : cleaned;
    } catch (error) {
      return '';
    }
  }

  public isRunning(): boolean {
    return this.intervalId !== null;
  }

  public getPollingInterval(): number {
    return this.POLLING_INTERVAL;
  }

  /**
   * Get current team working status data
   * Useful for external services that need to check working statuses
   */
  public async getTeamWorkingStatus(): Promise<TeamWorkingStatusFile> {
    return await this.loadTeamWorkingStatusFile();
  }

  /**
   * Get working status for a specific session
   */
  public async getWorkingStatusForSession(sessionName: string): Promise<WorkingStatus | null> {
    try {
      const data = await this.loadTeamWorkingStatusFile();

      if (sessionName === CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME) {
        return data.orchestrator.workingStatus;
      }

      return data.teamMembers[sessionName]?.workingStatus || null;
    } catch (error) {
      this.logger.error('Failed to get working status for session', {
        sessionName,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }
}