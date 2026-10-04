/**
 * Crewly Apps controller — `/api/apps/*` on this instance.
 *
 * Agents publish apps and read/write their data here; this backend calls
 * Crewly Cloud with the token it holds, so agents never touch it
 * (specs/2026-10-04-crewly-apps-p2.md §1). Backs the publish-app and
 * app-data skills. P3 (specs/2026-10-04-crewly-apps-p3.md) adds signed
 * open-link cards, link management and public-app requests; the signed URL
 * never appears in a response.
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
import { redactOpenLinkTokens } from '../../services/apps/app-open-link.js';

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
    res.status(err.status).json({ success: false, error: err.code, message: redactOpenLinkTokens(err.message), ...(hint ? { hint } : {}) });
    return;
  }
  const message = redactOpenLinkTokens(err instanceof Error ? err.message : String(err));
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
function handle(fn: (req: Request, caller: AppsCaller) => Promise<unknown>, status = 200, opts: { redact?: boolean } = {}) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      let data = await fn(req, callerOf(req));
      // Belt and braces for the routes that touch open-links: whatever the
      // service returns, no open-link token reaches the caller (P3 §1).
      if (opts.redact && data !== undefined) data = JSON.parse(redactOpenLinkTokens(JSON.stringify(data)));
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
    { files: b.files, name: b.name, appId: b.appId, source: b.source, entry: b.entry, note: b.note, notify: b.notify, publicRequest: b.publicRequest },
    caller,
  );
  logger.info('App published', {
    appId: result.appId,
    version: result.version,
    created: result.created,
    agent: caller.agentSession ?? 'owner',
    ...(result.card ? { card: result.card } : {}),
    ...(result.publicRequested !== undefined ? { publicRequested: result.publicRequested } : {}),
  });
  return result;
}, 200, { redact: true });

/** POST /api/apps/:appId/share `{ ttlDays? }` — fresh signed link, card to the owner */
export const shareApp = handle(async (req, caller) => {
  const result = await getAppsParts().service.share(req.params.appId, { ttlDays: body(req).ttlDays }, caller);
  logger.info('App card shared', { appId: result.appId, card: result.card ?? 'none', place: result.cardPlace ?? 'none', agent: caller.agentSession ?? 'owner' });
  return result;
}, 200, { redact: true });

/** GET /api/apps/:appId/links — open-links (never tokens) */
export const listLinks = handle((req, caller) => getAppsParts().service.links(req.params.appId, caller), 200, { redact: true });

/** DELETE /api/apps/:appId/links/:linkId */
export const revokeLink = handle((req, caller) => getAppsParts().service.revokeLink(req.params.appId, req.params.linkId, caller));

/** DELETE /api/apps/:appId/links — revoke all */
export const revokeLinks = handle((req, caller) => getAppsParts().service.revokeLinks(req.params.appId, caller));

/** POST /api/apps/:appId/visibility-request `{ publicRead?, publicSubmit?, note? }` — the owner approves in the app */
export const requestPublic = handle(async (req, caller) => {
  const b = body(req);
  const result = await getAppsParts().service.requestPublic(req.params.appId, { publicRead: b.publicRead, publicSubmit: b.publicSubmit, note: b.note }, caller);
  logger.info('Public app requested', { appId: result.appId, agent: caller.agentSession ?? 'owner', card: result.card ?? 'none' });
  return result;
}, 200, { redact: true });

/** DELETE /api/apps/:appId/visibility-request */
export const cancelPublicRequest = handle((req, caller) => getAppsParts().service.cancelPublicRequest(req.params.appId, caller));

/** POST /api/apps/:appId/make-private */
export const makePrivate = handle((req, caller) => getAppsParts().service.makePrivate(req.params.appId, caller));

/** POST /api/apps/:appId/rollback `{ version }` */
export const rollbackApp = handle((req, caller) => getAppsParts().service.rollback(req.params.appId, body(req).version, caller));

/** GET /api/apps — apps this instance published */
export const listApps = handle((_req, caller) => getAppsParts().service.list(caller));

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
