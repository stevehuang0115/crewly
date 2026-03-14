/**
 * Template REST Controller
 *
 * Exposes template operations via REST API for listing, inspecting,
 * and creating teams from team templates. Wraps the TemplateService
 * to provide HTTP endpoints for template management.
 *
 * @module controllers/template/template.controller
 */

import type { Request, Response } from 'express';
import { TemplateService } from '../../services/template/template.service.js';
import type { TemplateSummary } from '../../services/template/template.service.js';

/**
 * Wraps an async route handler with a standard try/catch that returns
 * a consistent JSON error response on unhandled exceptions.
 *
 * @param fn - The async handler function to wrap
 * @returns A wrapped handler that catches errors and responds with 500
 */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      await fn(req, res);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ success: false, error: msg });
    }
  };
}

/**
 * GET /api/templates - List all available team templates.
 *
 * Returns an array of template summaries including id, name,
 * description, category, role count, and version.
 *
 * Accepts optional query parameters:
 * - category: Filter by template category (development, content, research, operations, custom)
 *
 * @param req - Express request with optional query param: category
 * @param res - Express response returning { success, data: TemplateSummary[] }
 *
 * @example
 * ```
 * GET /api/templates
 * GET /api/templates?category=development
 * ```
 */
export const handleListTemplates = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const service = TemplateService.getInstance();
  let templates = service.listTemplates();

  const category = req.query.category as string | undefined;
  if (category) {
    templates = templates.filter((t: TemplateSummary) => t.category === category);
  }

  res.json({ success: true, data: templates });
});

/**
 * GET /api/templates/:id - Get a specific template by ID.
 *
 * Returns the full template definition including roles, verification
 * pipeline, and all configuration details.
 *
 * @param req - Express request with route param: id
 * @param res - Express response returning { success, data: TeamTemplate } or 404
 *
 * @example
 * ```
 * GET /api/templates/dev-fullstack
 * ```
 */
export const handleGetTemplate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const service = TemplateService.getInstance();
  const template = service.getTemplate(id);

  if (!template) {
    res.status(404).json({ success: false, error: `Template "${id}" not found` });
    return;
  }

  res.json({ success: true, data: template });
});

/**
 * POST /api/templates/:id/create-team - Create a team from a template.
 *
 * Generates a Team object with members based on the template's role
 * definitions, hierarchy configuration, and defaults. The created team
 * is returned but NOT persisted to storage — the caller should save it
 * via the teams API if desired.
 *
 * @param req - Express request with route param: id, body: { teamName, nameOverrides? }
 * @param res - Express response returning { success, data: CreateFromTemplateResult } or 404/400
 *
 * @example
 * ```
 * POST /api/templates/dev-fullstack/create-team
 * { "teamName": "Frontend Squad", "nameOverrides": { "team-leader": "Alice" } }
 * ```
 */
export const handleCreateTeamFromTemplate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { teamName, nameOverrides } = req.body as {
    teamName?: string;
    nameOverrides?: Record<string, string>;
  };

  if (!teamName || typeof teamName !== 'string' || teamName.trim().length === 0) {
    res.status(400).json({ success: false, error: 'teamName is required and must be a non-empty string' });
    return;
  }

  const service = TemplateService.getInstance();
  const result = service.createTeamFromTemplate(id, teamName.trim(), nameOverrides);

  if (!result) {
    res.status(404).json({ success: false, error: `Template "${id}" not found` });
    return;
  }

  res.status(201).json({ success: true, data: result });
});

/**
 * POST /api/templates/:id/deploy - Deploy a template: create team + save to storage (#184).
 *
 * Unlike create-team (which returns a team object without saving),
 * deploy creates the team, persists it to ~/.crewly/teams/, and
 * optionally assigns it to a project.
 *
 * @param req - Express request with template ID in params, teamName + projectId in body
 * @param res - Express response with created team data
 */
export const handleDeployTemplate = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { teamName, nameOverrides, projectId, defaultRuntime } = req.body as {
    teamName?: string;
    nameOverrides?: Record<string, string>;
    projectId?: string;
    defaultRuntime?: string;
  };

  if (!teamName || typeof teamName !== 'string' || teamName.trim().length === 0) {
    res.status(400).json({ success: false, error: 'teamName is required' });
    return;
  }

  const templateService = TemplateService.getInstance();
  const result = templateService.createTeamFromTemplate(id, teamName.trim(), nameOverrides);

  if (!result) {
    res.status(404).json({ success: false, error: `Template "${id}" not found` });
    return;
  }

  // Override runtime if specified (for crewly-pro/SMB deployments)
  if (defaultRuntime) {
    for (const member of result.team.members) {
      member.runtimeType = defaultRuntime as any;
    }
  }

  // Get template for mission/budget/qualityGate
  const template = templateService.getTemplate(id);
  if (template) {
    result.team.mission = (template as any).mission || result.team.description;
    result.team.budget = (template as any).budget;
    result.team.qualityGate = (template as any).qualityGate;
  }

  // Assign to project if specified
  if (projectId) {
    result.team.projectIds = [projectId];
  }

  // Generate session names for members
  const teamSlug = teamName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  for (const member of result.team.members) {
    const memberSlug = member.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    member.sessionName = `${teamSlug}-${memberSlug}-${member.id.slice(0, 8)}`;
  }

  // Save team to storage via API (StorageService)
  const { StorageService } = await import('../../services/core/storage.service.js');
  const storage = StorageService.getInstance();
  await storage.saveTeam(result.team);

  res.status(201).json({
    success: true,
    data: {
      ...result,
      deployed: true,
      message: `Team "${teamName}" deployed from template "${id}" with ${result.memberCount} members`,
    },
  });
});
