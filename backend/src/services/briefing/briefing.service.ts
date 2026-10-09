/**
 * BriefingService — the owner's Drive mode queue (specs/2026-10-08-drive-mode.md).
 *
 * Gathers everything on this machine that is waiting on the owner, in the
 * order a voice briefer should read it:
 *
 *  - open owner decision cards (`D-<n>`, including parked sensitive asks and
 *    cards whose "remind me" time came),
 *  - questions agents asked the owner in a reply that never became a card
 *    (Request open items of type `question`),
 *  - finished work handed back for the owner's OK (tickets in 待验收),
 *  - anything the owner said "later" about, once its time comes.
 *
 * …and carries out what the owner says, through the paths that already
 * exist: the decision service (as if the owner answered the card, via
 * `voice`), the agent's own conversation (recorded and dispatched like a
 * Talk message, tagged voice), and the ticket review (accept / send back).
 *
 * Sensitive items (deploy, money, delete, email…) need two calls: the first
 * returns `needs_confirmation` with a one-time token, the second must repeat
 * the same answer with `confirm: true` and that token.
 *
 * The owner's answers are never logged or stored here.
 *
 * @module services/briefing/briefing.service
 */

import { randomBytes } from 'crypto';
import { BRIEFING_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import type { OwnerDecision } from '../../types/decision.types.js';
import type { Request } from '../../types/v2/request.types.js';
import type { TicketListItem } from '../v3/ticket-intake.service.js';
import type { ReviewActionResult } from '../v3/ticket-review.service.js';
import type { AgentRosterEntry } from '../cloud/conversation-ingest.contract.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { BriefingStateStore } from './briefing-state.store.js';
import {
  BriefingError,
  type BriefingActionResult,
  type BriefingAnswerInput,
  type BriefingItem,
  type BriefingItemState,
  type BriefingQueue,
} from './briefing.types.js';
import { clip, orderBriefing, parseLaterTime, sensitiveReason, speakable, spokenSummary } from './briefing.utils.js';

const C = BRIEFING_CONSTANTS;

/** Decision statuses still waiting on the owner. */
const PENDING_DECISIONS = new Set(['open', 'parked']);
/** Open-item statuses in which a question is still unanswered. */
const OPEN_QUESTION_STATUSES = new Set(['open', 'overdue']);
/** Review answers. */
const REVIEW_ACCEPT = 'accept';
const REVIEW_SEND_BACK = 'send_back';

/** The decision operations used (DecisionService). */
export interface BriefingDecisions {
  list(which?: 'open' | 'all'): Promise<OwnerDecision[]>;
  chooseFromDashboard(id: string, optionKey: string, via?: 'dashboard' | 'voice'): Promise<OwnerDecision>;
  answerInWords(id: string, text: string, via?: 'voice' | 'dashboard'): Promise<OwnerDecision>;
  remindFromDashboard(id: string): Promise<OwnerDecision>;
  skipFromDashboard(id: string): Promise<OwnerDecision>;
}

/** The ticket review operations used (TicketReviewService). */
export interface BriefingReview {
  verify(ref: string): Promise<ReviewActionResult>;
  reject(ref: string, reason: string, via: 'board'): Promise<ReviewActionResult>;
}

/** Where to post the owner's words: an agent's DM, or a channel / thread. */
export interface BriefingPostTarget {
  agentSession: string;
  /** Omitted = the agent's DM */
  channelId?: string;
  threadId?: string;
}

/** Collaborators. */
export interface BriefingDeps {
  decisions: () => BriefingDecisions | null;
  /** Every Request (for open-item questions) */
  listRequests: () => Promise<Request[]>;
  /** Tickets in 待验收 */
  listReviewTickets: () => Promise<TicketListItem[]>;
  review: () => BriefingReview | null;
  /** "I don't care about this anymore" for an open-item question */
  dismissOpenItem: (requestId: string, itemId: string) => Promise<unknown>;
  /** Agents on this machine (names, teams) */
  roster: () => Promise<AgentRosterEntry[]>;
  /**
   * Post the owner's words to an agent exactly like an owner message from
   * Talk (recorded in chat-v2, ticket intake, dispatched; tagged voice).
   * Returns where it went.
   */
  postOwnerMessage: (target: BriefingPostTarget, text: string) => Promise<{ channelId: string; threadId?: string }>;
  /** The agent's first reply in that conversation after `sinceMs`, if any */
  findAgentReply: (agentSession: string, channelId: string, threadId: string | undefined, sinceMs: number) => Promise<{ text: string; at: string } | null>;
  store: BriefingStateStore;
  now?: () => Date;
  logger?: ComponentLogger;
}

/** A gathered item with its stored state (internal). */
interface GatheredItem {
  item: BriefingItem;
  state: BriefingItemState;
  decision?: OwnerDecision;
  request?: Request;
}

/** A confirmation waiting for the owner's spoken yes. */
interface PendingConfirmation {
  itemId: string;
  fingerprint: string;
  expiresAt: number;
}

/** The Drive mode queue and its actions. */
export class BriefingService {
  private readonly logger: ComponentLogger;
  private readonly now: () => Date;
  private readonly confirmations = new Map<string, PendingConfirmation>();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: BriefingDeps) {
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('Briefing');
    this.now = deps.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------------------
  // Queue
  // ---------------------------------------------------------------------------

  /**
   * The owner's queue right now: items to read (ordered), lookups the agents
   * are still working on, and how many are hidden by next / later.
   *
   * @returns The queue
   */
  async queue(): Promise<BriefingQueue> {
    const now = this.now();
    const all = await this.gather();
    const items: BriefingItem[] = [];
    const lookupsPending: BriefingQueue['lookupsPending'] = [];
    let hidden = 0;
    for (const g of all) {
      const visibility = await this.visibility(g, now);
      if (visibility === 'pending' && g.state.lookup) {
        lookupsPending.push({ id: g.item.id, agentName: g.item.agentName, question: g.state.lookup.question, askedAt: g.state.lookup.askedAt });
      } else if (visibility === 'hidden') {
        hidden += 1;
      } else if (visibility === 'visible') {
        items.push(g.item);
      }
    }
    // Forget state of items that are gone (answered elsewhere, closed…).
    void this.deps.store.prune(new Set(all.map((g) => g.item.id))).catch(() => undefined);
    return { items: orderBriefing(items).slice(0, C.MAX_ITEMS), lookupsPending, hidden, generatedAt: now.toISOString() };
  }

  /**
   * Whether an item is read now, and fold a found lookup answer into it.
   *
   * @param g - Gathered item (mutated: `item.lookupAnswer`, `item.reminder`, `item.urgency`)
   * @param now - Clock
   * @returns visible / hidden / pending (lookup) / answered (gone)
   */
  private async visibility(g: GatheredItem, now: Date): Promise<'visible' | 'hidden' | 'pending' | 'answered'> {
    const { item } = g;
    let state = g.state;
    if (state.answeredAt) return 'answered';
    if (state.lookup) {
      const since = Date.parse(state.lookup.askedAt);
      const reply = await this.deps.findAgentReply(item.agentSession, state.lookup.channelId, state.lookup.threadId, since).catch(() => null);
      if (reply) {
        const lookupAnswer = { question: state.lookup.question, answer: clip(speakable(reply.text), C.LOOKUP_ANSWER_MAX_CHARS), at: reply.at };
        state = (await this.deps.store.update(item.id, (cur) => ({ ...cur, lookup: undefined, lookupAnswer, hiddenUntil: undefined }))) ?? {};
        g.state = state;
      } else if (now.getTime() - since > C.LOOKUP_GIVE_UP_MS) {
        state = (await this.deps.store.update(item.id, (cur) => ({ ...cur, lookup: undefined }))) ?? {};
        g.state = state;
      } else {
        return 'pending';
      }
    }
    if (state.lookupAnswer) {
      item.lookupAnswer = state.lookupAnswer;
      item.urgency = 'high';
      return 'visible';
    }
    if (state.hiddenUntil && Date.parse(state.hiddenUntil) > now.getTime()) return 'hidden';
    if (state.hiddenUntil && state.later) {
      item.reminder = true;
      item.urgency = 'high';
    }
    return 'visible';
  }

  /** Everything waiting, unfiltered, with stored state. */
  private async gather(): Promise<GatheredItem[]> {
    const now = this.now();
    const [roster, state, decisions, requests, reviews] = await Promise.all([
      this.deps.roster().catch(() => [] as AgentRosterEntry[]),
      this.deps.store.read(),
      (this.deps.decisions()?.list('open') ?? Promise.resolve([] as OwnerDecision[])).catch(() => [] as OwnerDecision[]),
      this.deps.listRequests().catch(() => [] as Request[]),
      this.deps.listReviewTickets().catch(() => [] as TicketListItem[]),
    ]);
    const who = (session: string | null | undefined): { name: string; team?: string } => {
      const s = session || ORCHESTRATOR_SESSION_NAME;
      const r = roster.find((a) => a.agentSession === s);
      return { name: r?.displayName || s, ...(r?.teamName ? { team: r.teamName } : {}) };
    };
    const out: GatheredItem[] = [];
    for (const d of decisions) {
      const item = decisionItem(d, who(d.system ? ORCHESTRATOR_SESSION_NAME : d.asker), now);
      if (item) out.push({ item, state: state.items[item.id] ?? {}, decision: d });
    }
    for (const r of requests) {
      for (const it of r.openItems ?? []) {
        if (it.type !== 'question' || !OPEN_QUESTION_STATUSES.has(it.status) || it.decisionId || !r.chatRef) continue;
        const item = questionItem(r, it, who(it.agent));
        out.push({ item, state: state.items[item.id] ?? {}, request: r });
      }
    }
    for (const t of reviews) {
      const item = reviewItem(t, who(t.assignee ?? t.reply?.by), now);
      out.push({ item, state: state.items[item.id] ?? {} });
    }
    return out;
  }

  /**
   * One item by id (visible or not).
   *
   * @param id - Item id
   * @returns The item
   * @throws BriefingError(404)
   */
  private async find(id: string): Promise<GatheredItem> {
    const g = (await this.gather()).find((x) => x.item.id === id);
    if (!g || g.state.answeredAt) throw new BriefingError(404, C.CODES.NOT_FOUND, 'That item is no longer waiting — it was answered or closed.');
    return g;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Answer an item: choose an option or say something.
   *
   * @param id - Item id
   * @param input - `{ optionKey?, text?, confirm?, confirmToken? }`
   * @returns What happened (`needs_confirmation` for a sensitive item's first call)
   * @throws BriefingError(400/404/409/503)
   */
  async answer(id: string, input: BriefingAnswerInput): Promise<BriefingActionResult> {
    const optionKey = cleanText(input.optionKey, 100);
    const text = cleanText(input.text, C.TEXT_MAX_CHARS);
    if (!optionKey && !text) throw new BriefingError(400, C.CODES.INVALID, 'Say an option or an answer.');
    const g = await this.find(id);
    const { item } = g;
    if (optionKey && item.options.length > 0 && !matchOptionKey(item, optionKey)) {
      throw new BriefingError(400, C.CODES.INVALID, `Options are: ${item.options.map((o) => `${o.key} (${o.label})`).join(', ')}`);
    }
    if (item.kind === 'review') {
      const key = optionKey ? matchOptionKey(item, optionKey)?.key : undefined;
      if (!key) throw new BriefingError(400, C.CODES.INVALID, 'For finished work, say accept, or send back with what still needs fixing.');
      if (key === REVIEW_SEND_BACK && !text) throw new BriefingError(400, C.CODES.INVALID, 'Sending it back needs a reason: what still needs fixing?');
    }

    const fingerprint = JSON.stringify([optionKey ? matchOptionKey(item, optionKey)?.key ?? optionKey : null, text ?? null]);
    if (item.sensitive) {
      if (input.confirm !== true) return this.askConfirmation(item, fingerprint, optionKey);
      this.consumeConfirmation(item.id, fingerprint, input.confirmToken);
    }

    if (item.kind === 'decision') {
      const decisions = this.requireDecisions();
      const decisionId = (item.answerTarget as { decisionId: string }).decisionId;
      await wrapDecisionError(() =>
        optionKey ? decisions.chooseFromDashboard(decisionId, matchOptionKey(item, optionKey)?.key ?? optionKey, 'voice') : decisions.answerInWords(decisionId, text as string, 'voice'),
      );
      await this.deps.store.update(item.id, () => null);
      this.logger.info('Briefing: decision answered by voice', { itemId: item.id, how: optionKey ? 'option' : 'words' });
      return { status: 'done', itemId: item.id, spoken: `Done. ${item.agentName} has your answer.` };
    }

    if (item.kind === 'question') {
      const target = item.answerTarget as { channelId: string; threadId?: string; agentSession: string };
      const words = text ?? matchOptionKey(item, optionKey ?? '')?.label ?? (optionKey as string);
      await this.deps.postOwnerMessage({ agentSession: target.agentSession, channelId: target.channelId, ...(target.threadId ? { threadId: target.threadId } : {}) }, words);
      await this.deps.store.update(item.id, () => ({ answeredAt: this.now().toISOString() }));
      this.logger.info('Briefing: question answered by voice', { itemId: item.id });
      return { status: 'done', itemId: item.id, spoken: `Sent to ${item.agentName}.` };
    }

    // review
    const review = this.deps.review();
    if (!review) throw new BriefingError(503, C.CODES.NOT_READY, 'Tickets are not ready yet — Crewly is still starting.');
    const ticketId = (item.answerTarget as { ticketId: string }).ticketId;
    const key = matchOptionKey(item, optionKey as string)?.key;
    const result = key === REVIEW_ACCEPT ? await review.verify(ticketId) : await review.reject(ticketId, text as string, 'board');
    if (!result.ok) throw new BriefingError(409, C.CODES.FAILED, reviewRefusal(result.reason));
    await this.deps.store.update(item.id, () => null);
    this.logger.info('Briefing: review answered by voice', { itemId: item.id, action: key });
    return { status: 'done', itemId: item.id, spoken: key === REVIEW_ACCEPT ? 'Accepted.' : `Sent back to ${item.agentName}.` };
  }

  /**
   * "Next": hide an item for a while without settling it, or — with
   * `dismiss` — settle it as "I don't care about this anymore".
   *
   * @param id - Item id
   * @param opts - `{ dismiss? }`
   * @returns What happened
   */
  async skip(id: string, opts: { dismiss?: boolean } = {}): Promise<BriefingActionResult> {
    const g = await this.find(id);
    const { item } = g;
    if (opts.dismiss) {
      if (item.kind === 'decision') {
        const decisionId = (item.answerTarget as { decisionId: string }).decisionId;
        await wrapDecisionError(() => this.requireDecisions().skipFromDashboard(decisionId));
      } else if (item.kind === 'question' && g.request) {
        const [, , itemId] = item.id.split(':');
        await this.deps.dismissOpenItem(g.request.id, itemId);
      } else {
        throw new BriefingError(400, C.CODES.INVALID, 'Finished work cannot be dismissed — accept it, send it back, or say later.');
      }
      await this.deps.store.update(item.id, () => null);
      this.logger.info('Briefing: item dismissed by voice', { itemId: item.id });
      return { status: 'done', itemId: item.id, spoken: `Dropped. ${item.agentName} will let it go.` };
    }
    const until = new Date(this.now().getTime() + C.SKIP_HIDE_MS).toISOString();
    await this.deps.store.update(item.id, (cur) => ({ ...cur, hiddenUntil: until, later: undefined, lookupAnswer: undefined }));
    return { status: 'hidden', itemId: item.id, until, spoken: 'Skipped for now.' };
  }

  /**
   * "Later" / "remind me": hide until a time (default tomorrow morning), then
   * bring it back first, flagged as a reminder.
   *
   * @param id - Item id
   * @param opts - `{ at?: ISO }`
   * @returns What happened
   */
  async later(id: string, opts: { at?: unknown } = {}): Promise<BriefingActionResult> {
    const now = this.now();
    const at = parseLaterTime(opts.at, now);
    if (!at) throw new BriefingError(400, C.CODES.INVALID, 'Give a future time (ISO), at most 30 days away — or leave it out for tomorrow morning.');
    const g = await this.find(id);
    if (g.item.kind === 'decision' && (opts.at === undefined || opts.at === null || opts.at === '') && g.decision && !g.decision.system && g.decision.kind !== 'browser_action') {
      // The card itself also says "remind tomorrow", so Slack shows the same.
      await this.deps.decisions()?.remindFromDashboard(g.decision.id).catch(() => undefined);
    }
    const until = at.toISOString();
    await this.deps.store.update(id, (cur) => ({ ...cur, hiddenUntil: until, later: true, lookupAnswer: undefined }));
    return { status: 'hidden', itemId: id, until, spoken: `I'll bring it back ${opts.at ? 'then' : 'tomorrow morning'}.` };
  }

  /**
   * A follow-up question the details do not answer: hand it to the agent in
   * its conversation and keep the item out of the queue until it replies.
   *
   * @param id - Item id
   * @param question - What the owner asked
   * @returns `lookup_pending` (with the details, so the briefer can say what is already known)
   */
  async ask(id: string, question: unknown): Promise<BriefingActionResult> {
    const q = cleanText(question, C.TEXT_MAX_CHARS);
    if (!q) throw new BriefingError(400, C.CODES.INVALID, 'What should I ask?');
    const { item } = await this.find(id);
    let target: BriefingPostTarget;
    let message: string;
    if (item.answerTarget.kind === 'thread') {
      // The question was asked in that conversation: the owner's words go back there.
      target = { agentSession: item.agentSession, channelId: item.answerTarget.channelId, ...(item.answerTarget.threadId ? { threadId: item.answerTarget.threadId } : {}) };
      message = q;
    } else {
      const about =
        item.answerTarget.kind === 'decision'
          ? `decision ${item.answerTarget.decisionId}`
          : `ticket ${item.answerTarget.tkt ?? item.answerTarget.ticketId}`;
      target = { agentSession: item.agentSession };
      message = `[Drive mode] The owner asked about ${about} ("${clip(speakable(item.details.split('\n')[0] ?? ''), 160)}"): ${q}\nAnswer briefly in plain words — it will be read aloud.`;
    }
    const posted = await this.deps.postOwnerMessage(target, message);
    const askedAt = this.now().toISOString();
    await this.deps.store.update(item.id, (cur) => ({
      ...cur,
      lookupAnswer: undefined,
      hiddenUntil: undefined,
      later: undefined,
      lookup: { question: clip(q, 500), askedAt, channelId: posted.channelId, ...(posted.threadId ? { threadId: posted.threadId } : {}) },
    }));
    this.logger.info('Briefing: follow-up handed to the agent', { itemId: item.id, agent: item.agentSession });
    return { status: 'lookup_pending', itemId: item.id, handedTo: item.agentName, details: item.details, spoken: `I asked ${item.agentName}. It comes back to the queue when they answer.` };
  }

  // ---------------------------------------------------------------------------
  // Confirmation
  // ---------------------------------------------------------------------------

  private askConfirmation(item: BriefingItem, fingerprint: string, optionKey: string | null): BriefingActionResult {
    this.sweepConfirmations();
    const token = randomBytes(9).toString('base64url');
    this.confirmations.set(token, { itemId: item.id, fingerprint, expiresAt: this.now().getTime() + C.CONFIRM_TTL_MS });
    const label = optionKey ? matchOptionKey(item, optionKey)?.label ?? optionKey : null;
    const what = label ? `"${label}"` : 'your answer';
    return {
      status: 'needs_confirmation',
      itemId: item.id,
      confirmToken: token,
      confirmQuestion: `This one is sensitive (${item.sensitiveReason ?? 'sensitive'}). Confirm ${what} for: ${clip(item.summary, 160)}`,
      spoken: `Ask the owner to confirm ${what}. Only after a clear yes, call again with the same answer, confirm true and this token.`,
    };
  }

  private consumeConfirmation(itemId: string, fingerprint: string, token: unknown): void {
    this.sweepConfirmations();
    const pending = typeof token === 'string' ? this.confirmations.get(token) : undefined;
    if (!pending || pending.itemId !== itemId || pending.fingerprint !== fingerprint) {
      throw new BriefingError(409, C.CODES.CONFIRM_MISMATCH, 'Confirm the same answer first: call without confirm, ask the owner, then call again with the token.');
    }
    this.confirmations.delete(token as string);
  }

  private sweepConfirmations(): void {
    const now = this.now().getTime();
    for (const [token, c] of this.confirmations) if (c.expiresAt <= now) this.confirmations.delete(token);
  }

  private requireDecisions(): BriefingDecisions {
    const d = this.deps.decisions();
    if (!d) throw new BriefingError(503, C.CODES.NOT_READY, 'Decision cards are not ready yet — Crewly is still starting.');
    return d;
  }
}

// ---------------------------------------------------------------------------
// Item builders (pure)
// ---------------------------------------------------------------------------

/**
 * A decision card as a briefing item (null while it is snoozed by the card's
 * own "remind me tomorrow").
 *
 * @param d - Decision
 * @param who - Asker's name / team
 * @param now - Clock
 * @returns Item or null
 */
export function decisionItem(d: OwnerDecision, who: { name: string; team?: string }, now: Date): BriefingItem | null {
  if (!PENDING_DECISIONS.has(d.status)) return null;
  const remindAt = d.remindAt ? Date.parse(d.remindAt) : NaN;
  if (!Number.isNaN(remindAt) && remindAt > now.getTime()) return null;
  const reminder = !Number.isNaN(remindAt);
  const deadline = Date.parse(d.deadline);
  const urgent = d.status === 'parked' || reminder || (!Number.isNaN(deadline) && deadline - now.getTime() <= C.URGENT_DEADLINE_MS);
  const question = d.title ? `${d.title}: ${d.question}` : d.question;
  const reason = sensitiveReason(
    [d.question, d.title, ...d.options.map((o) => o.label), d.ticket?.title, d.browser?.target],
    d.sensitive ?? (d.kind === 'browser_action' ? 'browser_action' : null),
  );
  const defaultLabel = d.options.find((o) => o.key === d.defaultKey)?.label;
  const lines = [
    `Question: ${speakable(d.question)}`,
    ...(d.title ? [`Title: ${speakable(d.title)}`] : []),
    ...d.options.map((o) => `Option ${o.key}: ${speakable(o.label)}${o.detail ? ` — ${speakable(o.detail)}` : ''}`),
    ...(d.body ?? []).map((b) => speakable(b)),
    ...(d.ticket ? [`Ticket ${d.ticket.id}: ${speakable(d.ticket.title)}${d.ticket.projectName ? ` (project ${d.ticket.projectName})` : ''}`] : []),
    ...(d.browser ? [`Held browser action: ${speakable(d.browser.target)}${d.browser.where ? ` on ${d.browser.where}` : ''}`] : []),
    `Asked by ${who.name}${who.team ? ` (${who.team})` : ''} at ${d.askedAt ?? d.createdAt}.`,
    d.status === 'parked'
      ? 'Nothing happens until the owner answers (sensitive, parked).'
      : d.defaultKey === 'wait' || !defaultLabel
        ? `Deadline ${d.deadline}; with no answer the agent keeps waiting.`
        : `Deadline ${d.deadline}; with no answer: ${speakable(defaultLabel)}${d.sensitive ? ' is NOT applied (sensitive)' : ''}.`,
  ];
  return {
    id: `d:${d.id}`,
    kind: 'decision',
    urgency: urgent ? 'high' : 'normal',
    agentSession: d.system ? ORCHESTRATOR_SESSION_NAME : d.asker,
    agentName: who.name,
    ...(who.team ? { teamName: who.team } : {}),
    summary: spokenSummary('decision', who.name, question, d.options.map((o) => o.label)),
    details: clip(lines.join('\n'), C.DETAILS_MAX_CHARS),
    options: d.options.map((o) => ({ key: o.key, label: o.label, ...(o.detail ? { detail: o.detail } : {}) })),
    acceptsText: d.kind !== 'browser_action' && !d.system,
    sensitive: reason !== null,
    ...(reason ? { sensitiveReason: reason } : {}),
    answerTarget: { kind: 'decision', decisionId: d.id },
    since: d.askedAt ?? d.createdAt,
    deadline: d.deadline,
    ...(reminder ? { reminder: true } : {}),
  };
}

/**
 * An unanswered question from an agent's reply as a briefing item.
 *
 * @param r - Request holding it (has `chatRef`)
 * @param it - The open item
 * @param who - Agent name / team
 * @returns Item
 */
export function questionItem(r: Request, it: NonNullable<Request['openItems']>[number], who: { name: string; team?: string }): BriefingItem {
  const reason = sensitiveReason([it.text, r.title]);
  const lines = [
    `Question: ${speakable(it.text)}`,
    `About: ${speakable(r.title)}${r.ticketNumber ? ` (TKT-${r.ticketNumber})` : ''}`,
    ...(r.description ? [`Request: ${clip(speakable(r.description), 600)}`] : []),
    ...(r.reply?.excerpt ? [`${who.name}'s latest reply: ${clip(speakable(r.reply.excerpt), 600)}`] : []),
    `Asked by ${who.name}${who.team ? ` (${who.team})` : ''} at ${it.createdAt}. The answer is posted in that conversation.`,
  ];
  const chatRef = r.chatRef as NonNullable<Request['chatRef']>;
  return {
    id: `q:${r.id}:${it.id}`,
    kind: 'question',
    urgency: it.status === 'overdue' ? 'high' : 'normal',
    agentSession: it.agent,
    agentName: who.name,
    ...(who.team ? { teamName: who.team } : {}),
    summary: spokenSummary('question', who.name, it.text),
    details: clip(lines.join('\n'), C.DETAILS_MAX_CHARS),
    options: [],
    acceptsText: true,
    sensitive: reason !== null,
    ...(reason ? { sensitiveReason: reason } : {}),
    answerTarget: { kind: 'thread', channelId: chatRef.channelId, threadId: chatRef.threadRootId, agentSession: it.agent },
    since: it.createdAt,
  };
}

/**
 * A ticket in 待验收 as a briefing item.
 *
 * @param t - Board row
 * @param who - Agent name / team
 * @param now - Clock
 * @returns Item
 */
export function reviewItem(t: TicketListItem, who: { name: string; team?: string }, now: Date): BriefingItem {
  const autoAt = t.autoAcceptAt ? Date.parse(t.autoAcceptAt) : NaN;
  const soon = !Number.isNaN(autoAt) && autoAt - now.getTime() <= C.REVIEW_SOON_MS;
  const reason = sensitiveReason([t.title, t.description]);
  const lines = [
    `Finished work: ${speakable(t.title)}${t.tkt ? ` (${t.tkt})` : ''}`,
    ...(t.description ? [`Asked for: ${clip(speakable(t.description), 600)}`] : []),
    ...(t.reply?.excerpt ? [`${who.name}'s answer: ${clip(speakable(t.reply.excerpt), 800)}`] : []),
    ...t.acceptance.filter((a) => a.text).map((a) => `Check: ${speakable(a.text)}`),
    ...(t.rejectCount > 0 ? [`Sent back ${t.rejectCount} time(s) before.`] : []),
    t.autoAcceptAt ? `If the owner says nothing it is accepted at ${t.autoAcceptAt}.` : 'It waits for the owner.',
  ];
  return {
    id: `t:${t.id}`,
    kind: 'review',
    urgency: soon ? 'normal' : 'low',
    agentSession: t.assignee ?? t.reply?.by ?? ORCHESTRATOR_SESSION_NAME,
    agentName: who.name,
    ...(who.team ? { teamName: who.team } : {}),
    summary: spokenSummary('review', who.name, t.title),
    details: clip(lines.join('\n'), C.DETAILS_MAX_CHARS),
    options: [
      { key: REVIEW_ACCEPT, label: 'Accept' },
      { key: REVIEW_SEND_BACK, label: 'Send back', detail: 'with what still needs fixing' },
    ],
    acceptsText: true,
    sensitive: reason !== null,
    ...(reason ? { sensitiveReason: reason } : {}),
    answerTarget: { kind: 'ticket', ticketId: t.id, ...(t.tkt ? { tkt: t.tkt } : {}) },
    since: t.submittedAt ?? t.updatedAt,
    ...(t.autoAcceptAt ? { deadline: t.autoAcceptAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * A trimmed, length-checked string, or null when absent / empty.
 *
 * @param value - Body value
 * @param max - Longest length
 * @returns Text or null
 * @throws BriefingError(400) when too long or not a string
 */
function cleanText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BriefingError(400, C.CODES.INVALID, 'Expected text.');
  const t = value.trim();
  if (t.length > max) throw new BriefingError(400, C.CODES.INVALID, `Too long (max ${max} characters).`);
  return t || null;
}

/**
 * The option an owner meant by a key or a label.
 *
 * @param item - Item
 * @param key - Key or label
 * @returns Option or undefined
 */
function matchOptionKey(item: BriefingItem, key: string): BriefingItem['options'][number] | undefined {
  const k = key.trim().toLowerCase();
  return item.options.find((o) => o.key.toLowerCase() === k) ?? item.options.find((o) => o.label.toLowerCase() === k);
}

/**
 * Run a decision call, turning its HTTP-like errors into briefing errors.
 *
 * @param fn - Call
 */
async function wrapDecisionError(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    throw new BriefingError(status, status === 404 ? C.CODES.NOT_FOUND : status >= 500 ? C.CODES.FAILED : C.CODES.INVALID, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Speakable reason a ticket action was refused.
 *
 * @param reason - Review refusal
 * @returns Text
 */
function reviewRefusal(reason: string): string {
  switch (reason) {
    case 'open_work':
      return 'Work on it is still running — it cannot be accepted yet.';
    case 'already_done':
      return 'It was already accepted.';
    case 'not_in_review':
      return 'It is no longer waiting for review.';
    case 'cancelled':
      return 'It was cancelled.';
    case 'not_found':
      return 'That ticket no longer exists.';
    default:
      return 'That did not work.';
  }
}

let instance: BriefingService | null = null;

/**
 * The running briefing service (null until boot wired it).
 *
 * @returns Service or null
 */
export function getBriefingService(): BriefingService | null {
  return instance;
}

/**
 * Install the briefing service (boot, tests).
 *
 * @param service - Service or null
 */
export function setBriefingService(service: BriefingService | null): void {
  instance = service;
}
