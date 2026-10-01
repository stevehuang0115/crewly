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

import { OPEN_ITEMS_CONSTANTS } from '../../constants.js';
import { isInterim } from '../slack/slack-typing-placeholder.service.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { Request } from '../../types/v2/request.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { ACTIVE_OPEN_ITEM_STATUSES, type RequestOpenItem } from '../../types/v2/open-item.types.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import { formatTicketNumber } from '../../types/v2/ticket.types.js';
import { extractOpenItems, type ExtractedQuestion } from './open-item-extractor.js';
import { deriveQuestionCard, questionSimilarity, type DerivedQuestionCard } from './open-item-card.js';
import { formatWhen } from '../decisions/decision-card.js';

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
 * `--thread <channel>:<ts>` hint for the agent, when the conversation is in Slack.
 *
 * @param request - Request
 * @returns Hint text (leading space) or empty
 */
function threadHint(request: Request): string {
  const place = slackPlaceOf(request);
  return place ? ` (--thread ${place.slackChannelId}:${place.threadTs})` : '';
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
    if (message.senderType !== 'agent' || !message.content?.trim()) return null;
    // "Got it — on it" placeholders are not the reply.
    if (isInterim(message)) return null;
    return this.serial(async () => {
      const all = await this.deps.requests.listAll();
      const request = this.findRequestFor(message, all);
      if (!request) return null;
      const at = new Date(message.createdAt ?? this.now().getTime());
      const pool = await this.deps.listWorkItems().catch(() => [] as WorkItem[]);
      const planned = await this.plan(request, message, at);
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
      const fresh = planned.filter((p) => !items.some((i) => isSameItem(i, p.item)));
      for (const p of fresh) {
        const item = await this.activate(request, p, pool);
        items.push(item);
        changed = true;
      }
      if (!changed) return null;
      return this.save(request, items, fresh.length > 0);
    });
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
    found.commitments.forEach((c, i) => {
      out.push({ item: { ...base('commitment', i + 1), type: 'commitment', text: c.text, due: c.due.toISOString(), dueSource: c.dueSource } });
    });
    let qi = 0;
    for (const q of found.questions) {
      qi += 1;
      const item: RequestOpenItem = { ...base('question', qi), type: 'question', text: q.text };
      const asked = await this.alreadyAsked(message.senderId, q, at);
      out.push(asked ? { item, linkedDecisionId: asked.id } : { item, card: deriveQuestionCard(q) });
    }
    return out;
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
  private async activate(request: Request, p: PlannedOpenItem, pool: readonly WorkItem[]): Promise<RequestOpenItem> {
    const place = slackPlaceOf(request);
    let item = { ...p.item };
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
      const d = await this.deps.askQuestion({ request, item, card: p.card, place }).catch((err) => {
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
      if (item.type !== 'commitment' || !ACTIVE_OPEN_ITEM_STATUSES.has(item.status)) continue;
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
      // Posted after the work was finished.
      return !state.finishedAt || at >= Date.parse(state.finishedAt);
    }
    if (message.senderId !== item.agent) return false;
    if (at - Date.parse(item.createdAt) < OPEN_ITEMS_CONSTANTS.MIN_DELIVERY_GAP_MS) return false;
    return extractOpenItems(message.content, { now: new Date(at) }).commitments.length === 0;
  }

  /**
   * Take planned items onto a request (the backfill's apply step).
   *
   * @param requestId - Request
   * @param planned - Items from {@link plan}
   * @returns Updated request, or null when it is gone
   */
  async adopt(requestId: string, planned: PlannedOpenItem[]): Promise<Request | null> {
    return this.serial(async () => {
      const request = await this.deps.requests.getById(requestId);
      if (!request) return null;
      const pool = await this.deps.listWorkItems().catch(() => [] as WorkItem[]);
      const items = [...(request.openItems ?? [])];
      for (const p of planned) {
        if (items.some((i) => i.id === p.item.id)) continue;
        items.push(await this.activate(request, p, pool));
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
    const text =
      `[FOLLOW-UP ${ticketLabel(request)}] The work you promised the owner is ready (${what}) — deliver it now. ` +
      `You said: "${short(item.text, 200)}". Post it in the same thread${threadHint(request)}; that closes the follow-up.`;
    const ok = await this.deps.deliverToAgent(item.agent, text).catch(() => false);
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
      const status: RequestOpenItem['status'] =
        d.status === 'resolved' || d.status === 'defaulted' ? 'resolved' : d.status === 'cancelled' ? 'superseded' : d.status === 'expired' ? 'expired' : 'open';
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
          const items: RequestOpenItem[] = [];
          for (const item of request.openItems ?? []) items.push(await this.sweepItem(request, item, now, pool, counts));
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
      const status: RequestOpenItem['status'] = d.status === 'cancelled' ? 'superseded' : d.status === 'expired' ? 'expired' : 'resolved';
      const answer = d.chosenKey ? d.options.find((o) => o.key === d.chosenKey)?.label : d.answerText;
      counts.closed += 1;
      return { ...item, status, closedAt: nowIso, closedReason: `${d.id} ${d.status}`, ...(answer ? { answer } : {}) };
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
      const text =
        `[FOLLOW-UP ${ticketLabel(request)}] You promised the owner: "${short(current.text, 200)}" — due ${formatWhen(new Date(due), now)}, and it hasn't been delivered. ` +
        `Deliver it now in the same thread${threadHint(request)}, or tell the owner plainly when it will come and why.`;
      const ok = await this.deps.deliverToAgent(current.agent, text).catch(() => false);
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
 * Message of an unknown error.
 *
 * @param err - Thrown value
 * @returns Text
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
