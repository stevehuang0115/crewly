/**
 * Unified conversation log — the columns, outbox and migration that make
 * `chat.db` the machine's superset of every conversation surface
 * (specs/unified-conversations-cloud-store.md §A.4).
 *
 * Every message row carries first-class copies of what used to be hidden in
 * `metadata` JSON:
 *
 * - `source`        — which surface it belongs to (slack, crewly-chat, cloud-talk, …)
 * - `direction`     — `in` (to an agent), `out` (from an agent), `internal`
 * - `sender_kind`   — `owner`, `agent`, `human` (someone else), `system`
 * - `agent_session` — the agent the message is to/from (denormalised)
 * - `ext_ref`       — JSON of external ids (Slack workspace/channel/ts/thread, …)
 * - `cloud_sync`    — 1 when the row may leave the machine, 0 when not (owner
 *                     decision O3: other people's chatter in shared Slack
 *                     channels stays local)
 *
 * A trigger on `chat_messages` fills `cloud_outbox` for every syncable insert,
 * so any writer — present or future, through `recordTurn` or not — produces
 * an upload row.
 *
 * @module services/chat-v2/sqlite/unified-log
 */

import { CONVERSATION_LOG_CONSTANTS, OWNER_EVIDENCE_METADATA } from '../../../constants.js';
import type { ChatChannelType, ChatSenderType } from '../types.js';
import type { ChatDatabase } from './chat-db.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Which surface a message belongs to. */
export type ConversationSource = (typeof CONVERSATION_LOG_CONSTANTS.SOURCES)[number];
/** Whether a message went to an agent, came from one, or neither. */
export type ConversationDirection = (typeof CONVERSATION_LOG_CONSTANTS.DIRECTIONS)[number];
/** Who wrote a message. */
export type ConversationSenderKind = (typeof CONVERSATION_LOG_CONSTANTS.SENDER_KINDS)[number];

/** External ids kept per message (only the fields that apply are present). */
export interface ConversationExtRef {
  slackTeamId?: string;
  slackChannelId?: string;
  /** Slack message ts */
  ts?: string;
  /** Slack thread root ts */
  threadTs?: string;
  slackUserId?: string;
  telegramChatId?: string;
  telegramMessageId?: string;
  gchatSpace?: string;
  gchatThread?: string;
  gchatMessage?: string;
  whatsappChatId?: string;
}

/** The derived columns written with every insert. */
export interface UnifiedColumns {
  source: ConversationSource;
  direction: ConversationDirection;
  senderKind: ConversationSenderKind;
  agentSession: string | null;
  extRef: ConversationExtRef | null;
  /** 1 = may be uploaded to Cloud, 0 = stays on this machine. */
  cloudSync: 0 | 1;
}

/** Who the owner is on the surfaces that carry other people too. */
export interface OwnerIdentity {
  /** The owner's Slack user id (the person who installed the app), when known. */
  slackUserId?: string | null;
  /** The Slack workspace this machine serves, used when a row carries no team id. */
  slackTeamId?: string | null;
}

/** Inputs of {@link deriveUnifiedColumns}. */
export interface DeriveUnifiedColumnsInput {
  senderType: ChatSenderType;
  senderId: string;
  /** Parsed metadata (may be empty). */
  metadata: Record<string, unknown>;
  /** Mentioned agent sessions / member ids. */
  mentions: readonly string[];
  channel: { id: string; type: ChatChannelType; agentSession: string };
  /**
   * `source` column of the channel's most recent `user` row. An agent's reply
   * belongs to the surface it answers (spec §A.4: reply-tool takes the
   * inbound channel's source).
   */
  latestInboundSource?: string | null;
  owner?: OwnerIdentity | null;
}

/** `metadata.source` values that tag an agent's reply rather than a surface. */
const REPLY_METADATA_SOURCES: ReadonlySet<string> = new Set(['reply-tool', 'pty-runtime', 'in-process-runtime']);
/** Runtime capture tags — shown as `runtime` when nothing better is known. */
const RUNTIME_METADATA_SOURCES: ReadonlySet<string> = new Set(['pty-runtime', 'in-process-runtime']);
/** Metadata sources that are already surface names. */
const DIRECT_METADATA_SOURCES: Readonly<Record<string, ConversationSource>> = {
  web: 'crewly-chat',
  'crewly-chat': 'crewly-chat',
  slack: 'slack',
  telegram: 'telegram',
  'google-chat': 'google-chat',
  whatsapp: 'whatsapp',
  'cloud-talk': 'cloud-talk',
  system: 'system',
};

/**
 * Whether a value is one of the {@link ConversationSource} values.
 *
 * @param value - Candidate
 * @returns True for a known source
 */
export function isConversationSource(value: unknown): value is ConversationSource {
  return typeof value === 'string' && (CONVERSATION_LOG_CONSTANTS.SOURCES as readonly string[]).includes(value);
}

/**
 * The surface a channel id names, for legacy rows whose tag is missing or
 * wrong (WhatsApp rows were tagged `slack` before G2).
 *
 * @param channelId - chat-v2 channel id
 * @returns The surface, or null when the id says nothing
 */
export function sourceFromChannelId(channelId: string): ConversationSource | null {
  const id = channelId.toLowerCase();
  const p = CONVERSATION_LOG_CONSTANTS.CHANNEL_PREFIXES;
  if (id.startsWith(p.WHATSAPP)) return 'whatsapp';
  if (id.startsWith(p.TELEGRAM)) return 'telegram';
  if (id.startsWith(p.GOOGLE_CHAT)) return 'google-chat';
  if (id.startsWith(p.SLACK)) return 'slack';
  return null;
}

/**
 * Read a non-empty string field.
 *
 * @param obj - Source object
 * @param key - Field
 * @returns The trimmed string, or undefined
 */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v === 'string' && v.trim().length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/**
 * Resolve the `source` column.
 *
 * @param input - Derivation input
 * @returns The surface
 */
function deriveSource(input: DeriveUnifiedColumnsInput): ConversationSource {
  const meta = str(input.metadata, 'source');
  const byChannel = sourceFromChannelId(input.channel.id);
  // Messenger channels are named after their surface; trust the name over a
  // tag (a WhatsApp row tagged `slack` is WhatsApp).
  if (byChannel && byChannel !== 'slack' && meta !== 'system') return byChannel;
  if (meta && DIRECT_METADATA_SOURCES[meta]) return DIRECT_METADATA_SOURCES[meta];
  if (input.senderType === 'system') return 'system';
  if (input.senderType === 'agent' || (meta && REPLY_METADATA_SOURCES.has(meta))) {
    if (isConversationSource(input.latestInboundSource)) return input.latestInboundSource;
    if (byChannel) return byChannel;
    return meta && RUNTIME_METADATA_SOURCES.has(meta) ? 'runtime' : 'crewly-chat';
  }
  return byChannel ?? 'crewly-chat';
}

/**
 * Resolve the `sender_kind` column.
 *
 * `owner` for the owner's own surfaces (Crewly Chat, Cloud Talk, messenger
 * bridges — the same rows the approval gate reads as the owner). On Slack,
 * where other people post too, `owner` only when the Slack user is the
 * owner; when the owner's id is unknown a DM still counts as the owner and a
 * shared channel does not.
 *
 * @param input - Derivation input
 * @param source - Resolved source
 * @returns The sender kind
 */
function deriveSenderKind(input: DeriveUnifiedColumnsInput, source: ConversationSource): ConversationSenderKind {
  if (input.senderType === 'agent') return 'agent';
  if (input.senderType === 'system') return 'system';
  const md = input.metadata;
  if (str(md, OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION) || str(md, OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION)) {
    return 'agent';
  }
  const explicit = str(md, 'senderKind');
  if (explicit && (CONVERSATION_LOG_CONSTANTS.SENDER_KINDS as readonly string[]).includes(explicit)) {
    return explicit as ConversationSenderKind;
  }
  if (source !== 'slack') return 'owner';
  const slackUserId = str(md, 'slackUserId');
  const ownerId = input.owner?.slackUserId ?? null;
  if (slackUserId && ownerId) return slackUserId === ownerId ? 'owner' : 'human';
  return input.channel.type === 'dm' ? 'owner' : 'human';
}

/**
 * Pick the external ids that apply to this row.
 *
 * @param md - Metadata
 * @param source - Resolved source
 * @param owner - Owner identity (supplies the Slack workspace when the row has none)
 * @returns The ext ref, or null when there is nothing to keep
 */
function deriveExtRef(
  md: Record<string, unknown>,
  source: ConversationSource,
  owner: OwnerIdentity | null | undefined,
): ConversationExtRef | null {
  const ext: ConversationExtRef = {};
  const slackChannelId = str(md, 'slackChannelId');
  if (slackChannelId || source === 'slack') {
    const team = str(md, 'slackTeamId') ?? (slackChannelId ? owner?.slackTeamId ?? undefined : undefined);
    if (team) ext.slackTeamId = team;
    if (slackChannelId) ext.slackChannelId = slackChannelId;
    const ts = str(md, 'slackTs');
    if (ts) ext.ts = ts;
    const threadTs = str(md, 'slackThreadTs');
    if (threadTs) ext.threadTs = threadTs;
    const user = str(md, 'slackUserId');
    if (user) ext.slackUserId = user;
  }
  const tgChat = str(md, 'telegramChatId');
  if (tgChat) ext.telegramChatId = tgChat;
  const tgMsg = str(md, 'telegramMessageId');
  if (tgMsg) ext.telegramMessageId = tgMsg;
  for (const key of ['gchatSpace', 'gchatThread', 'gchatMessage'] as const) {
    const v = str(md, key);
    if (v) ext[key] = v;
  }
  if (source === 'whatsapp') {
    const chat = str(md, 'whatsappChatId') ?? str(md, 'chatId');
    if (chat) ext.whatsappChatId = chat;
  }
  return Object.keys(ext).length > 0 ? ext : null;
}

/**
 * Derive the unified-log columns for one message.
 *
 * Pure: every input is passed in, so the same function serves live inserts
 * and the legacy-row backfill.
 *
 * O3 (owner decision 2026-09-28): in a shared Slack channel (a `huddle` or
 * `channel` room), only messages involving this account's agents may leave
 * the machine — the owner's own messages, any local agent's message, and a
 * message that @-mentions one of our agents. Anyone else's chatter is
 * `cloud_sync = 0`.
 *
 * @param input - Row and channel facts
 * @returns The derived columns
 *
 * @example
 * ```typescript
 * deriveUnifiedColumns({
 *   senderType: 'user', senderId: 'Maya', mentions: [],
 *   metadata: { source: 'slack', slackUserId: 'U2' },
 *   channel: { id: 'huddle-1', type: 'huddle', agentSession: '' },
 *   owner: { slackUserId: 'U1' },
 * }).cloudSync; // 0 — someone else's chatter
 * ```
 */
export function deriveUnifiedColumns(input: DeriveUnifiedColumnsInput): UnifiedColumns {
  const source = deriveSource(input);
  const senderKind = deriveSenderKind(input, source);
  const direction: ConversationDirection =
    input.senderType === 'agent' ? 'out' : input.senderType === 'system' ? 'internal' : 'in';

  let agentSession: string | null = input.channel.agentSession || null;
  if (!agentSession) {
    if (input.senderType === 'agent') agentSession = input.senderId || null;
    else agentSession = input.mentions.find((m) => m.length > 0) ?? null;
  }

  const sharedRoom = input.channel.type === 'huddle' || input.channel.type === 'channel';
  const othersChatter =
    sharedRoom && source === 'slack' && input.senderType === 'user' && senderKind !== 'owner' && input.mentions.length === 0;

  return {
    source,
    // Other people's chatter is not addressed to an agent: `internal`, which
    // is also how Cloud's O3 filter reads it (`in` = delivered to an agent).
    direction: othersChatter ? 'internal' : direction,
    senderKind,
    agentSession,
    extRef: deriveExtRef(input.metadata, source, input.owner),
    cloudSync: othersChatter ? 0 : 1,
  };
}

/**
 * Parse a stored metadata / mentions JSON column without throwing.
 *
 * @param raw - Column value
 * @returns Parsed object (metadata) — `{}` when missing or malformed
 */
export function parseMetadataColumn(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Parse a stored mentions JSON column without throwing.
 *
 * @param raw - Column value
 * @returns String entries, `[]` when missing or malformed
 */
export function parseMentionsColumn(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** Columns added to `chat_messages` (name → ADD COLUMN clause). */
export const UNIFIED_LOG_MESSAGE_COLUMNS: ReadonlyArray<{ name: string; addClause: string }> = [
  { name: 'source', addClause: 'source TEXT' },
  { name: 'direction', addClause: 'direction TEXT' },
  { name: 'sender_kind', addClause: 'sender_kind TEXT' },
  { name: 'agent_session', addClause: 'agent_session TEXT' },
  { name: 'ext_ref', addClause: 'ext_ref TEXT' },
  { name: 'cloud_sync', addClause: 'cloud_sync INTEGER' },
];

/**
 * Outbox, sync state, per-agent index and outbox triggers. Idempotent.
 *
 * The triggers skip rows with `cloud_sync = 0` (O3). An update enqueues only
 * when user-visible content changes or a row becomes syncable (owner
 * reclassification); metadata-only bookkeeping does not.
 */
export const UNIFIED_LOG_SQL = `
CREATE INDEX IF NOT EXISTS ix_messages_agent_created
  ON chat_messages(agent_session, created_at DESC);

-- Backfill pages history in created_at order (spec §B.4).
CREATE INDEX IF NOT EXISTS ix_messages_created
  ON chat_messages(created_at);

CREATE TABLE IF NOT EXISTS cloud_outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  TEXT NOT NULL,
  op          TEXT NOT NULL CHECK(op IN ('upsert','delete')),
  enqueued_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_sync_state (
  k TEXT PRIMARY KEY,
  v TEXT
);

CREATE TRIGGER IF NOT EXISTS trg_outbox_ins AFTER INSERT ON chat_messages
  WHEN COALESCE(NEW.cloud_sync, 1) = 1
  BEGIN
    INSERT INTO cloud_outbox(message_id, op, enqueued_at) VALUES (NEW.id, 'upsert', NEW.created_at);
  END;

CREATE TRIGGER IF NOT EXISTS trg_outbox_upd AFTER UPDATE OF content, cloud_sync ON chat_messages
  WHEN COALESCE(NEW.cloud_sync, 1) = 1
   AND (NEW.content IS NOT OLD.content OR COALESCE(OLD.cloud_sync, 1) <> 1)
  BEGIN
    INSERT INTO cloud_outbox(message_id, op, enqueued_at)
      VALUES (NEW.id, 'upsert', CAST(strftime('%s','now') AS INTEGER) * 1000);
  END;

CREATE TRIGGER IF NOT EXISTS trg_outbox_del AFTER DELETE ON chat_messages
  WHEN COALESCE(OLD.cloud_sync, 1) = 1
  BEGIN
    INSERT INTO cloud_outbox(message_id, op, enqueued_at)
      VALUES (OLD.id, 'delete', CAST(strftime('%s','now') AS INTEGER) * 1000);
  END;
`;

/** Report of {@link applyUnifiedLogUpgrades}. */
export interface UnifiedLogUpgradeReport {
  /** Columns added to `chat_messages` on this run. */
  columnsAdded: string[];
  /** Legacy rows given unified-log columns on this run. */
  rowsBackfilled: number;
}

/**
 * Bring `chat.db` up to the unified-log schema: add the columns, create the
 * outbox / state tables, index and triggers, then backfill rows that have no
 * `source` yet (every row written before this migration).
 *
 * Backfilled rows are NOT put in the outbox — the first-sign-in backfill
 * (spec §B.4) uploads history within the plan's window.
 *
 * Safe on every boot: each step is a no-op once applied.
 *
 * @param db - The chat database handle
 * @returns What changed
 */
export function applyUnifiedLogUpgrades(db: ChatDatabase): UnifiedLogUpgradeReport {
  const existing = new Set((db.pragma('table_info(chat_messages)') as Array<{ name: string }>).map((c) => c.name));
  const columnsAdded: string[] = [];
  for (const col of UNIFIED_LOG_MESSAGE_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE chat_messages ADD COLUMN ${col.addClause}`);
      columnsAdded.push(col.name);
    }
  }
  db.exec(UNIFIED_LOG_SQL);
  const rowsBackfilled = backfillUnifiedColumns(db);
  return { columnsAdded, rowsBackfilled };
}

/** Row shape read by the backfill. */
interface BackfillRow {
  rowid: number;
  id: string;
  channel_id: string;
  sender_type: ChatSenderType;
  sender_id: string;
  metadata: string | null;
  mentions: string | null;
  ch_type: ChatChannelType | null;
  ch_agent: string | null;
}

/**
 * Give legacy rows (`source IS NULL`) their unified-log columns, best effort.
 *
 * Runs in pages of {@link CONVERSATION_LOG_CONSTANTS.BACKFILL_BATCH_SIZE}
 * rows ordered by channel and seq, carrying each channel's latest inbound
 * source forward so agent replies inherit the surface they answered. The
 * owner's Slack id is unknown at boot, so shared-channel Slack rows land as
 * `human`; {@link reclassifyOwnerSlackRows} upgrades them once it is known.
 *
 * Nothing is enqueued: the update trigger fires only when `content` changes
 * or `cloud_sync` rises from a non-1 value, and legacy rows have
 * `cloud_sync IS NULL`, which the trigger already treats as 1.
 *
 * @param db - The chat database handle
 * @returns Rows updated
 */
export function backfillUnifiedColumns(db: ChatDatabase): number {
  const pending = db.prepare('SELECT 1 FROM chat_messages WHERE source IS NULL LIMIT 1').get();
  if (!pending) return 0;

  const select = db.prepare(
    `SELECT m.rowid AS rowid, m.id, m.channel_id, m.sender_type, m.sender_id, m.metadata, m.mentions,
            c.type AS ch_type, c.agent_session AS ch_agent
     FROM chat_messages m LEFT JOIN chat_channels c ON c.id = m.channel_id
     WHERE m.source IS NULL
     ORDER BY m.channel_id, m.seq
     LIMIT ?`,
  );
  const update = db.prepare(
    `UPDATE chat_messages
     SET source = ?, direction = ?, sender_kind = ?, agent_session = ?, ext_ref = ?, cloud_sync = ?
     WHERE rowid = ?`,
  );
  const lastInbound = new Map<string, string>();
  let total = 0;
  const batch = CONVERSATION_LOG_CONSTANTS.BACKFILL_BATCH_SIZE;
  for (;;) {
    const rows = select.all(batch) as BackfillRow[];
    if (rows.length === 0) break;
    db.transaction(() => {
      for (const r of rows) {
        const cols = deriveUnifiedColumns({
          senderType: r.sender_type,
          senderId: r.sender_id,
          metadata: parseMetadataColumn(r.metadata),
          mentions: parseMentionsColumn(r.mentions),
          channel: { id: r.channel_id, type: r.ch_type ?? 'dm', agentSession: r.ch_agent ?? '' },
          latestInboundSource: lastInbound.get(r.channel_id) ?? null,
          owner: null,
        });
        if (r.sender_type === 'user') lastInbound.set(r.channel_id, cols.source);
        update.run(
          cols.source,
          cols.direction,
          cols.senderKind,
          cols.agentSession,
          cols.extRef ? JSON.stringify(cols.extRef) : null,
          cols.cloudSync,
          r.rowid,
        );
      }
    })();
    total += rows.length;
    if (rows.length < batch) break;
  }
  return total;
}

/**
 * Once the owner's Slack user id is known, mark their Slack rows as the
 * owner's and — in shared channels — syncable. Rows recorded before the id
 * was available (legacy backfill, early boot) were conservatively `human`.
 *
 * Idempotent; the `cloud_sync` 0 → 1 flip enqueues those rows for upload
 * through the update trigger.
 *
 * @param db - The chat database handle
 * @param ownerSlackUserId - The owner's Slack user id
 * @returns Rows reclassified
 */
export function reclassifyOwnerSlackRows(db: ChatDatabase, ownerSlackUserId: string): number {
  if (!ownerSlackUserId) return 0;
  const result = db
    .prepare(
      `UPDATE chat_messages
       SET sender_kind = 'owner', cloud_sync = 1, direction = 'in'
       WHERE source = 'slack' AND sender_type = 'user' AND sender_kind = 'human'
         AND json_valid(metadata)
         AND json_extract(metadata, '$.slackUserId') = ?
         AND json_extract(metadata, '$.${OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION}') IS NULL
         AND json_extract(metadata, '$.${OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION}') IS NULL`,
    )
    .run(ownerSlackUserId);
  return result.changes;
}
