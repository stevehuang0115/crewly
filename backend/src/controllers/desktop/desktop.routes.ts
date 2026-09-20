/**
 * Desktop control routes, mounted at `/api/desktop`.
 *
 * Mirrors the shape of `/api/browser/*` so the two reachable surfaces of a
 * machine look the same from outside.
 *
 * - GET  /status  — usable? busy? paused? stopped?
 * - POST /look    — read the screen (snapshot, ocr, screenshot, displays…)
 * - POST /act     — move the mouse or keyboard
 * - POST /stop    — halt everything, or `{resume:true}` to lift it
 *
 * @module controllers/desktop/desktop.routes
 */

import { Router } from 'express';
import { desktopAct, desktopLook, desktopStatus, desktopStop } from './desktop.controller.js';

/**
 * Build the desktop router.
 *
 * @returns Express router
 */
export function createDesktopRouter(): Router {
  const router = Router();
  router.get('/status', desktopStatus);
  router.post('/look', desktopLook);
  router.post('/act', desktopAct);
  // Stopping is never gated: an owner taking their machine back must not be
  // able to be refused by the thing they are taking it back from.
  router.post('/stop', desktopStop);
  return router;
}
