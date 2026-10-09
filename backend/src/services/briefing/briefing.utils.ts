/**
 * Pure helpers for the Drive mode briefing (specs/2026-10-08-drive-mode.md):
 * turning agent text into something a voice can read, ordering the queue,
 * and deciding which answers need a spoken confirmation.
 *
 * @module services/briefing/briefing.utils
 */

import { BRIEFING_CONSTANTS } from '../../constants.js';
import type { BriefingItem, BriefingUrgency } from './briefing.types.js';

const C = BRIEFING_CONSTANTS;

/** Sort rank of each urgency. */
const URGENCY_RANK: Record<BriefingUrgency, number> = { high: 0, normal: 1, low: 2 };

/**
 * Make text speakable: drop URLs, Slack/markdown markup, code and emoji
 * shortcodes, and collapse whitespace. Keeps the words.
 *
 * @param text - Agent-written text (may contain markdown)
 * @returns Plain text for speech
 *
 * @example
 * speakable('See *PR #12* <https://x.y|here> `npm i`') // 'See PR #12 here'
 */
export function speakable(text: string): string {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .replace(/<#[A-Z0-9]+\|?([^>]*)>/g, '$1')
    .replace(/:[a-z0-9_+-]+:/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?。，！？])/g, '$1$2')
    .replace(/\*\*|__|\*|~~/g, '')
    .replace(/[>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clip text at a word / sentence boundary near `max`, adding "…".
 *
 * @param text - Text
 * @param max - Longest length
 * @returns Clipped text
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('。'), cut.lastIndexOf('，'), cut.lastIndexOf(', '), cut.lastIndexOf(' '));
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trim()}…`;
}

/**
 * The short line the briefer speaks for an item.
 *
 * @param kind - Item kind
 * @param agentName - Who is waiting
 * @param text - The question / title
 * @param optionLabels - Answers to list (decisions)
 * @returns One speakable line
 */
export function spokenSummary(kind: BriefingItem['kind'], agentName: string, text: string, optionLabels: string[] = []): string {
  const body = clip(speakable(text), C.SUMMARY_MAX_CHARS);
  const lead = kind === 'review' ? `${agentName} finished: ${body}. Accept it or send it back?` : `${agentName} asks: ${body}`;
  const labels = optionLabels.map((l) => speakable(l)).filter(Boolean);
  if (kind === 'review' || labels.length === 0) return lead;
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
  return `${lead} Options: ${list}.`;
}

/**
 * Why an item needs a spoken confirmation, or null when it does not.
 *
 * @param texts - Question, title, option labels…
 * @param decisionSensitive - The decision's own sensitivity / kind, when it has one
 * @returns A short reason, or null
 */
export function sensitiveReason(texts: Array<string | undefined>, decisionSensitive?: string | null): string | null {
  if (decisionSensitive && (C.SENSITIVE_DECISION_KINDS as readonly string[]).includes(decisionSensitive)) return decisionSensitive;
  const joined = texts.filter((t): t is string => typeof t === 'string').join(' \n ');
  const m = joined.match(C.SENSITIVE_PATTERN);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Order the queue: urgency first, then the longest-waiting first; reminders
 * and answered lookups lead their urgency band.
 *
 * @param items - Items
 * @returns A new, sorted array
 */
export function orderBriefing(items: readonly BriefingItem[]): BriefingItem[] {
  const lead = (i: BriefingItem): number => (i.lookupAnswer ? 0 : i.reminder ? 1 : 2);
  return [...items].sort(
    (a, b) =>
      URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] ||
      lead(a) - lead(b) ||
      Date.parse(a.since) - Date.parse(b.since) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * When "later" with no time brings an item back: tomorrow at the default
 * local hour.
 *
 * @param now - Clock
 * @returns The time
 */
export function tomorrowMorning(now: Date): Date {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(C.LATER_DEFAULT_HOUR_LOCAL, 0, 0, 0);
  return at;
}

/**
 * Parse a "later" time: an ISO date-time in the future and at most
 * {@link BRIEFING_CONSTANTS.LATER_MAX_MS} away, or nothing (tomorrow morning).
 *
 * @param raw - Body value
 * @param now - Clock
 * @returns The time, or null when `raw` is unusable
 */
export function parseLaterTime(raw: unknown, now: Date): Date | null {
  if (raw === undefined || raw === null || raw === '') return tomorrowMorning(now);
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  if (at.getTime() <= now.getTime() || at.getTime() - now.getTime() > C.LATER_MAX_MS) return null;
  return at;
}
