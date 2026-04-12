import { Router } from 'express';
import type { ApiContext } from './types.js';

// Import route creators
import { createProjectRouter } from './project/project.routes.js';
import { createTeamRouter } from './team/team.routes.js';
import { createOrchestratorRouter } from './orchestrator/orchestrator.routes.js';
import { createMonitoringRouter } from './monitoring/monitoring.routes.js';
import { createSystemRouter } from './system/system.routes.js';
import { createSessionRouter } from './session/session.routes.js';
import { createSettingsRouter } from './settings/index.js';
import { createChatRouter } from './chat/index.js';
import { createSkillRouter } from './skill/index.js';
import { createSlackRouter } from './slack/index.js';
import { createWhatsAppRouter } from './whatsapp/index.js';
import { createUserRouter } from './user/user.routes.js';
import { createOAuthRouter } from './oauth/oauth.routes.js';
import { createMessengerRouter } from './messaging/messenger.routes.js';
import { selfImprovementRouter } from './self-improvement/index.js';
import { createMemoryRouter } from './memory/index.js';
import { createWorkspaceRouter } from './workspace/workspace.routes.js';
import { createAgentStreamRouter } from './agent-stream/agent-stream.routes.js';

/**
 * Creates the main API router that aggregates all feature routers.
 *
 * NOTE: Intent-task routes are registered in api.routes.ts (not here)
 * to avoid duplicate registration.
 *
 * @param context - API context with services
 * @returns Express router configured with all API routes
 */
export function createApiRouter(context: ApiContext): Router {
  const router = Router();

  // Mount feature routers
  router.use('/projects', createProjectRouter(context));
  router.use('/teams', createTeamRouter(context));
  router.use('/orchestrator', createOrchestratorRouter(context));
  router.use('/monitoring', createMonitoringRouter(context));
  router.use('/system', createSystemRouter(context));
  router.use('/sessions', createSessionRouter(context));
  router.use('/settings', createSettingsRouter(context));
  router.use('/chat', createChatRouter(context));
  router.use('/skills', createSkillRouter());
  router.use('/slack', createSlackRouter());
  router.use('/whatsapp', createWhatsAppRouter());
  router.use('/users', createUserRouter());
  router.use('/oauth', createOAuthRouter());
  router.use('/messengers', createMessengerRouter());
  router.use('/self-improvement', selfImprovementRouter);
  router.use('/memory', createMemoryRouter());
  router.use('/workspace', createWorkspaceRouter());
  router.use('/agents', createAgentStreamRouter());

  return router;
}

// Export types for external usage
export type { ApiContext } from './types.js';
