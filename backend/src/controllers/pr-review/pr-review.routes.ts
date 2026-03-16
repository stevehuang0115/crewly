/**
 * PR Review Routes
 *
 * Router configuration for PR review webhook and management endpoints.
 *
 * @module controllers/pr-review/pr-review.routes
 */

import { Router } from 'express';
import { handleWebhook, triggerManualReview, getPrReviewStatus } from './pr-review.controller.js';

/**
 * Create the PR review router with webhook and management endpoints.
 *
 * Routes:
 * - POST /webhook — GitHub webhook receiver for PR events
 * - POST /review — Manually trigger a PR review
 * - GET /status — Get review service status
 *
 * @returns Express router for /api/pr-review routes
 */
export function createPrReviewRouter(): Router {
  const router = Router();

  // POST /api/pr-review/webhook — GitHub webhook receiver
  router.post('/webhook', handleWebhook);

  // POST /api/pr-review/review — Manual review trigger
  router.post('/review', triggerManualReview);

  // GET /api/pr-review/status — Service status
  router.get('/status', getPrReviewStatus);

  return router;
}
