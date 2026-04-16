/**
 * Content Approvals Routes
 *
 * Router for marketing content approval endpoints.
 * Separate from tool execution approvals at /api/approvals.
 *
 * @module controllers/content-approvals/content-approvals.routes
 */

import { Router } from 'express';
import {
  submitContentApproval,
  getPendingContentApprovals,
  getContentApproval,
  approveContentApproval,
  rejectContentApproval,
  getContentApprovalStats,
} from './content-approvals.controller.js';

/**
 * Create the content approvals router.
 *
 * @returns Express router for /api/content-approvals routes
 */
export function createContentApprovalsRouter(): Router {
  const router = Router();

  // POST /api/content-approvals — submit content for approval
  router.post('/', submitContentApproval);

  // GET /api/content-approvals/pending — list pending approvals
  router.get('/pending', getPendingContentApprovals);

  // GET /api/content-approvals/stats — get team approval stats
  router.get('/stats', getContentApprovalStats);

  // GET /api/content-approvals/:id — get a specific approval
  router.get('/:id', getContentApproval);

  // POST /api/content-approvals/:id/approve — approve content
  router.post('/:id/approve', approveContentApproval);

  // POST /api/content-approvals/:id/reject — reject content
  router.post('/:id/reject', rejectContentApproval);

  return router;
}
