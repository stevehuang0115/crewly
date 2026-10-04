/**
 * Crewly Apps controller — `/api/apps/*` on this instance.
 *
 * Agents publish apps and read/write their data here; this backend calls
 * Crewly Cloud with the token it holds, so agents never touch it
 * (specs/2026-10-04-crewly-apps-p2.md §1). Backs the publish-app and
 * app-data skills.
 *
 * @module controllers/apps/apps.controller
 */

import type { Request, Response } from 'express';
import { LoggerService } from '../../services/core/logger.service.js';
import { callerAgentSession } from '../../middleware/caller-identity.middleware.js';
import { AppsCloudError } from '../../services/apps/apps-cloud.client.js';
import { getAppsParts } from '../../services/apps/apps.wiring.js';
import type { AppsCaller } from '../../services/apps/apps.service.js';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';

const logger = LoggerService.getInstance().createComponentLogger('AppsController');

/**
 * Who is calling: the verified agent session, or the owner.
 *
 * @param req - Request (already through `ownerOrVerifiedAgent`)
 * @returns Caller
 */
function callerOf(req: Request): AppsCaller {
  const session = callerAgentSession(req);
  return session ? { agentSession: session } : {};
}

/**
 * Answer a failure as `{ success:false, error, message, hint? }`.
 *
 * @param res - Response
 * @param err - The failure
 */
export function sendAppsError(res: Response, err: unknown): void {
  if (err instanceof AppsCloudError) {
    const hint =
      err.code === CREWLY_APPS_CONSTANTS.ERROR_CODES.NOT_LOGGED_IN
        ? 'Ask the owner to sign this machine in to Crewly Cloud (`crewly cloud login`).'
        : err.code === 'not_found'
          ? 'No such app, document or version for this account.'
          : undefined;
    res.status(err.status).json({ success: false, error: err.code, message: err.message, ...(hint ? { hint } : {}) });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Unexpected Crewly Apps failure', { error: message });
  res.status(500).json({ success: false, error: 'internal', message: 'Crewly Apps failed unexpectedly; check the backend log.' });
}

/**
 * Wrap a handler: run it, answer `{ success:true, data }`, map errors.
 *
 * @param fn - Produces the data
 * @param status - Success status
 * @returns Express handler
 */
function handle(fn: (req: Request, caller: AppsCaller) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const data = await fn(req, callerOf(req));
      res.status(status).json({ success: true, data });
    } catch (err) {
      sendAppsError(res, err);
    }
  };
}

const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};

/** POST /api/apps/publish */
export const publishApp = handle(async (req, caller) => {
  const b = body(req);
  const result = await getAppsParts().service.publish(
    { files: b.files, name: b.name, appId: b.appId, source: b.source, entry: b.entry, note: b.note, notify: b.notify },
    caller,
  );
  logger.info('App published', { appId: result.appId, version: result.version, created: result.created, agent: caller.agentSession ?? 'owner' });
  return result;
});

/** POST /api/apps/:appId/rollback `{ version }` */
export const rollbackApp = handle((req, caller) => getAppsParts().service.rollback(req.params.appId, body(req).version, caller));

/** GET /api/apps — apps this instance published */
export const listApps = handle(() => getAppsParts().service.list());

/** GET /api/apps/:appId/versions */
export const listVersions = handle((req, caller) => getAppsParts().service.versions(req.params.appId, caller));

/** GET /api/apps/:appId/data/:collection?limit&after */
export const listDocs = handle((req, caller) =>
  getAppsParts().service.listDocs(req.params.appId, req.params.collection, { limit: req.query.limit, after: req.query.after }, caller),
);

/** POST /api/apps/:appId/data/:collection `{ data }` */
export const addDoc = handle((req, caller) => getAppsParts().service.addDoc(req.params.appId, req.params.collection, body(req).data, caller), 201);

/** GET /api/apps/:appId/data/:collection/:docId */
export const getDoc = handle((req, caller) => getAppsParts().service.getDoc(req.params.appId, req.params.collection, req.params.docId, caller));

/** PUT /api/apps/:appId/data/:collection/:docId `{ data }` */
export const setDoc = handle((req, caller) =>
  getAppsParts().service.setDoc(req.params.appId, req.params.collection, req.params.docId, body(req).data, caller),
);

/** PATCH /api/apps/:appId/data/:collection/:docId `{ data, ifRev? }` */
export const updateDoc = handle((req, caller) => {
  const b = body(req);
  return getAppsParts().service.updateDoc(req.params.appId, req.params.collection, req.params.docId, b.data, b.ifRev, caller);
});

/** DELETE /api/apps/:appId/data/:collection/:docId */
export const deleteDoc = handle((req, caller) => getAppsParts().service.deleteDoc(req.params.appId, req.params.collection, req.params.docId, caller));
