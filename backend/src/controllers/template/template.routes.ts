/**
 * Template REST Routes
 *
 * Router configuration for template-related endpoints. Provides REST
 * access to team templates for listing, inspecting, and creating teams.
 *
 * @module controllers/template/template.routes
 */

import { Router } from 'express';
import {
  handleListTemplates,
  handleGetTemplate,
  handleCreateTeamFromTemplate,
  handleDeployTemplate,
} from './template.controller.js';

/**
 * Creates the template router with all template endpoints.
 *
 * Endpoints:
 * - GET  /              - List all templates (optional ?category= filter)
 * - GET  /:id           - Get a specific template by ID
 * - POST /:id/create-team - Create a team from a template
 *
 * Note: Static routes are registered before parameterized routes
 * to prevent path conflicts.
 *
 * @returns Express router configured with template routes
 */
export function createTemplateRouter(): Router {
  const router = Router();

  // Static routes first
  router.get('/', handleListTemplates);

  // Parameterized routes
  router.get('/:id', handleGetTemplate);
  router.post('/:id/create-team', handleCreateTeamFromTemplate);
  router.post('/:id/deploy', handleDeployTemplate);

  return router;
}
