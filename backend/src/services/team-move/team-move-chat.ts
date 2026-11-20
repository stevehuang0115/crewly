/**
 * Chat channels and rooms of a team (chat-v2 SQLite): which exist, who is a
 * member, and putting them on another machine. Messages stay where they were
 * said: only the channels and their membership move, so the team's rooms (and
 * the Slack mapping that points at them) exist on the target from the start.
 *
 * @module services/team-move/team-move-chat
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { openChatDatabase, type ChatDatabase } from '../chat-v2/sqlite/chat-db.js';
import type { TeamIdentity } from './team-move-select.js';

/** A `chat_channels` row (columns vary by schema version). */
export type ChannelRecord = Record<string, string | number | null>;
/** A `chat_channel_members` row. */
export interface ChannelMemberRecord {
  channel_id: string;
  member_session: string;
  joined_at: number;
}

/** A `chat_messages` row (columns vary by schema version). */
export type MessageRecord = Record<string, string | number | null>;

/** What a package carries of the chat store. */
export interface ChatRecords {
  channels: ChannelRecord[];
  members: ChannelMemberRecord[];
  /**
   * The newest messages of the team's Slack room (crewly#1344): the room's
   * thread history, so a thread turn on the target does not reach the agent
   * with only the clipped "thread so far" block. Absent in older packages.
   */
  messages?: MessageRecord[];
}

/** Caps on the messages carried. */
export interface ChatMessageLimits {
  perChannel: number;
  totalBytes: number;
}

/** File name of the chat-v2 store under the Crewly home (the default chat database path). */
export const CHAT_V2_DB_FILE = 'chat.db';

/**
 * Open the chat store of a home.
 *
 * @param home - Crewly home
 * @returns Database handle (caller closes)
 */
function open(home: string): ChatDatabase {
  return openChatDatabase({ dbPath: path.join(home, CHAT_V2_DB_FILE), skipIntegrityCheck: true });
}

/**
 * The team's channels, rooms and DMs with their members.
 *
 * @param home - Crewly home of the source
 * @param id - Team identity
 * @param options - `includeChannelIds` always travel; `rosterOnlyChannelIds` carry only this team's members; `messages` caps the history carried
 * @returns Records (empty when the machine has no chat store)
 */
export function readTeamChat(home: string, id: TeamIdentity, options: { includeChannelIds?: readonly string[]; rosterOnlyChannelIds?: readonly string[]; messages?: ChatMessageLimits & { channelIds: readonly string[] } } = {}): ChatRecords {
  if (!existsSync(path.join(home, CHAT_V2_DB_FILE))) return { channels: [], members: [] };
  const db = open(home);
  try {
    const sessions = [...id.sessions];
    const always = new Set(options.includeChannelIds ?? []);
    const channels = db.prepare('SELECT * FROM chat_channels WHERE archived_at IS NULL').all() as ChannelRecord[];
    const members = db.prepare('SELECT channel_id, member_session, joined_at FROM chat_channel_members').all() as ChannelMemberRecord[];
    const membersByChannel = new Map<string, string[]>();
    for (const m of members) {
      const list = membersByChannel.get(m.channel_id) ?? [];
      list.push(m.member_session);
      membersByChannel.set(m.channel_id, list);
    }
    const selected = channels.filter((c) => {
      // The room behind the team's Slack channel always travels, whoever else
      // is in it (the orchestrator, a guest agent): on the SteamFun move the
      // Slack mapping pointed at a room the target never had (crewly#1344).
      if (always.has(String(c['id']))) return true;
      if (c['team_id'] === id.teamId) return true;
      if (c['type'] === 'dm') return typeof c['agent_session'] === 'string' && id.sessions.has(c['agent_session']);
      if (c['type'] === 'huddle') {
        const roster = membersByChannel.get(String(c['id'])) ?? [];
        return roster.length > 0 && roster.every((s) => sessions.includes(s));
      }
      return false;
    });
    const ids = new Set(selected.map((c) => String(c['id'])));
    // A channel shared with other teams carries only this team's agents: the others are not on the target.
    const rosterOnly = new Set(options.rosterOnlyChannelIds ?? []);
    const records: ChatRecords = {
      channels: selected,
      members: members.filter((m) => ids.has(m.channel_id) && (!rosterOnly.has(m.channel_id) || id.sessions.has(m.member_session))),
    };
    if (options.messages) {
      const wanted = options.messages.channelIds.filter((c) => ids.has(c));
      if (wanted.length > 0) records.messages = readRecentMessages(db, wanted, options.messages);
    }
    return records;
  } finally {
    db.close();
  }
}

/**
 * The newest messages of the given channels, oldest first, within the caps.
 *
 * @param db - Open chat store
 * @param channelIds - Channels to read
 * @param limits - Per-channel count and total byte caps
 * @returns Rows, oldest first per channel
 */
function readRecentMessages(db: ChatDatabase, channelIds: readonly string[], limits: ChatMessageLimits): MessageRecord[] {
  const out: MessageRecord[] = [];
  let bytes = 0;
  const stmt = db.prepare('SELECT * FROM chat_messages WHERE channel_id = ? ORDER BY seq DESC LIMIT ?');
  for (const channelId of channelIds) {
    const rows = (stmt.all(channelId, limits.perChannel) as MessageRecord[]).reverse();
    const kept: MessageRecord[] = [];
    // Newest kept when the byte cap bites: drop from the oldest end.
    for (let i = rows.length - 1; i >= 0; i--) {
      const size = JSON.stringify(rows[i]).length;
      if (bytes + size > limits.totalBytes) break;
      bytes += size;
      kept.unshift(rows[i]!);
    }
    out.push(...kept);
  }
  return out;
}

/**
 * Point carried records at the channel ids the target already uses: a channel
 * that exists there under another id is not inserted again; its members and
 * messages move to the existing id. Moved messages carry no `seq`: {@link applyTeamChat}
 * numbers them after the messages the channel already has there.
 *
 * @param records - Records from the package
 * @param idMap - Source channel id to the id on this machine
 * @returns Records for {@link applyTeamChat}
 */
export function remapChatChannels(records: ChatRecords, idMap: ReadonlyMap<string, string>): ChatRecords {
  const out: ChatRecords = {
    channels: records.channels.filter((c) => !idMap.has(String(c['id']))),
    members: records.members.map((m) => ({ ...m, channel_id: idMap.get(m.channel_id) ?? m.channel_id })),
  };
  if (records.messages) {
    out.messages = records.messages.map((row) => {
      const to = idMap.get(String(row['channel_id']));
      if (!to) return row;
      return { ...row, channel_id: to, seq: null };
    });
  }
  return out;
}

/** Outcome of {@link applyTeamChat}. */
export interface ApplyChatResult {
  channelsAdded: number;
  channelsExisting: number;
  membersAdded: number;
  /** Carried messages written (absent when the package carried none) */
  messagesAdded?: number;
}

/**
 * Add channels and members that are not there yet (idempotent). A channel that
 * exists already (same id, or the same unique name) is kept as it is.
 *
 * @param home - Crewly home of the target
 * @param records - Records from the package
 * @returns Counts
 */
export function applyTeamChat(home: string, records: ChatRecords): ApplyChatResult {
  const result: ApplyChatResult = { channelsAdded: 0, channelsExisting: 0, membersAdded: 0 };
  if (records.channels.length === 0) return result;
  const db = open(home);
  try {
    const columns = new Set((db.prepare('PRAGMA table_info(chat_channels)').all() as Array<{ name: string }>).map((c) => c.name));
    const tx = db.transaction(() => {
      for (const row of records.channels) {
        const keys = Object.keys(row).filter((k) => columns.has(k));
        const sql = `INSERT OR IGNORE INTO chat_channels (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
        const info = db.prepare(sql).run(...keys.map((k) => row[k] ?? null));
        if (info.changes > 0) result.channelsAdded += 1;
        else result.channelsExisting += 1;
      }
      const insertMember = db.prepare('INSERT OR IGNORE INTO chat_channel_members (channel_id, member_session, joined_at) VALUES (?, ?, ?)');
      for (const m of records.members) {
        const exists = db.prepare('SELECT 1 FROM chat_channels WHERE id = ?').get(m.channel_id);
        if (!exists) continue;
        if (insertMember.run(m.channel_id, m.member_session, m.joined_at).changes > 0) result.membersAdded += 1;
      }
      if (records.messages && records.messages.length > 0) {
        result.messagesAdded = 0;
        const messageColumns = new Set((db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>).map((c) => c.name));
        const nextSeq = new Map<string, number>();
        for (const row of records.messages) {
          const channelId = row['channel_id'];
          if (typeof channelId !== 'string' || !db.prepare('SELECT 1 FROM chat_channels WHERE id = ?').get(channelId)) continue;
          if (row['seq'] === null || row['seq'] === undefined) {
            const next = nextSeq.get(channelId) ?? ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE channel_id = ?').get(channelId) as { m: number }).m + 1);
            row['seq'] = next;
            nextSeq.set(channelId, next + 1);
          }
          const keys = Object.keys(row).filter((k) => messageColumns.has(k));
          const sql = `INSERT OR IGNORE INTO chat_messages (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
          if (db.prepare(sql).run(...keys.map((k) => row[k] ?? null)).changes > 0) result.messagesAdded += 1;
        }
      }
    });
    tx();
  } finally {
    db.close();
  }
  return result;
}

/**
 * Archive (hide) or unarchive channels. Used on the source while the moved
 * team is away.
 *
 * @param home - Crewly home
 * @param channelIds - Channel ids
 * @param archived - True to archive, false to bring them back
 * @param nowMs - Archive time
 * @returns Number of rows changed
 */
export function setChannelsArchived(home: string, channelIds: readonly string[], archived: boolean, nowMs: number = Date.now()): number {
  if (channelIds.length === 0 || !existsSync(path.join(home, CHAT_V2_DB_FILE))) return 0;
  const db = open(home);
  try {
    const stmt = archived
      ? db.prepare('UPDATE chat_channels SET archived_at = ? WHERE id = ? AND archived_at IS NULL')
      : db.prepare('UPDATE chat_channels SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL');
    let changed = 0;
    const tx = db.transaction(() => {
      for (const id of channelIds) changed += (archived ? stmt.run(nowMs, id) : stmt.run(id)).changes;
    });
    tx();
    return changed;
  } finally {
    db.close();
  }
}
