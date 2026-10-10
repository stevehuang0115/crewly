/**
 * Ticket hygiene (specs/ticket-calm.md) — the rules that keep the ticket pile
 * from growing on the owner:
 *
 * - {@link answerNeedsOwner}: an answered ticket waits in 待验收 only when it
 *   has a deliverable someone must look at (a document, an email, a draft, a
 *   form, code, a deploy, money, anything sent out) or when the answer asks
 *   the owner something. A plain answer closes on the spot.
 * - {@link isStaleTicket}: open / running with no activity for
 *   {@link TICKET_CONSTANTS.STALE.AFTER_MS} → closed as stale.
 * - {@link planTicketCleanup} / {@link runTicketCleanup}: the one-time
 *   cleanup of the pile that built up before these rules (dry run by
 *   default, idempotent).
 *
 * Pure except for {@link runTicketCleanup}, which writes through the
 * request store it is given. No LLM.
 *
 * @module services/v3/ticket-hygiene
 */

import { TICKET_CONSTANTS } from '../../constants.js';
import type { Request, UpdateRequestInput } from '../../types/v2/request.types.js';
import { formatTicketNumber, parseReviewReply, ticketNeedsReview, type TicketDiscussionEntry } from '../../types/v2/ticket.types.js';
import { askText } from './ticket-ask-classifier.js';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Whether an answered ticket has to wait for the owner (待验收) or can close
 * as soon as it is answered.
 *
 * Waits when the ask names a deliverable ({@link TICKET_CONSTANTS.REVIEW.DELIVERABLE_ASK}),
 * the intent is a change ({@link TICKET_CONSTANTS.REVIEW.DELIVERABLE_CATEGORIES}),
 * or the agent's answer asks the owner something
 * ({@link TICKET_CONSTANTS.REVIEW.OWNER_QUESTION}). Everything else — "看看这个",
 * "研究一下", "这个团队都有几个人" — is a conversation, and a conversation
 * that got its answer is done.
 *
 * @param ticket - The ticket (its ask, intent and latest answer)
 * @returns True when the owner has to look at the result
 *
 * @example
 * ```typescript
 * answerNeedsOwner({ description: '帮我写一封回信', reply: {...} });      // true
 * answerNeedsOwner({ description: '看看这个 https://x.com/…', reply: {...} }); // false
 * ```
 */
export function answerNeedsOwner(
  ticket: Pick<Request, 'description' | 'intentCategory' | 'kind'> & { reply?: Pick<NonNullable<Request['reply']>, 'excerpt'> | undefined },
): boolean {
  if (ticket.kind === 'question') return false;
  const R = TICKET_CONSTANTS.REVIEW;
  if (ticket.intentCategory && R.DELIVERABLE_CATEGORIES.includes(ticket.intentCategory)) return true;
  if (R.DELIVERABLE_ASK.test(askText(ticket.description ?? ''))) return true;
  const answer = (ticket.reply?.excerpt ?? '').trim();
  // Ends on a question to him, or asks for an OK / a choice anywhere.
  return /[？?]$/.test(answer) || R.OWNER_QUESTION.test(answer);
}

/** The owner asks where it is / to send it again — never an approval. */
export const RESEND_OR_WHERE = /(再发|重新发|重发|再给我|发一下|发我一下|在哪|哪里|哪儿|没看到|没收到|看不到|找不到|收不到|链接呢|发到哪|where|resend|send (?:it |the \w+ )?again|didn'?t (?:get|see|receive)|can'?t (?:find|see)|no link)/i;

/**
 * Whether a message the owner left in a 待验收 ticket's thread is an
 * objection: a 打回, or "where is it / send it again".
 *
 * @param text - The owner's message
 * @returns True when the work is not settled by it
 */
export function isOwnerObjection(text: string): boolean {
  const t = (text ?? '').trim();
  return parseReviewReply(t)?.action === 'reject' || RESEND_OR_WHERE.test(t);
}

/**
 * Whether the owner already moved on in a 待验收 ticket's thread: they posted
 * after the answer and nothing they said is an objection. Pure
 * acknowledgements are not stored in the discussion (they accept at once), so
 * a later entry is a follow-up the agent answers in the thread, not a
 * complaint about the finished work. Notes written by Crewly itself do not
 * count.
 *
 * @param ticket - The ticket in 待验收
 * @returns True when silence-about-the-work can be taken as acceptance now
 */
export function ownerMovedOn(ticket: Pick<Request, 'submittedAt' | 'discussion'>): boolean {
  const since = ticket.submittedAt ? Date.parse(ticket.submittedAt) : NaN;
  if (!Number.isFinite(since)) return false;
  const later = (ticket.discussion ?? []).filter(
    (d) =>
      d.author !== TICKET_CONSTANTS.STALE.NOTE_AUTHOR &&
      d.author !== TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_NOTE_AUTHOR &&
      Date.parse(d.at) > since,
  );
  return later.length > 0 && !later.some((d) => isOwnerObjection(d.text));
}

/**
 * The last time anything happened on a ticket: created, updated, answered,
 * submitted or discussed.
 *
 * @param ticket - The ticket
 * @returns Epoch ms (NaN-safe: unparsable dates are skipped)
 */
export function ticketLastActivity(
  ticket: Pick<Request, 'createdAt' | 'updatedAt' | 'submittedAt' | 'discussion'> & { reply?: Pick<NonNullable<Request['reply']>, 'at'> | undefined },
): number {
  const times = [ticket.createdAt, ticket.updatedAt, ticket.submittedAt, ticket.reply?.at, ...(ticket.discussion ?? []).map((d) => d.at)]
    .map((t) => (t ? Date.parse(t) : NaN))
    .filter((n) => Number.isFinite(n));
  return times.length > 0 ? Math.max(...times) : 0;
}

/**
 * Whether a ticket has gone stale: open / ready / running and untouched for
 * {@link TICKET_CONSTANTS.STALE.AFTER_MS}.
 *
 * @param ticket - The ticket
 * @param now - Current time (ms)
 * @returns True when it should be closed as stale
 */
export function isStaleTicket(ticket: Request, now: number): boolean {
  if (!TICKET_CONSTANTS.STALE.STATUSES.includes(ticket.status)) return false;
  return now - ticketLastActivity(ticket) >= TICKET_CONSTANTS.STALE.AFTER_MS;
}

/**
 * The update that closes a ticket as stale: cancelled, tagged, with a note in
 * its discussion so whoever opens it sees why.
 *
 * @param ticket - The ticket
 * @param nowIso - Current time
 * @returns The update
 */
export function staleCloseUpdate(ticket: Request, nowIso: string): UpdateRequestInput {
  const note: TicketDiscussionEntry = {
    at: nowIso,
    author: TICKET_CONSTANTS.STALE.NOTE_AUTHOR,
    text: TICKET_CONSTANTS.STALE.NOTE,
    ref: `stale-${nowIso}`,
  };
  return {
    status: 'cancelled',
    tags: [...new Set([...ticket.tags, TICKET_CONSTANTS.STALE.TAG])],
    discussion: [...(ticket.discussion ?? []), note],
  };
}

// ---------------------------------------------------------------------------
// One-time cleanup
// ---------------------------------------------------------------------------

/** What the cleanup does to one ticket. */
export interface TicketCleanupAction {
  id: string;
  /** `TKT-042`, or null for a Request from before the ticket loop */
  tkt: string | null;
  title: string;
  from: Request['status'];
  /**
   * `answered`: 待验收 with nothing for the owner to look at → done (as a plain
   * answer now closes); `accept`: 待验收 answered over a day ago → done
   * (silence); `stale`: open / running idle → cancelled + stale
   */
  action: 'answered' | 'accept' | 'stale';
}

/** Result of {@link planTicketCleanup} / {@link runTicketCleanup}. */
export interface TicketCleanupReport {
  /** False = dry run: nothing was written */
  applied: boolean;
  /** Requests looked at */
  scanned: number;
  /** 待验收 whose answer needs nothing from the owner → done */
  answered: number;
  /** 待验收 older than AUTO_ACCEPT_MS → accepted */
  accept: number;
  /** open / running idle for STALE.AFTER_MS → closed as stale */
  stale: number;
  /** Actions that failed on apply (id + reason) */
  failed: Array<{ id: string; reason: string }>;
  actions: TicketCleanupAction[];
}

/** Options for {@link planTicketCleanup}. */
export interface TicketCleanupOptions {
  /** Current time (ms) */
  now: number;
  /**
   * Also close Requests from before the ticket loop (no TKT number) that went
   * stale. Default true: they are invisible on the board and only inflate
   * counts (2026-09-28: 37 open test-leak Requests from August).
   */
  includeLegacy?: boolean;
}

/**
 * Plan the one-time cleanup — the 2026-09-28 rules applied to the pile that
 * built up before them:
 *
 * - a 待验收 ticket whose answer needs nothing from the owner
 *   ({@link answerNeedsOwner}) is closed as answered;
 * - any other 待验收 ticket answered more than
 *   {@link TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS} ago is accepted (silence);
 * - an open / running one idle for {@link TICKET_CONSTANTS.STALE.AFTER_MS} is
 *   closed as stale.
 *
 * Idempotent: a second plan over the result is empty.
 *
 * @param requests - Every Request in the store
 * @param opts - Clock and scope
 * @returns The report (not applied)
 */
export function planTicketCleanup(requests: readonly Request[], opts: TicketCleanupOptions): TicketCleanupReport {
  const actions: TicketCleanupAction[] = [];
  for (const r of requests) {
    const numbered = typeof r.ticketNumber === 'number';
    if (!numbered && opts.includeLegacy === false) continue;
    const base = { id: r.id, tkt: numbered ? formatTicketNumber(r.ticketNumber as number) : null, title: r.title, from: r.status };
    if (r.status === 'waiting_confirmation') {
      const since = Date.parse(r.submittedAt ?? r.updatedAt);
      if (numbered && ticketNeedsReview(r) && r.reply && !answerNeedsOwner(r)) actions.push({ ...base, action: 'answered' });
      else if (Number.isFinite(since) && opts.now - since >= TICKET_CONSTANTS.REVIEW.AUTO_ACCEPT_MS) actions.push({ ...base, action: 'accept' });
    } else if (isStaleTicket(r, opts.now)) {
      actions.push({ ...base, action: 'stale' });
    }
  }
  return {
    applied: false,
    scanned: requests.length,
    answered: actions.filter((a) => a.action === 'answered').length,
    accept: actions.filter((a) => a.action === 'accept').length,
    stale: actions.filter((a) => a.action === 'stale').length,
    failed: [],
    actions,
  };
}

/** The request store surface the cleanup writes through. */
export interface TicketCleanupStore {
  listAll(): Promise<Request[]>;
  update(id: string, updates: UpdateRequestInput): Promise<Request>;
}

/**
 * Run the cleanup. Dry run unless `apply`; the plan is made from the store's
 * current contents, so running it twice changes nothing the second time.
 *
 * Accepting goes through the store's `done` gate with `accepted` (silence,
 * tagged `auto_accepted`) and `ignoreDeadChildren`, so a ticket with a live
 * WorkItem still stays open (reported under `failed`). A `waiting_confirmation`
 * ticket that does not need review (a question, a cron ticket) is closed the
 * same way without the tag.
 *
 * @param store - Request store
 * @param opts - Clock, scope and `apply`
 * @returns What was (or would be) done
 *
 * @example
 * ```typescript
 * const dry = await runTicketCleanup(RequestService.getInstance(), { now: Date.now() });
 * const done = await runTicketCleanup(RequestService.getInstance(), { now: Date.now(), apply: true });
 * ```
 */
export async function runTicketCleanup(
  store: TicketCleanupStore,
  opts: TicketCleanupOptions & { apply?: boolean },
): Promise<TicketCleanupReport> {
  const all = await store.listAll();
  const plan = planTicketCleanup(all, opts);
  if (!opts.apply) return plan;
  const byId = new Map(all.map((r) => [r.id, r]));
  const nowIso = new Date(opts.now).toISOString();
  const failed: TicketCleanupReport['failed'] = [];
  for (const a of plan.actions) {
    const r = byId.get(a.id);
    if (!r) continue;
    try {
      if (a.action === 'answered') {
        await store.update(r.id, {
          status: 'done',
          accepted: true,
          ignoreDeadChildren: true,
          tags: [...new Set([...r.tags, TICKET_CONSTANTS.REVIEW.ANSWERED_TAG])],
        });
      } else if (a.action === 'accept') {
        const silence = ticketNeedsReview(r);
        await store.update(r.id, {
          status: 'done',
          accepted: true,
          ignoreDeadChildren: true,
          ...(silence
            ? { acceptedBy: 'silence' as const, tags: [...new Set([...r.tags, TICKET_CONSTANTS.REVIEW.AUTO_ACCEPTED_TAG])] }
            : {}),
        });
      } else {
        await store.update(r.id, staleCloseUpdate(r, nowIso));
      }
    } catch (err) {
      failed.push({ id: r.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  const failedIds = new Set(failed.map((f) => f.id));
  const ok = plan.actions.filter((a) => !failedIds.has(a.id));
  return {
    ...plan,
    applied: true,
    answered: ok.filter((a) => a.action === 'answered').length,
    accept: ok.filter((a) => a.action === 'accept').length,
    stale: ok.filter((a) => a.action === 'stale').length,
    failed,
  };
}
