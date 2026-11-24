/**
 * Channel pages, server side: the hooks that need the live chat store, the
 * team storage and the task pool.
 *
 * @module services/wiki/channel-page.server
 */

import * as path from 'path';
import { CHANNEL_PAGE_CONSTANTS } from '../../constants.js';
import type { Team } from '../../types/index.js';
import { TERMINAL_WORK_ITEM_STATUSES } from '../../types/v2/work-item.types.js';
import { getChatV2Service } from '../chat-v2/chat-v2.singleton.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { TaskPoolService } from '../task-pool/task-pool.service.js';
import { readChannelPage } from './channel-page.js';
import { channelPageVault } from './channel-page.wiring.js';
import { ChannelPagesNightlyService } from './channel-pages-nightly.service.js';

/** The storage call the name lookup needs. */
export interface TeamsStorage {
  getTeams(): Promise<Team[]>;
}

let nightly: ChannelPagesNightlyService | null = null;

/**
 * Display names of the agents on this machine, by session.
 *
 * @param storage - Team storage
 * @returns Session → member name; empty when the teams cannot be read
 */
export async function sessionDisplayNames(storage: TeamsStorage): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (const team of await storage.getTeams()) {
      for (const member of team.members ?? []) {
        if (member.sessionName && member.name) names.set(member.sessionName, member.name);
      }
    }
  } catch {
    /* without names a session name is shown */
  }
  return names;
}

/**
 * A room by its chat id or its name.
 *
 * @param ref - Chat id, `#name` or name
 * @returns The room, or null when this machine has none by that reference
 */
export function findRoomByRef(ref: string): { id: string; name: string } | null {
  if (!ref) return null;
  const chat = getChatV2Service();
  const byId = chat.getChannelForBridge(ref);
  const room = byId && byId.type === 'huddle' && !byId.archivedAt ? byId : chat.findRoomByNameForBridge(ref);
  return room ? { id: room.id, name: room.name } : null;
}

/**
 * Start the nightly channel-page pass (once per process).
 *
 * @param storage - Team storage
 * @returns The running service
 */
export async function startChannelPagesNightly(storage: TeamsStorage): Promise<ChannelPagesNightlyService> {
  if (nightly) return nightly;
  const chat = getChatV2Service();
  const pool = TaskPoolService.getInstance();
  nightly = new ChannelPagesNightlyService({
    statePath: path.join(getCrewlyHomePath(), CHANNEL_PAGE_CONSTANTS.NIGHTLY_STATE_FILE),
    listActiveRooms: (sinceMs, limit) => chat.listRoomsActiveSince(sinceMs, limit),
    getRoom: (channelId) => findRoomByRef(channelId),
    listRoomRows: (channelId, sinceMs, limit) => chat.listRoomRows(channelId, sinceMs, limit),
    sessionNames: () => sessionDisplayNames(storage),
    readPage: (channelName) => readChannelPage(channelPageVault(), channelName),
    addWorkItem: (item) => pool.addToPool(item),
    isWorkItemOpen: async (workItemId) => {
      const item = await pool.findWorkItem(workItemId);
      return !!item && !TERMINAL_WORK_ITEM_STATUSES.has(item.status);
    },
  });
  nightly.start();
  return nightly;
}

/** Stop the nightly pass and forget it (shutdown and tests). */
export function stopChannelPagesNightly(): void {
  nightly?.stop();
  nightly = null;
}
