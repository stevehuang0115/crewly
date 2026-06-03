/**
 * ChatV2Service — orchestrator for the Agent-First Chat MVP.
 *
 * Wires ChannelStore + MessageStore, enforces the authorization rules
 * laid out in the tech spec §7.2, and maps DB rows to wire-format DTOs.
 *
 * WebSocket push, offline queuing, and attachment durability land in
 * later passes of Phase 1 — see §18 rollout plan.
 *
 * @module services/chat-v2/chat-v2.service
 */

import type { ChatV2Config } from './config.js';
import { ChannelStore } from './sqlite/channel.store.js';
import { EventEmitter } from 'events';
import { MessageStore } from './sqlite/message.store.js';
import { openChatDatabase, type ChatDatabase } from './sqlite/chat-db.js';
import {
  CHAT_CHANNEL_TYPES,
  CHAT_CONTENT_TYPES,
  CHAT_ERROR_CODES,
  CHAT_SENDER_TYPES,
  ChatError,
  type ChatAttachmentDTO,
  type ChatChannelDTO,
  type ChatChannelRow,
  type ChatChannelType,
  type ChatContentType,
  type ChatHuddleMember,
  type ChatMessageDTO,
  type ChatMessageListResult,
  type ChatMessageRow,
  type ChatPrincipal,
  type ChatSenderType,
} from './types.js';

// ---------------------------------------------------------------------------
// Service options
// ---------------------------------------------------------------------------

/** Constructor options for `ChatV2Service`. */
export interface ChatV2ServiceOptions {
  config: ChatV2Config;
  /** Optional pre-opened DB (tests pass an in-memory handle). */
  db?: ChatDatabase;
  /** Presence lookup — wired to `AgentRegistrationService` in wiring; tests pass a stub. */
  getPresence?: (agentSession: string) => {
    status: ChatChannelDTO['agentPresence']['status'];
    lastSeenAt: number | null;
  };
  /**
   * F2b (#333) — outer-ring tenant defense. Called when creating a
   * `type='channel'` channel; if the principal cannot bind a channel
   * to `teamId`, return false → `createChannel` throws
   * `forbidden_team` (HTTP 403). Sync only, since `createChannel` runs
   * inside the synchronous `runHandler` wrapper (an async refactor is
   * a Phase E concern, not a F2b requirement).
   *
   * In OSS production, wire to a check that confirms `teamId` exists
   * in `StorageService.getTeams()` — single-user OSS treats existence
   * as membership. Cloud Portal Phase E swaps in a real user-tenant
   * binding check.
   *
   * When omitted (legacy tests, REST-only fixtures) `createChannel`
   * preserves pre-F2b behavior: only validates teamId is non-empty.
   * The composition root in `backend/src/index.ts` MUST inject this
   * to close the leak in production.
   */
  validateTeamMembership?: (
    principal: ChatPrincipal,
    teamId: string,
  ) => boolean;
  /** Clock override for tests. */
  now?: () => number;
}

/** Minimal interface the service needs from a presence provider. */
export interface ChatPresenceProvider {
  getPresence(agentSession: string): {
    status: ChatChannelDTO['agentPresence']['status'];
    lastSeenAt: number | null;
  };
}

// ---------------------------------------------------------------------------
// Public input shapes
// ---------------------------------------------------------------------------

/** Arguments for `createChannel`. */
export interface CreateChannelArgs {
  /**
   * Wire-level session binding. Required when `type='dm'` (default);
   * for `type='channel'`, callers may omit it (server stores '').
   */
  agentSession?: string;
  name: string;
  purpose?: string;
  principal: ChatPrincipal;
  /**
   * Phase A (SEALED §3.1) — channel kind. Defaults to `'dm'` to preserve
   * the Phase 1 contract for callers that omit this field.
   */
  type?: ChatChannelType;
  /** Phase A — required when `type='channel'`. */
  teamId?: string;
  /** Phase A — optional even when `type='channel'`. */
  projectId?: string;
  /** Phase A — optional when `type='dm'`. */
  targetMemberId?: string;
}

/** Arguments for `createHuddle` (Phase B-2). */
export interface CreateHuddleArgs {
  /** Display name shown in the channel list (e.g. "Q4 planning"). */
  name: string;
  /** Optional one-liner — purpose of the huddle. */
  purpose?: string;
  /**
   * Agent session names (matches `DirectoryAgent.agentSession`) for
   * every member of the huddle. Must contain at least one entry; the
   * service rejects empty arrays so the dispatcher never has zero
   * recipients to fan out to. Order is not significant — the store
   * dedupes on insert.
   */
  memberSessions: string[];
  principal: ChatPrincipal;
}

/** Arguments for `listChannels`. */
export interface ListChannelsArgs {
  principal: ChatPrincipal;
  includeArchived?: boolean;
  limit?: number;
  /**
   * Phase C — filter to a single channel type. The controller validates
   * the wire value against {@link CHAT_CHANNEL_TYPES} before reaching
   * this layer; an unknown value is rejected as `validation_error`.
   */
  type?: ChatChannelType;
  /**
   * Phase C — filter to channels with this `team_id`. Empty string is
   * treated the same as `undefined` (no filter) so callers don't have
   * to pre-normalize blank query strings. The store-level filter still
   * uses an exact-match against the column, so DMs (which have null
   * team_id) drop out of the result.
   */
  teamId?: string;
  /**
   * Include "bridged" channels (Slack inbound, owned by `'system'`) in the
   * result. Defaults to true. Only applies to the unfiltered list (no
   * `type`/`teamId` filter) — bridged threads are surfaced alongside the
   * user's own DMs/channels in the consolidated chat list.
   */
  includeBridged?: boolean;
}

/** Arguments for `sendMessage`. */
export interface SendMessageArgs {
  channelId: string;
  principal: ChatPrincipal;
  content: string;
  contentType?: ChatContentType;
  clientMessageId?: string;
  /** Attachment hooks — the store is added in a later step, so pre-resolved DTOs are accepted. */
  attachments?: ChatAttachmentDTO[];
  /**
   * Phase A (SEALED §3.2) — array of mention IDs referenced inline in
   * `content`. Persisted as JSON; emitted on the outbound message DTO.
   * Empty / omitted → no mentions.
   *
   * **Wire-shape varies by channel type — callers must pass the right
   * one for the channel they're posting to:**
   *
   * - `type='channel'`: each entry is a **member id** or **team id**.
   *   The dispatcher routes these through `ChatV2MentionResolver` to
   *   look up the matching session name(s).
   *
   * - `type='huddle'`: each entry is an **agent session name** (the
   *   same shape that goes into `chat_channel_members.member_session`).
   *   The dispatcher does NOT run them through the resolver — they're
   *   matched directly against the huddle roster to set per-recipient
   *   `responseMode` (`'required'` for mentioned members, `'optional'`
   *   otherwise).
   *
   * - `type='dm'`: mentions are advisory only — DMs have a single
   *   recipient already, and the dispatcher doesn't re-route based on
   *   mentions.
   */
  mentions?: string[];
  /**
   * Phase A (SEALED §3.2) — Slack-style thread reply root. When set,
   * the new message is a reply within the thread rooted at this id;
   * the service validates that the thread root lives in the same
   * channel before persisting.
   */
  threadId?: string;
}

/**
 * Allowed values for `RecordTurnInput.metadata.source` — the audit-trail
 * discriminator that identifies which subsystem produced the message.
 *
 * Per spec `2026-05-14-unified-chat-message-store.md`, every {@link
 * ChatV2Service.recordTurn} caller MUST set `metadata.source` to one of
 * these values. The set is intentionally closed so future audits can
 * `GROUP BY metadata->>'$.source'` without surprise values.
 */
export const RECORD_TURN_SOURCES = [
  'web',
  'slack',
  'pty-runtime',
  'in-process-runtime',
  'reply-tool',
  'system',
] as const;

/** Union type of the values in {@link RECORD_TURN_SOURCES}. */
export type RecordTurnSource = (typeof RECORD_TURN_SOURCES)[number];

/** Server-internal write input for {@link ChatV2Service.recordTurn}. */
export interface RecordTurnInput {
  channelId: string;
  /** Server resolved — runtime/controller already knows who's sending. */
  senderType: ChatSenderType;
  /** User id, agent session name, or `'system'`. */
  senderId: string;
  content: string;
  contentType?: ChatContentType;
  /** Stable idempotency key — dedup keyed on `(channel_id, clientMessageId)`. */
  clientMessageId?: string;
  /** Optional thread-root reference; validated to live in the same channel. */
  threadId?: string;
  /** Optional inline mention ids (member or team). */
  mentions?: string[];
  /** Required audit metadata. Caller MUST set `source`. */
  metadata: {
    source: RecordTurnSource;
    /** Which agent runtime emitted the message, when applicable. */
    runtime?: 'claude-code' | 'gemini-cli' | 'crewly-agent';
    /** Slack correlation fields for cross-store reconciliation. */
    slackChannelId?: string;
    slackThreadTs?: string;
    /** Free-form additional context — not parsed by the store. */
    [key: string]: unknown;
  };
}

/** Result of {@link ChatV2Service.recordTurn}. */
export interface RecordTurnResult {
  /** The persisted (or pre-existing, when deduped) message DTO. */
  message: ChatMessageDTO;
  /** True when `clientMessageId` matched an existing row. */
  deduped: boolean;
}

/** Arguments for `listMessages`. */
export interface ListMessagesArgs {
  channelId: string;
  principal: ChatPrincipal;
  cursor?: string | null;
  limit?: number;
  direction?: 'backward' | 'forward';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Default presence provider used until AgentRegistrationService is wired. */
const DEFAULT_PRESENCE = () => ({
  status: 'offline' as const,
  lastSeenAt: null,
});

/**
 * Orchestrator for chat domain operations.
 *
 * Responsibilities:
 * - Owns the DB handle + stores.
 * - Enforces authorization per §7.2.
 * - Maps rows → DTOs.
 * - Fans out to WebSocket / adapters in later phases.
 */
export class ChatV2Service extends EventEmitter {
  /** Phase A spec §3.2: max mention count per message. */
  static readonly MAX_MENTIONS_PER_MESSAGE = 50;
  /** Phase A spec §3.2: max JSON-encoded byte size of the mentions array. */
  static readonly MAX_MENTIONS_JSON_BYTES = 1024;

  readonly config: ChatV2Config;
  private readonly db: ChatDatabase;
  private readonly channels: ChannelStore;
  private readonly messages: MessageStore;
  private presence: ChatV2ServiceOptions['getPresence'];
  private readonly validateTeamMembership: ChatV2ServiceOptions['validateTeamMembership'];
  private readonly now: () => number;

  constructor(options: ChatV2ServiceOptions) {
    super();
    this.config = options.config;
    this.db = options.db ?? openChatDatabase({ dbPath: options.config.storage.dbPath });
    this.channels = new ChannelStore(this.db);
    this.messages = new MessageStore(this.db);
    this.presence = options.getPresence ?? DEFAULT_PRESENCE;
    this.validateTeamMembership = options.validateTeamMembership;
    this.now = options.now ?? Date.now;
  }

  /**
   * Wire (or replace) the synchronous presence provider used by the channel
   * DTO mapper — i.e. what drives the DM presence dots in the conversation
   * list. Settable POST-construction because the singleton is first-constructed
   * by whichever caller wins the race (slack bridge, ws gateway, replay, …),
   * usually with no presence wired; the composition root then calls this once
   * so the dots reflect real agent liveness regardless of construction order.
   *
   * @param getPresence - Sync presence lookup (e.g. `createOssSyncPresence()`)
   */
  setPresenceProvider(getPresence: ChatV2ServiceOptions['getPresence']): void {
    this.presence = getPresence;
  }

  /** Release the DB handle. Safe to call during graceful shutdown / in tests. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // swallow — nothing to do if already closed
    }
  }

  /**
   * Count every persisted chat message across every channel.
   *
   * Onboarding v3 (B1) — surfaced for the cold-start detector. Defers to
   * `MessageStore.countAll()`. Intentionally bypasses the principal /
   * authorization layer because the caller is the orchestrator bootstrap,
   * which runs without an HTTP-request principal context. The detector
   * only needs an unsigned "is the store empty" answer; no row contents
   * are exposed.
   *
   * @returns Total message count across all channels (0 on a fresh install)
   */
  countAllMessages(): number {
    return this.messages.countAll();
  }

  /**
   * Phase 6.0 of unified-chat-message-store spec — replacement for the
   * legacy `ChatService.updateMessageMetadata`. Merges a partial
   * metadata object into the stored row's `metadata` JSON column using
   * SQLite's `json_patch` (atomic, server-side).
   *
   * No principal check — this is a server-internal mutation path used
   * by reconciliation jobs (Slack delivery status updates) and never
   * exposed directly to user HTTP traffic. Phase 6c will retire the
   * legacy method that called this; until then it is the only callable
   * write-through for the existing reconciliation code.
   *
   * @param messageId - Message id to update
   * @param patch - Shallow metadata patch to merge
   * @returns The updated message DTO, or null if no such message exists
   */
  updateMessageMetadata(
    messageId: string,
    patch: Record<string, unknown>,
  ): ChatMessageDTO | null {
    const row = this.messages.updateMetadata(messageId, patch);
    if (!row) return null;
    return this.toMessageDTO(row, []);
  }

  /**
   * Phase 6.0 — replacement for the legacy
   * `ChatService.getMessagesWithPendingSlackDelivery`. Returns the
   * messages still marked `slackDeliveryStatus='pending'` within the
   * caller-supplied lookback window, used by NotifyReconciliationService
   * to retry stuck Slack deliveries.
   *
   * @param maxAgeMs - Lookback window in milliseconds
   * @returns Pending-delivery messages, newest first, capped at MAX_LIMIT
   */
  findMessagesWithPendingSlackDelivery(maxAgeMs: number): ChatMessageDTO[] {
    const rows = this.messages.findPendingSlackDelivery(maxAgeMs);
    return rows.map((r) => this.toMessageDTO(r, []));
  }

  /**
   * Phase 6.0 — replacement for the legacy `ChatService.getStatistics`.
   * Aggregate counts used by the boot-time telemetry and the
   * admin/audit dashboards.
   *
   * @returns Active/archived channel counts plus total message count
   */
  getStatistics(): {
    totalChannels: number;
    activeChannels: number;
    archivedChannels: number;
    totalMessages: number;
  } {
    const activeChannels = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM chat_channels WHERE archived_at IS NULL`)
      .get() as { n: number }).n;
    const archivedChannels = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM chat_channels WHERE archived_at IS NOT NULL`)
      .get() as { n: number }).n;
    return {
      totalChannels: activeChannels + archivedChannels,
      activeChannels,
      archivedChannels,
      totalMessages: this.messages.countAll(),
    };
  }

  // -------------------------------------------------------------------------
  // Channel operations
  // -------------------------------------------------------------------------

  /**
   * Create a channel bound 1:1 to an agent session. Server always assigns
   * `owner_user_id = principal.userId` — the body's owner fields are ignored.
   *
   * F2b (#333): when `type='channel'` and a `validateTeamMembership` provider
   * is wired into the service, the principal must be authorized for the
   * requested `teamId`. Failures throw `forbidden_team` (403) — distinct
   * from generic `forbidden` so the FE can surface a tenant-specific
   * message.
   *
   * @param args - Channel creation args
   * @returns The created channel as a DTO
   * @throws {ChatError} `validation_error` (400) / `forbidden_team` (403) /
   *   `agent_already_bound` (409)
   */
  createChannel(args: CreateChannelArgs): ChatChannelDTO {
    const name = (args.name ?? '').trim();
    if (name.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'name is required');
    }
    if (name.length > this.config.maxChannelNameChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `name exceeds ${this.config.maxChannelNameChars} characters`,
      );
    }

    // Phase A: validate channel type (defaults to 'dm' for backwards compat).
    const channelType: ChatChannelType = args.type ?? 'dm';
    if (!CHAT_CHANNEL_TYPES.includes(channelType)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown channel type: ${channelType}`,
      );
    }

    // agentSession requirement is type-dependent:
    //   - 'dm'      → required (existing Phase 1 contract).
    //   - 'channel' → not 1:1-bound; server stores '' even if caller passed
    //                 something. Keep this strict so the wire shape matches
    //                 the design and we don't accidentally bind a team
    //                 channel to a single agent.
    const rawAgentSession = (args.agentSession ?? '').trim();
    let agentSession: string;
    if (channelType === 'dm') {
      if (rawAgentSession.length === 0) {
        throw new ChatError(
          CHAT_ERROR_CODES.VALIDATION,
          400,
          "agentSession is required when type='dm'",
        );
      }
      agentSession = rawAgentSession;
    } else {
      // channel: discard any caller-supplied agentSession.
      agentSession = '';
    }

    // Phase A: type='channel' must specify a teamId; type='dm' may
    // optionally carry a targetMemberId. Reject the contradicting cases.
    const teamId = args.teamId?.trim() || undefined;
    const projectId = args.projectId?.trim() || undefined;
    const targetMemberId = args.targetMemberId?.trim() || undefined;

    if (channelType === 'channel' && !teamId) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        "teamId is required when type='channel'",
      );
    }
    if (channelType === 'dm' && teamId) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        "teamId must be omitted when type='dm'",
      );
    }
    if (channelType === 'channel' && targetMemberId) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        "targetMemberId must be omitted when type='channel'",
      );
    }

    // F2b (#333) — outer-ring tenant defense. type='channel' bindings
    // must pass the membership check when one is wired. Pre-checks
    // already confirmed `teamId` is present and non-empty by here.
    if (channelType === 'channel' && teamId && this.validateTeamMembership) {
      const isMember = this.validateTeamMembership(args.principal, teamId);
      if (!isMember) {
        throw new ChatError(
          CHAT_ERROR_CODES.FORBIDDEN_TEAM,
          403,
          'caller is not a member of the requested team',
          { teamId, userId: args.principal.userId },
        );
      }
    }

    const purpose = args.purpose?.trim();
    if (purpose && purpose.length > this.config.maxPurposeChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `purpose exceeds ${this.config.maxPurposeChars} characters`,
      );
    }

    const row = this.channels.create({
      agentSession,
      ownerUserId: args.principal.userId,
      name,
      purpose: purpose || null,
      type: channelType,
      teamId: teamId ?? null,
      projectId: projectId ?? null,
      targetMemberId: targetMemberId ?? null,
      nowMs: this.now(),
    });
    return this.toChannelDTO(row);
  }

  /**
   * Phase B-2 (2026-05-17) — create a huddle (ad-hoc multi-agent group
   * channel). Creates a `type='huddle'` channel row with no team
   * binding, then inserts one row per member into
   * `chat_channel_members`. The dispatcher uses that roster to fan out
   * subsequent user messages to every member; agents whose session is
   * in the outgoing message's `mentions[]` get a "must respond"
   * prompt, others get an "optional" one.
   *
   * @param args - name, optional purpose, member roster, owning principal
   * @returns The created huddle channel as a DTO, with `members` populated
   * @throws {ChatError} `validation_error` (400) when name is empty/too long,
   *   purpose too long, or memberSessions is empty / has too many entries.
   */
  createHuddle(args: CreateHuddleArgs): ChatChannelDTO {
    const name = (args.name ?? '').trim();
    if (name.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'name is required');
    }
    if (name.length > this.config.maxChannelNameChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `name exceeds ${this.config.maxChannelNameChars} characters`,
      );
    }
    const purpose = args.purpose?.trim();
    if (purpose && purpose.length > this.config.maxPurposeChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `purpose exceeds ${this.config.maxPurposeChars} characters`,
      );
    }

    // Dedupe + trim member sessions. We accept any non-empty trimmed
    // string here — actual agent existence is validated by the
    // dispatcher when it tries to resolve the session at fan-out time.
    const seen = new Set<string>();
    const members: string[] = [];
    for (const raw of args.memberSessions ?? []) {
      const s = (raw ?? '').trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      members.push(s);
    }
    if (members.length === 0) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'memberSessions must include at least one agent session',
      );
    }
    // Defensive upper bound — a 200-member huddle would tax both the
    // dispatcher fan-out and downstream rate limits. The cap can be
    // raised when we have a real use case.
    const MAX_HUDDLE_MEMBERS = 50;
    if (members.length > MAX_HUDDLE_MEMBERS) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `huddle exceeds the ${MAX_HUDDLE_MEMBERS}-member cap`,
      );
    }

    const nowMs = this.now();
    const row = this.channels.create({
      // Huddle isn't 1:1-bound — keep agent_session empty (same convention
      // as type='channel'). No team_id either: huddles are ad-hoc groups,
      // not team-scoped surfaces.
      agentSession: '',
      ownerUserId: args.principal.userId,
      name,
      purpose: purpose || null,
      type: 'huddle',
      teamId: null,
      projectId: null,
      targetMemberId: null,
      nowMs,
    });

    // Insert membership rows. INSERT OR IGNORE is defensive against the
    // dedupe above getting bypassed (e.g., when callers reuse this
    // method via the relay adapter with raw input).
    const memberStmt = this.db.prepare(
      `INSERT OR IGNORE INTO chat_channel_members
         (channel_id, member_session, joined_at)
       VALUES (?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: string[]) => {
      for (const s of rows) memberStmt.run(row.id, s, nowMs);
    });
    insertMany(members);

    return this.toChannelDTO(row);
  }

  /**
   * Phase B-2 — list the members of a huddle channel. Returns an empty
   * array (not an error) for non-huddle channels so consumers can call
   * this unconditionally during channel rendering.
   *
   * @param channelId - The channel to enumerate
   * @param principal - The caller; used to verify ownership
   * @returns Array of `{ sessionName, joinedAt }` rows
   * @throws {ChatError} `not_found` (404) when the channel doesn't exist or
   *   isn't owned by `principal`.
   */
  listHuddleMembers(channelId: string, principal: ChatPrincipal): ChatHuddleMember[] {
    const row = this.requireOwnedChannel(channelId, principal);
    if (row.type !== 'huddle') return [];
    return this.queryHuddleMembers(channelId);
  }

  /**
   * Phase B-2 — dispatcher-facing roster lookup. Returns the session
   * names of every member in a huddle, in `joined_at ASC` order.
   * Unlike {@link listHuddleMembers} this is NOT principal-scoped:
   * the dispatcher runs server-side and already holds the channel
   * (it just persisted a message into it). Returns an empty array for
   * non-huddle channels or unknown ids so the dispatcher's
   * `members.length === 0` skip path stays clean.
   *
   * @param channelId - The huddle channel id
   * @returns Array of agent session names
   */
  queryHuddleMembersForDispatch(channelId: string): string[] {
    return this.queryHuddleMembers(channelId).map((m) => m.sessionName);
  }

  /** Internal: read members straight from the DB (no ownership check). */
  private queryHuddleMembers(channelId: string): ChatHuddleMember[] {
    const rows = this.db
      .prepare(
        `SELECT member_session AS sessionName, joined_at AS joinedAt
           FROM chat_channel_members
          WHERE channel_id = ?
          ORDER BY joined_at ASC`,
      )
      .all(channelId) as Array<{ sessionName: string; joinedAt: number }>;
    return rows.map((r) => ({ sessionName: r.sessionName, joinedAt: r.joinedAt }));
  }

  /**
   * Idempotent DM channel lookup-or-create for the /agents page.
   *
   * Returns the most-recent active DM channel owned by `principal.userId`
   * and bound to `agentSession`; creates a new one when none exists. The
   * caller is the human owner (auth principal), unlike
   * {@link ensureChannelForLegacyConversation} which runs as `'system'`
   * for server-internal bridge paths.
   *
   * Used by `POST /api/chat/channels/dm/ensure` so the /agents page can
   * map "user clicked an agent in the directory" → "send/receive messages
   * on this channel" without leaking duplicate DMs every time the page
   * is reloaded.
   *
   * @param args - Lookup-or-create args
   * @returns The channel DTO plus a `created` flag (true when a new row
   *   was inserted; false when an existing row was reused).
   * @throws {ChatError} `validation_error` (400) on empty `agentSession`
   *   or oversize `name` / `purpose`.
   */
  ensureDmChannel(args: {
    agentSession: string;
    name?: string;
    purpose?: string;
    principal: ChatPrincipal;
  }): { channel: ChatChannelDTO; created: boolean } {
    const agentSession = (args.agentSession ?? '').trim();
    if (agentSession.length === 0) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'agentSession is required',
      );
    }
    const existing = this.channels.findActiveDmByOwnerAndAgent(
      args.principal.userId,
      agentSession,
    );
    if (existing) {
      return { channel: this.toChannelDTO(existing), created: false };
    }
    // Fall through to createChannel so the full validation + tenant
    // checks (purpose length, name length, etc.) run consistently with
    // the public POST /channels endpoint.
    const channel = this.createChannel({
      agentSession,
      name: (args.name ?? agentSession).trim(),
      purpose: args.purpose,
      principal: args.principal,
      type: 'dm',
    });
    return { channel, created: true };
  }

  /**
   * Find-or-create the canonical `type='channel'` channel for a team.
   *
   * Backs the consolidated team-chat surface: opening a team's workspace
   * deep-link must always land on a real channel, but nothing else
   * auto-creates one. This is idempotent — if the team already has any
   * active channel it is returned untouched; otherwise a single default
   * channel (e.g. `#general`) is created. The same tenant/validation rules
   * as the public {@link createChannel} apply (the caller must pass team
   * membership when a `validateTeamMembership` check is wired).
   *
   * @param args - Ensure args
   * @param args.teamId - The team to ensure a channel for (required)
   * @param args.name - Display name for a freshly created channel; defaults to `#general`
   * @param args.purpose - Optional channel purpose
   * @param args.principal - The authenticated caller
   * @returns The existing or freshly created channel, with `created` flag
   * @throws {ChatError} `validation_error` (400) when `teamId` is blank
   * @throws {ChatError} `forbidden_team` (403) when the caller fails the membership check
   */
  ensureTeamChannel(args: {
    teamId: string;
    name?: string;
    purpose?: string;
    principal: ChatPrincipal;
  }): { channel: ChatChannelDTO; created: boolean } {
    const teamId = (args.teamId ?? '').trim();
    if (teamId.length === 0) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'teamId is required',
      );
    }
    const existing = this.channels.findActiveChannelByTeam(teamId);
    if (existing) {
      return { channel: this.toChannelDTO(existing), created: false };
    }
    const channel = this.createChannel({
      name: (args.name ?? '#general').trim(),
      purpose: args.purpose,
      principal: args.principal,
      type: 'channel',
      teamId,
    });
    return { channel, created: true };
  }

  /**
   * Server-internal idempotent helper used by migration / bridge code to
   * map a legacy conversationId (e.g. `slack-D0AC7-1234`, `web-conv-abc`)
   * onto a chat-v2 channel row with the conversationId as the primary key.
   *
   * Unlike {@link createChannel}, this method:
   *   - Returns the existing channel when one already lives at the given
   *     id — idempotent for runtimes that call it before every recordTurn.
   *   - Accepts a synthetic owner (`'system'`) for paths where no human
   *     principal is on the call stack (PTY finish hooks, Slack inbound
   *     bridge, in-process runtime auto-route).
   *   - Sets `type='dm'` so the channel matches the conversation-per-thread
   *     legacy model the user approved (spec Option B).
   *
   * The `agent_already_bound` failure mode that existed in chat-v2 Phase A
   * does not apply — the `uq_channel_agent_dm_active` index was dropped
   * per the unified-chat-message-store spec exactly so this helper can
   * lazy-create N concurrent DM channels for a single agent.
   *
   * @param args - Legacy bridge args
   * @returns The existing or freshly created channel DTO
   * @throws {ChatError} `validation_error` on missing id / agentSession
   *
   * @example
   * ```typescript
   * // Called from `routeInProcessResponseToChat` before `recordTurn`:
   * const channel = chatV2.ensureChannelForLegacyConversation({
   *   conversationId: 'slack-D0AC7-1700000000.000111',
   *   agentSession: 'crewly-orc',
   * });
   * chatV2.recordTurn({ channelId: channel.id, ... });
   * ```
   */
  ensureChannelForLegacyConversation(args: {
    conversationId: string;
    agentSession: string;
    /** Display name; defaults to the conversationId. */
    name?: string;
    /** Owner id; defaults to `'system'` for server-internal callers. */
    ownerUserId?: string;
  }): ChatChannelDTO {
    const conversationId = (args.conversationId ?? '').trim();
    if (conversationId.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'conversationId is required');
    }
    const agentSession = (args.agentSession ?? '').trim();
    if (agentSession.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'agentSession is required');
    }

    const existing = this.channels.getById(conversationId);
    if (existing) {
      return this.toChannelDTO(existing);
    }

    const name = (args.name ?? conversationId).trim();
    const ownerUserId = (args.ownerUserId ?? 'system').trim();

    const row = this.channels.create({
      id: conversationId,
      agentSession,
      ownerUserId,
      name,
      purpose: null,
      type: 'dm',
      teamId: null,
      projectId: null,
      targetMemberId: null,
      nowMs: this.now(),
    });
    return this.toChannelDTO(row);
  }

  /**
   * Phase 5 of unified-chat-message-store spec — idempotent import of one
   * legacy conversation file (`~/.crewly/chat/<conversationId>.json`)
   * into the chat-v2 SQLite store. Each legacy message becomes one
   * `chat_messages` row keyed by a deterministic `clientMessageId` so
   * re-running the import is safe — the underlying `MessageStore`
   * dedups on `(channel_id, clientMessageId)`.
   *
   * Designed as a service method (not a free function) so the CLI
   * migration script can call it per file and so callers can unit-test
   * the mapping in isolation.
   *
   * The mapping:
   *   - `conversation.id` → `chat_channels.id` (via
   *     {@link ensureChannelForLegacyConversation}). `agentSession`
   *     defaults to `'crewly-orc'` because every legacy conversation was
   *     a DM between the user and the orchestrator.
   *   - `messages[].from.type === 'user'` → `senderType: 'user'`
   *   - `messages[].from.type === 'orchestrator'` (or 'agent') →
   *     `senderType: 'agent'`, `senderId: 'crewly-orc'`
   *   - Anything else → `senderType: 'system'`, `senderId: 'system'`
   *   - `messages[].id` → `clientMessageId = 'legacy-' + msg.id` for
   *     stable idempotency across re-runs.
   *   - `messages[].metadata.source` (legacy slack/web) → carried
   *     through; `recordTurn`'s required outer `metadata.source` is set
   *     to `'system'` to identify the migration as the writer.
   *
   * @param input - Parsed legacy JSON (the entire file body)
   * @returns Per-message outcome (imported vs deduped) + the channel id
   *
   * @example
   * ```typescript
   * const json = JSON.parse(await readFile(filePath, 'utf-8'));
   * const result = chatV2.importLegacyConversation(json);
   * console.log(`Imported ${result.imported} new, ${result.deduped} dedup`);
   * ```
   */
  importLegacyConversation(input: {
    conversation: { id: string };
    messages: Array<{
      id: string;
      from: { type: string; name?: string };
      content: string;
      contentType?: string;
      timestamp?: string;
      metadata?: Record<string, unknown>;
    }>;
  }): { channelId: string; imported: number; deduped: number; skipped: number } {
    if (!input?.conversation?.id) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'legacy conversation.id is required',
      );
    }
    if (!Array.isArray(input.messages)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'legacy messages must be an array',
      );
    }

    const channel = this.ensureChannelForLegacyConversation({
      conversationId: input.conversation.id,
      agentSession: 'crewly-orc',
      name: input.conversation.id,
    });

    let imported = 0;
    let deduped = 0;
    let skipped = 0;
    const skippedReasons: Array<{ index: number; reason: string; id?: unknown }> = [];
    for (let i = 0; i < input.messages.length; i++) {
      const msg = input.messages[i];
      if (!msg?.id) {
        skipped++;
        skippedReasons.push({ index: i, reason: 'missing-id', id: msg?.id });
        continue;
      }
      if (typeof msg.content !== 'string' || msg.content.length === 0) {
        skipped++;
        skippedReasons.push({ index: i, reason: 'empty-content', id: msg.id });
        continue;
      }

      const fromType = (msg.from?.type ?? '').toLowerCase();
      let senderType: ChatSenderType;
      let senderId: string;
      if (fromType === 'user') {
        senderType = 'user';
        senderId =
          (typeof msg.metadata?.userId === 'string' && msg.metadata.userId) ||
          msg.from?.name ||
          'legacy-user';
      } else if (fromType === 'agent' || fromType === 'orchestrator') {
        senderType = 'agent';
        senderId = 'crewly-orc';
      } else {
        senderType = 'system';
        senderId = 'system';
      }

      const result = this.recordTurn({
        channelId: channel.id,
        senderType,
        senderId,
        content: msg.content,
        clientMessageId: `legacy-${msg.id}`,
        metadata: {
          source: 'system',
          // Carry through legacy metadata for forensic completeness —
          // future audits can still see "this row was originally a slack
          // inbound" via metadata.legacySource etc.
          legacySource: typeof msg.metadata?.source === 'string' ? msg.metadata.source : undefined,
          legacyMessageId: msg.id,
          legacyTimestamp: msg.timestamp,
        },
      });
      if (result.deduped) {
        deduped++;
      } else {
        imported++;
      }
    }

    if (skipped > 0) {
      // Surface malformed legacy rows so the migration operator can
      // decide whether to repair the source JSON before re-running, or
      // accept that some history is unrecoverable. Without this log the
      // earlier silent-skip behavior turned data-loss into a counter
      // mismatch that nobody noticed. ChatV2Service has no injected
      // logger; the migration runs as a CLI script so console output
      // is the right sink.
      // eslint-disable-next-line no-console
      console.warn(
        `[chat-v2] importLegacyConversation: skipped ${skipped}/${input.messages.length} malformed row(s) in ${input.conversation.id}`,
        {
          channelId: channel.id,
          skipped,
          totalRows: input.messages.length,
          reasons: skippedReasons.slice(0, 10),
          truncated: skippedReasons.length > 10,
        },
      );
    }

    return { channelId: channel.id, imported, deduped, skipped };
  }

  /**
   * List channels owned by the caller.
   *
   * Phase C: extended with optional `type` + `teamId` filters so the
   * channel-rail can request a focused slice (e.g. "channels in this
   * workspace only") without paging the full owner-scoped list. An
   * unknown `type` value is rejected as `validation_error`. Blank
   * `teamId` is normalized to "no filter" so callers don't need to
   * sanitize empty query strings.
   *
   * @param args - List args (principal + optional filters)
   * @returns DTO-mapped channels
   * @throws {ChatError} `validation_error` (400) when `type` is set
   *   to a value outside {@link CHAT_CHANNEL_TYPES}.
   */
  listChannels(args: ListChannelsArgs): ChatChannelDTO[] {
    if (args.type !== undefined && !CHAT_CHANNEL_TYPES.includes(args.type)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown channel type: ${args.type}`,
      );
    }
    // Treat blank teamId the same as omitted — saves the channel-rail FE
    // from having to strip empty query strings before issuing the GET.
    const teamIdFilter =
      args.teamId !== undefined && args.teamId.trim().length > 0
        ? args.teamId
        : undefined;

    const rows = this.channels.listByOwner(args.principal.userId, {
      includeArchived: args.includeArchived,
      limit: args.limit,
      type: args.type,
      teamId: teamIdFilter,
    });

    // Surface bridged (Slack) threads alongside the user's own channels on
    // the unfiltered list. They are owned by `'system'`, so listByOwner
    // never returns them; merge + dedupe by id (the user's own row wins).
    const includeBridged =
      (args.includeBridged ?? true) && args.type === undefined && teamIdFilter === undefined;
    if (includeBridged) {
      const seen = new Set(rows.map((r) => r.id));
      const bridged = this.channels
        .listBridged({ includeArchived: args.includeArchived, limit: args.limit })
        .filter((r) => !seen.has(r.id));
      return [...rows, ...bridged].map((r) => this.toChannelDTO(r));
    }
    return rows.map((r) => this.toChannelDTO(r));
  }

  /**
   * Look up a single channel the caller owns.
   *
   * @param channelId - Channel id
   * @param principal - Auth principal
   * @returns DTO shape
   * @throws {ChatError} `channel_not_found` (404) if the caller doesn't own it
   */
  getChannel(channelId: string, principal: ChatPrincipal): ChatChannelDTO {
    const row = this.requireOwnedChannel(channelId, principal);
    return this.toChannelDTO(row);
  }

  /**
   * Archive a channel. Returns true if a row was modified.
   *
   * @param channelId - Channel id
   * @param principal - Auth principal
   * @returns True if newly archived, false if already archived
   * @throws {ChatError} `channel_not_found` (404)
   */
  archiveChannel(channelId: string, principal: ChatPrincipal): boolean {
    this.requireOwnedChannel(channelId, principal);
    return this.channels.archive(channelId, this.now());
  }

  /**
   * Phase 6.0b — clear the `archived_at` flag on a channel. Inverse of
   * {@link archiveChannel}; required to retire the legacy
   * `unarchiveConversation` route.
   *
   * @param channelId - The channel to unarchive
   * @param principal - Auth principal (must own the channel)
   * @returns True if newly unarchived, false if already active
   * @throws {ChatError} `channel_not_found` (404)
   */
  unarchiveChannel(channelId: string, principal: ChatPrincipal): boolean {
    this.requireOwnedChannel(channelId, principal);
    return this.channels.unarchive(channelId);
  }

  /**
   * Phase 6.0b — rename a channel. Replaces the legacy
   * `updateConversationTitle` route. Server validates the same name
   * constraints as `createChannel`.
   *
   * @param channelId - The channel to rename
   * @param name - New name (trimmed, ≤ maxChannelNameChars)
   * @param principal - Auth principal (must own the channel)
   * @returns The renamed channel DTO
   * @throws {ChatError} `validation_error` (400) on empty / oversize name,
   *                    `channel_not_found` (404)
   */
  renameChannel(channelId: string, name: string, principal: ChatPrincipal): ChatChannelDTO {
    const trimmed = (name ?? '').trim();
    if (trimmed.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'name is required');
    }
    if (trimmed.length > this.config.maxChannelNameChars) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `name exceeds ${this.config.maxChannelNameChars} characters`,
      );
    }
    const row = this.requireOwnedChannel(channelId, principal);
    this.channels.rename(channelId, trimmed);
    return this.toChannelDTO({ ...row, name: trimmed });
  }

  /**
   * Phase 6.0b — hard-delete a channel and all its messages. Distinct
   * from {@link archiveChannel} (soft delete). Replaces the legacy
   * `deleteConversation` route. Uses SQLite FK cascade so the row
   * deletion atomically removes child messages.
   *
   * @param channelId - The channel to delete
   * @param principal - Auth principal (must own the channel)
   * @returns True if removed, false if the channel didn't exist
   * @throws {ChatError} `channel_not_found` (404)
   */
  deleteChannel(channelId: string, principal: ChatPrincipal): boolean {
    this.requireOwnedChannel(channelId, principal);
    return this.channels.hardDelete(channelId);
  }

  /**
   * Phase 6.0b — delete all messages in a channel while keeping the
   * channel row. Replaces the legacy `clearConversation` route. Useful
   * when the user wants a "fresh start" without losing the channel
   * itself (and its bookkeeping like `agent_session` binding).
   *
   * @param channelId - The channel to clear
   * @param principal - Auth principal (must own the channel)
   * @returns Number of messages deleted
   * @throws {ChatError} `channel_not_found` (404)
   */
  clearChannel(channelId: string, principal: ChatPrincipal): number {
    this.requireOwnedChannel(channelId, principal);
    return this.messages.deleteAllByChannel(channelId);
  }

  /**
   * Phase 6.0b — count messages in a single channel. Replaces the
   * legacy `getMessageCount` filtered to one conversation.
   *
   * @param channelId - The channel to count
   * @param principal - Auth principal (must own the channel)
   * @returns Message count (0 for empty channels)
   * @throws {ChatError} `channel_not_found` (404)
   */
  countChannelMessages(channelId: string, principal: ChatPrincipal): number {
    this.requireOwnedChannel(channelId, principal);
    return this.messages.count(channelId);
  }

  /**
   * Returns the text of recent OWNER-authored messages (`sender_type='user'`)
   * across ALL channels, newest first, created at or after `sinceMs`.
   *
   * Purpose: the Commitment Approval Guard (2026-06-02 autonomy incident) needs
   * an UNFAKEABLE signal of owner approval — the orchestrator can fabricate a
   * WorkItem title claiming "owner approved", but it cannot fabricate the
   * owner's actual chat history. This is a deliberate cross-channel read (no
   * per-channel authorization) used only server-side by the guard; it returns
   * message TEXT only, never agent/system messages.
   *
   * @param sinceMs - Unix epoch ms; only messages created at/after this are returned.
   * @param limit - Max messages to return (default 100, capped at 500).
   * @returns Owner message contents, newest first.
   */
  getRecentOwnerMessageContents(sinceMs: number, limit = 100): string[] {
    const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
    const rows = this.db
      .prepare(
        `SELECT content FROM chat_messages
         WHERE sender_type = 'user' AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(sinceMs, capped) as Array<{ content: string }>;
    return rows.map((r) => r.content);
  }

  // -------------------------------------------------------------------------
  // Message operations
  // -------------------------------------------------------------------------

  /**
   * Persist a message sent by the caller. The server decides `sender_type`
   * and `sender_id` from the auth principal; client fields are ignored.
   *
   * @param args - Send args
   * @returns The persisted message as a DTO (fresh or deduped)
   * @throws {ChatError} on validation, authorization, or size limit
   */
  sendMessage(args: SendMessageArgs): ChatMessageDTO {
    const row = this.requireReadableChannel(args.channelId, args.principal);

    const content = args.content ?? '';
    if (content.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'content is required');
    }
    const byteLen = Buffer.byteLength(content, 'utf-8');
    if (byteLen > this.config.maxMessageBytes) {
      throw new ChatError(
        CHAT_ERROR_CODES.PAYLOAD_TOO_LARGE,
        413,
        `content exceeds max bytes (${this.config.maxMessageBytes})`,
        { maxBytes: this.config.maxMessageBytes, yourBytes: byteLen },
      );
    }

    const contentType: ChatContentType = args.contentType ?? 'markdown';
    if (!CHAT_CONTENT_TYPES.includes(contentType)) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, `unknown contentType: ${contentType}`);
    }
    // Agents/users cannot self-tag as system.
    if (contentType === 'system_note' && this.resolveSender(row, args.principal).type !== 'system') {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'system_note can only be emitted server-side',
      );
    }

    const { type: senderType, id: senderId } = this.resolveSender(row, args.principal);

    // Phase A: validate mentions array. Bounded count + JSON-byte cap so
    // a misbehaving client cannot blow past the spec §3.2 1KB ceiling.
    const mentions = this.validateMentions(args.mentions);

    // Phase A: validate threadId — must reference an existing message in
    // this channel; refusing dangling thread refs prevents orphan replies
    // and contains UX confusion if the FE composes against a stale id.
    const threadId = this.validateThreadId(args.threadId, args.channelId);

    const { row: persisted } = this.messages.insert({
      channelId: args.channelId,
      senderType,
      senderId,
      content,
      contentType,
      clientMessageId: args.clientMessageId,
      mentions,
      threadId,
      nowMs: this.now(),
    });

    const dto = this.toMessageDTO(persisted, args.attachments ?? []);
    // Phase 6c: broadcast so the WebSocket gateway (and any other
    // in-process subscribers) can fan the new message out to connected
    // clients. The legacy ChatService.EventEmitter contract is now
    // owned by chat-v2 directly.
    this.emit('chat_message', dto);
    return dto;
  }

  /**
   * Canonical server-internal write entry for chat messages.
   *
   * Unlike {@link sendMessage}, which derives `sender_type` / `sender_id`
   * from an authenticated request principal, `recordTurn` is the path
   * used by runtimes, controllers, and bridges that have already
   * resolved exactly who the sender is — e.g.:
   *
   *   - In-process agent runtime finishing a turn
   *   - PTY runtime emitting a complete reply
   *   - Slack inbound bridge persisting a user DM
   *   - `/slack/send` controller persisting the agent's outbound reply
   *
   * Per spec `2026-05-14-unified-chat-message-store.md`, every chat
   * write in the system funnels through this method. No caller should
   * write to {@link MessageStore} directly; no caller should reach
   * into legacy {@link ChatService} (Phase 6 retires it).
   *
   * Idempotent via `clientMessageId` — the underlying store dedups by
   * `(channel_id, clientMessageId)` and returns the existing row with
   * `deduped=true` instead of inserting a duplicate.
   *
   * @param input - Turn payload (channel, sender, content, metadata)
   * @returns The persisted message DTO + dedupe flag
   * @throws {ChatError} `channel_not_found` (404) if the channel is missing
   * @throws {ChatError} `validation_error` (400) on empty content or invalid contentType
   * @throws {ChatError} `payload_too_large` (413) if content exceeds maxMessageBytes
   *
   * @example
   * ```typescript
   * const { message, deduped } = chatV2.recordTurn({
   *   channelId: 'slack-D0AC7-1234',
   *   senderType: 'agent',
   *   senderId: 'crewly-orc',
   *   content: 'Hello!',
   *   clientMessageId: 'agent-finish-2026-05-14T22:30:00Z',
   *   metadata: {
   *     source: 'in-process-runtime',
   *     runtime: 'crewly-agent',
   *     slackChannelId: 'D0AC7',
   *     slackThreadTs: '1234',
   *   },
   * });
   * ```
   */
  recordTurn(input: RecordTurnInput): RecordTurnResult {
    const content = input.content ?? '';
    if (content.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'content is required');
    }
    const byteLen = Buffer.byteLength(content, 'utf-8');
    if (byteLen > this.config.maxMessageBytes) {
      throw new ChatError(
        CHAT_ERROR_CODES.PAYLOAD_TOO_LARGE,
        413,
        `content exceeds max bytes (${this.config.maxMessageBytes})`,
        { maxBytes: this.config.maxMessageBytes, yourBytes: byteLen },
      );
    }

    const contentType: ChatContentType = input.contentType ?? 'markdown';
    if (!CHAT_CONTENT_TYPES.includes(contentType)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown contentType: ${contentType}`,
      );
    }

    if (!CHAT_SENDER_TYPES.includes(input.senderType)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown senderType: ${input.senderType}`,
      );
    }
    if (!input.senderId || input.senderId.length === 0) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'senderId is required');
    }

    const mentions = this.validateMentions(input.mentions);
    const threadId = this.validateThreadId(input.threadId, input.channelId);

    // `metadata.source` is the audit-trail discriminator that lets
    // future tooling tell "this message came from PTY" vs "from
    // in-process runtime" vs "from /slack/send" without parsing
    // content. Spec success criterion #4 depends on this tag being
    // present for every recordTurn caller.
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
    if (!metadata.source) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        'metadata.source is required for recordTurn (audit trail)',
      );
    }
    if (!RECORD_TURN_SOURCES.includes(metadata.source as RecordTurnSource)) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `unknown metadata.source: ${String(metadata.source)}`,
        { allowed: RECORD_TURN_SOURCES },
      );
    }

    const { row: persisted, deduped } = this.messages.insert({
      channelId: input.channelId,
      senderType: input.senderType,
      senderId: input.senderId,
      content,
      contentType,
      clientMessageId: input.clientMessageId,
      mentions,
      threadId,
      metadata,
      nowMs: this.now(),
    });

    const dto = this.toMessageDTO(persisted, []);
    // Phase 6c: emit only for freshly inserted rows. Skipping dedup hits
    // prevents replay-loop subscribers from seeing the same message twice
    // on idempotent retries.
    if (!deduped) {
      this.emit('chat_message', dto);
    }
    return { message: dto, deduped };
  }

  /**
   * Phase A — validate the mentions array passed to sendMessage.
   * Returns the cleaned array (or undefined when input is empty/missing).
   *
   * @param raw - The raw `mentions` field from the request body
   * @returns Validated mention IDs (caller passes to messageStore)
   * @throws {ChatError} `validation_error` (400) on type / size / count violation
   */
  private validateMentions(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'mentions must be an array');
    }
    if (raw.length === 0) return undefined;
    if (raw.length > ChatV2Service.MAX_MENTIONS_PER_MESSAGE) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `mentions exceeds max count (${ChatV2Service.MAX_MENTIONS_PER_MESSAGE})`,
      );
    }
    const cleaned: string[] = [];
    for (const item of raw) {
      if (typeof item !== 'string') {
        throw new ChatError(
          CHAT_ERROR_CODES.VALIDATION,
          400,
          'mentions entries must be strings',
        );
      }
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        throw new ChatError(
          CHAT_ERROR_CODES.VALIDATION,
          400,
          'mentions entries must be non-empty',
        );
      }
      cleaned.push(trimmed);
    }
    // Bound the JSON size — spec §3.2 caps mentions JSON at 1KB.
    const jsonByteLen = Buffer.byteLength(JSON.stringify(cleaned), 'utf-8');
    if (jsonByteLen > ChatV2Service.MAX_MENTIONS_JSON_BYTES) {
      throw new ChatError(
        CHAT_ERROR_CODES.PAYLOAD_TOO_LARGE,
        413,
        `mentions JSON exceeds max bytes (${ChatV2Service.MAX_MENTIONS_JSON_BYTES})`,
      );
    }
    return cleaned;
  }

  /**
   * Phase A — validate the threadId passed to sendMessage.
   *
   * Returns the original threadId if it's a valid reference to a message
   * in the same channel, or undefined when input is empty/missing.
   * Refuses dangling references and cross-channel thread roots.
   *
   * @param raw - The raw `threadId` field from the request body
   * @param channelId - The channel this message will be inserted into
   * @returns Validated thread root id (caller passes to messageStore)
   * @throws {ChatError} `validation_error` (400) when invalid
   */
  private validateThreadId(raw: unknown, channelId: string): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'string') {
      throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, 'threadId must be a string');
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;

    const root = this.messages.getById(trimmed);
    if (!root) {
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `threadId references a non-existent message`,
        { threadId: trimmed },
      );
    }
    if (root.channel_id !== channelId) {
      // Returning validation_error (not channel_not_found) because the
      // caller's intent IS valid — they're just pointing at the wrong
      // channel's thread root. Distinct error helps debugging.
      throw new ChatError(
        CHAT_ERROR_CODES.VALIDATION,
        400,
        `threadId belongs to a different channel`,
        { threadId: trimmed, expectedChannelId: channelId },
      );
    }
    return trimmed;
  }

  /**
   * Page messages for a channel the caller may read.
   *
   * @param args - List args
   * @returns A pagination envelope
   * @throws {ChatError} on auth or invalid cursor
   */
  listMessages(args: ListMessagesArgs): ChatMessageListResult {
    this.requireReadableChannel(args.channelId, args.principal);

    const page = this.messages.listByChannel(args.channelId, {
      cursor: args.cursor ?? null,
      limit: args.limit,
      direction: args.direction,
    });

    // Slack-style thread reply counts: one aggregate query for the whole
    // channel, then attach `replyCount`/`lastReplyAt` to the root-message
    // DTOs on this page. Root messages are those whose own `threadId` is
    // unset; replies never carry a count.
    const threadSummary = this.messages.threadReplySummary(args.channelId);
    const messages = page.rows.map((r) => {
      const dto = this.toMessageDTO(r, []);
      if (dto.threadId === undefined) {
        const summary = threadSummary.get(dto.id);
        if (summary) {
          dto.replyCount = summary.replyCount;
          dto.lastReplyAt = new Date(summary.lastReplyAtMs).toISOString();
        }
      }
      return dto;
    });

    return {
      channelId: args.channelId,
      messages,
      nextCursor: page.nextCursor,
      prevCursor: page.prevCursor,
    };
  }

  // -------------------------------------------------------------------------
  // Authorization helpers (§7.2)
  // -------------------------------------------------------------------------

  /** Fetch the channel and enforce caller = owner. */
  private requireOwnedChannel(channelId: string, principal: ChatPrincipal): ChatChannelRow {
    const row = this.channels.getById(channelId);
    if (!row) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    if (row.owner_user_id !== principal.userId) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    return row;
  }

  /**
   * Fetch the channel and allow if the caller is the owner OR the bound agent
   * OR the channel is a shared bridged Slack conversation.
   *
   * Slack-bridged channels (`slack-…`, persisted under the synthetic `'system'`
   * owner by the inbound bridge) belong to no single Crewly user — exactly like
   * {@link ChannelStore.listBridged} surfaces them in the consolidated list
   * regardless of owner, this lets the web user READ them (e.g. the team-chat
   * surface merges them inline into the Orchestrator timeline). Writes are still
   * gated downstream by {@link resolveSender}, which throws `forbidden` unless
   * the caller is the owner or bound agent — so this read allowance does not let
   * a user post into a bridged channel.
   *
   * Used for read + send; agents must always be acting from their own session.
   */
  private requireReadableChannel(channelId: string, principal: ChatPrincipal): ChatChannelRow {
    const row = this.channels.getById(channelId);
    if (!row) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    const isOwner = row.owner_user_id === principal.userId;
    const isBoundAgent =
      !!principal.agentSession && principal.agentSession === row.agent_session;
    const isSharedBridged = row.id.startsWith('slack-');
    if (!isOwner && !isBoundAgent && !isSharedBridged) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_NOT_FOUND, 404, 'Channel not found');
    }
    if (row.archived_at) {
      throw new ChatError(CHAT_ERROR_CODES.CHANNEL_ARCHIVED, 404, 'Channel is archived');
    }
    return row;
  }

  /** Decide sender_type + sender_id for a message based on principal + channel. */
  private resolveSender(
    channel: ChatChannelRow,
    principal: ChatPrincipal,
  ): { type: ChatSenderType; id: string } {
    if (principal.agentSession && principal.agentSession === channel.agent_session) {
      return { type: 'agent', id: principal.agentSession };
    }
    if (principal.userId === channel.owner_user_id) {
      return { type: 'user', id: principal.userId };
    }
    // Server-minted system messages go through an internal path, not this one.
    throw new ChatError(CHAT_ERROR_CODES.FORBIDDEN, 403, 'Principal cannot send in this channel');
  }

  // -------------------------------------------------------------------------
  // DTO mappers
  // -------------------------------------------------------------------------

  /** Map a channel row + live presence into the wire DTO. */
  private toChannelDTO(row: ChatChannelRow): ChatChannelDTO {
    // Phase B backwards-compat: legacy rows (pre-migration) lack `type` /
    // team scope fields. The migration backfills `type='dm'` for existing
    // rows; here we defend the in-memory path against rows that may not
    // yet have the column populated (e.g. mid-migration test runs).
    const channelType = row.type ?? 'dm';
    const presenceSource = channelType === 'dm' ? row.agent_session : '';
    const presence = (this.presence ?? DEFAULT_PRESENCE)(presenceSource);
    return {
      id: row.id,
      agentSession: row.agent_session,
      name: row.name,
      purpose: row.purpose ?? undefined,
      createdAt: row.created_at,
      archivedAt: row.archived_at ?? null,
      lastMessageAt: row.last_message_at ?? null,
      agentPresence: {
        status: presence.status,
        lastSeenAt: presence.lastSeenAt,
      },
      type: channelType,
      teamId: row.team_id ?? undefined,
      projectId: row.project_id ?? undefined,
      targetMemberId: row.target_member_id ?? undefined,
      // Phase B-2: huddle channels surface their roster inline so the
      // Portal can render member avatars without a second round-trip.
      // Non-huddle rows leave this undefined.
      ...(channelType === 'huddle'
        ? { members: this.queryHuddleMembers(row.id) }
        : {}),
    };
  }

  /** Map a message row to the wire DTO. Attachments passed in by the caller. */
  private toMessageDTO(row: ChatMessageRow, attachments: ChatAttachmentDTO[]): ChatMessageDTO {
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = undefined;
      }
    }
    // Phase B backwards-compat: parse mentions from JSON-encoded array
    // column. Legacy rows (pre-migration) have null; we surface as
    // empty array so the wire contract `mentions: string[]` is never
    // violated. A malformed JSON column also falls back to `[]` rather
    // than throwing — the wire contract is the priority.
    let mentions: string[] = [];
    if (row.mentions) {
      try {
        const parsed = JSON.parse(row.mentions) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          mentions = parsed as string[];
        }
      } catch {
        mentions = [];
      }
    }
    return {
      id: row.id,
      channelId: row.channel_id,
      seq: row.seq,
      senderType: row.sender_type,
      senderId: row.sender_id,
      content: row.content,
      contentType: row.content_type,
      createdAt: row.created_at,
      attachments,
      metadata,
      mentions,
      threadId: row.thread_id ?? undefined,
    };
  }
}
