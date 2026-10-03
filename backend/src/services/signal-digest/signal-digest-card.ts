/**
 * The signal digest card (#987, specs/2026-10-03-signal-digest.md §3): one
 * Slack message, one section per action with its own Do / Skip buttons.
 * Pure: same digest, same blocks.
 *
 * ```
 * [header]  Daily signals · visa.careerengine.us
 * [context] Owen · Fri 10/2 · Do opens an experiment ticket · SD-3
 * [section] *1. Rewrite the /h1b-fee title*
 *           Signal: 'h1b visa fee' ranks #2 with 4% CTR on 900 impressions
 *           Expected: about +70 clicks a week · Effort: S — 1 h
 * [actions] [Do] [Skip]                 (or, once answered: ✔ Do → CE-12)
 * …
 * ```
 *
 * @module services/signal-digest/signal-digest-card
 */

import { SIGNAL_DIGEST_CONSTANTS } from '../../constants.js';
import type { SlackBlock } from '../../types/slack.types.js';
import type { SignalButtonValue, SignalChoice, SignalDigest, SignalDigestItem } from '../../types/signal-digest.types.js';
import { isSignalChoice } from '../../types/signal-digest.types.js';

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Escape the characters Slack reserves in mrkdwn.
 *
 * @param text - Plain text
 * @returns Safe mrkdwn
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Button value JSON.
 *
 * @param digestId - Digest id
 * @param n - Item number
 * @param choice - do / skip
 * @param instanceId - This instance (Cloud routes the click by it)
 * @returns JSON string
 */
export function signalButtonValue(digestId: string, n: number, choice: SignalChoice, instanceId: string): string {
  const v: SignalButtonValue = { s: digestId, n, o: choice, i: instanceId };
  return JSON.stringify(v);
}

/**
 * Parse a digest button value.
 *
 * @param raw - `value` of the clicked button
 * @returns The value, or null when it is not a digest button
 */
export function parseSignalButtonValue(raw: unknown): SignalButtonValue | null {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const v = JSON.parse(raw) as Partial<SignalButtonValue>;
    if (typeof v.s !== 'string' || typeof v.n !== 'number' || !Number.isInteger(v.n) || !isSignalChoice(v.o)) return null;
    return { s: v.s, n: v.n, o: v.o, i: typeof v.i === 'string' ? v.i : '' };
  } catch {
    return null;
  }
}

/**
 * The line an answered (or expired) action shows instead of its buttons.
 *
 * @param item - Item
 * @returns mrkdwn line, or null while open
 */
export function itemOutcomeLine(item: SignalDigestItem): string | null {
  switch (item.status) {
    case 'do':
      if (item.ticketId) return `✔ Do → ${escapeMrkdwn(item.ticketId)}${item.experimentId ? ` · ${escapeMrkdwn(item.experimentId)}` : ''}`;
      return `✔ Do — no ticket: ${escapeMrkdwn(item.ticketError ?? 'not created')}`;
    case 'skip':
      return '⤼ Skipped';
    case 'expired':
      return 'No answer — replaced by a newer digest';
    default:
      return null;
  }
}

/**
 * `Fri 10/2` for an instant, in the machine's zone.
 *
 * @param iso - Instant
 * @returns Date label
 */
function dateLabel(iso: string): string {
  const d = new Date(iso);
  return `${WEEKDAY_SHORT[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * The card's blocks.
 *
 * @param digest - Digest
 * @param instanceId - This instance id (button values)
 * @param askerName - Team lead's display name, when known
 * @returns Blocks
 */
export function renderDigestCard(digest: SignalDigest, instanceId: string, askerName?: string): SlackBlock[] {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: `Daily signals · ${digest.site}`.slice(0, 150), emoji: true } },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: [askerName ? escapeMrkdwn(askerName) : null, dateLabel(digest.createdAt), 'Do opens an experiment ticket · Skip keeps it off the list for 30 days', digest.id]
            .filter(Boolean)
            .join(' · '),
        },
      ],
    },
  ];
  for (const item of digest.items) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*${item.n}. ${escapeMrkdwn(item.proposal)}*`,
          `Signal: ${escapeMrkdwn(item.signal)}`,
          `Expected: ${escapeMrkdwn(item.expectedEffect)} · Effort: ${escapeMrkdwn(item.effort)}`,
        ].join('\n'),
      },
    });
    const outcome = itemOutcomeLine(item);
    if (outcome) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: outcome }] });
      continue;
    }
    blocks.push({
      type: 'actions',
      block_id: `signal:${digest.id}:${item.n}`,
      elements: [
        {
          type: 'button',
          action_id: `${SIGNAL_DIGEST_CONSTANTS.ACTION_PREFIX}${item.n}:do`,
          text: { type: 'plain_text', text: 'Do', emoji: true },
          style: 'primary',
          value: signalButtonValue(digest.id, item.n, 'do', instanceId),
        },
        {
          type: 'button',
          action_id: `${SIGNAL_DIGEST_CONSTANTS.ACTION_PREFIX}${item.n}:skip`,
          text: { type: 'plain_text', text: 'Skip', emoji: true },
          value: signalButtonValue(digest.id, item.n, 'skip', instanceId),
        },
      ],
    });
  }
  return blocks as unknown as SlackBlock[];
}

/**
 * Notification text of the card (shown in the push / when blocks fail).
 *
 * @param digest - Digest
 * @returns Plain text
 */
export function digestFallbackText(digest: SignalDigest): string {
  const open = digest.items.filter((i) => i.status === 'open').length;
  return `Daily signals · ${digest.site}: ${digest.items.length} actions${open < digest.items.length ? ` (${open} waiting)` : ''}`;
}
