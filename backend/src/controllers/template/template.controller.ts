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
import { CloudClientService } from '../../services/cloud/cloud-client.service.js';
import { SkillTierService } from '../../services/skill/skill-tier.service.js';
import { StorageService } from '../../services/core/storage.service.js';
import { asyncHandler } from '../../utils/async-handler.js';
import type { CloudTier } from '../../constants.js';

/**
 * Resolves the current user's cloud tier from CloudClientService.
 *
 * @returns The current subscription tier (defaults to 'free' if not connected)
 */
function getCurrentTier(): CloudTier {
  return CloudClientService.getInstance().getTier();
}

/**
 * Checks if the current user's tier is sufficient for a template's required tier.
 * Sends a 403 response if insufficient.
 *
 * @param requiredTier - The tier required by the template
 * @param userTier - The user's current tier
 * @param templateName - Template name for error messages
 * @param res - Express response to write 403 to
 * @returns true if tier is sufficient, false if 403 was sent
 */
function checkTierOrReject(requiredTier: string | undefined, userTier: CloudTier, templateName: string, res: Response): boolean {
  if (!requiredTier) return true;
  const tierService = SkillTierService.getInstance();
  if (tierService.isTierSufficient(userTier, requiredTier as CloudTier)) return true;
  res.status(403).json({
    success: false,
    error: `Template "${templateName}" requires ${requiredTier} plan. Current plan: ${userTier}. Upgrade at https://crewlyai.com/pricing`,
  });
  return false;
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

  // Annotate templates with tier accessibility for the current user
  const userTier = getCurrentTier();
  const tierService = SkillTierService.getInstance();
  const annotated = templates.map((t: TemplateSummary) => ({
    ...t,
    accessible: !t.requiredTier || tierService.isTierSufficient(userTier, t.requiredTier as CloudTier),
  }));

  res.json({ success: true, data: annotated });
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
  const userTier = getCurrentTier();

  // Pre-check tier before calling service to avoid relying on thrown errors
  const template = service.getTemplate(id);
  if (!template) {
    res.status(404).json({ success: false, error: `Template "${id}" not found` });
    return;
  }
  if (!checkTierOrReject(template.requiredTier, userTier, template.name, res)) return;

  const result = service.createTeamFromTemplate(id, teamName.trim(), nameOverrides, userTier)!;

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
  const userTier = getCurrentTier();

  // Pre-check tier before calling service
  const template = templateService.getTemplate(id);
  if (!template) {
    res.status(404).json({ success: false, error: `Template "${id}" not found` });
    return;
  }
  if (!checkTierOrReject(template.requiredTier, userTier, template.name, res)) return;

  const result = templateService.createTeamFromTemplate(id, teamName.trim(), nameOverrides, userTier)!;

  // Override runtime if specified (for crewly-pro/SMB deployments)
  if (defaultRuntime) {
    for (const member of result.team.members) {
      member.runtimeType = defaultRuntime as any;
    }
  }

  // Copy mission/budget/qualityGate from template to team
  result.team.mission = (template as any).mission || result.team.description;
  result.team.budget = (template as any).budget;
  result.team.qualityGate = (template as any).qualityGate;

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

  // Save team to storage
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
