/**
 * Decision cards — Block Kit rendering and answer parsing
 * (specs/2026-10-01-decision-cards.md §3). Pure.
 *
 * @module services/decisions/decision-card
 */

import { DECISION_CONSTANTS } from '../../constants.js';
import type { SlackBlock } from '../../types/slack.types.js';
import type { DecisionAnswerFile, DecisionButtonValue, DecisionChoice, DecisionKind, DecisionLanguage, DecisionOption, OwnerDecision } from '../../types/decision.types.js';
import type { SlackFile } from '../../types/slack.types.js';
import { isAudioOrVideo } from '../../utils/inbound-file-hint.utils.js';
import { matchOption } from './decision-contract.js';
import { cardText, clipQuestion, contextSection, detailsLine, formatWhenZh } from './decision-wording.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Short local time for the card: "14:05" today, "tomorrow 12:00", else "Thu Oct 2 12:00"
 * (Chinese for a Chinese owner: "明天 12:00").
 *
 * @param at - Moment
 * @param now - Clock
 * @param lang - Owner language (absent = English)
 * @returns Text
 */
export function formatWhen(at: Date, now: Date = new Date(), lang?: DecisionLanguage): string {
  if (lang === 'zh') return formatWhenZh(at, now);
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

/** Slack's header block limit (characters). */
const HEADER_MAX_CHARS = 150;

/**
 * The card header: a system decision's own title, else the question itself
 * (crewly#1367: the card leads with the question in plain words — never a
 * ticket id or a ticket title the owner has to decode).
 *
 * @param d - Decision
 * @returns Header text (≤ 150 characters, Slack's header limit)
 */
export function cardHeader(d: Pick<OwnerDecision, 'id' | 'title' | 'browser' | 'question'>): string {
  const text = d.title
    ? d.title
    : d.browser
      ? `Browser · ${d.browser.agentName} is waiting for your OK`
      : d.question?.trim() || `Decision ${d.id}`;
  return text.length > HEADER_MAX_CHARS ? `${text.slice(0, HEADER_MAX_CHARS - 1)}…` : text;
}

/**
 * Whether the card shows the question again under the header: only when the
 * header is something else (a system title) or had to be clipped.
 *
 * @param d - Decision
 * @returns True when a question section is needed
 */
export function showsQuestionSection(d: Pick<OwnerDecision, 'id' | 'title' | 'browser' | 'question'>): boolean {
  return cardHeader(d) !== d.question;
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
  const lang = d.ownerLanguage;
  const t = cardText(lang);
  const when = formatWhen(new Date(d.deadline), now, lang);
  const parts: string[] = [];
  if (d.remindAt && Date.parse(d.remindAt) > now.getTime()) {
    parts.push(t.remindingAt(formatWhen(new Date(d.remindAt), now, lang)));
  }
  if (d.system?.defaultIsDecline) {
    parts.push(t.declineDefault(when, defaultLabel(d)));
  } else if (isHeldAction(d)) {
    parts.push(t.heldDefault(when, defaultLabel(d)));
  } else if (d.sensitive) {
    parts.push(t.sensitive(d.sensitive));
  } else if (d.defaultKey === DECISION_CONSTANTS.WAIT_DEFAULT) {
    // Says what to do — not "wait for what?" (specs/2026-10-02-decision-card-thread-answers.md §2).
    parts.push(t.waitHold);
  } else {
    parts.push(t.goWithDefault(when, defaultLabel(d)));
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
  const t = cardText(d.ownerLanguage);
  const blocks: Array<Record<string, unknown>> = [{ type: 'header', text: { type: 'plain_text', text: cardHeader(d), emoji: true } }];
  if (showsQuestionSection(d)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: d.question } });
  for (const text of d.body ?? []) if (text.trim()) blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
  const context = contextSection(d.context, d.ownerLanguage, d.merge);
  if (context) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: context } });
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
              text: { type: 'plain_text', text: t.remindButton, emoji: true },
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
              text: { type: 'plain_text', text: t.skipButton, emoji: true },
              value: buttonValue(d.id, DECISION_CONSTANTS.SKIP_OPTION, instanceId),
            },
          ]
        : []),
    ],
  });
  const refs = detailsLine(d, d.ownerLanguage);
  if (refs) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: refs }] });
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
export function canRemind(d: Pick<OwnerDecision, 'kind' | 'system'> & Partial<Pick<OwnerDecision, 'tierChange'>>): boolean {
  return !isHeldAction(d) && !d.system && !isNoticeCard(d);
}

/**
 * Decision kinds that hold one concrete action (a browser click, an email, a
 * reply into a room) until the owner says yes: their default is the safe
 * "no", applied unanswered; no snooze or skip, and words that are neither
 * yes nor no leave them open.
 */
export const HELD_ACTION_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>(['browser_action', 'gmail_send', 'private_share']);

/**
 * Whether a decision holds an action until the owner approves it ({@link HELD_ACTION_KINDS}).
 *
 * @param d - Decision
 * @returns True for a held action
 */
export function isHeldAction(d: Pick<OwnerDecision, 'kind'>): boolean {
  return !!d.kind && HELD_ACTION_KINDS.has(d.kind);
}

/**
 * Whether a card is a notice: the change already happened and its one
 * action undoes it (model-tier auto mode, crewly#1173). Nothing to snooze
 * or skip — not answering keeps it.
 *
 * @param d - Decision
 * @returns True for a notice
 */
export function isNoticeCard(d: Partial<Pick<OwnerDecision, 'tierChange'>>): boolean {
  return !!d.tierChange?.notice;
}

/**
 * Whether the card offers "Skip": every card except sensitive asks, system
 * decisions, held browser actions and merge cards with a "not now" — those
 * already have a "No", which is what skipping them means ({@link skipChoice}).
 * A merge card's way out is named by its outcome (先不合 / Not now), not
 * "Skip" (crewly#1367).
 *
 * @param d - Decision
 * @returns True when the Skip button is shown
 */
export function canSkip(d: Pick<OwnerDecision, 'kind' | 'system' | 'sensitive'> & Partial<Pick<OwnerDecision, 'merge' | 'options' | 'tierChange'>>): boolean {
  if (d.merge && d.options && noOption(d.options)) return false;
  if (isNoticeCard(d)) return false;
  return !isHeldAction(d) && !d.system && !d.sensitive;
}

/**
 * What "skip" means for a card: a real skip where {@link canSkip}; a
 * notice's default (keep what happened); else the safe way out — its "no" option, else its default when that never lets
 * anything through, else a real skip (dropping a sensitive ask does nothing).
 *
 * @param d - Decision
 * @returns Choice
 */
export function skipChoice(d: Pick<OwnerDecision, 'kind' | 'system' | 'sensitive' | 'options' | 'defaultKey'> & Partial<Pick<OwnerDecision, 'merge' | 'tierChange'>>): DecisionChoice {
  if (canSkip(d)) return { kind: 'skip' };
  // A notice's default keeps what already happened.
  if (isNoticeCard(d) && d.options.some((o) => o.key === d.defaultKey)) return { kind: 'option', key: d.defaultKey };
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
  return isHeldAction(d) || d.system?.defaultIsDecline === true;
}

/**
 * Blocks of a settled card (no buttons).
 *
 * @param d - Decision (resolved / defaulted / parked / cancelled)
 * @param ownerName - How to name the owner ("Steve"), when known
 * @param now - Clock
 * @returns Blocks
 */
export function renderSettledCard(d: OwnerDecision, ownerName?: string, now: Date = new Date(), askerName?: string): SlackBlock[] {
  return [
    { type: 'header', text: { type: 'plain_text', text: cardHeader(d), emoji: true } },
    ...(showsQuestionSection(d) ? [{ type: 'section', text: { type: 'mrkdwn', text: d.question } }] : []),
    { type: 'context', elements: [{ type: 'mrkdwn', text: settledLine(d, ownerName, now, askerName) }] },
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
export function settledLine(d: OwnerDecision, ownerName?: string, now: Date = new Date(), askerName?: string): string {
  const t = cardText(d.ownerLanguage);
  const at = formatWhen(new Date(d.resolvedAt ?? d.updatedAt), now, d.ownerLanguage);
  const who = ownerName || (d.answeredBy ? `<@${d.answeredBy}>` : t.theOwner);
  switch (d.status) {
    case 'resolved':
      if (d.answeredVia === 'thread') return t.answeredInThread(at);
      return d.chosenKey ? t.chose(who, optionLabel(d, d.chosenKey), at) : t.answered(who, (d.answerText ?? '').slice(0, 200), at);
    case 'defaulted':
      return deadlineDefaultLine(d, now, askerName, true);
    case 'parked':
      return t.parked(d.id);
    case 'cancelled':
      return t.closed(closedReasonLabel(d.closedReason), at);
    case 'expired':
      return d.browser
        ? `Expired — ${d.browser.agentName} will ask again · ${at}`
        : t.closed(DECISION_CONSTANTS.CLOSED_REASONS.STALE, at);
    case 'skipped':
      return t.skipped(who, at);
    default:
      return pendingContextLine(d, now);
  }
}

/**
 * The deadline line of a default that is applied: who does what.
 * "No answer by 12:00, so Owen will go with "Hold"." (settled card: "… went with …").
 * A `wait` default is never announced to the owner
 * (specs/2026-10-02-decision-card-thread-answers.md §2); its line only
 * names the state, for the dashboard.
 *
 * @param d - Decision
 * @param now - Clock
 * @param askerName - The asking agent's name ("Owen"); "I" when unknown
 * @param settled - Past tense (the settled card)
 * @returns Text
 */
export function deadlineDefaultLine(d: OwnerDecision, now: Date = new Date(), askerName?: string, settled = false): string {
  const t = cardText(d.ownerLanguage);
  const when = formatWhen(new Date(d.deadline), now, d.ownerLanguage);
  if (d.defaultKey === DECISION_CONSTANTS.WAIT_DEFAULT) return t.defaultNoAnswerOpen(when);
  return t.defaultNoAnswer(when, t.defaultVerb(askerName?.trim() || null, settled), defaultLabel(d));
}

/**
 * The one reminder of the `wait` cards nobody answered in a thread: ONE
 * short line pointing at the card above, never the card repeated
 * (crewly#1367; specs/2026-10-02-decision-card-thread-answers.md §2). Several
 * cards in one thread share one reminder that counts them.
 *
 * @param ds - The thread's due cards (one or more)
 * @param ownerUserId - The owner's Slack id (mentioned), when known
 * @returns mrkdwn text
 */
export function waitReminderLine(
  ds: ReminderCard | ReadonlyArray<ReminderCard>,
  ownerUserId?: string | null,
): string {
  const list = Array.isArray(ds) ? ds : [ds as ReminderCard];
  const at = ownerUserId ? `<@${ownerUserId}> ` : '';
  const t = cardText(list[list.length - 1]?.ownerLanguage);
  if (list.length === 1) return t.waitReminder(at, clipQuestion(list[0].question));
  return t.waitReminderMany(at, list.length);
}

/** What a reminder line needs of a card. */
export type ReminderCard = Pick<OwnerDecision, 'question'> & Partial<Pick<OwnerDecision, 'ownerLanguage'>>;

/**
 * The "Remind me tomorrow" reminder: one short line pointing at the card.
 *
 * @param d - The card
 * @param ownerUserId - Owner's Slack id (mentioned), when known
 * @returns Text
 */
export function remindNowLine(d: ReminderCard, ownerUserId?: string | null): string {
  return cardText(d.ownerLanguage).remindNow(ownerUserId ? `<@${ownerUserId}> ` : '', clipQuestion(d.question));
}

/**
 * The one re-ask of a sensitive card: one short line pointing at the card.
 *
 * @param d - The card
 * @param ownerUserId - Owner's Slack id (mentioned), when known
 * @returns Text
 */
export function sensitiveReaskLine(d: ReminderCard & Pick<OwnerDecision, 'sensitive'>, ownerUserId?: string | null): string {
  return cardText(d.ownerLanguage).sensitiveReask(ownerUserId ? `<@${ownerUserId}> ` : '', clipQuestion(d.question), String(d.sensitive ?? ''));
}

/**
 * How a withdrawn card names why it was closed ("ticket done",
 * "replaced by D-7", or the asker's own words, clipped).
 *
 * @param reason - The `cancelWhere` note
 * @returns Reason text (never empty)
 */
export function closedReasonLabel(reason: string | undefined): string {
  const r = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (!r) return 'no longer needed';
  const superseded = /^superseded by (D-\d+)$/i.exec(r);
  if (superseded) return `replaced by ${superseded[1]}`;
  if (r === 'cleared') return 'cleared from the ticket';
  const max = DECISION_CONSTANTS.CLOSED_REASON_MAX_CHARS;
  return r.length > max ? `${r.slice(0, max - 1)}…` : r;
}

/**
 * The plain-text fallback of a card (notifications, screen readers).
 *
 * @param d - Decision
 * @returns Text
 */
export function cardFallbackText(d: OwnerDecision): string {
  const header = cardHeader(d);
  // The id is always in the text: every machine reads a reply's thread from
  // Slack and must recognise the card in it (specs/2026-10-03-one-responder-per-message.md §1 c).
  const id = header.includes(d.id) ? '' : ` [${d.id}]`;
  const options = `(${d.options.map((o) => o.label).join(' / ')})`;
  return showsQuestionSection(d) ? `${header}${id}: ${d.question} ${options}` : `${d.question}${id} ${options}`;
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

/**
 * Whether Slack ts `a` is strictly later than `b` ("1790901042.417179" vs
 * "1790899545.203529"). Compared as whole seconds, then the fraction, so
 * float precision never decides. Unreadable values are not later.
 *
 * @param a - Slack ts
 * @param b - Slack ts
 * @returns True when `a` is after `b`
 */
export function slackTsAfter(a: string | undefined, b: string | undefined): boolean {
  const parse = (t: string | undefined): [number, string] | null => {
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(t ?? '').trim());
    return m ? [Number(m[1]), (m[2] ?? '').padEnd(9, '0')] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  return pa[0] !== pb[0] ? pa[0] > pb[0] : pa[1] > pb[1];
}

/**
 * The files of an owner message, as a decision answer: name, type, link and
 * Slack's own transcript of a recorded clip when it sent a finished one.
 *
 * @param files - Raw Slack file objects of the message
 * @returns Answer files (empty for none)
 */
export function answerFilesOf(files: ReadonlyArray<Partial<SlackFile>> | undefined): DecisionAnswerFile[] {
  return (files ?? [])
    .filter((f) => !!f && (f.name || f.permalink || f.id))
    .map((f) => {
      const t = f.transcription;
      const transcript = t && t.status !== 'failed' ? t.preview?.content?.replace(/\s+/g, ' ').trim() : undefined;
      return {
        name: f.name || f.id || 'file',
        ...(f.mimetype ? { mimetype: f.mimetype } : {}),
        ...(f.permalink ? { permalink: f.permalink } : {}),
        ...(transcript ? { transcript } : {}),
      };
    });
}

/**
 * What an owner's file answer is, in words for the asker: "a voice message",
 * "an image", "2 files".
 *
 * @param files - Answer files
 * @returns Phrase
 */
export function describeAnswerFiles(files: readonly DecisionAnswerFile[]): string {
  if (files.length === 0) return 'nothing';
  if (files.length > 1) return `${files.length} files`;
  const f = files[0];
  if (isAudioOrVideo({ name: f.name, mimetype: f.mimetype ?? '' })) return (f.mimetype ?? '').startsWith('video/') ? 'a video' : 'a voice message';
  if ((f.mimetype ?? '').startsWith('image/')) return 'an image';
  return 'a file';
}
