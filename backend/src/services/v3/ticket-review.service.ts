/**
 * TicketReviewService — the back half of the ticket loop
 * (specs/ticket-loop.md, Phase 2).
 *
 * Phase 1 files a ticket for every "please do X". This service decides when
 * a ticket is answered and what the owner does about it:
 *
 * - **Answered.** An agent message in the ticket's own conversation (matched
 *   through the chat-v2 turn that opened it, {@link TicketReviewService.noteChatTurn})
 *   is recorded as the ticket's `reply`. Once that agent is idle again (or the
 *   reply has settled for {@link TICKET_CONSTANTS.REVIEW.SUBMIT_SETTLE_MS}) and
 *   no WorkItem of the ticket is still open, the ticket is submitted: it goes
 *   to 待验收 (`waiting_confirmation`), or straight to done for origins that
 *   need no review. This replaces the old blind "close any open Request 3–10
 *   minutes old" sweep, which closed tickets that nobody had answered.
 * - **验过了** → done. **打回 + reason** → back to work; the reason becomes an
 *   acceptance criterion (#763: criteria grow from real review) and, when the
 *   owner sent it back from the board rather than the thread, a rework
 *   WorkItem is queued for whoever answered.
 * - **Silence accepts.** 待验收 for {@link TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS}
 *   with no word → done, tagged `auto_accepted`. The owner is never pinged.
 *
 * The `done` gate itself lives in {@link RequestService.update}: without
 * `accepted`, a ticket that needs review cannot become done by any path.
 *
 * @module services/v3/ticket-review.service
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { TICKET_CONSTANTS } from '../../constants.js';
import { isInterim } from '../slack/slack-typing-placeholder.service.js';
import {
  type Request,
  type RequestPriority,
  REQUEST_PRIORITIES,
  TERMINAL_REQUEST_STATUSES,
  isValidRequestTransition,
} from '../../types/v2/request.types.js';
import {
  type TicketAcceptance,
  type TicketAcceptanceCheck,
  type TicketKind,
  TICKET_KINDS,
  activeAcceptance,
  formatTicketNumber,
  parseTicketNumber,
  ticketNeedsReview,
} from '../../types/v2/ticket.types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Request store surface the review needs (narrow for tests). */
export interface ReviewRequestStore {
  getById(id: string): Promise<Request | null>;
  listAll(): Promise<Request[]>;
  update(id: string, updates: Parameters<import('./request.service.js').RequestService['update']>[1]): Promise<Request>;
}

/** The slice of a chat-v2 message the review reads. */
export interface ReviewChatMessage {
  id: string;
  channelId: string;
  senderType: string;
  senderId: string;
  content: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

/** A rework request for {@link TicketReviewServiceDeps.createRework}. */
export interface ReworkInput {
  ticket: Request;
  reason: string;
  /** Agent session to hand it to */
  target: string;
}

/** Constructor dependencies. */
export interface TicketReviewServiceDeps {
  requests: ReviewRequestStore;
  /** Number of the ticket's WorkItems that are not terminal */
  openWorkItemCount?: (requestId: string) => Promise<number>;
  /** Queue a rework WorkItem; returns its id */
  createRework?: (input: ReworkInput) => Promise<string | null>;
  /** Swap the receipt to "done" (🎫 → ✅) */
  markReceiptDone?: (ticket: Request) => Promise<void>;
  /**
   * Deliver a note to the agent that answered, asking it to follow up with
   * the owner itself. Absent → silence accepts after AUTO_ACCEPT_MS.
   */
  nudgeAgent?: (agentSession: string, text: string) => Promise<void>;
  /** Session the rework goes to when nobody answered (the orchestrator) */
  fallbackAgent: string;
  now?: () => Date;
}

/** Result of an owner action. */
export type ReviewActionResult =
  | { ok: true; ticket: Request }
  | { ok: false; reason: 'not_found' | 'not_in_review' | 'already_done' | 'cancelled' | 'open_work' | 'invalid' ; ticket?: Request };

/** Where a 打回 came from. */
export type RejectVia = 'thread' | 'board';

/** Fields the owner may change from the board. */
export interface TicketPatch {
  title?: string;
  priority?: RequestPriority;
  kind?: TicketKind;
  assignee?: string | null;
}

/** Statuses in which an agent answer can submit a ticket. */
const SUBMITTABLE = new Set(['open', 'ready', 'running']);

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Review lifecycle of tickets. See module docs.
 */
export class TicketReviewService {
  private readonly logger: ComponentLogger;
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param deps - Store and optional pool / receipt hooks
   */
  constructor(private readonly deps: TicketReviewServiceDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('TicketReview');
  }

  /**
   * Run one state change at a time, so an idle event and the sweep cannot
   * submit the same ticket twice.
   *
   * @param fn - The change
   * @returns Its result
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // -------------------------------------------------------------------------
  // Answer detection
  // -------------------------------------------------------------------------

  /**
   * Remember the chat-v2 turn that opened a ticket, so agent answers in the
   * same thread can be matched to it. Only the first turn counts.
   *
   * @param ticketId - The ticket
   * @param message - The owner's persisted message
   */
  async noteChatTurn(ticketId: string, message: Pick<ReviewChatMessage, 'id' | 'channelId' | 'threadId'>): Promise<void> {
    await this.serial(async () => {
      const ticket = await this.deps.requests.getById(ticketId);
      if (!ticket || ticket.chatRef) return;
      await this.deps.requests.update(ticketId, {
        chatRef: { channelId: message.channelId, messageId: message.id, threadRootId: message.threadId ?? message.id },
      });
    });
  }

  /**
   * An agent posted in chat-v2: record it as the answer of the ticket whose
   * thread it is in. Top-level agent messages (no thread) count for the newest
   * open ticket in that channel that the agent could be answering.
   *
   * @param message - The chat-v2 message
   * @returns The ticket it was recorded on, or null
   */
  async onChatMessage(message: ReviewChatMessage): Promise<Request | null> {
    if (message.senderType !== 'agent') return null;
    // "Got it — here is my plan" is not the answer.
    if (isInterim(message)) return null;
    return this.serial(async () => {
      const all = await this.deps.requests.listAll();
      const inChannel = all.filter(
        (r) =>
          typeof r.ticketNumber === 'number' &&
          r.chatRef?.channelId === message.channelId &&
          !TERMINAL_REQUEST_STATUSES.has(r.status) &&
          (!r.assignee || r.assignee === message.senderId || message.threadId !== undefined),
      );
      if (inChannel.length === 0) return null;
      const ticket = message.threadId
        ? inChannel.find((r) => r.chatRef?.threadRootId === message.threadId || r.chatRef?.messageId === message.threadId) ?? null
        : inChannel[0]; // listAll is newest-first
      if (!ticket) return null;
      const excerpt = message.content.trim().slice(0, TICKET_CONSTANTS.REVIEW.REPLY_EXCERPT_MAX);
      const updated = await this.deps.requests.update(ticket.id, {
        reply: { at: this.now().toISOString(), by: message.senderId, messageId: message.id, excerpt },
        // Somebody is on it.
        ...(ticket.status === 'open' || ticket.status === 'ready' ? { status: 'running' as const } : {}),
      });
      return updated;
    });
  }

  /**
   * An agent finished its turn: submit the tickets it answered.
   *
   * @param sessionName - The agent
   * @returns Tickets submitted
   */
  async onAgentIdle(sessionName: string): Promise<Request[]> {
    return this.serial(() => this.submitAnswered((t) => t.reply?.by === sessionName));
  }

  /**
   * Periodic pass: submit answers that have settled (in case no idle event
   * came), and auto-accept 待验收 tickets nobody objected to.
   *
   * @returns What changed
   */
  async sweep(): Promise<{ submitted: number; autoAccepted: number }> {
    return this.serial(async () => {
      const settleBefore = this.now().getTime() - TICKET_CONSTANTS.REVIEW.SUBMIT_SETTLE_MS;
      const submitted = await this.submitAnswered((t) => !!t.reply && Date.parse(t.reply.at) <= settleBefore);
      const now = this.now().getTime();
      let autoAccepted = 0;
      let nudged = 0;
      for (const t of await this.deps.requests.listAll()) {
        if (t.status !== 'waiting_confirmation' || !ticketNeedsReview(t) || !t.submittedAt) continue;
        const agent = t.reply?.by ?? t.assignee;
        if (this.deps.nudgeAgent && agent) {
          // The agent asks the owner itself; silence gets it to ask again, up
          // to MAX_NUDGES times, and only then counts as acceptance.
          const since = Date.parse(t.lastNudgeAt ?? t.submittedAt);
          if (now - since < TICKET_CONSTANTS.REVIEW.NUDGE_AFTER_MS) continue;
          if ((t.nudgeCount ?? 0) < TICKET_CONSTANTS.REVIEW.MAX_NUDGES) {
            const ok = await this.deps
              .nudgeAgent(agent, nudgeText(t, now))
              .then(() => true)
              .catch((err: unknown) => {
                this.logger.debug('Nudge could not be delivered', { id: t.id, error: errText(err) });
                return false;
              });
            if (ok) {
              await this.deps.requests.update(t.id, { nudgeCount: (t.nudgeCount ?? 0) + 1, lastNudgeAt: new Date(now).toISOString() });
              nudged += 1;
            }
            continue;
          }
        } else if (now - Date.parse(t.submittedAt) < TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS) {
          continue;
        }
        const tags = [...new Set([...t.tags, TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG])];
        const r = await this.accept(t, tags);
        if (r.ok) autoAccepted += 1;
      }
      if (submitted.length > 0 || autoAccepted > 0 || nudged > 0) {
        this.logger.info('Ticket review sweep', { submitted: submitted.length, autoAccepted, nudged });
      }
      return { submitted: submitted.length, autoAccepted };
    });
  }

  /**
   * Submit every answered ticket that matches and has no open work.
   *
   * @param match - Which answered tickets to look at
   * @returns Tickets submitted
   */
  private async submitAnswered(match: (t: Request) => boolean): Promise<Request[]> {
    const out: Request[] = [];
    for (const t of await this.deps.requests.listAll()) {
      if (typeof t.ticketNumber !== 'number' || !SUBMITTABLE.has(t.status) || !t.reply) continue;
      // Answered since the last submit only.
      if (t.submittedAt && Date.parse(t.reply.at) <= Date.parse(t.submittedAt)) continue;
      if (!match(t)) continue;
      if (this.deps.openWorkItemCount && (await this.deps.openWorkItemCount(t.id)) > 0) continue;
      try {
        // `done` without `accepted`: the RequestService gate turns it into
        // 待验收 when the ticket needs review.
        const base = t.status === 'ready' ? await this.deps.requests.update(t.id, { status: 'running' }) : t;
        const updated = await this.deps.requests.update(base.id, { status: 'done', result: t.reply.excerpt });
        out.push(updated);
        this.logger.info('Ticket answered', { tkt: tkt(updated), status: updated.status, by: t.reply.by });
        if (updated.status === 'done') await this.receiptDone(updated);
      } catch (err) {
        this.logger.debug('Ticket could not be submitted', { id: t.id, error: errText(err) });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Owner actions
  // -------------------------------------------------------------------------

  /**
   * 验过了 — the owner accepts. Works from any open status (the owner may
   * accept before the agent says it is finished), but not while WorkItems
   * are still running.
   *
   * @param ref - `TKT-123`, `123` or id
   * @returns The accepted ticket, or why not
   */
  async verify(ref: string): Promise<ReviewActionResult> {
    return this.serial(async () => {
      const ticket = await this.resolve(ref);
      if (!ticket) return { ok: false, reason: 'not_found' };
      return this.accept(ticket, ticket.tags);
    });
  }

  /**
   * Move a ticket to done with the owner's (or the auto-accept's) blessing.
   *
   * @param ticket - The ticket
   * @param tags - Tags to store
   * @returns Result
   */
  private async accept(ticket: Request, tags: string[]): Promise<ReviewActionResult> {
    if (ticket.status === 'done') return { ok: false, reason: 'already_done', ticket };
    if (ticket.status === 'cancelled') return { ok: false, reason: 'cancelled', ticket };
    try {
      let current = ticket;
      if (!isValidRequestTransition(current.status, 'done') && isValidRequestTransition(current.status, 'running')) {
        current = await this.deps.requests.update(current.id, { status: 'running' });
      }
      const updated = await this.deps.requests.update(current.id, { status: 'done', accepted: true, tags });
      this.logger.info('Ticket accepted', { tkt: tkt(updated), auto: tags.includes(TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG) });
      await this.receiptDone(updated);
      return { ok: true, ticket: updated };
    } catch (err) {
      if (err instanceof Error && err.name === 'RequestStillHasOpenChildrenError') {
        return { ok: false, reason: 'open_work', ticket };
      }
      throw err;
    }
  }

  /**
   * 打回 — the owner sends it back. The reason becomes an acceptance
   * criterion; from the board (not the thread, where the agent already sees
   * the owner's words) a rework WorkItem is queued for whoever answered.
   *
   * @param ref - `TKT-123`, `123` or id
   * @param reason - Why (required; the thread path fills a placeholder)
   * @param via - `thread` or `board`
   * @returns The reopened ticket, or why not
   */
  async reject(ref: string, reason: string, via: RejectVia): Promise<ReviewActionResult> {
    const why = reason.trim();
    if (!why) return { ok: false, reason: 'invalid' };
    return this.serial(async () => {
      const ticket = await this.resolve(ref);
      if (!ticket) return { ok: false, reason: 'not_found' };
      if (ticket.status !== 'waiting_confirmation') return { ok: false, reason: 'not_in_review', ticket };
      const at = this.now().toISOString();
      const acceptance: TicketAcceptance[] = [
        ...(ticket.acceptance ?? []),
        { text: why, source: 'reject', check: 'judgment', addedAt: at },
      ];
      const discussion = [...(ticket.discussion ?? []), { at, author: 'owner', text: `打回：${why}`, ref: `reject-${at}` }];
      const updated = await this.deps.requests.update(ticket.id, {
        status: 'running',
        rejectCount: (ticket.rejectCount ?? 0) + 1,
        acceptance,
        discussion,
      });
      this.logger.info('Ticket sent back', { tkt: tkt(updated), via, rejectCount: updated.rejectCount });
      if (via === 'board' && this.deps.createRework) {
        const target = ticket.reply?.by ?? ticket.assignee ?? ticket.ownerAgent ?? this.deps.fallbackAgent;
        await this.deps.createRework({ ticket: updated, reason: why, target }).catch((err: unknown) => {
          this.logger.warn('Rework could not be queued', { id: ticket.id, error: errText(err) });
        });
      }
      return { ok: true, ticket: updated };
    });
  }

  /**
   * A follow-up from the owner in a 待验收 ticket's thread that is neither
   * 验过了 nor 打回: the agent is working again, so the ticket leaves 待验收
   * (no reject counted).
   *
   * @param ticketId - The ticket
   * @returns The ticket after the change
   */
  async reopenOnFollowUp(ticketId: string): Promise<Request | null> {
    return this.serial(async () => {
      const ticket = await this.deps.requests.getById(ticketId);
      if (!ticket || ticket.status !== 'waiting_confirmation') return ticket;
      return this.deps.requests.update(ticketId, { status: 'running' });
    });
  }

  /**
   * Replace the live acceptance list. Criteria not in `items` are marked
   * removed (kept for history); new texts are added as the owner's.
   *
   * @param ref - Ticket reference
   * @param items - The list the owner wants, in order
   * @returns The ticket
   */
  async setAcceptance(ref: string, items: ReadonlyArray<{ text: string; check?: TicketAcceptanceCheck }>): Promise<ReviewActionResult> {
    return this.serial(async () => {
      const ticket = await this.resolve(ref);
      if (!ticket) return { ok: false, reason: 'not_found' };
      const at = this.now().toISOString();
      const wanted = items.map((i) => ({ text: i.text.trim(), check: i.check })).filter((i) => i.text.length > 0);
      const wantedTexts = new Set(wanted.map((w) => w.text));
      const existing = ticket.acceptance ?? [];
      const kept = existing.map((a) => (!a.removedAt && !wantedTexts.has(a.text) ? { ...a, removedAt: at } : a));
      const liveTexts = new Set(activeAcceptance(kept).map((a) => a.text));
      const updatedList = kept.map((a) => {
        const w = wanted.find((x) => x.text === a.text);
        return !a.removedAt && w?.check ? { ...a, check: w.check } : a;
      });
      for (const w of wanted) {
        if (liveTexts.has(w.text)) continue;
        updatedList.push({ text: w.text, source: 'owner', check: w.check ?? 'judgment', addedAt: at });
        liveTexts.add(w.text);
      }
      const updated = await this.deps.requests.update(ticket.id, { acceptance: updatedList });
      return { ok: true, ticket: updated };
    });
  }

  /**
   * An agent's self-check against one live criterion.
   *
   * @param ref - Ticket reference
   * @param index - Position in the live list (0-based)
   * @param result - pass / fail
   * @param evidence - What it looked at
   * @returns The ticket
   */
  async selfCheck(ref: string, index: number, result: 'pass' | 'fail', evidence?: string): Promise<ReviewActionResult> {
    return this.serial(async () => {
      const ticket = await this.resolve(ref);
      if (!ticket) return { ok: false, reason: 'not_found' };
      const live = activeAcceptance(ticket.acceptance);
      const target = live[index];
      if (!target) return { ok: false, reason: 'invalid', ticket };
      const acceptance = (ticket.acceptance ?? []).map((a) =>
        a === target ? { ...a, selfCheck: result, ...(evidence ? { evidence } : {}) } : a,
      );
      const updated = await this.deps.requests.update(ticket.id, { acceptance });
      return { ok: true, ticket: updated };
    });
  }

  /**
   * Board edits: title, priority, kind, assignee.
   *
   * @param ref - Ticket reference
   * @param patch - Changes
   * @returns The ticket
   */
  async patch(ref: string, patch: TicketPatch): Promise<ReviewActionResult> {
    if (patch.priority !== undefined && !REQUEST_PRIORITIES.includes(patch.priority)) return { ok: false, reason: 'invalid' };
    if (patch.kind !== undefined && !TICKET_KINDS.includes(patch.kind)) return { ok: false, reason: 'invalid' };
    if (patch.title !== undefined && patch.title.trim().length === 0) return { ok: false, reason: 'invalid' };
    return this.serial(async () => {
      const ticket = await this.resolve(ref);
      if (!ticket) return { ok: false, reason: 'not_found' };
      const updated = await this.deps.requests.update(ticket.id, {
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.assignee !== undefined ? { assignee: patch.assignee ?? '' } : {}),
      });
      return { ok: true, ticket: updated };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Find a ticket by `TKT-123`, `123` or id.
   *
   * @param ref - Reference
   * @returns The ticket, or null
   */
  private async resolve(ref: string): Promise<Request | null> {
    const trimmed = (ref ?? '').trim();
    if (!trimmed) return null;
    const byId = await this.deps.requests.getById(trimmed);
    if (byId) return byId;
    const n = parseTicketNumber(trimmed);
    if (n === null) return null;
    return (await this.deps.requests.listAll()).find((r) => r.ticketNumber === n) ?? null;
  }

  /**
   * Best-effort receipt swap.
   *
   * @param ticket - The done ticket
   */
  private async receiptDone(ticket: Request): Promise<void> {
    if (!this.deps.markReceiptDone || !ticket.receipt) return;
    await this.deps.markReceiptDone(ticket).catch((err: unknown) => {
      this.logger.debug('Receipt could not be marked done', { id: ticket.id, error: errText(err) });
    });
  }

  /**
   * Current time (injectable for tests).
   *
   * @returns Now
   */
  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
}

/**
 * The note an agent gets when the owner has not answered its question yet.
 * Written for the agent, not the owner: it must not say "ticket" to them.
 *
 * @param t - The ticket
 * @param now - Current time (ms)
 * @returns Message text
 */
export function nudgeText(t: Request, now: number): string {
  const hours = Math.max(1, Math.round((now - Date.parse(t.lastNudgeAt ?? t.submittedAt ?? t.updatedAt)) / 3_600_000));
  const marker = typeof t.ticketNumber === 'number' ? `[TICKET:${formatTicketNumber(t.ticketNumber)} ${t.id}] ` : '';
  const cmd = t.chatRef
    ? ` 回复命令: bash config/skills/agent/core/reply-channel/execute.sh --channel ${t.chatRef.channelId} --thread ${t.chatRef.threadRootId} --content "<一两句>"`
    : '';
  return (
    `${marker}你之前回答的「${t.title}」已经过了约 ${hours} 小时，对方还没回应。` +
    `如果这件事需要对方确认结果（交付物、改动、需要拍板的），在原来的对话里用一两句自然的话问一下这样行不行——不要提工单、编号或"验收"这类词；` +
    `如果只是回答了问题、不需要确认，什么都不用做。` +
    cmd
  );
}

/**
 * Display number of a ticket.
 *
 * @param t - Ticket
 * @returns `TKT-123` or null
 */
function tkt(t: Request): string | null {
  return typeof t.ticketNumber === 'number' ? formatTicketNumber(t.ticketNumber) : null;
}

/**
 * Error message of anything thrown.
 *
 * @param err - Thrown value
 * @returns Message
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: TicketReviewService | null = null;

/**
 * Install the process-wide review service (composition root).
 *
 * @param service - The service, or null to clear (tests)
 */
export function setTicketReviewService(service: TicketReviewService | null): void {
  instance = service;
}

/**
 * The process-wide review service, or null before boot wired it.
 *
 * @returns The service or null
 */
export function getTicketReviewService(): TicketReviewService | null {
  return instance;
}
