import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ScheduledMessage } from '../../types/index.js';
import { ScheduledMessageModel } from '../../models/ScheduledMessage.js';
import { StorageService } from '../core/storage.service.js';
import { PromptTemplateService, CheckinData } from '../ai/prompt-template.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

export interface ActiveProject {
  projectId: string;
  status: 'running' | 'stopped';
  startedAt: string;
  stoppedAt?: string;
  checkInScheduleId?: string;
}

export interface ActiveProjectsData {
  activeProjects: ActiveProject[];
  lastUpdated: string;
  version: string;
}

export class ActiveProjectsService {
  private readonly activeProjectsPath: string;
  private storageService?: StorageService;
  private promptTemplateService: PromptTemplateService;
  private readonly logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ActiveProjectsService');

  constructor(storageService?: StorageService) {
    this.activeProjectsPath = path.join(getCrewlyHomePath(), 'active_projects.json');
    this.storageService = storageService;
    this.promptTemplateService = new PromptTemplateService();
  }

  async loadActiveProjectsData(): Promise<ActiveProjectsData> {
    try {
      if (!fsSync.existsSync(this.activeProjectsPath)) {
        const initialData: ActiveProjectsData = {
          activeProjects: [],
          lastUpdated: new Date().toISOString(),
          version: '1.0.0'
        };
        await this.saveActiveProjectsData(initialData);
        return initialData;
      }

      const content = await fs.readFile(this.activeProjectsPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      this.logger.error('Error loading active projects data', { error: error instanceof Error ? error.message : String(error) });
      return {
        activeProjects: [],
        lastUpdated: new Date().toISOString(),
        version: '1.0.0'
      };
    }
  }

  async saveActiveProjectsData(data: ActiveProjectsData): Promise<void> {
    try {
      data.lastUpdated = new Date().toISOString();
      
      // Ensure directory exists
      const dir = path.dirname(this.activeProjectsPath);
      await fs.mkdir(dir, { recursive: true });
      
      await fs.writeFile(this.activeProjectsPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error('Error saving active projects data', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async startProject(
    projectId: string,
    messageSchedulerService?: any
  ): Promise<{
    checkInScheduleId?: string;
  }> {
    const data = await this.loadActiveProjectsData();

    // Check if project is already running
    const existingProject = data.activeProjects.find(p => p.projectId === projectId);
    if (existingProject && existingProject.status === 'running') {
      throw new Error('Project is already running');
    }

    // Create or update project entry
    const projectEntry: ActiveProject = {
      projectId,
      status: 'running',
      startedAt: new Date().toISOString()
    };

    let checkInScheduleId: string | undefined;

    // Create scheduled messages if messageSchedulerService is provided
    if (messageSchedulerService) {
      try {
        // Create 15-minute check-in schedule
        checkInScheduleId = await this.createProjectCheckInSchedule(
          projectId,
          messageSchedulerService
        );
        projectEntry.checkInScheduleId = checkInScheduleId;

      } catch (scheduleError) {
        this.logger.warn('Failed to create scheduled messages for project', { error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError) });
        // Continue without scheduled messages
      }
    }

    // Update or add project
    if (existingProject) {
      const index = data.activeProjects.findIndex(p => p.projectId === projectId);
      data.activeProjects[index] = projectEntry;
    } else {
      data.activeProjects.push(projectEntry);
    }

    await this.saveActiveProjectsData(data);

    return {
      checkInScheduleId
    };
  }

  async stopProject(
    projectId: string,
    messageSchedulerService?: any
  ): Promise<void> {
    const data = await this.loadActiveProjectsData();
    
    const projectIndex = data.activeProjects.findIndex(p => p.projectId === projectId);
    if (projectIndex === -1) {
      throw new Error('Project not found in active projects');
    }

    const project = data.activeProjects[projectIndex];

    // Cancel scheduled messages if messageSchedulerService is provided
    if (messageSchedulerService) {
      try {
        if (project.checkInScheduleId) {
          messageSchedulerService.cancelMessage(project.checkInScheduleId);
        }
      } catch (scheduleError) {
        this.logger.warn('Failed to cancel scheduled messages for project', { error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError) });
        // Continue with stopping project
      }
    }

    // Update project status
    project.status = 'stopped';
    project.stoppedAt = new Date().toISOString();

    // Remove schedule IDs since they're cancelled
    delete project.checkInScheduleId;

    data.activeProjects[projectIndex] = project;

    await this.saveActiveProjectsData(data);
  }

  async restartProject(
    projectId: string,
    messageSchedulerService?: any
  ): Promise<{
    checkInScheduleId?: string;
  }> {
    // Stop project first (if running) then start it
    try {
      await this.stopProject(projectId, messageSchedulerService);
    } catch (error) {
      // Project might not be running, continue with restart
      this.logger.info('Project was not running, starting fresh', { error: error instanceof Error ? error.message : String(error) });
    }

    return await this.startProject(projectId, messageSchedulerService);
  }

  async getActiveProjects(): Promise<ActiveProject[]> {
    const data = await this.loadActiveProjectsData();
    return data.activeProjects.filter(p => p.status === 'running');
  }

  async getAllProjects(): Promise<ActiveProject[]> {
    const data = await this.loadActiveProjectsData();
    return data.activeProjects;
  }

  async getProjectStatus(projectId: string): Promise<ActiveProject | null> {
    const data = await this.loadActiveProjectsData();
    return data.activeProjects.find(p => p.projectId === projectId) || null;
  }

  async isProjectRunning(projectId: string): Promise<boolean> {
    const project = await this.getProjectStatus(projectId);
    return project?.status === 'running';
  }

  private async createProjectCheckInSchedule(
    projectId: string,
    messageSchedulerService: any
  ): Promise<string> {
    let checkInMessage: string;

    try {
      // Get project information from storage service
      if (this.storageService) {
        const projects = await this.storageService.getProjects();
        const project = projects.find(p => p.id === projectId);

        if (project) {
          // Use the check-in template (includes auto-assignment)
          const templateData: CheckinData = {
            projectName: project.name,
            projectId: projectId,
            projectPath: project.path,
            currentTimestamp: new Date().toISOString()
          };

          checkInMessage = await this.promptTemplateService.getCheckinPrompt(templateData);
        } else {
          // Fallback to simplified version if project not found
          checkInMessage = `🔄 **15-Minute Project Check-in & Auto-Assignment**

**Project ID**: ${projectId}

**PHASE 1: PROJECT STATUS CHECK-IN**
1. Use the \`check_team_progress\` MCP tool with projectId: "${projectId}"
2. Review the team progress report and current task status
3. Identify any blockers, delays, or issues
4. Provide guidance and next steps to team members

**PHASE 2: AUTO-ASSIGNMENT**
1. Use \`get_team_status\` to find idle team members
2. Look for open tasks to assign to available members
3. Follow milestone-first assignment logic

Use: \`check_team_progress { "projectId": "${projectId}" }\``;
        }
      } else {
        // Fallback when no storage service
        checkInMessage = `🔄 **15-Minute Project Check-in & Auto-Assignment**

**Project ID**: ${projectId}

**PHASE 1: PROJECT STATUS CHECK-IN**
1. Use the \`check_team_progress\` MCP tool with projectId: "${projectId}"
2. Review the team progress report and current task status
3. Identify any blockers, delays, or issues
4. Provide guidance and next steps to team members

**PHASE 2: AUTO-ASSIGNMENT**
1. Use \`get_team_status\` to find idle team members
2. Look for open tasks to assign to available members
3. Follow milestone-first assignment logic

Use: \`check_team_progress { "projectId": "${projectId}" }\``;
      }
    } catch (error) {
      this.logger.warn('Failed to load unified check-in template, using fallback', { error: error instanceof Error ? error.message : String(error) });
      // Fallback message
      checkInMessage = `🔄 **15-Minute Project Check-in & Auto-Assignment**

**Project ID**: ${projectId}

**PHASE 1: PROJECT STATUS CHECK-IN**
1. Use the \`check_team_progress\` MCP tool with projectId: "${projectId}"
2. Review the team progress report and current task status
3. Identify any blockers, delays, or issues
4. Provide guidance and next steps to team members

**PHASE 2: AUTO-ASSIGNMENT**
1. Use \`get_team_status\` to find idle team members
2. Look for open tasks to assign to available members
3. Follow milestone-first assignment logic

Use: \`check_team_progress { "projectId": "${projectId}" }\``;
    }

    const scheduledMessage = ScheduledMessageModel.create({
      name: `Check-in for Project ${projectId}`,
      targetTeam: 'orchestrator',
      targetProject: projectId,
      message: checkInMessage,
      delayAmount: 15,
      delayUnit: 'minutes',
      isRecurring: true,
      isActive: true
    });

    if (this.storageService) {
      await this.storageService.saveScheduledMessage(scheduledMessage);
      messageSchedulerService?.scheduleMessage(scheduledMessage);
    }

    return scheduledMessage.id;
  }

  async cleanupStoppedProjects(olderThanDays: number = 7): Promise<number> {
    const data = await this.loadActiveProjectsData();
    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);

    const initialCount = data.activeProjects.length;
    
    data.activeProjects = data.activeProjects.filter(project => {
      if (project.status === 'stopped' && project.stoppedAt) {
        const stoppedDate = new Date(project.stoppedAt);
        return stoppedDate > cutoffDate;
      }
      return true; // Keep running projects and projects without stop date
    });

    await this.saveActiveProjectsData(data);
    
    return initialCount - data.activeProjects.length;
  }
}