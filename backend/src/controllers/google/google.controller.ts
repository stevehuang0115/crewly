/**
 * Google Workspace Controller
 *
 * HTTP surface for Gmail + Calendar on the owner's account, mounted at
 * `/api/google`. Backs the `gmail-*` / `calendar-*` agent skills and the
 * Settings → Integrations "Google Workspace" card.
 *
 * Every failure answers `{ success: false, error, hint }`; a missing grant
 * is a 409 `not_connected` whose `hint` is the Cloud consent URL so the
 * caller can send the owner straight there.
 *
 * @module controllers/google/google.controller
 */

import { PEOPLE_CONSTANTS } from '../../constants.js';
import { connectingPerson, createSharingHandler } from '../connector/grant-sharing.handler.js';
import type { Request, Response } from 'express';
import { GOOGLE_WORKSPACE_CONSTANTS, GOOGLE_PRODUCTS, type GoogleProduct } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';
import {
  GoogleWorkspaceTokenService,
  GoogleWorkspaceError,
} from '../../services/google/google-workspace-token.service.js';
import {
  holdGmailSend,
  listHeldSends,
  getHeldSend,
  clearHeldSend,
} from '../../services/google/gmail-send-gate.js';
import {
  holdDocComment,
  getDocCommentBatch,
  listDocCommentBatches,
  clearDocCommentBatch,
  decideBatchSend,
  buildHoldMessage,
  buildBatchRefusalMessage,
  DOC_COMMENT_CONFIRM_SCAN_LIMIT,
  type HeldDocComment,
} from '../../services/google/docs-comment-gate.js';
import { getChatV2Service } from '../../services/chat-v2/chat-v2.singleton.js';
import { GmailService, buildRfc822, type GmailSendInput } from '../../services/google/gmail.service.js';
import type { GmailSendApprovalService } from '../../services/google/gmail-send-approval.service.js';
import type { GmailReplyWatchService } from '../../services/google/gmail-reply-watch.service.js';
import { CalendarService } from '../../services/google/calendar.service.js';
import { DriveService } from '../../services/google/drive.service.js';
import { DocsService } from '../../services/google/docs.service.js';
import { DocsCommentsService } from '../../services/google/docs-comments.service.js';
import { SheetsService, type SheetCell } from '../../services/google/sheets.service.js';
import { SlidesService, type SlideOutline } from '../../services/google/slides.service.js';
import { isOwnerCaller } from '../../middleware/caller-identity.middleware.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import {
  GoogleReauthNotifier,
  type ReauthNotifyResult,
  type ReauthTrigger,
} from '../../services/google/google-reauth-notifier.service.js';
import { buildPortalConnectUrl, PRODUCT_LABELS } from './google-connect-card.js';
import { actorFromRequest, recordActivity } from '../../services/activity/activity-log.service.js';

/** Who a held send is attributed to when the caller named no agent session. */
const UNIDENTIFIED_SENDER = 'unidentified caller';

const logger = LoggerService.getInstance().createComponentLogger('GoogleController');

/** The services the handlers use; swappable for tests. */
export interface GoogleControllerDeps {
  tokens: GoogleWorkspaceTokenService;
  gmail: GmailService;
  calendar: CalendarService;
  drive: DriveService;
  docs: DocsService;
  docComments: DocsCommentsService;
  sheets: SheetsService;
  slides: SlidesService;
}

/**
 * A dependency set installed by a test, which then answers every request.
 *
 * Kept apart from the lazily-built default: if the two shared a variable,
 * the first call would populate it and every later request would be served
 * the default set, silently ignoring the Google account it named.
 */
let override: GoogleControllerDeps | null = null;
/** The lazily-built set for the default Google account. */
let defaultDeps: GoogleControllerDeps | null = null;
/** Per-Google-account service sets, built on demand. */
const byAccount = new Map<string, GoogleControllerDeps>();

/**
 * Lazily build the real services (token service singleton + Gmail/Calendar
 * bound to it).
 *
 * @returns The active dependency set
 */
function buildDeps(account?: string): GoogleControllerDeps {
  const tokens = GoogleWorkspaceTokenService.getInstance();
  // Each service names the product it needs, so a call made against a grant
  // that does not cover it fails with "connect Drive" rather than a Google 403.
  const bind = (product: GoogleProduct) => ({ tokens, product, ...(account ? { account } : {}) });
  return {
    tokens,
    gmail: new GmailService(bind('gmail')),
    calendar: new CalendarService(bind('calendar')),
    drive: new DriveService(bind('drive')),
    docs: new DocsService(bind('drive')),
    docComments: new DocsCommentsService(bind('drive')),
    sheets: new SheetsService(bind('drive')),
    slides: new SlidesService(bind('drive')),
  };
}

function getDeps(): GoogleControllerDeps {
  if (override) return override;
  if (!defaultDeps) defaultDeps = buildDeps();
  return defaultDeps;
}

/**
 * The services for the Google account a request names, or the default set.
 *
 * Tests that install their own dependency set keep it whatever the request
 * asks for — overriding it per account would make them untestable.
 *
 * @param req - Incoming request; `account` query or `X-Google-Account` header
 * @returns The service set to use
 */
function depsForRequest(req: Request): GoogleControllerDeps {
  const raw = typeof req.query.account === 'string' ? req.query.account : req.get('X-Google-Account') ?? '';
  return depsForAccount(raw.trim() || undefined);
}

/**
 * The services for one Google account (or the default set when none).
 *
 * @param account - Google account email; undefined for the default connection
 * @returns The service set to use
 */
function depsForAccount(account: string | undefined): GoogleControllerDeps {
  if (override) return override;
  if (!account) return getDeps();
  let set = byAccount.get(account);
  if (!set) {
    set = buildDeps(account);
    byAccount.set(account, set);
  }
  return set;
}

/** Raises the send card for a held draft and applies the owner's answer (CREW-257). */
let sendApproval: GmailSendApprovalService | null = null;
/** Watches threads for replies (CREW-257). */
let replyWatch: GmailReplyWatchService | null = null;

/**
 * Install the approval-card service (or, with null, remove it).
 *
 * @param next - The service
 */
export function setGmailSendApproval(next: GmailSendApprovalService | null): void {
  sendApproval = next;
}

/**
 * Install the reply-watch service (or, with null, remove it).
 *
 * @param next - The service
 */
export function setGmailReplyWatch(next: GmailReplyWatchService | null): void {
  replyWatch = next;
}

/**
 * Gmail for a named Google account (default account when omitted); the
 * background services (approval, reply watch) use this.
 *
 * @param account - Google account email
 * @returns The Gmail service
 */
export function gmailForAccount(account?: string): GmailService {
  if (override) return override.gmail;
  if (!account) return getDeps().gmail;
  let set = byAccount.get(account);
  if (!set) {
    set = buildDeps(account);
    byAccount.set(account, set);
  }
  return set.gmail;
}

/**
 * Replace (or, with null, reset) the services the handlers use. Tests only.
 *
 * @param next - Dependency set or null to rebuild lazily
 */
export function setGoogleControllerDeps(next: GoogleControllerDeps | null): void {
  override = next;
  defaultDeps = null;
  byAccount.clear();
}

/**
 * Where Cloud should send the owner after consent: an explicit http(s)
 * `returnUrl` query wins (the dashboard passes its own origin, which can
 * differ from the API's in dev), else this API's origin + the Settings
 * integrations tab.
 *
 * @param req - Incoming request
 * @returns Absolute return URL
 */
function resolveReturnUrl(req: Request): string {
  const explicit = typeof req.query.returnUrl === 'string' ? req.query.returnUrl : '';
  if (/^https?:\/\//i.test(explicit)) return explicit;
  return `${req.protocol}://${req.get('host')}${GOOGLE_WORKSPACE_CONSTANTS.SETTINGS_RETURN_PATH}`;
}

/**
 * The connect URL for this request, or null when not signed in to Cloud.
 *
 * @param req - Incoming request
 * @returns Cloud consent-start URL or null
 */
function connectUrlOrNull(req: Request): string | null {
  try {
    return getDeps().tokens.buildConnectUrl(resolveReturnUrl(req), connectOptions(req));
  } catch {
    return null;
  }
}

/**
 * The `not_connected` hint. The dashboard owner gets the Cloud consent URL
 * (it carries their session token and returns to their own dashboard — fine
 * in their own browser, never for an agent to paste anywhere). An agent gets
 * the skill that posts a card, and the portal page as the manual fallback:
 * the owner is usually on a phone and cannot reach the local dashboard.
 *
 * @param req - Incoming request
 * @param err - The failure
 * @returns Hint text
 */
function notConnectedHint(req: Request, err: GoogleWorkspaceError): string {
  const product = err.details?.product;
  if (isOwnerCaller(req)) {
    return connectUrlOrNull(req)
      ?? 'Sign in to Crewly Cloud (Settings → Cloud & devices), then connect Google Workspace under Connections.';
  }
  const products = product ? [product] : [];
  const flag = product ? ` --product ${product}` : ' --product <gmail|calendar|drive>';
  return `Google is not connected for this. Ask the owner to connect it: run the google-connect skill with${flag}; it posts a one-tap card in Slack. Never send the owner to Crewly settings or the Connections page. Manual fallback: ${buildPortalConnectUrl(products, err.details?.account ?? accountOf(req))}`;
}

/**
 * Which products a connect request is for, and which Google account to sign
 * in as.
 *
 * `products` narrows the consent screen to what the caller actually wants —
 * asking for Calendar must not show "read all your mail". `loginHint` is
 * what makes adding a *second* Google account possible: without it Google
 * reuses whichever session the browser is already signed in to.
 *
 * @param req - Incoming request
 * @returns Options for `buildConnectUrl`
 */
function connectOptions(req: Request): { products?: GoogleProduct[]; loginHint?: string; chooseAccount?: boolean; replace?: boolean; authorizedBy?: string } {
  const raw = typeof req.query.products === 'string' ? req.query.products : '';
  const wanted = new Set(raw.split(',').map((p) => p.trim().toLowerCase()));
  const products = GOOGLE_PRODUCTS.filter((p) => wanted.has(p));
  const hint = typeof req.query.loginHint === 'string' ? req.query.loginHint.trim() : '';
  const chooseAccount = req.query.chooseAccount === '1' || req.query.chooseAccount === 'true';
  const replace = req.query.replace === '1' || req.query.replace === 'true';
  return {
    ...(products.length ? { products } : {}),
    ...(hint ? { loginHint: hint } : {}),
    ...(chooseAccount ? { chooseAccount } : {}),
    ...(replace ? { replace } : {}),
    // The grant belongs to whoever connects it (issue #968): the owner from
    // the dashboard, else the person the asking agent acts for.
    authorizedBy: connectingPerson(req),
  };
}

/**
 * The Google account a grant request names, if any.
 *
 * @param req - Incoming request
 * @returns The email, or undefined for "the default connection"
 */
function accountOf(req: Request): string | undefined {
  const raw = typeof req.query.account === 'string' ? req.query.account : req.get('X-Google-Account') ?? '';
  return raw.trim() || undefined;
}

/**
 * The reconnect a failure calls for, if only the owner can fix it: the grant
 * lacks a scope this call needs (Google 403 insufficient scopes), or Google
 * no longer honours it (expired / revoked — Cloud said `grant_revoked`).
 *
 * @param err - The failure
 * @param req - Incoming request (agent session, Google account)
 * @returns The trigger, or null for any other failure
 */
export function reauthTriggerFor(err: unknown, req: Request): ReauthTrigger | null {
  if (!(err instanceof GoogleWorkspaceError)) return null;
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  const product = err.details?.product;
  if (!product) return null;
  let kind: ReauthTrigger['kind'];
  if (err.code === CODES.REAUTH_REQUIRED) kind = 'missing_scope';
  else if (err.code === CODES.NOT_CONNECTED && err.details?.reason === 'grant_revoked') kind = 'expired';
  else return null;
  const account = err.details?.account ?? accountOf(req);
  // Only an agent's call: the owner at the dashboard is already looking at
  // the Connections page, and a card in Slack would be noise.
  const agentSession = isOwnerCaller(req) ? undefined : readAgentSessionHeader(req);
  if (!agentSession) return null;
  return { product, kind, agentSession, ...(account ? { account } : {}) };
}

/**
 * Ask the owner to reconnect, without holding the skill call for long.
 *
 * @param trigger - The failure
 * @returns What happened, or null when no notifier is wired or it timed out
 */
async function notifyReauth(trigger: ReauthTrigger): Promise<ReauthNotifyResult | null> {
  const notifier = GoogleReauthNotifier.getInstance();
  if (!notifier) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), GOOGLE_WORKSPACE_CONSTANTS.REAUTH.POST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([notifier.notify(trigger).catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The agent-facing next step after a reconnect card was (or was not) sent.
 *
 * The agent must not send the owner to the dashboard's Connections page: the
 * owner is usually on a phone and cannot reach it. The card (its link never
 * expires) is the whole fix; the Cloud portal page is the manual fallback.
 *
 * @param trigger - The failure
 * @param result - What the notifier did
 * @returns The hint, or null to fall back to the generic one
 */
export function reauthHint(trigger: ReauthTrigger, result: ReauthNotifyResult | null): string | null {
  const label = PRODUCT_LABELS[trigger.product] ?? trigger.product;
  const portal = buildPortalConnectUrl([trigger.product], trigger.account);
  if (result?.status === 'posted') {
    return `A reconnect card was sent to the owner in Slack, in the conversation you are answering them in. Tell them in one line that you need them to tap it; its link does not expire. Never send them to Crewly settings or the Connections page. You will get a message saying ${label} is reconnected — then retry. If they say the card did not work, run the google-connect skill with --product ${trigger.product} for a fresh one, or give them ${portal} to open directly.`;
  }
  if (result?.status === 'already_sent') {
    return `A reconnect card was already sent to the owner in Slack at ${result.sentAt}. Do not ask again unless the owner says it did not work — then run the google-connect skill with --product ${trigger.product} for a fresh one, or give them ${portal} to open directly (never Crewly settings or the Connections page). You will get a message saying ${label} is reconnected, then retry.`;
  }
  return null;
}

/**
 * Answer a failure with the contract's `{ success:false, error, hint }`
 * shape. `not_connected` carries the consent URL as the hint; the other
 * codes get a one-line next step. A failure only the owner can fix (missing
 * scope, expired grant) first posts the owner a one-tap reconnect card in
 * Slack, and the hint says so.
 *
 * @param req - Incoming request (for the connect URL)
 * @param res - Response
 * @param err - The failure
 */
export async function sendGoogleError(req: Request, res: Response, err: unknown): Promise<void> {
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  if (err instanceof GoogleWorkspaceError) {
    const trigger = reauthTriggerFor(err, req);
    const reauth = trigger ? await notifyReauth(trigger) : null;
    const reauthText = trigger ? reauthHint(trigger, reauth) : null;
    let hint: string;
    switch (err.code) {
      case CODES.NOT_CONNECTED:
        hint = reauthText ?? notConnectedHint(req, err);
        break;
      case CODES.NOT_LOGGED_IN:
        hint = 'Sign in to Crewly Cloud first (Settings → Cloud & devices).';
        break;
      case CODES.NOT_CONFIGURED:
        hint = 'Crewly Cloud is not configured for Google Workspace; nothing to do on this instance.';
        break;
      case CODES.VALIDATION:
        hint = 'Fix the request and retry.';
        break;
      case CODES.REAUTH_REQUIRED: {
        // Owner-away: the only step is one tap on the Slack card.
        const product = err.details?.product ?? 'drive';
        hint = reauthText
          ?? `Ask the owner to reconnect ${PRODUCT_LABELS[product] ?? product}: run the google-connect skill with --product ${product}. It posts a one-tap card in Slack; nothing to do on this machine. Manual fallback: ${buildPortalConnectUrl([product], err.details?.account ?? accountOf(req))}`;
        break;
      }
      case PEOPLE_CONSTANTS.NOT_PERMITTED_CODE:
        hint = PEOPLE_CONSTANTS.NOT_PERMITTED_HINT;
        break;
      default:
        hint = err.status === 401
          ? 'The Google token was rejected; retry once — the cache has been cleared.'
          : 'Google or Crewly Cloud failed; retry later.';
    }
    res.status(err.status).json({
      success: false,
      error: err.code,
      message: err.message,
      hint,
      ...(reauthText ? { reconnectLinkSent: true } : {}),
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  logger.error('Unexpected Google Workspace failure', { error: message });
  res.status(500).json({ success: false, error: 'internal', message, hint: 'Check the backend log.' });
}

/**
 * Read a query parameter as a trimmed string ('' when absent).
 *
 * @param req - Incoming request
 * @param name - Parameter name
 * @returns The value
 */
function q(req: Request, name: string): string {
  const v = req.query[name];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Parse an optional integer query parameter.
 *
 * @param req - Incoming request
 * @param name - Parameter name
 * @returns The number or undefined
 */
function qInt(req: Request, name: string): number | undefined {
  const v = q(req, name);
  return v ? Number.parseInt(v, 10) : undefined;
}

/**
 * GET /api/google/status — `{ connected, cloudConnected, email?, scopes?, grantedAt? }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function getStatus(req: Request, res: Response): Promise<void> {
  try {
    const data = await getDeps().tokens.status();
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/connect-url — `{ url }` to open in the browser
 * (Cloud `/start?token=<jwt>&returnUrl=<dashboard>/connections?platform=google-workspace`).
 *
 * @param req - Incoming request; optional `returnUrl` query
 * @param res - Response
 */
export async function getConnectUrl(req: Request, res: Response): Promise<void> {
  try {
    // The dashboard URL carries the owner's Cloud session token and returns
    // to this machine's localhost: fine in the owner's own browser, a
    // credential an agent could paste into Slack. Agents get the portal page.
    const url = isOwnerCaller(req)
      ? getDeps().tokens.buildConnectUrl(resolveReturnUrl(req), connectOptions(req))
      : buildPortalConnectUrl(connectOptions(req).products ?? [], accountOf(req));
    res.json({ success: true, data: { url } });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * DELETE /api/google/disconnect — revoke on Cloud and forget the grant.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function disconnect(req: Request, res: Response): Promise<void> {
  try {
    const account = accountOf(req);
    const data = await getDeps().tokens.disconnect({ ...(account ? { account } : {}) });
    recordActivity({ actor: actorFromRequest(req), action: 'connector.disconnected', target: { type: 'connector', id: 'google-workspace', ...(account ? { name: account } : {}) } });
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/default — choose which connected Google account answers
 * a skill or agent that names none.
 *
 * @param req - Body `{ email }`
 * @param res - Response
 */
export async function setDefaultAccount(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { email?: unknown };
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!email) {
      res.status(400).json({ success: false, error: 'validation', message: 'email is required' });
      return;
    }
    const data = await getDeps().tokens.setDefaultAccount(email);
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/sharing — change who owns a Google grant and who it is
 * shared with (issue #968). Owner only: an agent is refused.
 * Body `{ email, authorizedBy?, sharing? }` → `{ authorizedBy, sharing }`.
 */
export const setSharing = createSharingHandler(async (req, change) => {
  const email = typeof (req.body as { email?: unknown } | undefined)?.email === 'string' ? (req.body as { email: string }).email.trim() : '';
  if (!email) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, 'email is required');
  return getDeps().tokens.setSharing(email, change);
}, sendGoogleError, 'google-workspace');

/**
 * GET /api/google/gmail/search?q=&max= — search hits with headers + snippet.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailSearch(req: Request, res: Response): Promise<void> {
  try {
    const query = q(req, 'q');
    if (!query) {
      throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, '"q" is required');
    }
    const messages = await depsForRequest(req).gmail.search({ query, max: qInt(req, 'max') });
    res.json({ success: true, data: { query, count: messages.length, messages } });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/gmail/messages/:id — one message, body decoded, attachments listed.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailRead(req: Request, res: Response): Promise<void> {
  try {
    const message = await depsForRequest(req).gmail.read(String(req.params.id ?? ''));
    res.json({ success: true, data: message });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/gmail/messages/:id/attachments/:attachmentId — the bytes of
 * one attachment as `{ messageId, attachmentId, size, dataBase64 }` (25 MB cap).
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailAttachment(req: Request, res: Response): Promise<void> {
  try {
    const data = await depsForRequest(req).gmail.getAttachment(
      String(req.params.id ?? ''),
      String(req.params.attachmentId ?? ''),
    );
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/gmail/send — body `{ to, cc?, subject, text, threadId?,
 * inReplyTo?, dryRun? }`. With `dryRun: true` nothing is sent; the RFC 822
 * preview comes back as `data.raw` instead.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailSend(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as Partial<GmailSendInput> & { dryRun?: boolean };
    const input: GmailSendInput = {
      to: String(body.to ?? ''),
      subject: String(body.subject ?? ''),
      text: String(body.text ?? ''),
      ...(body.cc ? { cc: String(body.cc) } : {}),
      ...(body.threadId ? { threadId: String(body.threadId) } : {}),
      ...(body.inReplyTo ? { inReplyTo: String(body.inReplyTo) } : {}),
    };
    if (body.dryRun === true) {
      res.json({ success: true, data: { dryRun: true, raw: buildRfc822(input) } });
      return;
    }

    const gmail = depsForRequest(req).gmail;
    // Only an owner credential sends directly (#999). Anyone else — an agent,
    // or a caller that merely left out X-Agent-Session — gets a draft.
    const agentSession = isOwnerCaller(req) ? undefined : (readAgentSessionHeader(req) ?? UNIDENTIFIED_SENDER);

    // An agent does not send mail on the owner's behalf by asking to.
    //
    // An owner asked for a reply to be *drafted*. Two emails went out
    // instead, to outside parties, in live threads — and afterwards the
    // agent cited an instruction to send that does not exist anywhere in the
    // record. Both halves matter: the action was irreversible, and the
    // account of it was not checkable.
    //
    // So the default for an agent is now a real Gmail draft, which the owner
    // can open, edit and send. Sending needs the owner to say so against
    // this specific message. The owner (dashboard session, relay, API token)
    // is unaffected.
    if (agentSession) {
      const draft = await gmail.createDraft(input);
      const account = (typeof req.query.account === 'string' ? req.query.account : req.get('X-Google-Account') ?? '').trim();
      const pending = holdGmailSend({
        agentSession,
        draftId: draft.draftId,
        to: input.to,
        subject: input.subject,
        claim: readAuthorizationClaim(req),
        ...(account ? { account } : {}),
      });
      // Ask the owner on a card. Only their answer (never anything the agent
      // sends) sends the draft.
      let carded = false;
      try {
        carded = agentSession === UNIDENTIFIED_SENDER ? false : ((await sendApproval?.onHeld(pending)) ?? false);
      } catch (err) {
        logger.warn('Could not raise the send card for a held draft', { id: pending.id, error: err instanceof Error ? err.message : String(err) });
      }
      logger.warn('Gmail send held — draft created, awaiting the owner', {
        agentSession,
        draftId: draft.draftId,
        to: input.to,
        citedAuthorization: pending.claim ?? '(none given)',
      });
      res.status(202).json({
        success: true,
        data: {
          drafted: true,
          draftId: draft.draftId,
          threadId: draft.threadId,
          pendingId: pending.id,
          approvalCard: carded,
          message: carded
            ? 'Saved as a draft and put to the owner as a decision card. It has NOT been sent. If the owner taps Send, it goes out and you are told; replies on the thread will wake you. Do not retry, and do not look for another way to send it.'
            : 'Saved as a draft in the owner\'s Gmail. It has NOT been sent. Only the owner can send it — tell them it is waiting and what it says. Do not retry, and do not look for another way to send it.',
        },
      });
      return;
    }

    const sent = await gmail.send(input);
    logger.info('Gmail message sent', { id: sent.id, threadId: sent.threadId, to: input.to, agentSession });
    res.json({ success: true, data: sent });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/calendar/events?from=&to=&calendarId=&max= — upcoming events.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function calendarList(req: Request, res: Response): Promise<void> {
  try {
    const events = await depsForRequest(req).calendar.listEvents({
      calendarId: q(req, 'calendarId') || undefined,
      timeMin: q(req, 'from') || undefined,
      timeMax: q(req, 'to') || undefined,
      max: qInt(req, 'max'),
    });
    res.json({ success: true, data: { count: events.length, events } });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/calendar/events — body `{ calendarId?, summary, start,
 * end, description?, attendees?, timezone? }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function calendarCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as {
      calendarId?: string; summary?: string; start?: string; end?: string;
      description?: string; attendees?: unknown; timezone?: string;
    };
    const attendees = Array.isArray(body.attendees)
      ? body.attendees.map((a) => String(a))
      : typeof body.attendees === 'string'
        ? body.attendees.split(',')
        : [];
    const event = await depsForRequest(req).calendar.createEvent({
      calendarId: body.calendarId,
      summary: String(body.summary ?? ''),
      start: String(body.start ?? ''),
      end: String(body.end ?? ''),
      description: body.description,
      attendees,
      timezone: body.timezone,
    });
    res.json({ success: true, data: event });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

/**
 * GET /api/google/drive/files?q=&mimeType=&folderId=&max= — search.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function driveSearch(req: Request, res: Response): Promise<void> {
  try {
    const files = await depsForRequest(req).drive.search({
      query: q(req, 'q') || undefined,
      mimeType: q(req, 'mimeType') || undefined,
      folderId: q(req, 'folderId') || undefined,
      max: qInt(req, 'max'),
    });
    res.json({ success: true, data: { count: files.length, files } });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/drive/files/:id — metadata.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function driveGet(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await depsForRequest(req).drive.get(String(req.params.id ?? '')) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/drive/files/:id/content — exported text / downloaded body.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function driveContent(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await depsForRequest(req).drive.readContent(String(req.params.id ?? '')) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/drive/files — body `{ name, content, encoding?, mimeType?, folderId?, convertTo? }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function driveUpload(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { name?: string; content?: string; encoding?: string; mimeType?: string; folderId?: string; convertTo?: string };
    const file = await depsForRequest(req).drive.upload({
      name: String(body.name ?? ''),
      content: typeof body.content === 'string' ? body.content : '',
      encoding: body.encoding === 'base64' ? 'base64' : 'utf8',
      mimeType: body.mimeType,
      folderId: body.folderId,
      convertTo: body.convertTo,
    });
    logger.info('Drive file uploaded', { id: file.id, name: file.name });
    res.json({ success: true, data: file });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

/**
 * GET /api/google/docs/:id — document as text.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsRead(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await depsForRequest(req).docs.read(String(req.params.id ?? '')) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/docs — body `{ title, text? }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { title?: string; text?: string };
    const doc = await depsForRequest(req).docs.create({ title: String(body.title ?? ''), text: typeof body.text === 'string' ? body.text : undefined });
    logger.info('Google Doc created', { id: doc.id, title: doc.title });
    res.json({ success: true, data: doc });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/docs/:id/append — body `{ text }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsAppend(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { text?: string };
    res.json({ success: true, data: await depsForRequest(req).docs.append(String(req.params.id ?? ''), String(body.text ?? '')) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/docs/:id/comments — `?includeResolved=1` keeps resolved ones.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsCommentsList(req: Request, res: Response): Promise<void> {
  try {
    const flag = q(req, 'includeResolved').toLowerCase();
    const includeResolved = flag === '1' || flag === 'true';
    res.json({ success: true, data: await depsForRequest(req).docComments.list(String(req.params.id ?? ''), { includeResolved }) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * Hold an agent's Doc comment action instead of posting it.
 *
 * A comment on a shared Doc is visible to collaborators under the owner's
 * name, so it is outbound like `gmail-send`: only the owner credential posts
 * directly. Anyone else queues it into their open batch, and the owner
 * authorizes the whole batch with one 「发 C<n>」 (see docs-comment-gate).
 *
 * @param req - Incoming request
 * @param res - Response
 * @param item - The action to hold
 * @returns True when the request was held (response sent); false when the caller may post
 */
function holdDocCommentUnlessOwner(req: Request, res: Response, item: HeldDocComment): boolean {
  if (isOwnerCaller(req)) return false;
  const agentSession = readAgentSessionHeader(req) ?? UNIDENTIFIED_SENDER;
  const batch = holdDocComment(agentSession, item, readAuthorizationClaim(req));
  logger.warn('Doc comment held — awaiting the owner', {
    agentSession,
    code: batch.code,
    action: item.action,
    docId: item.docId,
    citedAuthorization: readAuthorizationClaim(req) ?? '(none given)',
  });
  res.status(202).json({
    success: true,
    data: {
      held: true,
      batch: batch.code,
      queued: batch.items.length,
      message: buildHoldMessage(batch),
    },
  });
  return true;
}

/**
 * POST /api/google/docs/:id/comments — body `{ text, quote? }`.
 * An agent's comment is queued for the owner's OK, not posted.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsCommentsAdd(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { text?: unknown; quote?: unknown };
    const quote = typeof body.quote === 'string' ? body.quote : undefined;
    const docId = String(req.params.id ?? '');
    const text = String(body.text ?? '');
    if (!isOwnerCaller(req)) {
      if (!text.trim()) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, 'Comment text is required.');
      if (holdDocCommentUnlessOwner(req, res, { action: 'add', docId, text, ...(quote ? { quote } : {}), ...accountField(req) })) return;
    }
    const data = await depsForRequest(req).docComments.add(docId, text, quote);
    logger.info('Google Doc comment added', { docId: data.docId, commentId: data.id });
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/docs/:id/comments/:commentId/replies — body `{ text }`.
 * An agent's reply is queued for the owner's OK, not posted.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsCommentsReply(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { text?: unknown };
    const docId = String(req.params.id ?? '');
    const commentId = String(req.params.commentId ?? '');
    const text = String(body.text ?? '');
    if (!isOwnerCaller(req)) {
      if (!text.trim()) throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, 'Reply text is required.');
      if (holdDocCommentUnlessOwner(req, res, { action: 'reply', docId, commentId, text, ...accountField(req) })) return;
    }
    const data = await depsForRequest(req).docComments.reply(docId, commentId, text);
    logger.info('Google Doc comment replied', { docId: data.docId, commentId: data.commentId });
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/docs/:id/comments/:commentId/resolve — body `{ text? }`.
 * An agent's resolve is queued for the owner's OK, not posted.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docsCommentsResolve(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : undefined;
    const docId = String(req.params.id ?? '');
    const commentId = String(req.params.commentId ?? '');
    if (holdDocCommentUnlessOwner(req, res, { action: 'resolve', docId, commentId, ...(text ? { text } : {}), ...accountField(req) })) return;
    const data = await depsForRequest(req).docComments.resolve(docId, commentId, text);
    logger.info('Google Doc comment resolved', { docId: data.docId, commentId: data.commentId });
    res.json({ success: true, data });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/** `{ account }` when the request names a Google account, else nothing. */
function accountField(req: Request): { account?: string } {
  const account = accountOf(req);
  return account ? { account } : {};
}

/**
 * GET /api/google/doc-comment-batches — comments agents have queued for the
 * owner. Each batch carries what the agent cited as authorization.
 *
 * @param _req - Incoming request
 * @param res - Response
 */
export function docCommentBatchesList(_req: Request, res: Response): void {
  res.json({ success: true, data: { batches: listDocCommentBatches() } });
}

/**
 * POST /api/google/doc-comment-batches/:code/send — post a whole batch.
 *
 * Owner credential: allowed (the click is the confirmation). Agent: only
 * after the owner's 「发 C<n>」 in chat that post-dates the batch's last
 * change. Items post in order; the first failure stops the run and the
 * unposted items stay queued, so a retry never double-posts.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function docCommentBatchSend(req: Request, res: Response): Promise<void> {
  const batch = getDocCommentBatch(String(req.params.code ?? ''));
  if (!batch) {
    res.status(404).json({ success: false, error: 'not_found', message: `No queued comment batch ${req.params.code}` });
    return;
  }
  if (batch.sending) {
    res.status(409).json({ success: false, error: 'already_sending', message: `Batch ${batch.code} is already being posted.` });
    return;
  }
  const owner = isOwnerCaller(req);
  const agentSession = owner ? undefined : (readAgentSessionHeader(req) ?? UNIDENTIFIED_SENDER);
  const decision = decideBatchSend({
    batch,
    agentSession,
    ownerMessagesSince: (since) => getChatV2Service().getRecentOwnerMessageContents(since, DOC_COMMENT_CONFIRM_SCAN_LIMIT),
    now: Date.now(),
  });
  if (!decision.allowed) {
    logger.warn('Agent doc comment batch send refused', { code: batch.code, agentSession, reason: decision.reason });
    res.status(403).json({
      success: false,
      error: 'needs_owner_confirmation',
      reason: decision.reason,
      message: buildBatchRefusalMessage(batch.code, decision.reason),
    });
    return;
  }

  batch.sending = true;
  const posted: Array<{ action: string; docId: string; commentId?: string; id?: string }> = [];
  try {
    while (batch.items.length > 0) {
      const item = batch.items[0];
      const deps = depsForAccount(item.account);
      try {
        if (item.action === 'add') {
          const r = await deps.docComments.add(item.docId, item.text ?? '', item.quote);
          posted.push({ action: 'add', docId: r.docId, id: r.id });
        } else if (item.action === 'reply') {
          const r = await deps.docComments.reply(item.docId, item.commentId ?? '', item.text ?? '');
          posted.push({ action: 'reply', docId: r.docId, commentId: r.commentId, id: r.id });
        } else {
          const r = await deps.docComments.resolve(item.docId, item.commentId ?? '', item.text);
          posted.push({ action: 'resolve', docId: r.docId, commentId: r.commentId, id: r.id });
        }
        batch.items.shift();
      } catch (err) {
        logger.warn('Doc comment batch stopped on a failure', { code: batch.code, posted: posted.length, remaining: batch.items.length });
        if (posted.length === 0) {
          // Any reconnect card must name the account the item acted as.
          if (item.account) req.query.account = item.account;
          await sendGoogleError(req, res, err);
        } else {
          res.status(207).json({
            success: false,
            error: 'partial',
            message: `Posted ${posted.length}, stopped on the next one: ${err instanceof Error ? err.message : String(err)}. ${batch.items.length} still queued under ${batch.code}; send again to retry them.`,
            data: { batch: batch.code, posted: posted.length, remaining: batch.items.length, results: posted },
          });
        }
        return;
      }
    }
    clearDocCommentBatch(batch.code);
    logger.info('Doc comment batch posted', { code: batch.code, posted: posted.length, via: decision.via });
    res.json({ success: true, data: { batch: batch.code, posted: posted.length, remaining: 0, results: posted } });
  } finally {
    batch.sending = false;
  }
}

/**
 * POST /api/google/doc-comment-batches/:code/discard — drop a queued batch.
 * Safe for anyone: it only removes comments that would have been posted.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export function docCommentBatchDiscard(req: Request, res: Response): void {
  const batch = getDocCommentBatch(String(req.params.code ?? ''));
  if (!batch) {
    res.status(404).json({ success: false, error: 'not_found', message: `No queued comment batch ${req.params.code}` });
    return;
  }
  if (batch.sending) {
    res.status(409).json({ success: false, error: 'already_sending', message: `Batch ${batch.code} is being posted.` });
    return;
  }
  clearDocCommentBatch(batch.code);
  logger.info('Doc comment batch discarded', { code: batch.code, dropped: batch.items.length });
  res.json({ success: true, data: { discarded: true, batch: batch.code, dropped: batch.items.length } });
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/**
 * GET /api/google/sheets/:id — title + tabs.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function sheetsInfo(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await depsForRequest(req).sheets.info(String(req.params.id ?? '')) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/sheets/:id/values?range= — cell values.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function sheetsRead(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await depsForRequest(req).sheets.read(String(req.params.id ?? ''), q(req, 'range') || undefined) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/sheets — body `{ title, sheetTitle?, rows? }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function sheetsCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { title?: string; sheetTitle?: string; rows?: SheetCell[][] };
    const info = await depsForRequest(req).sheets.create({ title: String(body.title ?? ''), sheetTitle: body.sheetTitle, rows: body.rows });
    logger.info('Google Sheet created', { id: info.id, title: info.title });
    res.json({ success: true, data: info });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/sheets/:id/values — body `{ range?, rows, mode?: 'append' | 'update' }`
 * (default append).
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function sheetsWrite(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { range?: string; rows?: SheetCell[][]; mode?: string };
    const input = { spreadsheetId: String(req.params.id ?? ''), range: body.range, rows: body.rows as SheetCell[][] };
    const result = body.mode === 'update' ? await depsForRequest(req).sheets.update(input) : await depsForRequest(req).sheets.append(input);
    res.json({ success: true, data: { mode: body.mode === 'update' ? 'update' : 'append', ...result } });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------

/**
 * GET /api/google/slides/:id — deck as text per slide.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function slidesRead(req: Request, res: Response): Promise<void> {
  try {
    res.json({ success: true, data: await depsForRequest(req).slides.read(String(req.params.id ?? '')) });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * POST /api/google/slides — body `{ title, slides: [{ title, bullets? }] }`.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function slidesCreate(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as { title?: string; slides?: SlideOutline[] };
    const deck = await depsForRequest(req).slides.create({ title: String(body.title ?? ''), slides: Array.isArray(body.slides) ? body.slides : [] });
    logger.info('Google Slides deck created', { id: deck.id, title: deck.title, slides: deck.slideCount });
    res.json({ success: true, data: deck });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}

/**
 * Read the instruction an agent cites for an irreversible action.
 *
 * HTTP headers are Latin-1, and these citations quote what the owner
 * actually said — which here is routinely Chinese, and in general is
 * whatever language the two of them speak. So the skill base64-encodes it
 * behind a `b64:` marker and we decode here. A bare value is still accepted,
 * for the ASCII case and for anything calling by hand.
 *
 * @param req - Incoming request
 * @returns The citation, or undefined when none was given
 */
function readAuthorizationClaim(req: Request): string | undefined {
  const raw = req.headers['x-agent-authorization'];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  if (!raw.startsWith('b64:')) return raw;
  try {
    const decoded = Buffer.from(raw.slice(4), 'base64').toString('utf-8');
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    // Keep the raw value rather than losing the citation entirely — a
    // mangled claim is still evidence that a claim was made.
    return raw;
  }
}

/**
 * GET /api/google/gmail/held — mail an agent has drafted and is waiting to send.
 *
 * Each entry carries the instruction the agent cited when it tried, captured
 * at that moment. An entry with no citation is an attempt that named nothing.
 *
 * @param _req - Incoming request
 * @param res - Response
 */
export function gmailListHeld(_req: Request, res: Response): void {
  res.json({ success: true, data: { held: listHeldSends() } });
}

/**
 * POST /api/google/gmail/held/:id — the owner answers a held send.
 *
 * Body `{ decision: 'send' | 'discard' }`. Sending goes through the draft
 * the owner can already see, so what leaves is exactly what they reviewed —
 * including any edits they made in Gmail.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailResolveHeld(req: Request, res: Response): Promise<void> {
  try {
    const decision = (req.body as { decision?: string } | undefined)?.decision;
    if (decision !== 'send' && decision !== 'discard') {
      res.status(400).json({ success: false, error: "decision must be 'send' or 'discard'" });
      return;
    }

    const entry = getHeldSend(req.params.id);
    if (!entry) {
      res.status(404).json({ success: false, error: 'No such held message' });
      return;
    }

    if (decision === 'discard') {
      // The one place a draft is deleted: the owner's explicit Discard.
      await depsForRequest(req).gmail.deleteDraft(entry.draftId).catch((err) => logger.warn('Could not delete a discarded draft', { id: entry.id, error: err instanceof Error ? err.message : String(err) }));
      if (entry.decisionId && sendApproval) await sendApproval.discarded(entry.id);
      clearHeldSend(entry.id);
      logger.info('Owner discarded a held send', { id: entry.id, to: entry.to });
      recordActivity({ actor: actorFromRequest(req), action: 'send.gmail.discarded', target: { type: 'gmail_draft', id: entry.draftId, name: entry.subject }, after: { to: entry.to, draftedBy: entry.agentSession } });
      res.json({ success: true, data: { discarded: true, draftId: entry.draftId } });
      return;
    }

    // With a card, the answer goes through it so the card and the send agree
    // (and the draft is checked against what the card showed).
    if (entry.decisionId && sendApproval) {
      const answered = await sendApproval.answerFromOwner(entry.id, 'send');
      if (answered) {
        res.json({ success: true, data: { resolved: true, sent: !getHeldSend(entry.id), draftId: entry.draftId } });
        return;
      }
    }

    // Send the draft rather than rebuilding the message, so what goes out is
    // what the owner looked at — including anything they edited in Gmail.
    const sent = await depsForRequest(req).gmail.sendDraft(entry.draftId);
    clearHeldSend(entry.id);
    // One owner approval covers exactly the one message they reviewed — it must
    // not also pre-approve the agent's next, unreviewed send (#882).
    logger.info('Owner approved a held send', { id: entry.id, to: entry.to, messageId: sent.id });
    recordActivity({ actor: actorFromRequest(req), action: 'send.gmail', target: { type: 'gmail_draft', id: entry.draftId, name: entry.subject }, after: { to: entry.to, messageId: sent.id, threadId: sent.threadId, draftedBy: entry.agentSession } });
    res.json({ success: true, data: sent });
  } catch (err) {
    await sendGoogleError(req, res, err);
  }
}


/**
 * POST /api/google/gmail/watch — body `{ threadId }`. Wake the calling agent
 * when a reply lands in that thread (`gmail:reply_received`).
 *
 * @param req - Incoming request (agent session from X-Agent-Session)
 * @param res - Response
 */
export async function gmailWatchThread(req: Request, res: Response): Promise<void> {
  try {
    const threadId = String((req.body as { threadId?: unknown } | undefined)?.threadId ?? '').trim();
    const session = readAgentSessionHeader(req);
    if (!threadId) {
      res.status(400).json({ success: false, error: 'threadId is required' });
      return;
    }
    if (!session) {
      res.status(400).json({ success: false, error: 'X-Agent-Session is required: the watch wakes that agent' });
      return;
    }
    if (!replyWatch) {
      res.status(503).json({ success: false, error: 'Reply watching is not running' });
      return;
    }
    const w = await replyWatch.watch(threadId, session, typeof req.query.account === 'string' ? req.query.account : req.get('X-Google-Account') ?? undefined);
    res.json({ success: true, data: { threadId: w.threadId, ownerSession: w.ownerSession, event: 'gmail:reply_received' } });
  } catch (err) {
    sendGoogleError(req, res, err);
  }
}

/**
 * GET /api/google/gmail/watches — the calling agent's watched threads.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailListWatches(req: Request, res: Response): Promise<void> {
  const session = readAgentSessionHeader(req);
  const list = (await replyWatch?.list(session)) ?? [];
  res.json({ success: true, data: { watches: list.map((w) => ({ threadId: w.threadId, ownerSession: w.ownerSession, createdAt: w.createdAt })) } });
}

/**
 * DELETE /api/google/gmail/watch/:threadId — stop watching a thread.
 *
 * @param req - Incoming request
 * @param res - Response
 */
export async function gmailUnwatchThread(req: Request, res: Response): Promise<void> {
  const session = readAgentSessionHeader(req);
  const removed = session ? ((await replyWatch?.unwatch(String(req.params.threadId ?? ''), session)) ?? false) : false;
  res.json({ success: true, data: { removed } });
}
