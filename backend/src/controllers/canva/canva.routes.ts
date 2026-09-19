/**
 * Canva routes — mounted at `/api/canva`.
 *
 * Everything after /disconnect is behind the connector's role allowlist.
 *
 * - GET    /status               — grant status
 * - GET    /connect-url          — Cloud consent-start URL
 * - DELETE /disconnect           — revoke + forget
 * - GET    /designs              — ?q=&ownership=&sort=&limit=&continuation=
 * - GET    /designs/:id          — one design
 * - POST   /designs              — { title?, preset?, width?, height?, assetId? }
 * - POST   /designs/:id/export   — { format, quality?, videoQuality?, pages? }
 * - POST   /assets               — { name, content: base64 }
 *
 * @module controllers/canva/canva.routes
 */

import { Router } from 'express';
import { requireConnectorAccess } from '../connector/connector.controller.js';
import { getStatus, getConnectUrl, disconnect, listDesigns, getDesign, createDesign, exportDesign, uploadAsset } from './canva.controller.js';

/**
 * Creates the Canva router.
 *
 * @returns Express router
 */
export function createCanvaRouter(): Router {
  const router = Router();
  router.get('/status', getStatus);
  router.get('/connect-url', getConnectUrl);
  router.delete('/disconnect', disconnect);
  // Data routes only — see the note in google.routes.ts.
  router.use(requireConnectorAccess('canva'));
  router.get('/designs', listDesigns);
  router.get('/designs/:id', getDesign);
  router.post('/designs', createDesign);
  router.post('/designs/:id/export', exportDesign);
  router.post('/assets', uploadAsset);
  return router;
}
