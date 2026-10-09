/**
 * One-line owner alert for a refused boot.
 *
 * When Crewly refuses to start (stale build because an agent switched the live
 * checkout's branch) nothing else is running to tell the owner. This posts a
 * single Slack message with the bot token the machine already holds, at most
 * once per distinct line per day, never throws, and gives up after a short
 * timeout so a refused boot is not delayed by Slack.
 *
 * @module utils/boot-owner-alert
 */

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

/** Minimum gap before the same alert line is posted again. */
export const BOOT_ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;
/** Give up on Slack after this long. */
export const BOOT_ALERT_TIMEOUT_MS = 5000;

/** Credentials subset the alert needs. */
export interface BootAlertTarget {
  botToken: string;
  /** DM target: first allowed user id, else the default channel */
  channel: string;
}

/**
 * Post the alert line once.
 *
 * @param line - English alert text
 * @param crewlyHome - Crewly home (holds the once-per-day marker)
 * @param loadTarget - Resolves where to post; null when Slack is not set up
 * @param fetchImpl - `fetch` (injectable for tests)
 * @param now - Clock (injectable for tests)
 * @returns true when a message was posted, false when skipped or failed
 */
export async function postBootOwnerAlert(
  line: string,
  crewlyHome: string,
  loadTarget: () => Promise<BootAlertTarget | null>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<boolean> {
  try {
    const marker = path.join(crewlyHome, 'runtime', `boot-alert-${createHash('sha1').update(line).digest('hex').slice(0, 12)}`);
    try {
      const last = Number((await fs.readFile(marker, 'utf8')).trim());
      if (Number.isFinite(last) && now() - last < BOOT_ALERT_REPEAT_MS) return false;
    } catch {
      /* no marker yet */
    }
    const target = await loadTarget();
    if (!target) return false;
    const res = await fetchImpl('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${target.botToken}` },
      body: JSON.stringify({ channel: target.channel, text: line }),
      signal: AbortSignal.timeout(BOOT_ALERT_TIMEOUT_MS),
    });
    const body = (await res.json()) as { ok?: boolean };
    if (!body.ok) return false;
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, String(now()), 'utf8');
    return true;
  } catch {
    return false;
  }
}
