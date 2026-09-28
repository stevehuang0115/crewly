/**
 * Wire contract of Crewly Cloud's conversation ingest endpoint — the single
 * place to adjust if the Cloud side changes shape
 * (specs/unified-conversations-cloud-store.md §B.2). Mirrors the auth
 * service's `conversations/contract.ts`; change both together.
 *
 * ```http
 * POST <cloudUrl>/api/cloud/conversations/ingest
 * Authorization: Bearer <the machine's cloud access token>
 * Content-Type: application/json
 * Content-Encoding: gzip
 * ```
 *
 * - `200 { success, ackedThroughLocalSeq, accepted, duplicates, updated, deleted,
 *   filtered, expired, rejected, errors?, capped, retentionDays }` — every
 *   message up to `ackedThroughLocalSeq` is settled (rejected ones included).
 * - `400 invalid_batch` · `401` · `403 sync_disabled` · `413 payload_too_large`
 *   · `503 conversations_key_missing` · `404` while Cloud has no such route.
 *
 * @module services/cloud/conversation-ingest.contract
 */

/** Path of the ingest endpoint, relative to the Cloud base URL. */
export const CONVERSATION_INGEST_PATH = '/api/cloud/conversations/ingest';

/** Error codes Cloud returns on ingest. */
export const INGEST_ERROR_CODES = {
  INVALID_BATCH: 'invalid_batch',
  SYNC_DISABLED: 'sync_disabled',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  KEY_MISSING: 'conversations_key_missing',
} as const;

/** Cloud's per-request limits. */
export const INGEST_LIMITS = {
  /** Max messages per batch. */
  MAX_MESSAGES: 500,
  /** Max request body after gzip inflation. */
  MAX_BODY_BYTES: 8 * 1024 * 1024,
} as const;

/** Same shape as a relay queue id (instanceId = deviceId = relay queue id). */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Where a message was said. */
export const CONVERSATION_SOURCES = [
  'slack',
  'crewly-chat',
  'cloud-talk',
  'google-chat',
  'telegram',
  'whatsapp',
  'system',
  'runtime',
] as const;
export type IngestSource = (typeof CONVERSATION_SOURCES)[number];

/** `in` = to an agent, `out` = from an agent, `internal` = neither. */
export const CONVERSATION_DIRECTIONS = ['in', 'out', 'internal'] as const;
export type IngestDirection = (typeof CONVERSATION_DIRECTIONS)[number];

/** `owner` = the account holder; `human` = anybody else. */
export const SENDER_KINDS = ['owner', 'agent', 'human', 'system'] as const;
export type IngestSenderKind = (typeof SENDER_KINDS)[number];

/** Channel kinds. */
export type IngestChannelKind = 'dm' | 'channel' | 'huddle';

/** Whether a batch carries new messages or history. */
export type IngestMode = 'live' | 'backfill';

/** Attachment metadata only — file bytes never leave the machine (O4). */
export interface IngestAttachment {
  kind: string;
  mime?: string;
  size?: number;
  name?: string;
}

/** Platform ids (plaintext on Cloud, used to collapse a Slack message two machines saw). */
export interface IngestExt {
  slackTeamId?: string;
  slackChannelId?: string;
  ts?: string;
  threadTs?: string;
  slackUserId?: string;
  telegramChatId?: string;
  telegramMessageId?: string;
  gchatSpace?: string;
  gchatThread?: string;
  gchatMessage?: string;
  whatsappChatId?: string;
}

/** Insert or replace one message. */
export interface IngestUpsert {
  /** chat-v2 message id — with (account, instanceId) the dedupe key */
  localId: string;
  op: 'upsert';
  channel: { localId: string; kind: IngestChannelKind; name?: string };
  /** The agent this message is to/from (required, never empty) */
  agentSession: string;
  mentions?: string[];
  source: IngestSource;
  direction: IngestDirection;
  senderKind: IngestSenderKind;
  sender: { id: string; name?: string };
  ext?: IngestExt;
  threadLocalId?: string;
  text: string;
  contentType?: string;
  attachments?: IngestAttachment[];
  /** Only for messages that originated in Cloud Talk (`talk-<uuid>`) */
  clientMessageId?: string;
  /** ms since epoch */
  createdAt: number;
  /** `cloud_outbox.seq` (live); 0 for backfilled history */
  localSeq: number;
}

/** Remove one message. */
export interface IngestDelete {
  localId: string;
  localSeq: number;
  op: 'delete';
}

/** One element of `messages`. */
export type IngestMessage = IngestUpsert | IngestDelete;

/** Request body. */
export interface IngestRequest {
  instanceId: string;
  homeId?: string;
  crewlyVersion?: string;
  deviceName?: string;
  batchId?: string;
  mode?: IngestMode;
  messages: IngestMessage[];
  /** Every agent on this machine (Phase 3) — Cloud lists them before they have messages. */
  roster?: AgentRosterEntry[];
  /** What this machine handles (`talk_message`). */
  capabilities?: string[];
}

/** One agent on this machine, as Cloud's `GET /agents` lists it. */
export interface AgentRosterEntry {
  agentSession: string;
  displayName?: string;
  role?: string;
  teamName?: string;
}

/** Parsed 200 response (fields Cloud leaves out come back null / 0). */
export interface IngestResponse {
  /** Highest `localSeq` settled; null for an empty batch */
  ackedThroughLocalSeq: number | null;
  accepted: number;
  duplicates: number;
  updated: number;
  deleted: number;
  filtered: number;
  expired: number;
  rejected: number;
  capped: boolean;
  /** Days Cloud keeps messages for this account (7 free / 90 paid) */
  retentionDays: number | null;
}

/**
 * Read a finite number field.
 *
 * @param obj - Parsed body
 * @param key - Field name
 * @returns The number, or null
 */
function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Parse an ingest 200 body (flat, or wrapped in `{ success, data }`).
 *
 * @param body - Parsed JSON (anything)
 * @returns The response fields
 *
 * @example
 * ```typescript
 * parseIngestResponse({ success: true, ackedThroughLocalSeq: 12, retentionDays: 90 }).retentionDays; // 90
 * ```
 */
export function parseIngestResponse(body: unknown): IngestResponse {
  let obj: Record<string, unknown> = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) obj = obj.data as Record<string, unknown>;
  return {
    ackedThroughLocalSeq: num(obj, 'ackedThroughLocalSeq'),
    accepted: num(obj, 'accepted') ?? 0,
    duplicates: num(obj, 'duplicates') ?? 0,
    updated: num(obj, 'updated') ?? 0,
    deleted: num(obj, 'deleted') ?? 0,
    filtered: num(obj, 'filtered') ?? 0,
    expired: num(obj, 'expired') ?? 0,
    rejected: num(obj, 'rejected') ?? 0,
    capped: obj.capped === true,
    retentionDays: num(obj, 'retentionDays'),
  };
}

/**
 * Read the error code of a failed ingest response (`code`, `error.code`, or
 * a bare `error` string that is a known code).
 *
 * @param body - Parsed JSON (anything)
 * @returns The code, or null
 */
export function parseIngestErrorCode(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.code === 'string') return obj.code;
  if (obj.error && typeof obj.error === 'object') {
    const code = (obj.error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  const known: readonly string[] = Object.values(INGEST_ERROR_CODES);
  if (typeof obj.error === 'string' && known.includes(obj.error)) return obj.error;
  return null;
}

/**
 * Whether a value is one of the given enum values.
 *
 * @param values - Allowed values
 * @param value - Candidate
 * @returns True when allowed
 */
export function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Cloud Talk (Phase 3) — mirrors AUTH:conversations/contract.ts
// ---------------------------------------------------------------------------

/** `clientMessageId` charset Cloud accepts for Talk (a uuid or `talk-<uuid>`). */
export const TALK_CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** `data` of a `talk_message` relay push. No text: it is fetched from Cloud. */
export interface TalkRelayData {
  v: 1;
  /** Cloud's id of the stored message */
  messageId: string;
  clientMessageId: string;
  /** The machine it is for (this machine's device id) */
  instanceId: string;
  agentSession: string;
}

/** `GET /api/cloud/conversations/talk/:messageId?instanceId=` → `data`. */
export interface TalkFetchResponse {
  messageId: string;
  clientMessageId: string;
  instanceId: string;
  agentSession: string;
  text: string;
  inputMode?: 'voice' | 'text';
  createdAt: string;
  delivery: 'queued' | 'sent' | 'delivered' | 'failed';
}

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything
 * @returns True for a non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a value is a non-empty string of at most `max` characters.
 *
 * @param value - Anything
 * @param max - Longest accepted length
 * @returns True when usable as an id
 */
function nonEmpty(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Validate the `data` of a `talk_message` push. Never throws.
 *
 * @param raw - `IncomingMessage.payload`
 * @returns The push, or null when it is not one
 */
export function parseTalkRelayData(raw: unknown): TalkRelayData | null {
  if (!isRecord(raw)) return null;
  const { messageId, clientMessageId, instanceId, agentSession } = raw;
  if (!nonEmpty(messageId, 64) || !nonEmpty(agentSession) || !nonEmpty(instanceId, 128)) return null;
  if (typeof clientMessageId !== 'string' || !TALK_CLIENT_MESSAGE_ID_PATTERN.test(clientMessageId)) return null;
  return { v: 1, messageId, clientMessageId, instanceId, agentSession };
}

/**
 * Validate Cloud's answer to the Talk fetch. Never throws.
 *
 * @param raw - Parsed JSON body
 * @returns The message, or null when the body is not usable
 */
export function parseTalkFetchResponse(raw: unknown): TalkFetchResponse | null {
  const data = isRecord(raw) && isRecord(raw['data']) ? raw['data'] : null;
  if (!data) return null;
  const { messageId, clientMessageId, instanceId, agentSession, text, inputMode, createdAt, delivery } = data;
  if (!nonEmpty(messageId, 64) || !nonEmpty(clientMessageId, 128) || !nonEmpty(instanceId, 128) || !nonEmpty(agentSession)) return null;
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  return {
    messageId,
    clientMessageId,
    instanceId,
    agentSession,
    text,
    ...(inputMode === 'voice' || inputMode === 'text' ? { inputMode } : {}),
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    delivery: delivery === 'queued' || delivery === 'sent' || delivery === 'delivered' || delivery === 'failed' ? delivery : 'sent',
  };
}
