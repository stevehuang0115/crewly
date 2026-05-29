/**
 * Task Pool Routes
 *
 * Router configuration for Task Pool API endpoints.
 *
 * @module controllers/task-pool/task-pool.routes
 */

import { Router } from 'express';
import {
  addItem,
  listAvailable,
  listAllItems,
  claimItem,
  releaseItem,
  completeItem,
  blockItem,
  failItemHandler,
  cancelQueuedItem,
  getStats,
  heartbeat,
  extendLease,
  scanExpired,
  revokeAndRelease,
  deleteItem,
  getItem,
  setItemOutput,
  handoffItem,
  appendItemNote,
} from './task-pool.controller.js';

/**
 * Creates the task pool router with all endpoints.
 *
 * @returns Express router configured with task pool routes
 */
export function createTaskPoolRouter(): Router {
  const router = Router();

  // Pool statistics (must be before parameterized routes)
  router.get('/stats', getStats);

  // Scan for expired claims
  router.get('/claims/expired', scanExpired);

  // List available work items
  router.get('/', listAvailable);

  // Alias: /all returns the same list (used by frontend Execution Logs page)
  router.get('/all', listAvailable);

  // P1 1ffffb84(a) — admin/cleanup audit surface. Returns ALL items
  // regardless of status (cancelled, done_by_worker, failed, etc.).
  // Distinct from `/all` which returns only the available subset.
  router.get('/items', listAllItems);

  // Add a work item to the pool
  router.post('/add', addItem);

  // Claim a work item
  router.post('/claim', claimItem);

  // Agent heartbeat for active claim
  router.post('/heartbeat', heartbeat);

  // Extend lease on a claim
  router.post('/extend-lease', extendLease);

  // Release a work item back to pool
  router.post('/release/:workItemId', releaseItem);

  // Complete a work item (V3.1 — agent-reported completion with token usage)
  router.post('/complete/:workItemId', completeItem);

  // Block a work item (V3.1 — agent-reported blocked state)
  router.post('/block/:workItemId', blockItem);

  // Fail a work item (V3.1 — agent-reported failure)
  router.post('/fail/:workItemId', failItemHandler);

  // Revoke a claim and release work item
  router.post('/revoke/:claimId', revokeAndRelease);

  // P1 1ffffb84(a) — bulk-DELETE entry. Idempotent on missing id; returns
  // 409 with structured payload when the WI is claimed and `?force=1` is
  // not supplied.
  router.delete('/:workItemId', deleteItem);

  // V3 single-item surface (replaces v1 task-management read/output/handoff/sync).
  // See spec/2026-05-06-task-management-v1-deprecation.md.
  router.get('/items/:workItemId', getItem);
  router.post('/items/:workItemId/output', setItemOutput);
  router.post('/items/:workItemId/handoff', handoffItem);
  router.post('/items/:workItemId/notes', appendItemNote);
  // #609: clean queued→cancelled transition for stuck WIs. Uses
  // `cancelQueued` (queued/blocked/scheduled → cancelled). Distinct
  // from DELETE which is a hard purge.
  router.post('/items/:workItemId/cancel', cancelQueuedItem);

  return router;
}
