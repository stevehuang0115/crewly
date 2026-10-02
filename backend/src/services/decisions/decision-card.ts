/**
 * Decision cards — Block Kit rendering and answer parsing
 * (specs/2026-10-01-decision-cards.md §3). Pure.
 *
 * @module services/decisions/decision-card
 */

import { DECISION_CONSTANTS } from '../../constants.js';
import type { SlackBlock } from '../../types/slack.types.js';
import type { DecisionButtonValue, DecisionChoice, DecisionOption, OwnerDecision } from '../../types/decision.types.js';
import { matchOption } from './decision-contract.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Short local time for the card: "14:05" today, "tomorrow 12:00", else "Thu Oct 2 12:00".
 *
 * @param at - Moment
 * @param now - Clock
 * @returns Text
 */
export function formatWhen(at: Date, now: Date = new Date()): string {
  const hm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const day = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (day(at) === day(now)) return hm;
  const tomorrow = new Date(now.getTime());
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day(at) === day(tomorrow)) return `tomorrow ${hm}`;
  return `${DAYS[at.getDay()]} ${MONTHS[at.getMonth()]} ${at.getDate()} ${hm}`;
}

/**
 * The label of the default, as the card says it ("wait" for none).
 *
 * @param d - Decision
 * @returns Option label, or "wait"
 */
export function defaultLabel(d: Pick<OwnerDecision, 'defaultKey' | 'options'>): string {
  return d.options.find((o) => o.key === d.defaultKey)?.label ?? DECISION_CONSTANTS.WAIT_DEFAULT;
}

/**
 * The label of an option key.
 *
 * @param d - Decision
 * @param key - Option key
 * @returns Label (the key itself when unknown)
 */
export function optionLabel(d: Pick<OwnerDecision, 'options'>, key: string | undefined): string {
  return d.options.find((o) => o.key === key)?.label ?? String(key ?? '');
}

/**
 * The card header: ticket id + title, else the asker's topic.
 *
 * @param d - Decision
 * @returns Header text (≤ 150 characters, Slack's header limit)
 */
export function cardHeader(d: Pick<OwnerDecision, 'ticket' | 'id' | 'title' | 'browser'>): string {
  const text = d.title
    ? d.title
    : d.ticket
      ? `${d.ticket.id} · ${d.ticket.title}`
      : d.browser
        ? `Browser · ${d.browser.agentName} is waiting for your OK`
        : `Decision ${d.id}`;
  return text.length > 150 ? `${text.slice(0, 149)}…` : text;
}

/**
 * The thread root for a ticket that has no thread yet.
 *
 * @param ticket - Ticket id + title
 * @returns mrkdwn line
 */
export function ticketThreadRootText(ticket: { id: string; title: string }): string {
  return `*${ticket.id} · ${ticket.title}*`;
}

/**
 * Button value JSON.
 *
 * @param decisionId - Decision id
 * @param option - Option key, `remind` or `skip`
 * @param instanceId - This instance (Cloud routes the click by it)
 * @returns JSON string
 */
export function buttonValue(decisionId: string, option: string, instanceId: string): string {
  const v: DecisionButtonValue = { d: decisionId, o: option, i: instanceId };
  return JSON.stringify(v);
}

/**
 * Parse a button value.
 *
 * @param raw - `value` of the clicked button
 * @returns The value, or null when it is not a decision button
 */
export function parseButtonValue(raw: unknown): DecisionButtonValue | null {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    const v = JSON.parse(raw) as Partial<DecisionButtonValue>;
    if (typeof v.d !== 'string' || typeof v.o !== 'string') return null;
    return { d: v.d, o: v.o, i: typeof v.i === 'string' ? v.i : '' };
  } catch {
    return null;
  }
}

/**
 * The context line of a pending card.
 *
 * @param d - Decision
 * @param now - Clock
 * @returns mrkdwn text
 */
export function pendingContextLine(d: OwnerDecision, now: Date = new Date()): string {
  const when = formatWhen(new Date(d.deadline), now);
  const parts: string[] = [];
  if (d.remindAt && Date.parse(d.remindAt) > now.getTime()) {
    parts.push(`⏰ Reminding you ${formatWhen(new Date(d.remindAt), now)}.`);
  }
  if (d.system?.defaultIsDecline) {
    parts.push(`Nothing is accepted until you answer. No answer by ${when}: ${defaultLabel(d)}.`);
  } else if (d.kind === 'browser_action') {
    parts.push(`Nothing happens without your OK. If no answer by ${when}, the answer is ${defaultLabel(d)}.`);
  } else if (d.sensitive) {
    parts.push(`This needs your OK (${d.sensitive}); I won't go ahead without an answer.`);
  } else if (d.defaultKey === DECISION_CONSTANTS.WAIT_DEFAULT) {
    parts.push(`If no answer by ${when}, I'll keep waiting.`);
  } else {
    parts.push(`If no answer by ${when}, I'll go with ${defaultLabel(d)}.`);
  }
  parts.push(d.id);
  return parts.join(' · ');
}

/**
 * The option lines under the question (only when some option has a detail).
 *
 * @param options - Options
 * @returns mrkdwn, or null
 */
function optionDetails(options: DecisionOption[]): string | null {
  if (!options.some((o) => o.detail)) return null;
  return options.map((o) => `• *${o.label}*${o.detail ? ` — ${o.detail}` : ''}`).join('\n');
}

/**
 * Blocks of an open card.
 *
 * @param d - Decision
 * @param instanceId - This instance id (button values)
 * @param now - Clock
 * @returns Blocks
 */
export function renderOpenCard(d: OwnerDecision, instanceId: string, now: Date = new Date()): SlackBlock[] {
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: cardHeader(d), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: d.question } },
  ];
  for (const text of d.body ?? []) if (text.trim()) blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  const details = optionDetails(d.options);
  if (details) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: details } });
  blocks.push({
    type: 'actions',
    block_id: `decision:${d.id}`,
    elements: [
      ...d.options.map((o) => ({
        type: 'button',
        action_id: `${DECISION_CONSTANTS.ACTION_PREFIX}${o.key}`,
        text: { type: 'plain_text', text: o.label, emoji: true },
        value: buttonValue(d.id, o.key, instanceId),
        ...(o.key === d.defaultKey && !d.sensitive ? { style: 'primary' } : {}),
      })),
      // Held browser actions (short deadline) and system decisions (exactly
      // their options) cannot be snoozed.
      ...(canRemind(d)
        ? [
            {
              type: 'button',
              action_id: DECISION_CONSTANTS.REMIND_ACTION_ID,
              text: { type: 'plain_text', text: 'Remind me tomorrow', emoji: true },
              value: buttonValue(d.id, 'remind', instanceId),
            },
          ]
        : []),
      // "I don't care about this anymore". Not on sensitive / system /
      // browser cards: their "No" already is the safe way out.
      ...(canSkip(d)
        ? [
            {
              type: 'button',
              action_id: DECISION_CONSTANTS.SKIP_ACTION_ID,
              text: { type: 'plain_text', text: 'Skip', emoji: true },
              value: buttonValue(d.id, DECISION_CONSTANTS.SKIP_OPTION, instanceId),
            },
          ]
        : []),
    ],
  });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: pendingContextLine(d, now) }] });
  return blocks as unknown as SlackBlock[];
}

/**
 * Whether "Remind me tomorrow" is offered: not for held browser actions
 * (a deadline of hours), nor for system decisions (answered with exactly
 * their options).
 *
 * @param d - Decision
 * @returns True when snoozing is allowed
 */
export function canRemind(d: Pick<OwnerDecision, 'kind' | 'system'>): boolean {
  return d.kind !== 'browser_action' && !d.system;
}

/**
 * Whether the card offers "Skip": every card except sensitive asks, system
 * decisions and held browser actions — those already have a "No", which is
 * what skipping them means ({@link skipChoice}).
 *
 * @param d - Decision
 * @returns True when the Skip button is shown
 */
export function canSkip(d: Pick<OwnerDecision, 'kind' | 'system' | 'sensitive'>): boolean {
  return d.kind !== 'browser_action' && !d.system && !d.sensitive;
}

/**
 * What "skip" means for a card: a real skip where {@link canSkip}; else the
 * safe way out — its "no" option, else its default when that never lets
 * anything through, else a real skip (dropping a sensitive ask does nothing).
 *
 * @param d - Decision
 * @returns Choice
 */
export function skipChoice(d: Pick<OwnerDecision, 'kind' | 'system' | 'sensitive' | 'options' | 'defaultKey'>): DecisionChoice {
  if (canSkip(d)) return { kind: 'skip' };
  const no = noOption(d.options);
  if (no) return { kind: 'option', key: no.key };
  if (defaultIsSafe(d) && d.options.some((o) => o.key === d.defaultKey)) return { kind: 'option', key: d.defaultKey };
  return { kind: 'skip' };
}

/**
 * Whether the default never lets anything through (a held browser action's
 * "No", a declining system decision), so it is applied at the deadline even
 * when the decision is sensitive.
 *
 * @param d - Decision
 * @returns True when the default is safe to apply unanswered
 */
export function defaultIsSafe(d: Pick<OwnerDecision, 'kind' | 'system'>): boolean {
  return d.kind === 'browser_action' || d.system?.defaultIsDecline === true;
}

/**
 * Blocks of a settled card (no buttons).
 *
 * @param d - Decision (resolved / defaulted / parked / cancelled)
 * @param ownerName - How to name the owner ("Steve"), when known
 * @param now - Clock
 * @returns Blocks
 */
export function renderSettledCard(d: OwnerDecision, ownerName?: string, now: Date = new Date()): SlackBlock[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: cardHeader(d), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: d.question } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: settledLine(d, ownerName, now) }] },
  ] as unknown as SlackBlock[];
}

/**
 * The one line a settled card shows.
 *
 * @param d - Decision
 * @param ownerName - Owner display name
 * @param now - Clock
 * @returns Text
 */
export function settledLine(d: OwnerDecision, ownerName?: string, now: Date = new Date()): string {
  const at = formatWhen(new Date(d.resolvedAt ?? d.updatedAt), now);
  const who = ownerName || (d.answeredBy ? `<@${d.answeredBy}>` : 'The owner');
  switch (d.status) {
    case 'resolved':
      return d.chosenKey
        ? `✔ ${who} chose *${optionLabel(d, d.chosenKey)}* · ${at}`
        : `✔ ${who} answered: “${(d.answerText ?? '').slice(0, 200)}” · ${at}`;
    case 'defaulted':
      return deadlineDefaultLine(d, now);
    case 'parked':
      return `⏸ Parked — no answer, so I'm not going ahead. Answer from "Waiting on you" to reopen it. · ${d.id}`;
    case 'cancelled':
      return `Withdrawn · ${at}`;
    case 'expired':
      return `Expired — ${d.browser?.agentName ?? (d.asker || 'the agent')} will ask again · ${at}`;
    case 'skipped':
      return `⤼ ${who} skipped this · ${at}`;
    default:
      return pendingContextLine(d, now);
  }
}

/**
 * "No answer by <deadline> — going with <default>." (or "— still waiting." for `wait`).
 *
 * @param d - Decision
 * @param now - Clock
 * @returns Text
 */
export function deadlineDefaultLine(d: OwnerDecision, now: Date = new Date()): string {
  const when = formatWhen(new Date(d.deadline), now);
  return d.defaultKey === DECISION_CONSTANTS.WAIT_DEFAULT
    ? `No answer by ${when} — I'll keep waiting.`
    : `No answer by ${when} — going with ${defaultLabel(d)}.`;
}

/**
 * The plain-text fallback of a card (notifications, screen readers).
 *
 * @param d - Decision
 * @returns Text
 */
export function cardFallbackText(d: OwnerDecision): string {
  return `${cardHeader(d)}: ${d.question} (${d.options.map((o) => o.label).join(' / ')})`;
}

/**
 * The option that reads as "no", when one does.
 *
 * @param options - Options
 * @returns Option, or null
 */
export function noOption(options: DecisionOption[]): DecisionOption | null {
  const words = DECISION_CONSTANTS.NO_WORDS as readonly string[];
  return (
    options.find((o) => {
      const l = o.label.toLowerCase().trim();
      return words.includes(l) || words.includes(l.split(/[\s,—–-]+/)[0]) || words.some((w) => /[^\x00-\x7F]/.test(w) && l.startsWith(w));
    }) ?? null
  );
}

/**
 * The option ✅ / "yes" means: `yesKey` when set, else the default, else the first option.
 *
 * @param d - Decision
 * @returns Option key
 */
export function acceptKey(d: Pick<OwnerDecision, 'defaultKey' | 'options' | 'yesKey'>): string {
  if (d.yesKey && d.options.some((o) => o.key === d.yesKey)) return d.yesKey;
  return d.options.some((o) => o.key === d.defaultKey) ? d.defaultKey : d.options[0].key;
}

/**
 * Map a reaction on a card to a choice: ✅ accept, ❌ the "no" option,
 * ⏰ remind, 🚫 / ⏭️ skip ({@link skipChoice}).
 *
 * @param d - Decision
 * @param reaction - Emoji name (no colons; skin tone suffix allowed)
 * @returns Choice, or null when the reaction means nothing
 */
export function choiceFromReaction(d: Pick<OwnerDecision, 'defaultKey' | 'options' | 'yesKey'> & Partial<Pick<OwnerDecision, 'kind' | 'system' | 'sensitive'>>, reaction: string): DecisionChoice | null {
  const name = reaction.replace(/::skin-tone-\d$/, '');
  if ((DECISION_CONSTANTS.REACTION_SKIP as readonly string[]).includes(name)) return skipChoice(d);
  if ((DECISION_CONSTANTS.REACTION_ACCEPT as readonly string[]).includes(name)) return { kind: 'option', key: acceptKey(d) };
  if ((DECISION_CONSTANTS.REACTION_REMIND as readonly string[]).includes(name)) return { kind: 'remind' };
  if ((DECISION_CONSTANTS.REACTION_REJECT as readonly string[]).includes(name)) {
    const no = noOption(d.options);
    return no ? { kind: 'option', key: no.key } : null;
  }
  return null;
}

/**
 * Map a free-text thread reply to a choice: an option (label, key, number),
 * a skip word ("skip", 「不用了」, 「算了」, 「不管了」 — {@link skipChoice}),
 * a yes word (the default / first option), a no word (the "no" option), a
 * remind word — else the text itself, for the asker to read.
 *
 * @param d - Decision
 * @param text - The owner's reply
 * @returns Choice, or null for an empty reply
 */
export function choiceFromText(d: Pick<OwnerDecision, 'defaultKey' | 'options' | 'yesKey'> & Partial<Pick<OwnerDecision, 'kind' | 'system' | 'sensitive'>>, text: string): DecisionChoice | null {
  const clean = text.replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const opt = matchOption(clean, d.options);
  if (opt) return { kind: 'option', key: opt.key };
  const norm = clean.toLowerCase().replace(/[\s.。!！,，]+$/u, '');
  if (isSkipWord(norm)) return skipChoice(d);
  if ((DECISION_CONSTANTS.REMIND_WORDS as readonly string[]).includes(norm)) return { kind: 'remind' };
  if ((DECISION_CONSTANTS.YES_WORDS as readonly string[]).includes(norm)) return { kind: 'option', key: acceptKey(d) };
  if ((DECISION_CONSTANTS.NO_WORDS as readonly string[]).includes(norm)) {
    const no = noOption(d.options);
    if (no) return { kind: 'option', key: no.key };
  }
  // "go with Hold", "option 2", "let's do B"
  const tail = /^(?:go with|option|choose|pick|let'?s do|do|选)\s*(.+)$/i.exec(norm);
  if (tail) {
    const o = matchOption(tail[1], d.options);
    if (o) return { kind: 'option', key: o.key };
  }
  return { kind: 'text', text: clean };
}

/**
 * Whether a reply (lower-cased, trailing punctuation stripped) means "skip".
 *
 * @param norm - Normalised reply
 * @returns True for a skip word
 */
export function isSkipWord(norm: string): boolean {
  return (DECISION_CONSTANTS.SKIP_WORDS as readonly string[]).includes(norm.replace(/[\s.。!！,，~～]+$/u, '').trim());
}
