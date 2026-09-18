/**
 * Gmail Service
 *
 * Search, read and send on the owner's mailbox through the Gmail REST API
 * with a Cloud-minted access token. Messages are built locally as RFC 822
 * and sent base64url-encoded; bodies are decoded here; attachments are
 * listed but never downloaded.
 *
 * @module services/google/gmail.service
 */

import { GOOGLE_WORKSPACE_CONSTANTS } from '../../constants.js';
import { GoogleWorkspaceError } from './google-workspace-token.service.js';
import { buildGoogleUrl, googleRequest, type GoogleApiDeps } from './google-api.client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One search hit (metadata only). */
export interface GmailSearchHit {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
}

/** An attachment reference — name/type/size only, never the bytes. */
export interface GmailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/** A fully read message. */
export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  /** RFC 822 Message-ID header (for replies) */
  messageId: string;
  snippet: string;
  /** Decoded body text */
  body: string;
  /** Which part the body came from */
  bodyType: 'text' | 'html' | 'none';
  attachments: GmailAttachment[];
  labelIds: string[];
}

/** Input to {@link GmailService.search}. */
export interface GmailSearchInput {
  query: string;
  max?: number;
}

/** Input to {@link GmailService.send}. */
export interface GmailSendInput {
  to: string;
  cc?: string;
  subject: string;
  text: string;
  /** Gmail thread to append to */
  threadId?: string;
  /** RFC 822 Message-ID of the message being answered */
  inReplyTo?: string;
}

/** Result of {@link GmailService.send}. */
export interface GmailSendResult {
  id: string;
  threadId: string;
  labelIds: string[];
}

// ---------------------------------------------------------------------------
// Gmail wire types (subset)
// ---------------------------------------------------------------------------

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailWireMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate?: number;
}

// ---------------------------------------------------------------------------
// Encoding helpers (exported for the tests and the controller's dry-run)
// ---------------------------------------------------------------------------

/**
 * Standard base64url without padding — what `messages.send` expects in `raw`.
 *
 * @param input - Bytes or UTF-8 string
 * @returns base64url string
 */
export function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Decode Gmail's base64url body data (tolerates standard base64 too).
 *
 * @param data - base64url string
 * @returns UTF-8 text
 */
export function base64UrlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * RFC 2047 encoded-word for a header value that is not plain printable
 * ASCII (a Chinese subject, an emoji); ASCII values are left untouched.
 *
 * @param value - Header value
 * @returns The value as it should appear on the wire
 */
export function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/**
 * Wrap a base64 body at the RFC 2045 line width.
 *
 * @param base64 - Unwrapped base64
 * @returns CRLF-wrapped base64
 */
function wrapBase64(base64: string): string {
  const width = GOOGLE_WORKSPACE_CONSTANTS.MIME_LINE_WIDTH;
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += width) lines.push(base64.slice(i, i + width));
  return lines.join('\r\n');
}

/**
 * Build the RFC 822 message for {@link GmailService.send}. The From header is
 * left to Gmail (it fills in the authenticated user); the body is UTF-8
 * text/plain, base64 transfer-encoded so any script is safe on the wire.
 *
 * @param input - Recipients, subject, body, optional reply threading
 * @returns The raw message with CRLF line endings
 * @throws GoogleWorkspaceError(400, validation) when `to` or `subject` is empty
 */
export function buildRfc822(input: GmailSendInput): string {
  const CODES = GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES;
  if (!input.to?.trim()) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"to" is required');
  if (!input.subject?.trim()) throw new GoogleWorkspaceError(400, CODES.VALIDATION, '"subject" is required');

  const headers: string[] = [`To: ${input.to.trim()}`];
  if (input.cc?.trim()) headers.push(`Cc: ${input.cc.trim()}`);
  headers.push(`Subject: ${encodeHeaderValue(input.subject.trim())}`);
  if (input.inReplyTo?.trim()) {
    const ref = input.inReplyTo.trim();
    headers.push(`In-Reply-To: ${ref}`, `References: ${ref}`);
  }
  headers.push(
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  );
  const body = wrapBase64(Buffer.from(input.text ?? '', 'utf8').toString('base64'));
  return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

/**
 * Very small HTML → text: drop scripts/styles, turn block boundaries into
 * newlines, strip tags, unescape the common entities, collapse blank runs.
 * Only used when a message has no text/plain part.
 *
 * @param html - HTML source
 * @returns Plain text
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Case-insensitive header lookup.
 *
 * @param headers - Gmail header list
 * @param name - Header name
 * @returns Value or empty string
 */
function header(headers: GmailHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? '';
}

/**
 * Walk a MIME tree depth-first.
 *
 * @param part - Root part
 * @param visit - Callback per part
 */
function walkParts(part: GmailPart | undefined, visit: (p: GmailPart) => void): void {
  if (!part) return;
  visit(part);
  for (const child of part.parts ?? []) walkParts(child, visit);
}

/**
 * Pick the body: first text/plain part with inline data, else first text/html
 * (stripped), else nothing.
 *
 * @param payload - Message payload
 * @returns Body text and which kind it was
 */
function extractBody(payload: GmailPart | undefined): { body: string; bodyType: GmailMessage['bodyType'] } {
  let plain: string | undefined;
  let html: string | undefined;
  walkParts(payload, (p) => {
    if (p.filename || !p.body?.data) return;
    const mime = (p.mimeType ?? '').toLowerCase();
    if (mime === 'text/plain' && plain === undefined) plain = base64UrlDecode(p.body.data);
    else if (mime === 'text/html' && html === undefined) html = base64UrlDecode(p.body.data);
  });
  if (plain !== undefined) return { body: plain, bodyType: 'text' };
  if (html !== undefined) return { body: stripHtml(html), bodyType: 'html' };
  return { body: '', bodyType: 'none' };
}

/**
 * Every part that carries a filename and an attachmentId.
 *
 * @param payload - Message payload
 * @returns Attachment references
 */
function extractAttachments(payload: GmailPart | undefined): GmailAttachment[] {
  const out: GmailAttachment[] = [];
  walkParts(payload, (p) => {
    if (p.filename && p.body?.attachmentId) {
      out.push({
        filename: p.filename,
        mimeType: p.mimeType ?? 'application/octet-stream',
        size: p.body.size ?? 0,
        attachmentId: p.body.attachmentId,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Gmail operations on the signed-in owner's mailbox.
 *
 * @example
 * ```ts
 * const gmail = new GmailService({ tokens: GoogleWorkspaceTokenService.getInstance() });
 * const hits = await gmail.search({ query: 'is:unread newer_than:1d' });
 * ```
 */
export class GmailService {
  private readonly deps: GoogleApiDeps;
  private readonly base = GOOGLE_WORKSPACE_CONSTANTS.GMAIL_API_BASE;

  /**
   * @param deps - Token provider and optional fetch override
   */
  constructor(deps: GoogleApiDeps) {
    this.deps = deps;
  }

  /**
   * Gmail search (`messages.list`) followed by one metadata `messages.get`
   * per hit for From / To / Subject / Date and the snippet.
   *
   * @param input - Gmail query string and result cap
   * @returns Hits in Gmail's order (newest first)
   * @throws GoogleWorkspaceError on auth / Google failures
   */
  async search(input: GmailSearchInput): Promise<GmailSearchHit[]> {
    const query = (input.query ?? '').trim();
    const max = clampMax(input.max, GOOGLE_WORKSPACE_CONSTANTS.GMAIL_DEFAULT_MAX_RESULTS, GOOGLE_WORKSPACE_CONSTANTS.GMAIL_MAX_RESULTS_CEILING);

    const list = await googleRequest<GmailListResponse>(
      this.deps,
      buildGoogleUrl(`${this.base}/messages`, { q: query, maxResults: max }),
    );
    const refs = list.messages ?? [];
    if (refs.length === 0) return [];

    const messages = await Promise.all(
      refs.map((ref) =>
        googleRequest<GmailWireMessage>(
          this.deps,
          buildGoogleUrl(`${this.base}/messages/${encodeURIComponent(ref.id)}`, {
            format: 'metadata',
            metadataHeaders: [...GOOGLE_WORKSPACE_CONSTANTS.GMAIL_SEARCH_HEADERS],
          }),
        ),
      ),
    );

    return messages.map((m) => {
      const h = m.payload?.headers;
      return {
        id: m.id,
        threadId: m.threadId,
        from: header(h, 'From'),
        to: header(h, 'To'),
        subject: header(h, 'Subject'),
        date: header(h, 'Date'),
        snippet: m.snippet ?? '',
        labelIds: m.labelIds ?? [],
      };
    });
  }

  /**
   * Full `messages.get`; body decoded (text/plain preferred, stripped
   * text/html as fallback), attachments listed only.
   *
   * @param id - Gmail message id
   * @returns The message
   * @throws GoogleWorkspaceError — 404 when Gmail has no such message
   */
  async read(id: string): Promise<GmailMessage> {
    if (!id?.trim()) {
      throw new GoogleWorkspaceError(400, GOOGLE_WORKSPACE_CONSTANTS.ERROR_CODES.VALIDATION, 'message id is required');
    }
    const m = await googleRequest<GmailWireMessage>(
      this.deps,
      buildGoogleUrl(`${this.base}/messages/${encodeURIComponent(id.trim())}`, { format: 'full' }),
    );
    const h = m.payload?.headers;
    const { body, bodyType } = extractBody(m.payload);
    return {
      id: m.id,
      threadId: m.threadId,
      from: header(h, 'From'),
      to: header(h, 'To'),
      cc: header(h, 'Cc'),
      subject: header(h, 'Subject'),
      date: header(h, 'Date'),
      messageId: header(h, 'Message-ID'),
      snippet: m.snippet ?? '',
      body,
      bodyType,
      attachments: extractAttachments(m.payload),
      labelIds: m.labelIds ?? [],
    };
  }

  /**
   * `messages.send` with a locally built RFC 822 message.
   *
   * @param input - Recipients, subject, text and optional reply threading
   * @returns The sent message's id / threadId / labels
   * @throws GoogleWorkspaceError(400, validation) for missing to/subject; auth / Google failures
   */
  async send(input: GmailSendInput): Promise<GmailSendResult> {
    const raw = base64UrlEncode(buildRfc822(input));
    const body: { raw: string; threadId?: string } = { raw };
    if (input.threadId?.trim()) body.threadId = input.threadId.trim();

    const sent = await googleRequest<GmailWireMessage>(this.deps, `${this.base}/messages/send`, { method: 'POST', body });
    return { id: sent.id, threadId: sent.threadId, labelIds: sent.labelIds ?? [] };
  }
}

/**
 * Coerce a caller-supplied result cap into [1, ceiling], defaulting when
 * absent or not a number.
 *
 * @param value - Requested cap
 * @param fallback - Default
 * @param ceiling - Hard maximum
 * @returns The cap to send to Google
 */
export function clampMax(value: number | undefined, fallback: number, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), 1), ceiling);
}
