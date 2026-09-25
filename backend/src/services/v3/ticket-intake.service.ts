/**
 * TicketIntakeService — the single intake point of the ticket loop
 * (specs/ticket-loop.md, Phase 1 §1).
 *
 * Every surface the owner talks on (Slack team channels and shared rooms,
 * Slack agent DMs, chat-v2 — which covers the dashboard, portal and phone —
 * and the legacy chat + legacy Slack bridge) hands its inbound owner message
 * to {@link TicketIntakeService.intake}. The service decides, with one shared
 * gate, whether the message:
 *
 * - opens a new ticket (a `Request` with a TKT number, `kind`, `origin`,
 *   `assignee`) and posts ONE receipt where it was said;
 * - is a follow-up in a thread that already has an open ticket, and is
 *   appended to that ticket's discussion instead;
 * - is "不用记" (don't track) and dismisses the ticket it answers;
 * - is noise (trivial ack, file only, a question, agent-authored) and is
 *   ignored.
 *
 * Creation goes through {@link RequestService.create}, so `request:created`
 * still fires and the decompose + SLA subscribers keep working unchanged.
 *
 * @module services/v3/ticket-intake.service
 */

import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { modifyJsonFile } from '../../utils/file-io.utils.js';
import { TICKET_CONSTANTS } from '../../constants.js';
import {
  type Request,
  type RequestStatus,
  TERMINAL_REQUEST_STATUSES,
  isValidRequestTransition,
} from '../../types/v2/request.types.js';
import {
  type TicketOrigin,
  type TicketReceipt,
  type TicketKind,
  type TicketBoardColumn,
  type TicketPriorityLabel,
  type BoardWorkItemView,
  formatTicketNumber,
  parseTicketNumber,
  deriveBoardColumn,
  ticketPriorityLabel,
  inferTicketKind,
  uniqueTicketIdFromTexts,
  parseReviewReply,
  activeAcceptance,
  ticketNeedsReview,
  type ReviewReply,
  type TicketAcceptance,
  type TicketReply,
} from '../../types/v2/ticket.types.js';

// ---------------------------------------------------------------------------
// Suppression gate (moved here from SlackOrchestratorBridge so every channel
// uses the same rules)
// ---------------------------------------------------------------------------

/**
 * Trimmed-text regex for trivial acknowledgement messages — anchored,
 * case-insensitive, allows trailing punctuation. Matches "ok", "好的",
 * "thx", "👍", etc.
 */
const TRIVIAL_ACK_PATTERN = /^(ok|okay|好的|好|收到|thx|thanks|thank you|谢谢|多谢|👍|✅|got it|sure|yes|是|对|对的|嗯|嗯嗯|行)\W*$/iu;

/**
 * Trimmed-text regex matching the synthetic `[Slack File: …]` lines the
 * Slack bridge appends for uploaded files.
 */
const FILE_REFERENCE_LINE = /\[Slack File:[^\]]*\]\.?/g;

/** CJK ideographs, kana and hangul count double towards the length gate. */
const WIDE_CHAR = /[぀-ヿ㐀-䶿一-鿿가-힯]/u;

/**
 * Length of a text for the length gate, counting wide (CJK) characters twice:
 * a Chinese sentence says as much in 7 characters as an English one in 14.
 *
 * @param text - Trimmed text
 * @returns Weighted length
 */
export function weightedTextLength(text: string): number {
  let n = 0;
  for (const ch of text) n += WIDE_CHAR.test(ch) ? 2 : 1;
  return n;
}

/**
 * Gate 1 — trivial acknowledgement or too short to be a request.
 *
 * @param rawText - Message text
 * @returns `'trivial_or_short'` when suppressed, else null
 */
export function suppressTrivialOrShort(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (weightedTextLength(trimmed) < TICKET_CONSTANTS.MIN_WEIGHTED_TEXT_LENGTH || TRIVIAL_ACK_PATTERN.test(trimmed)) {
    return 'trivial_or_short';
  }
  return null;
}

/**
 * Gate 3 — only file references (or only attachments), no narrative.
 *
 * @param rawText - Message text (may carry `[Slack File: …]` lines)
 * @param hasAttachments - Whether the message carried files
 * @returns `'file_only'` when suppressed, else null
 */
export function suppressFileOnly(rawText: string, hasAttachments = false): string | null {
  const trimmed = rawText.trim();
  const hadReference = FILE_REFERENCE_LINE.test(trimmed);
  FILE_REFERENCE_LINE.lastIndex = 0;
  const narrative = trimmed.replace(FILE_REFERENCE_LINE, '').trim();
  if ((hadReference || hasAttachments) && narrative.length === 0) return 'file_only';
  return null;
}

/**
 * Text a ticket title is made from: Slack's raw `<@U0C2ZK849ND>` mention codes
 * and `<https://…|label>` links read as noise on the board (2026-09-24:
 * "[Message] <@U0C2ZK849ND> 看看这个"), so mentions go and links keep their
 * label (or the bare URL).
 *
 * @param text - Message text
 * @returns Cleaned text (the ticket description keeps the original)
 */
export function titleText(text: string): string {
  const cleaned = text
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, '')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || text.trim();
}

/**
 * Whether a message is the "don't track" action.
 *
 * @param text - Message text
 * @returns True for "不用记" and its variants
 */
export function isDismissText(text: string): boolean {
  return TICKET_CONSTANTS.DISMISS_PATTERN.test(text);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where a receipt should be posted. */
export type ReceiptTarget =
  | {
      kind: 'slack';
      slackChannelId: string;
      /** Thread to reply in (the message's thread root, or the message itself) */
      threadTs: string;
      /** Agent whose bot posts it (DMs, private rooms); absent = workspace bot */
      postAs?: string;
      /**
       * The owner's own message. When set, the receipt is a 🎫 reaction on it
       * instead of a thread reply: a reply per ticket was one more message
       * (and notification) in every thread, next to the agent's own "working
       * on it" (owner, 2026-09-24: 「每次都要问一下会不会很麻烦」).
       */
      messageTs?: string;
    }
  | {
      kind: 'chat-v2';
      chatChannelId: string;
      /** Thread root the receipt goes under */
      threadId?: string;
    };

/** One inbound message handed to intake. */
export interface IntakeMessage {
  /** Message text as the owner wrote it (file references allowed) */
  text: string;
  /** Where and by whom */
  origin: TicketOrigin;
  /** Attached files, when any */
  attachments?: ReadonlyArray<{ name?: string }>;
  /** True only for the owner's own words — agent-authored text never opens a ticket */
  isOwner: boolean;
  /** The agent the message was addressed to (becomes `assignee`) */
  targetAgent?: string;
  /**
   * Conversation the message belongs to (a Slack channel, a chat-v2 channel).
   * A top-level "不用记" dismisses the latest open ticket from it. Must be the
   * prefix of `origin.threadRef` (`<conversationRef>:<thread root>`).
   */
  conversationRef?: string;
  /**
   * sourceConversationItemId of the thread root as older (pre-ticket) code
   * stored it, so a reply in a thread opened before the ticket loop still
   * counts as a continuation.
   */
  legacyThreadParentRef?: string;
  /** Extra tags (e.g. `slack` / `chat-v2` for the SLA subscriber) */
  tags?: readonly string[];
  /** Where to post the receipt; omitted = no receipt */
  receipt?: ReceiptTarget;
}

/** What intake did with a message. */
export type IntakeOutcome =
  | { action: 'created'; ticket: Request }
  | { action: 'appended'; ticket: Request }
  | { action: 'duplicate'; ticket: Request }
  | { action: 'dismissed'; ticket: Request }
  /** 验过了 on a 待验收 ticket (Phase 2) */
  | { action: 'verified'; ticket: Request }
  /** 打回 on a 待验收 ticket (Phase 2) */
  | { action: 'rejected'; ticket: Request }
  | { action: 'ignored'; reason: string };

/** The review actions intake hands 验过了 / 打回 / follow-ups to (TicketReviewService). */
export interface IntakeReviewHandler {
  verify(ref: string): Promise<{ ok: boolean; ticket?: Request }>;
  reject(ref: string, reason: string, via: 'thread'): Promise<{ ok: boolean; ticket?: Request }>;
  reopenOnFollowUp(ticketId: string): Promise<Request | null>;
}

/** Posts and edits receipts on one kind of surface. */
export interface TicketReceiptSink {
  /**
   * Post the receipt for a new ticket.
   *
   * @param ticket - The ticket
   * @param target - Where to post
   * @returns Where it landed, or null when it could not be posted
   */
  post(ticket: Request, target: ReceiptTarget): Promise<TicketReceipt | null>;
  /**
   * Change an existing receipt to "已取消记录".
   *
   * @param ticket - The dismissed ticket
   * @param receipt - The receipt to edit
   */
  markDismissed(ticket: Request, receipt: TicketReceipt): Promise<void>;
  /**
   * Change an existing receipt to "done" (Phase 2).
   *
   * @param ticket - The accepted ticket
   * @param receipt - The receipt to edit
   */
  markDone?(ticket: Request, receipt: TicketReceipt): Promise<void>;
}

/** RequestService surface the intake needs (narrow for tests). */
export interface TicketRequestStore {
  create(input: Parameters<import('./request.service.js').RequestService['create']>[0]): Promise<Request>;
  getById(id: string): Promise<Request | null>;
  listAll(): Promise<Request[]>;
  update(id: string, updates: Parameters<import('./request.service.js').RequestService['update']>[1]): Promise<Request>;
  getRequestsDir(): string;
}

/** Board-shaped ticket row returned by the API. */
export interface TicketListItem {
  id: string;
  tkt: string | null;
  ticketNumber: number | null;
  title: string;
  description: string;
  kind: TicketKind;
  column: TicketBoardColumn;
  status: RequestStatus;
  priority: Request['priority'];
  priorityLabel: TicketPriorityLabel;
  origin: TicketOrigin | null;
  assignee: string | null;
  workItemIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Live acceptance criteria (removed ones left out) */
  acceptance: TicketAcceptance[];
  /** Start of the latest agent answer */
  reply: TicketReply | null;
  rejectCount: number;
  submitCount: number;
  /** When it last went to 待验收 */
  submittedAt: string | null;
  completedAt: string | null;
  /** When silence will accept it (待验收 only) */
  autoAcceptAt: string | null;
}

/** Filters for {@link TicketIntakeService.list}. */
export interface TicketListQuery {
  column?: TicketBoardColumn;
  kind?: TicketKind;
  /** Case-insensitive search over TKT, title and description */
  q?: string;
  /** Include Requests from before the ticket loop (no TKT number) */
  includeLegacy?: boolean;
}

/** Result of {@link TicketIntakeService.dismiss}. */
export type DismissResult =
  | { ok: true; ticket: Request; alreadyDismissed: boolean }
  | { ok: false; reason: 'not_found' | 'already_done' | 'invalid_transition'; ticket?: Request };

/** Constructor dependencies. */
export interface TicketIntakeServiceDeps {
  requests: TicketRequestStore;
  /** WorkItem lookup for the derived board column (optional) */
  findWorkItem?: (id: string) => Promise<BoardWorkItemView | null | undefined>;
  now?: () => Date;
  /** Post receipts (default {@link TICKET_CONSTANTS.RECEIPT.ENABLED}, i.e. off) */
  receiptsEnabled?: boolean;
}

/** Counter file shape. */
interface TicketCounterFile {
  /** Last number handed out; -1 = not yet seeded from existing tickets */
  last: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Single intake point for owner messages → tickets. See module docs.
 */
export class TicketIntakeService {
  private readonly logger: ComponentLogger;
  private readonly sinks: Partial<Record<ReceiptTarget['kind'], TicketReceiptSink>> = {};
  /** Serialises intake so two messages in one thread cannot both open a ticket. */
  private chain: Promise<unknown> = Promise.resolve();
  /** 验过了 / 打回 handler (Phase 2); absent = those words are plain follow-ups */
  private review: IntakeReviewHandler | null = null;

  /**
   * @param deps - Request store and optional WorkItem lookup
   */
  constructor(private readonly deps: TicketIntakeServiceDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('TicketIntake');
  }

  /**
   * Register the receipt poster for a surface.
   *
   * @param kind - `slack` or `chat-v2`
   * @param sink - The poster, or null to remove
   */
  setReceiptSink(kind: ReceiptTarget['kind'], sink: TicketReceiptSink | null): void {
    if (sink) this.sinks[kind] = sink;
    else delete this.sinks[kind];
  }

  /**
   * Wire the review handler (Phase 2).
   *
   * @param handler - The handler, or null to remove
   */
  setReviewHandler(handler: IntakeReviewHandler | null): void {
    this.review = handler;
  }

  /**
   * Mark a ticket's receipt done (🎫 → ✅ on Slack, 「已完成」 in chat-v2).
   *
   * @param ticket - The done ticket
   */
  async markReceiptDone(ticket: Request): Promise<void> {
    if (!ticket.receipt) return;
    const sink = this.sinks[ticket.receipt.kind];
    if (sink?.markDone) await sink.markDone(ticket, ticket.receipt);
  }

  /**
   * Spec entry point: take one inbound message.
   *
   * @param message - The message
   * @returns The ticket the message now belongs to (new, appended-to or
   *   dedupe hit), or null when it opened nothing
   */
  async intake(message: IntakeMessage): Promise<Request | null> {
    const outcome = await this.intakeWithOutcome(message);
    return outcome.action === 'created' || outcome.action === 'appended' || outcome.action === 'duplicate'
      ? outcome.ticket
      : null;
  }

  /**
   * Take one inbound message and say what happened to it.
   *
   * Never throws: a failure is logged and reported as `ignored`, because
   * intake must never stop a message from being delivered.
   *
   * @param message - The message
   * @returns The outcome
   */
  intakeWithOutcome(message: IntakeMessage): Promise<IntakeOutcome> {
    const run = this.chain.then(() => this.process(message));
    this.chain = run.catch(() => undefined);
    return run.catch((err: unknown) => {
      this.logger.warn('Ticket intake failed (message still delivered)', {
        ref: message.origin.ref,
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: 'ignored', reason: 'error' } as IntakeOutcome;
    });
  }

  /**
   * The gate, in order. See module docs.
   *
   * @param message - The message
   * @returns The outcome
   */
  private async process(message: IntakeMessage): Promise<IntakeOutcome> {
    if (!message.isOwner) return this.ignored(message, 'not_owner');
    const text = (message.text ?? '').trim();
    const all = await this.deps.requests.listAll();

    // "不用记" — the owner undoing the ticket this message answers.
    if (isDismissText(text)) {
      const target = this.findDismissTarget(all, message);
      if (!target) return this.ignored(message, 'dismiss_without_ticket');
      const result = await this.dismissTicket(target);
      if (!result.ok) return this.ignored(message, `dismiss_${result.reason}`);
      return { action: 'dismissed', ticket: result.ticket };
    }

    // Same message twice (Slack redelivery, two event types).
    const duplicate = all.find((r) => r.sourceConversationItemId === message.origin.ref);
    if (duplicate) return { action: 'duplicate', ticket: duplicate };

    // A follow-up in a thread that already has a ticket.
    const threadTicket = this.findThreadTicket(all, message);
    const review = parseReviewReply(text);
    // The agent asked "is this OK?" in its own words; a plain 「好的」「可以」
    // back is the OK (2026-09-24).
    const ack = TICKET_CONSTANTS.REVIEW.ACK_PATTERN.test(text);
    if (threadTicket) {
      if (TERMINAL_REQUEST_STATUSES.has(threadTicket.status)) {
        // Only a dismissed thread stays quiet; a finished one may open a new ticket.
        if (threadTicket.tags.includes(TICKET_CONSTANTS.DISMISSED_TAG)) {
          return this.ignored(message, 'thread_dismissed');
        }
      } else if (threadTicket.status === 'waiting_confirmation' && this.review) {
        if (review) return this.applyReview(threadTicket, review);
        if (ack) return this.applyReview(threadTicket, { action: 'verify' });
        // Anything else from the owner: the agent is back on it.
        await this.review.reopenOnFollowUp(threadTicket.id);
        return this.appendToTicket(threadTicket, message, text);
      } else {
        return this.appendToTicket(threadTicket, message, text);
      }
    }

    // 验过了 / 打回 outside a thread (DMs, where every message is top-level):
    // the newest 待验收 ticket of this conversation.
    if ((review || ack) && this.review && message.conversationRef) {
      const conversation = message.conversationRef;
      const inReview = all.find(
        (r) => r.status === 'waiting_confirmation' && typeof r.ticketNumber === 'number' && this.conversationMatches(r, conversation),
      );
      // A bare 「好的」 only counts while the agent's question is recent — the
      // owner says 「好的」 to plenty of other things in a DM.
      const recent =
        inReview &&
        this.now().getTime() - Date.parse(inReview.lastNudgeAt ?? inReview.submittedAt ?? inReview.updatedAt) <
          TICKET_CONSTANTS.REVIEW.NUDGE_AFTER_MS;
      if (inReview && (review || recent)) return this.applyReview(inReview, review ?? { action: 'verify' });
    }

    const trivial = suppressTrivialOrShort(text);
    if (trivial) return this.ignored(message, trivial);
    const fileOnly = suppressFileOnly(text, (message.attachments?.length ?? 0) > 0);
    if (fileOnly) return this.ignored(message, fileOnly);

    // Lazy: v3-data pulls in the pool and storage singletons, which the Slack
    // modules that import this service must not load at module time.
    const { classifyIntent, generateRequestTitle } = await import('./v3-data.service.js');
    const { intentLevel, intentCategory } = classifyIntent(text);
    if (intentCategory === 'query') return this.ignored(message, 'query');
    if (intentLevel === 'L0') return this.ignored(message, 'not_actionable');

    const ticketNumber = await this.nextTicketNumber(all);
    const tags = [...new Set([TICKET_CONSTANTS.TAG, message.origin.channel, ...(message.tags ?? [])])];
    const ticket = await this.deps.requests.create({
      sourceConversationItemId: message.origin.ref,
      title: generateRequestTitle(titleText(text), intentCategory),
      description: text,
      priority: 'normal',
      tags,
      intentLevel,
      intentCategory,
      ticketNumber,
      kind: inferTicketKind(text),
      origin: message.origin,
      // Phase 2: the owner accepts it (or silence does); cron / mission close alone.
      requiresConfirmation:
        !TICKET_CONSTANTS.REVIEW.NO_REVIEW_ORIGINS.includes(message.origin.channel) &&
        !TICKET_CONSTANTS.REVIEW.NO_REVIEW_CATEGORIES.includes(intentCategory),
      ...(message.targetAgent ? { assignee: message.targetAgent } : {}),
    });
    this.logger.info('Ticket created', {
      tkt: formatTicketNumber(ticketNumber),
      id: ticket.id,
      channel: message.origin.channel,
      assignee: message.targetAgent,
    });
    if (message.receipt) void this.postReceipt(ticket, message.receipt);
    return { action: 'created', ticket };
  }

  /**
   * Hand a 验过了 / 打回 to the review handler.
   *
   * @param ticket - The 待验收 ticket
   * @param review - What the owner said
   * @returns The outcome
   */
  private async applyReview(ticket: Request, review: NonNullable<ReviewReply>): Promise<IntakeOutcome> {
    const handler = this.review;
    if (!handler) return { action: 'appended', ticket };
    const result =
      review.action === 'verify' ? await handler.verify(ticket.id) : await handler.reject(ticket.id, review.reason, 'thread');
    const after = result.ticket ?? ticket;
    if (!result.ok) return { action: 'appended', ticket: after };
    return review.action === 'verify' ? { action: 'verified', ticket: after } : { action: 'rejected', ticket: after };
  }

  /**
   * Log and build an `ignored` outcome.
   *
   * @param message - The message
   * @param reason - Why
   * @returns The outcome
   */
  private ignored(message: IntakeMessage, reason: string): IntakeOutcome {
    this.logger.debug('Message did not open a ticket', { ref: message.origin.ref, channel: message.origin.channel, reason });
    return { action: 'ignored', reason };
  }

  /**
   * The ticket already living in this message's thread, if any (open or not).
   *
   * @param all - Every Request
   * @param message - The message
   * @returns The newest ticket in the thread, or null
   */
  private findThreadTicket(all: readonly Request[], message: IntakeMessage): Request | null {
    const threadRef = message.origin.threadRef;
    const legacy = message.legacyThreadParentRef;
    const matches = all.filter(
      (r) =>
        (threadRef && r.origin?.threadRef === threadRef) ||
        (legacy && r.sourceConversationItemId === legacy),
    );
    if (matches.length === 0) return null;
    // Prefer an open ticket; otherwise the newest (listAll is newest-first).
    return matches.find((r) => !TERMINAL_REQUEST_STATUSES.has(r.status)) ?? matches[0];
  }

  /**
   * The ticket a "不用记" is aimed at: the open ticket in its thread, else the
   * newest open ticket opened recently in the same conversation.
   *
   * @param all - Every Request
   * @param message - The dismiss message
   * @returns The ticket, or null
   */
  private findDismissTarget(all: readonly Request[], message: IntakeMessage): Request | null {
    const inThread = this.findThreadTicket(all, message);
    if (inThread && !TERMINAL_REQUEST_STATUSES.has(inThread.status)) return inThread;
    const conversation = message.conversationRef;
    if (!conversation) return null;
    const cutoff = this.now().getTime() - TICKET_CONSTANTS.DISMISS_LOOKBACK_MS;
    return (
      all.find(
        (r) =>
          typeof r.ticketNumber === 'number' &&
          !TERMINAL_REQUEST_STATUSES.has(r.status) &&
          this.conversationMatches(r, conversation) &&
          Date.parse(r.createdAt) >= cutoff,
      ) ?? null
    );
  }

  /**
   * Whether a ticket was opened in a conversation. Thread refs are built as
   * `<conversationRef>:<thread root>` (see ticket-channel-hooks), so the
   * conversation is a prefix of the thread.
   *
   * @param r - Ticket
   * @param conversation - Conversation ref
   * @returns True when it was
   */
  private conversationMatches(r: Request, conversation: string): boolean {
    return !!r.origin?.threadRef && r.origin.threadRef.startsWith(`${conversation}:`);
  }

  /**
   * Append a follow-up to a ticket's discussion.
   *
   * Trivial follow-ups ("好的") are not written, but the message still belongs
   * to the ticket (so the delivered copy carries its marker).
   *
   * @param ticket - The open ticket
   * @param message - The follow-up
   * @param text - Trimmed text
   * @returns `appended` outcome
   */
  private async appendToTicket(ticket: Request, message: IntakeMessage, text: string): Promise<IntakeOutcome> {
    if (suppressTrivialOrShort(text) || text.length === 0) return { action: 'appended', ticket };
    const discussion = [
      ...(ticket.discussion ?? []),
      {
        at: this.now().toISOString(),
        author: message.origin.authorName ?? message.origin.author,
        text,
        ref: message.origin.ref,
      },
    ];
    const updated = await this.deps.requests.update(ticket.id, { discussion });
    this.logger.debug('Follow-up appended to ticket', { id: ticket.id, ref: message.origin.ref });
    return { action: 'appended', ticket: updated };
  }

  /**
   * Hand out the next ticket number. Monotonic per data dir: an atomic counter
   * file next to the Request files, updated under a lock. The first call seeds
   * it from the highest number already on disk.
   *
   * @param all - Every Request (for seeding)
   * @returns The new number
   */
  private async nextTicketNumber(all: readonly Request[]): Promise<number> {
    const counterPath = path.join(this.deps.requests.getRequestsDir(), TICKET_CONSTANTS.COUNTER_FILENAME);
    const maxExisting = all.reduce((m, r) => (typeof r.ticketNumber === 'number' && r.ticketNumber > m ? r.ticketNumber : m), 0);
    const data = await modifyJsonFile<TicketCounterFile, TicketCounterFile>(counterPath, { last: -1 }, (current) => {
      const last = typeof current?.last === 'number' ? current.last : -1;
      // Never hand out a number that is already on disk, even if the counter
      // file was lost or restored from an older backup.
      return { last: Math.max(last, maxExisting) + 1 };
    });
    return data.last;
  }

  /**
   * Post the receipt and remember where it landed. Runs after intake returns
   * so delivery is not held up by Slack. If the owner dismissed the ticket
   * before the receipt landed, the receipt is edited straight away.
   *
   * @param ticket - New ticket
   * @param target - Where to post
   */
  private async postReceipt(ticket: Request, target: ReceiptTarget): Promise<void> {
    // Tickets are Crewly's own record; the owner sees no receipt (2026-09-24).
    if (!(this.deps.receiptsEnabled ?? TICKET_CONSTANTS.RECEIPT.ENABLED)) return;
    const sink = this.sinks[target.kind];
    if (!sink) {
      this.logger.debug('No receipt sink for surface', { kind: target.kind, id: ticket.id });
      return;
    }
    try {
      const receipt = await sink.post(ticket, target);
      if (!receipt) return;
      const current = await this.deps.requests.getById(ticket.id);
      if (!current) return;
      const updated = await this.deps.requests.update(ticket.id, { receipt });
      if (current.status === 'cancelled') await sink.markDismissed(updated, receipt);
    } catch (err) {
      this.logger.warn('Ticket receipt could not be posted', {
        id: ticket.id,
        kind: target.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Dismiss / lookup / list
  // -------------------------------------------------------------------------

  /**
   * "不用记": cancel a ticket, tag it `dismissed`, and edit its receipt.
   *
   * @param ref - `TKT-123`, `123` or the ticket id
   * @returns What happened
   */
  async dismiss(ref: string): Promise<DismissResult> {
    const run = this.chain.then(async () => {
      const ticket = await this.resolve(ref);
      if (!ticket) return { ok: false, reason: 'not_found' } as DismissResult;
      return this.dismissTicket(ticket);
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Dismiss a loaded ticket (see {@link dismiss}).
   *
   * @param ticket - The ticket
   * @returns What happened
   */
  private async dismissTicket(ticket: Request): Promise<DismissResult> {
    if (ticket.status === 'cancelled') return { ok: true, ticket, alreadyDismissed: true };
    if (ticket.status === 'done') return { ok: false, reason: 'already_done', ticket };
    if (!isValidRequestTransition(ticket.status, 'cancelled')) {
      return { ok: false, reason: 'invalid_transition', ticket };
    }
    const tags = [...new Set([...ticket.tags, TICKET_CONSTANTS.DISMISSED_TAG])];
    const updated = await this.deps.requests.update(ticket.id, { status: 'cancelled', tags });
    this.logger.info('Ticket dismissed (不用记)', {
      tkt: typeof ticket.ticketNumber === 'number' ? formatTicketNumber(ticket.ticketNumber) : null,
      id: ticket.id,
    });
    if (updated.receipt) {
      const sink = this.sinks[updated.receipt.kind];
      if (sink) {
        await sink.markDismissed(updated, updated.receipt).catch((err: unknown) => {
          this.logger.warn('Receipt could not be marked dismissed', {
            id: ticket.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    return { ok: true, ticket: updated, alreadyDismissed: false };
  }

  /**
   * Find a ticket by `TKT-123`, `123` or id.
   *
   * @param ref - The reference
   * @returns The ticket, or null
   */
  async resolve(ref: string): Promise<Request | null> {
    const trimmed = (ref ?? '').trim();
    if (!trimmed) return null;
    const byId = await this.deps.requests.getById(trimmed);
    if (byId) return byId;
    const n = parseTicketNumber(trimmed);
    if (n === null) return null;
    const all = await this.deps.requests.listAll();
    return all.find((r) => r.ticketNumber === n) ?? null;
  }

  /**
   * Board-shaped ticket list.
   *
   * @param query - Filters
   * @returns Rows (newest first) and per-column counts over the filtered set
   */
  async list(query: TicketListQuery = {}): Promise<{ tickets: TicketListItem[]; columns: Record<TicketBoardColumn, number> }> {
    const all = await this.deps.requests.listAll();
    const q = query.q?.trim().toLowerCase();
    const rows: TicketListItem[] = [];
    for (const r of all) {
      if (!query.includeLegacy && typeof r.ticketNumber !== 'number') continue;
      const item = await this.toListItem(r);
      if (query.kind && item.kind !== query.kind) continue;
      if (q && ![item.tkt ?? '', item.title, item.description].some((s) => s.toLowerCase().includes(q))) continue;
      rows.push(item);
    }
    const columns: Record<TicketBoardColumn, number> = {
      idea: 0,
      todo: 0,
      in_progress: 0,
      blocked: 0,
      to_review: 0,
      done: 0,
      cancelled: 0,
    };
    for (const row of rows) columns[row.column] += 1;
    const tickets = query.column
      ? rows.filter((row) => row.column === query.column)
      // Cancelled tickets are hidden unless asked for (searchable via column=cancelled).
      : rows.filter((row) => row.column !== 'cancelled');
    return { tickets, columns };
  }

  /**
   * Shape one Request as a board row.
   *
   * @param r - The Request
   * @returns The row
   */
  async toListItem(r: Request): Promise<TicketListItem> {
    const workItems: BoardWorkItemView[] = [];
    if (this.deps.findWorkItem) {
      for (const id of r.workItemIds) {
        const wi = await this.deps.findWorkItem(id).catch(() => null);
        if (wi) workItems.push(wi);
      }
    }
    const kind: TicketKind = r.kind ?? 'feature';
    return {
      id: r.id,
      tkt: typeof r.ticketNumber === 'number' ? formatTicketNumber(r.ticketNumber) : null,
      ticketNumber: typeof r.ticketNumber === 'number' ? r.ticketNumber : null,
      title: r.title,
      description: r.description,
      kind,
      column: deriveBoardColumn({ status: r.status, kind, requiresConfirmation: r.requiresConfirmation }, workItems),
      status: r.status,
      priority: r.priority,
      priorityLabel: ticketPriorityLabel(r.priority),
      origin: r.origin ?? null,
      assignee: r.assignee ?? null,
      workItemIds: r.workItemIds,
      tags: r.tags,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      acceptance: activeAcceptance(r.acceptance),
      reply: r.reply ?? null,
      rejectCount: r.rejectCount ?? 0,
      submitCount: r.submitCount ?? 0,
      submittedAt: r.submittedAt ?? null,
      completedAt: r.completedAt ?? null,
      autoAcceptAt:
        r.status === 'waiting_confirmation' && r.submittedAt && ticketNeedsReview(r)
          ? new Date(
              Date.parse(r.lastNudgeAt ?? r.submittedAt) +
                TICKET_CONSTANTS.REVIEW.NUDGE_AFTER_MS *
                  (TICKET_CONSTANTS.REVIEW.MAX_NUDGES - (r.nudgeCount ?? 0) + 1),
            ).toISOString()
          : null,
    };
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

// ---------------------------------------------------------------------------
// WorkItem → ticket linking (spec §3)
// ---------------------------------------------------------------------------

/** The slice of InFlightTurnTracker the resolver reads. */
export interface InFlightTurnSource {
  snapshot(): Array<{ sessionName: string; messages: Array<{ text: string; originalContent?: string }> }>;
}

/**
 * The ticket an agent's current turn is about, from the `[TICKET:…]` markers
 * in the messages delivered into that turn.
 *
 * @param tracker - The in-flight turn tracker
 * @param sessionName - The agent creating a WorkItem
 * @returns The ticket id, or null when the turn has none or several tickets
 */
export function resolveTicketIdForSession(tracker: InFlightTurnSource, sessionName: string): string | null {
  const turn = tracker.snapshot().find((t) => t.sessionName === sessionName);
  if (!turn) return null;
  return uniqueTicketIdFromTexts(turn.messages.map((m) => `${m.text}\n${m.originalContent ?? ''}`));
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: TicketIntakeService | null = null;

/**
 * Install the process-wide intake (composition root).
 *
 * @param service - The service, or null to clear (tests)
 */
export function setTicketIntakeService(service: TicketIntakeService | null): void {
  instance = service;
}

/**
 * The process-wide intake, or null before boot wired it. Callers skip ticket
 * intake when null — a message is always delivered either way.
 *
 * @returns The service or null
 */
export function getTicketIntakeService(): TicketIntakeService | null {
  return instance;
}
