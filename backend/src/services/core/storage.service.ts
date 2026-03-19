import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync, watch, FSWatcher } from 'fs';
import { promisify } from 'util';
import { exec } from 'child_process';
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml';
import { Team, TeamMember, Project, Ticket, TicketFilter, ScheduledCheck, ScheduledMessage, MessageDeliveryLog } from '../../types/index.js';
import { TeamModel, ProjectModel, TicketModel, ScheduledMessageModel, MessageDeliveryLogModel } from '../../models/index.js';
import { v4 as uuidv4 } from 'uuid';
import * as os from 'os';
import { CREWLY_CONSTANTS, RUNTIME_TYPES, type AgentStatus, type WorkingStatus, type RuntimeType } from '../../constants.js';
import { LoggerService, ComponentLogger } from './logger.service.js';
import { TeamsBackupService } from './teams-backup.service.js';
import { atomicWriteFile, withOperationLock } from '../../utils/file-io.utils.js';
import { addGeminiTrustedFolders, getProjectTrustPaths } from '../../utils/gemini-trusted-folders.js';

export class StorageService {
  private static instance: StorageService | null = null;
  private static instanceHome: string | null = null;

  private crewlyHome: string;
  /** @deprecated Use teamsDir instead - kept for migration */
  private teamsFile: string;
  /** Directory containing individual team files */
  private teamsDir: string;
  /** Orchestrator status file */
  private orchestratorFile: string;
  private projectsFile: string;
  private runtimeFile: string;
  private scheduledMessagesFile: string;
  private deliveryLogsFile: string;
  private recurringChecksFile: string;
  private oneTimeChecksFile: string;
  private logger: ComponentLogger;
  /** Flag to track if migration has been performed */
  private migrationDone: boolean = false;
  /** Debounce timer for teams backup to avoid I/O storms */
  private backupDebounceTimer: NodeJS.Timeout | null = null;
  private readonly BACKUP_DEBOUNCE_MS = 2000;

  constructor(crewlyHome?: string) {
    this.logger = LoggerService.getInstance().createComponentLogger('StorageService');
    this.crewlyHome = crewlyHome || path.join(os.homedir(), '.crewly');
    this.teamsFile = path.join(this.crewlyHome, 'teams.json'); // Legacy, kept for migration
    this.teamsDir = path.join(this.crewlyHome, 'teams');
    // Orchestrator now uses directory structure: teams/orchestrator/config.json
    this.orchestratorFile = path.join(this.teamsDir, 'orchestrator', 'config.json');
    this.projectsFile = path.join(this.crewlyHome, 'projects.json');
    this.runtimeFile = path.join(this.crewlyHome, 'runtime.json');
    this.scheduledMessagesFile = path.join(this.crewlyHome, 'scheduled-messages.json');
    this.deliveryLogsFile = path.join(this.crewlyHome, 'message-delivery-logs.json');
    this.recurringChecksFile = path.join(this.crewlyHome, 'recurring-checks.json');
    this.oneTimeChecksFile = path.join(this.crewlyHome, 'one-time-checks.json');

    this.ensureDirectories();
    this.logger.info('StorageService initialized', { crewlyHome: this.crewlyHome });
  }

  /**
   * Get singleton instance of StorageService to prevent multiple instances
   * from interfering with each other's file operations
   */
  public static getInstance(crewlyHome?: string): StorageService {
    const homeDir = crewlyHome || path.join(os.homedir(), '.crewly');
    
    // Return existing instance if it matches the same home directory
    if (StorageService.instance && StorageService.instanceHome === homeDir) {
      return StorageService.instance;
    }
    
    // Create new instance if none exists or home directory changed
    StorageService.instance = new StorageService(homeDir);
    StorageService.instanceHome = homeDir;
    
    return StorageService.instance;
  }

  /**
   * Clear singleton instance (useful for testing)
   */
  public static clearInstance(): void {
    StorageService.instance = null;
    StorageService.instanceHome = null;
  }

  /**
   * Get the crewly home directory path.
   * Used by SchedulerService to locate orphaned temp files for cleanup (#217).
   *
   * @returns Absolute path to the crewly home directory (e.g. ~/.crewly)
   */
  getCrewlyHome(): string {
    return this.crewlyHome;
  }

  /**
   * Ensures the crewly home and teams directories exist, creating them if necessary
   */
  private ensureDirectories(): void {
    if (!existsSync(this.crewlyHome)) {
      mkdirSync(this.crewlyHome, { recursive: true });
    }
    if (!existsSync(this.teamsDir)) {
      mkdirSync(this.teamsDir, { recursive: true });
    }
    // Ensure orchestrator directory exists
    const orchestratorDir = path.join(this.teamsDir, 'orchestrator');
    if (!existsSync(orchestratorDir)) {
      mkdirSync(orchestratorDir, { recursive: true });
    }
  }

  /**
   * Get the directory path for a team.
   *
   * @param teamId - The team ID
   * @returns Path to the team directory
   */
  getTeamDir(teamId: string): string {
    return path.join(this.teamsDir, teamId);
  }

  /**
   * Get the prompts directory path for a team.
   *
   * @param teamId - The team ID
   * @returns Path to the team's prompts directory
   */
  getTeamPromptsDir(teamId: string): string {
    return path.join(this.teamsDir, teamId, 'prompts');
  }

  /**
   * Get the prompt file path for a team member.
   *
   * @param teamId - The team ID
   * @param memberId - The member ID
   * @returns Path to the member's prompt file
   */
  getMemberPromptPath(teamId: string, memberId: string): string {
    return path.join(this.getTeamPromptsDir(teamId), `${memberId}.md`);
  }

  /**
   * Get the orchestrator prompt file path.
   *
   * @returns Path to the orchestrator's prompt file
   */
  getOrchestratorPromptPath(): string {
    return path.join(this.teamsDir, 'orchestrator', 'prompt.md');
  }

  /**
   * Migrate from old storage formats to new directory structure.
   * Handles: teams.json -> teams/{team-id}/config.json
   *          teams/{team-id}.json -> teams/{team-id}/config.json
   *          teams/orchestrator.json -> teams/orchestrator/config.json
   */
  private async migrateFromLegacyTeamsFile(): Promise<void> {
    if (this.migrationDone) {
      return;
    }
    this.migrationDone = true;

    // Migration 1: From old teams.json (single file with all teams)
    if (existsSync(this.teamsFile)) {
      try {
        const content = await fs.readFile(this.teamsFile, 'utf-8');
        const data = JSON.parse(content);

        // Migrate orchestrator to directory structure
        if (data.orchestrator) {
          const orchestratorDir = path.join(this.teamsDir, 'orchestrator');
          if (!existsSync(orchestratorDir)) {
            mkdirSync(orchestratorDir, { recursive: true });
          }
          if (!existsSync(this.orchestratorFile)) {
            await atomicWriteFile(this.orchestratorFile, JSON.stringify(data.orchestrator, null, 2));
            this.logger.info('Migrated orchestrator to directory structure');
          }
        }

        // Migrate teams to directory structure
        const teams = data.teams || (Array.isArray(data) ? data : []);
        for (const team of teams) {
          if (team.id) {
            await this.migrateTeamToDirectory(team);
          }
        }

        // Backup legacy file
        const backupPath = `${this.teamsFile}.migrated.${Date.now()}`;
        await fs.rename(this.teamsFile, backupPath);
        this.logger.info('Legacy teams.json backed up after migration', { backupPath });
      } catch (error) {
        this.logger.warn('Error during legacy teams.json migration (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Migration 2: From flat team files (teams/{team-id}.json) to directory structure
    await this.migrateFlatTeamFiles();

    // Migration 3: From flat orchestrator file (teams/orchestrator.json) to directory
    const flatOrchestratorFile = path.join(this.teamsDir, 'orchestrator.json');
    if (existsSync(flatOrchestratorFile) && !existsSync(this.orchestratorFile)) {
      try {
        const content = await fs.readFile(flatOrchestratorFile, 'utf-8');
        const orchestrator = JSON.parse(content);
        const orchestratorDir = path.join(this.teamsDir, 'orchestrator');
        if (!existsSync(orchestratorDir)) {
          mkdirSync(orchestratorDir, { recursive: true });
        }
        await atomicWriteFile(this.orchestratorFile, JSON.stringify(orchestrator, null, 2));
        await fs.rename(flatOrchestratorFile, `${flatOrchestratorFile}.migrated.${Date.now()}`);
        this.logger.info('Migrated flat orchestrator.json to directory structure');
      } catch (error) {
        this.logger.warn('Error migrating flat orchestrator.json (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Migrate flat team files (teams/{team-id}.json) to directory structure (teams/{team-id}/config.json).
   */
  private async migrateFlatTeamFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.teamsDir);
      for (const file of files) {
        // Skip directories and non-json files
        if (!file.endsWith('.json') || file === 'orchestrator.json') continue;

        const filePath = path.join(this.teamsDir, file);
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) continue;

        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const team = JSON.parse(content);
          if (team.id) {
            await this.migrateTeamToDirectory(team);
            // Backup flat file
            await fs.rename(filePath, `${filePath}.migrated.${Date.now()}`);
            this.logger.info('Migrated flat team file to directory', { teamId: team.id });
          }
        } catch (error) {
          this.logger.warn('Error migrating flat team file (non-fatal)', {
            file,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn('Error scanning for flat team files (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Migrate a team to the new directory structure.
   * Creates teams/{team-id}/config.json and teams/{team-id}/prompts/{member-id}.md
   */
  private async migrateTeamToDirectory(team: Team): Promise<void> {
    const teamDir = this.getTeamDir(team.id);
    const teamConfigFile = path.join(teamDir, 'config.json');
    const promptsDir = this.getTeamPromptsDir(team.id);

    // Create team directory structure
    if (!existsSync(teamDir)) {
      mkdirSync(teamDir, { recursive: true });
    }
    if (!existsSync(promptsDir)) {
      mkdirSync(promptsDir, { recursive: true });
    }

    // Save team config (without inline prompts if they exist)
    if (!existsSync(teamConfigFile)) {
      await atomicWriteFile(teamConfigFile, JSON.stringify(team, null, 2));
    }

    // Extract member prompts to individual files
    for (const member of team.members || []) {
      if (member.systemPrompt) {
        const promptPath = this.getMemberPromptPath(team.id, member.id);
        if (!existsSync(promptPath)) {
          await atomicWriteFile(promptPath, member.systemPrompt);
          this.logger.debug('Extracted member prompt to file', {
            teamId: team.id,
            memberId: member.id,
            promptPath,
          });
        }
      }
    }

    this.logger.info('Migrated team to directory structure', {
      teamId: team.id,
      teamName: team.name,
      memberCount: team.members?.length || 0,
    });
  }

  /**
   * Creates default orchestrator configuration object
   * @returns Default orchestrator settings with inactive status
   */
  private createDefaultOrchestrator() {
    return {
      sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
      agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
      workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
      runtimeType: RUNTIME_TYPES.CLAUDE_CODE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  /**
   * Ensures a storage file exists and is valid JSON, creating or recovering it if needed
   * @param filePath - Path to the storage file
   * @param defaultContent - Default content to use if file needs to be created/recovered
   */
  private async ensureFile(filePath: string, defaultContent: unknown = []): Promise<void> {
    const fileName = path.basename(filePath);

    if (!existsSync(filePath)) {
      this.logger.info('Creating new storage file', { file: fileName });
      await atomicWriteFile(filePath, JSON.stringify(defaultContent, null, 2));
    } else {
      // File exists - validate it's not corrupted
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = JSON.parse(content);

        // If file is empty or has invalid content (null/undefined), reinitialize with defaults
        if (!content.trim() || parsed === null || parsed === undefined) {
          this.logger.warn('Storage file exists but appears empty/corrupted, creating backup and initializing with defaults', {
            file: fileName,
            contentLength: content?.length || 0,
          });
          // Backup even empty files for debugging
          const backupPath = `${filePath}.empty.${Date.now()}`;
          try {
            await fs.copyFile(filePath, backupPath);
            this.logger.info('Backed up empty file', { backupPath });
          } catch {
            // Ignore backup errors
          }
          await atomicWriteFile(filePath, JSON.stringify(defaultContent, null, 2));
        }
      } catch (error) {
        // File exists but can't be parsed - back it up and create new one
        this.logger.warn('Storage file exists but cannot be parsed, backing up and reinitializing', {
          file: fileName,
          error: error instanceof Error ? error.message : String(error),
        });
        const backupPath = `${filePath}.backup.${Date.now()}`;
        try {
          await fs.copyFile(filePath, backupPath);
          this.logger.info('Backed up corrupted file', { backupPath });
        } catch (backupError) {
          this.logger.error('Failed to backup corrupted file', {
            error: backupError instanceof Error ? backupError.message : String(backupError),
          });
        }
        await atomicWriteFile(filePath, JSON.stringify(defaultContent, null, 2));
      }
    }
  }

  // Team management
  /**
   * Get all teams from team directories.
   * Each team is stored as teams/{teamId}/config.json for isolation.
   *
   * @returns Array of all teams
   */
  async getTeams(): Promise<Team[]> {
    try {
      // Migrate from legacy format if needed
      await this.migrateFromLegacyTeamsFile();

      // Ensure teams directory exists
      if (!existsSync(this.teamsDir)) {
        mkdirSync(this.teamsDir, { recursive: true });
        return [];
      }

      // Read all team directories
      const entries = await fs.readdir(this.teamsDir, { withFileTypes: true });
      const teamDirs = entries.filter(e => e.isDirectory() && e.name !== 'orchestrator');

      const teams: Team[] = [];
      for (const dir of teamDirs) {
        try {
          const configPath = path.join(this.teamsDir, dir.name, 'config.json');
          if (!existsSync(configPath)) {
            continue; // Skip directories without config.json
          }
          const content = await fs.readFile(configPath, 'utf-8');
          const team = JSON.parse(content);
          const processedTeam = TeamModel.fromJSON(team).toJSON();
          teams.push(processedTeam);
        } catch (fileError) {
          this.logger.warn('Error reading team config, skipping', {
            teamDir: dir.name,
            error: fileError instanceof Error ? fileError.message : String(fileError),
          });
        }
      }

      this.logger.debug('Retrieved teams from storage', { count: teams.length });
      return teams;
    } catch (error) {
      this.logger.error('Error reading teams', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Save a team to its directory structure.
   * Each team is stored as teams/{teamId}/config.json for isolation and resilience.
   * Member prompts are saved to teams/{teamId}/prompts/{memberId}.md
   *
   * @param team - The team to save
   */
  async saveTeam(team: Team): Promise<void> {
    const teamDir = this.getTeamDir(team.id);
    const teamFile = path.join(teamDir, 'config.json');
    const promptsDir = this.getTeamPromptsDir(team.id);

    // Use operation lock on the team directory
    return withOperationLock(teamDir, async () => {
      try {
        // Ensure team directory structure exists
        if (!existsSync(teamDir)) {
          mkdirSync(teamDir, { recursive: true });
        }
        if (!existsSync(promptsDir)) {
          mkdirSync(promptsDir, { recursive: true });
        }

        // Check if this is an update or create
        const isUpdate = existsSync(teamFile);

        // Write team config to file
        await atomicWriteFile(teamFile, JSON.stringify(team, null, 2));

        // Save member prompts to individual files
        for (const member of team.members || []) {
          if (member.systemPrompt) {
            const promptPath = this.getMemberPromptPath(team.id, member.id);
            await atomicWriteFile(promptPath, member.systemPrompt);
          }
        }

        this.logger.info('Team saved successfully', {
          teamId: team.id,
          teamName: team.name,
          action: isUpdate ? 'updated' : 'created',
          memberCount: team.members?.length || 0,
          filePath: teamFile,
        });

        // Update teams backup (fire-and-forget, non-blocking)
        this.updateTeamsBackup();
      } catch (error) {
        this.logger.error('Error saving team', {
          teamId: team.id,
          teamName: team.name,
          error: error instanceof Error ? error.message : String(error),
          filePath: teamFile,
        });
        throw error;
      }
    });
  }

  /**
   * Save a member's prompt file.
   *
   * @param teamId - The team ID
   * @param memberId - The member ID
   * @param prompt - The prompt content
   */
  async saveMemberPrompt(teamId: string, memberId: string, prompt: string): Promise<void> {
    const promptsDir = this.getTeamPromptsDir(teamId);
    const promptPath = this.getMemberPromptPath(teamId, memberId);

    if (!existsSync(promptsDir)) {
      mkdirSync(promptsDir, { recursive: true });
    }

    await atomicWriteFile(promptPath, prompt);
    this.logger.debug('Saved member prompt', { teamId, memberId, promptPath });
  }

  /**
   * Get a member's prompt from file.
   *
   * @param teamId - The team ID
   * @param memberId - The member ID
   * @returns The prompt content or null if not found
   */
  async getMemberPrompt(teamId: string, memberId: string): Promise<string | null> {
    const promptPath = this.getMemberPromptPath(teamId, memberId);

    if (!existsSync(promptPath)) {
      return null;
    }

    try {
      return await fs.readFile(promptPath, 'utf-8');
    } catch (error) {
      this.logger.warn('Error reading member prompt', {
        teamId,
        memberId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Find a team member by their session name.
   *
   * @param sessionName - The session name to search for
   * @returns Object with team and member, or null if not found
   */
  async findMemberBySessionName(sessionName: string): Promise<{
    team: Team;
    member: TeamMember;
  } | null> {
    try {
      const teams = await this.getTeams();

      for (const team of teams) {
        for (const member of team.members || []) {
          if (member.sessionName === sessionName) {
            return { team, member };
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error('Error finding member by session name', {
        sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Save the orchestrator's prompt file.
   *
   * @param prompt - The prompt content
   */
  async saveOrchestratorPrompt(prompt: string): Promise<void> {
    const orchestratorDir = path.join(this.teamsDir, 'orchestrator');
    if (!existsSync(orchestratorDir)) {
      mkdirSync(orchestratorDir, { recursive: true });
    }

    const promptPath = this.getOrchestratorPromptPath();
    await atomicWriteFile(promptPath, prompt);
    this.logger.debug('Saved orchestrator prompt', { promptPath });
  }

  /**
   * Get the orchestrator's prompt from file.
   *
   * @returns The prompt content or null if not found
   */
  async getOrchestratorPrompt(): Promise<string | null> {
    const promptPath = this.getOrchestratorPromptPath();

    if (!existsSync(promptPath)) {
      return null;
    }

    try {
      return await fs.readFile(promptPath, 'utf-8');
    } catch (error) {
      this.logger.warn('Error reading orchestrator prompt', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }


  /**
   * Delete a team by removing its directory.
   *
   * @param id - The team ID to delete
   */
  async deleteTeam(id: string): Promise<void> {
    const teamDir = this.getTeamDir(id);

    try {
      if (existsSync(teamDir)) {
        // Remove team directory recursively
        await fs.rm(teamDir, { recursive: true, force: true });
        this.logger.info('Team deleted successfully', { teamId: id, teamDir });

        // Update teams backup (fire-and-forget, non-blocking)
        this.updateTeamsBackup();
      } else {
        this.logger.warn('Team directory not found for deletion', { teamId: id, teamDir });
      }
    } catch (error) {
      this.logger.error('Error deleting team', {
        teamId: id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Project management
  async getProjects(): Promise<Project[]> {
    try {
      await this.ensureFile(this.projectsFile);
      const content = await fs.readFile(this.projectsFile, 'utf-8');
      const projects = JSON.parse(content) as Project[];
      this.logger.debug('Retrieved projects from storage', { count: projects.length });
      return projects.map(project => ProjectModel.fromJSON(project).toJSON());
    } catch (error) {
      this.logger.error('Error reading projects', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async addProject(projectPath: string): Promise<Project> {
    try {
      // Resolve to absolute path to ensure .crewly is created in the correct location
      // If path is relative, resolve it relative to the parent directory of the current working directory
      let resolvedProjectPath: string;
      if (path.isAbsolute(projectPath)) {
        resolvedProjectPath = projectPath;
      } else {
        // Resolve relative to parent directory (where sibling projects should be)
        const parentDir = path.dirname(process.cwd());
        resolvedProjectPath = path.resolve(parentDir, projectPath);
      }
      const projectName = path.basename(resolvedProjectPath);
      const projectId = uuidv4();
      
      const project = new ProjectModel({
        id: projectId,
        name: projectName,
        path: resolvedProjectPath,
        teams: {},
        status: 'stopped',
      });

      // Ensure project directory and .crewly structure exists with template files
      mkdirSync(resolvedProjectPath, { recursive: true });
      
      const crewlyDir = path.join(resolvedProjectPath, '.crewly');
      if (!existsSync(crewlyDir)) {
        mkdirSync(crewlyDir, { recursive: true });
        mkdirSync(path.join(crewlyDir, 'tasks'), { recursive: true });
        mkdirSync(path.join(crewlyDir, 'specs'), { recursive: true });
        mkdirSync(path.join(crewlyDir, 'memory'), { recursive: true });
        mkdirSync(path.join(crewlyDir, 'prompts'), { recursive: true });
        
        // Create template files
        await this.createProjectTemplateFiles(crewlyDir, projectName);
      }

      await this.saveProject(project.toJSON());

      // Pre-trust the project path (and its parent directory) for Gemini CLI
      // so that agent sessions launched in this project do not hit the
      // interactive trust prompt. This is fire-and-forget (non-fatal).
      await addGeminiTrustedFolders(getProjectTrustPaths(resolvedProjectPath), this.logger);

      return project.toJSON();
    } catch (error) {
      this.logger.error('Error adding project', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async saveProject(project: Project): Promise<void> {
    try {
      const projects = await this.getProjects();
      const existingIndex = projects.findIndex(p => p.id === project.id);
      const isUpdate = existingIndex >= 0;

      if (isUpdate) {
        projects[existingIndex] = project;
      } else {
        projects.push(project);
      }

      const newContent = JSON.stringify(projects, null, 2);
      await atomicWriteFile(this.projectsFile, newContent);

      this.logger.info('Project saved successfully', {
        projectId: project.id,
        projectName: project.name,
        action: isUpdate ? 'updated' : 'created',
        totalProjects: projects.length,
        filePath: this.projectsFile,
      });
    } catch (error) {
      this.logger.error('Error saving project', {
        projectId: project.id,
        projectName: project.name,
        error: error instanceof Error ? error.message : String(error),
        filePath: this.projectsFile,
      });
      throw error;
    }
  }

  async deleteProject(id: string): Promise<void> {
    try {
      const projects = await this.getProjects();
      const filteredProjects = projects.filter(p => p.id !== id);
      await atomicWriteFile(this.projectsFile, JSON.stringify(filteredProjects, null, 2));
    } catch (error) {
      this.logger.error('Error deleting project', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // Ticket management
  async getTickets(projectPath: string, filter?: TicketFilter): Promise<Ticket[]> {
    try {
      const resolvedProjectPath = path.resolve(projectPath);
      const ticketsDir = path.join(resolvedProjectPath, '.crewly', 'tasks');
      
      if (!existsSync(ticketsDir)) {
        return [];
      }

      const files = await fs.readdir(ticketsDir);
      const yamlFiles = files.filter(file => file.endsWith('.yaml') || file.endsWith('.yml'));
      
      const tickets: Ticket[] = [];
      
      for (const file of yamlFiles) {
        try {
          const filePath = path.join(ticketsDir, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const ticket = this.parseTicketYAML(content);
          tickets.push(ticket);
        } catch (error) {
          this.logger.error('Error parsing ticket file', { file, error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Apply filters
      let filteredTickets = tickets;
      if (filter) {
        if (filter.status) {
          filteredTickets = filteredTickets.filter(t => t.status === filter.status);
        }
        if (filter.assignedTo) {
          filteredTickets = filteredTickets.filter(t => t.assignedTo === filter.assignedTo);
        }
        if (filter.projectId) {
          filteredTickets = filteredTickets.filter(t => t.projectId === filter.projectId);
        }
        if (filter.priority) {
          filteredTickets = filteredTickets.filter(t => t.priority === filter.priority);
        }
      }

      return filteredTickets.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (error) {
      this.logger.error('Error reading tickets', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async saveTicket(projectPath: string, ticket: Ticket): Promise<void> {
    try {
      const resolvedProjectPath = path.resolve(projectPath);
      const ticketsDir = path.join(resolvedProjectPath, '.crewly', 'tasks');
      
      if (!existsSync(ticketsDir)) {
        mkdirSync(ticketsDir, { recursive: true });
      }

      const ticketModel = TicketModel.fromJSON(ticket);
      const filename = `${ticket.id}.yaml`;
      const filePath = path.join(ticketsDir, filename);
      
      await fs.writeFile(filePath, ticketModel.toYAML());
    } catch (error) {
      this.logger.error('Error saving ticket', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async deleteTicket(projectPath: string, ticketId: string): Promise<void> {
    try {
      const resolvedProjectPath = path.resolve(projectPath);
      const ticketsDir = path.join(resolvedProjectPath, '.crewly', 'tasks');
      const filename = `${ticketId}.yaml`;
      const filePath = path.join(ticketsDir, filename);
      
      if (existsSync(filePath)) {
        await fs.unlink(filePath);
      }
    } catch (error) {
      this.logger.error('Error deleting ticket', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private parseTicketYAML(content: string): Ticket {
    const lines = content.split('\n');
    let frontmatterEnd = -1;
    let frontmatterStart = -1;

    // Find YAML frontmatter
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        if (frontmatterStart === -1) {
          frontmatterStart = i;
        } else {
          frontmatterEnd = i;
          break;
        }
      }
    }

    let frontmatter: any = {};
    let description = '';

    if (frontmatterStart !== -1 && frontmatterEnd !== -1) {
      const yamlContent = lines.slice(frontmatterStart + 1, frontmatterEnd).join('\n');
      frontmatter = parseYAML(yamlContent) || {};
      description = lines.slice(frontmatterEnd + 1).join('\n').trim();
    } else {
      description = content.trim();
    }

    return {
      id: frontmatter.id || uuidv4(),
      title: frontmatter.title || 'Untitled',
      description: description,
      status: frontmatter.status || 'open',
      assignedTo: frontmatter.assignedTo,
      priority: frontmatter.priority || 'medium',
      labels: frontmatter.labels || [],
      projectId: frontmatter.projectId || '',
      createdAt: frontmatter.createdAt || new Date().toISOString(),
      updatedAt: frontmatter.updatedAt || new Date().toISOString(),
    };
  }

  // File watching
  watchProject(projectPath: string): FSWatcher {
    const resolvedProjectPath = path.resolve(projectPath);
    const crewlyDir = path.join(resolvedProjectPath, '.crewly');
    
    return watch(crewlyDir, { recursive: true }, (eventType, filename) => {
      if (filename) {
        this.logger.info('File change detected', { eventType, filename: filename || 'unknown', projectPath: resolvedProjectPath });
        // Emit events that can be handled by WebSocket gateway
      }
    });
  }

  // Runtime state management
  async getRuntimeState(): Promise<any> {
    try {
      await this.ensureFile(this.runtimeFile, {});
      const content = await fs.readFile(this.runtimeFile, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      this.logger.error('Error reading runtime state', { error: error instanceof Error ? error.message : String(error) });
      return {};
    }
  }

  async saveRuntimeState(state: any): Promise<void> {
    try {
      await atomicWriteFile(this.runtimeFile, JSON.stringify(state, null, 2));
    } catch (error) {
      this.logger.error('Error saving runtime state', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Create template files for a new project
   */
  private async createProjectTemplateFiles(crewlyDir: string, projectName: string): Promise<void> {
    try {
      // Project specification template
      const projectSpecPath = path.join(crewlyDir, 'specs', 'project.md');
      const projectSpecTemplate = `# ${projectName} - Project Specification

## Overview
Brief description of ${projectName} and its goals.

## Requirements
- List key functional requirements
- Non-functional requirements
- Technical constraints

## Architecture
High-level system architecture and technology stack.

## Implementation Plan
### Phase 1: Foundation
- Core functionality setup
- Basic project structure
- Initial testing framework

### Phase 2: Features
- Main feature implementation
- Integration and testing
- Performance optimization

### Phase 3: Polish
- UI/UX improvements
- Documentation completion
- Deployment preparation

## Acceptance Criteria
- [ ] All requirements implemented
- [ ] Tests passing (>90% coverage)
- [ ] Documentation complete
- [ ] Performance targets met
- [ ] Security review completed
`;

      await fs.writeFile(projectSpecPath, projectSpecTemplate, 'utf8');

      // README for the .crewly directory
      const readmePath = path.join(crewlyDir, 'README.md');
      const readmeTemplate = `# Crewly Project Directory

This directory contains Crewly-specific files for **${projectName}** project orchestration.

## Structure

- **specs/**: Project specifications and requirements
- **tasks/**: Task items in YAML + Markdown format  
- **memory/**: Agent memory and context files
- **prompts/**: Custom system prompts for team members

## Usage

Crewly agents automatically read from these directories to understand:
- Project requirements and specifications
- Current tasks and their status
- Historical context and decisions
- Role-specific instructions

All files in this directory are monitored by Crewly for real-time updates.

## Getting Started

1. Update \`specs/project.md\` with your project requirements
2. Create task items in \`tasks/\` directory for specific tasks
3. Customize team member prompts in \`prompts/\` as needed
4. Let Crewly orchestrate your development workflow!
`;

      await fs.writeFile(readmePath, readmeTemplate, 'utf8');

      // Sample ticket template
      const sampleTicketPath = path.join(crewlyDir, 'tasks', 'sample-setup-task.yaml');
      const ticketTemplate = `---
id: sample-setup-task
title: Project Setup and Configuration
status: todo
priority: high
assignedTo: ""
estimatedHours: 4
createdAt: ${new Date().toISOString()}
updatedAt: ${new Date().toISOString()}
tags:
  - setup
  - configuration
  - infrastructure
---

# Project Setup and Configuration

## Description
Set up the basic project infrastructure and configuration for ${projectName}.

## Acceptance Criteria
- [ ] Project structure created
- [ ] Build system configured
- [ ] Testing framework set up
- [ ] CI/CD pipeline configured
- [ ] Documentation structure established
- [ ] Development environment documented

## Implementation Notes
This is a foundational task that should be completed first before other development work begins.

## Test Plan
- Verify build process works correctly
- Confirm tests can be run successfully
- Check all documentation is accessible
- Validate development environment setup instructions
`;

      await fs.writeFile(sampleTicketPath, ticketTemplate, 'utf8');

      this.logger.info('Created Crewly template files for project', { projectName });
    } catch (error) {
      this.logger.error('Error creating project template files', { error: error instanceof Error ? error.message : String(error) });
      // Don't throw - project can still work without template files
    }
  }

  // Scheduled Messages management
  async getScheduledMessages(): Promise<ScheduledMessage[]> {
    try {
      await this.ensureFile(this.scheduledMessagesFile, []);
      const content = await fs.readFile(this.scheduledMessagesFile, 'utf-8');
      
      // Handle empty content or malformed JSON
      if (!content.trim()) {
        await atomicWriteFile(this.scheduledMessagesFile, JSON.stringify([], null, 2));
        return [];
      }
      
      try {
        return JSON.parse(content) as ScheduledMessage[];
      } catch (parseError) {
        this.logger.error('Error parsing scheduled messages JSON, resetting file', { error: parseError instanceof Error ? parseError.message : String(parseError) });
        // Reset the file with empty array if JSON is corrupted
        await atomicWriteFile(this.scheduledMessagesFile, JSON.stringify([], null, 2));
        return [];
      }
    } catch (error) {
      this.logger.error('Error reading scheduled messages', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async saveScheduledMessage(scheduledMessage: ScheduledMessage): Promise<void> {
    try {
      const messages = await this.getScheduledMessages();
      const existingIndex = messages.findIndex(m => m.id === scheduledMessage.id);
      
      if (existingIndex >= 0) {
        messages[existingIndex] = scheduledMessage;
      } else {
        messages.push(scheduledMessage);
      }

      await atomicWriteFile(this.scheduledMessagesFile, JSON.stringify(messages, null, 2));
    } catch (error) {
      this.logger.error('Error saving scheduled message', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async getScheduledMessage(id: string): Promise<ScheduledMessage | undefined> {
    try {
      const messages = await this.getScheduledMessages();
      return messages.find(m => m.id === id);
    } catch (error) {
      this.logger.error('Error getting scheduled message', { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  async deleteScheduledMessage(id: string): Promise<boolean> {
    try {
      const messages = await this.getScheduledMessages();
      const filteredMessages = messages.filter(m => m.id !== id);
      
      if (filteredMessages.length === messages.length) {
        return false; // Message not found
      }

      await atomicWriteFile(this.scheduledMessagesFile, JSON.stringify(filteredMessages, null, 2));
      return true;
    } catch (error) {
      this.logger.error('Error deleting scheduled message', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // Recurring Checks persistence
  /**
   * Get all persisted recurring checks.
   *
   * @returns Array of persisted ScheduledCheck entries
   */
  async getRecurringChecks(): Promise<ScheduledCheck[]> {
    try {
      await this.ensureFile(this.recurringChecksFile, []);
      const content = await fs.readFile(this.recurringChecksFile, 'utf-8');

      if (!content.trim()) {
        await atomicWriteFile(this.recurringChecksFile, JSON.stringify([], null, 2));
        return [];
      }

      try {
        return JSON.parse(content) as ScheduledCheck[];
      } catch (parseError) {
        this.logger.error('Error parsing recurring checks JSON, resetting file', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        await atomicWriteFile(this.recurringChecksFile, JSON.stringify([], null, 2));
        return [];
      }
    } catch (error) {
      this.logger.error('Error reading recurring checks', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Save or update a recurring check entry on disk.
   *
   * @param check - The ScheduledCheck to persist
   */
  async saveRecurringCheck(check: ScheduledCheck): Promise<void> {
    try {
      const checks = await this.getRecurringChecks();
      const existingIndex = checks.findIndex(c => c.id === check.id);

      if (existingIndex >= 0) {
        checks[existingIndex] = check;
      } else {
        checks.push(check);
      }

      await atomicWriteFile(this.recurringChecksFile, JSON.stringify(checks, null, 2));
    } catch (error) {
      this.logger.error('Error saving recurring check', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete a persisted recurring check by ID.
   *
   * @param id - The check ID to delete
   * @returns true if the check was found and deleted
   */
  async deleteRecurringCheck(id: string): Promise<boolean> {
    try {
      const checks = await this.getRecurringChecks();
      const filtered = checks.filter(c => c.id !== id);

      if (filtered.length === checks.length) {
        return false;
      }

      await atomicWriteFile(this.recurringChecksFile, JSON.stringify(filtered, null, 2));
      return true;
    } catch (error) {
      this.logger.error('Error deleting recurring check', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clear all persisted recurring checks.
   */
  async clearRecurringChecks(): Promise<void> {
    try {
      await atomicWriteFile(this.recurringChecksFile, JSON.stringify([], null, 2));
    } catch (error) {
      this.logger.error('Error clearing recurring checks', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // One-Time Checks persistence
  /**
   * Get all persisted one-time checks.
   *
   * @returns Array of persisted ScheduledCheck entries
   */
  async getOneTimeChecks(): Promise<ScheduledCheck[]> {
    try {
      await this.ensureFile(this.oneTimeChecksFile, []);
      const content = await fs.readFile(this.oneTimeChecksFile, 'utf-8');

      if (!content.trim()) {
        await atomicWriteFile(this.oneTimeChecksFile, JSON.stringify([], null, 2));
        return [];
      }

      try {
        return JSON.parse(content) as ScheduledCheck[];
      } catch (parseError) {
        this.logger.error('Error parsing one-time checks JSON, resetting file', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
        await atomicWriteFile(this.oneTimeChecksFile, JSON.stringify([], null, 2));
        return [];
      }
    } catch (error) {
      this.logger.error('Error reading one-time checks', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Save or update a one-time check entry on disk.
   *
   * @param check - The ScheduledCheck to persist
   */
  async saveOneTimeCheck(check: ScheduledCheck): Promise<void> {
    try {
      const checks = await this.getOneTimeChecks();
      const existingIndex = checks.findIndex(c => c.id === check.id);

      if (existingIndex >= 0) {
        checks[existingIndex] = check;
      } else {
        checks.push(check);
      }

      await atomicWriteFile(this.oneTimeChecksFile, JSON.stringify(checks, null, 2));
    } catch (error) {
      this.logger.error('Error saving one-time check', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete a persisted one-time check by ID.
   *
   * @param id - The check ID to delete
   * @returns true if the check was found and deleted
   */
  async deleteOneTimeCheck(id: string): Promise<boolean> {
    try {
      const checks = await this.getOneTimeChecks();
      const filtered = checks.filter(c => c.id !== id);

      if (filtered.length === checks.length) {
        return false;
      }

      await atomicWriteFile(this.oneTimeChecksFile, JSON.stringify(filtered, null, 2));
      return true;
    } catch (error) {
      this.logger.error('Error deleting one-time check', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Clear all persisted one-time checks.
   */
  async clearOneTimeChecks(): Promise<void> {
    try {
      await atomicWriteFile(this.oneTimeChecksFile, JSON.stringify([], null, 2));
    } catch (error) {
      this.logger.error('Error clearing one-time checks', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // Message Delivery Logs management
  async getDeliveryLogs(): Promise<MessageDeliveryLog[]> {
    try {
      await this.ensureFile(this.deliveryLogsFile);
      const content = await fs.readFile(this.deliveryLogsFile, 'utf-8');
      const logs = JSON.parse(content) as MessageDeliveryLog[];
      // Sort by sentAt (newest first)
      return logs.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
    } catch (error) {
      this.logger.error('Error reading delivery logs', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  async saveDeliveryLog(log: MessageDeliveryLog): Promise<void> {
    try {
      const logs = await this.getDeliveryLogs();
      logs.unshift(log); // Add to beginning for newest first order
      
      // Keep only last 1000 logs to prevent file from getting too large
      const trimmedLogs = logs.slice(0, 1000);
      
      await atomicWriteFile(this.deliveryLogsFile, JSON.stringify(trimmedLogs, null, 2));
    } catch (error) {
      this.logger.error('Error saving delivery log', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async clearDeliveryLogs(): Promise<void> {
    try {
      await atomicWriteFile(this.deliveryLogsFile, JSON.stringify([], null, 2));
    } catch (error) {
      this.logger.error('Error clearing delivery logs', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // Orchestrator management
  /**
   * Get orchestrator status from dedicated orchestrator.json file.
   *
   * @returns Orchestrator status object or null if not found
   */
  async getOrchestratorStatus(): Promise<{ sessionName: string; agentStatus: AgentStatus; workingStatus: WorkingStatus; runtimeType: RuntimeType; createdAt: string; updatedAt: string } | null> {
    try {
      // Migrate from legacy format if needed
      await this.migrateFromLegacyTeamsFile();

      // Check if orchestrator file exists
      if (!existsSync(this.orchestratorFile)) {
        // Create default orchestrator
        const orchestrator = this.createDefaultOrchestrator();
        await atomicWriteFile(this.orchestratorFile, JSON.stringify(orchestrator, null, 2));
        return orchestrator;
      }

      const content = await fs.readFile(this.orchestratorFile, 'utf-8');
      const orchestrator = JSON.parse(content);
      return orchestrator;
    } catch (error) {
      this.logger.error('Error reading orchestrator status', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Update agent status for orchestrator or any team member.
   * Orchestrator status is stored in teams/orchestrator.json.
   * Team member status is stored in the respective team's file.
   *
   * @param sessionName - Session name of the agent (CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME for orchestrator)
   * @param status - New agent status (CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE | CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVATING | CREWLY_CONSTANTS.AGENT_STATUSES.ACTIVE)
   */
  async updateAgentStatus(sessionName: string, status: AgentStatus): Promise<void> {
    // Handle orchestrator separately
    if (sessionName === CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME) {
      return withOperationLock(this.orchestratorFile, async () => {
        try {
          let orchestrator;
          if (existsSync(this.orchestratorFile)) {
            const content = await fs.readFile(this.orchestratorFile, 'utf-8');
            orchestrator = JSON.parse(content);
          } else {
            orchestrator = this.createDefaultOrchestrator();
          }

          orchestrator.agentStatus = status;
          orchestrator.updatedAt = new Date().toISOString();

          await atomicWriteFile(this.orchestratorFile, JSON.stringify(orchestrator, null, 2));
          this.logger.debug('Updated orchestrator status', { status });
        } catch (error) {
          this.logger.error('Error updating orchestrator status', {
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      });
    }

    // Handle regular team members - find the team containing this member
    try {
      const teams = await this.getTeams();
      let memberFound = false;

      for (const team of teams) {
        for (const member of team.members || []) {
          if (member.sessionName === sessionName) {
            member.agentStatus = status;
            member.updatedAt = new Date().toISOString();
            memberFound = true;

            // Save the updated team
            await this.saveTeam(team);
            this.logger.debug('Updated team member status', {
              sessionName,
              status,
              teamId: team.id,
            });
            break;
          }
        }
        if (memberFound) break;
      }

      if (!memberFound) {
        // DEBUG: This is expected for orphaned sessions from deleted/reconfigured teams.
        // Monitors (RuntimeExitMonitor, ActivityMonitor) may still track stale tmux sessions.
        this.logger.debug('Agent session not found in any team (likely orphaned)', { sessionName });
      }
    } catch (error) {
      this.logger.error('Error updating agent status', {
        sessionName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update team member runtime type
   */
  async updateTeamMemberRuntimeType(teamId: string, memberId: string, runtimeType: RuntimeType): Promise<void> {
    try {
      const teams = await this.getTeams();
      const team = teams.find(t => t.id === teamId);
      
      if (!team) {
        throw new Error(`Team not found: ${teamId}`);
      }
      
      const member = team.members.find(m => m.id === memberId);
      if (!member) {
        throw new Error(`Team member not found: ${memberId} in team ${teamId}`);
      }
      
      member.runtimeType = runtimeType;
      member.updatedAt = new Date().toISOString();
      
      await this.saveTeam(team);
    } catch (error) {
      this.logger.error('Error updating team member runtime type', { teamId, memberId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Update orchestrator runtime type in teams/orchestrator.json.
   *
   * @param runtimeType - The runtime type to set
   */
  async updateOrchestratorRuntimeType(runtimeType: RuntimeType): Promise<void> {
    return withOperationLock(this.orchestratorFile, async () => {
      try {
        let orchestrator;
        if (existsSync(this.orchestratorFile)) {
          const content = await fs.readFile(this.orchestratorFile, 'utf-8');
          orchestrator = JSON.parse(content);
        } else {
          orchestrator = this.createDefaultOrchestrator();
        }

        orchestrator.runtimeType = runtimeType;
        orchestrator.updatedAt = new Date().toISOString();

        await atomicWriteFile(this.orchestratorFile, JSON.stringify(orchestrator, null, 2));
        this.logger.debug('Updated orchestrator runtime type', { runtimeType });
      } catch (error) {
        this.logger.error('Error updating orchestrator runtime type', {
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });
  }


  /**
   * Update the teams backup file asynchronously with debouncing.
   *
   * When many teams are saved in rapid succession (e.g. ActivityMonitor
   * marking 14 stale agents), each saveTeam() call used to trigger a
   * full getTeams() + backup, flooding the libuv thread pool with I/O
   * and starving other requests. Debouncing collapses the burst into a
   * single backup operation.
   */
  private updateTeamsBackup(): void {
    if (this.backupDebounceTimer) {
      clearTimeout(this.backupDebounceTimer);
    }
    this.backupDebounceTimer = setTimeout(() => {
      this.backupDebounceTimer = null;
      this.getTeams()
        .then((teams) => TeamsBackupService.getInstance().updateBackup(teams))
        .catch((error) => {
          this.logger.warn('Failed to update teams backup', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, this.BACKUP_DEBOUNCE_MS);
  }

  /**
   * @deprecated Use updateAgentStatus instead
   */
  async updateOrchestratorStatus(status: string): Promise<void> {
    return this.updateAgentStatus(CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME, status as AgentStatus);
  }
}