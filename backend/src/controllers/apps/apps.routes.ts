/**
 * Crewly Apps routes — mounted at `/api/apps`. Owner or a verified agent
 * (badge / process tree) only (specs/2026-10-04-crewly-apps-p2.md §1).
 *
 * - POST   /publish                                — publish a bundle (find/create the app)
 * - GET    /                                       — apps this instance published
 * - POST   /:appId/rollback                        — `{ version }`
 * - GET    /:appId/versions                        — versions, newest first
 * - GET    /:appId/data/:collection                — `?limit&after`
 * - POST   /:appId/data/:collection                — add `{ data }`
 * - GET    /:appId/data/:collection/:docId         — one doc
 * - PUT    /:appId/data/:collection/:docId         — replace `{ data }`
 * - PATCH  /:appId/data/:collection/:docId         — merge `{ data, ifRev? }`
 * - DELETE /:appId/data/:collection/:docId         — delete
 *
 * @module controllers/apps/apps.routes
 */

import { Router } from 'express';
import { ownerOrVerifiedAgent } from '../../middleware/caller-identity.middleware.js';
import { publishApp, listApps, rollbackApp, listVersions, listDocs, addDoc, getDoc, setDoc, updateDoc, deleteDoc } from './apps.controller.js';

/**
 * Creates the Crewly Apps router.
 *
 * @returns Express router
 */
export function createAppsRouter(): Router {
  const router = Router();
  router.use(ownerOrVerifiedAgent('Crewly Apps'));
  router.post('/publish', publishApp);
  router.get('/', listApps);
  router.post('/:appId/rollback', rollbackApp);
  router.get('/:appId/versions', listVersions);
  router.get('/:appId/data/:collection', listDocs);
  router.post('/:appId/data/:collection', addDoc);
  router.get('/:appId/data/:collection/:docId', getDoc);
  router.put('/:appId/data/:collection/:docId', setDoc);
  router.patch('/:appId/data/:collection/:docId', updateDoc);
  router.delete('/:appId/data/:collection/:docId', deleteDoc);
  return router;
}
