/**
 * Harness routes — mounted at `/api/harness` (specs/onboarding-harness-login.md).
 *
 * @module controllers/harness/harness.routes
 */

import { Router } from 'express';
import type { HarnessService } from '../../services/harness/harness.service.js';
import { getHarnessService } from '../../services/harness/harness.service.js';
import { createHarnessController } from './harness.controller.js';

/**
 * Create the harness router.
 *
 * Routes (static paths are registered before `/:id/...` so they never match as ids):
 * - GET  /                          — statuses, orc harness, system tools
 * - GET  /install/:jobId            — install job progress
 * - PUT  /orc                       — choose the orchestrator harness { harnessId }
 * - POST /orc                       — the same, for the relay (portal / phone carry GET and POST only)
 * - GET  /login/:sessionId          — login session
 * - POST /login/:sessionId/input    — type the user's reply { text }
 * - POST /login/:sessionId/cancel   — cancel a login
 * - POST /:id/install               — start an install job
 * - POST /:id/login                 — start a broker login { method }
 * - POST /:id/api-key               — store an API key { key }
 *
 * @param getService - Service accessor (tests inject a fake)
 * @returns Express router for /api/harness
 */
export function createHarnessRouter(getService: () => HarnessService = getHarnessService): Router {
  const router = Router();
  const controller = createHarnessController(getService);
  router.get('/', controller.getOverview);
  router.get('/install/:jobId', controller.getInstallJob);
  router.put('/orc', controller.setOrcHarness);
  // POST twin: the relay (portal / phone) only carries GET and POST.
  router.post('/orc', controller.setOrcHarness);
  router.get('/login/:sessionId', controller.getLogin);
  router.post('/login/:sessionId/input', controller.inputLogin);
  router.post('/login/:sessionId/cancel', controller.cancelLogin);
  router.post('/:id/install', controller.startInstall);
  router.post('/:id/login', controller.startLogin);
  router.post('/:id/api-key', controller.submitApiKey);
  return router;
}
