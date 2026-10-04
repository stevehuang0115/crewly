/**
 * Crewly Apps routes — mounted at `/api/apps`. Owner or a verified agent
 * (badge / process tree) only (specs/2026-10-04-crewly-apps-p2.md §1).
 *
 * - POST   /publish                                — publish a bundle (find/create the app)
 * - GET    /                                       — apps of the caller (owner: all)
 * - POST   /:appId/rollback                        — `{ version }`
 * - GET    /:appId/versions                        — versions, newest first
 * - GET    /:appId/data/:collection                — `?limit&after`
 * - POST   /:appId/data/:collection                — add `{ data }`
 * - GET    /:appId/data/:collection/:docId         — one doc
 * - PUT    /:appId/data/:collection/:docId         — replace `{ data }`
 * - PATCH  /:appId/data/:collection/:docId         — merge `{ data, ifRev? }`
 * - DELETE /:appId/data/:collection/:docId         — delete
 *
 * The publish body is skipped by the app-wide parsers (index.ts) and parsed
 * here, after the caller check, so an unauthenticated client cannot make the
 * server buffer a large body.
 *
 * @module controllers/apps/apps.routes
 */

import express, { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ownerOrVerifiedAgent } from '../../middleware/caller-identity.middleware.js';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { publishApp, listApps, rollbackApp, listVersions, listDocs, addDoc, getDoc, setDoc, updateDoc, deleteDoc } from './apps.controller.js';

const C = CREWLY_APPS_CONSTANTS;

/**
 * The declared body size, or null when the request does not say.
 *
 * @param req - Request
 * @returns Bytes or null
 */
function declaredLength(req: Request): number | null {
  const raw = req.headers['content-length'];
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The caller gate. A refused request that declares a large body is answered
 * with `Connection: close`, so the server stops receiving the upload rather
 * than draining it.
 *
 * @param gate - The identity gate
 * @returns Middleware
 */
export function gateClosingLargeRejects(gate: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const large = (declaredLength(req) ?? 0) > C.PUBLISH_CLOSE_ABOVE_BYTES || req.headers['transfer-encoding'] !== undefined;
    if (large) res.setHeader('Connection', 'close');
    gate(req, res, (err?: unknown) => {
      if (large) res.removeHeader('Connection');
      next(err);
    });
  };
}

/**
 * Refuse a publish whose declared size is over the limit before reading it.
 *
 * @param req - Request
 * @param res - Response
 * @param next - Next
 */
export function rejectOversizedPublish(req: Request, res: Response, next: NextFunction): void {
  const n = declaredLength(req);
  if (n !== null && n > C.PUBLISH_BODY_MAX_BYTES) {
    res.setHeader('Connection', 'close');
    res.status(413).json({ success: false, error: 'too_large', message: `A publish can be at most ${C.PUBLISH_BODY_LIMIT}.` });
    return;
  }
  next();
}

/**
 * Creates the Crewly Apps router.
 *
 * @returns Express router
 */
export function createAppsRouter(): Router {
  const router = Router();
  router.use(gateClosingLargeRejects(ownerOrVerifiedAgent('Crewly Apps')));
  router.post('/publish', rejectOversizedPublish, express.json({ limit: C.PUBLISH_BODY_LIMIT }), publishApp);
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
