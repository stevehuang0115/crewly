/**
 * Owner receipt (#828) — the data layer.
 *
 * Builds a {@link ReceiptData} from tickets and WorkItems only: no LLM, no
 * chat logs, no wording. Pure functions, so the window, the outcomes, the
 * deliverables and the cost policy can each be tested on their own and the
 * whole thing can be replayed over a day of real data.
 *
 * - **Asks** = numbered tickets created in the window, including split
 *   children and `question` tickets (#827). Each appears exactly once, under
 *   the team of its assignee.
 * - **Waiting on you** = every ticket in 待验收 (whatever day it was asked) and
 *   every WorkItem the reconciler escalated to the owner for review (#813).
 * - **Cost**: see {@link cumulativeMeterCost} — today's WorkItem `cost` is a
 *   cumulative session meter (#812), so no per-day figure can be derived and
 *   the receipt says so instead of printing a number.
 *
 * @module services/v3/owner-receipt/owner-receipt-data
 */

import { OWNER_RECEIPT_CONSTANTS, TICKET_CONSTANTS } from '../../../constants.js';
import type { Request } from '../../../types/v2/request.types.js';
import { formatTicketNumber, ticketNeedsReview } from '../../../types/v2/ticket.types.js';
import { REVIEW_ESCALATED_TO_OWNER_KEY, type WorkItem } from '../../../types/v2/work-item.types.js';
import { redactSensitive } from '../../wiki/wiki-redaction.js';
import { weightedTextLength } from '../ticket-ask-classifier.js';
import type { IntakeLogReading } from '../ticket-intake-log.js';
import {
  RECEIPT_OUTCOMES,
  type ReceiptAsk,
  type ReceiptCoverage,
  type ReceiptPossiblyMissed,
  type ReceiptCost,
  type ReceiptData,
  type ReceiptDeliverable,
  type ReceiptOutcome,
  type ReceiptTeam,
  type ReceiptWaiting,
  type ReceiptWindow,
} from './owner-receipt.types.js';

// ---------------------------------------------------------------------------
// Time (Intl only — no date library)
// ---------------------------------------------------------------------------

/** A wall-clock reading in a time zone. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * The wall-clock date and time of an instant in a time zone.
 *
 * @param at - The instant
 * @param timeZone - IANA zone
 * @returns Local parts
 */
export function localParts(at: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/**
 * Local calendar date `YYYY-MM-DD` of an instant.
 *
 * @param at - The instant
 * @param timeZone - IANA zone
 * @returns The date
 */
export function localDate(at: Date, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * The instant local midnight began on the day of `at`.
 *
 * @param at - Any instant of that local day
 * @param timeZone - IANA zone
 * @returns Local midnight as a Date
 */
export function localMidnight(at: Date, timeZone: string): Date {
  const p = localParts(at, timeZone);
  // Offset of the zone at `at` (ms): the local wall clock read as UTC, minus the instant.
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const offset = wallAsUtc - Math.floor(at.getTime() / 60000) * 60000;
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - offset);
}

/**
 * The window a receipt covers.
 *
 * Default (a decision awaiting the owner, #828): **since the last receipt**,
 * so asks sent after the send time fall into the next receipt instead of a
 * gap (the local-day rule dropped 19 of the owner's 9/25 evening messages).
 * The first receipt, with no previous one, covers the local day so far.
 *
 * @param opts.now - End of the window
 * @param opts.timezone - Owner's zone
 * @param opts.lastSentAt - When the previous receipt went out, if any
 * @param opts.from - Explicit start (API); wins over the rest
 * @param opts.to - Explicit end (API)
 * @param opts.mode - `since_last_receipt` (default) or `local_day`
 * @returns The window
 */
export function resolveReceiptWindow(opts: {
  now: Date;
  timezone: string;
  lastSentAt?: string;
  from?: string;
  to?: string;
  mode?: 'since_last_receipt' | 'local_day';
}): ReceiptWindow {
  const to = opts.to ? new Date(opts.to) : opts.now;
  if (opts.from) return { from: new Date(opts.from).toISOString(), to: to.toISOString(), basis: 'explicit', timezone: opts.timezone };
  const last = opts.lastSentAt ? Date.parse(opts.lastSentAt) : NaN;
  if ((opts.mode ?? 'since_last_receipt') === 'since_last_receipt' && Number.isFinite(last) && last < to.getTime()) {
    return { from: new Date(last).toISOString(), to: to.toISOString(), basis: 'since_last_receipt', timezone: opts.timezone };
  }
  return { from: localMidnight(to, opts.timezone).toISOString(), to: to.toISOString(), basis: 'local_day', timezone: opts.timezone };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Shorten the owner's words for one receipt line: mentions and Slack file
 * lines go, links keep their label, only the first non-empty line is kept,
 * then it is cut at `max` weighted characters (CJK count double) with "…".
 * Redacted. No LLM (#828: an LLM may shorten later; the counts never need one).
 *
 * @param text - The ticket description (the owner's message)
 * @param max - Weighted length limit
 * @returns Short, redacted text
 */
export function shortenAsk(text: string, max: number = OWNER_RECEIPT_CONSTANTS.MAX_ASK_WEIGHTED_LENGTH): string {
  const cleaned = text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '')
    .replace(/\[(Slack File|Slack Image|Slack|Hint):[^\]]*\]\.?/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1');
  const line = cleaned.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const safe = redactSensitive(line.replace(/\s+/g, ' '));
  if (weightedTextLength(safe) <= max) return safe || '（语音或文件）';
  let out = '';
  for (const ch of safe) {
    if (weightedTextLength(out + ch) > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>|)"'，。]+/g;
const FILE_RE = /(?:^|[\s`(（:：])((?:~|\.crewly|ops|specs|reports|docs)\/[\w./@-]+\.(?:md|pdf|png|jpe?g|html|json|csv|docx|pptx|xlsx))/g;

/**
 * Deliverables named in some text: GitHub PRs and issues, other links, and
 * file paths under the usual output folders. Deduplicated, in order found.
 *
 * @param texts - Output texts (WorkItem summaries, the agent's reply)
 * @returns Deliverables
 *
 * @example
 * ```typescript
 * extractDeliverables(['PR https://github.com/o/r/pull/831 and .crewly/research/x.pdf']);
 * // [{kind:'pr', label:'#831', ...}, {kind:'file', label:'x.pdf', ...}]
 * ```
 */
export function extractDeliverables(texts: ReadonlyArray<string | undefined | null>): ReceiptDeliverable[] {
  const out: ReceiptDeliverable[] = [];
  const seen = new Set<string>();
  const add = (d: ReceiptDeliverable): void => {
    if (seen.has(d.ref)) return;
    seen.add(d.ref);
    out.push(d);
  };
  for (const raw of texts) {
    if (!raw) continue;
    const text = redactSensitive(raw);
    for (const m of text.matchAll(URL_RE)) {
      const url = m[0].replace(/[.,;:!?]+$/, '');
      const gh = /github\.com\/[^/]+\/[^/]+\/(pull|issues)\/(\d+)/.exec(url);
      if (gh) add({ kind: gh[1] === 'pull' ? 'pr' : 'issue', ref: url, label: `#${gh[2]}` });
      else {
        let host = url;
        try {
          host = new URL(url).hostname.replace(/^www\./, '');
        } catch {
          /* keep the URL */
        }
        add({ kind: 'link', ref: url, label: host });
      }
    }
    for (const m of text.matchAll(FILE_RE)) {
      const ref = m[1];
      add({ kind: 'file', ref, label: ref.split('/').pop() ?? ref });
    }
  }
  return out;
}

/**
 * Every text a ticket's deliverables can be found in: the agent's reply,
 * the ticket result, and each WorkItem's output / result summary.
 *
 * @param ticket - The ticket
 * @param workItems - Its WorkItems
 * @returns Texts, in order
 */
function outputTexts(ticket: Request, workItems: readonly WorkItem[]): string[] {
  const texts: string[] = [];
  if (ticket.reply?.excerpt) texts.push(ticket.reply.excerpt);
  if (typeof ticket.result === 'string') texts.push(ticket.result);
  for (const wi of workItems) {
    for (const bag of [wi.output, wi.result]) {
      if (!bag) continue;
      for (const v of Object.values(bag)) if (typeof v === 'string') texts.push(v);
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/**
 * What happened to a ticket, from its status and WorkItems only.
 *
 * @param ticket - The ticket
 * @param workItems - Its WorkItems
 * @returns The outcome
 */
export function outcomeOf(ticket: Request, workItems: readonly WorkItem[]): ReceiptOutcome {
  if (ticket.status === 'cancelled') return 'dismissed';
  if (ticket.status === 'done') return 'done';
  if (ticket.status === 'waiting_confirmation') return ticketNeedsReview(ticket) ? 'to_review' : 'done';
  if (ticket.status === 'blocked' || workItems.some((w) => w.status === 'blocked')) return 'blocked';
  if (!ticket.assignee && workItems.length === 0) return 'unowned';
  return 'in_progress';
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/** Where per-team cost for a window comes from. */
export type ReceiptCostSource = (team: string, workItems: readonly WorkItem[], window: ReceiptWindow) => ReceiptCost;

/**
 * The default cost policy: **never prints a number it cannot stand behind.**
 *
 * `WorkItem.cost` today is a cumulative session meter (#812): it only grows
 * across a session's items, and subagents have no meter of their own. Its
 * value on today's last item is the session's lifetime spend, not today's,
 * so a non-zero reading is reported as `cumulative_meter` (not tracked), and
 * no reading at all as `no_data`. Swap in a real per-day source when #812
 * lands; the renderer already prints a tracked figure.
 *
 * @param _team - Team (unused: the policy is the same for every team)
 * @param workItems - The team's WorkItems in the window
 * @returns Always `not_tracked`
 */
export const cumulativeMeterCost: ReceiptCostSource = (_team, workItems) =>
  workItems.some((w) => (w.cost ?? 0) > 0)
    ? { status: 'not_tracked', reason: 'cumulative_meter' }
    : { status: 'not_tracked', reason: 'no_data' };

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Inputs to {@link buildReceiptData}. */
export interface ReceiptInputs {
  /** Every Request (tickets and legacy ones; non-tickets are ignored) */
  requests: readonly Request[];
  /** Every WorkItem the pool knows */
  workItems: readonly WorkItem[];
  window: ReceiptWindow;
  /** Team name of an agent session, or null when it is in no team */
  teamOf: (session: string) => string | null;
  /**
   * The team lead's display name, or null when unknown (Ava's reference:
   * `CE（Owen）`). Absent entirely → every team's `lead` is null, so the
   * renderer falls back to `*<team>*` with no parenthetical.
   */
  teamLeadOf?: (team: string) => string | null;
  /** Cost policy (default {@link cumulativeMeterCost}) */
  cost?: ReceiptCostSource;
  /**
   * The intake outcome log (#828 coverage). Absent → coverage `unknown`
   * (`not_recorded`); a log that started after the window began → `unknown`
   * (`window_before_log`). Never zeros for a window it did not see.
   */
  intakeLog?: IntakeLogReading | null;
  now: Date;
}

/**
 * The line of a message that carries the request: in 「1. 修 ⏎ 2. 485那个…可以去
 * 其他地方搜索一下吗」 it is line 2, not "1. 修". Falls back to the text.
 *
 * @param text - The owner's message
 * @returns The line to show
 */
export function askLineOf(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => TICKET_CONSTANTS.ASK.STRONG_REQUEST.test(l) || TICKET_CONSTANTS.ASK.REQUEST_VERB.test(l));
  return hit ?? text;
}

/**
 * Coverage of a window: every owner message intake logged in it, and what it
 * did with each. Unknown — not zero — when the log does not cover the window.
 *
 * @param log - The intake outcome log, if any
 * @param window - The receipt's window
 * @returns Coverage and the appended messages that still read like a request
 */
export function coverageOf(
  log: IntakeLogReading | null | undefined,
  window: ReceiptWindow,
): { coverage: ReceiptCoverage; possiblyMissed: ReceiptPossiblyMissed[] } {
  if (!log || !log.startedAt) return { coverage: { status: 'unknown', reason: 'not_recorded' }, possiblyMissed: [] };
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (Date.parse(log.startedAt) > from) {
    return { coverage: { status: 'unknown', reason: 'window_before_log' }, possiblyMissed: [] };
  }
  const seen = new Set<string>();
  const counts = { created: 0, appended: 0, ignored: 0 };
  const possiblyMissed: ReceiptPossiblyMissed[] = [];
  for (const e of [...log.events].sort((a, b) => a.at.localeCompare(b.at))) {
    const at = Date.parse(e.at);
    if (!(at >= from && at < to) || seen.has(e.ref)) continue;
    seen.add(e.ref);
    counts[e.action] += 1;
    if (e.action === 'appended' && e.askSignal && e.text && e.ticketId) {
      const tkt = typeof e.ticketNumber === 'number' ? formatTicketNumber(e.ticketNumber) : null;
      possiblyMissed.push({
        text: shortenAsk(askLineOf(e.text)),
        ticketId: e.ticketId,
        tkt,
        ref: e.ref,
        splitCommand: `split-ticket --ticket ${tkt ?? e.ticketId} --discussion-ref ${e.ref}`,
        at: e.at,
      });
    }
  }
  return {
    coverage: { status: 'known', messages: counts.created + counts.appended + counts.ignored, ...counts },
    possiblyMissed,
  };
}

/**
 * Build the receipt data.
 *
 * @param input - Tickets, WorkItems, the window and how to name teams
 * @returns Receipt data; every ticket of the window appears exactly once
 */
export function buildReceiptData(input: ReceiptInputs): ReceiptData {
  const from = Date.parse(input.window.from);
  const to = Date.parse(input.window.to);
  const cost = input.cost ?? cumulativeMeterCost;
  const teamName = (session: string | undefined): string =>
    (session ? input.teamOf(session) : null) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM;
  const itemsOf = (t: Request): WorkItem[] =>
    input.workItems.filter((w) => w.requestId === t.id || t.workItemIds.includes(w.id));

  const inWindow = input.requests
    .filter((r) => typeof r.ticketNumber === 'number')
    .filter((r) => {
      const at = Date.parse(r.createdAt);
      return at >= from && at < to;
    })
    .sort((a, b) => (a.ticketNumber as number) - (b.ticketNumber as number));

  const byTeam = new Map<string, { asks: ReceiptAsk[]; items: WorkItem[] }>();
  const outcomes = Object.fromEntries(RECEIPT_OUTCOMES.map((o) => [o, 0])) as Record<ReceiptOutcome, number>;
  const deliverables: ReceiptData['deliverables'] = { pr: 0, issue: 0, file: 0, link: 0 };

  for (const t of inWindow) {
    const items = itemsOf(t);
    const outcome = outcomeOf(t, items);
    const found = extractDeliverables(outputTexts(t, items));
    const ask: ReceiptAsk = {
      ticketId: t.id,
      tkt: formatTicketNumber(t.ticketNumber as number),
      text: shortenAsk(t.description),
      outcome,
      kind: t.kind ?? 'feature',
      isQuestion: t.kind === 'question',
      parentTicketId: t.parentTicketId ?? null,
      assignee: t.assignee ?? null,
      deliverables: found,
      blockedReason: outcome === 'blocked' ? (items.find((w) => w.blockedReason)?.blockedReason ?? null) : null,
      createdAt: t.createdAt,
    };
    const team = teamName(t.assignee);
    const bucket = byTeam.get(team) ?? { asks: [], items: [] };
    bucket.asks.push(ask);
    bucket.items.push(...items);
    byTeam.set(team, bucket);
    outcomes[outcome] += 1;
    for (const d of found) deliverables[d.kind] += 1;
  }

  const teams: ReceiptTeam[] = [...byTeam.entries()]
    // Biggest team first; unassigned last.
    .sort(([a, x], [b, y]) =>
      a === OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM ? 1 : b === OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM ? -1 : y.asks.length - x.asks.length || a.localeCompare(b),
    )
    .map(([team, v]) => ({
      team,
      lead: team === OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM ? null : (input.teamLeadOf?.(team) ?? null),
      asks: v.asks,
      cost: cost(team, v.items, input.window),
    }));

  return {
    window: input.window,
    teams,
    outcomes,
    deliverables,
    waiting: collectWaiting(input.requests, input.workItems, teamName),
    askCount: inWindow.length,
    ...coverageOf(input.intakeLog, input.window),
    generatedAt: input.now.toISOString(),
  };
}

/**
 * Everything waiting on the owner, oldest first: tickets in 待验收 (any day)
 * and WorkItems escalated to the owner for review (#813) that are still
 * awaiting it.
 *
 * @param requests - Every Request
 * @param workItems - Every WorkItem
 * @param teamName - Team of a session
 * @returns The waiting list
 */
function collectWaiting(
  requests: readonly Request[],
  workItems: readonly WorkItem[],
  teamName: (session: string | undefined) => string,
): ReceiptWaiting[] {
  const waiting: ReceiptWaiting[] = [];
  for (const r of requests) {
    if (typeof r.ticketNumber !== 'number' || r.status !== 'waiting_confirmation' || !ticketNeedsReview(r)) continue;
    waiting.push({
      source: 'ticket_review',
      id: r.id,
      tkt: formatTicketNumber(r.ticketNumber),
      text: shortenAsk(r.description),
      question: r.reply?.excerpt ? shortenAsk(r.reply.excerpt, OWNER_RECEIPT_CONSTANTS.MAX_QUESTION_WEIGHTED_LENGTH) : null,
      team: teamName(r.assignee),
      since: r.submittedAt ?? r.updatedAt ?? null,
    });
  }
  for (const w of workItems) {
    const at = w.metadata?.[REVIEW_ESCALATED_TO_OWNER_KEY];
    if (w.status !== 'done_by_worker' || typeof at !== 'string') continue;
    waiting.push({
      source: 'owner_escalation',
      id: w.id,
      tkt: null,
      text: shortenAsk(w.title),
      question: typeof w.output?.summary === 'string' ? shortenAsk(w.output.summary, OWNER_RECEIPT_CONSTANTS.MAX_QUESTION_WEIGHTED_LENGTH) : null,
      team: teamName(w.target),
      since: at,
    });
  }
  return waiting.sort((a, b) => Date.parse(a.since ?? '') - Date.parse(b.since ?? '') || a.id.localeCompare(b.id));
}
