import { Request, Response } from 'express';
import {
  StorageService,
  TmuxService,
  SchedulerService,
  MessageSchedulerService,
  AgentRegistrationService
} from '../services/index.js';
import { ActiveProjectsService } from '../services/index.js';
import { PromptTemplateService } from '../services/index.js';
import { TaskAssignmentMonitorService } from '../services/index.js';

export class ApiController {
  public activeProjectsService: ActiveProjectsService;
  public promptTemplateService: PromptTemplateService;
  public taskAssignmentMonitor: TaskAssignmentMonitorService;
  public agentRegistrationService: AgentRegistrationService;

  constructor(
    public storageService: StorageService,
    public tmuxService: TmuxService,
    public schedulerService: SchedulerService,
    public messageSchedulerService?: MessageSchedulerService
  ) {
    this.activeProjectsService = new ActiveProjectsService(this.storageService);
    this.promptTemplateService = new PromptTemplateService();
    this.taskAssignmentMonitor = new TaskAssignmentMonitorService(this.tmuxService);

    // Create AgentRegistrationService using the public accessor method from TmuxService
    const tmuxCommand = this.tmuxService.getTmuxCommandService();
    this.agentRegistrationService = new AgentRegistrationService(
      tmuxCommand,
      process.cwd(),
      this.storageService
    );
  }

  // V1 Task Management methods removed per spec
  // 2026-05-06-task-management-v1-deprecation.md. All task lifecycle
  // operations now go through the V3 task-pool controller — see
  // backend/src/controllers/task-pool/task-pool.controller.ts.

  // Teams Methods
  public async createTeam(req: Request, res: Response): Promise<void> {
    const { createTeam } = await import('./team/team.controller.js');
    return createTeam.call(this, req, res);
  }

  public async getTeams(req: Request, res: Response): Promise<void> {
    const { getTeams } = await import('./team/team.controller.js');
    return getTeams.call(this, req, res);
  }

  public async getTeam(req: Request, res: Response): Promise<void> {
    const { getTeam } = await import('./team/team.controller.js');
    return getTeam.call(this, req, res);
  }

  public async startTeam(req: Request, res: Response): Promise<void> {
    const { startTeam } = await import('./team/team.controller.js');
    return startTeam.call(this, req, res);
  }

  public async stopTeam(req: Request, res: Response): Promise<void> {
    const { stopTeam } = await import('./team/team.controller.js');
    return stopTeam.call(this, req, res);
  }

  public async getTeamWorkload(req: Request, res: Response): Promise<void> {
    const { getTeamWorkload } = await import('./team/team.controller.js');
    return getTeamWorkload.call(this, req, res);
  }

  public async deleteTeam(req: Request, res: Response): Promise<void> {
    const { deleteTeam } = await import('./team/team.controller.js');
    return deleteTeam.call(this, req, res);
  }

  public async getTeamMemberSession(req: Request, res: Response): Promise<void> {
    const { getTeamMemberSession } = await import('./team/team.controller.js');
    return getTeamMemberSession.call(this, req, res);
  }

  public async addTeamMember(req: Request, res: Response): Promise<void> {
    const { addTeamMember } = await import('./team/team.controller.js');
    return addTeamMember.call(this, req, res);
  }

  public async updateTeamMember(req: Request, res: Response): Promise<void> {
    const { updateTeamMember } = await import('./team/team.controller.js');
    return updateTeamMember.call(this, req, res);
  }

  public async deleteTeamMember(req: Request, res: Response): Promise<void> {
    const { deleteTeamMember } = await import('./team/team.controller.js');
    return deleteTeamMember.call(this, req, res);
  }

  public async startTeamMember(req: Request, res: Response): Promise<void> {
    const { startTeamMember } = await import('./team/team.controller.js');
    return startTeamMember.call(this, req, res);
  }

  public async stopTeamMember(req: Request, res: Response): Promise<void> {
    const { stopTeamMember } = await import('./team/team.controller.js');
    return stopTeamMember.call(this, req, res);
  }

  public async reportMemberReady(req: Request, res: Response): Promise<void> {
    const { reportMemberReady } = await import('./team/team.controller.js');
    return reportMemberReady.call(this, req, res);
  }

  public async registerMemberStatus(req: Request, res: Response): Promise<void> {
    const { registerMemberStatus } = await import('./team/team.controller.js');
    return registerMemberStatus.call(this, req, res);
  }

  public async generateMemberContext(req: Request, res: Response): Promise<void> {
    const { generateMemberContext } = await import('./team/team.controller.js');
    return generateMemberContext.call(this, req, res);
  }

  public async injectContextIntoSession(req: Request, res: Response): Promise<void> {
    const { injectContextIntoSession } = await import('./team/team.controller.js');
    return injectContextIntoSession.call(this, req, res);
  }

  public async refreshMemberContext(req: Request, res: Response): Promise<void> {
    const { refreshMemberContext } = await import('./team/team.controller.js');
    return refreshMemberContext.call(this, req, res);
  }

  public async getTeamActivityStatus(req: Request, res: Response): Promise<void> {
    const { getTeamActivityStatus } = await import('./team/team.controller.js');
    return getTeamActivityStatus.call(this, req, res);
  }

  // Projects Methods
  public async createProject(req: Request, res: Response): Promise<void> {
    const { createProject } = await import('./project/project.controller.js');
    return createProject.call(this, req, res);
  }

  public async getProjects(req: Request, res: Response): Promise<void> {
    const { getProjects } = await import('./project/project.controller.js');
    return getProjects.call(this, req, res);
  }

  public async getProject(req: Request, res: Response): Promise<void> {
    const { getProject } = await import('./project/project.controller.js');
    return getProject.call(this, req, res);
  }

  public async getProjectStatus(req: Request, res: Response): Promise<void> {
    const { getProjectStatus } = await import('./project/project.controller.js');
    return getProjectStatus.call(this, req, res);
  }

  public async getProjectFiles(req: Request, res: Response): Promise<void> {
    const { getProjectFiles } = await import('./project/project.controller.js');
    return getProjectFiles.call(this, req, res);
  }

  public async getFileContent(req: Request, res: Response): Promise<void> {
    const { getFileContent } = await import('./project/project.controller.js');
    return getFileContent.call(this, req, res);
  }

  public async getProjectCompletion(req: Request, res: Response): Promise<void> {
    const { getProjectCompletion } = await import('./project/project.controller.js');
    return getProjectCompletion.call(this, req, res);
  }

  public async deleteProject(req: Request, res: Response): Promise<void> {
    const { deleteProject } = await import('./project/project.controller.js');
    return deleteProject.call(this, req, res);
  }

  public async getProjectContext(req: Request, res: Response): Promise<void> {
    const { getProjectContext } = await import('./project/project.controller.js');
    return getProjectContext.call(this, req, res);
  }

  public async openProjectInFinder(req: Request, res: Response): Promise<void> {
    const { openProjectInFinder } = await import('./project/project.controller.js');
    return openProjectInFinder.call(this, req, res);
  }

  public async createSpecFile(req: Request, res: Response): Promise<void> {
    const { createSpecFile } = await import('./project/project.controller.js');
    return createSpecFile.call(this, req, res);
  }

  public async getSpecFileContent(req: Request, res: Response): Promise<void> {
    const { getSpecFileContent } = await import('./project/project.controller.js');
    return getSpecFileContent.call(this, req, res);
  }

  public async getAgentmuxMarkdownFiles(req: Request, res: Response): Promise<void> {
    const { getAgentmuxMarkdownFiles } = await import('./project/project.controller.js');
    return getAgentmuxMarkdownFiles.call(this, req, res);
  }

  public async saveMarkdownFile(req: Request, res: Response): Promise<void> {
    const { saveMarkdownFile } = await import('./project/project.controller.js');
    return saveMarkdownFile.call(this, req, res);
  }

  public async startProject(req: Request, res: Response): Promise<void> {
    const { startProject } = await import('./project/project.controller.js');
    return startProject.call(this, req, res);
  }

  public async stopProject(req: Request, res: Response): Promise<void> {
    const { stopProject } = await import('./project/project.controller.js');
    return stopProject.call(this, req, res);
  }

  public async restartProject(req: Request, res: Response): Promise<void> {
    const { restartProject } = await import('./project/project.controller.js');
    return restartProject.call(this, req, res);
  }

  public async assignTeamsToProject(req: Request, res: Response): Promise<void> {
    const { assignTeamsToProject } = await import('./project/project.controller.js');
    return assignTeamsToProject.call(this, req, res);
  }

  public async unassignTeamFromProject(req: Request, res: Response): Promise<void> {
    const { unassignTeamFromProject } = await import('./project/project.controller.js');
    return unassignTeamFromProject.call(this, req, res);
  }

  // Tickets Methods
  public async createTicket(req: Request, res: Response): Promise<void> {
    const { createTicket } = await import('./task-management/tickets.controller.js');
    return createTicket.call(this, req, res);
  }

  public async getTickets(req: Request, res: Response): Promise<void> {
    const { getTickets } = await import('./task-management/tickets.controller.js');
    return getTickets.call(this, req, res);
  }

  public async getTicket(req: Request, res: Response): Promise<void> {
    const { getTicket } = await import('./task-management/tickets.controller.js');
    return getTicket.call(this, req, res);
  }

  public async updateTicket(req: Request, res: Response): Promise<void> {
    const { updateTicket } = await import('./task-management/tickets.controller.js');
    return updateTicket.call(this, req, res);
  }

  public async deleteTicket(req: Request, res: Response): Promise<void> {
    const { deleteTicket } = await import('./task-management/tickets.controller.js');
    return deleteTicket.call(this, req, res);
  }

  public async addSubtask(req: Request, res: Response): Promise<void> {
    const { addSubtask } = await import('./task-management/tickets.controller.js');
    return addSubtask.call(this, req, res);
  }

  public async toggleSubtask(req: Request, res: Response): Promise<void> {
    const { toggleSubtask } = await import('./task-management/tickets.controller.js');
    return toggleSubtask.call(this, req, res);
  }

  public async createTicketTemplate(req: Request, res: Response): Promise<void> {
    const { createTicketTemplate } = await import('./task-management/tickets.controller.js');
    return createTicketTemplate.call(this, req, res);
  }

  public async getTicketTemplates(req: Request, res: Response): Promise<void> {
    const { getTicketTemplates } = await import('./task-management/tickets.controller.js');
    return getTicketTemplates.call(this, req, res);
  }

  public async getTicketTemplate(req: Request, res: Response): Promise<void> {
    const { getTicketTemplate } = await import('./task-management/tickets.controller.js');
    return getTicketTemplate.call(this, req, res);
  }

  // Git Methods
  public async getGitStatus(req: Request, res: Response): Promise<void> {
    const { getGitStatus } = await import('./project/git.controller.js');
    return getGitStatus.call(this, req, res);
  }

  public async commitChanges(req: Request, res: Response): Promise<void> {
    const { commitChanges } = await import('./project/git.controller.js');
    return commitChanges.call(this, req, res);
  }

  public async startAutoCommit(req: Request, res: Response): Promise<void> {
    const { startAutoCommit } = await import('./project/git.controller.js');
    return startAutoCommit.call(this, req, res);
  }

  public async stopAutoCommit(req: Request, res: Response): Promise<void> {
    const { stopAutoCommit } = await import('./project/git.controller.js');
    return stopAutoCommit.call(this, req, res);
  }

  public async getCommitHistory(req: Request, res: Response): Promise<void> {
    const { getCommitHistory } = await import('./project/git.controller.js');
    return getCommitHistory.call(this, req, res);
  }

  public async createBranch(req: Request, res: Response): Promise<void> {
    const { createBranch } = await import('./project/git.controller.js');
    return createBranch.call(this, req, res);
  }

  public async createPullRequest(req: Request, res: Response): Promise<void> {
    const { createPullRequest } = await import('./project/git.controller.js');
    return createPullRequest.call(this, req, res);
  }

  // Orchestrator Methods
  public async getOrchestratorCommands(req: Request, res: Response): Promise<void> {
    const { getOrchestratorCommands } = await import('./orchestrator/orchestrator.controller.js');
    return getOrchestratorCommands.call(this, req, res);
  }

  public async executeOrchestratorCommand(req: Request, res: Response): Promise<void> {
    const { executeOrchestratorCommand } = await import('./orchestrator/orchestrator.controller.js');
    return executeOrchestratorCommand.call(this, req, res);
  }

  public async sendOrchestratorMessage(req: Request, res: Response): Promise<void> {
    const { sendOrchestratorMessage } = await import('./orchestrator/orchestrator.controller.js');
    return sendOrchestratorMessage.call(this, req, res);
  }

  public async sendOrchestratorEnter(req: Request, res: Response): Promise<void> {
    const { sendOrchestratorEnter } = await import('./orchestrator/orchestrator.controller.js');
    return sendOrchestratorEnter.call(this, req, res);
  }

  public async setupOrchestrator(req: Request, res: Response): Promise<void> {
    const { setupOrchestrator } = await import('./orchestrator/orchestrator.controller.js');
    return setupOrchestrator.call(this, req, res);
  }

  public async getOrchestratorHealth(req: Request, res: Response): Promise<void> {
    const { getOrchestratorHealth } = await import('./orchestrator/orchestrator.controller.js');
    return getOrchestratorHealth.call(this, req, res);
  }

  public async assignTaskToOrchestrator(req: Request, res: Response): Promise<void> {
    const { assignTaskToOrchestrator } = await import('./orchestrator/orchestrator.controller.js');
    return assignTaskToOrchestrator.call(this, req, res);
  }

  // Scheduler Methods
  public async scheduleCheck(req: Request, res: Response): Promise<void> {
    const { scheduleCheck } = await import('./system/scheduler.controller.js');
    return scheduleCheck.call(this, req, res);
  }

  public async getScheduledChecks(req: Request, res: Response): Promise<void> {
    const { getScheduledChecks } = await import('./system/scheduler.controller.js');
    return getScheduledChecks.call(this, req, res);
  }

  public async cancelScheduledCheck(req: Request, res: Response): Promise<void> {
    const { cancelScheduledCheck } = await import('./system/scheduler.controller.js');
    return cancelScheduledCheck.call(this, req, res);
  }

  // Terminal Methods
  public async listTerminalSessions(req: Request, res: Response): Promise<void> {
    const { listTerminalSessions } = await import('./monitoring/terminal.controller.js');
    return listTerminalSessions.call(this, req, res);
  }

  public async captureTerminal(req: Request, res: Response): Promise<void> {
    const { captureTerminal } = await import('./monitoring/terminal.controller.js');
    return captureTerminal.call(this, req, res);
  }

  public async sendTerminalInput(req: Request, res: Response): Promise<void> {
    const { sendTerminalInput } = await import('./monitoring/terminal.controller.js');
    return sendTerminalInput.call(this, req, res);
  }

  public async sendTerminalKey(req: Request, res: Response): Promise<void> {
    const { sendTerminalKey } = await import('./monitoring/terminal.controller.js');
    return sendTerminalKey.call(this, req, res);
  }

  // Errors Methods
  public async trackError(req: Request, res: Response): Promise<void> {
    const { trackError } = await import('./system/errors.controller.js');
    return trackError.call(this, req, res);
  }

  public async getErrorStats(req: Request, res: Response): Promise<void> {
    const { getErrorStats } = await import('./system/errors.controller.js');
    return getErrorStats.call(this, req, res);
  }

  public async getErrors(req: Request, res: Response): Promise<void> {
    const { getErrors } = await import('./system/errors.controller.js');
    return getErrors.call(this, req, res);
  }

  public async getError(req: Request, res: Response): Promise<void> {
    const { getError } = await import('./system/errors.controller.js');
    return getError.call(this, req, res);
  }

  public async clearErrors(req: Request, res: Response): Promise<void> {
    const { clearErrors } = await import('./system/errors.controller.js');
    return clearErrors.call(this, req, res);
  }

  // Scheduled Messages Methods
  public async createScheduledMessage(req: Request, res: Response): Promise<void> {
    const { createScheduledMessage } = await import('./messaging/scheduled-messages.controller.js');
    return createScheduledMessage.call(this, req, res);
  }

  public async getScheduledMessages(req: Request, res: Response): Promise<void> {
    const { getScheduledMessages } = await import('./messaging/scheduled-messages.controller.js');
    return getScheduledMessages.call(this, req, res);
  }

  public async getScheduledMessage(req: Request, res: Response): Promise<void> {
    const { getScheduledMessage } = await import('./messaging/scheduled-messages.controller.js');
    return getScheduledMessage.call(this, req, res);
  }

  public async updateScheduledMessage(req: Request, res: Response): Promise<void> {
    const { updateScheduledMessage } = await import('./messaging/scheduled-messages.controller.js');
    return updateScheduledMessage.call(this, req, res);
  }

  public async deleteScheduledMessage(req: Request, res: Response): Promise<void> {
    const { deleteScheduledMessage } = await import('./messaging/scheduled-messages.controller.js');
    return deleteScheduledMessage.call(this, req, res);
  }

  public async toggleScheduledMessage(req: Request, res: Response): Promise<void> {
    const { toggleScheduledMessage } = await import('./messaging/scheduled-messages.controller.js');
    return toggleScheduledMessage.call(this, req, res);
  }

  public async runScheduledMessage(req: Request, res: Response): Promise<void> {
    const { runScheduledMessage } = await import('./messaging/scheduled-messages.controller.js');
    return runScheduledMessage.call(this, req, res);
  }

  // Delivery Logs Methods
  public async getDeliveryLogs(req: Request, res: Response): Promise<void> {
    const { getDeliveryLogs } = await import('./messaging/delivery-logs.controller.js');
    return getDeliveryLogs.call(this, req, res);
  }

  public async clearDeliveryLogs(req: Request, res: Response): Promise<void> {
    const { clearDeliveryLogs } = await import('./messaging/delivery-logs.controller.js');
    return clearDeliveryLogs.call(this, req, res);
  }

  // Config Files Methods
  public async getConfigFile(req: Request, res: Response): Promise<void> {
    const { getConfigFile } = await import('./system/config.controller.js');
    return getConfigFile.call(this, req, res);
  }

  // Project Tasks Methods
  public async getAllTasks(req: Request, res: Response): Promise<void> {
    const { getAllTasks } = await import('./task-management/tasks.controller.js');
    return getAllTasks.call(this, req, res);
  }

  public async getMilestones(req: Request, res: Response): Promise<void> {
    const { getMilestones } = await import('./task-management/tasks.controller.js');
    return getMilestones.call(this, req, res);
  }

  public async getTasksByStatus(req: Request, res: Response): Promise<void> {
    const { getTasksByStatus } = await import('./task-management/tasks.controller.js');
    return getTasksByStatus.call(this, req, res);
  }

  public async getTasksByMilestone(req: Request, res: Response): Promise<void> {
    const { getTasksByMilestone } = await import('./task-management/tasks.controller.js');
    return getTasksByMilestone.call(this, req, res);
  }

  public async getProjectTasksStatus(req: Request, res: Response): Promise<void> {
    const { getProjectTasksStatus } = await import('./task-management/tasks.controller.js');
    return getProjectTasksStatus.call(this, req, res);
  }
}
