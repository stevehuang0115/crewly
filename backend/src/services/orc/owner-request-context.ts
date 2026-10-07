/**
 * Owner requests an agent is handling that are not chat turns.
 *
 * A chat / Slack message from the owner becomes the agent's turn origin
 * (OrcReplyRouteService) and the work it starts inherits an owner origin.
 * Two other ways an owner request reaches an agent left no trace:
 *
 * - an app comment: the owner commented in a Crewly App and the comment was
 *   delivered to the app's agent as an `[APP CHANGES]` message (no `[CHAT:…]`
 *   header, so no turn origin);
 * - a hand-over: the agent that got the owner's request messaged a colleague
 *   (send-message) to do it.
 *
 * Incident 2026-10-07: the owner's comment in the schedule app reached Lyra,
 * Lyra handed it to Ella by message, Ella opened CREW-305/309/310 and
 * delegated them. Every item was verified and nobody told the owner: none of
 * them carried an owner origin.
 *
 * This registry remembers, per agent session, the owner request it is
 * handling, in memory like turn origins, while it is fresh
 * (`OWNER_COMPLETION_REPORT_CONSTANTS.CONTEXT_FRESH_MS`). The task pool reads
 * it when the agent creates work (`inheritedOrigin`).
 *
 * @module services/orc/owner-request-context
 */

import { OWNER_COMPLETION_REPORT_CONSTANTS as C } from '../../constants.js';
import type { WorkItemOrigin } from './work-item-destination.js';

/** An owner request an agent is handling. */
export interface OwnerRequestContext {
  /** The owner origin work started from it inherits */
  origin: Extract<WorkItemOrigin, { kind: 'owner' }>;
  /** When it reached this agent (epoch ms) */
  at: number;
  /** How it reached this agent */
  via: 'app-comment' | 'hand-over';
}

/** Resolves an app comment to the Slack thread it is mirrored in, when there is one. */
export type AppCommentThreadResolver = (appId: string, commentId: string) => Promise<{ slackChannelId: string; threadTs: string } | null>;

/** The sender's owner turn, as an owner origin (null when it has no fresh one). */
export type TurnOwnerOriginLookup = (session: string, now: number) => { origin: Extract<WorkItemOrigin, { kind: 'owner' }>; at: number } | null;

/** Per-session owner request contexts. */
export class OwnerRequestContextRegistry {
  private readonly contexts = new Map<string, OwnerRequestContext>();
  private appCommentThread: AppCommentThreadResolver | null = null;
  private turnLookup: TurnOwnerOriginLookup | null = null;

  /**
   * Wire how an app comment resolves to its Slack thread (apps wiring).
   *
   * @param resolver - Resolver, or null
   */
  setAppCommentThreadResolver(resolver: AppCommentThreadResolver | null): void {
    this.appCommentThread = resolver;
  }

  /**
   * Wire the sender's owner chat turn lookup used by {@link relay} (boot).
   *
   * @param lookup - Lookup, or null
   */
  setTurnLookup(lookup: TurnOwnerOriginLookup | null): void {
    this.turnLookup = lookup;
  }

  /**
   * An owner app comment was delivered to `session`.
   *
   * @param session - Receiving agent
   * @param comment - App and comment id
   * @param now - Clock
   */
  noteAppComment(session: string, comment: { appId: string; commentId: string }, now: number = Date.now()): void {
    if (!session || !comment.appId || !comment.commentId) return;
    this.set(session, {
      origin: { kind: 'owner', receivedBy: session, appComment: { appId: comment.appId, commentId: comment.commentId } },
      at: now,
      via: 'app-comment',
    });
  }

  /**
   * `sender` messaged `target`: when the sender is handling a fresh owner
   * request (its own chat turn or a context), the target now handles it too.
   * The origin keeps who received it from the owner. A target with a newer
   * owner request of its own keeps that one.
   *
   * @param sender - Sending agent
   * @param target - Receiving agent
   * @param now - Clock
   * @returns True when the target took the sender's request
   */
  relay(sender: string, target: string, now: number = Date.now()): boolean {
    if (!sender || !target || sender === target) return false;
    const fromTurn = this.turnLookup?.(sender, now) ?? null;
    const own = this.get(sender, now);
    const best = fromTurn && own ? (own.at > fromTurn.at ? own : fromTurn) : own ?? fromTurn;
    if (!best) return false;
    const targetTurn = this.turnLookup?.(target, now) ?? null;
    const current = this.get(target, now);
    if (targetTurn && targetTurn.at > best.at) return false;
    if (current && current.via === 'app-comment' && current.at > best.at) return false;
    this.set(target, { origin: { ...best.origin, receivedBy: best.origin.receivedBy ?? sender }, at: now, via: 'hand-over' });
    return true;
  }

  /**
   * The fresh owner request `session` is handling, if any.
   *
   * @param session - Agent
   * @param now - Clock
   * @returns The context, or null
   */
  get(session: string, now: number = Date.now()): OwnerRequestContext | null {
    const ctx = this.contexts.get(session);
    if (!ctx) return null;
    if (now - ctx.at > C.CONTEXT_FRESH_MS) {
      this.contexts.delete(session);
      return null;
    }
    return ctx;
  }

  /**
   * {@link get}, with an app comment origin completed with the comment's
   * Slack thread (so the work's answers land in it). Never throws.
   *
   * @param session - Agent
   * @param now - Clock
   * @returns The context, or null
   */
  async resolve(session: string, now: number = Date.now()): Promise<OwnerRequestContext | null> {
    const ctx = this.get(session, now);
    if (!ctx) return null;
    const ac = ctx.origin.appComment;
    if (!ac || ctx.origin.slackChannelId || !this.appCommentThread) return ctx;
    const thread = await this.appCommentThread(ac.appId, ac.commentId).catch(() => null);
    if (!thread) return ctx;
    const resolved: OwnerRequestContext = { ...ctx, origin: { ...ctx.origin, slackChannelId: thread.slackChannelId, threadTs: thread.threadTs } };
    // Keep the resolved form while it is still the current one.
    if (this.contexts.get(session) === ctx) this.contexts.set(session, resolved);
    return resolved;
  }

  /** Forget everything (tests). */
  clear(): void {
    this.contexts.clear();
  }

  private set(session: string, ctx: OwnerRequestContext): void {
    this.contexts.delete(session);
    this.contexts.set(session, ctx);
    while (this.contexts.size > C.MAX_CONTEXT_SESSIONS) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) break;
      this.contexts.delete(oldest);
    }
  }
}

let registry: OwnerRequestContextRegistry | null = null;

/**
 * The process-wide registry.
 *
 * @returns The registry
 */
export function getOwnerRequestContext(): OwnerRequestContextRegistry {
  if (!registry) registry = new OwnerRequestContextRegistry();
  return registry;
}

/** Drop the process-wide registry (tests). */
export function resetOwnerRequestContext(): void {
  registry = null;
}
