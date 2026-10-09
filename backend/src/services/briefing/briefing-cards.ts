/**
 * Which decision cards and reply questions are still worth reading out in
 * Drive mode (specs/2026-10-08-drive-mode.md §6). The briefing queue is read
 * only when the owner asks ("anything waiting for me?"), and then only the
 * live items: the phone test of 2026-10-08 read mostly stale cards,
 * duplicates and questions already answered in their thread.
 *
 * Left out:
 *  - a card past its deadline (plus a grace) or asked too long ago;
 *  - a card or question the owner already answered — replied in the card's
 *    thread, or wrote in its conversation after it was asked;
 *  - a duplicate: an older card (or question) from the same asker whose
 *    question is nearly the same as a newer one.
 *
 * Pure functions; the owner's last turn per conversation comes from chat-v2.
 *
 * @module services/briefing/briefing-cards
 */

import { BRIEFING_CONSTANTS } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { speakable } from './briefing.utils.js';

const C = BRIEFING_CONSTANTS;

/** When the owner last wrote in a conversation (all time). */
export interface OwnerTurnMark {
  channelId: string;
  /** Thread root id; '' for a DM */
  root: string;
  lastAt: number;
}

/**
 * The key of a conversation: a DM channel, or one thread of a channel.
 *
 * @param channelId - chat-v2 channel
 * @param root - Thread root id ('' for a DM)
 * @returns Key
 */
export function conversationKey(channelId: string, root: string): string {
  return `${channelId}|${root}`;
}

/**
 * Owner turn marks as a lookup.
 *
 * @param marks - Marks
 * @returns Key → epoch ms
 */
export function ownerLastIndex(marks: readonly OwnerTurnMark[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of marks) {
    const key = conversationKey(m.channelId, m.root);
    out.set(key, Math.max(out.get(key) ?? 0, m.lastAt));
  }
  return out;
}

/**
 * Character-bigram similarity of two questions (Dice, 0–1), ignoring
 * punctuation, markup and case.
 *
 * @param a - Question
 * @param b - Question
 * @returns Similarity
 */
export function questionSimilarity(a: string, b: string): number {
  const norm = (s: string) => speakable(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1);
    return m;
  };
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  return (2 * overlap) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1));
}

/** What the card filter needs. */
export interface CardContext {
  now: number;
  /** The conversation key of a card (its open item's chat ref), or null */
  conversationOf: (d: OwnerDecision) => string | null;
  /** When the owner last wrote in a conversation (epoch ms), or 0 */
  ownerLastAt: (conversationKey: string) => number;
}

/** Why a card is not read out. */
export type CardDropReason = 'not_pending' | 'snoozed' | 'expired' | 'stale' | 'answered' | 'duplicate';

/** The result of {@link liveCards}. */
export interface LiveCards {
  /** Live cards, newest first */
  live: OwnerDecision[];
  dropped: Array<{ id: string; reason: CardDropReason }>;
}

/**
 * The cards worth reading out.
 *
 * @param decisions - Open / parked cards
 * @param ctx - Clock and conversation lookups
 * @returns Live cards and why the others were dropped
 */
export function liveCards(decisions: readonly OwnerDecision[], ctx: CardContext): LiveCards {
  const dropped: LiveCards['dropped'] = [];
  const askedAt = (d: OwnerDecision): number => Date.parse(d.askedAt ?? d.createdAt) || 0;
  const candidates: OwnerDecision[] = [];
  for (const d of decisions) {
    if (d.status !== 'open' && d.status !== 'parked') {
      dropped.push({ id: d.id, reason: 'not_pending' });
      continue;
    }
    const remindAt = d.remindAt ? Date.parse(d.remindAt) : NaN;
    if (!Number.isNaN(remindAt) && remindAt > ctx.now) {
      dropped.push({ id: d.id, reason: 'snoozed' });
      continue;
    }
    const asked = askedAt(d);
    // A card the owner asked to be reminded of counts from the reminder.
    const since = Number.isNaN(remindAt) ? asked : Math.max(asked, remindAt);
    const deadline = Date.parse(d.deadline);
    if (d.status === 'open' && Number.isNaN(remindAt) && !Number.isNaN(deadline) && ctx.now - deadline > C.CARD_STALE_AFTER_DEADLINE_MS) {
      dropped.push({ id: d.id, reason: 'expired' });
      continue;
    }
    if (ctx.now - since > C.CARD_MAX_AGE_MS) {
      dropped.push({ id: d.id, reason: 'stale' });
      continue;
    }
    const repliedAt = d.ownerRepliedAt ? Date.parse(d.ownerRepliedAt) : NaN;
    const conv = ctx.conversationOf(d);
    const lastOwner = conv ? ctx.ownerLastAt(conv) : 0;
    if ((!Number.isNaN(repliedAt) && repliedAt >= asked) || (lastOwner > 0 && lastOwner > asked)) {
      dropped.push({ id: d.id, reason: 'answered' });
      continue;
    }
    candidates.push(d);
  }
  candidates.sort((a, b) => askedAt(b) - askedAt(a) || b.id.localeCompare(a.id));
  const live: OwnerDecision[] = [];
  for (const d of candidates) {
    const dup = live.find((k) => k.asker === d.asker && questionSimilarity(k.question, d.question) >= C.CARD_DUPLICATE_SIMILARITY);
    if (dup) dropped.push({ id: d.id, reason: 'duplicate' });
    else live.push(d);
  }
  return { live, dropped };
}

/** A reply question as the filter sees it. */
export interface QuestionLike {
  id: string;
  agent: string;
  text: string;
  /** ISO */
  createdAt: string;
  /** Its conversation key, or null */
  conversation: string | null;
}

/**
 * Reply questions worth reading out: not answered in their conversation
 * (the owner wrote there after it was asked), not stale, and not a repeat of
 * a live card or a newer question from the same agent.
 *
 * @param questions - Open reply questions
 * @param cards - Live cards
 * @param ctx - Clock and the owner's last turn per conversation
 * @returns Ids of the questions to keep
 */
export function liveQuestionIds(questions: readonly QuestionLike[], cards: readonly OwnerDecision[], ctx: Pick<CardContext, 'now' | 'ownerLastAt'>): Set<string> {
  const keep: QuestionLike[] = [];
  const similar = (a: string, b: string) => questionSimilarity(a, b) >= C.CARD_DUPLICATE_SIMILARITY;
  const sorted = [...questions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  for (const q of sorted) {
    const at = Date.parse(q.createdAt) || 0;
    if (ctx.now - at > C.CARD_MAX_AGE_MS) continue;
    if (q.conversation && ctx.ownerLastAt(q.conversation) > at) continue;
    if (cards.some((d) => d.asker === q.agent && similar(d.question, q.text))) continue;
    if (keep.some((k) => k.agent === q.agent && similar(k.text, q.text))) continue;
    keep.push(q);
  }
  return new Set(keep.map((q) => q.id));
}
