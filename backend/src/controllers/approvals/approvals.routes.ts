/**
 * Approvals Routes
 *
 * Router configuration for tool approval management endpoints.
 *
 * @module controllers/approvals/approvals.routes
 */

import { Router } from 'express';
import { getPendingApprovals, approveRequest, rejectRequest, getAuditTrail } from './approvals.controller.js';

/**
 * Create the approvals router with pending, approve, reject, and audit endpoints.
 *
 * @returns Express router for /api/approvals routes
 */
export function createApprovalsRouter(): Router {
  const router = Router();

  // GET /api/approvals/pending — list pending approval requests
  router.get('/pending', getPendingApprovals);

  // GET /api/approvals/audit — retrieve the approval audit trail
  router.get('/audit', getAuditTrail);

  // POST /api/approvals/:id/approve — approve a pending request
  router.post('/:id/approve', approveRequest);

  // POST /api/approvals/:id/reject — reject a pending request
  router.post('/:id/reject', rejectRequest);

  return router;
}
