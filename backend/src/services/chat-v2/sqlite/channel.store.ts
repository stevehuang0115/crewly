/**
 * ChannelStore — CRUD for `chat_channels`.
 *
 * All authorization is handled at a higher layer (`ChatV2Service`);
 * this store only enforces DB-level invariants (FKs, unique indexes).
 *
 * @module services/chat-v2/sqlite/channel.store
 */

import { randomUUID } from 'crypto';
import {
  CHAT_ERROR_CODES,
  ChatError,
  type ChatChannelRow,
  type ChatChannelType,
} from '../types.js';
import type { ChatDatabase } from './chat-db.js';

// ---------------------------------------------------------------------------
// Constants — shared SELECT column list, single source of truth
// ---------------------------------------------------------------------------

/**
 * Canonical column list for `chat_channels` SELECTs. Including all Phase A
 * columns (type / team_id / project_id / target_member_id) here keeps every
 * read path in this store mapping to a fully-populated `ChatChannelRow`.
 */
const CHANNEL_SELECT_COLUMNS = `
  id, agent_session, owner_user_id, name, purpose,
  created_at, archived_at, last_message_at,
  type, team_id, project_id, target_member_id
`;

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

/** Payload for `ChannelStore.create`. */
export interface ChannelCreateInput {
  /**
   * Wire-level session binding. For `type='dm'` (default), this is the
   * agent's session ID and the partial unique index enforces 1:1 binding.
   * For `type='channel'`, callers should pass the empty string `''` —
   * channel rows are excluded from the dm-binding unique index by design.
   */
  agentSession: string;
  ownerUserId: string;
  name: string;
  purpose?: string | null;
  /**
   * Phase A (SEALED §3.1) — channel type. Defaults to `'dm'` to preserve
   * the Phase 1 / Week 2 contract for callers that omit this field.
   */
  type?: ChatChannelType;
  /** Phase A — required when `type='channel'`; null/empty for DMs. */
  teamId?: string | null;
  /** Phase A — optional project link for project-scoped channels. */
  projectId?: string | null;
  /** Phase A — for `type='dm'`, the resolved member-ID being DM'd. */
  targetMemberId?: string | null;
  /** Override the clock (tests). */
  nowMs?: number;
  /** Override the generated id (tests / deterministic callers). */
  id?: string;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** SQLite-backed store for chat channels. */
export class ChannelStore {
  constructor(private readonly db: ChatDatabase) {}

  /**
   * Create a new channel. Enforces the 1:1 agent-binding by catching
   * the SQLite unique-constraint error and surfacing it as a
   * `ChatError(agent_already_bound, 409)`.
   *
   * @param input - The channel creation payload
   * @returns The inserted channel row
   * @throws {ChatError} `agent_already_bound` (409) if the agent is already bound
   *   to another active channel.
   */
  create(input: ChannelCreateInput): ChatChannelRow {
    const id = input.id ?? randomUUID();
    const createdAt = input.nowMs ?? Date.now();
    const purpose = input.purpose ?? null;
    const channelType: ChatChannelType = input.type ?? 'dm';
    const teamId = input.teamId ?? null;
    const projectId = input.projectId ?? null;
    const targetMemberId = input.targetMemberId ?? null;

    const stmt = this.db.prepare(
      `INSERT INTO chat_channels
         (id, agent_session, owner_user_id, name, purpose, created_at,
          type, team_id, project_id, target_member_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      stmt.run(
        id,
        input.agentSession,
        input.ownerUserId,
        input.name,
        purpose,
        createdAt,
        channelType,
        teamId,
        projectId,
        targetMemberId,
      );
    } catch (err) {
      // Unique constraint means either the partial index on agent_session fired
      // (the common case — 1:1 binding violated) or we raced an id collision.
      // In either case it's safer to check `findActiveByAgentSession` before
      // surfacing a typed error.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE')) {
        const existing = this.findActiveByAgentSession(input.agentSession);
        if (existing) {
          throw new ChatError(
            CHAT_ERROR_CODES.AGENT_ALREADY_BOUND,
            409,
            `Agent "${input.agentSession}" is already bound to another active channel.`,
            { existingChannelId: existing.id },
          );
        }
      }
      throw err;
    }

    const created = this.getById(id);
    // Row must exist — insert just succeeded. This branch is for type-narrowing.
    if (!created) {
      throw new ChatError(
        CHAT_ERROR_CODES.INTERNAL,
        500,
        'Channel disappeared immediately after insert',
      );
    }
    return created;
  }

  /**
   * Look up a channel by its id (active or archived).
   *
   * @param id - The channel id
   * @returns The row, or null if not found
   */
  getById(id: string): ChatChannelRow | null {
    const row = this.db
      .prepare(
        `SELECT ${CHANNEL_SELECT_COLUMNS}
         FROM chat_channels
         WHERE id = ?`,
      )
      .get(id) as ChatChannelRow | undefined;
    return row ?? null;
  }

  /**
   * Find the single active channel bound to an agent session, if any.
   * Uses the partial unique index, so at most one row is returned.
   *
   * @param agentSession - The agent session id
   * @returns The active channel row, or null
   */
  findActiveByAgentSession(agentSession: string): ChatChannelRow | null {
    // Phase A: scope to type='dm' so this method's contract matches the
    // post-migration `uq_channel_agent_dm_active` partial unique index.
    // type='channel' rows can share the empty agent_session sentinel; we
    // never want this lookup to surface those.
    const row = this.db
      .prepare(
        `SELECT ${CHANNEL_SELECT_COLUMNS}
         FROM chat_channels
         WHERE agent_session = ? AND archived_at IS NULL AND type = 'dm'
         LIMIT 1`,
      )
      .get(agentSession) as ChatChannelRow | undefined;
    return row ?? null;
  }

  /**
   * Find the most-recent active DM channel owned by a specific user and
   * bound to a specific agent session. Used by the `ensureDmChannel`
   * helper backing the /agents page — the owner-scoped variant is needed
   * because the `uq_channel_agent_dm_active` unique index was dropped
   * (see chat-db.ts:380-386), so multiple DM rows for the same agent
   * can coexist (e.g. created by legacy bridge code with the synthetic
   * `'system'` owner).
   *
   * Ordering matches `listByOwner`: most-recent activity first, so the
   * caller always lands on the DM the user was last using.
   *
   * @param ownerUserId - The user_id that must own the channel
   * @param agentSession - The agent session id
   * @returns The most-recent active DM channel row, or null
   */
  findActiveDmByOwnerAndAgent(
    ownerUserId: string,
    agentSession: string,
  ): ChatChannelRow | null {
    const row = this.db
      .prepare(
        `SELECT ${CHANNEL_SELECT_COLUMNS}
         FROM chat_channels
         WHERE owner_user_id = ?
           AND agent_session = ?
           AND archived_at IS NULL
           AND type = 'dm'
         ORDER BY COALESCE(last_message_at, created_at) DESC
         LIMIT 1`,
      )
      .get(ownerUserId, agentSession) as ChatChannelRow | undefined;
    return row ?? null;
  }

  /**
   * Find the oldest active `type='channel'` row for a team, if any.
   *
   * Team channels are not owner-scoped — a team channel belongs to the
   * whole team — so this lookup is keyed on `team_id` alone. Ordering by
   * `created_at ASC` returns the team's original (e.g. `#general`) channel
   * stably, which is what `ensureTeamChannel` treats as the canonical
   * "the team already has a channel" marker.
   *
   * @param teamId - The team id whose channel to find
   * @returns The oldest active team channel row, or null when none exists
   */
  findActiveChannelByTeam(teamId: string): ChatChannelRow | null {
    const row = this.db
      .prepare(
        `SELECT ${CHANNEL_SELECT_COLUMNS}
         FROM chat_channels
         WHERE team_id = ? AND archived_at IS NULL AND type = 'channel'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(teamId) as ChatChannelRow | undefined;
    return row ?? null;
  }

  /**
   * List channels owned by a user.
   *
   * Phase C — extended with `type` + `teamId` filter options so the
   * `GET /api/chat/channels` endpoint can serve the channel-rail's
   * grouped/workspace-scoped views without shipping every row to the
   * client. Filters compose with AND; passing `undefined` for either is
   * a no-op (the existing all-channels behavior).
   *
   * @param ownerUserId - The user_id whose channels to return
   * @param options - Listing options
   * @param options.includeArchived - When false (default), filter out archived rows
   * @param options.limit - Max rows to return (capped at 100)
   * @param options.type - Phase C: when set, filter rows to this channel type
   *   (`'dm'` or `'channel'`). Useful for the channel-rail's "DMs only" /
   *   "Channels only" views.
   * @param options.teamId - Phase C: when set, filter rows whose `team_id`
   *   matches. Used by the workspace-scoped Channels group; empty / null
   *   `team_id` rows are excluded by this filter on purpose (DMs and
   *   workspace-less rows belong to no team).
   * @returns Channel rows sorted by `last_message_at DESC, created_at DESC`
   */
  listByOwner(
    ownerUserId: string,
    options?: {
      includeArchived?: boolean;
      limit?: number;
      type?: ChatChannelType;
      teamId?: string;
    },
  ): ChatChannelRow[] {
    const includeArchived = options?.includeArchived ?? false;
    const limit = Math.min(options?.limit ?? 50, 100);

    // Build WHERE clauses + bound params positionally so the filter set
    // composes cleanly. Each branch is independent — no implicit coupling.
    const where: string[] = ['owner_user_id = ?'];
    const params: unknown[] = [ownerUserId];

    if (!includeArchived) {
      where.push('archived_at IS NULL');
    }
    if (options?.type !== undefined) {
      where.push('type = ?');
      params.push(options.type);
    }
    if (options?.teamId !== undefined) {
      where.push('team_id = ?');
      params.push(options.teamId);
    }

    const sql = `
      SELECT ${CHANNEL_SELECT_COLUMNS}
      FROM chat_channels
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(last_message_at, created_at) DESC
      LIMIT ?
    `;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as ChatChannelRow[];
  }

  /**
   * Mark a channel as archived (soft-delete). No-op if already archived.
   *
   * @param id - The channel id
   * @param nowMs - Optional override for the archive timestamp
   * @returns True if a row was updated (was active), false otherwise
   */
  archive(id: string, nowMs?: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE chat_channels
         SET archived_at = ?
         WHERE id = ? AND archived_at IS NULL`,
      )
      .run(nowMs ?? Date.now(), id);
    return result.changes > 0;
  }

  /**
   * Phase 6.0b — clear an archived flag. Inverse of {@link archive};
   * required by the legacy `unarchiveConversation` controller route.
   *
   * @param id - The channel id
   * @returns True if a row was updated (was archived), false otherwise
   */
  unarchive(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE chat_channels
         SET archived_at = NULL
         WHERE id = ? AND archived_at IS NOT NULL`,
      )
      .run(id);
    return result.changes > 0;
  }

  /**
   * Phase 6.0b — rename a channel. Used by the legacy
   * `updateConversationTitle` controller route.
   *
   * @param id - The channel id
   * @param name - The new name
   * @returns True if a row was updated, false if the channel doesn't exist
   */
  rename(id: string, name: string): boolean {
    const result = this.db
      .prepare(`UPDATE chat_channels SET name = ? WHERE id = ?`)
      .run(name, id);
    return result.changes > 0;
  }

  /**
   * Phase 6.0b — hard-delete a channel and all its messages. Note: this
   * is distinct from {@link archive} (soft delete via archived_at).
   * Used by the legacy `deleteConversation` controller route.
   *
   * FK ON DELETE CASCADE on `chat_messages.channel_id` cleans up
   * messages atomically with the channel row.
   *
   * @param id - The channel id to remove
   * @returns True if a row was removed, false if no such channel
   */
  hardDelete(id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM chat_channels WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  /**
   * Bump `last_message_at` to a provided timestamp if it is greater than
   * the current value. Safe to call many times.
   *
   * @param id - The channel id
   * @param timestampMs - The timestamp to record
   */
  touchLastMessageAt(id: string, timestampMs: number): void {
    this.db
      .prepare(
        `UPDATE chat_channels
         SET last_message_at = ?
         WHERE id = ?
           AND (last_message_at IS NULL OR last_message_at < ?)`,
      )
      .run(timestampMs, id, timestampMs);
  }
}
