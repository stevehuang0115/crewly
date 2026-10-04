/**
 * Signed open-links of Crewly Apps (specs/2026-10-04-crewly-apps-p3.md §1).
 *
 * Cloud mints `https://apps.crewlyai.com/<appId>?k=<token>`: whoever holds
 * it opens the app as the owner until it expires or is revoked. So the
 * token goes to exactly one place, the owner-only card, and nowhere else:
 * not into an agent's output, not into a log, not into the Slack context an
 * agent is shown later. These helpers recognise and redact it.
 *
 * @module services/apps/app-open-link
 */

import { CREWLY_APPS_CONSTANTS } from '../../constants.js';

const C = CREWLY_APPS_CONSTANTS;

/** A freshly minted link as Cloud returns it (`POST /apps/:id/open-links`). */
export interface MintedOpenLink {
  linkId: string;
  url: string;
  expiresAt: string;
}

/** One link as Cloud lists it (`GET /apps/:id/open-links`); never carries a token. */
export interface OpenLinkInfo {
  linkId: string;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  uses: number;
  active: boolean;
  createdBy: string | null;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The apps host anywhere in text (fast pre-check). */
const APPS_HOST_RE = new RegExp(escapeRe(new URL(C.APPS_ORIGIN).host), 'i');

/**
 * `k=<token>` in the query of an apps-origin URL, in any surrounding text:
 * Markdown `(…)`, Slack `<…|…>`, plain. Group 1 keeps everything up to the `=`.
 */
const TOKEN_IN_URL_RE = new RegExp(
  `(${escapeRe(C.APPS_ORIGIN)}/[^\\s?#<>|()"']*\\?(?:[^\\s#<>|()"']*&)?${C.OPEN_LINK.TOKEN_PARAM}=)[^\\s&#<>|()"']+`,
  'gi',
);

/**
 * Replace every open-link token in text with `[redacted]`.
 *
 * @param text - Any text (a log line, a context line, a JSON string)
 * @returns The text with tokens removed; other text unchanged
 */
export function redactOpenLinkTokens(text: string): string {
  // Cheap test first: this runs on every log line.
  if (typeof text !== 'string' || !APPS_HOST_RE.test(text)) return text;
  return text.replace(TOKEN_IN_URL_RE, `$1${C.OPEN_LINK.REDACTED}`);
}

/**
 * Whether text still carries an open-link token (tests, assertions).
 *
 * @param text - Text
 * @returns True when a token is present
 */
export function hasOpenLinkToken(text: string): boolean {
  return redactOpenLinkTokens(text) !== text;
}

/**
 * Check a link Cloud minted before it is posted: it must open exactly this
 * app on the apps origin, with a token. Anything else (an old Cloud, a
 * changed origin) is treated as a failed mint, and the plain card goes out.
 *
 * @param appId - The app the link is for
 * @param minted - Cloud's answer
 * @returns The link, or null when it is not usable
 */
export function usableMintedLink(appId: string, minted: unknown): MintedOpenLink | null {
  if (!minted || typeof minted !== 'object') return null;
  const m = minted as Record<string, unknown>;
  if (typeof m.url !== 'string' || typeof m.linkId !== 'string' || !C.OPEN_LINK.LINK_ID_PATTERN.test(m.linkId)) return null;
  let u: URL;
  try {
    u = new URL(m.url);
  } catch {
    return null;
  }
  if (u.origin !== C.APPS_ORIGIN || u.pathname !== `/${appId}` || !u.searchParams.get(C.OPEN_LINK.TOKEN_PARAM)) return null;
  // Card text is Markdown: a URL with spaces or brackets would break the link.
  if (/[\s()[\]<>|]/.test(m.url)) return null;
  return { linkId: m.linkId, url: m.url, expiresAt: typeof m.expiresAt === 'string' ? m.expiresAt : '' };
}

/**
 * Who made a link, as text: Cloud's string, or `kind:id` of an actor object.
 *
 * @param v - Cloud's `createdBy`
 * @returns Text or null
 */
function creatorOf(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const a = v as Record<string, unknown>;
    if (typeof a.kind === 'string') return typeof a.id === 'string' ? `${a.kind}:${a.id}` : a.kind;
  }
  return null;
}

/**
 * Cloud's link list reduced to the documented fields: whatever else Cloud
 * might add (a URL, a token) never reaches the caller.
 *
 * @param list - Cloud's answer
 * @returns Links
 */
export function toOpenLinkInfos(list: unknown): OpenLinkInfo[] {
  if (!Array.isArray(list)) return [];
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return list
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && typeof (l as Record<string, unknown>).linkId === 'string')
    .map((l) => ({
      linkId: l.linkId as string,
      createdAt: str(l.createdAt),
      expiresAt: str(l.expiresAt),
      revokedAt: str(l.revokedAt),
      lastUsedAt: str(l.lastUsedAt),
      uses: typeof l.uses === 'number' ? l.uses : 0,
      active: l.active === true,
      createdBy: creatorOf(l.createdBy),
    }));
}
