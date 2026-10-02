/**
 * Owner receipt (#828) — the renderer: {@link ReceiptData} → Slack mrkdwn.
 *
 * **All wording and layout lives in this file and nowhere else.** Pure: same
 * data, same text.
 *
 * Redesigned 2026-09-28 after the owner found the first version overwhelming
 * (14 asks + 17 「等你拍板」 with TKT numbers and his own words cut off
 * mid-sentence). The receipt now says only two things, in at most ten
 * lines. The wording is English like the rest of the owner-facing UI
 * (owner decision 2026-09-29); the bullets carry the agents' own words.
 *
 * ```
 * *Crewly receipt · Mon 9/28*
 * *Done today*
 * • Think Tank: a daily 8 am question for you is set up
 * • …(at most 3)
 * *Needs your decision*
 * • Atlas: a weekly 30-min chat plus a monthly roundtable — which is realistic?
 * • …(at most 3)
 * N more on the board
 * ```
 *
 * Never: ticket numbers, the owner's own words, counts nobody asked for,
 * lines for what is unknown. A section with nothing in it is
 * left out; with nothing in either, the receipt is empty and not sent.
 *
 * Slack mrkdwn, not a code block: CJK text in the bullets breaks monospace
 * alignment on a phone.
 *
 * @module services/v3/owner-receipt/owner-receipt.renderer
 */

import { localParts } from './owner-receipt-data.js';
import type { ReceiptData } from './owner-receipt.types.js';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Escape the characters Slack reserves in message text.
 *
 * @param text - Plain text
 * @returns Text safe inside a Slack message
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `Mon 9/28` for an instant in the owner's zone.
 *
 * @param iso - Instant
 * @param tz - Zone
 * @returns Date label
 */
function localDateLabel(iso: string, tz: string): string {
  const p = localParts(new Date(iso), tz);
  return `${WEEKDAY_SHORT[p.weekday] ?? ''} ${p.month}/${p.day}`.trim();
}

/**
 * One bullet: `• <who>: <text>`, or `• <text>` when nobody is named.
 *
 * @param who - Team or agent, or null
 * @param text - The line
 * @returns mrkdwn line
 */
function bullet(who: string | null, text: string): string {
  return `• ${who ? `${escapeMrkdwn(who)}: ` : ''}${escapeMrkdwn(text)}`;
}

/**
 * Render a receipt as a Slack message, or '' when there is nothing to say
 * (nothing notable done, nothing waiting on the owner) — then it is not sent.
 *
 * @param data - Receipt data from the data layer
 * @returns Slack mrkdwn text (at most ten lines), or ''
 *
 * @example
 * ```typescript
 * const text = renderReceiptSlack(buildReceiptData(inputs));
 * if (text) await send(text);
 * ```
 */
export function renderReceiptSlack(data: ReceiptData): string {
  if (data.highlights.length === 0 && data.decisionsTotal === 0) return '';
  const lines: string[] = [`*Crewly receipt · ${localDateLabel(data.window.to, data.window.timezone)}*`];
  if (data.highlights.length > 0) {
    lines.push('*Done today*', ...data.highlights.map((h) => bullet(h.team, h.summary)));
  }
  if (data.decisionsTotal > 0) {
    lines.push('*Needs your decision*', ...data.decisions.map((d) => bullet(d.from, d.question)));
    const rest = data.decisionsTotal - data.decisions.length;
    if (rest > 0) lines.push(`${rest} more on the board`);
  }
  return lines.join('\n');
}
