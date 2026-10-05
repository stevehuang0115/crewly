/**
 * Open items — Crewly tracks what agents promise and ask the owner in their
 * replies, so nothing is silently dropped (specs/2026-10-01-reply-open-items.md).
 *
 * Incident (TKT-185, 2026-10-01): in #book-publish Atlas told the owner "Kai is
 * going through the four episodes… 明天中午给我，我核过以后挑最有用的几条发你"
 * and asked "第 13 章「互评当体检用」这个读法，你同意吗？". The ticket was already
 * closed. Kai finished at 18:14 and Atlas verified it, but nobody delivered
 * it and Atlas went idle; the question was never tracked.
 *
 * Now, for every agent message in a ticket's conversation:
 *
 * - **Extract** commitments and owner questions (rules, {@link extractOpenItems}).
 * - **Hold the ticket open**: items live on `Request.openItems`; while one is
 *   active the ticket is `awaiting_followup` (RequestService gates `done`).
 * - **Commitments**: a follow-up WorkItem for the agent, due at the parsed
 *   time; the delegated child work is linked; when that work is finished
 *   before the agent delivers, the agent is woken at once ("the work you
 *   promised the owner is ready — deliver it now"); past the due time the
 *   agent is nudged once, then the owner is told in the thread what is late
 *   and why; the agent's next post in the thread once the work is ready
 *   marks it delivered.
 * - **Questions**: a decision card in the same thread, asked as the agent,
 *   with options and a default derived from its words ({@link deriveQuestionCard});
 *   answers reach the agent through the decision flow. No second card when
 *   the agent already asked the same thing with ask-owner.
 *
 * Collaborators are injected ({@link OpenItemsDeps}); `open-items.wiring.ts`
 * connects the real ones.
 *
 * @module services/open-items/open-items.service
 */

import { OPEN_ITEMS_CONSTANTS, ORCHESTRATOR_SESSION_NAME, REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import { isInterim } from '../slack/slack-typing-placeholder.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { ACTIVE_OPEN_ITEM_STATUSES, type RequestOpenItem } from '../../types/v2/open-item.types.js';
import type { DecisionSource, OwnerDecision } from '../../types/decision.types.js';
import { formatTicketNumber } from '../../types/v2/ticket.types.js';
import { extractOpenItems, parseDue, type ExtractedQuestion } from './open-item-extractor.js';
import { deriveEitherOrCard, deriveQuestionCard, groupEitherOr, questionContextBlocks, questionSimilarity, type DerivedQuestionCard } from './open-item-card.js';
import { formatWhen } from '../decisions/decision-card.js';
import { AgentPromptReferenceService, type ReplyReference } from '../orc/agent-prompt-reference.service.js';
import { withQueueMeta } from '../messaging/queue-priority.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The chat-v2 message fields the service reads. */
export interface OpenItemsChatMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string;
  content: string;
  threadId?: string;
  /** Epoch ms (defaults to now) */
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

/** Where a request's conversation lives in Slack, when it does. */
export interface OpenItemsSlackPlace {
  slackChannelId: string;
  threadTs: string;
}

/** Input to create a commitment's follow-up WorkItem. */
export interface FollowUpInput {
  request: Request;
  item: RequestOpenItem;
  /** Slack thread of the conversation, when it has one */
  place: OpenItemsSlackPlace | null;
}

/** Input to card a question. */
export interface QuestionCardInput {
  request: Request;
  item: RequestOpenItem;
  card: DerivedQuestionCard;
  place: OpenItemsSlackPlace | null;
  /** `backfill` when the backfill cards an old reply */
  source?: DecisionSource;
}

/** Collaborators. */
export interface OpenItemsDeps {
  requests: {
    getById(id: string): Promise<Request | null>;
    listAll(): Promise<Request[]>;
    update(id: string, updates: Parameters<import('../v3/request.service.js').RequestService['update']>[1]): Promise<Request>;
  };
  /** Every WorkItem in the pool */
  listWorkItems: () => Promise<WorkItem[]>;
  /** Queue the follow-up WorkItem (held until delivered); returns its id */
  createFollowUp?: (input: FollowUpInput) => Promise<string | null>;
  /** Close the follow-up WorkItem: `delivered` → done, else cancelled */
  closeFollowUp?: (workItemId: string, outcome: 'delivered' | 'cancelled', reason: string) => Promise<void>;
  /** Decisions the agent asked recently (for the ask-owner dedupe) */
  recentDecisionsBy?: (agent: string, sinceMs: number) => Promise<OwnerDecision[]>;
  /** Post a card for a question; returns the decision */
  askQuestion?: (input: QuestionCardInput) => Promise<OwnerDecision | null>;
  /** Withdraw a question's card (the ticket was cancelled) */
  cancelQuestion?: (decisionId: string, note: string) => Promise<void>;
  /** A question the owner skipped in this request (not asked again for 30 days) */
  skippedQuestion?: (requestId: string, agent: string, question: string) => Promise<OwnerDecision | null>;
  /** Skip a question's card (the owner skipped the open item); false when it was not pending */
  skipQuestion?: (decisionId: string) => Promise<boolean>;
  /** A decision by id (sweep catches answers a missed handler call left behind) */
  getDecision?: (decisionId: string) => Promise<OwnerDecision | null>;
  /** Deliver a note to an agent, waking it; false when it could not */
  deliverToAgent: (session: string, text: string) => Promise<boolean>;
  /** Post a note for the owner in the request's conversation */
  postOwnerNote: (request: Request, text: string) => Promise<boolean>;
  /** Display name of an agent ("Atlas") */
  displayName?: (session: string) => Promise<string>;
  /** Names of the agent's colleagues (questions to them are not for the owner) */
  colleagueNames?: (session: string) => Promise<string[]>;
  /** The owner's Slack user id */
  ownerSlackUserId?: () => string | null;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** What one extraction would add (also the backfill's dry-run row). */
export interface PlannedOpenItem {
  item: RequestOpenItem;
  /** Question: the card it would post (absent when an ask-owner card already covers it) */
  card?: DerivedQuestionCard;
  /** Question: the ask-owner decision it is linked to instead of a new card */
  linkedDecisionId?: string;
  /** Question: the owner already skipped the same question here — tracked as skipped, never carded */
  skippedDecisionId?: string;
}

/** Thrown for open-item requests the caller must fix (HTTP 4xx). */
export class OpenItemsError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenItemsError';
  }
}

/** Statuses of a child WorkItem that count as finished work. */
const CHILD_DONE = new Set(['done', 'verified']);

/** Ticket statuses the service follows (`cancelled` closes items instead). */
const FOLLOWED = new Set(['open', 'ready', 'running', 'blocked', 'waiting_confirmation', 'awaiting_followup', 'done']);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The Slack thread of a request's conversation (`origin.threadRef` is
 * `slack:<channel>:<ts>`).
 *
 * @param request - Request
 * @returns Place, or null for chat-only conversations
 */
export function slackPlaceOf(request: Pick<Request, 'origin'>): OpenItemsSlackPlace | null {
  const ref = request.origin?.threadRef;
  if (typeof ref !== 'string') return null;
  const m = /^slack:([CDG][A-Z0-9]+):(\d{6,}\.\d+)$/.exec(ref);
  return m ? { slackChannelId: m[1], threadTs: m[2] } : null;
}

/**
 * Whether a message is in the request's conversation.
 *
 * @param request - Ticket with a chatRef
 * @param message - chat-v2 message
 * @returns True for its thread (or its root)
 */
export function inRequestThread(request: Pick<Request, 'chatRef'>, message: Pick<OpenItemsChatMessage, 'channelId' | 'threadId' | 'id'>): boolean {
  const ref = request.chatRef;
  if (!ref || ref.channelId !== message.channelId) return false;
  const root = message.threadId ?? message.id;
  return root === ref.threadRootId || root === ref.messageId;
}

/**
 * Whether a WorkItem is bookkeeping (verify / follow-up) rather than work.
 *
 * @param wi - WorkItem
 * @returns True to ignore it as child work
 */
function isBookkeeping(wi: WorkItem): boolean {
  const meta = (wi.metadata ?? {}) as Record<string, unknown>;
  return (
    wi.type === 'review' ||
    wi.id.includes(':verify:') ||
    typeof meta.verifyOf === 'string' ||
    meta[OPEN_ITEMS_CONSTANTS.FOLLOW_UP_METADATA_KEY] !== undefined
  );
}

/**
 * Whether a WorkItem was started for this request's conversation: linked to
 * the request, or (1.20.183 origin chain) carrying its thread as its origin.
 *
 * @param wi - WorkItem
 * @param request - Request
 * @returns True when it belongs to the request
 */
function belongsTo(wi: WorkItem, request: Request): boolean {
  if (wi.requestId === request.id || request.workItemIds.includes(wi.id)) return true;
  const origin = (wi.metadata as Record<string, unknown> | undefined)?.origin as Record<string, unknown> | undefined;
  if (!origin || origin.kind !== 'owner') return false;
  if (request.chatRef && origin.chatThreadId === request.chatRef.threadRootId) return true;
  const place = slackPlaceOf(request);
  return !!place && origin.slackChannelId === place.slackChannelId && origin.threadTs === place.threadTs;
}

/**
 * The delegated child work a commitment waits on: WorkItems of the request
 * given to someone else, started around the promise and not already finished
 * before it.
 *
 * @param request - Request
 * @param item - Commitment
 * @param pool - Every WorkItem
 * @returns Child WorkItem ids
 */
export function childWorkFor(request: Request, item: Pick<RequestOpenItem, 'agent' | 'createdAt'>, pool: readonly WorkItem[]): string[] {
  const at = Date.parse(item.createdAt);
  const from = at - OPEN_ITEMS_CONSTANTS.CHILD_LOOKBACK_MS;
  const to = at + OPEN_ITEMS_CONSTANTS.CHILD_LOOKAHEAD_MS;
  const out = new Set<string>();
  for (const wi of pool) {
    if (isBookkeeping(wi) || !belongsTo(wi, request)) continue;
    if (!wi.target || wi.target === item.agent) continue;
    if (wi.status === 'cancelled') continue;
    const created = Date.parse(wi.createdAt);
    if (!(created >= from && created <= to)) continue;
    const finished = wi.completedAt ? Date.parse(wi.completedAt) : NaN;
    if (CHILD_DONE.has(wi.status) && Number.isFinite(finished) && finished < at) continue;
    out.add(wi.id);
  }
  return [...out];
}

/**
 * Whether every child of a commitment is finished (cancelled ones ignored).
 *
 * @param ids - Child ids
 * @param pool - Every WorkItem
 * @returns `ready` with the latest finish time, or not ready (with what is left)
 */
export function childrenState(ids: readonly string[], pool: readonly WorkItem[]): { ready: boolean; finishedAt?: string; pending: WorkItem[]; done: WorkItem[] } {
  const byId = new Map(pool.map((w) => [w.id, w]));
  const pending: WorkItem[] = [];
  const done: WorkItem[] = [];
  let latest = 0;
  for (const id of ids) {
    const wi = byId.get(id);
    if (!wi || wi.status === 'cancelled') continue;
    if (CHILD_DONE.has(wi.status)) {
      done.push(wi);
      latest = Math.max(latest, Date.parse(wi.completedAt ?? '') || 0);
    } else {
      pending.push(wi);
    }
  }
  const ready = done.length > 0 && pending.length === 0;
  return { ready, ...(ready && latest > 0 ? { finishedAt: new Date(latest).toISOString() } : {}), pending, done };
}

/**
 * Whether two items are the same thing said once: same message, or the same
 * words by the same agent within {@link OPEN_ITEMS_CONSTANTS.DUPLICATE_WINDOW_MS}.
 *
 * @param a - Item
 * @param b - Item
 * @returns True for a duplicate
 */
export function isSameItem(a: Pick<RequestOpenItem, 'sourceMessageId' | 'text' | 'agent' | 'createdAt'>, b: Pick<RequestOpenItem, 'sourceMessageId' | 'text' | 'agent' | 'createdAt'>): boolean {
  if (a.text !== b.text) return false;
  if (a.sourceMessageId === b.sourceMessageId) return true;
  return a.agent === b.agent && Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) <= OPEN_ITEMS_CONSTANTS.DUPLICATE_WINDOW_MS;
}

/** Whether the owner's message agrees ("可以", "同意", "ok", "go ahead", 👍) and does not hold back. */
export function isApproval(text: string): boolean {
  const t = text.replace(/<@[A-Z0-9]+>/g, ' ').trim().toLowerCase();
  if (!t || t.length > 120) return false;
  if (/不(?:行|可以|同意|好|要|用|必)|别|先别|等等|再想想|\bno\b|don'?t|\bwait\b|\bhold\b|\bstop\b|不对/.test(t)) return false;
  return /^(?:ok|okay|yes|yep|yeah|sure|go|go ahead|approved?|lgtm|agreed?|👍|✅|可以|好的?|行|同意|没问题|批准|确认|通过|发吧|做吧|开始吧?|就这样|按你说的)/u.test(t) || /(?:可以|同意|没问题|go ahead|approved?)[。！!.\s]*$/u.test(t);
}

/**
 * Kinds of deliverable a promise can name; a post delivers such a promise
 * only with a link, an attachment, or the same kind of thing named.
 */
const DELIVERABLE_FAMILIES: ReadonlyArray<readonly string[]> = [
  ['预览', 'preview'],
  ['pdf'],
  ['链接', 'link', 'url'],
  ['报告', 'report'],
  ['结论', 'conclusion', 'finding'],
  ['文章', 'article', '稿', 'draft'],
  ['名单', 'list'],
  ['截图', 'screenshot', 'image'],
  ['文件', 'file', '附件', 'attachment', '表格', 'sheet'],
];

/** A post that only acknowledges or reports progress — not a delivery. */
const NOT_A_DELIVERY = /^\s*(?:(?:收到|好的?|ok(?:ay)?|got it|on it|嗯+|明白)[\s，,。.!！~]*$|(?:在做|正在|还在|马上|稍等|working on|still working|in progress))/i;

/**
 * Whether a post plausibly fulfils a promise (specs/2026-10-02-harness-owned-routing.md §5):
 * the harness marked it as the ticket's delivery; or, for a promise of a
 * deliverable (preview, PDF, link, report, file…), it carries a link, an
 * attachment or names the same kind of thing; or, for a plain promise, it
 * is a substantive post — not an ack, a progress line, or only a question.
 *
 * @param promise - The commitment's words
 * @param message - The post
 * @returns True when it can be the delivery
 */
export function plausiblyFulfils(promise: string, message: Pick<OpenItemsChatMessage, 'content' | 'metadata'>): boolean {
  const meta = message.metadata ?? {};
  if (meta[REPLY_ROUTING_CONSTANTS.DELIVERS_TICKET_METADATA_KEY]) return true;
  const text = (message.content ?? '').trim();
  if (!text) return false;
  const hasLink = /https?:\/\/\S+/i.test(text) || /<https?:[^>]+>/i.test(text);
  const hasAttachment =
    (Array.isArray(meta.attachments) && meta.attachments.length > 0) ||
    (Array.isArray(meta.files) && meta.files.length > 0) ||
    /\[file uploaded:/i.test(text);
  const p = promise.toLowerCase();
  const t = text.toLowerCase();
  const families = DELIVERABLE_FAMILIES.filter((f) => f.some((w) => p.includes(w)));
  if (families.length > 0) {
    return hasLink || hasAttachment || families.some((f) => f.some((w) => t.includes(w)));
  }
  if (hasLink || hasAttachment) return true;
  if (NOT_A_DELIVERY.test(text)) return false;
  // Only a question back ("where should I send it?") is not the delivery.
  const sentences = text.split(/[。.!！\n]+/).map((x) => x.trim()).filter(Boolean);
  if (sentences.length > 0 && sentences.every((x) => /[?？]$/.test(x))) return false;
  return text.length >= OPEN_ITEMS_CONSTANTS.MIN_DELIVERY_CHARS;
}

/** Named people / tools a promise mentions (Nova, Vera, CDC…). */
function namesIn(s: string): Set<string> {
  return new Set((s.match(/\b[A-Z][A-Za-z]{2,}\b/g) ?? []).map((n) => n.toLowerCase()));
}

const DELIVERABLE_NOUNS = ['预览', 'preview', 'pdf', '报告', '结论', '文章', '稿', '名单', 'report', 'draft'];

/**
 * Whether two commitments are the same promise: the same words, or — from the
 * same agent within {@link OPEN_ITEMS_CONSTANTS.PROMISE_DUPLICATE_WINDOW_MS} —
 * very similar words, or the same deliverable (same person named and the same
 * kind of thing handed over).
 *
 * @param a - One item
 * @param b - The other
 * @returns True for one promise said twice
 */
export function isSamePromise(a: RequestOpenItem, b: RequestOpenItem): boolean {
  if (a.type !== 'commitment' || b.type !== 'commitment') return false;
  if (isSameItem(a, b)) return true;
  if (a.agent !== b.agent || Math.abs(Date.parse(a.createdAt) - Date.parse(b.createdAt)) > OPEN_ITEMS_CONSTANTS.PROMISE_DUPLICATE_WINDOW_MS) return false;
  if (questionSimilarity(a.text, b.text) >= OPEN_ITEMS_CONSTANTS.SAME_QUESTION_SIMILARITY) return true;
  const na = namesIn(a.text);
  const shared = [...namesIn(b.text)].some((n) => na.has(n));
  const la = a.text.toLowerCase();
  const lb = b.text.toLowerCase();
  return shared && DELIVERABLE_NOUNS.some((w) => la.includes(w) && lb.includes(w));
}

/**
 * Clip for a one-line mention.
 *
 * @param s - Text
 * @param max - Max characters
 * @returns Clipped
 */
function short(s: string, max = 120): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The reference a follow-up prompt names (specs/2026-10-02-harness-owned-routing.md §4).
 *
 * @param request - Request
 * @param item - Commitment
 * @returns The ticket (and follow-up work item) the agent answers about
 */
export function followUpReference(request: Request, item: Pick<RequestOpenItem, 'workItemId'>): ReplyReference {
  return {
    ...(typeof request.ticketNumber === 'number' ? { ticket: formatTicketNumber(request.ticketNumber) } : {}),
    ...(item.workItemId ? { workItemId: item.workItemId } : {}),
  };
}

/**
 * The exact command a follow-up prompt tells the agent to run — a reference,
 * never a raw thread key (the harness finds the thread).
 *
 * @param ref - Follow-up reference
 * @returns Command text
 */
export function followUpCommand(ref: ReplyReference): string {
  if (ref.ticket) return `reply --ticket ${ref.ticket} "<your message>"`;
  if (ref.workItemId) return `reply --work-item ${ref.workItemId} "<your message>"`;
  return 'reply "<your message>"';
}

/**
 * The ticket's display id.
 *
 * @param request - Request
 * @returns `TKT-185`, else the id prefix
 */
function ticketLabel(request: Request): string {
  return typeof request.ticketNumber === 'number' ? formatTicketNumber(request.ticketNumber) : request.id.slice(0, 8);
}

/** An owner promise still owed, as the restart path needs it. */
export interface OwedCommitment {
  /** Agent that promised */
  sessionName: string;
  /** Ticket label (TKT-194), when the request has one */
  ticket?: string;
  /** The promise */
  text: string;
  /** Request holding it */
  requestId: string;
  /** The open item */
  itemId: string;
  /** When it was due (ISO) */
  due?: string;
}

/**
 * Promises a restart should act on: past due, never nudged and never
 * reminded after a restart, on requests that are not done or cancelled
 * (specs/2026-10-02-restart-busy-and-resume.md). Not-yet-due promises are left
 * alone (the sweep acts when they come due), and nudged / overdue ones belong
 * to the sweep, so a restart never adds a second nudge.
 *
 * @param requests - Every request
 * @param now - Clock
 * @returns One entry per such commitment
 */
export function owedCommitments(requests: readonly Request[], now: Date = new Date()): OwedCommitment[] {
  const out: OwedCommitment[] = [];
  for (const r of requests) {
    if (r.status === 'done' || r.status === 'cancelled') continue;
    for (const i of r.openItems ?? []) {
      if (i.type !== 'commitment' || (i.status !== 'open' && i.status !== 'ready')) continue;
      if (!i.agent || i.nudgedAt || i.restartRemindedAt) continue;
      const due = i.due ? Date.parse(i.due) : NaN;
      if (!Number.isFinite(due) || due > now.getTime()) continue;
      out.push({
        sessionName: i.agent,
        ...(typeof r.ticketNumber === 'number' ? { ticket: formatTicketNumber(r.ticketNumber) } : {}),
        text: i.text,
        requestId: r.id,
        itemId: i.id,
        ...(i.due ? { due: i.due } : {}),
      });
    }
  }
  return out;
}

/**
 * Record that a restart reminder was sent for a commitment. It counts as the
 * one nudge: the sweep then moves on to the owner note, never nudging again.
 * Re-reads the request first; returns false when the sweep nudged it already.
 *
 * @param requests - Request store
 * @param requestId - Request
 * @param itemId - Commitment
 * @param at - When the reminder goes out
 * @returns True when the reminder should be (and is now recorded as) sent
 */
export async function markRestartReminded(
  requests: Pick<OpenItemsDeps['requests'], 'getById' | 'update'>,
  requestId: string,
  itemId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const r = await requests.getById(requestId);
  const item = r?.openItems?.find((i) => i.id === itemId);
  if (!r || !item || item.nudgedAt || item.restartRemindedAt || (item.status !== 'open' && item.status !== 'ready')) return false;
  const iso = at.toISOString();
  await requests.update(requestId, {
    openItems: (r.openItems ?? []).map((i) => (i.id === itemId ? { ...i, status: 'overdue' as const, nudgedAt: iso, restartRemindedAt: iso } : i)),
  });
  return true;
}

/** Deliverables an interim promise must name (a doc, a plan, a link…), not just "I'll get back to you". */
const INTERIM_DELIVERABLE =
  /方案|文档|文件|报告|结论|清单|名单|预览|截图|表格|稿|文章|代码|数据|计划|设计|总结|分析|链接|附件|pdf|\bdoc(?:ument)?s?\b|\bplan\b|\breport\b|\bdraft\b|\blink\b|\bfile\b|\bsheet\b|spreadsheet|\blist\b|screenshot|preview|proposal|summary|write-?up|\bPR\b|pull request|numbers|figures/iu;

/** "I'll report back / get back to you" — status, not a deliverable. */
const REPORT_BACK =
  /report(?:ing)? back|get(?:ting)? back to (?:you|u)|circle back|follow(?:ing)? up|update you|keep you (?:posted|updated)|let you know|回复(?:你|您)|回(?:你|您)(?:一?[句声下])?|答复|告诉(?:你|您)|汇报|同步给(?:你|您)|跟(?:你|您)说|反馈/giu;

/**
 * Whether a commitment from an interim note is worth tracking: an explicit
 * time and a concrete deliverable. "On it, I'll report back" and "稍后回复你"
 * are not: they could never be delivered (PR #1013 review).
 *
 * @param item - The planned commitment
 * @returns True to track it
 */
export function isConcreteInterimPromise(item: Pick<RequestOpenItem, 'text' | 'dueSource'>): boolean {
  if (item.dueSource !== 'text') return false;
  const withoutReportBack = item.text.replace(REPORT_BACK, ' ');
  return INTERIM_DELIVERABLE.test(withoutReportBack);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Tracks commitments and questions on Requests. See module docs.
 */
export class OpenItemsService {
  private static instance: OpenItemsService | null = null;
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: OpenItemsDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('OpenItems');
    this.now = deps.now ?? (() => new Date());
  }

  /** @returns The process-wide instance, or null before wiring */
  static getInstance(): OpenItemsService | null {
    return OpenItemsService.instance;
  }

  /** @param service - Instance to install (null clears) */
  static setInstance(service: OpenItemsService | null): void {
    OpenItemsService.instance = service;
  }

  /** Start the periodic sweep. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => this.logger.warn('Open-items sweep failed', { error: errText(err) }));
    }, OPEN_ITEMS_CONSTANTS.SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stop the sweep. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One change at a time (a chat message, a WorkItem event and the sweep may
   * touch the same request).
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * {@link markRestartReminded}, serialized with every other change to the
   * same requests (the sweep may be nudging the same promise).
   *
   * @param requestId - Request
   * @param itemId - Commitment
   * @returns True when the reminder should be (and is now recorded as) sent
   */
  markRestartReminded(requestId: string, itemId: string): Promise<boolean> {
    return this.serial(() => markRestartReminded(this.deps.requests, requestId, itemId, this.now()));
  }

  // -------------------------------------------------------------------------
  // Agent replies
  // -------------------------------------------------------------------------

  /**
   * The ticket an agent message belongs to: the one whose thread it is in
   * (any status but cancelled, closed within the lookback), else — for a
   * top-level message — the newest open ticket in that channel the agent is
   * answering.
   *
   * @param message - chat-v2 message
   * @param all - Every request
   * @returns The request, or null
   */
  findRequestFor(message: OpenItemsChatMessage, all: readonly Request[]): Request | null {
    const since = this.now().getTime() - OPEN_ITEMS_CONSTANTS.LOOKBACK_MS;
    const at = message.createdAt ?? this.now().getTime();
    const tickets = all
      .filter((r) => typeof r.ticketNumber === 'number' && !!r.chatRef && FOLLOWED.has(r.status) && Date.parse(r.updatedAt) >= since)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    // Several tickets can share one thread (follow-up asks): the message
    // belongs to the newest one opened before it — the open one first.
    const sharing = tickets.filter((r) => inRequestThread(r, message));
    const openedBefore = sharing.filter((r) => Date.parse(r.createdAt) <= at);
    const inThread = openedBefore.length > 0 ? openedBefore : sharing;
    if (inThread.length > 0) return inThread.find((r) => r.status !== 'done') ?? inThread[0];
    if (message.threadId) return null;
    return (
      tickets.find(
        (r) =>
          r.chatRef?.channelId === message.channelId &&
          r.status !== 'done' &&
          (r.assignee === message.senderId || r.reply?.by === message.senderId),
      ) ?? null
    );
  }

  /**
   * An agent posted in chat-v2: mark what it delivered, and track what it
   * newly promised or asked.
   *
   * @param message - The message
   * @returns The request it changed, or null
   */
  async onAgentMessage(message: OpenItemsChatMessage): Promise<Request | null> {
    if (message.senderType === 'user') return this.onOwnerMessage(message);
    if (message.senderType !== 'agent' || !message.content?.trim()) return null;
    // An interim note ("got it — here is my plan, the doc in ~30 min") is not
    // the reply and delivers nothing (deliveredBy refuses it), but it is
    // exactly where agents promise things: read it for commitments only.
    // Skipping it entirely lost Eve's promise on TKT-194 (2026-10-02).
    const interim = isInterim(message);
    return this.serial(async () => {
      const all = await this.deps.requests.listAll();
      const request = this.findRequestFor(message, all);
      if (!request) return null;
      const at = new Date(message.createdAt ?? this.now().getTime());
      const pool = await this.deps.listWorkItems().catch(() => [] as WorkItem[]);
      // From an interim note: only timed promises of a concrete deliverable.
      const planned = (await this.plan(request, message, at))
        .filter((p) => !interim || (p.item.type === 'commitment' && isConcreteInterimPromise(p.item)))
        .map((p) => (interim ? { ...p, item: { ...p.item, fromInterim: true } } : p));
      let items = [...(request.openItems ?? [])];
      let changed = false;

      // Deliveries first: this post may be what an earlier promise was waiting for.
      const delivered = this.deliveries(items, message, at, pool);
      for (const d of delivered) {
        items = items.map((i) => (i.id === d.id ? d : i));
        changed = true;
        if (d.workItemId) await this.closeFollowUp(d.workItemId, 'delivered', `Delivered to the owner (message ${message.id})`);
        this.logger.info('Commitment delivered', { tkt: ticketLabel(request), item: d.id, by: message.senderId });
      }

      // The same words twice (a reply recorded both from the reply path and the
      // Slack mirror) are one item.
      // A post that delivers something restates it ("结论在下面：…"): the words are
      // the delivery, not a new promise.
      const restated = (p: PlannedOpenItem): boolean =>
        p.item.type === 'commitment' &&
        delivered.some((d) => questionSimilarity(d.text, p.item.text) >= OPEN_ITEMS_CONSTANTS.SAME_QUESTION_SIMILARITY);
      const fresh = planned.filter((p) => !items.some((i) => isSameItem(i, p.item)) && !restated(p));
      for (const p of fresh) {
        // The same promise said again (a plan, then "收到，按刚才说的做"): the newest one stands.
        for (let k = 0; k < items.length; k++) {
          if (isSamePromise(items[k], p.item) && ACTIVE_OPEN_ITEM_STATUSES.has(items[k].status)) {
            if (items[k].workItemId) await this.closeFollowUp(items[k].workItemId!, 'cancelled', `Superseded by a newer promise (${p.item.id})`);
            items[k] = { ...items[k], status: 'superseded', closedAt: at.toISOString(), closedReason: `said again in message ${message.id}` };
          }
        }
        const item = await this.activate(request, p, pool);
        items.push(item);
        changed = true;
      }
      if (!changed) return null;
      return this.save(request, items, fresh.length > 0);
    });
  }

  /**
   * The owner posted in a ticket's thread: a yes opens the conditional
   * promises that wait on them.
   *
   * @param message - The owner's message
   * @returns The request it changed, or null
   */
  async onOwnerMessage(message: OpenItemsChatMessage): Promise<Request | null> {
    if (!message.content?.trim() || !isApproval(message.content)) return null;
    return this.serial(async () => {
      const all = await this.deps.requests.listAll();
      const request = all.find((r) => r.status !== 'cancelled' && inRequestThread(r, message) && (r.openItems ?? []).some((i) => i.status === 'waiting_owner'));
      if (!request) return null;
      const at = new Date(message.createdAt ?? this.now().getTime());
      return this.openWaiting(request, at, `the owner said yes in the thread (message ${message.id})`, () => true);
    });
  }

  /**
   * Open waiting promises: their due time is counted from `at`, and the
   * follow-up WorkItem is created now.
   *
   * @param request - Request
   * @param at - When the owner agreed
   * @param why - For the log
   * @param pick - Which waiting items
   * @returns The updated request, or null when none matched
   */
  private async openWaiting(request: Request, at: Date, why: string, pick: (i: RequestOpenItem) => boolean): Promise<Request | null> {
    const pool = await this.deps.listWorkItems().catch(() => [] as WorkItem[]);
    const items: RequestOpenItem[] = [];
    let changed = false;
    for (const i of request.openItems ?? []) {
      if (i.status !== 'waiting_owner' || !pick(i)) {
        items.push(i);
        continue;
      }
      const { due, source } = parseDue(i.text, at);
      const opened = await this.activate(request, { item: { ...i, status: 'open', due: due.toISOString(), dueSource: source } }, pool);
      this.logger.info('Conditional promise opened', { tkt: ticketLabel(request), item: i.id, due: opened.due, why });
      items.push(opened);
      changed = true;
    }
    return changed ? this.save(request, items, false) : null;
  }

  /**
   * What a message would add, without side effects (also the backfill's view).
   *
   * @param request - Its request
   * @param message - The agent message
   * @param at - When it was posted
   * @returns Planned items
   */
  async plan(request: Request, message: OpenItemsChatMessage, at: Date): Promise<PlannedOpenItem[]> {
    const names = await this.deps.colleagueNames?.(message.senderId).catch(() => [] as string[]);
    const owner = this.deps.ownerSlackUserId?.() ?? (request.origin?.author?.startsWith('U') ? request.origin.author : null);
    const found = extractOpenItems(message.content, {
      now: at,
      ...(names ? { colleagueNames: names } : {}),
      ...(owner ? { ownerSlackUserId: owner } : {}),
    });
    const base = (type: RequestOpenItem['type'], n: number): Pick<RequestOpenItem, 'id' | 'agent' | 'sourceMessageId' | 'createdAt' | 'status'> => ({
      id: `${type === 'commitment' ? 'c' : 'q'}-${message.id.slice(0, 8)}-${n}`,
      agent: message.senderId,
      sourceMessageId: message.id,
      createdAt: at.toISOString(),
      status: 'open',
    });
    const out: PlannedOpenItem[] = [];
    for (const [i, c] of found.commitments.entries()) {
      if (c.waitsOnOwner) {
        // Conditional on the owner: no due time, no follow-up, no nudges until they say yes.
        const gate = await this.recentDecision(message.senderId, at);
        out.push({ item: { ...base('commitment', i + 1), type: 'commitment', text: c.text, status: 'waiting_owner', ...(gate ? { gateDecisionId: gate.id } : {}) } });
        continue;
      }
      out.push({ item: { ...base('commitment', i + 1), type: 'commitment', text: c.text, due: c.due.toISOString(), dueSource: c.dueSource } });
    }
    let qi = 0;
    for (const group of groupEitherOr(found.questions)) {
      const q = group[0];
      qi += 1;
      const item: RequestOpenItem = { ...base('question', qi), type: 'question', text: q.text };
      const skipped = await this.deps.skippedQuestion?.(request.id, message.senderId, q.text).catch(() => null);
      if (skipped) {
        out.push({ item, skippedDecisionId: skipped.id });
        continue;
      }
      const asked = await this.alreadyAsked(message.senderId, q, at);
      if (asked) {
        out.push({ item, linkedDecisionId: asked.id });
        continue;
      }
      // A question that points back ("这样安排行不行？") carries what it points at.
      const context = questionContextBlocks({ content: message.content, question: q.text, ownerAsk: request.description || request.title });
      // Consecutive either/or questions are ONE card, one button per alternative.
      const derived = group.length > 1 ? deriveEitherOrCard(group) : deriveQuestionCard(q);
      out.push({ item, card: { ...derived, ...(context ? { context } : {}) } });
    }
    return out;
  }

  /**
   * The newest ask-owner decision this agent made shortly before `at` (the card a conditional promise waits on).
   *
   * @param agent - Agent
   * @param at - When the promise was made
   * @returns The decision, or null
   */
  private async recentDecision(agent: string, at: Date): Promise<OwnerDecision | null> {
    if (!this.deps.recentDecisionsBy) return null;
    const win = OPEN_ITEMS_CONSTANTS.ASK_OWNER_DEDUPE_WINDOW_MS;
    const recent = await this.deps.recentDecisionsBy(agent, at.getTime() - win).catch(() => [] as OwnerDecision[]);
    return recent.filter((d) => d.kind !== 'reply_question' && Date.parse(d.createdAt) <= at.getTime() + 60_000).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  }

  /**
   * The ask-owner decision the agent already made for this question, if any.
   *
   * @param agent - Asking agent
   * @param q - The question
   * @param at - When it was asked in the reply
   * @returns The decision, or null
   */
  private async alreadyAsked(agent: string, q: ExtractedQuestion, at: Date): Promise<OwnerDecision | null> {
    if (!this.deps.recentDecisionsBy) return null;
    const win = OPEN_ITEMS_CONSTANTS.ASK_OWNER_DEDUPE_WINDOW_MS;
    const recent = await this.deps.recentDecisionsBy(agent, at.getTime() - win).catch(() => [] as OwnerDecision[]);
    return (
      recent.find(
        (d) =>
          d.kind !== 'reply_question' &&
          Math.abs(Date.parse(d.createdAt) - at.getTime()) <= win &&
          questionSimilarity(d.question, q.text) >= OPEN_ITEMS_CONSTANTS.SAME_QUESTION_SIMILARITY,
      ) ?? null
    );
  }

  /**
   * Turn a planned item into a tracked one: link child work and queue the
   * follow-up (commitment), or post / link the card (question).
   *
   * @param request - Its request
   * @param p - Planned item
   * @param pool - Every WorkItem
   * @returns The stored item
   */
  private async activate(request: Request, p: PlannedOpenItem, pool: readonly WorkItem[], source: DecisionSource = 'live'): Promise<RequestOpenItem> {
    const place = slackPlaceOf(request);
    let item = { ...p.item };
    if (p.skippedDecisionId) {
      this.logger.info('Question the owner already skipped — not asked again', { tkt: ticketLabel(request), decisionId: p.skippedDecisionId });
      return { ...item, status: 'skipped', decisionId: p.skippedDecisionId, closedAt: this.now().toISOString(), closedReason: `owner skipped this before (${p.skippedDecisionId})` };
    }
    if (item.type === 'commitment' && item.status === 'waiting_owner') {
      this.logger.info('Conditional promise — waiting on the owner', { tkt: ticketLabel(request), item: item.id, agent: item.agent, gate: item.gateDecisionId });
      return item;
    }
    if (item.type === 'commitment') {
      const children = childWorkFor(request, item, pool);
      if (children.length > 0) item.childWorkItemIds = children;
      const wiId = await this.deps.createFollowUp?.({ request, item, place }).catch((err) => {
        this.logger.warn('Follow-up WorkItem not created', { tkt: ticketLabel(request), error: errText(err) });
        return null;
      });
      if (wiId) item.workItemId = wiId;
      this.logger.info('Commitment tracked', { tkt: ticketLabel(request), item: item.id, agent: item.agent, due: item.due, children: children.length });
      // The child work may already be finished (the promise came late).
      const state = childrenState(item.childWorkItemIds ?? [], pool);
      if (state.ready) item = await this.markReady(request, item, state.finishedAt, state.done);
      return item;
    }
    if (p.linkedDecisionId) {
      item.decisionId = p.linkedDecisionId;
      this.logger.info('Question already asked with ask-owner — no second card', { tkt: ticketLabel(request), decisionId: p.linkedDecisionId });
      return item;
    }
    if (p.card && this.deps.askQuestion) {
      const d = await this.deps.askQuestion({ request, item, card: p.card, place, source }).catch((err) => {
        this.logger.warn('Question card not posted', { tkt: ticketLabel(request), error: errText(err) });
        return null;
      });
      if (d) item.decisionId = d.id;
    }
    this.logger.info('Question tracked', { tkt: ticketLabel(request), item: item.id, agent: item.agent, decisionId: item.decisionId });
    return item;
  }

  /**
   * Commitments this message delivers.
   *
   * @param items - Current items
   * @param message - The post
   * @param at - Its time
   * @param pool - Every WorkItem
   * @returns Updated (delivered) items
   */
  private deliveries(items: RequestOpenItem[], message: OpenItemsChatMessage, at: Date, pool: readonly WorkItem[]): RequestOpenItem[] {
    const out: RequestOpenItem[] = [];
    for (const item of items) {
      if (item.type !== 'commitment' || !ACTIVE_OPEN_ITEM_STATUSES.has(item.status) || item.status === 'waiting_owner') continue;
      if (!this.deliveredBy(item, { ...message, createdAt: at.getTime() }, pool)) continue;
      out.push({ ...item, status: 'delivered', closedAt: at.toISOString(), closedReason: `posted in the thread (message ${message.id})` });
    }
    return out;
  }

  /**
   * Whether a post in the thread delivers a commitment: by the promising
   * agent (or one doing the child work), once the child work is finished.
   * With no child work: a later post by the promising agent, at least
   * {@link OPEN_ITEMS_CONSTANTS.MIN_DELIVERY_GAP_MS} after the promise, that
   * does not itself promise something new.
   *
   * @param item - Commitment
   * @param message - The post (`createdAt` set)
   * @param pool - Every WorkItem
   * @returns True when it is the delivery
   */
  deliveredBy(item: RequestOpenItem, message: OpenItemsChatMessage, pool: readonly WorkItem[]): boolean {
    if (item.type !== 'commitment' || item.sourceMessageId === message.id) return false;
    if (message.senderType !== 'agent' || isInterim(message)) return false;
    const at = message.createdAt ?? this.now().getTime();
    if (at <= Date.parse(item.createdAt)) return false;
    const children = item.childWorkItemIds ?? [];
    if (children.length > 0) {
      const childTargets = new Set(pool.filter((w) => children.includes(w.id)).map((w) => w.target));
      if (message.senderId !== item.agent && !childTargets.has(message.senderId)) return false;
      const state = childrenState(children, pool);
      if (!state.ready) return false;
      // Posted after the work was finished. A verify pass can stamp the child's
      // completedAt after the agent has posted, so allow a grace before it.
      const postedBefore = state.finishedAt ? Date.parse(state.finishedAt) - at : 0;
      if (postedBefore > OPEN_ITEMS_CONSTANTS.DELIVERY_FINISH_GRACE_MS) return false;
      // Only a post that plausibly IS the promised thing (spec 2026-10-02 §5).
      if (!plausiblyFulfils(item.text, message)) return false;
      // A post that makes a new promise is not the delivery.
      return postedBefore <= 0 || !this.promisesAnew(item, message, at);
    }
    if (message.senderId !== item.agent) return false;
    // A promise from an interim note ("the doc in ~30 min") is delivered by the
    // agent's next substantive real reply in the thread, however soon.
    if (item.fromInterim) return plausiblyFulfils('', message);
    if (at - Date.parse(item.createdAt) < OPEN_ITEMS_CONSTANTS.MIN_DELIVERY_GAP_MS) return false;
    if (!plausiblyFulfils(item.text, message)) return false;
    return !this.promisesAnew(item, message, at);
  }

  /**
   * Whether a post makes a NEW promise: restating the one it delivers does not count.
   *
   * @param item - The commitment being delivered
   * @param message - The post
   * @param at - Its time (epoch ms)
   * @returns True when it promises something else
   */
  private promisesAnew(item: RequestOpenItem, message: OpenItemsChatMessage, at: number): boolean {
    return extractOpenItems(message.content, { now: new Date(at) }).commitments.some(
      (c) => questionSimilarity(c.text, item.text) < OPEN_ITEMS_CONSTANTS.SAME_QUESTION_SIMILARITY,
    );
  }

  /**
   * The agent that owns a follow-up WorkItem closes it as already delivered:
   * the open item is closed and the WorkItem finished (no done_by_worker step).
   *
   * @param workItemId - The follow-up WorkItem
   * @param agent - The session closing it (must be the promising agent)
   * @param summary - What the agent says (where it was delivered)
   * @returns True when an active item of that agent was closed
   */
  async closeByAgent(workItemId: string, agent: string, summary: string): Promise<boolean> {
    return this.serial(async () => {
      const all = await this.deps.requests.listAll();
      const request = all.find((r) => (r.openItems ?? []).some((i) => i.workItemId === workItemId));
      if (!request) return false;
      const target = (request.openItems ?? []).find((i) => i.workItemId === workItemId);
      if (!target || target.agent !== agent || !ACTIVE_OPEN_ITEM_STATUSES.has(target.status)) return false;
      const at = this.now().toISOString();
      const items = (request.openItems ?? []).map((i) =>
        i.id === target.id ? { ...i, status: 'delivered' as const, closedAt: at, closedReason: `closed by ${agent}: ${short(summary, 200)}` } : i,
      );
      await this.deps.closeFollowUp?.(workItemId, 'delivered', `Closed by ${agent}`);
      await this.save(request, items, false);
      return true;
    });
  }

  /**
   * Take planned items onto a request (the backfill's apply step).
   *
   * @param requestId - Request
   * @param planned - Items from {@link plan}
   * @param opts - `source: 'backfill'` marks the cards it posts as backfilled; `caller` is
   *   the session of whoever asked for it (logged: who ran an apply)
   * @returns Updated request, or null when it is gone
   */
  async adopt(requestId: string, planned: PlannedOpenItem[], opts: { source?: DecisionSource; caller?: string } = {}): Promise<Request | null> {
    return this.serial(async () => {
      this.logger.info('Open items adopted (backfill apply)', { requestId, count: planned.length, caller: opts.caller ?? 'unknown', source: opts.source ?? 'live' });
      const request = await this.deps.requests.getById(requestId);
      if (!request) return null;
      const pool = await this.deps.listWorkItems().catch(() => [] as WorkItem[]);
      const items = [...(request.openItems ?? [])];
      for (const p of planned) {
        if (items.some((i) => i.id === p.item.id)) continue;
        items.push(await this.activate(request, p, pool, opts.source ?? 'live'));
      }
      return this.save(request, items, true);
    });
  }

  /**
   * Store items, and move the request between `done` and `awaiting_followup`.
   *
   * @param request - Request as read
   * @param items - New item list
   * @param added - New active items were added
   * @returns Updated request
   */
  private async save(request: Request, items: RequestOpenItem[], added: boolean): Promise<Request> {
    const active = items.some((i) => ACTIVE_OPEN_ITEM_STATUSES.has(i.status));
    if (active && request.status === 'done' && added) {
      this.logger.info('Closed ticket reopened: its agent left open items in the thread', { tkt: ticketLabel(request) });
      return this.deps.requests.update(request.id, { openItems: items, status: 'awaiting_followup', reopenForFollowup: true });
    }
    if (!active && request.status === 'awaiting_followup') {
      this.logger.info('Every open item closed — ticket done', { tkt: ticketLabel(request) });
      return this.deps.requests.update(request.id, { openItems: items, status: 'done', accepted: true, ignoreDeadChildren: true });
    }
    return this.deps.requests.update(request.id, { openItems: items });
  }

  // -------------------------------------------------------------------------
  // Child work
  // -------------------------------------------------------------------------

  /**
   * A WorkItem finished (task:done / task:verified): wake whoever promised
   * the owner the result, if that was the last piece.
   *
   * @param workItemId - The WorkItem
   * @returns Items that became ready
   */
  async onWorkItemSettled(workItemId: string): Promise<RequestOpenItem[]> {
    return this.serial(async () => {
      const woken: RequestOpenItem[] = [];
      const all = await this.deps.requests.listAll();
      const affected = all.filter((r) => (r.openItems ?? []).some((i) => i.type === 'commitment' && i.status === 'open' && (i.childWorkItemIds ?? []).includes(workItemId)));
      if (affected.length === 0) return woken;
      const pool = await this.deps.listWorkItems();
      for (const request of affected) {
        let changed = false;
        const items: RequestOpenItem[] = [];
        for (const item of request.openItems ?? []) {
          if (item.type === 'commitment' && item.status === 'open' && (item.childWorkItemIds ?? []).includes(workItemId)) {
            const state = childrenState(item.childWorkItemIds ?? [], pool);
            if (state.ready) {
              const ready = await this.markReady(request, item, state.finishedAt, state.done);
              items.push(ready);
              woken.push(ready);
              changed = true;
              continue;
            }
          }
          items.push(item);
        }
        if (changed) await this.deps.requests.update(request.id, { openItems: items });
      }
      return woken;
    });
  }

  /**
   * Deliver a follow-up reminder about a ticket's promise. If the agent is
   * busy and it waits on the queue, a newer reminder for the same ticket
   * replaces it there (2026-10-05: several TKT-270 "promised work is ready"
   * reminders sat ahead of the owner's answer).
   *
   * @param request - The ticket's request
   * @param agent - The agent
   * @param text - The reminder
   * @returns Whether it was accepted
   */
  private remindAgent(request: Request, agent: string, text: string): Promise<boolean> {
    return withQueueMeta(agent, text, { supersedeKey: `followup:${request.id}` }, () =>
      this.deps.deliverToAgent(agent, text).catch(() => false),
    );
  }

  /**
   * The child work is finished: wake the agent to deliver.
   *
   * @param request - Request
   * @param item - Commitment
   * @param finishedAt - When the last child finished
   * @param done - Finished children
   * @returns Updated item (`ready`)
   */
  private async markReady(request: Request, item: RequestOpenItem, finishedAt: string | undefined, done: WorkItem[]): Promise<RequestOpenItem> {
    const now = this.now();
    const what = done.map((w) => `"${short(w.title, 80)}"`).join(', ');
    const ref = followUpReference(request, item);
    const text =
      `[FOLLOW-UP ${ticketLabel(request)}] The work you promised the owner is ready (${what}) — deliver it now. ` +
      `You said: "${short(item.text, 200)}". Run: ${followUpCommand(ref)} — Crewly posts it in the ticket's thread; that closes the follow-up.`;
    const ok = await this.remindAgent(request, item.agent, text);
    if (ok) AgentPromptReferenceService.getInstance().note(item.agent, ref, `[FOLLOW-UP ${ticketLabel(request)}]`);
    this.logger.info('Promised work is ready — agent woken to deliver', { tkt: ticketLabel(request), item: item.id, agent: item.agent, delivered: ok });
    return { ...item, status: 'ready', readyAt: finishedAt ?? now.toISOString(), ...(ok ? { wokeAt: now.toISOString() } : {}) };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * A `reply_question` decision settled: close its open item and give the
   * agent the answer (the generic decision note).
   *
   * @param d - The decision
   * @param fallback - The generic note
   * @returns The note for the agent (null when withdrawn)
   */
  async onDecisionSettled(d: OwnerDecision, fallback: string | null | undefined): Promise<string | null> {
    const ref = d.requestRef;
    if (!ref) return fallback ?? null;
    // Not awaited: the handler can run inside this service's own chain (the
    // sweep withdrawing a card), and the note does not depend on the write.
    void this.serial(async () => {
      const request = await this.deps.requests.getById(ref.requestId);
      if (!request) return;
      const now = this.now().toISOString();
      const status = itemStatusFor(d);
      if (status === 'open') return; // parked: still waiting on the owner
      const answer = d.chosenKey ? d.options.find((o) => o.key === d.chosenKey)?.label : d.answerText;
      const items = (request.openItems ?? []).map((i) =>
        i.id === ref.itemId && ACTIVE_OPEN_ITEM_STATUSES.has(i.status)
          ? { ...i, status, closedAt: now, closedReason: `${d.id} ${d.status}`, ...(answer ? { answer } : {}) }
          : i,
      );
      await this.save(request, items, false);
    }).catch((err) => this.logger.warn('Answered question not recorded', { decisionId: d.id, error: errText(err) }));
    if (d.status === 'cancelled') return null;
    const reply = d.chosenKey && d.options.find((o) => o.key === d.chosenKey)?.label === OPEN_ITEMS_CONSTANTS.REPLY_LABEL;
    if (reply) {
      return `[DECISION ${d.id}] The owner will answer "${d.question}" in words in the thread. Wait for their message there, then act on it.`;
    }
    return fallback ?? null;
  }

  // -------------------------------------------------------------------------
  // Owner skips
  // -------------------------------------------------------------------------

  /**
   * The owner skipped an open item ("I don't care about this anymore"). A
   * promise is closed, its follow-up WorkItem cancelled and the agent told
   * once to drop it; a question's card is skipped (which closes the item and
   * tells the agent). The request completes when nothing else is open.
   *
   * @param requestId - Request
   * @param itemId - Open item
   * @returns The closed item
   * @throws OpenItemsError(404 / 409)
   */
  async skipItem(requestId: string, itemId: string): Promise<RequestOpenItem> {
    const request = await this.deps.requests.getById(requestId);
    if (!request) throw new OpenItemsError(404, `Request ${requestId} not found`);
    const item = (request.openItems ?? []).find((i) => i.id === itemId);
    if (!item) throw new OpenItemsError(404, `Open item ${itemId} not found on ${ticketLabel(request)}`);
    if (!ACTIVE_OPEN_ITEM_STATUSES.has(item.status)) throw new OpenItemsError(409, `Open item ${itemId} is already ${item.status}`);
    // A question with a pending card: skip the card; its settle handler closes the item.
    if (item.type === 'question' && item.decisionId && this.deps.skipQuestion) {
      await this.deps.skipQuestion(item.decisionId).catch(() => false);
    }
    let note: string | null = null;
    const closed = await this.serial(async () => {
      const fresh = await this.deps.requests.getById(requestId);
      const cur = fresh?.openItems?.find((i) => i.id === itemId);
      if (!fresh || !cur) throw new OpenItemsError(404, `Open item ${itemId} not found`);
      if (!ACTIVE_OPEN_ITEM_STATUSES.has(cur.status)) return cur;
      const next: RequestOpenItem = { ...cur, status: 'skipped', closedAt: this.now().toISOString(), closedReason: 'skipped by the owner' };
      if (cur.type === 'commitment') {
        if (cur.workItemId) await this.closeFollowUp(cur.workItemId, 'cancelled', 'The owner skipped this promise');
        note =
          `[FOLLOW-UP ${ticketLabel(fresh)}] The owner skipped this — drop it, don't ask again. ` +
          `You had promised: "${short(cur.text, 200)}". Don't deliver it unless the owner asks again.`;
      } else {
        note = `[FOLLOW-UP ${ticketLabel(fresh)}] The owner skipped this — drop it, don't ask again: "${short(cur.text, 200)}".`;
      }
      const items = (fresh.openItems ?? []).map((i) => (i.id === itemId ? next : i));
      await this.save(fresh, items, false);
      return next;
    });
    if (note) await this.deps.deliverToAgent(closed.agent, note).catch(() => false);
    this.logger.info('Open item skipped by the owner', { tkt: ticketLabel(request), item: itemId, type: closed.type });
    return closed;
  }

  // -------------------------------------------------------------------------
  // Sweep
  // -------------------------------------------------------------------------

  /**
   * Periodic pass: link late child work, catch missed readiness, nudge
   * overdue promises once and then tell the owner, sync answered questions,
   * expire stale items, close cancelled tickets' items.
   *
   * @returns Counts of what happened
   */
  async sweep(): Promise<{ ready: number; nudged: number; ownerNotes: number; expired: number; closed: number }> {
    return this.serial(async () => {
      const counts = { ready: 0, nudged: 0, ownerNotes: 0, expired: 0, closed: 0 };
      const now = this.now();
      const all = await this.deps.requests.listAll();
      const tracked = all.filter(
        (r) => r.status === 'awaiting_followup' || (r.openItems ?? []).some((i) => ACTIVE_OPEN_ITEM_STATUSES.has(i.status)),
      );
      if (tracked.length === 0) return counts;
      const pool = await this.deps.listWorkItems().catch(() => [] as WorkItem[]);
      for (const request of tracked) {
        try {
          const before = JSON.stringify(request.openItems);
          let items: RequestOpenItem[] = [];
          for (const item of request.openItems ?? []) items.push(await this.sweepItem(request, item, now, pool, counts));
          items = await this.tellOwnerAboutDroppedPromises(request, request.openItems ?? [], items, pool, now);
          const changed = JSON.stringify(items) !== before;
          const allClosed = !items.some((i) => ACTIVE_OPEN_ITEM_STATUSES.has(i.status));
          if (changed || (request.status === 'awaiting_followup' && allClosed)) await this.save(request, items, false);
        } catch (err) {
          this.logger.warn('Open-items sweep step failed', { id: request.id, error: errText(err) });
        }
      }
      if (counts.ready + counts.nudged + counts.ownerNotes + counts.expired + counts.closed > 0) {
        this.logger.info('Open-items sweep', counts);
      }
      return counts;
    });
  }

  /**
   * Promises this sweep closed without delivery are told to the owner once,
   * in one note per request:
   * - the follow-up WorkItem was cancelled by ANOTHER agent (an agent's
   *   cleanup, a bulk script) — the cancel API records who
   *   (`metadata.cancelledBy`);
   * - nothing happened for 7 days and the owner was never told it was late.
   *
   * The promising agent cancelling its own follow-up, owner skips,
   * superseded promises and cancelled tickets were closed on purpose and
   * stay quiet. Before this, ~60 tracked promises were cancelled in one
   * cleanup and Owen's two article links were never sent (crewly#1015 §10).
   *
   * @param request - Request
   * @param previous - Its items before this sweep
   * @param items - Its items after this sweep (same order)
   * @param pool - Every WorkItem
   * @param now - Clock
   * @returns The items, with `ownerNotifiedAt` set on the ones the owner was told about
   */
  private async tellOwnerAboutDroppedPromises(
    request: Request,
    previous: readonly RequestOpenItem[],
    items: RequestOpenItem[],
    pool: readonly WorkItem[],
    now: Date,
  ): Promise<RequestOpenItem[]> {
    const cancelledByOther = (item: RequestOpenItem): string | null => {
      if (item.status !== 'cancelled' || !item.workItemId) return null;
      const fu = pool.find((w) => w.id === item.workItemId);
      if (!fu || fu.status !== 'cancelled') return null;
      const by = (fu.metadata ?? {})[OPEN_ITEMS_CONSTANTS.CANCELLED_BY_METADATA_KEY];
      // The orchestrator cancels follow-ups when the owner asks it to: the
      // owner knows (crewly#1015 review).
      if (by === ORCHESTRATOR_SESSION_NAME) return null;
      return typeof by === 'string' && by && by !== item.agent ? by : null;
    };
    const dropped = items.filter((item, i) => {
      const was = previous[i];
      if (!was || was.id !== item.id || item.type !== 'commitment') return false;
      if (!ACTIVE_OPEN_ITEM_STATUSES.has(was.status)) return false;
      const expiredUntold = item.status === 'expired' && !was.ownerNotifiedAt;
      return expiredUntold || cancelledByOther(item) !== null;
    });
    if (dropped.length === 0) return items;
    const lines: string[] = [];
    for (const item of dropped) {
      const name = (await this.deps.displayName?.(item.agent).catch(() => undefined)) ?? item.agent;
      const by = cancelledByOther(item);
      const byName = by ? ((await this.deps.displayName?.(by).catch(() => undefined)) ?? by) : '';
      const reason = item.closedReason?.includes(': ') ? short(item.closedReason.slice(item.closedReason.indexOf(': ') + 2), 100) : '';
      const why =
        item.status === 'expired'
          ? 'nothing happened on it for 7 days'
          : `${byName} cancelled its follow-up${reason ? ` ("${reason}")` : ''}`;
      lines.push(`${name}'s promise "${short(item.text, 160)}" was closed without being delivered: ${why}. If you still want it, ask ${name} again.`);
    }
    const ok = await this.deps.postOwnerNote(request, lines.join('\n')).catch(() => false);
    this.logger.warn('Promises closed undelivered — owner told in the thread', {
      tkt: ticketLabel(request),
      items: dropped.map((i) => i.id),
      posted: ok,
    });
    if (!ok) return items;
    const nowIso = now.toISOString();
    const told = new Set(dropped.map((i) => i.id));
    return items.map((i) => (told.has(i.id) ? { ...i, ownerNotifiedAt: nowIso } : i));
  }

  /**
   * One item's sweep step.
   */
  private async sweepItem(
    request: Request,
    item: RequestOpenItem,
    now: Date,
    pool: readonly WorkItem[],
    counts: { ready: number; nudged: number; ownerNotes: number; expired: number; closed: number },
  ): Promise<RequestOpenItem> {
    if (!ACTIVE_OPEN_ITEM_STATUSES.has(item.status)) return item;
    const nowIso = now.toISOString();
    if (request.status === 'cancelled') {
      counts.closed += 1;
      if (item.workItemId) await this.closeFollowUp(item.workItemId, 'cancelled', 'The ticket was cancelled');
      if (item.decisionId) await this.deps.cancelQuestion?.(item.decisionId, 'ticket cancelled').catch(() => undefined);
      return { ...item, status: 'cancelled', closedAt: nowIso, closedReason: 'ticket cancelled' };
    }
    if (now.getTime() - Date.parse(item.createdAt) >= OPEN_ITEMS_CONSTANTS.EXPIRE_AFTER_MS) {
      counts.expired += 1;
      if (item.workItemId) await this.closeFollowUp(item.workItemId, 'cancelled', 'Expired: nothing happened for 7 days');
      return { ...item, status: 'expired', closedAt: nowIso, closedReason: 'no activity for 7 days' };
    }
    if (item.type === 'question') {
      if (!item.decisionId || !this.deps.getDecision) return item;
      const d = await this.deps.getDecision(item.decisionId).catch(() => null);
      if (!d || d.status === 'open' || d.status === 'parked') return item;
      const status = itemStatusFor(d);
      const answer = d.chosenKey ? d.options.find((o) => o.key === d.chosenKey)?.label : d.answerText;
      counts.closed += 1;
      return { ...item, status, closedAt: nowIso, closedReason: `${d.id} ${d.status}`, ...(answer ? { answer } : {}) };
    }

    if (item.status === 'waiting_owner') {
      // No due time, no nudges. A card answer opens it; a declined card closes it.
      if (!item.gateDecisionId || !this.deps.getDecision) return item;
      const d = await this.deps.getDecision(item.gateDecisionId).catch(() => null);
      if (!d || d.status === 'open' || d.status === 'parked') return item;
      if (d.status === 'cancelled' || d.status === 'expired' || (d.chosenKey && d.yesKey && d.chosenKey !== d.yesKey)) {
        counts.closed += 1;
        return { ...item, status: 'superseded', closedAt: nowIso, closedReason: `${d.id} ${d.status}: the owner did not agree` };
      }
      const at = d.resolvedAt ? new Date(d.resolvedAt) : now;
      const { due, source } = parseDue(item.text, at);
      return this.activate(request, { item: { ...item, status: 'open', due: due.toISOString(), dueSource: source } }, pool);
    }

    // Commitment whose follow-up WorkItem was finished or cancelled (by anyone,
    // through the task API): the item is closed with it, so it cannot nudge or be re-armed.
    const followUp = item.workItemId ? pool.find((w) => w.id === item.workItemId) : undefined;
    if (followUp && ['done', 'verified', 'cancelled'].includes(followUp.status)) {
      counts.closed += 1;
      const delivered = followUp.status !== 'cancelled';
      return {
        ...item,
        status: delivered ? 'delivered' : 'cancelled',
        closedAt: nowIso,
        closedReason: `follow-up ${followUp.id.slice(0, 8)} is ${followUp.status}${!delivered && followUp.cancelReason ? `: ${short(followUp.cancelReason, 160)}` : ''}`,
      };
    }

    // Commitment: link child work started after the promise.
    let current = item;
    const children = childWorkFor(request, item, pool);
    if (children.some((id) => !(item.childWorkItemIds ?? []).includes(id))) {
      current = { ...current, childWorkItemIds: [...new Set([...(item.childWorkItemIds ?? []), ...children])] };
    }
    if (current.status === 'open' && (current.childWorkItemIds ?? []).length > 0) {
      const state = childrenState(current.childWorkItemIds ?? [], pool);
      if (state.ready) {
        counts.ready += 1;
        return this.markReady(request, current, state.finishedAt, state.done);
      }
    }
    const due = current.due ? Date.parse(current.due) : NaN;
    if (!Number.isFinite(due) || now.getTime() < due) return current;
    if (!current.nudgedAt) {
      const ref = followUpReference(request, current);
      const text =
        `[FOLLOW-UP ${ticketLabel(request)}] You promised the owner: "${short(current.text, 200)}" — due ${formatWhen(new Date(due), now)}, and it hasn't been delivered. ` +
        `Deliver it now, or tell the owner plainly when it will come and why. Run: ${followUpCommand(ref)} — Crewly posts it in the ticket's thread.`;
      const ok = await this.remindAgent(request, current.agent, text);
      if (ok) AgentPromptReferenceService.getInstance().note(current.agent, ref, `[FOLLOW-UP ${ticketLabel(request)}]`);
      counts.nudged += 1;
      this.logger.info('Overdue promise — agent nudged', { tkt: ticketLabel(request), item: current.id, agent: current.agent, delivered: ok });
      return { ...current, status: 'overdue', nudgedAt: nowIso };
    }
    if (!current.ownerNotifiedAt && now.getTime() - Date.parse(current.nudgedAt) >= OPEN_ITEMS_CONSTANTS.OWNER_NOTE_AFTER_NUDGE_MS) {
      const note = await this.ownerNote(request, current, pool, now);
      const ok = await this.deps.postOwnerNote(request, note).catch(() => false);
      counts.ownerNotes += 1;
      this.logger.info('Overdue promise — owner told in the thread', { tkt: ticketLabel(request), item: current.id, posted: ok });
      return ok ? { ...current, status: 'overdue', ownerNotifiedAt: nowIso } : current;
    }
    return current;
  }

  /**
   * The owner's note for a late promise: what, by when, and why it is late.
   *
   * @param request - Request
   * @param item - Commitment
   * @param pool - Every WorkItem
   * @param now - Clock
   * @returns Note text (English harness text; the agent's words quoted)
   */
  async ownerNote(request: Request, item: RequestOpenItem, pool: readonly WorkItem[], now: Date): Promise<string> {
    const name = (await this.deps.displayName?.(item.agent).catch(() => undefined)) ?? item.agent;
    const due = item.due ? formatWhen(new Date(item.due), now) : 'today';
    const state = childrenState(item.childWorkItemIds ?? [], pool);
    let why: string;
    if (state.pending.length > 0) {
      const parts: string[] = [];
      for (const w of state.pending.slice(0, 2)) {
        const who = w.target ? ((await this.deps.displayName?.(w.target).catch(() => undefined)) ?? w.target) : 'nobody';
        parts.push(`${who}'s part ("${short(w.title, 60)}") is still ${w.status.replace(/_/g, ' ')}`);
      }
      why = parts.join('; ');
    } else if (state.ready || item.readyAt) {
      const at = item.readyAt ? formatWhen(new Date(item.readyAt), now) : 'earlier';
      why = `the work was ready at ${at}, but ${name} hasn't posted it`;
    } else {
      why = `${name} hasn't posted it yet`;
    }
    return `${name} promised "${short(item.text, 160)}" by ${due}. It hasn't arrived: ${why}. ${name} has been reminded.`;
  }

  private async closeFollowUp(workItemId: string, outcome: 'delivered' | 'cancelled', reason: string): Promise<void> {
    await this.deps.closeFollowUp?.(workItemId, outcome, reason).catch((err) =>
      this.logger.debug('Follow-up WorkItem not closed', { workItemId, error: errText(err) }),
    );
  }
}

/**
 * The open-item status a settled decision leaves its question in.
 *
 * @param d - Decision
 * @returns Status (`open` while it is still pending)
 */
export function itemStatusFor(d: Pick<OwnerDecision, 'status'>): RequestOpenItem['status'] {
  switch (d.status) {
    case 'resolved':
    case 'defaulted':
      return 'resolved';
    case 'cancelled':
      return 'superseded';
    case 'expired':
      return 'expired';
    case 'skipped':
      return 'skipped';
    default:
      return 'open';
  }
}

/**
 * Message of an unknown error.
 *
 * @param err - Thrown value
 * @returns Text
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
