/**
 * Routes for the owner receipt (#828), mounted at `/api/owner-receipt`.
 *
 * @module controllers/owner-receipt/owner-receipt.routes
 */

import { Router } from 'express';
import { getReceipt, getReceiptSettings, sendReceiptNow, updateReceiptSettings } from './owner-receipt.controller.js';

/**
 * Create the owner receipt router.
 *
 * Routes:
 * - GET  /           — receipt data + rendered text (`from`, `to`, `mode`)
 * - GET  /settings   — settings and last send
 * - PUT  /settings   — change time / zone / on-off (owner only)
 * - POST /settings   — the same, for the relay (GET and POST only)
 * - POST /send       — send now (owner only)
 *
 * @returns Express router
 */
export function createOwnerReceiptRouter(): Router {
  const router = Router();
  router.get('/', getReceipt);
  router.get('/settings', getReceiptSettings);
  router.put('/settings', updateReceiptSettings);
  router.post('/settings', updateReceiptSettings);
  router.post('/send', sendReceiptNow);
  return router;
}
