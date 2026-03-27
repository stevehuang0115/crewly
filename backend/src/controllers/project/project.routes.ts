import { Router } from 'express';
import type { ApiContext } from '../types.js';
import {
  createProject,
  getProjects,
  getProject,
  getProjectStatus,
  getProjectFiles,
  getFileContent,
  getProjectCompletion,
  deleteProject,
  getProjectContext,
  openProjectInFinder,
  createSpecFile,
  getSpecFileContent,
  getAgentmuxMarkdownFiles,
  saveMarkdownFile,
  startProject,
  stopProject,
  restartProject,
  assignTeamsToProject,
  unassignTeamFromProject,
  getProjectStats,
  getAlignmentStatus,
  continueWithMisalignment,
  handleSearch,
} from './project.controller.js';

// Import additional controllers for consolidated routes
import * as ticketHandlers from '../task-management/tickets.controller.js';
import * as gitHandlers from './git.controller.js';
import * as taskHandlers from '../task-management/tasks.controller.js';
import * as orchestratorHandlers from '../orchestrator/orchestrator.controller.js';

/**
 * Creates consolidated project router with all project-related endpoints
 *
 * This router includes:
 * - Core project CRUD operations and lifecycle management
 * - File and spec management
 * - Team assignment and project statistics
 * - Ticket management (CRUD, templates, subtasks)
 * - Task management from markdown files (milestones, status filtering)
 * - Git integration (status, commits, branches, pull requests)
 * - Legacy endpoint compatibility
 *
 * @param context - API context with services
 * @returns Express router configured with all consolidated project routes
 */
export function createProjectRouter(context: ApiContext): Router {
  const router = Router();

  // Project search (must be before /:id to avoid route collision)
  router.get('/search', handleSearch.bind(context));

  // Project CRUD operations
  router.post('/', createProject.bind(context));
  router.get('/', getProjects.bind(context));
  router.get('/:id', getProject.bind(context));
  router.delete('/:id', deleteProject.bind(context));

  // Project status and information
  router.get('/:id/status', getProjectStatus.bind(context));
  router.get('/:id/completion', getProjectCompletion.bind(context));
  router.get('/:id/context', getProjectContext.bind(context));
  router.get('/:id/stats', getProjectStats.bind(context));
  router.get('/:id/alignment-status', getAlignmentStatus.bind(context));
  router.post('/:id/continue-with-misalignment', continueWithMisalignment.bind(context));

  // Project lifecycle management
  router.post('/:id/start', startProject.bind(context));
  router.post('/:id/stop', stopProject.bind(context));
  router.post('/:id/restart', restartProject.bind(context));

  // Team assignment
  router.post('/:id/teams', assignTeamsToProject.bind(context));
  router.delete('/:id/teams', unassignTeamFromProject.bind(context));

  // File operations
  router.get('/:id/files', getProjectFiles.bind(context));
  router.get('/:projectId/file-content', getFileContent.bind(context));
  router.post('/:id/open-finder', openProjectInFinder.bind(context));

  // Spec file management
  router.post('/:id/specs', createSpecFile.bind(context));
  router.get('/:id/specs', getSpecFileContent.bind(context));

  // Markdown file operations
  router.get('/markdown-files', getAgentmuxMarkdownFiles.bind(context));
  router.post('/markdown-files', saveMarkdownFile.bind(context));

  // ============================================================
  // CONSOLIDATED ROUTES - Migrated from legacy projects.routes.ts
  // ============================================================

  // Project lifecycle with different endpoint patterns (legacy compatibility)
  router.post('/:id/assign-teams', assignTeamsToProject.bind(context));
  router.post('/:id/unassign-team', unassignTeamFromProject.bind(context));
  router.post('/:id/create-spec-file', createSpecFile.bind(context));
  router.get('/:id/spec-file-content', getSpecFileContent.bind(context));

  // Task assignment to orchestrator
  router.post('/:projectId/assign-task', (req, res) => {
    return orchestratorHandlers.assignTaskToOrchestrator.call(context, req, res);
  });

  // Ticket management routes
  router.post('/:projectId/tickets', (req, res) => {
    return ticketHandlers.createTicket.call(context, req, res);
  });
  router.get('/:projectId/tickets', (req, res) => {
    return ticketHandlers.getTickets.call(context, req, res);
  });
  router.get('/:projectId/tickets/:ticketId', (req, res) => {
    return ticketHandlers.getTicket.call(context, req, res);
  });
  router.put('/:projectId/tickets/:ticketId', (req, res) => {
    return ticketHandlers.updateTicket.call(context, req, res);
  });
  router.delete('/:projectId/tickets/:ticketId', (req, res) => {
    return ticketHandlers.deleteTicket.call(context, req, res);
  });
  router.post('/:projectId/tickets/:ticketId/subtasks', (req, res) => {
    return ticketHandlers.addSubtask.call(context, req, res);
  });
  router.patch('/:projectId/tickets/:ticketId/subtasks/:subtaskId/toggle', (req, res) => {
    return ticketHandlers.toggleSubtask.call(context, req, res);
  });

  // Task management routes (from markdown files)
  router.get('/:projectId/tasks', (req, res) => {
    return taskHandlers.getAllTasks.call(context, req, res);
  });
  router.get('/:projectId/milestones', (req, res) => {
    return taskHandlers.getMilestones.call(context, req, res);
  });
  router.get('/:projectId/tasks/status/:status', (req, res) => {
    return taskHandlers.getTasksByStatus.call(context, req, res);
  });
  router.get('/:projectId/tasks/milestone/:milestoneId', (req, res) => {
    return taskHandlers.getTasksByMilestone.call(context, req, res);
  });
  router.get('/:projectId/tasks-status', (req, res) => {
    return taskHandlers.getProjectTasksStatus.call(context, req, res);
  });

  // Ticket template routes
  router.post('/:projectId/ticket-templates/:templateName', (req, res) => {
    return ticketHandlers.createTicketTemplate.call(context, req, res);
  });
  router.get('/:projectId/ticket-templates', (req, res) => {
    return ticketHandlers.getTicketTemplates.call(context, req, res);
  });
  router.get('/:projectId/ticket-templates/:templateName', (req, res) => {
    return ticketHandlers.getTicketTemplate.call(context, req, res);
  });

  // Git integration routes
  router.get('/:projectId/git/status', (req, res) => {
    return gitHandlers.getGitStatus.call(context, req, res);
  });
  router.post('/:projectId/git/commit', (req, res) => {
    return gitHandlers.commitChanges.call(context, req, res);
  });
  router.post('/:projectId/git/auto-commit/start', (req, res) => {
    return gitHandlers.startAutoCommit.call(context, req, res);
  });
  router.post('/:projectId/git/auto-commit/stop', (req, res) => {
    return gitHandlers.stopAutoCommit.call(context, req, res);
  });
  router.get('/:projectId/git/history', (req, res) => {
    return gitHandlers.getCommitHistory.call(context, req, res);
  });
  router.post('/:projectId/git/branch', (req, res) => {
    return gitHandlers.createBranch.call(context, req, res);
  });
  router.post('/:projectId/git/pull-request', (req, res) => {
    return gitHandlers.createPullRequest.call(context, req, res);
  });

  // Legacy endpoint compatibility (files -> save-file)
  router.post('/save-file', saveMarkdownFile.bind(context));
  router.get('/files', getAgentmuxMarkdownFiles.bind(context));

  return router;
}