/**
 * Wire shapes of shared channels (crewly#1543): the relay pushes from Cloud and
 * the machine-token endpoints, with guards that never throw.
 *
 * @module services/shared-channel/shared-channel.types
 */

import { SHARED_CHANNEL_CONSTANTS } from '../../constants.js';

/** `data` of a `shared_channel_message` push (no body: it is fetched). */
export interface SharedChannelMessagePush {
  v: 1;
  linkId: string;
  messageId: string;
}

/** `data` of a `shared_channel_revoked` push. */
export interface SharedChannelRevokedPush {
  v: 1;
  linkId: string;
}

/** One link of `GET /api/cloud/shared-channels`. */
export interface SharedChannelLink {
  linkId: string;
  status: 'active' | 'revoked';
  counterpartDisplayName: string;
  counterpartEmail: string;
  acceptedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** One message of `GET /api/cloud/shared-channels/:linkId/messages`. */
export interface SharedChannelMessage {
  id: string;
  linkId: string;
  direction: 'sent' | 'received';
  fromAgentName: string;
  fromTeam: string;
  text: string;
  replyTo?: string;
  createdAt: string;
  deliveredAt?: string;
  status: string;
}

/** A page of history, oldest first. */
export interface SharedChannelPage {
  messages: SharedChannelMessage[];
  hasMore: boolean;
}

/**
 * The chat-v2 channel id of a link: `external-<linkId>`, with characters a
 * channel id cannot carry replaced.
 *
 * @param linkId - Cloud link id
 * @returns Channel id
 */
export function externalChannelIdOf(linkId: string): string {
  return `${SHARED_CHANNEL_CONSTANTS.CHAT_CHANNEL_PREFIX}${linkId.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 120)}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * @param v - A relay payload
 * @returns True for a well-formed `shared_channel_message` data
 */
export function isSharedChannelMessagePush(v: unknown): v is SharedChannelMessagePush {
  return isObj(v) && v['v'] === SHARED_CHANNEL_CONSTANTS.WIRE_VERSION && nonEmpty(v['linkId']) && nonEmpty(v['messageId']);
}

/**
 * @param v - A relay payload
 * @returns True for a well-formed `shared_channel_revoked` data
 */
export function isSharedChannelRevokedPush(v: unknown): v is SharedChannelRevokedPush {
  return isObj(v) && v['v'] === SHARED_CHANNEL_CONSTANTS.WIRE_VERSION && nonEmpty(v['linkId']);
}

/**
 * Parse one link row; null when unusable.
 *
 * @param v - Raw row
 * @returns The link, or null
 */
export function parseSharedChannelLink(v: unknown): SharedChannelLink | null {
  if (!isObj(v) || !nonEmpty(v['linkId'])) return null;
  const status = v['status'];
  if (status !== 'active' && status !== 'revoked') return null;
  const email = typeof v['counterpartEmail'] === 'string' ? v['counterpartEmail'] : '';
  const name = typeof v['counterpartDisplayName'] === 'string' ? v['counterpartDisplayName'] : '';
  return {
    linkId: v['linkId'],
    status,
    counterpartDisplayName: name,
    counterpartEmail: email,
    ...(optStr(v['acceptedAt']) ? { acceptedAt: optStr(v['acceptedAt']) } : {}),
    ...(optStr(v['revokedAt']) ? { revokedAt: optStr(v['revokedAt']) } : {}),
    ...(optStr(v['revokedBy']) ? { revokedBy: optStr(v['revokedBy']) } : {}),
  };
}

/**
 * Parse one message row; null when unusable (no id or no text).
 *
 * @param v - Raw row
 * @returns The message, or null
 */
export function parseSharedChannelMessage(v: unknown): SharedChannelMessage | null {
  if (!isObj(v) || !nonEmpty(v['id']) || !nonEmpty(v['linkId']) || !nonEmpty(v['text'])) return null;
  const direction = v['direction'];
  if (direction !== 'sent' && direction !== 'received') return null;
  return {
    id: v['id'],
    linkId: v['linkId'],
    direction,
    fromAgentName: typeof v['fromAgentName'] === 'string' && v['fromAgentName'] ? v['fromAgentName'] : 'Agent',
    fromTeam: typeof v['fromTeam'] === 'string' ? v['fromTeam'] : '',
    text: v['text'].slice(0, SHARED_CHANNEL_CONSTANTS.MAX_TEXT_LENGTH),
    ...(optStr(v['replyTo']) ? { replyTo: optStr(v['replyTo']) } : {}),
    createdAt: typeof v['createdAt'] === 'string' ? v['createdAt'] : new Date(0).toISOString(),
    ...(optStr(v['deliveredAt']) ? { deliveredAt: optStr(v['deliveredAt']) } : {}),
    status: typeof v['status'] === 'string' ? v['status'] : 'unknown',
  };
}

/**
 * Unwrap Cloud's `{success, data}` envelope. A body without one is returned as is.
 *
 * @param body - JSON body
 * @returns The `data` payload, or the body itself
 */
export function unwrapCloudData(body: unknown): unknown {
  return isObj(body) && 'data' in body ? body['data'] : body;
}

/**
 * Parse a `{links}` answer.
 *
 * @param body - JSON body
 * @returns Usable links (empty for a malformed body)
 */
export function parseSharedChannelLinks(body: unknown): SharedChannelLink[] {
  const rows = isObj(body) && Array.isArray(body['links']) ? body['links'] : [];
  return rows.map(parseSharedChannelLink).filter((l): l is SharedChannelLink => l !== null);
}

/**
 * Parse a `{messages, hasMore}` answer; null when the body is not that shape.
 *
 * @param body - JSON body
 * @returns The page, or null
 */
export function parseSharedChannelPage(body: unknown): SharedChannelPage | null {
  if (!isObj(body) || !Array.isArray(body['messages'])) return null;
  return {
    messages: body['messages'].map(parseSharedChannelMessage).filter((m): m is SharedChannelMessage => m !== null),
    hasMore: body['hasMore'] === true,
  };
}

/** Cloud's answer to `POST /:linkId/messages`. `status` 0 = Cloud could not be reached. */
export type SharedChannelPostAnswer =
  | { ok: true; messageId: string; createdAt: string; duplicate: boolean }
  | { ok: false; status: number; code: string; error: string; retryAfterS?: number };

/**
 * Parse Cloud's answer to a send: `{success:true, data:{message, duplicate}}`
 * (201, or 200 for a retry of a stored id) or `{success:false, error, code}`.
 *
 * @param status - HTTP status
 * @param body - JSON body (null when not JSON)
 * @param retryAfter - `Retry-After` header, if any
 * @returns The outcome
 */
export function parseSharedChannelPostAnswer(status: number, body: unknown, retryAfter?: string | null): SharedChannelPostAnswer {
  if (status >= 200 && status < 300) {
    const data = unwrapCloudData(body);
    const message = isObj(data) && isObj(data['message']) ? parseSharedChannelMessage(data['message']) : null;
    if (message) return { ok: true, messageId: message.id, createdAt: message.createdAt, duplicate: isObj(data) && data['duplicate'] === true };
    return { ok: false, status, code: 'malformed', error: 'Crewly Cloud gave an answer this version does not understand' };
  }
  const code = isObj(body) && typeof body['code'] === 'string' ? body['code'] : `http_${status}`;
  const error = isObj(body) && typeof body['error'] === 'string' && body['error'] ? body['error'] : `Crewly Cloud answered ${status}`;
  const wait = retryAfter ? Number(retryAfter) : NaN;
  return { ok: false, status, code, error, ...(Number.isFinite(wait) && wait > 0 ? { retryAfterS: wait } : {}) };
}
