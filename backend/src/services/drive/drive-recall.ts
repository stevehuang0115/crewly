/**
 * Drive mode recall (specs/2026-10-08-drive-mode.md §7): "what did Ella
 * just send me about the newsletter? say it again". Picks an agent's recent
 * messages to the owner out of chat-v2 — its DMs with the owner, and the
 * threads the owner is in — and ranks them by the owner's hint. Pure.
 *
 * @module services/drive/drive-recall
 */

import { DRIVE_CONSTANTS } from '../../constants.js';
import { conversationKey, ownerLastIndex, type OwnerTurnMark } from '../briefing/briefing-cards.js';
import { clip, speakable } from '../briefing/briefing.utils.js';

const C = DRIVE_CONSTANTS;

/** A chat-v2 message as recall reads it (a subset of ChatTimelineItemDTO). */
export interface RecallFeedMessage {
  id: string;
  channelId: string;
  channelType: 'dm' | 'channel' | 'huddle';
  channelName: string;
  threadId?: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  /** `owner`, `agent`, `human`, `system` */
  senderKind: string;
  agentSession: string | null;
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

/** One message recalled for the owner. */
export interface RecalledMessage {
  agentSession: string;
  /** "your DM", "#content-team" */
  where: string;
  /** ISO */
  at: string;
  /** Speakable text (no URLs / markup), clipped */
  text: string;
}

/**
 * The agent messages to the owner among chat-v2 rows: by one of `sessions`,
 * in a DM, or in a channel thread the owner wrote in. System lines and
 * Drive mode's own relays are left out.
 *
 * @param rows - Messages (any order)
 * @param ownerTurns - When the owner last wrote in each conversation
 * @param sessions - Agent sessions to recall
 * @returns Matching messages, newest first
 */
export function messagesToOwner(rows: readonly RecallFeedMessage[], ownerTurns: readonly OwnerTurnMark[], sessions: readonly string[]): RecallFeedMessage[] {
  const want = new Set(sessions);
  const owner = ownerLastIndex(ownerTurns);
  return rows
    .filter((m) => {
      if (m.senderType === 'system' || m.senderKind === 'system' || (m.senderKind !== 'agent' && m.senderType !== 'agent')) return false;
      if (!want.has(m.agentSession ?? m.senderId) && !want.has(m.senderId)) return false;
      if (!m.content.trim() || m.content.startsWith('[Drive mode')) return false;
      if (m.channelType === 'dm') return true;
      return owner.has(conversationKey(m.channelId, m.threadId ?? m.id));
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * How well a text covers the owner's hint (share of the hint's character
 * bigrams found in it), 0–1.
 *
 * @param hint - What the owner said it was about
 * @param text - A message
 * @returns Score
 */
export function hintScore(hint: string, text: string): number {
  const norm = (s: string) => speakable(s).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const h = norm(hint);
  const t = norm(text);
  if (!h || !t) return 0;
  if (t.includes(h)) return 1;
  if (h.length < 2) return 0;
  const grams = new Set<string>();
  for (let i = 0; i < h.length - 1; i++) grams.add(h.slice(i, i + 2));
  let found = 0;
  for (const g of grams) if (t.includes(g)) found += 1;
  return found / grams.size;
}

/**
 * The messages to read back: best match to the hint first (then newest), at
 * most {@link DRIVE_CONSTANTS.RECALL_MAX}; without a hint, the newest.
 *
 * @param messages - Candidates, newest first
 * @param hint - What it was about (optional)
 * @returns Recalled messages
 */
export function pickRecall(messages: readonly RecallFeedMessage[], hint?: string | null): RecalledMessage[] {
  const h = (hint ?? '').trim();
  const ranked = h
    ? messages
        .map((m, i) => ({ m, i, s: hintScore(h, m.content) }))
        .filter((x) => x.s >= 0.34)
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.m)
    : [...messages];
  return ranked.slice(0, C.RECALL_MAX).map((m) => ({
    agentSession: m.agentSession ?? m.senderId,
    where: m.channelType === 'dm' ? 'your DM' : m.channelName,
    at: new Date(m.createdAt).toISOString(),
    text: clip(speakable(m.content), C.RECALL_MESSAGE_MAX_CHARS),
  }));
}
