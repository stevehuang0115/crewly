/**
 * Wiring for channel pages: where they live on this machine, and the block
 * attached to a message delivered in a room.
 *
 * @module services/wiki/channel-page.wiring
 */

import * as path from 'path';
import { CHANNEL_PAGE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { readChannelPage, recentThreadsOf, renderChannelBlock, type RoomRow } from './channel-page.js';

/** A room row with the agent session recorded on a mirrored agent post. */
export interface AuthoredRoomRow extends RoomRow {
  author: string | null;
}

/** What the block needs from the rest of the server. */
export interface ChannelBlockDeps {
  /** Messages of a room since a time, oldest first */
  listRoomRows: (channelId: string, sinceMs: number, limit: number) => AuthoredRoomRow[];
  /** Display names of the agents on this machine, by session */
  sessionNames: () => Promise<Map<string, string>>;
  /** Global vault root (defaults to this machine's) */
  vaultPath?: string;
  /** Clock (tests) */
  now?: () => number;
}

/**
 * The global vault of this machine, where channel pages live.
 *
 * @param home - CREWLY_HOME (defaults to this machine's)
 * @returns Vault root
 */
export function channelPageVault(home: string = getCrewlyHomePath()): string {
  return path.join(home, 'global-wiki');
}

/**
 * The agent that wrote a room row, by display name.
 *
 * A local agent's row carries its session as the sender. An agent on another
 * machine is stored as a person's row named `Ella (Team) (agent)` with its
 * session in the metadata; so is a local agent's post mirrored from Slack.
 *
 * @param row - The row
 * @param names - Display names of local agents, by session
 * @returns The name, or null when a person wrote the row
 *
 * @example
 * ```ts
 * agentNameOfRow({ senderType: 'user', senderId: 'Ella (PA Team) (agent)', author: 'pa-ella-1', ... }, new Map()); // 'Ella'
 * ```
 */
export function agentNameOfRow(row: AuthoredRoomRow, names: ReadonlyMap<string, string>): string | null {
  if (row.senderType === 'agent') return names.get(row.senderId) ?? row.senderId;
  if (!row.author) return null;
  const local = names.get(row.author);
  if (local) return local;
  const shown = row.senderId.replace(/\s*\(agent\)\s*$/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return shown || row.author;
}

/**
 * The command an agent runs to record who leads a room or covers what.
 *
 * @param channelId - chat-v2 id of the room
 * @returns Command text for a prompt
 */
export function channelRecordCommand(channelId: string): string {
  const base = `bash config/skills/agent/core/channel-notes/execute.sh --channel ${channelId}`;
  return `\`${base} --lead "<name>"\` or \`${base} --cover "<name>: <what they cover>"\`.`;
}

/**
 * The channel block for one delivery.
 *
 * @param deps - Server hooks
 * @param channel - The room
 * @returns The block, or '' when nothing is known about the room. Never throws.
 */
export async function channelBlockFor(deps: ChannelBlockDeps, channel: { id: string; name: string }): Promise<string> {
  try {
    const C = CHANNEL_PAGE_CONSTANTS;
    const now = (deps.now ?? Date.now)();
    const [page, names] = await Promise.all([readChannelPage(deps.vaultPath ?? channelPageVault(), channel.name), deps.sessionNames()]);
    const rows = deps.listRoomRows(channel.id, now - C.RECENT_WINDOW_MS, C.RECENT_SCAN_MESSAGES);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const recent = recentThreadsOf(rows, (row) => agentNameOfRow(byId.get(row.id) ?? { ...row, author: null }, names));
    return renderChannelBlock({ channelName: channel.name, page, recent, recordCommand: channelRecordCommand(channel.id) });
  } catch {
    return '';
  }
}
