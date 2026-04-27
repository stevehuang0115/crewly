import { Request, Response } from 'express';
import type { ApiContext } from '../types.js';
import { TaskService } from '../../services/index.js';
import { ApiResponse } from '../../types/index.js';
import { LoggerService } from '../../services/core/logger.service.js';

const logger = LoggerService.getInstance().createComponentLogger('TasksController');

/**
 * Resolve the project record for `projectId` from storage.
 *
 * Distinguishes three cases for the caller, so each handler can map them
 * to the correct HTTP response without scattering `try/catch` ladders:
 *  - `{ kind: 'ok', project }`         — project found
 *  - `{ kind: 'not-found' }`           — projectId is unknown (→ 404)
 *  - `{ kind: 'storage-error', error }`— storage layer failed (→ 500)
 *
 * @param ctx - The ApiContext exposing the storage service
 * @param projectId - The project UUID from the URL params
 * @returns A discriminated lookup result
 */
async function resolveProject(
  ctx: ApiContext,
  projectId: string,
): Promise<
  | { kind: 'ok'; project: { id: string; path: string } }
  | { kind: 'not-found' }
  | { kind: 'storage-error'; error: unknown }
> {
  try {
    const projects = await ctx.storageService.getProjects();
    const project = projects.find((p) => p.id === projectId);
    if (!project) return { kind: 'not-found' };
    return { kind: 'ok', project };
  } catch (error) {
    return { kind: 'storage-error', error };
  }
}

/**
 * Build a graceful-degradation response for a TaskService failure.
 *
 * Returns 200 with `{ success: true, data: <empty>, warning }` so the
 * dashboard card stays alive instead of going red on a 500. The empty
 * value is supplied by the caller because shape varies per endpoint
 * (array vs status-summary object).
 *
 * Logs the underlying error at error-level so the failure is still
 * observable in backend logs and downstream alerting.
 *
 * @param res - Express response
 * @param emptyData - The shape-correct empty value for this endpoint
 * @param projectId - Project ID for log context
 * @param projectPath - Project path for log context
 * @param error - The underlying error from TaskService
 * @param contextLabel - Short label identifying which TaskService call failed
 */
function respondWithDegradation<T>(
  res: Response,
  emptyData: T,
  projectId: string,
  projectPath: string,
  error: unknown,
  contextLabel: string,
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`TaskService failure (${contextLabel}) — degrading to empty result`, {
    projectId,
    projectPath,
    error: message,
  });
  const warning = `Failed to load ${contextLabel} for project ${projectId}: ${message}`;
  res.json({ success: true, data: emptyData, warning } as ApiResponse<T>);
}

/**
 * GET /api/projects/:projectId/tasks
 *
 * Lists all tasks across all milestones for a project.
 *
 * Failure mapping:
 *  - 400 if `projectId` is missing
 *  - 404 if the project does not exist
 *  - 500 if the storage layer (projects.json) cannot be read
 *  - 200 + `warning` if TaskService throws (e.g. corrupt task file,
 *    permission denied on .crewly/tasks/) — graceful degradation so
 *    dashboard cards do not go red on per-project filesystem issues.
 *    The `data` array is empty in this case.
 *
 * @throws Never (errors are mapped to HTTP status codes)
 */
export async function getAllTasks(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;
  if (!projectId) {
    res.status(400).json({ success: false, error: 'Project ID is required' } as ApiResponse);
    return;
  }
  const lookup = await resolveProject(this, projectId);
  if (lookup.kind === 'not-found') {
    res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    return;
  }
  if (lookup.kind === 'storage-error') {
    logger.error('Error fetching projects from storage', {
      error: lookup.error instanceof Error ? lookup.error.message : String(lookup.error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch tasks' } as ApiResponse);
    return;
  }
  const { project } = lookup;
  try {
    const svc = new TaskService(project.path);
    const tasks = await svc.getAllTasks();
    res.json({ success: true, data: tasks } as ApiResponse);
  } catch (error) {
    respondWithDegradation(res, [], projectId, project.path, error, 'tasks');
  }
}

/**
 * GET /api/projects/:projectId/milestones
 *
 * Lists all milestones (with their nested tasks) for a project.
 * Same failure mapping as {@link getAllTasks}.
 */
export async function getMilestones(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;
  if (!projectId) {
    res.status(400).json({ success: false, error: 'Project ID is required' } as ApiResponse);
    return;
  }
  const lookup = await resolveProject(this, projectId);
  if (lookup.kind === 'not-found') {
    res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    return;
  }
  if (lookup.kind === 'storage-error') {
    logger.error('Error fetching projects from storage', {
      error: lookup.error instanceof Error ? lookup.error.message : String(lookup.error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch milestones' } as ApiResponse);
    return;
  }
  const { project } = lookup;
  try {
    const svc = new TaskService(project.path);
    const milestones = await svc.getMilestones();
    res.json({ success: true, data: milestones } as ApiResponse);
  } catch (error) {
    respondWithDegradation(res, [], projectId, project.path, error, 'milestones');
  }
}

/**
 * GET /api/projects/:projectId/tasks/by-status/:status
 *
 * Lists tasks for a project filtered by status.
 * Same failure mapping as {@link getAllTasks}.
 */
export async function getTasksByStatus(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { projectId, status } = req.params;
  if (!projectId) {
    res.status(400).json({ success: false, error: 'Project ID is required' } as ApiResponse);
    return;
  }
  const lookup = await resolveProject(this, projectId);
  if (lookup.kind === 'not-found') {
    res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    return;
  }
  if (lookup.kind === 'storage-error') {
    logger.error('Error fetching projects from storage', {
      error: lookup.error instanceof Error ? lookup.error.message : String(lookup.error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch tasks by status' } as ApiResponse);
    return;
  }
  const { project } = lookup;
  try {
    const svc = new TaskService(project.path);
    const tasks = await svc.getTasksByStatus(status);
    res.json({ success: true, data: tasks } as ApiResponse);
  } catch (error) {
    respondWithDegradation(res, [], projectId, project.path, error, 'tasks by status');
  }
}

/**
 * GET /api/projects/:projectId/tasks/by-milestone/:milestoneId
 *
 * Lists tasks for a project filtered by milestone.
 * Same failure mapping as {@link getAllTasks}.
 */
export async function getTasksByMilestone(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { projectId, milestoneId } = req.params;
  if (!projectId) {
    res.status(400).json({ success: false, error: 'Project ID is required' } as ApiResponse);
    return;
  }
  const lookup = await resolveProject(this, projectId);
  if (lookup.kind === 'not-found') {
    res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    return;
  }
  if (lookup.kind === 'storage-error') {
    logger.error('Error fetching projects from storage', {
      error: lookup.error instanceof Error ? lookup.error.message : String(lookup.error),
    });
    res.status(500).json({ success: false, error: 'Failed to fetch tasks by milestone' } as ApiResponse);
    return;
  }
  const { project } = lookup;
  try {
    const svc = new TaskService(project.path);
    const tasks = await svc.getTasksByMilestone(milestoneId);
    res.json({ success: true, data: tasks } as ApiResponse);
  } catch (error) {
    respondWithDegradation(res, [], projectId, project.path, error, 'tasks by milestone');
  }
}

/**
 * GET /api/projects/:projectId/tasks-status
 *
 * Returns a per-project summary of task counts (totals by status) plus the
 * project's milestones, used by dashboard cards.
 *
 * Failure mapping mirrors {@link getAllTasks}. The graceful-degradation
 * payload uses an empty status-summary shape: `{ totals: { all: 0 }, milestones: [] }`.
 */
export async function getProjectTasksStatus(this: ApiContext, req: Request, res: Response): Promise<void> {
  const { projectId } = req.params;
  if (!projectId) {
    res.status(400).json({ success: false, error: 'Project ID is required' } as ApiResponse);
    return;
  }
  const lookup = await resolveProject(this, projectId);
  if (lookup.kind === 'not-found') {
    res.status(404).json({ success: false, error: 'Project not found' } as ApiResponse);
    return;
  }
  if (lookup.kind === 'storage-error') {
    logger.error('Error fetching projects from storage', {
      error: lookup.error instanceof Error ? lookup.error.message : String(lookup.error),
    });
    res.status(500).json({ success: false, error: 'Failed to get project task status' } as ApiResponse);
    return;
  }
  const { project } = lookup;
  try {
    const svc = new TaskService(project.path);
    const [all, milestones] = await Promise.all([svc.getAllTasks(), svc.getMilestones()]);
    const byStatus = all.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1;
      return acc;
    }, {});
    res.json({
      success: true,
      data: { totals: { all: all.length, ...byStatus }, milestones },
    } as ApiResponse);
  } catch (error) {
    respondWithDegradation(
      res,
      { totals: { all: 0 }, milestones: [] },
      projectId,
      project.path,
      error,
      'project task status',
    );
  }
}
