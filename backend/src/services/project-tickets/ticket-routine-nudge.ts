/**
 * Routine nudge for done tickets (crewly#1034).
 *
 * A ticket whose verified result says "at least one card per day" or "check
 * this every Monday" is a recurring plan, but nothing turns it into a
 * schedule. These pure helpers detect the cadence, decide whether the lead
 * still needs telling, and build the one nudge. They never schedule anything.
 *
 * @module services/project-tickets/ticket-routine-nudge
 */

import { TICKET_ROUTINE_NUDGE_CONSTANTS as C } from '../../constants.js';
import type { Trigger } from '../../types/v2/trigger.types.js';

/**
 * A recurring cadence in English or Chinese. Deliberately narrow: "updated"
 * or "dailymotion" do not match (word boundaries).
 */
const CADENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:daily|weekly|monthly|hourly|nightly|biweekly|fortnightly)\b/i,
  /\bevery\s+(?:other\s+)?(?:day|weekday|week|month|morning|evening|night|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i,
  /\b(?:once|twice|\d+\s*(?:x|times?))\s+(?:a|per|each)\s+(?:day|week|month)\b/i,
  /\b(?:per|each)\s+(?:day|week|month)\b/i,
  /\bon\s+(?:mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|weekdays)\b/i,
  /每(?:个)?\s*(?:天|日|周|星期|礼拜|月|工作日)/,
  /每\s*\d+\s*(?:天|周|个月|小时)/,
];

/**
 * Collect the text of a WorkItem result / output: string leaves only, in
 * order, capped. Numbers and booleans are not prose and are skipped.
 *
 * @param values - Result and output objects
 * @returns One string to scan
 */
export function collectResultText(...values: unknown[]): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number): void => {
    if (size >= C.MAX_SCAN_CHARS || depth > 4) return;
    if (typeof v === 'string') {
      parts.push(v);
      size += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1);
    }
  };
  for (const v of values) walk(v, 0);
  return parts.join('\n').slice(0, C.MAX_SCAN_CHARS);
}

/**
 * Find a recurring cadence in a result text.
 *
 * @param text - Result / summary text
 * @returns The sentence that names the cadence (trimmed, capped), or null
 */
export function detectRecurringCadence(text: string): string | null {
  if (!text) return null;
  const sentences = text.split(/(?<=[.!?。！？])\s*|\n+/);
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence && CADENCE_PATTERNS.some((re) => re.test(sentence))) {
      return sentence.length > C.MAX_QUOTE_CHARS ? `${sentence.slice(0, C.MAX_QUOTE_CHARS)}…` : sentence;
    }
  }
  return null;
}

/**
 * Whether the nudge was already sent for a ticket (its Log carries the marker).
 *
 * @param log - Ticket Log lines
 * @returns True when it was sent
 */
export function routineNudgeAlreadySent(log: readonly string[]): boolean {
  return log.some((line) => line.includes(C.LOG_MARKER));
}

/**
 * Whether a live trigger already references the ticket (its id appears in the
 * trigger's name or action), so a routine is already set.
 *
 * @param triggers - All triggers
 * @param ticketId - Ticket id (e.g. `CE-101`)
 * @returns True when an active or paused trigger names the ticket
 */
export function triggerReferencesTicket(triggers: readonly Trigger[], ticketId: string): boolean {
  const escaped = ticketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`, 'i');
  return triggers.some((t) => {
    if (t.status !== 'active' && t.status !== 'paused') return false;
    return re.test(`${t.name ?? ''}\n${JSON.stringify(t.action ?? {})}`);
  });
}

/** Inputs of {@link buildRoutineNudgeBrief}. */
export interface RoutineNudgeInput {
  ticketId: string;
  title: string;
  /** The sentence that names the cadence */
  quote: string;
  /** Session that does the scheduling (the verifying lead) */
  lead: string;
}

/**
 * The nudge text for the lead (internal; the owner never sees it).
 *
 * @param input - Ticket and cadence
 * @returns Markdown brief
 */
export function buildRoutineNudgeBrief(input: RoutineNudgeInput): string {
  const title = input.title.length > C.TITLE_MAX_CHARS ? `${input.title.slice(0, C.TITLE_MAX_CHARS)}…` : input.title;
  return [
    `Ticket ${input.ticketId} ("${title}") is done, and its result describes recurring work:`,
    '',
    `> ${input.quote}`,
    '',
    'Nothing runs this on a schedule yet. Either set a routine, or say why not (one line in the ticket log is enough).',
    '',
    'Command shape (keep the ticket id in --name or --title so this check sees it):',
    '',
    '```',
    `schedule-followup --cron "<cron>" --max-fires <N> --target ${input.lead} --name "${input.ticketId}-routine" --title "${input.ticketId}: <what to do each time>"`,
    '```',
    '',
    'This is the only reminder for this ticket.',
  ].join('\n');
}
