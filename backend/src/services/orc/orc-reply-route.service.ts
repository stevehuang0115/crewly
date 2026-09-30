/**
 * Orchestrator reply routing — "answer where you were asked".
 *
 * Tracks, per agent session, the conversation its latest user-originated
 * message came from (the *turn origin*), and decides where a reply the
 * orchestrator posts during or right after that turn should land.
 *
 * Incident 2026-09-26 03:23–03:34 UTC: the owner was talking to the orc in a
 * Slack DM (D0C381XPD3L → chat-v2 channel a721f48d). A reconciler WorkItem
 * redispatch then started a system turn with no `[CHAT:…]` prefix. In it the
 * orc:
 *   - filed `report-status [BLOCKED]` and `reply-chat` without a
 *     conversationId; `/api/chat/agent-response` fell back to
 *     `ChatService.getCurrentConversation()`, which only sees system-owned
 *     channels — never the owner's orchestrator DM — and returned #think-tank
 *     (b79a6e4d), so the summary was mirrored into Slack #pro-think-tank;
 *   - called `reply-slack` on D0AC7NF5N7L, the owner's DM with the *master*
 *     Crewly bot, not the orc-bot DM the conversation was in.
 * The question in that summary ("reply start Ella") never reached the owner.
 *
 * What counts as "the reply": anything the orchestrator posts to a
 * user-facing conversation through `/api/chat/agent-response` (reply-chat,
 * report-status) or to a Slack DM through `/api/slack/send` (reply-slack).
 * It is re-routed to the turn origin when it targets a conversation the orc
 * has not received a user message from recently, unless the caller marked it
 * as a deliberate cross-post. Posts to Slack channels (team notifications,
 * delegation) and `reply-channel` writes are not replies and are untouched.
 *
 * @module services/orc/orc-reply-route.service
 */

import { ORC_REPLY_ROUTE_CONSTANTS } from '../../constants.js';
import { extractSlackThreadKeys, formatSlackThreadKey } from '../slack/slack-thread-key.js';

/** Where an agent's current turn came from. */
export interface TurnOrigin {
  /** chat-v2 channel / conversation id the user message was recorded in. */
  conversationId: string;
  /** Slack channel, when the delivered message carried a `[SLACK:…]` marker. */
  slackChannelId?: string;
  /** Slack thread, when the marker named one. */
  slackThreadTs?: string;
  /**
   * `[SLACK-THREAD:<key>]` of the delivered message — the exact Slack thread
   * its answer belongs in (every Slack-sourced delivery carries one).
   */
  slackThreadKey?: string;
  /**
   * chat-v2 thread the message sits in (huddles), told by the dispatcher
   * right after delivery. Undefined for a DM.
   */
  chatThreadId?: string;
  /** Epoch ms the message was delivered to the agent. */
  receivedAt: number;
}

/** Parsed routing header of a delivered message. */
export type InboundOrigin = Omit<TurnOrigin, 'receivedAt'>;

/** How {@link OrcReplyRouteService.resolveConversationReply} decided. */
export type ReplyRouteAction =
  /** Post where the caller asked. */
  | 'as-requested'
  /** Caller named no conversation; the turn origin was used. */
  | 'defaulted-to-origin'
  /** Caller named a stale conversation; the turn origin was used instead. */
  | 'rerouted-to-origin'
  /** Caller named nothing and no origin is known; caller keeps its fallback. */
  | 'no-origin';

/** Result of a reply-target decision. */
export interface ReplyRouteDecision {
  action: ReplyRouteAction;
  /** Target to use; undefined only for `no-origin`. */
  conversationId?: string;
  /** Why, for logs. */
  reason: string;
  /** The origin consulted, if any. */
  origin?: TurnOrigin;
}

/** Result of a Slack reply-target decision. */
export interface SlackReplyRouteDecision {
  action: 'as-requested' | 'rerouted-to-origin';
  reason: string;
  origin?: TurnOrigin;
}

/** Where a Slack post should actually go. */
export type SlackReplyPlan =
  | { kind: 'slack'; channelId: string; threadTs?: string }
  | { kind: 'conversation'; conversationId: string };

/** Options shared by the resolve methods. */
export interface ResolveOptions {
  /** Caller explicitly marked the post as a deliberate cross-post. */
  crossPost?: boolean;
  /** Clock override for tests. */
  now?: number;
}

/**
 * `[CHAT:<id>…]` / `[GCHAT:<id>…]` at the start of a delivered message. Both
 * delivery paths put it first: the chat-v2 dispatcher (`[CHAT:<channel>]
 * <sender@name>`) and the message queue (`[CHAT:<conversation>:<fp>] …`).
 * System deliveries (`[SYSTEM]`, `[CREWLY-DISPATCH]`, reminders) never do.
 */
const CHAT_PREFIX = /^\s*\[G?CHAT:([^\]\s]+)[^\]]*\]/;

/**
 * The message queue appends `:<last 8 chars of the message id>` to the
 * conversation id as a delivery fingerprint.
 */
const QUEUE_FINGERPRINT_SUFFIX = /^(.+):[A-Za-z0-9-]{8}$/;

/** `[SLACK:<channel>]` or `[SLACK:<channel>:<threadTs>]`, anywhere. */
const SLACK_MARKER = /\[SLACK:([^:\]\s]+)(?::([^\]\s]+))?\]/;

/**
 * Parses the routing header of a message delivered to an agent.
 *
 * @param message - The exact text delivered to the agent
 * @returns The origin, or null for system-originated deliveries
 *
 * @example
 * ```typescript
 * parseInboundOrigin('[CHAT:a721f48d] <owner@Orchestrator>\n\nhi');
 * // → { conversationId: 'a721f48d' }
 * ```
 */
export function parseInboundOrigin(message: string): InboundOrigin | null {
  const chat = CHAT_PREFIX.exec(message);
  if (!chat) return null;
  const raw = chat[1];
  const fp = QUEUE_FINGERPRINT_SUFFIX.exec(raw);
  const origin: InboundOrigin = { conversationId: fp ? fp[1] : raw };
  const slack = SLACK_MARKER.exec(message);
  if (slack) {
    origin.slackChannelId = slack[1];
    if (slack[2]) origin.slackThreadTs = slack[2];
  }
  const [threadKey] = extractSlackThreadKeys(message);
  if (threadKey) origin.slackThreadKey = formatSlackThreadKey(threadKey.slackChannelId, threadKey.threadTs);
  return origin;
}

/**
 * Whether a Slack channel id is a direct-message conversation.
 *
 * @param slackChannelId - Slack channel id
 * @returns True for `D…` ids
 */
export function isSlackDm(slackChannelId: string): boolean {
  return slackChannelId.startsWith(ORC_REPLY_ROUTE_CONSTANTS.SLACK_DM_PREFIX);
}

/** Per-session state. */
interface SessionRouteState {
  origin?: TurnOrigin;
  /** conversationId → last inbound epoch ms. */
  conversations: Map<string, number>;
  /** Slack channel id → last inbound epoch ms. */
  slackChannels: Map<string, number>;
  /** conversationId → chat thread the latest message there sits in (dispatcher hints). */
  threadHints: Map<string, string | undefined>;
}

/**
 * Tracks turn origins and decides reply targets. Process-wide singleton; all
 * state is in memory (a restart starts every agent on a fresh turn anyway).
 */
export class OrcReplyRouteService {
  private static instance: OrcReplyRouteService | null = null;

  private readonly sessions = new Map<string, SessionRouteState>();

  /**
   * @returns The shared instance
   */
  static getInstance(): OrcReplyRouteService {
    if (!OrcReplyRouteService.instance) OrcReplyRouteService.instance = new OrcReplyRouteService();
    return OrcReplyRouteService.instance;
  }

  /** Drops the shared instance (tests). */
  static resetInstance(): void {
    OrcReplyRouteService.instance = null;
  }

  /**
   * Records a message delivered to an agent. User-originated messages (those
   * with a `[CHAT:…]` header) become the session's turn origin; system
   * deliveries leave the origin alone, so a system turn that follows a user
   * turn still answers the user where they asked.
   *
   * @param sessionName - Receiving agent session
   * @param message - Exact delivered text
   * @param now - Clock override for tests
   * @returns The new origin, or null when the message was system-originated
   */
  noteDelivery(sessionName: string, message: string, now: number = Date.now()): TurnOrigin | null {
    const parsed = parseInboundOrigin(message);
    if (!parsed) return null;
    const state = this.stateFor(sessionName);
    const origin: TurnOrigin = { ...parsed, receivedAt: now };
    const hint = state.threadHints.get(origin.conversationId);
    if (hint) origin.chatThreadId = hint;
    state.origin = origin;
    remember(state.conversations, origin.conversationId, now);
    if (origin.slackChannelId) remember(state.slackChannels, origin.slackChannelId, now);
    return origin;
  }

  /**
   * Record which chat-v2 thread a message delivered to `sessionName` in
   * `conversationId` sits in. Applied to the current origin when it is that
   * conversation, and remembered for a delivery that is still queued.
   *
   * @param sessionName - Receiving agent session
   * @param conversationId - chat-v2 channel of the message
   * @param threadId - Thread root id (undefined = no thread, e.g. a DM)
   */
  noteOriginThread(sessionName: string, conversationId: string, threadId: string | undefined): void {
    const state = this.stateFor(sessionName);
    state.threadHints.delete(conversationId);
    state.threadHints.set(conversationId, threadId);
    while (state.threadHints.size > ORC_REPLY_ROUTE_CONSTANTS.MAX_TRACKED_CONVERSATIONS) {
      const oldest = state.threadHints.keys().next().value;
      if (oldest === undefined) break;
      state.threadHints.delete(oldest);
    }
    if (state.origin?.conversationId === conversationId) {
      if (threadId) state.origin.chatThreadId = threadId;
      else delete state.origin.chatThreadId;
    }
  }

  /**
   * The session's turn origin, however old.
   *
   * @param sessionName - Agent session
   * @returns The last user-originated origin, or undefined
   */
  getLastOrigin(sessionName: string): TurnOrigin | undefined {
    return this.sessions.get(sessionName)?.origin;
  }

  /**
   * The session's turn origin if it is still fresh.
   *
   * @param sessionName - Agent session
   * @param now - Clock override for tests
   * @returns The origin within {@link ORC_REPLY_ROUTE_CONSTANTS.ORIGIN_TTL_MS}
   */
  getFreshOrigin(sessionName: string, now: number = Date.now()): TurnOrigin | undefined {
    const origin = this.getLastOrigin(sessionName);
    if (!origin) return undefined;
    return now - origin.receivedAt <= ORC_REPLY_ROUTE_CONSTANTS.ORIGIN_TTL_MS ? origin : undefined;
  }

  /**
   * Decides which conversation a chat reply (reply-chat, report-status)
   * belongs in.
   *
   * - No conversation named → the turn origin (any age: it is still a better
   *   guess than "the newest channel in the system"); none known → caller's
   *   own fallback.
   * - A conversation named → kept when it is the origin, when the session
   *   received a user message there recently, when the caller marked a
   *   cross-post, or when there is no fresh origin to prefer. Otherwise the
   *   reply goes to the origin.
   *
   * @param sessionName - Replying agent session
   * @param requested - Conversation the caller named, if any
   * @param options - Cross-post flag and clock
   * @returns The decision
   */
  resolveConversationReply(
    sessionName: string,
    requested: string | undefined,
    options: ResolveOptions = {},
  ): ReplyRouteDecision {
    const now = options.now ?? Date.now();
    if (!requested) {
      const last = this.getLastOrigin(sessionName);
      return last
        ? { action: 'defaulted-to-origin', conversationId: last.conversationId, origin: last, reason: 'no conversation named — using the conversation the turn came from' }
        : { action: 'no-origin', reason: 'no conversation named and no turn origin known' };
    }
    const origin = this.getFreshOrigin(sessionName, now);
    if (!origin) return { action: 'as-requested', conversationId: requested, reason: 'no fresh turn origin' };
    if (requested === origin.conversationId) {
      return { action: 'as-requested', conversationId: requested, origin, reason: 'is the turn origin' };
    }
    if (options.crossPost) {
      return { action: 'as-requested', conversationId: requested, origin, reason: 'explicit cross-post' };
    }
    if (this.receivedRecently(this.sessions.get(sessionName)?.conversations, requested, now)) {
      return { action: 'as-requested', conversationId: requested, origin, reason: 'received a user message there recently' };
    }
    return {
      action: 'rerouted-to-origin',
      conversationId: origin.conversationId,
      origin,
      reason: 'named a conversation the turn did not come from and no user wrote in recently',
    };
  }

  /**
   * Decides whether a Slack post is a misdirected reply. Only DMs are
   * candidates — posting in a channel is how the orchestrator notifies teams
   * and delegates, so channel posts are always sent as asked.
   *
   * @param sessionName - Posting agent session
   * @param slackChannelId - Slack channel the caller named
   * @param options - Cross-post flag, clock, and the Slack DM the origin
   *   conversation is bridged to (when the delivered message had no marker)
   * @returns The decision
   */
  resolveSlackReply(
    sessionName: string,
    slackChannelId: string,
    options: ResolveOptions & { originSlackChannelId?: string } = {},
  ): SlackReplyRouteDecision {
    const now = options.now ?? Date.now();
    if (!isSlackDm(slackChannelId)) {
      return { action: 'as-requested', reason: 'channel post — cross-posting allowed' };
    }
    const origin = this.getFreshOrigin(sessionName, now);
    if (!origin) return { action: 'as-requested', reason: 'no fresh turn origin' };
    const originSlack = origin.slackChannelId ?? options.originSlackChannelId;
    if (originSlack === slackChannelId) {
      return { action: 'as-requested', origin, reason: 'is the turn origin' };
    }
    if (options.crossPost) return { action: 'as-requested', origin, reason: 'explicit cross-post' };
    if (this.receivedRecently(this.sessions.get(sessionName)?.slackChannels, slackChannelId, now)) {
      return { action: 'as-requested', origin, reason: 'received a user message there recently' };
    }
    return {
      action: 'rerouted-to-origin',
      origin,
      reason: 'posted to a Slack DM the turn did not come from and no user wrote in recently',
    };
  }

  /**
   * Plans where a Slack post by `sessionName` should go.
   *
   * When {@link resolveSlackReply} re-routes, the destination is the origin's
   * own Slack conversation if the delivered message carried a `[SLACK:…]`
   * marker (the master-bot bridge), else the origin chat-v2 conversation —
   * which the Slack DM bridge mirrors into the agent-bot DM the owner wrote
   * in, under the right bot.
   *
   * @param sessionName - Posting agent session
   * @param target - Slack channel/thread the caller named, and its cross-post flag
   * @param findDmSlackChannel - Maps a chat-v2 conversation to the Slack DM it
   *   is bridged to, when it is
   * @param now - Clock override for tests
   * @returns The plan and the decision behind it
   */
  planSlackReply(
    sessionName: string,
    target: { channelId: string; threadTs?: string; crossPost?: boolean },
    findDmSlackChannel: (conversationId: string) => string | undefined,
    now: number = Date.now(),
  ): { plan: SlackReplyPlan; decision: SlackReplyRouteDecision } {
    const fresh = this.getFreshOrigin(sessionName, now);
    const originSlackChannelId =
      fresh && !fresh.slackChannelId ? findDmSlackChannel(fresh.conversationId) : undefined;
    const decision = this.resolveSlackReply(sessionName, target.channelId, {
      crossPost: target.crossPost,
      originSlackChannelId,
      now,
    });
    if (decision.action !== 'rerouted-to-origin' || !decision.origin) {
      return { plan: { kind: 'slack', channelId: target.channelId, threadTs: target.threadTs }, decision };
    }
    const origin = decision.origin;
    const plan: SlackReplyPlan = origin.slackChannelId
      ? { kind: 'slack', channelId: origin.slackChannelId, threadTs: origin.slackThreadTs }
      : { kind: 'conversation', conversationId: origin.conversationId };
    return { plan, decision };
  }

  /**
   * Whether an inbound map saw `key` within the recent-inbound window.
   *
   * @param seen - Inbound map
   * @param key - Conversation or Slack channel id
   * @param now - Epoch ms
   * @returns True when recent
   */
  private receivedRecently(seen: Map<string, number> | undefined, key: string, now: number): boolean {
    const at = seen?.get(key);
    return at !== undefined && now - at <= ORC_REPLY_ROUTE_CONSTANTS.RECENT_INBOUND_MS;
  }

  /**
   * @param sessionName - Agent session
   * @returns Its state, created on first use
   */
  private stateFor(sessionName: string): SessionRouteState {
    let state = this.sessions.get(sessionName);
    if (!state) {
      state = { conversations: new Map(), slackChannels: new Map(), threadHints: new Map() };
      this.sessions.set(sessionName, state);
    }
    return state;
  }
}

/**
 * Records `key` as seen at `at`, keeping the map bounded (oldest first out;
 * Map preserves insertion order, and re-inserting moves a key to the end).
 *
 * @param map - Inbound map
 * @param key - Conversation or Slack channel id
 * @param at - Epoch ms
 */
function remember(map: Map<string, number>, key: string, at: number): void {
  map.delete(key);
  map.set(key, at);
  while (map.size > ORC_REPLY_ROUTE_CONSTANTS.MAX_TRACKED_CONVERSATIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
