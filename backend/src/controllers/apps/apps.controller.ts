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
import { getAppCommentAudio, getAppsParts } from '../../services/apps/apps.wiring.js';
import type { AppsCaller } from '../../services/apps/apps.service.js';
import { CREWLY_APPS_CONSTANTS } from '../../constants.js';
import { redactOpenLinkTokens } from '../../services/apps/app-open-link.js';
import { requireAppId } from '../../services/apps/apps.service.js';

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
    // A template scan's findings (masked excerpts, never full values) go back so the agent can fix them.
    const findings = err.code === CREWLY_APPS_CONSTANTS.ERROR_CODES.UNSAFE_CONTENT && Array.isArray(err.details?.['findings']) ? { findings: err.details['findings'] } : {};
    res.status(err.status).json({ success: false, error: err.code, message: redactOpenLinkTokens(err.message), ...(hint ? { hint } : {}), ...findings });
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

/** POST /api/apps/:appId/transfer `{ toSession }` — hand the app to another agent / team */
export const transferApp = handle(async (req, caller) => {
  const result = await getAppsParts().service.transfer(req.params.appId, body(req).toSession, caller);
  logger.info('App transferred', { appId: result.appId, from: result.previous ?? 'none', to: result.publisher, by: caller.agentSession ?? 'owner', changed: result.changed, notified: result.notified });
  return result;
});

/** GET /api/apps/:appId/owner — who the app's comments go to (an agent, a team or a channel) */
export const getAppOwner = handle((req, caller) => getAppsParts().service.getOwner(req.params.appId, caller));

/**
 * PUT /api/apps/:appId/owner `{ owner: 'agent:<name>' | 'team:<name>' | 'channel:#<name>' | 'default' }` —
 * the owner, or one of the app's owner agents (Cloud refuses other agents)
 */
export const setAppOwner = handle(async (req, caller) => {
  const result = await getAppsParts().service.setOwner(req.params.appId, body(req), caller);
  logger.info('App owner changed', { appId: result.appId, to: result.owner?.kind ?? 'default', by: caller.agentSession ?? 'owner' });
  return result;
});

/** POST /api/apps/:appId/collaborators/agents `{ agent }` — an owner agent (or the owner) adds an agent of any of the account's machines (`Rex` or `Rex@iriss-air`) */
export const addAgentCollaborator = handle((req, caller) => getAppsParts().service.addAgentCollaborator(req.params.appId, body(req).agent, caller));

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

/**
 * POST /api/apps/:appId/files — raw body, `Content-Type`, `X-File-Name`
 * (URI-encoded). Forwards to Cloud and answers `{ fileId, name, size,
 * contentType, url }`; Cloud's refusals (not a collaborator, too large,
 * quota) pass through with their own status and code.
 */
export const uploadFile = handle(async (req, caller) => {
  if (!Buffer.isBuffer(req.body)) {
    throw new AppsCloudError(415, 'unsupported_type', 'Send the file as the raw request body with a non-JSON Content-Type (application/octet-stream if unsure).');
  }
  const nameHeader = req.get('x-file-name');
  let name: string | undefined;
  try {
    name = nameHeader ? decodeURIComponent(nameHeader) : undefined;
  } catch {
    name = nameHeader ?? undefined;
  }
  const contentType = (req.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const result = (await getAppsParts().service.uploadFile(req.params.appId, { data: req.body, contentType, name }, caller)) as { fileId?: string; size?: number };
  logger.info('App file uploaded', { appId: req.params.appId, fileId: result.fileId, size: result.size, agent: caller.agentSession ?? 'owner' });
  return result;
}, 201);

/** GET /api/apps/:appId/comments?status=open|resolved|all (crewly#1056) */
export const listComments = handle((req, caller) => getAppsParts().service.listComments(req.params.appId, req.query.status, caller));

/** GET /api/apps/:appId/comments/:commentId */
export const getComment = handle((req, caller) => getAppsParts().service.getComment(req.params.appId, req.params.commentId, caller));

/** POST /api/apps/:appId/comments/:commentId/replies `{ text }` */
export const replyComment = handle(
  (req, caller) => getAppsParts().service.replyComment(req.params.appId, req.params.commentId, body(req).text, caller),
  201,
);

/** POST /api/apps/:appId/comments/:commentId/resolve */
export const resolveComment = handle((req, caller) => getAppsParts().service.setCommentStatus(req.params.appId, req.params.commentId, 'resolve', caller));

/** POST /api/apps/:appId/comments/:commentId/reopen */
export const reopenComment = handle((req, caller) => getAppsParts().service.setCommentStatus(req.params.appId, req.params.commentId, 'reopen', caller));

/**
 * POST /api/apps/:appId/comments/:commentId/audio — download the thread's
 * voice recordings to this machine (crewly-services apps/SPEC.md §16) and
 * answer their local paths, for the agent to transcribe. Same access as
 * reading the thread.
 */
export const downloadCommentAudio = handle(async (req, caller) => {
  const appId = String(req.params.appId);
  const commentId = String(req.params.commentId);
  const thread = (await getAppsParts().service.getComment(appId, commentId, caller)) as { attachments?: unknown; replies?: Array<{ attachments?: unknown }> };
  const files = await getAppCommentAudio().forThread(appId, commentId, thread);
  return {
    recordings: files.map((f) => ({ blobId: f.blobId, durationMs: f.durationMs, mime: f.mime, ...(f.path ? { path: f.path } : { error: f.error ?? 'not downloaded' }) })),
  };
});

/**
 * POST /api/apps/:appId/thumbnail/refresh — capture the portal thumbnail now
 * (the publisher or the owner). Waits for the capture; a machine without a
 * browser answers `{ captured: false, reason: 'no_browser' }`, not an error.
 */
export const refreshThumbnail = handle(async (req, caller) => {
  const { service, thumbnails } = getAppsParts();
  const appId = requireAppId(req.params.appId);
  await service.assertPublisher(appId, caller);
  if (!thumbnails) return { appId, captured: false, reason: 'disabled', message: 'Thumbnails are not available on this instance.' };
  const entry = await getAppsParts().registry.get(appId);
  const r = await thumbnails.capture(appId, caller.agentSession ?? entry?.agentSession ?? null);
  return r.ok ? { appId, captured: true, bytes: r.bytes } : { appId, captured: false, reason: r.reason, message: r.message };
});

/**
 * POST /api/apps/thumbnails/refresh-all — owner only: capture a thumbnail for
 * every app in this machine's registry, one after another in the background.
 * Answers 202 with how many were queued; results are in the backend log.
 */
export const refreshAllThumbnails = async (req: Request, res: Response): Promise<void> => {
  try {
    if (callerOf(req).agentSession) {
      res.status(403).json({ success: false, error: 'owner_only', message: 'Only the owner can refresh every app thumbnail.' });
      return;
    }
    const { thumbnails } = getAppsParts();
    if (!thumbnails) {
      res.status(409).json({ success: false, error: 'disabled', message: 'Thumbnails are not available on this instance.' });
      return;
    }
    const apps = await thumbnails.registeredApps();
    void thumbnails
      .captureAll(apps)
      .then((results) => {
        const ok = results.filter((r) => r.ok).length;
        logger.info('Thumbnail backfill finished', { total: results.length, captured: ok });
      })
      .catch(() => undefined);
    res.status(202).json({ success: true, data: { queued: apps.length } });
  } catch (err) {
    sendAppsError(res, err);
  }
};

/** POST /api/apps/:appId/collaborators/request `{ scope?, reason? }` — an agent asks the owner to let its team (or only itself) work in the app */
export const requestCollaborator = handle(async (req, caller) => {
  const b = body(req);
  return requireCollaborators().request(req.params.appId, caller.agentSession, { scope: b.scope, reason: b.reason });
});

/** GET /api/apps/:appId/collaborators — who the owner let work in the app */
export const listCollaborators = handle(async (req, caller) => requireCollaborators().list(req.params.appId, caller.agentSession));

/** POST /api/apps/:appId/collaborators — the OWNER adds a team/agent (an agent is refused in the route) */
export const addCollaborator = handle(async (req) => requireCollaborators().add(req.params.appId, body(req)));

/** DELETE /api/apps/:appId/collaborators/:entryId — the OWNER removes one; effective on the next call */
export const removeCollaborator = handle(async (req) => requireCollaborators().remove(req.params.appId, req.params.entryId));

/** The collaborators service of the shared parts. */
function requireCollaborators() {
  const svc = getAppsParts().collaborators;
  if (!svc) throw new AppsCloudError(503, 'unavailable', 'Collaborators are not available on this machine.');
  return svc;
}

// ---------------------------------------------------------------------------
// Marketplace templates (specs/2026-10-08-app-templates.md)
// ---------------------------------------------------------------------------

/** The templates service of the shared parts. */
function requireTemplates() {
  const svc = getAppsParts().templates;
  if (!svc) throw new AppsCloudError(503, 'unavailable', 'App templates are not available on this machine.');
  return svc;
}

/** POST /api/apps/:appId/template-request `{ description, name?, category?, tags?, author?, sampleData? }` — Cloud drafts it, the owner gets a card */
export const requestTemplate = handle(async (req, caller) => {
  const b = body(req);
  const result = await requireTemplates().requestPublish(req.params.appId, caller, {
    description: b.description,
    name: b.name,
    category: b.category,
    tags: b.tags,
    author: b.author,
    sampleData: b.sampleData,
  });
  logger.info('App template requested', { appId: req.params.appId, templateId: result.templateId, version: result.version, decisionId: result.decisionId, agent: caller.agentSession ?? 'owner' });
  return result;
});

/** GET /api/apps/templates?q=&tag=&category=&limit= — search the Marketplace */
export const findTemplates = handle(async (req, caller) =>
  requireTemplates().find({ q: req.query.q, tag: req.query.tag, category: req.query.category, limit: req.query.limit }, caller),
);

/** GET /api/apps/templates/mine — this account's own templates */
export const myTemplates = handle(async (_req, caller) => requireTemplates().mine(caller));

/** POST /api/apps/templates/:templateId/use `{ name?, source? }` — a new app from the template; answers its files */
export const useTemplate = handle(async (req, caller) => {
  const b = body(req);
  const result = await requireTemplates().use(req.params.templateId, caller, { name: b.name, source: b.source });
  logger.info('App made from a template', { templateId: req.params.templateId, appId: result.appId, agent: caller.agentSession ?? 'owner' });
  return result;
}, 201);

/** POST /api/apps/templates/:templateId/unlist — off the Marketplace (no approval needed to reduce exposure) */
export const unlistTemplate = handle(async (req, caller) => requireTemplates().unlist(req.params.templateId, caller));

/** POST /api/apps/:appId/template-files `{ source? }` — the template files of an app made from a template */
export const checkoutTemplateFiles = handle(async (req, caller) => requireTemplates().checkout(req.params.appId, caller, { source: body(req).source }));
