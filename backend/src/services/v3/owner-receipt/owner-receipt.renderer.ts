/**
 * Owner receipt (#828) — the renderer: {@link ReceiptData} → Slack mrkdwn.
 *
 * **All wording and layout lives in this file and nowhere else.** The owner
 * has not approved the format yet (Ava's manual receipt of 2026-09-26 is the
 * reference: `.crewly/research/2026-09-26-owner-receipt/receipt.slack.md`), so
 * changing a label, an emoji or the order of sections must never touch the
 * data layer. Pure: same data, same text.
 *
 * Slack mrkdwn, not a code block: CJK text breaks monospace alignment on a
 * phone and links inside code are not clickable (Ava's format note §8).
 *
 * @module services/v3/owner-receipt/owner-receipt.renderer
 */

import { OWNER_RECEIPT_CONSTANTS } from '../../../constants.js';
import { localParts } from './owner-receipt-data.js';
import type { ReceiptAsk, ReceiptCost, ReceiptData, ReceiptDeliverable, ReceiptOutcome } from './owner-receipt.types.js';

/** Emoji per outcome. */
const OUTCOME_MARK: Record<ReceiptOutcome, string> = {
  done: '✅',
  to_review: '👀',
  in_progress: '🔄',
  blocked: '⛔',
  unowned: '⛔',
  dismissed: '✖',
};

/** Deliverable kinds as the count line names them. */
const DELIVERABLE_LABEL: Record<ReceiptDeliverable['kind'], string> = {
  pr: 'PR',
  issue: 'issue',
  file: '文件',
  link: '链接',
};

/** Short Chinese names for the time zones the owner is likely in. */
const ZONE_LABEL: Record<string, string> = {
  'America/New_York': '美东',
  'America/Chicago': '美中',
  'America/Denver': '美山地',
  'America/Los_Angeles': '美西',
  'Asia/Shanghai': '北京',
  'Asia/Hong_Kong': '香港',
  'Asia/Taipei': '台北',
  'Asia/Tokyo': '东京',
  'Europe/London': '伦敦',
  UTC: 'UTC',
};

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * Escape the characters Slack reserves in message text. The owner's own
 * words go through this; links and emphasis are added after.
 *
 * @param text - Plain text
 * @returns Text safe inside a Slack message
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `9/26 周六` and `21:00` for an instant in the owner's zone.
 *
 * @param iso - Instant
 * @param tz - Zone
 * @returns Date label and time label
 */
function localLabels(iso: string, tz: string): { date: string; time: string } {
  const p = localParts(new Date(iso), tz);
  return {
    date: `${p.month}/${p.day} ${WEEKDAY_ZH[p.weekday] ?? ''}`.trim(),
    time: `${p.hour}:${String(p.minute).padStart(2, '0')}`,
  };
}

/**
 * One deliverable as mrkdwn: a clickable link, or a file path in backticks.
 *
 * @param d - Deliverable
 * @returns mrkdwn
 */
function deliverableText(d: ReceiptDeliverable): string {
  if (d.kind === 'file') return `\`${d.ref.replace(/`/g, "'")}\``;
  return `<${d.ref}|${escapeMrkdwn(d.label)}>`;
}

/**
 * The part after "→" on an ask line.
 *
 * @param a - The ask
 * @returns mrkdwn, or '' when there is nothing to add
 */
function askTail(a: ReceiptAsk): string {
  const links = a.deliverables.slice(0, 3).map(deliverableText).join(' · ');
  const more = a.deliverables.length > 3 ? ` 等 ${a.deliverables.length} 项` : '';
  switch (a.outcome) {
    case 'done':
      return links ? `${links}${more}` : a.isQuestion ? '已答' : '';
    case 'to_review':
      return links ? `${links}${more}，等你看` : '已答，等你看';
    case 'in_progress':
      return links ? `在做：${links}${more}` : '在做';
    case 'blocked':
      return a.blockedReason ? `卡住：${escapeMrkdwn(a.blockedReason)}` : '卡住';
    case 'unowned':
      return '没人接';
    case 'dismissed':
      return '不用记';
  }
}

/**
 * One line per ask.
 *
 * @param a - The ask
 * @returns mrkdwn line
 */
function askLine(a: ReceiptAsk): string {
  const tail = askTail(a);
  return `${OUTCOME_MARK[a.outcome]} ${escapeMrkdwn(a.text)}${tail ? ` → ${tail}` : ''}`;
}

/**
 * The cost line. A number only when it is real (#812: today's meter is
 * cumulative, so it is 没记); "$0" is never shown for missing data.
 *
 * @param teams - Team name + cost
 * @returns mrkdwn line
 */
function costLine(teams: ReadonlyArray<{ team: string; cost: ReceiptCost }>): string {
  if (teams.length === 0) return '*花费*：没记（今天没有工作项）';
  if (teams.every((t) => t.cost.status === 'not_tracked')) {
    const meter = teams.some((t) => t.cost.status === 'not_tracked' && t.cost.reason === 'cumulative_meter');
    return meter
      ? '*花费*：各团队都 没记（成本字段是会话累计值，不是当天花费，#812）'
      : '*花费*：各团队都 没记（没有花费数据）';
  }
  const parts = teams.map((t) =>
    t.cost.status === 'tracked' ? `${escapeMrkdwn(t.team)} $${t.cost.usd.toFixed(2)}` : `${escapeMrkdwn(t.team)} 没记`,
  );
  return `*花费*：${parts.join(' · ')}`;
}

/**
 * Render a receipt as a Slack message.
 *
 * @param data - Receipt data from the data layer
 * @returns Slack mrkdwn text
 *
 * @example
 * ```typescript
 * const text = renderReceiptSlack(buildReceiptData(inputs));
 * ```
 */
export function renderReceiptSlack(data: ReceiptData): string {
  const tz = data.window.timezone;
  const zone = ZONE_LABEL[tz] ?? tz;
  const end = localLabels(data.window.to, tz);
  const start = localLabels(data.window.from, tz);
  const span =
    data.window.basis === 'since_last_receipt'
      ? `（${zone}，上次小票 ${start.date === end.date ? '' : `${start.date} `}${start.time} 起）`
      : `（${zone} ${start.time}–${end.time}）`;
  const lines: string[] = [`*Crewly 小票 · ${end.date}*${span}`];

  if (data.askCount === 0) {
    lines.push('这段时间你没有提新的事。');
  } else {
    const counts = (Object.keys(data.outcomes) as ReceiptOutcome[])
      .filter((o) => data.outcomes[o] > 0)
      // unowned and blocked share the ⛔ mark: count them together.
      .reduce<Array<[string, number]>>((acc, o) => {
        const mark = OUTCOME_MARK[o];
        const hit = acc.find(([m]) => m === mark);
        if (hit) hit[1] += data.outcomes[o];
        else acc.push([mark, data.outcomes[o]]);
        return acc;
      }, [])
      .map(([m, n]) => `${m} ${n}`)
      .join(' · ');
    lines.push(`你提了 *${data.askCount} 件事*：${counts}`);
    const made = (Object.keys(data.deliverables) as ReceiptDeliverable['kind'][])
      .filter((k) => data.deliverables[k] > 0)
      .map((k) => `${DELIVERABLE_LABEL[k]} ${data.deliverables[k]}`);
    if (made.length > 0) lines.push(`交付：${made.join(' · ')}`);
  }

  // Asks by team, capped for a phone.
  let shown = 0;
  let hidden = 0;
  for (const t of data.teams) {
    const room = OWNER_RECEIPT_CONSTANTS.MAX_ASK_LINES - shown;
    if (room <= 0) {
      hidden += t.asks.length;
      continue;
    }
    lines.push('', `*${escapeMrkdwn(t.team)}*`);
    for (const a of t.asks.slice(0, room)) lines.push(askLine(a));
    shown += Math.min(room, t.asks.length);
    hidden += Math.max(0, t.asks.length - room);
  }
  if (hidden > 0) lines.push(`…另有 ${hidden} 件，见看板`);

  // Waiting on you.
  if (data.waiting.length > 0) {
    lines.push('', `*等你拍板（${data.waiting.length}）*`);
    data.waiting.slice(0, OWNER_RECEIPT_CONSTANTS.MAX_WAITING_LINES).forEach((w, i) => {
      const id = w.tkt ? `${w.tkt} ` : '';
      const q = w.question ? ` — ${escapeMrkdwn(w.question)}` : '';
      lines.push(`${i + 1}. ${id}${escapeMrkdwn(w.text)}${q}`);
    });
    const rest = data.waiting.length - OWNER_RECEIPT_CONSTANTS.MAX_WAITING_LINES;
    if (rest > 0) lines.push(`…另有 ${rest} 件等你，见看板`);
  }

  lines.push('', costLine(data.teams));
  return lines.join('\n');
}
