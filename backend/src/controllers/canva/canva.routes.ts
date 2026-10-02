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
import { getStatus, getConnectUrl, disconnect, setSharing, listDesigns, getDesign, createDesign, exportDesign, uploadAsset } from './canva.controller.js';

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
  // Who owns the grant and who it is shared with (issue #968; owner only)
  router.post('/sharing', setSharing);
  // Data routes only — see the note in google.routes.ts.
  router.use(requireConnectorAccess('canva'));
  router.get('/designs', listDesigns);
  router.get('/designs/:id', getDesign);
  router.post('/designs', createDesign);
  router.post('/designs/:id/export', exportDesign);
  router.post('/assets', uploadAsset);
  return router;
}
