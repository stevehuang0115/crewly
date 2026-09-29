/**
 * Owner receipt (#828) — the renderer: {@link ReceiptData} → Slack mrkdwn.
 *
 * **All wording and layout lives in this file and nowhere else.** Pure: same
 * data, same text.
 *
 * Redesigned 2026-09-28 after the owner found the first version overwhelming
 * (14 asks + 17 「等你拍板」 with TKT numbers and his own words cut off
 * mid-sentence). The receipt now says only two things, in Chinese, in at
 * most ten lines:
 *
 * ```
 * *Crewly 小票 · 9/28 周一*
 * *今天做完的*
 * • Think Tank：每天早上 8 点问你一个问题，已经设好
 * • …(at most 3)
 * *需要你决定的*
 * • Atlas：每周一个 30 分钟的聊天，加上每月一场圆桌，哪个现实？
 * • …(at most 3)
 * 另有 N 件，在看板上
 * ```
 *
 * Never: ticket numbers, the owner's own words, counts nobody asked for,
 * lines for what is unknown (不详 / 没记). A section with nothing in it is
 * left out; with nothing in either, the receipt is empty and not sent.
 *
 * Slack mrkdwn, not a code block: CJK text breaks monospace alignment on a
 * phone.
 *
 * @module services/v3/owner-receipt/owner-receipt.renderer
 */

import { localParts } from './owner-receipt-data.js';
import type { ReceiptData } from './owner-receipt.types.js';

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
 * `9/28 周一` for an instant in the owner's zone.
 *
 * @param iso - Instant
 * @param tz - Zone
 * @returns Date label
 */
function localDateLabel(iso: string, tz: string): string {
  const p = localParts(new Date(iso), tz);
  return `${p.month}/${p.day} ${WEEKDAY_ZH[p.weekday] ?? ''}`.trim();
}

/**
 * One bullet: `• <who>：<text>`, or `• <text>` when nobody is named.
 *
 * @param who - Team or agent, or null
 * @param text - The line
 * @returns mrkdwn line
 */
function bullet(who: string | null, text: string): string {
  return `• ${who ? `${escapeMrkdwn(who)}：` : ''}${escapeMrkdwn(text)}`;
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
  const lines: string[] = [`*Crewly 小票 · ${localDateLabel(data.window.to, data.window.timezone)}*`];
  if (data.highlights.length > 0) {
    lines.push('*今天做完的*', ...data.highlights.map((h) => bullet(h.team, h.summary)));
  }
  if (data.decisionsTotal > 0) {
    lines.push('*需要你决定的*', ...data.decisions.map((d) => bullet(d.from, d.question)));
    const rest = data.decisionsTotal - data.decisions.length;
    if (rest > 0) lines.push(`另有 ${rest} 件，在看板上`);
  }
  return lines.join('\n');
}
