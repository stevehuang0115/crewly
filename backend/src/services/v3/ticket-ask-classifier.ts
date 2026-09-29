/**
 * Ticket ask classifier (#827) — is an owner message a new ask, or a
 * follow-up on the work already in progress?
 *
 * Ticket intake used to append every message in a thread with an open ticket
 * to that ticket, and to drop request-phrased questions ("可以去研究一下 X 吗")
 * as noise. On 2026-09-26 that turned 15+ distinct asks into 6 tickets. This
 * classifier gives intake one deterministic answer per message:
 *
 * - `new_ask`  — a new unit of work with its own deliverable → its own ticket
 * - `question` — a pure information question → a lightweight `question`
 *   ticket with no acceptance step
 * - `follow_up` — an answer, approval, clarification, correction, delivery
 *   instruction or status ping about the current work → append
 * - `not_ask`  — nothing to act on (top level only)
 *
 * **Scoring.** Each message gets an ask score and a follow score from the
 * patterns in {@link TICKET_CONSTANTS.ASK}. It is a new ask only when the ask
 * score reaches {@link TICKET_CONSTANTS.ASK.MIN_ASK_SCORE} AND is strictly
 * greater than the follow score. Ties append: over-splitting (ticket spam, an
 * extra review nudge per ticket) is the worse failure for the owner, and an
 * agent can split a ticket afterwards.
 *
 * No LLM, no network: the same text always gets the same verdict, and every
 * verdict carries the signals that produced it.
 *
 * @module services/v3/ticket-ask-classifier
 */

import { TICKET_CONSTANTS } from '../../constants.js';

/** What a message is, for ticket intake. */
export type AskVerdict = 'new_ask' | 'question' | 'follow_up' | 'not_ask';

/** Result of {@link classifyOwnerMessage}. */
export interface AskClassification {
  verdict: AskVerdict;
  /** Ask score (request verb 2, info question / new topic / idea +1 each) */
  ask: number;
  /** Follow-up score (the strongest follow-up signal) */
  follow: number;
  /** Names of the signals that fired, for logs and tests */
  signals: string[];
}

/** Context the verdict depends on. */
export interface AskContext {
  /**
   * The message is a reply in a thread that already has a ticket. In a
   * thread the question is "new ask or follow-up"; at top level it is "ask or
   * not" (status pings and chatter are `not_ask`).
   */
  inThread: boolean;
}

/** CJK ideographs, kana and hangul count double towards length checks. */
const WIDE_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;

/**
 * Length of a text counting wide (CJK) characters twice: a Chinese sentence
 * says as much in 7 characters as an English one in 14.
 *
 * @param text - Trimmed text
 * @returns Weighted length
 */
export function weightedTextLength(text: string): number {
  let n = 0;
  for (const ch of text) n += WIDE_CHAR.test(ch) ? 2 : 1;
  return n;
}

/**
 * The words of a message, without what Slack wraps around them: mention
 * codes, `[Slack File: …]` / `[Slack Image: …]` / `[Hint: …]` lines and
 * markdown image embeds. Links keep their URL.
 *
 * @param text - Raw message text
 * @returns Cleaned, trimmed text
 */
export function askText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ')
    .replace(/\[(Slack File|Slack Image|Slack|Hint):[^\]]*\]\.?/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<(https?:[^>|]+)(\|[^>]+)?>/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Classify one owner message. Pure and deterministic.
 *
 * @param rawText - The message as the owner wrote it
 * @param ctx - Whether it is a reply in a ticket's thread
 * @returns The verdict, both scores and the signals that fired
 *
 * @example
 * ```typescript
 * classifyOwnerMessage('可以去研究一下opus做视频那个吗', { inThread: true }).verdict; // 'new_ask'
 * classifyOwnerMessage('好的 开issue可以的', { inThread: true }).verdict;            // 'follow_up'
 * classifyOwnerMessage('这个团队都有几个人', { inThread: false }).verdict;             // 'question'
 * ```
 */
export function classifyOwnerMessage(rawText: string, ctx: AskContext): AskClassification {
  const P = TICKET_CONSTANTS.ASK;
  const text = askText(rawText);
  const signals: string[] = [];
  if (!text) return { verdict: ctx.inThread ? 'follow_up' : 'not_ask', ask: 0, follow: 0, signals: ['empty'] };

  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  // Lines that only say 「好的」 carry no ask and must not mask one that follows.
  const content = lines.filter((l) => !P.ACK_ONLY_LINE.test(l));
  const body = content.join('\n');
  // Asks are read from the owner's own words, not from what they quote.
  const ownWords = body.replace(P.QUOTED, ' ');

  // --- follow-up signals: the strongest one counts ---
  let follow = 0;
  const bump = (name: string, score: number): void => {
    signals.push(name);
    follow = Math.max(follow, score);
  };
  if (content.length === 0) bump('ack_only', 3);
  // Links carry words like `/status/` — read the owner's words only.
  if (P.STATUS_PING.test(body.replace(/https?:\/\/\S+/g, ' '))) bump('status_ping', 3);
  // The rest are about "the work in progress" — only a thread has one.
  if (ctx.inThread) {
    // A numbered reply answers the agent's own list: it wins over the asks in it.
    if (P.NUMBERED_REPLY.test(lines[0] ?? '')) bump('numbered_reply', 5);
    if (content.length === 1 && P.APPROVAL_LINE.test(content[0])) bump('approval', 3);
    if (P.DELIVERY_FORMAT.test(body)) bump('delivery_format', 3);
    if (P.FEEDBACK.test(body)) bump('feedback', 3);
    if (P.CLARIFY.test(body)) bump('clarify', 2);
    if (P.ABOUT_AGENT_WORK.test(body)) bump('about_agent_work', 3);
    if (P.SHOW_ME_TAIL.test(body)) bump('show_me', 3);
    if (P.CORRECTION_OR_CHOICE.test(content[0] ?? '')) bump('correction_or_choice', 3);
    if (P.RETRY_CONTINUE.test(body)) bump('retry_continue', 3);
    if (P.SUGGEST_TAIL.test(body)) bump('suggest_tail', 3);
    if (P.DISPOSITION.test(body)) bump('disposition', 3);
  }

  // --- ask signals: they add up ---
  let ask = 0;
  const strong = P.STRONG_REQUEST.test(ownWords);
  // 「看看这个 <link>」: the reference is the object of the look. Read from the
  // raw text, since askText() drops the [Slack Image: …] lines.
  const lookAtReference = P.LOOK.test(ownWords) && P.REFERENCE.test(rawText);
  if (lookAtReference) signals.push('look_at_reference');
  const verb = strong || lookAtReference || P.REQUEST_VERB.test(ownWords);
  // In a thread a verb-less question must look like one (「…有什么值得学习的吗」);
  // a reflective 「都有什么经验见解」 mid-discussion is not a new ask.
  const question = P.INFO_QUESTION.test(ownWords) && (!ctx.inThread || verb || P.QUESTION_MARK.test(ownWords));
  const newTopic = P.NEW_TOPIC.test(body);
  if (strong) {
    signals.push('strong_request');
    ask += 4;
  } else if (verb) {
    signals.push('request_verb');
    ask += 2;
  }
  if (question) {
    signals.push('info_question');
    ask += 1;
  }
  if (newTopic) {
    signals.push('new_topic');
    ask += 1;
  }
  if (P.IDEA.test(ownWords)) {
    signals.push('idea');
    ask += 1;
  }

  // Spoken discussion in a thread (voice transcripts): long, reflective, and
  // full of incidental 看看 / 有没有 that add up. A follow-up unless it opens a
  // new topic or says 「你能不能帮我…」 outright (a strong request beats 3).
  // At the top level a long message is a brief, not a reply.
  if (ctx.inThread && weightedTextLength(body) > P.LONG_DISCUSSION_WEIGHTED_LENGTH && !newTopic) {
    bump('long_discussion', strong ? 3 : Math.max(ask, 3));
  }

  // A pure information question (no verb) still stands on its own at the
  // top level; in a thread it is a new ask only if it beats the follow score.
  const questionOnly = question && !verb;
  const effectiveAsk = questionOnly && ask < P.MIN_ASK_SCORE ? P.MIN_ASK_SCORE : ask;
  const isAsk = effectiveAsk >= P.MIN_ASK_SCORE && effectiveAsk > follow;

  if (!isAsk) return { verdict: ctx.inThread ? 'follow_up' : 'not_ask', ask, follow, signals };
  return { verdict: questionOnly ? 'question' : 'new_ask', ask, follow, signals };
}
