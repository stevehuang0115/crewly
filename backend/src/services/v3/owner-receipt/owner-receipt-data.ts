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
 * - **Highlights / decisions** (2026-09-28 redesign, what the Slack receipt
 *   shows): the few outcomes worth telling him, in the agent's words
 *   ({@link summarizeOutcome}), and the few things genuinely blocked on him,
 *   phrased as the question ({@link ownerQuestionOf}). A ticket is credited
 *   to the team that actually did it ({@link ticketTeamOf}); an answer that
 *   came from another team than the assignee's is treated as misrouted
 *   ({@link isMisrouted}) and left off both lists.
 *
 * @module services/v3/owner-receipt/owner-receipt-data
 */

import { ORCHESTRATOR_SESSION_NAME, OWNER_RECEIPT_CONSTANTS, TICKET_CONSTANTS } from '../../../constants.js';
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
  type ReceiptDecision,
  type ReceiptDeliverable,
  type ReceiptHighlight,
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
  if (weightedTextLength(safe) <= max) return safe || '(voice or file)';
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
  /** An agent session's display name (「Atlas」), or null; absent → its team is named instead */
  agentNameOf?: (session: string) => string | null;
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
  const label = teamLabeller(input.teamOf);
  const teamName = (session: string | undefined): string => label(session) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM;
  const itemsOf = (t: Request): WorkItem[] =>
    input.workItems.filter((w) => w.requestId === t.id || t.workItemIds.includes(w.id));
  const ticketTeam = (t: Request): string => ticketTeamOf(t, itemsOf(t), label) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM;

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
    const team = ticketTeam(t);
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
    waiting: collectWaiting(input.requests, input.workItems, (t) => ticketTeam(t), teamName),
    askCount: inWindow.length,
    ...coverageOf(input.intakeLog, input.window),
    highlights: collectHighlights(input, itemsOf, label),
    ...collectDecisions(input, itemsOf, label),
    generatedAt: input.now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Who did it (2026-09-28: an Atlas ticket was listed under another team)
// ---------------------------------------------------------------------------

/** Team (or orchestrator label) of a session, or null when it is not one of ours. */
export type TeamLabeller = (session: string | null | undefined) => string | null;

/**
 * Team names for sessions, with the orchestrator (in no team) named
 * {@link OWNER_RECEIPT_CONSTANTS.ORCHESTRATOR_LABEL}.
 *
 * @param teamOf - Team of a session
 * @returns The labeller
 */
export function teamLabeller(teamOf: (session: string) => string | null): TeamLabeller {
  return (session) => {
    if (!session) return null;
    return teamOf(session) ?? (session === ORCHESTRATOR_SESSION_NAME ? OWNER_RECEIPT_CONSTANTS.ORCHESTRATOR_LABEL : null);
  };
}

/**
 * The team that actually did a ticket: its assignee's, when the assignee is
 * one of this machine's agents; else the team of the agent that answered it;
 * else of whoever its WorkItems went to. A ticket addressed to an agent on
 * another machine (a shared Slack room) but answered here is credited here.
 *
 * @param t - The ticket
 * @param items - Its WorkItems
 * @param label - Session → team
 * @returns Team label, or null when nobody known did it
 */
export function ticketTeamOf(t: Request, items: readonly WorkItem[], label: TeamLabeller): string | null {
  return label(t.assignee) ?? label(t.reply?.by) ?? items.map((w) => label(w.target)).find((x): x is string => !!x) ?? null;
}

/**
 * Whether the answer recorded on a ticket came from somebody other than its
 * assignee's team — another team's post in a shared thread (TKT-017: Ella's
 * calendar question recorded as the answer to Atlas's ticket), or an agent on
 * another machine. Such a ticket is not put in front of the owner. A ticket
 * addressed to another machine's agent but answered here is not misrouted:
 * it is ours ({@link ticketTeamOf}).
 *
 * @param t - The ticket
 * @param label - Session → team
 * @returns True when the recorded answer is not the assignee team's
 */
export function isMisrouted(t: Request, label: TeamLabeller): boolean {
  const by = t.reply?.by;
  if (!by || !t.assignee || by === t.assignee) return false;
  const assigneeTeam = label(t.assignee);
  const answerTeam = label(by);
  return answerTeam === null || (assigneeTeam !== null && assigneeTeam !== answerTeam);
}

// ---------------------------------------------------------------------------
// Owner-facing wording helpers (no LLM)
// ---------------------------------------------------------------------------

/**
 * Plain text of an agent's Slack-flavoured answer: no mentions, links keep
 * their label, bare URLs and file paths go, markdown marks go.
 *
 * @param text - Raw text
 * @returns Cleaned text (lines kept)
 */
function plainAnswerText(text: string): string {
  return redactSensitive(text)
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<https?:[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(^|[\s(（:：])(~|\.{0,2}\/)?[\w.@-]*(\/[\w.@-]+)+\.(md|pdf|png|jpe?g|html|json|csv|docx|pptx|xlsx|ts|js)\b/g, '$1')
    .replace(/(路径是|路径为|写在|写到|放在|放到|放进|存在|存到|存进|见|path:?)\s*(?=[。，,；;）)]|$)/gim, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([。，,；;！？])/g, '$1')
    .replace(/[，,；;]([。！？])/g, '$1')
    .replace(/[，,；;]+\s*$/gm, '')
    .replace(/([：:]) +/g, '$1');
}

/**
 * Cut a line to `max` weighted characters, at a phrase boundary when there is
 * one (。！？；，;!? — not `,`, which also sits inside numbers), else with 「…」.
 *
 * @param line - The line
 * @param max - Weighted limit
 * @returns The line, fitting
 */
export function fitLine(line: string, max: number = OWNER_RECEIPT_CONSTANTS.MAX_LINE_WEIGHTED_LENGTH): string {
  const trimmed = line.trim();
  if (weightedTextLength(trimmed) <= max) return trimmed;
  let out = '';
  let lastBoundary = -1;
  for (const ch of trimmed) {
    if (weightedTextLength(out + ch) > max - 1) break;
    out += ch;
    if (/[。！？；，;!?]/.test(ch)) lastBoundary = out.length;
  }
  if (lastBoundary >= out.length / 3) return out.slice(0, lastBoundary).replace(/[，,;；]$/, '').trim();
  return `${out.trimEnd()}…`;
}

/**
 * One line saying what was done, taken from the agent's answer: the first
 * line that says something (not a heading, not a lead-in ending in 「：」, not
 * a greeting), cut to fit. Deterministic; empty when nothing usable.
 *
 * @param text - The agent's answer (ticket result / reply excerpt)
 * @returns The outcome line, or ''
 *
 * @example
 * ```typescript
 * summarizeOutcome('*结论*\n• 每天早上 8 点问你一个问题，已经设好'); // '每天早上 8 点问你一个问题，已经设好'
 * ```
 */
export function summarizeOutcome(text: string | null | undefined): string {
  if (!text) return '';
  const min = OWNER_RECEIPT_CONSTANTS.MIN_SUMMARY_WEIGHTED_LENGTH;
  const lines = plainAnswerText(text).split('\n');
  // The owner reads Chinese: a Chinese line first, any line if there is none.
  const cjk = /[一-鿿]/;
  for (const raw of [...lines.filter((l) => cjk.test(l)), ...lines.filter((l) => !cjk.test(l))]) {
    let line = raw
      .replace(/^\s*([•·\-–—]|\d+[.、)）])\s*/, '')
      .replace(/^(Steve|老板|你好|好的|收到)[，,、：:\s]+/i, '')
      .trim();
    // 「看了。」「一半是。」 opens the answer; the outcome is what follows.
    const opener = /^[^。！？!?]{1,6}[。！？!?]\s*/.exec(line);
    if (opener && weightedTextLength(line.slice(opener[0].length)) >= min) line = line.slice(opener[0].length);
    // A lead-in (「…可以直接复制发：」) keeps only its sentences before it.
    if (/[：:]\s*$/.test(line)) {
      const end = Math.max(line.lastIndexOf('。'), line.lastIndexOf('！'), line.lastIndexOf('？'));
      line = end >= 0 ? line.slice(0, end + 1) : '';
    }
    if (weightedTextLength(line) < min) continue;
    return fitLine(line);
  }
  return '';
}

/**
 * The question an agent's answer asks the owner, as one line: the last
 * sentence that ends in a question mark; a lead-in before 「：」 is dropped
 * when the rest stands alone. Null when the answer asks nothing.
 *
 * @param text - The agent's answer
 * @returns The question, or null
 */
export function ownerQuestionOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const sentences = plainAnswerText(text)
    .split(/(?<=[。！？!?\n])/)
    .map((x) => x.replace(/^\s*([•·\-–—]|\d+[.、)）])\s*/, '').trim())
    .filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    let q = sentences[i];
    if (!/[？?]\s*$/.test(q)) continue;
    const colon = Math.max(q.lastIndexOf('：'), q.lastIndexOf(':'));
    if (colon >= 0 && weightedTextLength(q.slice(colon + 1)) >= OWNER_RECEIPT_CONSTANTS.MIN_SUMMARY_WEIGHTED_LENGTH) q = q.slice(colon + 1);
    q = q.trim();
    if (weightedTextLength(q) < 6) continue;
    return fitLine(q);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Highlights and decisions
// ---------------------------------------------------------------------------

/**
 * 「今天做完的」: tickets that became done in the window (not stale-closed, not
 * dismissed, not misrouted), each as its outcome line. Ranked: with
 * deliverables first, real work before plain questions, newest first; at
 * most {@link OWNER_RECEIPT_CONSTANTS.MAX_HIGHLIGHTS}, no two alike.
 *
 * @param input - Receipt inputs
 * @param itemsOf - WorkItems of a ticket
 * @param label - Session → team
 * @returns Highlights
 */
function collectHighlights(input: ReceiptInputs, itemsOf: (t: Request) => WorkItem[], label: TeamLabeller): ReceiptHighlight[] {
  const from = Date.parse(input.window.from);
  const to = Date.parse(input.window.to);
  const candidates: Array<ReceiptHighlight & { question: boolean }> = [];
  for (const t of input.requests) {
    if (typeof t.ticketNumber !== 'number' || t.status !== 'done') continue;
    if (t.tags.includes(TICKET_CONSTANTS.STALE.TAG) || t.tags.includes(TICKET_CONSTANTS.DISMISSED_TAG)) continue;
    const at = Date.parse(t.completedAt ?? t.updatedAt);
    if (!(at >= from && at < to) || isMisrouted(t, label)) continue;
    const items = itemsOf(t);
    const texts = outputTexts(t, items);
    const summary = summarizeOutcome(typeof t.result === 'string' && t.result ? t.result : t.reply?.excerpt) || summarizeOutcome(texts.join('\n'));
    if (!summary) continue;
    candidates.push({
      ticketId: t.id,
      team: ticketTeamOf(t, items, label),
      summary,
      // Links are what he sent; a file, a PR or an issue is what got made.
      deliverableCount: extractDeliverables(texts).filter((d) => d.kind !== 'link').length,
      completedAt: new Date(at).toISOString(),
      question: t.kind === 'question',
    });
  }
  candidates.sort(
    (a, b) =>
      Number(b.deliverableCount > 0) - Number(a.deliverableCount > 0) ||
      Number(a.question) - Number(b.question) ||
      b.completedAt.localeCompare(a.completedAt),
  );
  // One per team first (so one busy team does not fill the list), then the rest.
  const seen = new Set<string>();
  const out: ReceiptHighlight[] = [];
  const teams = new Set<string | null>();
  for (const pass of [0, 1]) {
    for (const { question: _question, ...h } of candidates) {
      if (out.length >= OWNER_RECEIPT_CONSTANTS.MAX_HIGHLIGHTS) break;
      if (seen.has(h.summary) || (pass === 0 && teams.has(h.team))) continue;
      seen.add(h.summary);
      teams.add(h.team);
      out.push(h);
    }
  }
  return out.sort((a, b) => b.deliverableCount - a.deliverableCount || b.completedAt.localeCompare(a.completedAt));
}

/**
 * 「需要你决定的」: what is genuinely blocked on the owner, oldest first — a
 * 待验收 deliverable answered within {@link OWNER_RECEIPT_CONSTANTS.DECISION_MAX_AGE_MS}
 * (not misrouted), and WorkItems escalated to him for review (#813) within the
 * same age. Each phrased as the question he is asked.
 *
 * @param input - Receipt inputs
 * @param itemsOf - WorkItems of a ticket
 * @param label - Session → team
 * @returns The first few decisions and how many there are in all
 */
function collectDecisions(
  input: ReceiptInputs,
  itemsOf: (t: Request) => WorkItem[],
  label: TeamLabeller,
): { decisions: ReceiptDecision[]; decisionsTotal: number } {
  const cutoff = input.now.getTime() - OWNER_RECEIPT_CONSTANTS.DECISION_MAX_AGE_MS;
  const nameOf = (session: string | null | undefined, fallback: string | null): string | null =>
    (session ? input.agentNameOf?.(session) : null) ?? fallback;
  const all: ReceiptDecision[] = [];
  for (const t of input.requests) {
    if (typeof t.ticketNumber !== 'number' || t.status !== 'waiting_confirmation' || !ticketNeedsReview(t)) continue;
    const since = t.submittedAt ?? t.updatedAt;
    if (Date.parse(since) < cutoff || isMisrouted(t, label)) continue;
    const answer = t.reply?.excerpt ?? (typeof t.result === 'string' ? t.result : '');
    const summary = summarizeOutcome(answer);
    const question = ownerQuestionOf(answer) ?? (summary ? `${summary.replace(/[。.!！]$/, '')} — OK?` : null);
    if (!question) continue;
    all.push({
      id: t.id,
      source: 'ticket_review',
      from: nameOf(t.reply?.by ?? t.assignee, ticketTeamOf(t, itemsOf(t), label)),
      question,
      since,
    });
  }
  for (const w of input.workItems) {
    const at = w.metadata?.[REVIEW_ESCALATED_TO_OWNER_KEY];
    if (w.status !== 'done_by_worker' || typeof at !== 'string' || Date.parse(at) < cutoff) continue;
    const summary = typeof w.output?.summary === 'string' ? w.output.summary : '';
    const question = ownerQuestionOf(summary) ?? `${fitLine(plainAnswerText(w.title).replace(/\s+/g, ' '))} — needs your review`;
    all.push({ id: w.id, source: 'owner_escalation', from: nameOf(w.target, label(w.target)), question, since: at });
  }
  all.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id.localeCompare(b.id));
  return { decisions: all.slice(0, OWNER_RECEIPT_CONSTANTS.MAX_DECISIONS), decisionsTotal: all.length };
}

/**
 * Whether a receipt has nothing to tell the owner: nothing notable done and
 * nothing waiting on him. Then no receipt is sent at all.
 *
 * @param data - Receipt data
 * @returns True when it should be skipped
 */
export function isReceiptEmpty(data: Pick<ReceiptData, 'highlights' | 'decisionsTotal'>): boolean {
  return data.highlights.length === 0 && data.decisionsTotal === 0;
}

/**
 * Everything waiting on the owner, oldest first: tickets in 待验收 (any day)
 * and WorkItems escalated to the owner for review (#813) that are still
 * awaiting it.
 *
 * @param requests - Every Request
 * @param workItems - Every WorkItem
 * @param ticketTeam - Team that did a ticket
 * @param teamName - Team of a session
 * @returns The waiting list
 */
function collectWaiting(
  requests: readonly Request[],
  workItems: readonly WorkItem[],
  ticketTeam: (t: Request) => string,
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
      team: ticketTeam(r),
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
