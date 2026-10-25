/**
 * HTTP controller for Phase 1 Chat endpoints.
 *
 * Thin layer: parses + validates requests, delegates to `ChatV2Service`,
 * and maps `ChatError` to HTTP responses. All routes are owner-scoped via
 * `requireAuth` middleware; the principal is lifted from `req.user`.
 *
 * Wiring hooks (all optional — omit for tests that only need REST):
 *   - `gateway.broadcast(channelId, frame)`  — after successful persist,
 *     the controller fans a `message` frame out to WS subscribers so the
 *     sending client's WS re-broadcasts reconcile with its HTTP-201 echo.
 *   - `dispatcher.dispatchToAgent(channel, message)` — fires when a USER
 *     message lands, pushing the text into the bound agent's runtime. The
 *     agent replies via the `reply-channel` skill, which re-enters this
 *     same endpoint with an `X-Crewly-Agent-Session` header.
 *
 * @module controllers/chat-v2/chat-v2.controller
 */

import type { AttachResult } from '../../services/file-handoff/file-handoff.service.js';
import { awaitSlackDelivery } from '../../services/slack/slack-outbound-delivery.js';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/require-auth.middleware.js';
import type { ChatV2Service } from '../../services/chat-v2/chat-v2.service.js';
import type { ChatV2DispatcherService } from '../../services/chat-v2/chat-v2.dispatcher.service.js';
import type { ChatV2Gateway } from '../../websocket/chat-v2.gateway.js';
import { buildMessageEvent } from '../../websocket/chat-v2.gateway.js';
import { getChatV2RealtimeDeps } from '../../services/chat-v2/chat-v2.realtime-holder.js';
import { TICKET_CONSTANTS } from '../../constants.js';
import {
  buildChatV2SourceId,
  isOrchestratorRoutedChatV2Channel,
  intakeChatV2OwnerMessage,
} from '../../services/v3/ticket-channel-hooks.js';
import { getTicketIntakeService } from '../../services/v3/ticket-intake.service.js';
import {
  CHAT_ERROR_CODES,
  ChatError,
  type ChatChannelType,
  type ChatMessageDTO,
  type ChatPrincipal,
} from '../../services/chat-v2/types.js';
import { stripTraceMarkers } from '../../services/trace/trace-markers.js';
import type { MessageRoute } from '../../services/orc/message-route.js';
import { getCallerIdentity, rejectUnverifiedCaller, sendOwnerAuthRequired } from '../../middleware/caller-identity.middleware.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the service-level principal from the authenticated request.
 *
 * The agent session comes from the caller-identity classifier (#999,
 * #1012), not from a header the caller chose to send: an agent badge, the
 * process tree, or (migration window) `X-Agent-Session`. The service
 * resolves `sender_type` from it — `agent` in the agent's own channel, a
 * `user` row tagged with the authoring agent elsewhere — so an agent can
 * never write a row that passes as the owner's words. Before #1012 a post
 * that left the header out (or carried only the badge) became a `user` row,
 * which the WhatsApp 「发 Wn」 gate and the approval guard read as the
 * owner speaking.
 *
 * Whether the caller may write at all is decided by
 * {@link rejectUnidentifiedChatWriter} in front of every write route.
 */
export function principalFromRequest(req: Request): ChatPrincipal {
  const user = (req as AuthenticatedRequest).user;
  if (!user?.userId) {
    throw new ChatError(CHAT_ERROR_CODES.FORBIDDEN, 401, 'Authentication required');
  }
  const identity = getCallerIdentity(req);
  const agentSession = identity.kind === 'agent' && identity.session ? identity.session : undefined;
  return {
    userId: user.userId,
    agentSession,
    source: 'oss',
  };
}

/**
 * Refuse a chat write from a caller that is neither the owner nor an
 * identified agent (#1012). Chat rows written by the owner are trusted as
 * the owner's own words (WhatsApp send gate, commitment-approval guard,
 * owner-login evidence), so only an owner credential — the dashboard
 * session, the API token, the phone / portal relay — may write as the
 * owner. Agents write as themselves.
 *
 * - owner, relay: allowed (written as the owner);
 * - agent with a known session: allowed (written as that agent);
 * - agent whose session is unknown (an agent process presenting the owner
 *   token, matched by ancestry only): 403 — it would otherwise be stored
 *   as the owner;
 * - no credential, or the Cloud Slack credential: 401 `owner_auth_required`
 *   (the dashboard refreshes its session and retries once).
 *
 * @param req - Request
 * @param res - Response (written when refused)
 * @returns True when refused
 */
export function rejectUnidentifiedChatWriter(req: Request, res: Response): boolean {
  const identity = getCallerIdentity(req);
  if (identity.kind === 'owner' || identity.kind === 'relay-owner') return false;
  if (identity.kind === 'agent') {
    if (identity.session) return false;
    sendChatError(
      res,
      new ChatError(
        CHAT_ERROR_CODES.FORBIDDEN,
        403,
        'This call comes from an agent process whose session is unknown. Send it with your agent badge (the reply-channel skill does).',
      ),
    );
    return true;
  }
  sendOwnerAuthRequired(res, req);
  return true;
}

/**
 * `reply-channel` with a Slack thread key that is not this conversation's
 * Slack channel: deliver through the reply resolver (the key's own
 * conversation when the agent is in it, else its references / turn origin)
 * and answer for the caller. Anything else returns false (normal path).
 *
 * @param req - The send request
 * @param res - Response (written when handled)
 * @returns True when the request was handled here
 */
async function rerouteMismatchedAgentThread(req: Request, res: Response): Promise<boolean> {
  let agentSession: string | undefined;
  try {
    agentSession = principalFromRequest(req).agentSession ?? undefined;
  } catch {
    return false;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!agentSession || typeof body.threadId !== 'string' || typeof body.content !== 'string') return false;
  const { parseSlackThreadKey } = await import('../../services/slack/slack-thread-key.js');
  const key = parseSlackThreadKey(body.threadId);
  if (!key) return false;
  const conversationId = String(req.params.id);
  const { getSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
  const { getSlackAgentDmService } = await import('../../services/slack/slack-agent-dm.service.js');
  const own =
    getSlackTeamChannelService()?.findByChatChannelId(conversationId)?.slackChannelId ??
    getSlackAgentDmService()?.findByChatChannelId(conversationId)?.slackChannelId ??
    null;
  if (!own || own === key.slackChannelId) return false;
  const { deliverReply } = await import('../../services/orc/reply-destination.wiring.js');
  const delivery = await deliverReply({
    session: agentSession,
    content: body.content,
    interim: body.interim === true,
    ...(body.addsNew === true ? { addsNew: true } : {}),
    hints: { conversationId, thread: body.threadId },
  });
  if (!delivery.ok) {
    res.status(409).json({ success: false, error: delivery.error });
    return true;
  }
  res.status(201).json({
    success: true,
    data: {
      ...(delivery.messageId ? { id: delivery.messageId, channelId: delivery.conversationId } : {}),
      ...(delivery.slackChannelId ? { slackChannelId: delivery.slackChannelId, messageTs: delivery.messageTs } : {}),
      rerouted: true,
      note: `Thread ${body.threadId} is not in this conversation; the reply went to ${delivery.destination.reason}.`,
    },
  });
  return true;
}

/**
 * Upload the files of an agent's message and rewrite `req.body.content` with
 * the marker lines. Never throws and never blocks the post: a failure is
 * reported back to the agent in the response.
 *
 * @param req - The send request (body is updated in place)
 * @returns The upload report, or null when no file was involved
 */
async function attachAgentFiles(req: Request): Promise<AttachResult | null> {
  try {
    const agentSession = principalFromRequest(req).agentSession ?? undefined;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!agentSession || typeof body.content !== 'string') return null;
    const [{ attachOutboundFiles }, wiring] = await Promise.all([
      import('../../services/file-handoff/file-handoff.outbound.js'),
      import('../../services/file-handoff/file-handoff.wiring.js'),
    ]);
    const result = await attachOutboundFiles(
      { content: body.content, files: body.files, projectPath: body.projectPath, interim: body.interim === true },
      agentSession,
      String(req.params.id),
      { service: wiring.getFileHandoffService(), projectDirFor: wiring.projectDirForAgent, crossMachine: wiring.roomHasRemoteColleague },
    );
    if (result) body.content = result.content;
    return result;
  } catch {
    return null;
  }
}

/**
 * Refuse an agent's post into a Slack team room that names no thread and
 * does not ask for a new one (R7, 2026-10-18 audit): the Slack mirror would
 * put it at the channel's top level. Ella's "@Rex …" for Steve's
 * #crewly-marketing thread landed at the top of #awesome-videos that way.
 * `newThread: true` (`reply-channel --new-thread`) is a deliberate new
 * top-level post. Never blocks a post because a lookup failed.
 *
 * @param req - The send request
 * @param res - Response (written when refused)
 * @returns True when the post was refused
 */
async function refuseUnthreadedAgentPostInSlackRoom(req: Request, res: Response): Promise<boolean> {
  try {
    const session = principalFromRequestSafe(req).agentSession;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const conversationId = req.params?.id ? String(req.params.id) : '';
    if (!session || !conversationId || body.newThread === true) return false;
    if (typeof body.threadId === 'string' && body.threadId.trim()) return false;
    const { getSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
    const mapping = getSlackTeamChannelService()?.findByChatChannelId(conversationId);
    if (!mapping) return false;
    res.status(409).json({
      success: false,
      error: {
        code: 'thread_required',
        message: `Not posted: name the thread this answers (--thread <the message id or [SLACK-THREAD:<key>] from your prompt>). This room is Slack channel ${mapping.slackChannelName ?? mapping.slackChannelId}; a post with no thread would land at its top level. To reach a colleague use send-message; for a deliberate new top-level post pass --new-thread.`,
      },
      refused: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse an agent's post into a Slack room thread the owner has not written
 * in for days (STALE_OWNER_THREAD_MS): it would surface in an old thread
 * with no context. 2026-10-19: a 3-week-old reminder put Ella's Reddit
 * summary into an 80-message thread whose owner turns were weeks old. The
 * agent posts it as a new thread whose first line says what it follows up
 * on. Interim notes pass. Never blocks a post because a lookup failed.
 *
 * @param req - The send request
 * @param res - Response (written when refused)
 * @returns True when the post was refused
 */
async function refusePostInStaleOwnerThread(req: Request, res: Response): Promise<boolean> {
  try {
    const session = principalFromRequestSafe(req).agentSession;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const conversationId = req.params?.id ? String(req.params.id) : '';
    if (!session || !conversationId || body.newThread === true || body.interim === true) return false;
    if (typeof body.threadId !== 'string' || !body.threadId.trim()) return false;
    const { getSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
    const teamChannels = getSlackTeamChannelService();
    const stale = typeof teamChannels?.staleOwnerThread === 'function' ? await teamChannels.staleOwnerThread({ conversationId, thread: body.threadId }) : null;
    if (!stale) return false;
    const since = new Date(stale.lastOwnerAt).toISOString().slice(0, 10);
    res.status(409).json({
      success: false,
      error: {
        code: 'stale_owner_thread',
        message: `Not posted: the owner last wrote in this thread on ${since}; a post there now reads with no context. Post it as a new thread in this room (--new-thread), and make its first line say what it follows up on (what was agreed then, and when).`,
      },
      refused: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The reply gate (specs/2026-10-03-one-responder-per-message.md §2): an
 * agent posting in a Slack room thread where a different agent already
 * answered the owner's latest message gets `409 already_answered` with that
 * answer, and posts only with `addsNew: true` (`--adds-new`). Interim notes
 * are never held.
 *
 * @param req - The send request
 * @param res - Response (written when held)
 * @returns True when the post was held
 */
async function holdAlreadyAnsweredReply(req: Request, res: Response): Promise<boolean> {
  let agentSession: string | undefined;
  try {
    agentSession = principalFromRequest(req).agentSession ?? undefined;
  } catch {
    return false;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (!agentSession || body.interim === true || body.addsNew === true || typeof body.threadId !== 'string') return false;
  let prior: { by: string; excerpt: string; messageId: string } | null = null;
  try {
    const { getSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
    const teamChannels = getSlackTeamChannelService();
    prior = typeof teamChannels?.heldReplyFor === 'function'
      ? await teamChannels.heldReplyFor({ conversationId: String(req.params.id), thread: body.threadId, agentSession })
      : null;
  } catch {
    // The gate is a backstop: never block a reply because it failed.
    prior = null;
  }
  if (!prior) return false;
  const { heldReplyMessage } = await import('../../services/slack/room-responder.js');
  res.status(409).json({
    success: false,
    error: { code: 'already_answered', message: heldReplyMessage(prior) },
    held: true,
    existingAnswer: { by: prior.by, excerpt: prior.excerpt, messageId: prior.messageId },
  });
  return true;
}

/** Where an agents-only post taken out of an owner thread is delivered instead. */
export interface PrivateAgentDelivery {
  /** Deliver framed text to one agent */
  deliverToAgentPrivately(sessionName: string, text: string): Promise<{ success: boolean; queued?: boolean; error?: string }>;
}

/**
 * Take an agent's post into the owner's thread that only @-mentions other
 * agents out of the thread (crewly#1375; R6 of the message-routing audit
 * 2026-10-18: agents never converse inside an owner thread). The text is
 * delivered privately to the agents it @-mentions, framed with the sender
 * and the owner thread's route, and the poster gets 200
 * `{ deliveredPrivately: true, to }`. With no private delivery wired (REST
 * tests), or when it fails, the post is refused with 409 naming
 * send-message. Never blocks a post because a lookup failed.
 *
 * @param req - The send request
 * @param res - Response (written when the post is taken out)
 * @param delivery - Private delivery to agents, when wired
 * @returns True when the post did not go into the thread
 */
async function refuseAgentOnlyPostInOwnerThread(req: Request, res: Response, delivery?: PrivateAgentDelivery): Promise<boolean> {
  try {
    const session = principalFromRequestSafe(req).agentSession;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const conversationId = req.params?.id ? String(req.params.id) : '';
    if (!session || !conversationId || typeof body.content !== 'string' || !body.content.includes('@')) return false;
    const [{ getTurnTriggerTracker }, { latestInputOf }, { misdirectedAgentMention }, { StorageService }] = await Promise.all([
      import('../../services/trace/turn-trigger.js'),
      import('../../services/orc/reply-destination-resolver.js'),
      import('../../services/orc/agent-mention-post-guard.js'),
      import('../../services/core/storage.service.js'),
    ]);
    const tracker = getTurnTriggerTracker();
    const ownerAskedHere = tracker.ownerAskedRecently(session, conversationId);
    if (!ownerAskedHere) return false;
    const latest = latestInputOf(tracker.routedTrigger(session) ?? tracker.trigger(session));
    const teams = await StorageService.getInstance().getTeams().catch(() => []);
    const byName = new Map<string, string>();
    for (const team of teams) {
      for (const m of team.members ?? []) {
        if (m.name && m.sessionName) byName.set(m.name.toLowerCase(), m.sessionName);
      }
    }
    const refusal = misdirectedAgentMention({
      session,
      content: body.content,
      latest,
      ownerAskedHere,
      agentByName: (name) => byName.get(name.toLowerCase()) ?? null,
    });
    if (!refusal) return false;
    if (delivery) {
      const delivered = await deliverAgentPostPrivately(session, conversationId, body, refusal.mentioned, delivery);
      if (delivered) {
        res.status(200).json({
          success: true,
          data: {
            deliveredPrivately: true,
            to: refusal.mentioned,
            note: 'Not posted in the owner\'s thread: agents do not talk to each other there. Delivered privately to the agents you @-mentioned; post only your final answer to the owner in this thread.',
          },
        });
        return true;
      }
    }
    res.status(409).json({
      success: false,
      error: { code: 'agent_mention_in_owner_thread', message: refusal.message },
      refused: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Deliver an agents-only post privately to each agent it @-mentions, framed
 * with the poster and the owner thread's route (the answer goes back to the
 * poster; the owner thread stays the place of the final answer).
 *
 * @param session - Poster
 * @param conversationId - The owner conversation the post was written into
 * @param body - The send body (content, threadId)
 * @param to - Agent sessions to deliver to
 * @param delivery - Private delivery
 * @returns True when every agent got it
 */
async function deliverAgentPostPrivately(
  session: string,
  conversationId: string,
  body: Record<string, unknown>,
  to: string[],
  delivery: PrivateAgentDelivery,
): Promise<boolean> {
  try {
    const [{ describeAgentSender, wrapAgentMessage }, { StorageService }, { currentRouteOf }] = await Promise.all([
      import('../../services/messaging/agent-message-envelope.js'),
      import('../../services/core/storage.service.js'),
      import('../../services/orc/reply-destination.wiring.js'),
    ]);
    const described = await describeAgentSender(session, (s) => StorageService.getInstance().findMemberBySessionName(s));
    const current = await currentRouteOf(session).catch(() => null);
    const threadId = typeof body.threadId === 'string' && body.threadId ? body.threadId : undefined;
    const route: MessageRoute =
      current?.kind === 'owner' && current.conversationId === conversationId
        ? current
        : { kind: 'owner', conversationId, ...(threadId ? { thread: threadId } : {}) };
    const sender = { ...(described ?? { session, name: session }), route };
    const text = wrapAgentMessage(stripTraceMarkers(String(body.content)), sender);
    for (const target of to) {
      const result = await delivery.deliverToAgentPrivately(target, text);
      if (!result.success && !result.queued) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * {@link principalFromRequest} that never throws (post-ack paths).
 *
 * @param req - The request
 * @returns The principal, or an anonymous OSS principal
 */
function principalFromRequestSafe(req: Request): ChatPrincipal {
  try {
    return principalFromRequest(req);
  } catch {
    return { userId: '', source: 'oss' };
  }
}

/**
 * Provenance for an agent's post into a conversation (reply-channel): null
 * for anyone but an agent, or when the body has no text. Never throws.
 *
 * @param req - The POST /channels/:id/messages request
 * @returns The text to store and the record, or null
 */
async function agentPostProvenance(req: Request): Promise<{ content: string; triggeredBy?: Record<string, unknown> } | null> {
  try {
    const session = principalFromRequestSafe(req).agentSession;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!session || typeof body.content !== 'string' || !req.params?.id) return null;
    const { provenanceForAgentPost } = await import('../../services/orc/reply-destination.wiring.js');
    const thread = typeof body.threadId === 'string' && body.threadId.trim() ? body.threadId.trim() : undefined;
    return await provenanceForAgentPost({ session, conversationId: req.params.id, content: body.content, interim: body.interim === true, ...(thread ? { thread } : {}) });
  } catch {
    return null;
  }
}

/** Serialize a `ChatError` into the canonical wire shape. */
export function sendChatError(res: Response, err: ChatError): void {
  res.status(err.httpStatus).json({
    success: false,
    error: {
      code: err.code,
      message: err.message,
      details: err.details,
    },
  });
}

/** Fallback 500 responder for unknown failures. */
export function sendInternalError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  res.status(500).json({
    success: false,
    error: {
      code: CHAT_ERROR_CODES.INTERNAL,
      message: `Internal error: ${msg}`,
    },
  });
}

/** Thin wrapper that catches ChatError → 4xx and anything else → 500. */
export function runHandler<T>(res: Response, run: () => T): T | undefined {
  try {
    return run();
  } catch (err) {
    if (err instanceof ChatError) {
      sendChatError(res, err);
    } else {
      sendInternalError(res, err);
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// INBOUND-2 helpers — V3 Request + SLA hooks for chat-v2 ingress
// ---------------------------------------------------------------------------

/**
 * Canonical chat-v2 sourceConversationItemId (`chatv2-<channel>__<message>`).
 * Lives in the ticket hooks now; re-exported for existing callers.
 */
export { buildChatV2SourceId, isOrchestratorRoutedChatV2Channel };

/**
 * Where an owner's chat-v2 message came from, for the ticket's `origin`.
 *
 * @param req - The HTTP request (the mobile relay sets `X-Crewly-Client: mobile`)
 * @param principal - The resolved principal (`portal` for Cloud service tokens)
 * @returns `mobile`, `portal` or `chat`
 */
export function chatV2OriginChannel(req: Request, principal: ChatPrincipal): 'chat' | 'portal' | 'mobile' {
  const hdr = req.headers?.[TICKET_CONSTANTS.CLIENT_HEADER];
  const client = Array.isArray(hdr) ? hdr[0] : hdr;
  if (typeof client === 'string' && client.trim().toLowerCase() === TICKET_CONSTANTS.MOBILE_CLIENT) return 'mobile';
  return principal.source === 'portal' ? 'portal' : 'chat';
}

/**
 * Fire-and-forget: when an AGENT-origin chat-v2 message lands in a
 * channel that may have an outstanding `respond_to_user` WI tracked by
 * the SLA subscriber, mark it resolved (transitions the WI to `done`,
 * silences the breach + escalation timers).
 *
 * Safe to call for any agent-origin message — `markResolvedByChatV2` is
 * a no-op when the channel isn't tracked.
 *
 * @param message - The persisted message (only agent-origin is acted on)
 */
export function notifyChatV2AgentReply(message: ChatMessageDTO): void {
  if (message.senderType !== 'agent') return;

  setImmediate(async () => {
    try {
      const { getRequestSlaSubscriber } = await import(
        '../../services/v3/request-sla.subscriber.js'
      );
      const sub = getRequestSlaSubscriber();
      if (!sub) return;
      await sub.markResolvedByChatV2(message.channelId);
    } catch {
      // Non-critical — auto-resolve failure must not break chat send.
    }
  });
}

// ---------------------------------------------------------------------------
// Controller factory
// ---------------------------------------------------------------------------

/** Express handlers returned by `createChatV2Controller`. */
export interface ChatV2ControllerHandlers {
  listChannels: (req: Request, res: Response) => void;
  createChannel: (req: Request, res: Response) => void;
  getChannel: (req: Request, res: Response) => void;
  archiveChannel: (req: Request, res: Response) => void;
  markChannelRead: (req: Request, res: Response) => void;
  markChannelUnread: (req: Request, res: Response) => void;
  getUnread: (req: Request, res: Response) => void;
  listMessages: (req: Request, res: Response) => void;
  sendMessage: (req: Request, res: Response) => void | Promise<void>;
  ensureDmChannel: (req: Request, res: Response) => void;
  ensureTeamChannel: (req: Request, res: Response) => void;
  createHuddle: (req: Request, res: Response) => void;
  renameChannel: (req: Request, res: Response) => void;
  setHuddleMembers: (req: Request, res: Response) => void;
  listAgents: (req: Request, res: Response) => void | Promise<void>;
  getAgentPresence: (req: Request, res: Response) => void | Promise<void>;
  getAgentTimeline: (req: Request, res: Response) => void;
  searchMessages: (req: Request, res: Response) => void;
}

/**
 * Minimal directory entry surfaced by `GET /api/chat/agents`.
 *
 * Lives on the wire as-is; the /agents page renders one row per entry,
 * grouped by team. The fields match the join the controller performs
 * between {@link IAgentDirectoryProvider} (teams + members) and the
 * presence provider, with no extra denormalization.
 */
export interface ChatAgentDirectoryEntry {
  /** Member's `sessionName` — the agent's wire id, matches `Channel.agentSession`. */
  agentSession: string;
  /** Member display name (e.g. "Leo"). */
  name: string;
  /** Member role (e.g. "team-leader"). */
  role: string;
  /** Owning team id. */
  teamId: string;
  /** Owning team display name. */
  teamName: string;
  /** Stored agentStatus from the team file. */
  agentStatus: string;
  /** Stored workingStatus from the team file. */
  workingStatus: string;
  /** Optional emoji / avatar surfaced by the team file. */
  avatar?: string;
}

/**
 * Minimal storage surface the controller needs to enumerate agents.
 * Decoupled from `StorageService` so tests can pass a fixture without
 * spinning up SQLite + the team-file watcher.
 */
export interface IAgentDirectoryProvider {
  /**
   * Return all teams + members visible to the caller. The controller
   * filters/flattens; no need to pre-shape the response.
   */
  getTeams(): Promise<
    Array<{
      id: string;
      name: string;
      members: Array<{
        sessionName: string;
        name: string;
        role: string;
        agentStatus: string;
        workingStatus: string;
        avatar?: string;
      }>;
    }>
  >;
}

/** Wire shape returned by `GET /api/chat/presence/:agentId`. */
export interface ChatAgentPresenceDTO {
  agentSession: string;
  status: 'online' | 'busy' | 'offline' | 'starting';
  lastSeenAt: number | null;
}

/**
 * Presence resolver. Returns the live status + last-seen timestamp for
 * an agent session. Default implementation (`createDefaultPresenceProvider`)
 * delegates to the orchestrator-status helper; tests inject a stub.
 */
export interface IAgentPresenceProvider {
  getPresence(agentSession: string): Promise<ChatAgentPresenceDTO>;
}

/**
 * Optional wiring for real-time fan-out + agent dispatch. Leave undefined
 * in REST-only tests; supply both in the live server.
 *
 * Phase F — `directory` + `presence` providers are needed only by the
 * new `/agents`, `/presence/:id`, and `/channels/dm/ensure` endpoints.
 * When omitted, those endpoints return HTTP 503 `directory_unavailable`
 * so REST-only tests can keep mounting the router without wiring storage.
 */
export interface ChatV2ControllerDeps {
  gateway?: ChatV2Gateway;
  dispatcher?: ChatV2DispatcherService;
  directory?: IAgentDirectoryProvider;
  presence?: IAgentPresenceProvider;
}

/**
 * Build Express-compatible handlers for the chat-v2 endpoints.
 *
 * @param service - A configured ChatV2Service
 * @param deps    - Optional gateway/dispatcher for realtime wiring
 * @returns One handler per endpoint; wire into an Express Router
 */
export function createChatV2Controller(
  service: ChatV2Service,
  deps: ChatV2ControllerDeps = {},
): ChatV2ControllerHandlers {
  // Deps resolve in this order:
  //   1. explicit argument (tests + the realtime-aware router)
  //   2. process-wide realtime holder (populated by server start-up)
  // Falling back to the holder means the router can be mounted before the
  // gateway is live, and picks up realtime deps once they register.
  const resolveDeps = (): ChatV2ControllerDeps => {
    if (deps.gateway || deps.dispatcher) return deps;
    const live = getChatV2RealtimeDeps();
    return {
      gateway: live.gateway ?? deps.gateway,
      dispatcher: live.dispatcher ?? deps.dispatcher,
      // `directory` + `presence` are constructor-only (not realtime); pass
      // them through unchanged so the holder fallback path still surfaces
      // them to the agents/presence handlers.
      directory: deps.directory,
      presence: deps.presence,
    };
  };

  return {
    listChannels: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const includeArchived = req.query.includeArchived === 'true';
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;
        // Phase C — channel-rail listing refinements.
        // `type` and `teamId` query params let the rail fetch a focused
        // slice (e.g. only DMs, or only channels in the active workspace)
        // without shipping the full owner-scoped list. Both are optional
        // and compose with AND. Service-layer rejects unknown `type`
        // values with `validation_error`; we forward as-is so the caller
        // gets a precise error message.
        const typeRaw = req.query.type;
        const type = typeof typeRaw === 'string' && typeRaw.length > 0 ? typeRaw : undefined;
        const teamIdRaw = req.query.teamId;
        const teamId =
          typeof teamIdRaw === 'string' && teamIdRaw.length > 0 ? teamIdRaw : undefined;
        const channels = service.listChannels({
          principal,
          includeArchived,
          limit: Number.isFinite(limit) ? limit : undefined,
          type: type as ChatChannelType | undefined,
          teamId,
        });
        res.json({ success: true, data: { channels, nextCursor: null } });
      }),

    createChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const channel = service.createChannel({
          agentSession: body.agentSession,
          name: body.name,
          purpose: body.purpose,
          principal,
          // Phase A (SEALED §3.1) — Slack-like channel surfaces. Service
          // layer validates the type↔teamId↔targetMemberId combinations.
          type: body.type,
          teamId: body.teamId,
          projectId: body.projectId,
          targetMemberId: body.targetMemberId,
        });
        res.status(201).json({ success: true, data: channel });
      }),

    getChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const channel = service.getChannel(req.params.id, principal);
        res.json({ success: true, data: channel });
      }),

    markChannelRead: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const seq = (req.body as { seq?: unknown } | undefined)?.seq;
        const state = service.markChannelRead(
          req.params.id,
          principal,
          seq === undefined || seq === null ? undefined : (seq as number),
        );
        res.json({ success: true, data: state });
      }),

    markChannelUnread: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const seq = (req.body as { seq?: unknown } | undefined)?.seq;
        const state = service.markChannelUnread(req.params.id, principal, seq as number);
        res.json({ success: true, data: state });
      }),

    getUnread: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        res.json({ success: true, data: service.getUnreadSummary(principal) });
      }),

    archiveChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        service.archiveChannel(req.params.id, principal);
        res.status(204).end();
      }),

    listMessages: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined;
        const directionRaw = req.query.direction;
        const direction: 'backward' | 'forward' =
          directionRaw === 'forward' ? 'forward' : 'backward';
        const result = service.listMessages({
          channelId: req.params.id,
          principal,
          cursor,
          limit: Number.isFinite(limit) ? limit : undefined,
          direction,
        });
        res.json({ success: true, data: result });
      }),

    /**
     * POST /channels/:id/messages
     *
     * Order of operations:
     *  1. Persist via `ChatV2Service.sendMessage` (resolves senderType from
     *     `principal.agentSession` — set by the `X-Crewly-Agent-Session`
     *     header when the agent's `reply-channel` skill is the caller).
     *  2. Send HTTP 201 with the DTO (the contract-locked ack — clients
     *     reconcile optimistic pending bubbles by `clientMessageId`).
     *  3. Broadcast a WS `message` frame so peer subscribers of the same
     *     channel see the row. Idempotent on the client — reconciliation
     *     dedupes by `clientMessageId` first, then by `id`.
     *  4. If the message is USER-origin, kick the dispatcher to push the
     *     text into the agent session. Agent-origin messages skip this
     *     step to avoid self-loopback.
     *
     * Steps 3 + 4 are fire-and-forget: they run after `res.status(201)` so
     * a broken WS / missing agent never blocks the HTTP ack.
     */
    sendMessage: async (req, res) => {
      // An agent naming a Slack thread key from ANOTHER channel than this
      // conversation's (`reply-channel --channel A --thread <key of B>`): the
      // harness decides where it belongs instead of letting the mirror swap
      // in this channel's latest thread or a top-level post
      // (specs/2026-10-02-harness-owned-routing.md §1).
      if (await rerouteMismatchedAgentThread(req, res)) return;
      // No thread named in a Slack team room: never a silent top-level post (R7).
      if (await refuseUnthreadedAgentPostInSlackRoom(req, res)) return;
      // A post in the owner's thread that only talks to other agents, unprompted
      // by that thread: it goes to the agent instead (crewly#1375).
      if (await refuseAgentOnlyPostInOwnerThread(req, res, resolveDeps().dispatcher)) return;
      // A colleague already answered the owner's latest message in this
      // thread: hold this one (specs/2026-10-03-one-responder-per-message.md §2).
      // A thread the owner has not written in for days: a new thread instead.
      if (await refusePostInStaleOwnerThread(req, res)) return;
      if (await holdAlreadyAnsweredReply(req, res)) return;
      // Files an agent attached (`--file`) or mentioned by path travel as Cloud
      // handoffs; their marker lines are appended to the text before it is stored.
      const fileHandoff = await attachAgentFiles(req);
      // Why an agent is posting: the provenance record and, when the post is
      // not its answer to the owner here, a muted "Triggered by" line.
      const provenance = await agentPostProvenance(req);
      // Persist + 201 — on error, runHandler serializes it and we bail
      // without running any post-ack side-effects. On success, the
      // closure populates `persisted` + `channelForDispatch`.
      let persisted: ChatMessageDTO | undefined;
      let ackDeferred = false;
      let channelForDispatch: Awaited<ReturnType<typeof service.getChannel>> | null = null;

      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        if (Array.isArray(body.attachments) && body.attachments.length > 0) {
          throw new ChatError(
            CHAT_ERROR_CODES.VALIDATION,
            400,
            'attachments are not yet supported on this endpoint',
          );
        }
        const message = service.sendMessage({
          channelId: req.params.id,
          principal,
          // Trace ids are harness plumbing: never shown in a conversation.
          content: typeof body.content === 'string' ? stripTraceMarkers(provenance?.content ?? body.content) : body.content,
          contentType: body.contentType,
          clientMessageId: body.clientMessageId,
          attachments: [],
          // Phase A (SEALED §3.2) — mentions + threadId are forwarded to
          // the service which validates and persists them.
          mentions: body.mentions,
          threadId: body.threadId,
          interim: body.interim === true,
          ...(provenance?.triggeredBy ? { triggeredBy: provenance.triggeredBy } : {}),
        });
        // An agent's reply waits for its Slack mirror before it is acked
        // (below), so a refused Slack post is not reported as delivered.
        if (message.senderType === 'agent') ackDeferred = true;
        else res.status(201).json({ success: true, data: message, ...(fileHandoff ? { fileHandoff: { attached: fileHandoff.attached, failed: fileHandoff.failed } } : {}) });
        persisted = message;
        // Look up channel for gateway + dispatcher wiring. `getChannel`
        // requires `principal.userId === channel.owner_user_id` — which
        // matches both the normal user case and the agent-reply case
        // (the agent's principal inherits the owner's userId in Phase 1).
        try {
          channelForDispatch = service.getChannel(message.channelId, {
            userId: principal.userId,
            source: principal.source,
          });
        } catch {
          channelForDispatch = null;
        }
      });

      // If `persisted` is still undefined, runHandler already serialized an
      // error response — skip the realtime fan-out.
      if (!persisted) return;

      if (ackDeferred) {
        const delivery = await awaitSlackDelivery(persisted.id);
        if (delivery && !delivery.delivered) {
          const error = delivery.error ?? 'Slack post failed';
          res.status(502).json({
            success: false,
            error: `Slack delivery failed: ${error}`,
            data: { ...persisted, slackDelivered: false },
          });
        } else {
          res.status(201).json({ success: true, data: persisted, ...(fileHandoff ? { fileHandoff: { attached: fileHandoff.attached, failed: fileHandoff.failed } } : {}) });
        }
      }

      // -------- post-ack realtime side-effects --------
      const { gateway, dispatcher } = resolveDeps();
      try {
        // Broadcast the persisted row to the channel's WS subscribers. This
        // must NOT depend on `channelForDispatch`: that lookup uses the
        // sender's principal, and an AGENT reply (via reply-channel) whose
        // principal doesn't match the channel owner resolves it to null —
        // which previously suppressed the agent reply's realtime fan-out,
        // leaving the chat UI stuck on "thinking" until a reload. The
        // broadcast only needs the already-persisted message + its channel.
        if (gateway) {
          gateway.broadcast(
            persisted.channelId,
            buildMessageEvent(persisted.channelId, persisted),
          );
        }
      } catch {
        // broadcast must never break the ack
      }

      // Ticket loop (specs/ticket-loop.md §2): an owner message becomes a
      // ticket (or joins its thread's ticket) BEFORE it is dispatched, so the
      // agent's copy carries `[TICKET:TKT-123 <id>]`. Replaces the INBOUND-2
      // Request hook; orc-DM tickets keep the `chat-v2` tag, so the SLA
      // subscriber still tracks them.
      const toDispatch = channelForDispatch
        ? await intakeChatV2OwnerMessage(
            getTicketIntakeService(),
            channelForDispatch,
            persisted,
            chatV2OriginChannel(req, principalFromRequestSafe(req)),
          )
        : persisted;

      try {
        if (dispatcher && channelForDispatch && persisted.senderType === 'user') {
          // Phase C BE.3 — single high-level entry point that branches
          // on `channel.type` internally:
          //   `type='dm'`     → 1:1 dispatch via dispatchToAgent (legacy)
          //   `type='channel'`→ resolve `mentions[]` → fan-out per target
          // Fire-and-forget — already past the HTTP ack at this point.
          void dispatcher.dispatchMessage(channelForDispatch, toDispatch);
        }
      } catch {
        // dispatcher must never break the ack
      }

      // INBOUND-2 — SLA auto-resolve on agent replies. Fire-and-forget.
      try {
        notifyChatV2AgentReply(persisted);
      } catch {
        // INBOUND-2 hooks must never break the ack
      }
    },

    /**
     * POST /channels/dm/ensure
     *
     * Find-or-create a DM channel for the caller bound to `agentSession`.
     * Idempotent: repeated calls for the same (owner, agentSession) return
     * the same channel row, so the /agents page can map "click agent" →
     * "active channel" without leaking duplicate DMs on reloads.
     *
     * Status code:
     *  - 200 when the channel already existed
     *  - 201 when a new channel was created
     */
    ensureDmChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const { channel, created } = service.ensureDmChannel({
          agentSession: body.agentSession,
          name: body.name,
          purpose: body.purpose,
          principal,
        });
        res.status(created ? 201 : 200).json({ success: true, data: channel });
      }),

    /**
     * POST /channels/team/ensure
     *
     * Find-or-create the canonical channel for a team. Backs the
     * consolidated team-chat deep-link (`/team-chat?team=<id>`) so opening
     * a team's workspace always lands on a real channel even if none was
     * created manually.
     *
     * Status code:
     *  - 200 when the team already had a channel
     *  - 201 when a new channel was created
     */
    ensureTeamChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const { channel, created } = service.ensureTeamChannel({
          teamId: body.teamId,
          name: body.name,
          purpose: body.purpose,
          principal,
        });
        res.status(created ? 201 : 200).json({ success: true, data: channel });
      }),

    /**
     * POST /channels/huddle
     *
     * Create an ad-hoc multi-agent group chat ("拉群"). Body:
     * `{ name, memberSessions: string[], purpose? }`. Messages posted to
     * the resulting `type='huddle'` channel fan out to every member agent
     * via the dispatcher's huddle-broadcast strategy.
     */
    createHuddle: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const channel = service.createHuddle({
          name: body.name,
          purpose: body.purpose,
          memberSessions: Array.isArray(body.memberSessions) ? body.memberSessions : [],
          principal,
        });
        res.status(201).json({ success: true, data: channel });
      }),

    /**
     * PATCH /channels/:id
     *
     * Rename a group chat or team channel (#1400 private channels). Body:
     * `{ name }`. DMs and Crewly channels are refused (400).
     */
    renameChannel: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const channel = service.renameChannel(
          req.params.id,
          typeof body.name === 'string' ? body.name : '',
          principal,
        );
        res.json({ success: true, data: channel });
      }),

    /**
     * PUT /channels/:id/members
     *
     * Replace a group chat's roster (#1400 private channels). Body:
     * `{ memberSessions: string[] }` — the complete desired roster.
     */
    setHuddleMembers: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const body = req.body ?? {};
        const memberSessions = Array.isArray(body.memberSessions)
          ? (body.memberSessions as unknown[]).filter((m): m is string => typeof m === 'string')
          : [];
        const channel = service.setHuddleRoster(req.params.id, memberSessions, principal);
        res.json({ success: true, data: channel });
      }),

    /**
     * GET /agents
     *
     * Directory of all agents reachable from the configured teams.
     * Returns one entry per (team × member), with cached
     * agentStatus/workingStatus from the team file. The /agents page
     * uses this to render the left rail; presence freshness comes from
     * the per-agent `GET /presence/:agentId` endpoint, not from this list
     * (intentional — the list is cheap; presence is per-row + on focus).
     *
     * Returns HTTP 503 `directory_unavailable` when the controller was
     * wired without a `directory` provider (REST-only tests, etc.).
     */
    listAgents: async (req, res) => {
      try {
        // principalFromRequest enforces auth; the returned principal is
        // intentionally unused here because the directory is global
        // within a single OSS instance (no per-user filtering yet).
        principalFromRequest(req);
        const { directory } = resolveDeps();
        if (!directory) {
          res.status(503).json({
            success: false,
            error: {
              code: 'directory_unavailable',
              message: 'agent directory provider is not wired',
            },
          });
          return;
        }
        const teams = await directory.getTeams();
        const entries: ChatAgentDirectoryEntry[] = [];
        for (const team of teams) {
          for (const member of team.members) {
            const sessionName = (member.sessionName ?? '').trim();
            if (sessionName.length === 0) continue;
            entries.push({
              agentSession: sessionName,
              name: member.name,
              role: member.role,
              teamId: team.id,
              teamName: team.name,
              agentStatus: member.agentStatus,
              workingStatus: member.workingStatus,
              avatar: member.avatar,
            });
          }
        }
        res.json({ success: true, data: { agents: entries } });
      } catch (err) {
        if (err instanceof ChatError) {
          sendChatError(res, err);
        } else {
          sendInternalError(res, err);
        }
      }
    },

    /**
     * GET /presence/:agentId
     *
     * Returns the agent's current presence + last-seen timestamp. Backs
     * the chat-ui `getAgentPresence(agentId)` client call so the message
     * thread can surface a live `online/busy/offline` badge per agent.
     *
     * Returns HTTP 503 `presence_unavailable` when the controller was
     * wired without a `presence` provider (REST-only tests).
     */
    getAgentPresence: async (req, res) => {
      try {
        principalFromRequest(req);
        const agentId = (req.params.agentId ?? '').trim();
        if (agentId.length === 0) {
          throw new ChatError(
            CHAT_ERROR_CODES.VALIDATION,
            400,
            'agentId is required',
          );
        }
        const { presence } = resolveDeps();
        if (!presence) {
          res.status(503).json({
            success: false,
            error: {
              code: 'presence_unavailable',
              message: 'presence provider is not wired',
            },
          });
          return;
        }
        const result = await presence.getPresence(agentId);
        res.json({ success: true, data: result });
      } catch (err) {
        if (err instanceof ChatError) {
          sendChatError(res, err);
        } else {
          sendInternalError(res, err);
        }
      }
    },

    /**
     * `GET /agents/:session/timeline?before=<ms>&cursor=&limit=50&source=slack,cloud-talk`
     * — one agent's messages across every surface, newest first
     * (specs/unified-conversations-cloud-store.md §A.5). `source` (or
     * `sources`) is a comma-separated filter.
     */
    /**
     * `GET /search?q=<keywords>&channel=&from=&to=&limit=&session=` — search the
     * chat history the caller can see. An agent searches as itself (its badge);
     * the owner names the agent with `session`, or leaves it out to search
     * every conversation (#1400). `from` / `to` take a date (`2026-10-09`) or
     * a timestamp.
     */
    searchMessages: (req, res) =>
      runHandler(res, () => {
        const identity = getCallerIdentity(req);
        if (identity.kind !== 'owner' && identity.kind !== 'relay-owner' && rejectUnverifiedCaller(req, res, 'Searching chat history')) return;
        const principal = principalFromRequest(req);
        const q = req.query;
        const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
        const when = (v: unknown, endOfDay: boolean): number | undefined => {
          const raw = str(v);
          if (!raw) return undefined;
          const ms = Date.parse(raw);
          if (!Number.isFinite(ms)) {
            throw new ChatError(CHAT_ERROR_CODES.VALIDATION, 400, `bad date: ${raw}`);
          }
          // A bare date means the whole day.
          return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? ms + 24 * 60 * 60 * 1000 : ms;
        };
        const limitRaw = typeof q.limit === 'string' ? Number.parseInt(q.limit, 10) : undefined;
        const hits = service.searchMessagesForAgent({
          agentSession: principal.agentSession ?? str(q.session),
          principal,
          query: str(q.q) ?? '',
          channel: str(q.channel),
          from: when(q.from, false),
          to: when(q.to, true),
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        });
        res.json({ success: true, data: { count: hits.length, hits } });
      }),

    getAgentTimeline: (req, res) =>
      runHandler(res, () => {
        const principal = principalFromRequest(req);
        const q = req.query;
        const beforeRaw = typeof q.before === 'string' ? Number(q.before) : undefined;
        const limitRaw = typeof q.limit === 'string' ? Number.parseInt(q.limit, 10) : undefined;
        const sourceRaw = typeof q.source === 'string' ? q.source : typeof q.sources === 'string' ? q.sources : '';
        const result = service.getAgentTimeline({
          agentSession: req.params.session ?? '',
          principal,
          before: Number.isFinite(beforeRaw) ? beforeRaw : undefined,
          cursor: typeof q.cursor === 'string' && q.cursor.length > 0 ? q.cursor : null,
          limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
          sources: sourceRaw ? sourceRaw.split(',') : [],
        });
        res.json({ success: true, data: result });
      }),
  };
}
