/**
 * Which finished tickets are worth asking the owner to accept in Drive mode,
 * and how to say it (specs/2026-10-08-drive-mode.md §6).
 *
 * Owner feedback of 2026-10-10: Drive read out "Milo finished: <the owner's
 * own question>. Accept it or send it back?". Ticket intake turns many owner
 * messages into tickets (a question, a status check, a voice note), the agent
 * answers in the conversation, and the ticket lands in review. Asking the owner
 * to accept an answer to their own question inverts the direction: the owner
 * asked, the team answered, there is nothing to accept.
 *
 * So only a real deliverable is surfaced for acceptance, and it is phrased as
 * what was delivered, with the owner's request as context ("You asked: …").
 * A question, a status check, a long reflective voice note, or a ticket older
 * than the review window is left out; the ticket review sweep still settles
 * it on its own deadline.
 *
 * Pure and deterministic: no LLM, no network.
 *
 * @module services/briefing/briefing-review
 */

import { BRIEFING_CONSTANTS, TICKET_CONSTANTS } from '../../constants.js';
import { askText, weightedTextLength } from '../v3/ticket-ask-classifier.js';
import { clip, speakable } from './briefing.utils.js';

const C = BRIEFING_CONSTANTS;

/** Why a finished ticket is not asked about. */
export type ReviewDropReason = 'question_ticket' | 'inquiry' | 'discussion' | 'stale';

/** Verdict for one finished ticket. */
export type ReviewVerdict = { surface: true } | { surface: false; reason: ReviewDropReason };

/** The ticket fields the triage reads. */
export interface ReviewTicketLike {
  kind: string;
  title: string;
  description: string;
  /** ISO — when it last went to review */
  submittedAt: string | null;
  updatedAt: string;
}

/** A leading category tag the ticket title carries ("[Request] ", "[Deploy] "). */
const CATEGORY_PREFIX = /^\s*\[[A-Za-z][A-Za-z _-]{0,24}\]\s*/;

/** Wherever a question is asked: a question mark at a sentence end, or a spoken question particle. */
const QUESTION_FORM = /[?？]|(吗|呢|对吧|是不是|有没有|是否)\s*[。.!！~]*\s*$|(为什么|怎么|如何|哪里|哪个|哪些|什么时候|是什么)|\b(why|how|what|where|when|which|did you|do you|are you|is it|is there|can you tell)\b/i;

/** A status check or "did you get it": asking after the work, not asking for work. */
const STATUS_CHECK =
  /(到哪(里|了)|进展|进度|收到了吗|收到没|看到了吗|看到没|没看到|有没有收到|有收到吗|做完了吗|好了吗|怎么样了|在吗|where (is|are)|did you (get|see|receive)|any update|status)/i;

/**
 * The owner's own words: attachments and mention codes dropped, the category
 * tag a title carries removed.
 *
 * @param text - Ticket title or description
 * @returns Plain words
 */
export function ownerWords(text: string): string {
  return askText(String(text ?? '')).replace(CATEGORY_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether the owner's message asked a question or checked on progress rather
 * than asking for something to be produced.
 *
 * A message with an explicit request ("帮我…", "research …", "draft …") is
 * work even when phrased as a question ("可以研究一下 X 吗"); a status check
 * ("你 draft 到哪里了？") is not, even though it names a request verb.
 *
 * @param text - The owner's message
 * @returns True when it is an inquiry
 */
export function isInquiry(text: string): boolean {
  const own = ownerWords(text).replace(TICKET_CONSTANTS.ASK.QUOTED, ' ');
  if (!own) return false;
  if (STATUS_CHECK.test(own)) return true;
  if (!QUESTION_FORM.test(own)) return false;
  return !TICKET_CONSTANTS.ASK.STRONG_REQUEST.test(own) && !TICKET_CONSTANTS.ASK.REQUEST_VERB.test(own);
}

/**
 * Whether the message is a long, reflective voice note (thinking aloud, no
 * ask): the agent's answer is advice in the conversation, not a deliverable.
 *
 * @param text - The owner's message
 * @returns True when it reads as discussion
 */
export function isDiscussion(text: string): boolean {
  const own = ownerWords(text).replace(TICKET_CONSTANTS.ASK.QUOTED, ' ');
  if (weightedTextLength(own) < C.REVIEW_DISCUSSION_MIN_WEIGHTED) return false;
  return !TICKET_CONSTANTS.ASK.STRONG_REQUEST.test(own) && !TICKET_CONSTANTS.ASK.REQUEST_VERB.test(own);
}

/**
 * Decide whether a finished ticket is asked about.
 *
 * @param t - The ticket
 * @param now - Clock (ms)
 * @returns Surface it, or why it is left out
 */
export function triageReview(t: ReviewTicketLike, now: number): ReviewVerdict {
  if (t.kind === 'question') return { surface: false, reason: 'question_ticket' };
  const since = Date.parse(t.submittedAt ?? t.updatedAt);
  if (!Number.isNaN(since) && now - since > C.REVIEW_MAX_AGE_MS) return { surface: false, reason: 'stale' };
  const words = t.description || t.title;
  if (isInquiry(words)) return { surface: false, reason: 'inquiry' };
  if (isDiscussion(words)) return { surface: false, reason: 'discussion' };
  return { surface: true };
}

/**
 * The first sentence or two of an agent's answer, speakable.
 *
 * @param excerpt - The answer's start
 * @param max - Longest length
 * @returns Text, or '' when there is none
 */
export function deliveredLine(excerpt: string | undefined, max: number): string {
  const text = speakable(excerpt ?? '');
  if (!text) return '';
  const sentences = text.match(/[^。.!?！？]+[。.!?！？]?/g) ?? [text];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > max && out) break;
    out += s;
    if (out.length >= max * 0.5) break;
  }
  return clip(out.trim().replace(/[。.]$/, ''), max);
}

/**
 * The spoken line for a review item. Direction first: it is the team
 * reporting back on something the owner asked for, never the team asking.
 *
 * @param agentName - Who did it
 * @param t - Ticket title / description
 * @param excerpt - The agent's answer, when there is one
 * @returns One speakable line (no markup)
 *
 * @example
 * reviewSummary('Pia', { title: '[Implement] redo the intro', description: 'redo the intro' }, 'v5 is ready, 43 seconds.')
 * // 'You asked Pia: redo the intro. Pia reports: v5 is ready, 43 seconds. Accept it or send it back?'
 */
export function reviewSummary(agentName: string, t: Pick<ReviewTicketLike, 'title' | 'description'>, excerpt: string | undefined): string {
  const ask = clip(ownerWords(t.description || t.title), C.REVIEW_ASK_MAX_CHARS);
  const result = deliveredLine(excerpt, C.REVIEW_RESULT_MAX_CHARS);
  const head = ask ? `You asked ${agentName}: ${ask}.` : `${agentName} did some work for you.`;
  const body = result ? ` ${agentName} reports: ${result}.` : ` ${agentName} says it is done.`;
  return `${head}${body} Accept it or send it back?`;
}
