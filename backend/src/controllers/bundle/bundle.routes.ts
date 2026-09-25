/**
 * Solution bundle routes — mounted at `/api/bundles`.
 *
 * GET and POST only, so the phone / portal relay can carry them
 * (`MobileApiRelayService` allowlists `GET /bundles` and `POST /bundles/apply`).
 *
 * - GET  /                — ready bundles
 * - GET  /apply/:jobId    — apply progress (owner-only)
 * - POST /apply           — deploy { templateId, answers, runtime?, allowDraft? } (owner-only)
 * - GET  /:templateId     — questions, members, deployment on this machine
 *
 * @module controllers/bundle/bundle.routes
 */

import { Router } from 'express';
import type { BundleApplyService } from '../../services/bundle/bundle-apply.service.js';
import type { BundleCatalog } from '../../services/bundle/bundle-catalog.js';
import { getBundleApplyService, getBundleCatalog } from '../../services/bundle/bundle-apply.factory.js';
import { createBundleController } from './bundle.controller.js';

/**
 * Create the bundle router.
 *
 * @param getService - Engine accessor (tests inject a fake)
 * @param getCatalog - Catalog accessor (tests inject a fake)
 * @returns Express router
 */
export function createBundleRouter(
  getService: () => BundleApplyService = getBundleApplyService,
  getCatalog: () => Pick<BundleCatalog, 'list' | 'get'> = getBundleCatalog,
): Router {
  const router = Router();
  const controller = createBundleController({ service: getService, catalog: getCatalog });
  router.get('/', controller.list);
  router.get('/apply/:jobId', controller.getJob);
  router.post('/apply', controller.apply);
  router.get('/:templateId', controller.detail);
  return router;
}
