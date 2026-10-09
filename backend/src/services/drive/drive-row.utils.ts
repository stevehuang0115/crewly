/**
 * Drive mode's mark on chat rows (specs/2026-10-08-drive-mode.md §7). Every
 * chat-v2 row Drive mode writes — the owner's voice turn, an agent's spoken
 * reply, a recap — carries `metadata.via = 'drive-mode'`. The Slack room and
 * DM mirrors skip those rows: a Drive mode conversation is spoken on the
 * phone, and its one recap is posted to Slack by Drive mode itself.
 *
 * @module services/drive/drive-row.utils
 */

import { DRIVE_CONSTANTS } from '../../constants.js';

/**
 * Whether a chat row was written by Drive mode.
 *
 * @param row - A chat row (or anything with metadata), or null
 * @returns True for a Drive mode row
 */
export function isDriveModeRow(row: { metadata?: Record<string, unknown> } | null | undefined): boolean {
  return row?.metadata?.via === DRIVE_CONSTANTS.VIA;
}
