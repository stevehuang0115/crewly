/**
 * Fallback target for owner-facing Slack notifications.
 *
 * `SlackService.sendNotification` needs a channel. Installs that never set
 * `SLACK_DEFAULT_CHANNEL` (steamfun-ops, 2026-09-18) silently dropped every
 * notification — including the OKR approval nudge — with "No channel
 * configured". The owner has, however, already talked to the orchestrator
 * somewhere: each Slack conversation leaves a directory under
 * `~/.crewly/slack-threads/<channelId>/`. The most recently active one is
 * where the owner is, so that is where a notification without an explicit
 * channel goes. Direct-message channels (`D…`) win over public channels when
 * both were used within the same window, because a nudge is for the owner,
 * not the team.
 *
 * @module services/slack/slack-notification-fallback
 */

import * as fs from 'fs';
import * as path from 'path';
import { SLACK_THREAD_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/** Slack channel id prefix for direct messages. */
const DM_PREFIX = 'D';

/**
 * Pick the channel the owner most recently used, from the thread store.
 *
 * @param threadsDir - Override of `~/.crewly/slack-threads` (tests)
 * @returns A Slack channel id, or null when the store is empty or missing
 *
 * @example
 * ```ts
 * const channel = notification.channelId ?? config.defaultChannelId ?? resolveFallbackNotificationChannel();
 * ```
 */
export function resolveFallbackNotificationChannel(threadsDir?: string): string | null {
  const dir = threadsDir ?? path.join(getCrewlyHomePath(), SLACK_THREAD_CONSTANTS.STORAGE_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(dir, e.name);
      let latest = 0;
      try {
        for (const f of fs.readdirSync(full)) {
          const t = fs.statSync(path.join(full, f)).mtimeMs;
          if (t > latest) latest = t;
        }
      } catch {
        // unreadable channel dir — treat as never used
      }
      return { id: e.name, latest, dm: e.name.startsWith(DM_PREFIX) };
    })
    .filter((c) => c.latest > 0)
    .sort((a, b) => (a.dm !== b.dm ? (a.dm ? -1 : 1) : b.latest - a.latest));
  return candidates[0]?.id ?? null;
}
