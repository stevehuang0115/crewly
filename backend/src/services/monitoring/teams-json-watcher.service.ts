import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { TeamActivityWebSocketService } from './team-activity-websocket.service.js';
import { Team, TeamMember } from '../../types/index.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { AgentEvent, EventType } from '../../types/event-bus.types.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/**
 * Service that watches the teams directory for changes and triggers
 * real-time WebSocket updates when agent registrations or team status changes occur.
 *
 * Watches: ~/.crewly/teams/{team-id}/config.json files
 */
export class TeamsJsonWatcherService extends EventEmitter {
  private logger: ComponentLogger;
  private teamActivityService: TeamActivityWebSocketService | null = null;
  private eventBusService: EventBusService | null = null;
  private watcher: fs.FSWatcher | null = null;
  private teamWatchers: Map<string, fs.FSWatcher> = new Map();
  private debounceTimer: NodeJS.Timeout | null = null;
  private readonly DEBOUNCE_DELAY = 1000; // 1 second debounce
  private teamsDir: string;
  private lastTeamsData: Team[] = []; // Cache of previous teams data for comparison

  constructor() {
    super();
    this.logger = LoggerService.getInstance().createComponentLogger('TeamsDirectoryWatcher');
    this.teamsDir = path.join(getCrewlyHomePath(), 'teams');

    // Cleanup on process exit
    process.on('SIGINT', () => this.cleanup());
    process.on('SIGTERM', () => this.cleanup());
  }

  /**
   * Set the TeamActivityWebSocketService instance to trigger when team changes occur
   */
  setTeamActivityService(teamActivityService: TeamActivityWebSocketService): void {
    this.teamActivityService = teamActivityService;
  }

  /**
   * Set the EventBusService instance for publishing agent lifecycle events
   */
  setEventBusService(service: EventBusService): void {
    this.eventBusService = service;
  }

  /**
   * Start watching the teams directory for changes
   */
  start(): void {
    this.logger.info('Starting teams directory watcher...', {
      path: this.teamsDir
    });

    // Ensure the teams directory exists
    if (!fs.existsSync(this.teamsDir)) {
      this.logger.warn('Teams directory does not exist, creating it...', {
        dir: this.teamsDir
      });
      fs.mkdirSync(this.teamsDir, { recursive: true });
    }

    // Stop existing watchers if any
    this.stop();

    try {
      // Watch the teams directory for new team folders being added/removed
      this.watcher = fs.watch(this.teamsDir, { persistent: true }, (eventType, filename) => {
        // Ignore hidden files and non-directory events
        if (filename && !filename.startsWith('.')) {
          this.logger.debug('Teams directory change detected', { eventType, filename });
          this.handleTeamsDirChange(eventType, filename);
        }
      });

      this.watcher.on('error', (error) => {
        this.logger.error('Teams directory watcher error:', {
          error: error instanceof Error ? error.message : String(error),
          path: this.teamsDir
        });

        // Emit error event for handling by parent services
        this.emit('watcher_error', error);

        // Attempt to restart watcher after a delay
        setTimeout(() => {
          this.logger.info('Attempting to restart teams directory watcher...');
          this.start();
        }, 5000);
      });

      // Set up watchers for existing team directories
      this.watchExistingTeamDirs();

      // Perform initial check to ensure current state is broadcasted
      this.triggerTeamActivityUpdate('initial_check');

      this.logger.info('Teams directory watcher started successfully');

    } catch (error) {
      this.logger.error('Failed to start teams directory watcher:', {
        error: error instanceof Error ? error.message : String(error),
        path: this.teamsDir
      });

      throw error;
    }
  }

  /**
   * Watch existing team directories for config.json changes
   */
  private watchExistingTeamDirs(): void {
    try {
      const entries = fs.readdirSync(this.teamsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          this.watchTeamDir(entry.name);
        }
      }
    } catch (error) {
      this.logger.warn('Error scanning existing team directories', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Watch a specific team directory for config.json changes
   */
  private watchTeamDir(teamId: string): void {
    const teamDir = path.join(this.teamsDir, teamId);

    // Skip if already watching
    if (this.teamWatchers.has(teamId)) {
      return;
    }

    try {
      const watcher = fs.watch(teamDir, { persistent: true }, (eventType, filename) => {
        // Only watch config.json changes
        if (filename === 'config.json') {
          this.logger.debug('Team config change detected', { teamId, eventType });
          this.handleTeamConfigChange(teamId, eventType);
        }
      });

      watcher.on('error', (error) => {
        this.logger.warn('Team directory watcher error', {
          teamId,
          error: error instanceof Error ? error.message : String(error)
        });
        // Remove failed watcher
        this.teamWatchers.delete(teamId);
      });

      this.teamWatchers.set(teamId, watcher);
      this.logger.debug('Started watching team directory', { teamId });
    } catch (error) {
      this.logger.warn('Failed to watch team directory', {
        teamId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Stop watching a specific team directory
   */
  private unwatchTeamDir(teamId: string): void {
    const watcher = this.teamWatchers.get(teamId);
    if (watcher) {
      try {
        watcher.close();
      } catch (error) {
        // Ignore close errors
      }
      this.teamWatchers.delete(teamId);
      this.logger.debug('Stopped watching team directory', { teamId });
    }
  }

  /**
   * Handle changes in the teams directory (new teams added/removed)
   */
  private handleTeamsDirChange(eventType: string, filename: string): void {
    const teamDir = path.join(this.teamsDir, filename);

    // Check if it's a directory
    if (fs.existsSync(teamDir) && fs.statSync(teamDir).isDirectory()) {
      // New team directory - start watching it
      this.watchTeamDir(filename);
    } else if (!fs.existsSync(teamDir)) {
      // Team directory removed - stop watching it
      this.unwatchTeamDir(filename);
    }

    // Trigger debounced update
    this.handleTeamsJsonChange(eventType);
  }

  /**
   * Handle changes in a team's config.json
   */
  private handleTeamConfigChange(teamId: string, eventType: string): void {
    this.logger.debug('Team config changed', { teamId, eventType });
    this.handleTeamsJsonChange(eventType);
  }

  /**
   * Stop watching the teams directory
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Stop all team directory watchers
    this.teamWatchers.forEach((watcher, teamId) => {
      try {
        watcher.close();
      } catch (error) {
        // Ignore close errors
      }
    });
    this.teamWatchers.clear();

    if (this.watcher) {
      try {
        this.watcher.close();
        this.logger.debug('Teams directory watcher stopped');
      } catch (error) {
        this.logger.error('Error stopping teams directory watcher:', {
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        this.watcher = null;
      }
    }
  }

  /**
   * Handle teams.json file changes with debouncing
   */
  private handleTeamsJsonChange(eventType: string): void {
    this.logger.debug('Teams.json change detected', { eventType });

    // Clear existing debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    // Set new debounce timer
    this.debounceTimer = setTimeout(() => {
      this.processTeamsJsonChange(eventType);
      this.debounceTimer = null;
    }, this.DEBOUNCE_DELAY);
  }

  /**
   * Process the actual teams change after debouncing
   */
  private async processTeamsJsonChange(eventType: string): Promise<void> {
    try {
      // Check if teams directory exists
      const dirExists = fs.existsSync(this.teamsDir);

      this.logger.info('Processing teams directory change', {
        eventType,
        dirExists,
        timestamp: new Date().toISOString()
      });

      // Emit change event for other services that might be interested
      this.emit('teams_changed', {
        eventType,
        dirExists,
        path: this.teamsDir,
        timestamp: new Date()
      });

      // Smart change detection - only trigger activity refresh for relevant changes
      const shouldTriggerActivityRefresh = await this.shouldTriggerActivityRefresh();

      if (shouldTriggerActivityRefresh) {
        this.logger.info('Activity-relevant change detected, triggering team activity refresh', {
          eventType
        });
        this.triggerTeamActivityUpdate(eventType);
      } else {
        this.logger.info('Metadata-only change detected, skipping activity refresh', {
          eventType
        });
      }

    } catch (error) {
      this.logger.error('Error processing teams change:', {
        error: error instanceof Error ? error.message : String(error),
        eventType
      });
    }
  }

  /**
   * Determine if the teams change should trigger an activity refresh
   * Only session/activity-relevant changes should trigger tmux commands
   */
  private async shouldTriggerActivityRefresh(): Promise<boolean> {
    try {
      // Read current teams data from directory structure
      const currentData = await this.readTeamsFromDirectory();

      // If this is the first time or we don't have cached data, trigger refresh
      if (!this.lastTeamsData || this.lastTeamsData.length === 0) {
        this.lastTeamsData = JSON.parse(JSON.stringify(currentData)); // Deep copy
        return true;
      }

      // Compare teams data for activity-relevant changes
      const hasActivityRelevantChange = this.hasActivityRelevantChanges(this.lastTeamsData, currentData);

      // Publish granular agent lifecycle events to the event bus
      this.publishAgentEvents(this.lastTeamsData, currentData);

      // Update cached data for next comparison
      this.lastTeamsData = JSON.parse(JSON.stringify(currentData)); // Deep copy

      return hasActivityRelevantChange;

    } catch (error) {
      this.logger.warn('Error comparing teams data, defaulting to trigger refresh', {
        error: error instanceof Error ? error.message : String(error)
      });
      return true; // Default to safe behavior
    }
  }

  /**
   * Read all teams from the directory structure
   */
  private async readTeamsFromDirectory(): Promise<Team[]> {
    const teams: Team[] = [];

    if (!fs.existsSync(this.teamsDir)) {
      return teams;
    }

    try {
      const entries = fs.readdirSync(this.teamsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'orchestrator' && !entry.name.startsWith('.')) {
          const configPath = path.join(this.teamsDir, entry.name, 'config.json');
          if (fs.existsSync(configPath)) {
            try {
              const content = fs.readFileSync(configPath, 'utf8');
              const team = JSON.parse(content) as Team;
              teams.push(team);
            } catch (parseError) {
              this.logger.warn('Error parsing team config', {
                teamId: entry.name,
                error: parseError instanceof Error ? parseError.message : String(parseError)
              });
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn('Error reading teams directory', {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return teams;
  }

  /**
   * Compare old and new teams data and publish granular agent lifecycle events
   * to the event bus for each status change detected.
   */
  private publishAgentEvents(oldTeams: Team[], newTeams: Team[]): void {
    if (!this.eventBusService) {
      return;
    }

    for (const newTeam of newTeams) {
      const oldTeam = oldTeams.find((t: Team) => t.id === newTeam.id);
      if (!oldTeam) {
        continue;
      }

      for (const newMember of newTeam.members) {
        const oldMember = oldTeam.members.find((m: TeamMember) => m.id === newMember.id);
        if (!oldMember) {
          continue;
        }

        // Detect agentStatus changes
        if (oldMember.agentStatus !== newMember.agentStatus) {
          const baseEvent: AgentEvent = {
            id: crypto.randomUUID(),
            type: 'agent:status_changed',
            timestamp: new Date().toISOString(),
            teamId: newTeam.id,
            teamName: newTeam.name,
            memberId: newMember.id,
            memberName: newMember.name,
            sessionName: newMember.sessionName,
            previousValue: oldMember.agentStatus,
            newValue: newMember.agentStatus,
            changedField: 'agentStatus',
          };

          // Publish generic status_changed event
          this.eventBusService.publish(baseEvent);

          // Publish specific event based on new status
          let specificType: EventType | null = null;
          if (newMember.agentStatus === 'active') {
            specificType = 'agent:active';
          } else if (newMember.agentStatus === 'inactive') {
            specificType = 'agent:inactive';
          }

          if (specificType) {
            this.eventBusService.publish({
              ...baseEvent,
              id: crypto.randomUUID(),
              type: specificType,
            });
          }
        }

        // Detect workingStatus changes
        if (oldMember.workingStatus !== newMember.workingStatus) {
          const workingEvent: AgentEvent = {
            id: crypto.randomUUID(),
            type: newMember.workingStatus === 'idle' ? 'agent:idle' : 'agent:busy',
            timestamp: new Date().toISOString(),
            teamId: newTeam.id,
            teamName: newTeam.name,
            memberId: newMember.id,
            memberName: newMember.name,
            sessionName: newMember.sessionName,
            previousValue: oldMember.workingStatus,
            newValue: newMember.workingStatus,
            changedField: 'workingStatus',
          };

          this.eventBusService.publish(workingEvent);

          // 2026-05-20 follow-up — disambiguate idle transitions for
          // peer-watch triggers. The file-watcher sees raw `oldValue →
          // newValue` transitions; we can distinguish:
          //   - prev was `in_progress` → this is `agent:idle_after_task`
          //   - prev was unset/null/empty (fresh-registration row) →
          //     `agent:idle_after_registration`
          // We do NOT emit the precise variant when we can't tell
          // (e.g. prev='idle', new='idle' — that case is filtered out
          // by the outer guard anyway).
          if (newMember.workingStatus === 'idle') {
            const wasBusy = oldMember.workingStatus === 'in_progress';
            const wasUnset = !oldMember.workingStatus;
            const preciseType: 'agent:idle_after_task' | 'agent:idle_after_registration' | null =
              wasBusy ? 'agent:idle_after_task'
              : wasUnset ? 'agent:idle_after_registration'
              : null;
            if (preciseType) {
              this.eventBusService.publish({
                ...workingEvent,
                id: crypto.randomUUID(),
                type: preciseType,
              });
            }
          }
        }
      }
    }
  }

  /**
   * Compare old and new teams data to detect activity-relevant changes
   * Returns true if changes affect session status or activity monitoring
   */
  private hasActivityRelevantChanges(oldTeams: Team[], newTeams: Team[]): boolean {
    // Check if number of teams changed (teams added/removed)
    if (oldTeams.length !== newTeams.length) {
      this.logger.debug('Teams count changed - activity relevant', {
        oldCount: oldTeams.length,
        newCount: newTeams.length
      });
      return true;
    }

    // Check each team for activity-relevant changes
    for (let i = 0; i < newTeams.length; i++) {
      const oldTeam = oldTeams.find((team: Team) => team.id === newTeams[i].id);
      const newTeam = newTeams[i];
      
      // If team doesn't exist in old data, it's a new team (activity relevant)
      if (!oldTeam) {
        this.logger.debug('New team detected - activity relevant', { teamId: newTeam.id });
        return true;
      }

      // Check if number of members changed (members added/removed)
      if (oldTeam.members.length !== newTeam.members.length) {
        this.logger.debug('Member count changed - activity relevant', {
          teamId: newTeam.id,
          oldCount: oldTeam.members.length,
          newCount: newTeam.members.length
        });
        return true;
      }

      // Check each member for activity-relevant changes
      for (const newMember of newTeam.members) {
        const oldMember = oldTeam.members.find((member: TeamMember) => member.id === newMember.id);
        
        // If member doesn't exist in old data, it's a new member (activity relevant)
        if (!oldMember) {
          this.logger.debug('New member detected - activity relevant', { 
            teamId: newTeam.id, 
            memberId: newMember.id 
          });
          return true;
        }

        // Check for activity-relevant field changes
        if (
          oldMember.agentStatus !== newMember.agentStatus ||
          oldMember.workingStatus !== newMember.workingStatus ||
          oldMember.sessionName !== newMember.sessionName
        ) {
          this.logger.debug('Activity-relevant field changed', {
            teamId: newTeam.id,
            memberId: newMember.id,
            changes: {
              agentStatus: oldMember.agentStatus !== newMember.agentStatus ? 
                { old: oldMember.agentStatus, new: newMember.agentStatus } : undefined,
              workingStatus: oldMember.workingStatus !== newMember.workingStatus ? 
                { old: oldMember.workingStatus, new: newMember.workingStatus } : undefined,
              sessionName: oldMember.sessionName !== newMember.sessionName ? 
                { old: oldMember.sessionName, new: newMember.sessionName } : undefined,
            }
          });
          return true;
        }

        // Log metadata changes but don't trigger activity refresh
        const metadataChanges: string[] = [];
        
        if (oldMember.runtimeType !== newMember.runtimeType) {
          metadataChanges.push(`runtimeType: ${oldMember.runtimeType} → ${newMember.runtimeType}`);
        }
        if (oldMember.systemPrompt !== newMember.systemPrompt) {
          metadataChanges.push('systemPrompt changed');
        }
        if (oldMember.name !== newMember.name) {
          metadataChanges.push(`name: ${oldMember.name} → ${newMember.name}`);
        }
        if (oldMember.role !== newMember.role) {
          metadataChanges.push(`role: ${oldMember.role} → ${newMember.role}`);
        }
        if (oldMember.readyAt !== newMember.readyAt) {
          metadataChanges.push('readyAt timestamp updated');
        }
        if (oldMember.lastActivityCheck !== newMember.lastActivityCheck) {
          metadataChanges.push('lastActivityCheck timestamp updated');
        }
        if (oldMember.updatedAt !== newMember.updatedAt) {
          metadataChanges.push('updatedAt timestamp updated');
        }

        if (metadataChanges.length > 0) {
          this.logger.debug('Metadata-only changes detected (not triggering activity refresh)', {
            teamId: newTeam.id,
            memberId: newMember.id,
            changes: metadataChanges
          });
        }
      }
    }

    // No activity-relevant changes found
    return false;
  }

  /**
   * Trigger team activity update through TeamActivityWebSocketService
   */
  private triggerTeamActivityUpdate(reason: string): void {
    if (!this.teamActivityService) {
      this.logger.warn('TeamActivityWebSocketService not set, cannot trigger update');
      return;
    }

    this.logger.info('Triggering team activity WebSocket update', { reason });

    try {
      // Force refresh of team activity data and broadcast to all connected clients
      this.teamActivityService.forceRefresh();
      
      // Emit event for logging/monitoring
      this.emit('team_activity_triggered', { reason, timestamp: new Date() });
      
    } catch (error) {
      this.logger.error('Error triggering team activity update:', {
        error: error instanceof Error ? error.message : String(error),
        reason
      });
    }
  }

  /**
   * Get watcher status information
   */
  getStatus(): {
    isWatching: boolean;
    teamsDir: string;
    dirExists: boolean;
    teamCount: number;
    watchedTeams: string[];
  } {
    const dirExists = fs.existsSync(this.teamsDir);
    let teamCount = 0;

    if (dirExists) {
      try {
        const entries = fs.readdirSync(this.teamsDir, { withFileTypes: true });
        teamCount = entries.filter(e => e.isDirectory() && e.name !== 'orchestrator' && !e.name.startsWith('.')).length;
      } catch (error) {
        this.logger.warn('Error counting teams:', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      isWatching: this.watcher !== null,
      teamsDir: this.teamsDir,
      dirExists,
      teamCount,
      watchedTeams: Array.from(this.teamWatchers.keys())
    };
  }

  /**
   * Force trigger a team activity update (for testing or manual refresh)
   */
  forceTrigger(reason: string = 'manual_trigger'): void {
    this.logger.info('Force triggering team activity update', { reason });
    this.triggerTeamActivityUpdate(reason);
  }

  /**
   * Cleanup resources
   */
  private cleanup(): void {
    this.logger.info('Cleaning up teams directory watcher...');
    this.stop();
    this.removeAllListeners();
  }
}