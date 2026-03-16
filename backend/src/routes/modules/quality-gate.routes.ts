/**
 * Quality Gate REST Routes
 *
 * Router configuration for quality gate endpoints. Provides REST access
 * to the QualityGateService for orchestrator bash skills to run quality
 * checks before task completion.
 *
 * @module routes/modules/quality-gate.routes
 */

import { Router } from 'express';
import { checkQualityGates, preCommitGate } from '../../controllers/quality-gate/quality-gate.controller.js';

/**
 * Creates the quality gate router with all quality gate endpoints.
 *
 * Endpoints:
 * - POST /check       - Run quality gates against a project directory
 * - POST /pre-commit  - Pre-commit hook norm verification
 *
 * @returns Express router configured with quality gate routes
 */
export function createQualityGateRouter(): Router {
  const router = Router();

  router.post('/check', checkQualityGates);
  router.post('/pre-commit', preCommitGate);

  return router;
}
