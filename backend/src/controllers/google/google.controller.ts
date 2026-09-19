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

import type { Request, Response } from 'express';
import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { LoggerService } from '../../services/core/logger.service.js';
import {
  GoogleWorkspaceTokenService,
  GoogleWorkspaceError,
} from '../../services/google/google-workspace-token.service.js';
import { GmailService, buildRfc822, type GmailSendInput } from '../../services/google/gmail.service.js';
import { CalendarService } from '../../services/google/calendar.service.js';
import { DriveService } from '../../services/google/drive.service.js';
import { DocsService } from '../../services/google/docs.service.js';
import { SheetsService, type SheetCell } from '../../services/google/sheets.service.js';
import { SlidesService, type SlideOutline } from '../../services/google/slides.service.js';

const logger = LoggerService.getInstance().createComponentLogger('GoogleController');

/** The services the handlers use; swappable for tests. */
export interface GoogleControllerDeps {
  tokens: GoogleWorkspaceTokenService;
  gmail: GmailService;
  calendar: CalendarService;
  drive: DriveService;
  docs: DocsService;
  sheets: SheetsService;
  slides: SlidesService;
}

let deps: GoogleControllerDeps | null = null;

/**
 * Lazily build the real services (token service singleton + Gmail/Calendar
 * bound to it).
 *
 * @returns The active dependency set
 */
function getDeps(): GoogleControllerDeps {
  if (!deps) {
    const tokens = GoogleWorkspaceTokenService.getInstance();
    deps = {
      tokens,
      gmail: new GmailService({ tokens }),
      calendar: new CalendarService({ tokens }),
      drive: new DriveService({ tokens }),
      docs: new DocsService({ tokens }),
      sheets: new SheetsService({ tokens }),
      slides: new SlidesService({ tokens }),
    };
  }
  return deps;
}

/**
 * Replace (or, with null, reset) the services the handlers use. Tests only.
 *
 * @param next - Dependency set or null to rebuild lazily
 */
export function setGoogleControllerDeps(next: GoogleControllerDeps | null): void {
  deps = next;
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
    return getDeps().tokens.buildConnectUrl(resolveReturnUrl(req));
  } catch {
    return null;
  }
}

/**
 * Answer a failure with the contract's `{ success:false, error, hint }`
 * shape. `not_connected` carries the consent URL as the hint; the other
 * codes get a one-line next step.
 *
 * @param req - Incoming request (for the connect URL)
 * @param res - Response
 * @param err - The failure
 */
export function sendGoogleError(req: Request, res: Response, err: unknown): void {
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  if (err instanceof GoogleWorkspaceError) {
    let hint: string;
    switch (err.code) {
      case CODES.NOT_CONNECTED:
        hint = connectUrlOrNull(req)
          ?? 'Sign in to Crewly Cloud (Settings → Cloud), then connect Google Workspace under Settings → Integrations.';
        break;
      case CODES.NOT_LOGGED_IN:
        hint = 'Sign in to Crewly Cloud first (Settings → Cloud).';
        break;
      case CODES.NOT_CONFIGURED:
        hint = 'Crewly Cloud is not configured for Google Workspace; nothing to do on this instance.';
        break;
      case CODES.VALIDATION:
        hint = 'Fix the request and retry.';
        break;
      default:
        hint = err.status === 401
          ? 'The Google token was rejected; retry once — the cache has been cleared.'
          : 'Google or Crewly Cloud failed; retry later.';
    }
    res.status(err.status).json({ success: false, error: err.code, message: err.message, hint });
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
    sendGoogleError(req, res, err);
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
    const url = getDeps().tokens.buildConnectUrl(resolveReturnUrl(req));
    res.json({ success: true, data: { url } });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const data = await getDeps().tokens.disconnect();
    res.json({ success: true, data });
  } catch (err) {
    sendGoogleError(req, res, err);
  }
}

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
    const messages = await getDeps().gmail.search({ query, max: qInt(req, 'max') });
    res.json({ success: true, data: { query, count: messages.length, messages } });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const message = await getDeps().gmail.read(String(req.params.id ?? ''));
    res.json({ success: true, data: message });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const sent = await getDeps().gmail.send(input);
    logger.info('Gmail message sent', { id: sent.id, threadId: sent.threadId, to: input.to });
    res.json({ success: true, data: sent });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const events = await getDeps().calendar.listEvents({
      calendarId: q(req, 'calendarId') || undefined,
      timeMin: q(req, 'from') || undefined,
      timeMax: q(req, 'to') || undefined,
      max: qInt(req, 'max'),
    });
    res.json({ success: true, data: { count: events.length, events } });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const event = await getDeps().calendar.createEvent({
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
    sendGoogleError(req, res, err);
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
    const files = await getDeps().drive.search({
      query: q(req, 'q') || undefined,
      mimeType: q(req, 'mimeType') || undefined,
      folderId: q(req, 'folderId') || undefined,
      max: qInt(req, 'max'),
    });
    res.json({ success: true, data: { count: files.length, files } });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    res.json({ success: true, data: await getDeps().drive.get(String(req.params.id ?? '')) });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    res.json({ success: true, data: await getDeps().drive.readContent(String(req.params.id ?? '')) });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const file = await getDeps().drive.upload({
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
    sendGoogleError(req, res, err);
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
    res.json({ success: true, data: await getDeps().docs.read(String(req.params.id ?? '')) });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const doc = await getDeps().docs.create({ title: String(body.title ?? ''), text: typeof body.text === 'string' ? body.text : undefined });
    logger.info('Google Doc created', { id: doc.id, title: doc.title });
    res.json({ success: true, data: doc });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    res.json({ success: true, data: await getDeps().docs.append(String(req.params.id ?? ''), String(body.text ?? '')) });
  } catch (err) {
    sendGoogleError(req, res, err);
  }
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
    res.json({ success: true, data: await getDeps().sheets.info(String(req.params.id ?? '')) });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    res.json({ success: true, data: await getDeps().sheets.read(String(req.params.id ?? ''), q(req, 'range') || undefined) });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const info = await getDeps().sheets.create({ title: String(body.title ?? ''), sheetTitle: body.sheetTitle, rows: body.rows });
    logger.info('Google Sheet created', { id: info.id, title: info.title });
    res.json({ success: true, data: info });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const result = body.mode === 'update' ? await getDeps().sheets.update(input) : await getDeps().sheets.append(input);
    res.json({ success: true, data: { mode: body.mode === 'update' ? 'update' : 'append', ...result } });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    res.json({ success: true, data: await getDeps().slides.read(String(req.params.id ?? '')) });
  } catch (err) {
    sendGoogleError(req, res, err);
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
    const deck = await getDeps().slides.create({ title: String(body.title ?? ''), slides: Array.isArray(body.slides) ? body.slides : [] });
    logger.info('Google Slides deck created', { id: deck.id, title: deck.title, slides: deck.slideCount });
    res.json({ success: true, data: deck });
  } catch (err) {
    sendGoogleError(req, res, err);
  }
}
