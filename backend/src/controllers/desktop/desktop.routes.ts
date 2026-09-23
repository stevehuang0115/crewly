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
 * - GET  /remote        — is remote control allowed here?
 * - PUT  /remote        — allow / forbid it (this machine only, never over the network)
 * - POST /remote/frame  — the owner's live view (JPEG)
 * - POST /remote/input  — the owner's click / type / key / scroll
 *
 * @module controllers/desktop/desktop.routes
 */

import { Router } from 'express';
import { desktopAct, desktopLook, desktopStatus, desktopStop, desktopRemoteGet, desktopRemoteSet, desktopRemoteFrame, desktopRemoteInput } from './desktop.controller.js';

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
  router.get('/remote', desktopRemoteGet);
  router.put('/remote', desktopRemoteSet);
  router.post('/remote/frame', desktopRemoteFrame);
  router.post('/remote/input', desktopRemoteInput);
  return router;
}
