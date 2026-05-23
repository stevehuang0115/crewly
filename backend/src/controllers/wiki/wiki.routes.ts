/**
 * Wiki REST Routes
 *
 * @module controllers/wiki/wiki.routes
 */

import { Router } from 'express';
import {
  ingest,
  queryVault,
  queueAdd,
  queueList,
  queueClaim,
  queueClaimNext,
  queueProcess,
  queueSkip,
  queueStats,
  bookkeep,
  bookkeepTriggerNow,
  listVaults,
  getVaultTree,
  getPage,
} from './wiki.controller.js';

/**
 * Creates the wiki router.
 *
 * Endpoints:
 * - POST /ingest                    Low-level write: append/promote into the vault
 * - POST /query                     Read: build system-context for caller's LLM
 *
 * Queue (Steve 2026-05-22 redesign — agents enqueue, agents process):
 * - POST /queue                     Agent enqueues wiki-worthy content + reason
 * - GET  /queue                     List items (filter by vaultPath/status/queuedBy)
 * - POST /queue/:id/claim           Agent claims a pending item
 * - POST /queue/:id/process         Agent commits classification (ingested + target)
 * - POST /queue/:id/skip            Agent marks item not-wiki-worthy with reason
 * - GET  /queue/stats               Status counts per vault
 */
export function createWikiRouter(): Router {
  const router = Router();
  router.post('/ingest', ingest);
  router.post('/query', queryVault);
  // Queue routes — order matters for /stats and /claim-next vs /:id paths.
  router.get('/queue/stats', queueStats);
  router.post('/queue/claim-next', queueClaimNext);
  router.post('/queue', queueAdd);
  router.get('/queue', queueList);
  router.post('/queue/:id/claim', queueClaim);
  router.post('/queue/:id/process', queueProcess);
  router.post('/queue/:id/skip', queueSkip);
  router.post('/bookkeep', bookkeep);
  router.post('/bookkeep/trigger-now', bookkeepTriggerNow);
  // Browse endpoints — power the /wiki UI.
  router.get('/vaults', listVaults);
  router.get('/tree', getVaultTree);
  router.get('/page', getPage);
  return router;
}
