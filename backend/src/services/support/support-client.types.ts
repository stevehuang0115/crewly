/**
 * Types and pure helpers of the support CLIENT: the side of support access
 * where agents of an account that RECEIVED a grant read the granting
 * account's machine (crewly#1558).
 *
 * Everything an agent can ask for is one of four reads, and the path of each
 * is built here from validated pieces. Nothing an agent types reaches the
 * relay as a path.
 *
 * `specs/2026-11-12-support-access-agent-read.md`
 *
 * @module services/support/support-client.types
 */

import { SUPPORT_ACCESS_CONSTANTS, SUPPORT_VIEW_CONSTANTS } from '../../constants.js';

const V = SUPPORT_VIEW_CONSTANTS;
const F = V.FAILURES;

/** Why a support read failed. */
export type SupportViewFailureCode = (typeof SUPPORT_VIEW_CONSTANTS.FAILURES)[keyof typeof SUPPORT_VIEW_CONSTANTS.FAILURES];

/** HTTP status the local API answers with, per failure. */
export const SUPPORT_VIEW_STATUS: Readonly<Record<SupportViewFailureCode, number>> = {
  [F.ACCESS_ENDED]: 403,
  [F.AGENT_ACCESS_OFF]: 403,
  [F.READ_ONLY]: 403,
  [F.NOT_ALLOWED]: 403,
  [F.RATE_LIMITED]: 429,
  [F.OFFLINE]: 504,
  [F.DISABLED]: 403,
  [F.NOT_FOUND]: 404,
  [F.NOT_CONNECTED]: 503,
  [F.TURNED_OFF_HERE]: 403,
  [F.OWNER_ONLY]: 403,
  [F.CHOOSE]: 409,
  [F.CLOUD_UNSUPPORTED]: 501,
  [F.INVALID]: 400,
  [F.FAILED]: 502,
};

/** Plain words for each failure (the skill prints them). */
export const SUPPORT_VIEW_TEXT: Readonly<Record<SupportViewFailureCode, string>> = {
  [F.ACCESS_ENDED]: 'Support access to that account has ended or was never given.',
  [F.AGENT_ACCESS_OFF]: 'The other account has not turned on access for agents. A person can still look in the portal under Access.',
  [F.READ_ONLY]: 'Agents can only read through support access. A person restarts agents in the portal under Access.',
  [F.NOT_ALLOWED]: 'Agents may read conversations, agents and errors only.',
  [F.RATE_LIMITED]: 'Too many requests. Wait a minute and try again.',
  [F.OFFLINE]: 'That machine is offline or did not answer.',
  [F.DISABLED]: 'The owner of that machine has turned support access off on it.',
  [F.NOT_FOUND]: 'Not found on that machine.',
  [F.NOT_CONNECTED]: 'This machine is not connected to Crewly Cloud, so it cannot reach the other account.',
  [F.TURNED_OFF_HERE]: 'The owner of this machine has turned off agent use of support access (Settings, support.allowAgentViews).',
  [F.OWNER_ONLY]: 'Support access belongs to the owner of this account. Only work done for the owner may use it.',
  [F.CHOOSE]: 'More than one match. Name the grant or the machine.',
  [F.CLOUD_UNSUPPORTED]: 'This Crewly Cloud does not support agent access yet.',
  [F.INVALID]: 'That value is not accepted.',
  [F.FAILED]: 'The read failed.',
};

/** A failed support read. */
export class SupportViewError extends Error {
  /**
   * @param code - Failure
   * @param message - Plain words (default: the failure's standard text)
   * @param choices - For `choose`: what may be named
   */
  constructor(
    readonly code: SupportViewFailureCode,
    message?: string,
    readonly choices?: string[],
  ) {
    super(message ?? SUPPORT_VIEW_TEXT[code]);
    this.name = 'SupportViewError';
  }

  /** HTTP status of the local API answer. */
  get status(): number {
    return SUPPORT_VIEW_STATUS[this.code];
  }
}

/** A grant this account received, as agents see it. */
export interface SupportViewGrant {
  id: string;
  /** Email of the account that gave access */
  grantorEmail: string;
  /** Its display name, when Cloud has one */
  grantorName?: string;
  role: 'viewer' | 'admin';
  includePrivate: boolean;
  /** Whether the grantor turned on access for agents; undefined when Cloud did not say */
  agentAccess?: boolean;
  /** The one machine the grant is limited to, or null for all */
  instanceId: string | null;
  expiresAt?: string;
}

/** A machine a grant reaches. */
export interface SupportViewMachine {
  instanceId: string;
  deviceName: string;
  /** Relay queue of the machine; kept inside the backend, never shown to an agent */
  relayQueueId: string;
  lastSeenAt?: string;
  live: boolean;
}

/** One read an agent may ask for. */
export type SupportRead =
  | { area: 'agents' }
  | { area: 'conversations'; limit?: number }
  | { area: 'messages'; conversationId: string; limit?: number; older?: string }
  | { area: 'errors'; limit?: number };

/**
 * A whole number inside 1..max, or the default.
 *
 * @param value - Raw value (number or numeric string)
 * @param fallback - Default
 * @param max - Upper bound
 * @returns The bounded number
 */
export function boundedCount(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,6}$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * The relay path of a read, built from validated pieces only.
 *
 * @param read - What to read
 * @returns Path relative to `/api`, starting `/support/`
 * @throws SupportViewError `invalid` for a conversation id or cursor that is not a clean value
 *
 * @example
 * ```typescript
 * buildSupportReadPath({ area: 'messages', conversationId: 'slack-C1', older: 'eyJzZXEiOjF9' });
 * // '/support/conversations/slack-C1/messages?limit=30&direction=backward&cursor=eyJzZXEiOjF9'
 * ```
 */
export function buildSupportReadPath(read: SupportRead): string {
  const prefix = SUPPORT_ACCESS_CONSTANTS.PATH_PREFIX;
  switch (read.area) {
    case V.AREAS.AGENTS:
      return `${prefix}agents`;
    case V.AREAS.CONVERSATIONS:
      return `${prefix}conversations?limit=${boundedCount(read.limit, V.DEFAULT_CONVERSATIONS, V.MAX_CONVERSATIONS)}`;
    case V.AREAS.ERRORS:
      return `${prefix}errors?limit=${boundedCount(read.limit, V.DEFAULT_ERROR_LINES, V.MAX_ERROR_LINES)}`;
    case V.AREAS.MESSAGES: {
      const id = read.conversationId;
      if (typeof id !== 'string' || !V.CONVERSATION_ID_PATTERN.test(id) || id === '.' || id === '..') {
        throw new SupportViewError(F.INVALID, 'That conversation id is not accepted. Use an id from the conversations list.');
      }
      if (read.older !== undefined && (typeof read.older !== 'string' || !V.CURSOR_PATTERN.test(read.older))) {
        throw new SupportViewError(F.INVALID, 'That cursor is not accepted. Use the "older" value of the previous page.');
      }
      const limit = boundedCount(read.limit, V.DEFAULT_MESSAGES, V.MAX_MESSAGES);
      return `${prefix}conversations/${id}/messages?limit=${limit}&direction=backward${read.older ? `&cursor=${read.older}` : ''}`;
    }
    default:
      throw new SupportViewError(F.NOT_ALLOWED);
  }
}

/**
 * The name an agent request carries: the agent's display name reduced to the
 * characters the relay accepts, else its session name, else `agent`.
 *
 * @param displayName - Member name (may hold any characters)
 * @param session - Session name, used when the display name leaves nothing
 * @returns 1..64 characters of `[A-Za-z0-9 ._-]`
 */
export function supportAgentName(displayName: string | undefined, session: string | undefined): string {
  const clean = (v: string | undefined): string =>
    (v ?? '')
      .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SUPPORT_ACCESS_CONSTANTS.AGENT_NAME_MAX_CHARS)
      .trim();
  return clean(displayName) || clean(session) || 'agent';
}

/**
 * The failure a relay refusal of the send means.
 *
 * @param status - HTTP status of the relay's answer
 * @param code - `code` of its JSON error body, when any
 * @returns Failure
 */
export function failureFromRelay(status: number, code: string | null): SupportViewFailureCode {
  const R = V.RELAY_CODES;
  if (code === R.AGENT_ACCESS_OFF) return F.AGENT_ACCESS_OFF;
  if (code === R.AGENT_READ_ONLY || code === R.METHOD) return F.READ_ONLY;
  if (code === R.AGENT_PATH || code === R.PATH) return F.NOT_ALLOWED;
  if (code === R.AGENT_RATE_LIMITED || status === 429) return F.RATE_LIMITED;
  // A 404 is "Peer queue not found": no active grant reaches that machine.
  if (status === 404 || status === 403) return F.ACCESS_ENDED;
  if (status === 401) return F.NOT_CONNECTED;
  return F.FAILED;
}

/**
 * The failure a non-2xx answer of the granted machine means.
 *
 * @param status - `status` of the `api_response`
 * @param code - `code` of its body, when any
 * @returns Failure
 */
export function failureFromAnswer(status: number, code: string | null): SupportViewFailureCode {
  const C = SUPPORT_ACCESS_CONSTANTS.CODES;
  if (code === C.DISABLED) return F.DISABLED;
  if (code === C.NOT_FOUND || status === 404) return F.NOT_FOUND;
  if (code === C.AGENT_READ_ONLY || code === C.METHOD) return F.READ_ONLY;
  if (code === C.AGENT_PATH || code === C.PATH) return F.NOT_ALLOWED;
  if (status === 429) return F.RATE_LIMITED;
  return F.FAILED;
}

/**
 * A string field of a Cloud record, trimmed and bounded.
 *
 * @param v - Raw value
 * @returns The string, or '' when it is not one
 */
function text(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 512) : '';
}

/**
 * The grants this account RECEIVED and may use now, from Cloud's
 * received-grants list. Cloud lists active grants only; a row that names
 * another status is dropped all the same.
 *
 * @param data - `data` of `GET /api/cloud/support-grants/received` (`{ grants }`)
 * @returns Active received grants (malformed rows dropped)
 */
export function parseReceivedGrants(data: unknown): SupportViewGrant[] {
  const rows = (data as { grants?: unknown } | null | undefined)?.grants;
  if (!Array.isArray(rows)) return [];
  const out: SupportViewGrant[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = text(r['id']);
    if (!id || (r['status'] !== undefined && r['status'] !== V.ACTIVE_STATUS)) continue;
    const role = r['role'] === 'admin' ? 'admin' : 'viewer';
    const instanceId = text(r['instanceId']);
    out.push({
      id,
      grantorEmail: text(r['grantorEmail']).toLowerCase(),
      ...(text(r['grantorDisplayName']) ? { grantorName: text(r['grantorDisplayName']) } : {}),
      role,
      includePrivate: r['includePrivate'] === true,
      ...(typeof r['agentAccess'] === 'boolean' ? { agentAccess: r['agentAccess'] } : {}),
      instanceId: instanceId || null,
      ...(text(r['expiresAt']) ? { expiresAt: text(r['expiresAt']) } : {}),
    });
  }
  return out;
}

/**
 * The machines of one grant, from Cloud.
 *
 * @param data - `data` of `GET /api/cloud/support-grants/:id/instances` (`{ instances }`)
 * @returns Machines (one without a relay queue has `relayQueueId: ''` and cannot be reached)
 */
export function parseGrantMachines(data: unknown): SupportViewMachine[] {
  const rows = (data as { instances?: unknown } | null | undefined)?.instances;
  if (!Array.isArray(rows)) return [];
  const out: SupportViewMachine[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const instanceId = text(r['instanceId']);
    if (!instanceId) continue;
    out.push({
      instanceId,
      deviceName: text(r['deviceName']) || instanceId,
      relayQueueId: text(r['relayQueueId']),
      ...(text(r['lastSeenAt']) ? { lastSeenAt: text(r['lastSeenAt']) } : {}),
      live: r['live'] === true,
    });
  }
  return out;
}

/**
 * The private-source person id of a grantor account: what an agent read
 * through the grant is that account's data.
 *
 * @param grant - The grant read through
 * @returns `support:<grantor email>`, or `support:<grant id>` when Cloud gave no email
 */
export function supportSourcePersonId(grant: Pick<SupportViewGrant, 'id' | 'grantorEmail'>): string {
  return `${V.PRIVATE_SOURCE_PERSON_PREFIX}${grant.grantorEmail || grant.id}`;
}
