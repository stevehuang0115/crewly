/**
 * Chat Controller
 *
 * HTTP request handlers for chat functionality. Provides endpoints for
 * sending messages, managing conversations, and retrieving chat history.
 *
 * @module controllers/chat/chat.controller
 */

import type { Request, Response, NextFunction } from 'express';
import {
  getChatService,
  MessageValidationError,
  ConversationNotFoundError,
} from '../../services/chat/chat.service.js';
// Phase 6c — chat.controller.ts still imports the legacy ChatService
// façade. Behaviour-neutral: the façade is a thin shim over
// ChatV2Service (single storage, single write primitive). The 14
// call sites below will be replaced one endpoint at a time in a
// follow-up cleanup PR; doing so does not change runtime
// architecture, only the import surface.
import { sanitizeMessages, sanitizeMessage } from '../../services/chat/chat-sanitizer.service.js';
import { getChatHighlightsService } from '../../services/chat/chat-highlights.service.js';
import { ORCHESTRATOR_SESSION_NAME, ORC_STATUS_FORWARDING, OWNER_EVIDENCE_METADATA, SLACK_TYPING_CONSTANTS, SLACK_THREAD_KEY_CONSTANTS } from '../../constants.js';
import { extractSlackThreadKeys, formatSlackThreadKey, parseSlackThreadKey } from '../../services/slack/slack-thread-key.js';
import { readAgentSessionHeader } from '../../utils/agent-caller.utils.js';
import { isOwnerCaller, sendOwnerAuthRequired } from '../../middleware/caller-identity.middleware.js';
import { OrcReplyRouteService } from '../../services/orc/orc-reply-route.service.js';
import { OrcStatusRouterService } from '../../services/orc/orc-status-router.service.js';
import { getTicketIntakeService } from '../../services/v3/ticket-intake.service.js';
import {
  appendTicketLine,
  chatV2ConversationRef,
  chatV2ThreadRef,
  intakeWithin,
  ticketOfOutcome,
} from '../../services/v3/ticket-channel-hooks.js';
import { getSessionBackendSync } from '../../services/session/session-backend.factory.js';
import { LoggerService, ComponentLogger } from '../../services/core/logger.service.js';
import type { MessageQueueService } from '../../services/messaging/message-queue.service.js';
import type {
  SendMessageInput,
  ChatMessageFilter,
  ConversationFilter,
  ChatSenderType,
  ChatContentType,
  ChatChannelType,
} from '../../types/chat.types.js';
import { isValidChannelType } from '../../types/chat.types.js';
import { stripTraceMarkers } from '../../services/trace/trace-markers.js';

// Module-level message queue service instance
let messageQueueService: MessageQueueService | null = null;

// Module-level thread status queue service instance
let threadStatusQueueService: import('../../services/messaging/thread-status-queue.service.js').ThreadStatusQueueService | null = null;

// Logger instance for chat controller
const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ChatController');

/**
 * Set the message queue service for enqueuing messages to the orchestrator.
 * Called during server initialization.
 *
 * @param service - The MessageQueueService instance
 */
export function setMessageQueueService(service: MessageQueueService): void {
  messageQueueService = service;
  // Agent status reports are routed (orchestrator, team lead, digest) through
  // the same queue (specs/2026-10-01-orc-status-wakes.md).
  OrcStatusRouterService.getInstance().setEnqueue(service ? (input) => service.enqueue(input) : null);
}

/**
 * Set the thread status queue service for thread status API endpoints.
 * Called during server initialization.
 *
 * @param service - The ThreadStatusQueueService instance
 */
export function setThreadStatusQueueService(
  service: import('../../services/messaging/thread-status-queue.service.js').ThreadStatusQueueService
): void {
  threadStatusQueueService = service;
}

// =============================================================================
// Message Endpoints
// =============================================================================

/** How a chat message reached (or failed to reach) the orchestrator. */
export interface OrchestratorDeliveryStatus {
  forwarded: boolean;
  queued?: boolean;
  queueId?: string;
  error?: string;
}

/** Input of {@link sendChatMessageToOrchestrator}. */
export interface ChatToOrchestratorInput {
  /** Message text (must be non-empty) */
  content: string;
  /** Existing conversation, or a new one when omitted */
  conversationId?: string;
  /** Caller metadata stored on the message */
  metadata?: Record<string, unknown>;
  /** Forward to the orchestrator (default true) */
  forwardToOrchestrator?: boolean;
  /** Set when an agent session wrote the message (`X-Agent-Session`) */
  agentSession?: string | null;
}

/** Result of {@link sendChatMessageToOrchestrator}. */
export interface ChatToOrchestratorResult {
  /** Stored message and its conversation */
  result: Awaited<ReturnType<ReturnType<typeof getChatService>['sendMessage']>>;
  /** Delivery to the orchestrator */
  orchestrator: OrchestratorDeliveryStatus;
}

/**
 * Record a chat message and hand it to the orchestrator — the path behind
 * `POST /api/chat/send`, shared with the first-run checklist's "first task"
 * (specs/onboarding-harness-login.md, Phase 3).
 *
 * The message is stored as a `user` turn; when an agent session wrote it,
 * that session is recorded so the commitment-approval gate never reads it as
 * the owner's words. The owner's messages go through ticket intake. Delivery
 * uses the message queue, which also holds the message while the
 * orchestrator is offline.
 *
 * @param input - Content, conversation, metadata, forward flag, agent session
 * @returns Stored message + conversation and the orchestrator delivery status
 * @throws MessageValidationError for invalid content (from the chat service)
 *
 * @example
 * ```ts
 * const { orchestrator } = await sendChatMessageToOrchestrator({ content: 'Plan my week' });
 * ```
 */
export async function sendChatMessageToOrchestrator(input: ChatToOrchestratorInput): Promise<ChatToOrchestratorResult> {
  const { content, conversationId, metadata, forwardToOrchestrator: shouldForward = true, agentSession } = input;

  // This records a `user` turn. When an agent session calls it, keep the
  // message but mark who wrote it: the commitment-approval gate treats `user`
  // rows as the owner's words and must never be satisfied by text an agent
  // posted (#730 / 2026-06-02 incident).
  const sendInput: SendMessageInput = {
    content,
    conversationId,
    metadata: agentSession
      ? { ...(metadata ?? {}), [OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION]: agentSession }
      : metadata,
  };

  const chatService = getChatService();
  const result = await chatService.sendMessage(sendInput);

  // Ticket loop (specs/ticket-loop.md §2): the owner's message goes through
  // the single intake — which may open a ticket (receipt posted in this
  // conversation), join an open one, or be ignored. Only the owner files
  // tickets: an agent posting here (X-Agent-Session) never does. Bounded
  // wait; the message is forwarded either way.
  const ticket = ticketOfOutcome(
    await intakeWithin(getTicketIntakeService(), {
      text: content,
      isOwner: !agentSession,
      origin: {
        channel: 'chat',
        // Same source id the pre-ticket code used, so dedupe still holds.
        ref: result.message.id,
        threadRef: chatV2ThreadRef(result.conversation.id, result.message.id),
        author: 'owner',
      },
      conversationRef: chatV2ConversationRef(result.conversation.id),
      targetAgent: ORCHESTRATOR_SESSION_NAME,
      tags: ['chat-ui'],
      receipt: { kind: 'chat-v2', chatChannelId: result.conversation.id },
    }).catch(() => null),
  );
  const deliveryContent = appendTicketLine(content, ticket);

  // Enqueue message for orchestrator processing if enabled (default: true)
  let orchestratorStatus: OrchestratorDeliveryStatus = { forwarded: false };

  if (shouldForward) {
    const backend = getSessionBackendSync();
    const sessionExists = backend?.sessionExists(ORCHESTRATOR_SESSION_NAME) ?? false;

    if (!sessionExists && !messageQueueService) {
      // #247: Only fail if both orchestrator is down AND queue is unavailable.
      // If the queue is available, enqueue the message for replay when
      // the orchestrator comes back online.
      orchestratorStatus = {
        forwarded: false,
        error: 'Orchestrator is not running. Please start the orchestrator first.',
      };
    } else if (!sessionExists && messageQueueService) {
      // #247: Orchestrator is offline but queue is available — queue for later delivery.
      // The queue processor defers delivery until the orchestrator registers as active.
      try {
        const queued = messageQueueService.enqueue({
          content: deliveryContent,
          conversationId: result.conversation.id,
          source: 'web_chat',
        });
        orchestratorStatus = {
          forwarded: true,
          queued: true,
          queueId: queued.id,
          error: 'Orchestrator is currently offline. Message queued for delivery when it comes back online.',
        };
        logger.info('Message queued for offline orchestrator (#247)', {
          conversationId: result.conversation.id,
          queueId: queued.id,
        });
      } catch (enqueueErr) {
        orchestratorStatus = {
          forwarded: false,
          error: `Orchestrator offline and queue failed: ${enqueueErr instanceof Error ? enqueueErr.message : 'Unknown error'}`,
        };
      }
    } else if (!messageQueueService) {
      orchestratorStatus = {
        forwarded: false,
        error: 'Message queue service not initialized',
      };
    } else {
      try {
        const queued = messageQueueService.enqueue({
          content: deliveryContent,
          conversationId: result.conversation.id,
          source: 'web_chat',
        });
        orchestratorStatus = { forwarded: true, queued: true, queueId: queued.id };
      } catch (enqueueErr) {
        logger.warn('Failed to enqueue message', {
          error: enqueueErr instanceof Error ? enqueueErr.message : String(enqueueErr),
          conversationId: result.conversation.id,
        });
        orchestratorStatus = {
          forwarded: false,
          error: enqueueErr instanceof Error ? enqueueErr.message : 'Failed to enqueue message',
        };
      }
    }
  }

  // The owner's message now waits for the orchestrator's answer: watched
  // until it comes (specs/2026-09-30-owner-message-guarantee.md).
  if (!agentSession && orchestratorStatus.forwarded) {
    try {
      const { getOwnerMessageWatchdog } = await import('../../services/messaging/owner-message-watchdog.service.js');
      getOwnerMessageWatchdog()?.track({
        surface: 'chat',
        chatChannelId: result.conversation.id,
        messageId: result.message.id,
        responsible: ORCHESTRATOR_SESSION_NAME,
        recipients: [ORCHESTRATOR_SESSION_NAME],
        required: true,
        text: content,
      });
    } catch {
      /* watchdog is best-effort */
    }
  }

  return { result, orchestrator: orchestratorStatus };
}

/**
 * POST /api/chat/send
 *
 * Send a message to the orchestrator. Creates a new conversation if
 * conversationId is not provided.
 *
 * @param req - Request with body: { content: string, conversationId?: string, metadata?: object }
 * @param res - Response with sent message and conversation
 */
export async function sendMessage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { content, conversationId, metadata, forwardToOrchestrator } = req.body;

    if (!content || (typeof content === 'string' && content.trim().length === 0)) {
      res.status(400).json({
        success: false,
        error: 'Message content is required',
      });
      return;
    }

    const callerMetadata =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    // The message is stored as the owner's only for an owner credential
    // (#999). An agent's is filed as that agent's; a caller with neither
    // could otherwise speak as the owner, so it is refused.
    const owner = isOwnerCaller(req);
    const agentSession = owner ? undefined : readAgentSessionHeader(req);
    if (!owner && !agentSession) {
      sendOwnerAuthRequired(res, req);
      return;
    }
    const { result, orchestrator } = await sendChatMessageToOrchestrator({
      content,
      conversationId,
      // An agent's metadata is merged into; the owner's is passed through as sent.
      metadata: agentSession ? callerMetadata : metadata,
      forwardToOrchestrator,
      agentSession,
    });

    res.status(201).json({
      success: true,
      data: {
        ...result,
        orchestrator,
      },
    });

  } catch (error) {
    if (error instanceof MessageValidationError) {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }
    next(error);
  }
}

/**
 * GET /api/chat/messages
 *
 * Get messages for a conversation with optional filtering.
 *
 * @param req - Request with query params for filtering
 * @param res - Response with array of messages
 */
export async function getMessages(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { conversationId, senderType, contentType, after, before, limit, offset } = req.query;

    if (!conversationId) {
      res.status(400).json({
        success: false,
        error: 'conversationId is required',
      });
      return;
    }

    const filter: ChatMessageFilter = {
      conversationId: conversationId as string,
      senderType: senderType as ChatSenderType | undefined,
      contentType: contentType as ChatContentType | undefined,
      after: after as string | undefined,
      before: before as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    };

    const chatService = getChatService();
    const [messages, totalCount] = await Promise.all([
      chatService.getMessages(filter),
      chatService.getMessageCount(filter),
    ]);

    // hasMore is true when there are older messages not included in this response.
    // For default loads (no offset), the returned messages are the newest tail,
    // so hasMore = totalCount > messages.length. For explicit offset loads,
    // hasMore = offset > 0 (there are messages before the offset window).
    const hasMore = offset
      ? parseInt(offset as string, 10) > 0
      : totalCount > messages.length;

    res.json({
      success: true,
      data: sanitizeMessages(messages),
      count: messages.length,
      totalCount,
      hasMore,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/messages/:conversationId/:messageId
 *
 * Get a single message by ID.
 *
 * @param req - Request with conversationId and messageId params
 * @param res - Response with the message
 */
export async function getMessage(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { conversationId, messageId } = req.params;

    const chatService = getChatService();
    const message = await chatService.getMessage(conversationId, messageId);

    if (!message) {
      res.status(404).json({
        success: false,
        error: 'Message not found',
      });
      return;
    }

    res.json({
      success: true,
      data: sanitizeMessage(message),
    });
  } catch (error) {
    next(error);
  }
}

// =============================================================================
// Agent Response Endpoint
// =============================================================================

/**
 * Whether `name` is the display name of the team member running as
 * `agentSession` (case-insensitive).
 *
 * @param agentSession - The member's session name
 * @param name - A display name an agent passed as `senderName`
 * @returns True when they denote the same member
 */
async function isMemberNameOf(agentSession: string, name: string): Promise<boolean> {
  const wanted = (name ?? '').trim().toLowerCase();
  if (!wanted) return false;
  try {
    const { StorageService } = await import('../../services/core/storage.service.js');
    for (const team of await StorageService.getInstance().getTeams()) {
      const member = team.members?.find((m) => m.sessionName === agentSession);
      if (member) return (member.name ?? '').trim().toLowerCase() === wanted;
    }
  } catch {
    /* storage unavailable — fall through */
  }
  return false;
}

/**
 * The session an agent's `senderName` stands for: a session name as is, else
 * the member with that display name ("Ella", "Avery") — the one in
 * `conversationId` when several share the name.
 *
 * @param senderName - Session or display name the agent passed
 * @param conversationId - Conversation it named, if any
 * @returns Session name (the input when nothing matches)
 */
export async function sessionOfSender(senderName: string, conversationId?: string): Promise<string> {
  const wanted = senderName.trim().toLowerCase();
  if (!wanted) return senderName;
  try {
    const { StorageService } = await import('../../services/core/storage.service.js');
    const members = (await StorageService.getInstance().getTeams()).flatMap((t) => t.members ?? []);
    if (members.some((m) => m.sessionName === senderName)) return senderName;
    const named = members.filter((m) => (m.name ?? '').trim().toLowerCase() === wanted).map((m) => m.sessionName);
    if (named.length === 1) return named[0];
    if (named.length > 1 && conversationId) {
      for (const s of named) if (await isAgentsOwnConversation(s, conversationId)) return s;
    }
    if (named.length > 0) return named[0];
  } catch {
    /* storage unavailable — use the name as given */
  }
  return senderName;
}

/**
 * Record an agent's reply on its own chat-v2 DM channel when
 * `conversationId` names one (the channel is bound to this very agent).
 * Anything else — an orchestrator thread a sub-agent reports [DONE] into,
 * a team channel, a legacy conversation — returns null so the caller keeps
 * the orchestrator status-report path.
 *
 * @param channelId - The conversation id the agent replied to
 * @param senderName - The agent's session name
 * @param content - Reply text
 * @returns The persisted message id, or null when not a chat-v2 channel
 */
async function recordChatV2AgentReply(
  channelId: string,
  senderName: string,
  content: string,
  headerSession?: string,
  interim = false,
  slackThreadKey?: string,
  extraMetadata?: Record<string, unknown>,
): Promise<string | null> {
  try {
    const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
    const chatV2 = getChatV2Service();
    const channel = chatV2.getChannelForBridge(channelId);
    if (!channel || channel.archivedAt) return null;
    if (channel.type !== 'dm' || !channel.agentSession) return null;
    // Who is replying: the skills' X-Agent-Session header is authoritative;
    // agents also pass their display name ("Ella") as senderName, so accept
    // the member name bound to this channel's session as well.
    const isOwnChannel =
      headerSession === channel.agentSession ||
      senderName === channel.agentSession ||
      (await isMemberNameOf(channel.agentSession, senderName));
    if (!isOwnChannel) return null;
    const { message } = chatV2.recordTurn({
      channelId,
      senderType: 'agent',
      senderId: channel.agentSession,
      content,
      metadata: {
        ...(extraMetadata ?? {}),
        source: 'reply-tool',
        ...(interim ? { [SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY]: true } : {}),
        // The Slack thread this answer is for (`reply-chat --thread <key>`):
        // the DM bridge posts it there, not in the thread written in last.
        ...(slackThreadKey ? { [SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]: slackThreadKey } : {}),
      },
    });
    logger.info('Agent reply recorded on chat-v2 channel', {
      senderName,
      agentSession: channel.agentSession,
      channelId,
      channelType: channel.type,
      messageId: message.id,
    });
    return message.id;
  } catch (err) {
    logger.warn('Could not record the agent reply on chat-v2 (falling back to the status path)', {
      channelId,
      senderName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whether an `agent-response` body is a report-status line for the
 * orchestrator ([DONE], [WORKING], [IDLE], [STATUS REPORT], …) rather than
 * content a person is waiting for.
 *
 * @param content - The posted text
 * @returns True for a status marker
 */
export function isAgentStatusMarker(content: string): boolean {
  return ORC_STATUS_FORWARDING.STATUS_MARKERS.test(content);
}

/**
 * Record an agent's answer in a Slack-mapped room (the huddle behind a Slack
 * team/ad-hoc channel) when it arrives through `agent-response` instead of
 * `reply-channel`. The row is the same one `reply-channel` writes — an agent
 * turn in the huddle, in the owner's thread — so the Slack mirror posts it as
 * the agent's bot and replaces its "working on it" placeholder.
 *
 * 2026-09-30 (#steamfun运维组): the owner @'d Avery; her `reply-channel`
 * calls were refused (her shell carried the orchestrator's session name), so
 * she fell back to `reply-chat` with the room's conversation id. The endpoint
 * only knew agent DMs, took her whole answer for a status report and queued
 * it for the orchestrator; the owner saw nothing.
 *
 * Only a substantive reply qualifies (status markers keep the orchestrator
 * path), only from a member of the room, and only for a thread the agent was
 * asked in: the thread it named, or the latest message that @'d it here.
 *
 * @param input - Channel id, sender, content, header session, interim flag, raw thread reference
 * @returns The persisted message id, or null to keep the status path
 */
async function recordSlackRoomAgentReply(input: {
  channelId: string;
  senderName: string;
  content: string;
  headerSession?: string;
  interim: boolean;
  rawThread?: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  if (isAgentStatusMarker(input.content)) return null;
  try {
    const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
    const chatV2 = getChatV2Service();
    const channel = chatV2.getChannelForBridge(input.channelId);
    if (!channel || channel.archivedAt || channel.type !== 'huddle') return null;
    const { getSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
    const mapping = getSlackTeamChannelService()?.findByChatChannelId(input.channelId) ?? null;
    if (!mapping) return null;

    // Who is replying: a room member named by the header, by session, or by
    // display name. The header is normally authoritative, but it can be
    // wrong — the skill shell inherits CREWLY_SESSION_NAME from wherever the
    // runtime spawned it (Codex's shared app-server carried the
    // orchestrator's) — and a header that is not in the room names nobody.
    const members = chatV2.queryHuddleMembersForDispatch(input.channelId);
    let agentSession: string | null = null;
    if (input.headerSession && members.includes(input.headerSession)) agentSession = input.headerSession;
    else if (members.includes(input.senderName)) agentSession = input.senderName;
    else {
      for (const m of members) {
        if (await isMemberNameOf(m, input.senderName)) {
          agentSession = m;
          break;
        }
      }
    }
    if (!agentSession) return null;
    if (input.headerSession && input.headerSession !== agentSession) {
      logger.warn('agent-response header names a different session than the replying room member — the skill shell has the wrong CREWLY_SESSION_NAME', {
        headerSession: input.headerSession,
        senderName: input.senderName,
        resolvedAgent: agentSession,
        channelId: input.channelId,
      });
    }

    // Which thread: the one named (a huddle message id — what the delivered
    // prompt hands out — or a Slack thread key of this channel), else the
    // latest message that @'d this agent here recently. No evidence the
    // agent was asked in this room → not ours to post.
    let threadId: string | undefined;
    const raw = input.rawThread?.trim();
    if (raw) {
      const named = chatV2.getMessageForBridge(raw);
      if (named && named.channelId === input.channelId) threadId = named.threadId ?? named.id;
      const key = parseSlackThreadKey(raw);
      if (!threadId && key && key.slackChannelId === mapping.slackChannelId) {
        threadId = chatV2.findSlackThreadRoot(input.channelId, key.threadTs)?.id;
      }
    }
    if (!threadId) {
      const asked = chatV2.findLatestUserMessageMentioning(
        input.channelId,
        agentSession,
        Date.now() - ORC_STATUS_FORWARDING.RECENT_ROOM_REQUEST_WINDOW_MS,
      );
      if (asked) threadId = asked.threadId ?? asked.id;
    }
    if (!threadId) return null;

    const { message } = chatV2.recordTurn({
      channelId: input.channelId,
      senderType: 'agent',
      senderId: agentSession,
      content: input.content,
      threadId,
      metadata: {
        ...(input.metadata ?? {}),
        source: 'reply-tool',
        ...(input.interim ? { [SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY]: true } : {}),
      },
    });
    try {
      const { notifyChatV2AgentReply } = await import('../chat-v2/chat-v2.controller.js');
      notifyChatV2AgentReply(message);
    } catch {
      /* SLA auto-resolve is best-effort */
    }
    logger.info('Agent reply to a Slack room delivered as the agent (arrived via agent-response)', {
      agentSession,
      channelId: input.channelId,
      slackChannel: mapping.slackChannelId,
      threadId,
      messageId: message.id,
    });
    return message.id;
  } catch (err) {
    logger.warn('Could not deliver the agent reply to its Slack room (falling back to the status path)', {
      channelId: input.channelId,
      senderName: input.senderName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whether `agentSession` may answer in chat-v2 conversation `conversationId`:
 * its own DM channel, or a huddle / room it is a member of.
 *
 * @param agentSession - Replying agent
 * @param conversationId - chat-v2 channel id
 * @returns True when it is the agent's own conversation
 */
export async function isAgentsOwnConversation(agentSession: string, conversationId: string): Promise<boolean> {
  try {
    const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
    const chatV2 = getChatV2Service();
    const channel = chatV2.getChannelForBridge(conversationId);
    if (!channel || channel.archivedAt) return false;
    if (channel.type === 'dm') return channel.agentSession === agentSession;
    return chatV2.queryHuddleMembersForDispatch(conversationId).includes(agentSession);
  } catch {
    return false;
  }
}

/**
 * Deliver an agent's answer into a chat-v2 conversation over the right
 * transport — the one reply path behind `reply` (and the tolerant fallback of
 * `agent-response`), specs/2026-09-30-owner-message-guarantee.md §B:
 *  - its own DM channel → the agent's turn there (mirrored to the Slack DM
 *    when the owner wrote from Slack, shown in the portal otherwise), in the
 *    Slack thread `thread` names;
 *  - a Slack room → the same row `reply-channel` writes, posted as the agent's
 *    bot in the owner's thread;
 *  - any other huddle it is a member of → an agent turn in `thread`.
 *
 * @param input - Conversation, thread (Slack thread key or chat-v2 message id), agent, text, interim flag
 * @returns The persisted message id, or null when the conversation is not the agent's
 */
export async function deliverAgentReplyToConversation(input: {
  conversationId: string;
  thread?: string;
  agentSession: string;
  content: string;
  interim?: boolean;
  /** Extra metadata on the recorded row (e.g. the harness marking a ticket delivery) */
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  // Trace ids are harness plumbing: never shown to the owner.
  input = { ...input, content: stripTraceMarkers(input.content) };
  const slackKey = parseSlackThreadKey(input.thread);
  const formattedKey = slackKey ? formatSlackThreadKey(slackKey.slackChannelId, slackKey.threadTs) : undefined;
  const dm = await recordChatV2AgentReply(
    input.conversationId,
    input.agentSession,
    input.content,
    input.agentSession,
    input.interim === true,
    formattedKey,
    input.metadata,
  );
  if (dm) return dm;
  const room = await recordSlackRoomAgentReply({
    channelId: input.conversationId,
    senderName: input.agentSession,
    content: input.content,
    headerSession: input.agentSession,
    interim: input.interim === true,
    rawThread: input.thread,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  if (room) return room;
  try {
    const { getChatV2Service } = await import('../../services/chat-v2/chat-v2.singleton.js');
    const chatV2 = getChatV2Service();
    const channel = chatV2.getChannelForBridge(input.conversationId);
    if (!channel || channel.archivedAt || channel.type === 'dm') return null;
    if (!chatV2.queryHuddleMembersForDispatch(input.conversationId).includes(input.agentSession)) return null;
    // A Slack-mapped room took no thread above: a row here would be mirrored
    // into whatever Slack thread is latest — not ours to guess
    // (specs/2026-10-02-harness-owned-routing.md §1).
    const { getSlackTeamChannelService } = await import('../../services/slack/slack-team-channel.service.js');
    if (getSlackTeamChannelService()?.findByChatChannelId(input.conversationId)) return null;
    let threadId: string | undefined;
    if (input.thread && !slackKey) {
      const named = chatV2.getMessageForBridge(input.thread);
      if (named && named.channelId === input.conversationId) threadId = named.threadId ?? named.id;
    }
    const { message } = chatV2.recordTurn({
      channelId: input.conversationId,
      senderType: 'agent',
      senderId: input.agentSession,
      content: input.content,
      ...(threadId ? { threadId } : {}),
      metadata: {
        ...(input.metadata ?? {}),
        source: 'reply-tool',
        ...(input.interim ? { [SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY]: true } : {}),
      },
    });
    try {
      const { notifyChatV2AgentReply } = await import('../chat-v2/chat-v2.controller.js');
      notifyChatV2AgentReply(message);
    } catch {
      /* SLA auto-resolve is best-effort */
    }
    logger.info('Agent reply recorded in its huddle', {
      agentSession: input.agentSession,
      channelId: input.conversationId,
      threadId,
      messageId: message.id,
    });
    return message.id;
  } catch (err) {
    logger.warn('Could not record the agent reply in its huddle', {
      channelId: input.conversationId,
      agentSession: input.agentSession,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A substantive answer that would otherwise be filed as a status report:
 * when the agent owes the owner an answer in its turn-origin conversation
 * (the watchdog tracks it), deliver it there instead of swallowing it.
 *
 * @param agentSession - Replying agent
 * @param content - Its text
 * @param interim - Interim note
 * @returns The persisted message id and conversation, or null to keep the status path
 */
async function deliverOwedAnswerToOrigin(
  agentSession: string,
  content: string,
  interim: boolean,
): Promise<{ messageId: string; conversationId: string } | null> {
  if (isAgentStatusMarker(content)) return null;
  const origin = OrcReplyRouteService.getInstance().getLastOrigin(agentSession);
  if (!origin) return null;
  const { getOwnerMessageWatchdog } = await import('../../services/messaging/owner-message-watchdog.service.js');
  const owed = getOwnerMessageWatchdog()
    ?.owedBy(agentSession)
    .some((e) => e.chatChannelId === origin.conversationId);
  if (!owed) return null;
  const messageId = await deliverAgentReplyToConversation({
    conversationId: origin.conversationId,
    thread: origin.slackThreadKey ?? origin.chatThreadId,
    agentSession,
    content,
    interim,
  });
  if (!messageId) return null;
  logger.warn('Agent answer with missing/wrong ids delivered to the owner conversation it was asked in (not filed as status)', {
    agentSession,
    conversationId: origin.conversationId,
    messageId,
  });
  return { messageId, conversationId: origin.conversationId };
}

/**
 * Order an agent's Slack threads so the one its [DONE] is about comes first.
 *
 * The completion notice went to `threads[0]` — the first thread the agent
 * was ever registered on — whatever the work was for. A report that names
 * its thread (`--thread <key>` or a `[SLACK-THREAD:<key>]` tag in the text)
 * now goes there. Only a thread the agent is registered on can be chosen —
 * a tag cannot send the notice somewhere the agent was never asked from.
 *
 * @param threads - Threads the agent is registered on (store order)
 * @param content - The status report text
 * @param explicitKey - Key passed with the report, if any
 * @returns Threads with the named one first; unchanged when none matches
 */
export function pickCompletionThreads<T extends { channelId: string; threadTs: string }>(
  threads: T[],
  content: string,
  explicitKey?: string,
): T[] {
  const named = [
    ...(parseSlackThreadKey(explicitKey) ? [parseSlackThreadKey(explicitKey)!] : []),
    ...extractSlackThreadKeys(content),
  ];
  for (const n of named) {
    const match = threads.find((t) => t.channelId === n.slackChannelId && t.threadTs === n.threadTs);
    if (match) return [match, ...threads.filter((t) => t !== match)];
  }
  return threads;
}

/**
 * POST /api/chat/agent-response
 *
 * Store an agent's response message in a chat conversation. Used by
 * orchestrator bash skills to post agent responses directly to the
 * chat without going through terminal output parsing.
 *
 * @param req - Request with body: { content, senderName, senderType?, conversationId? }
 * @param res - Response with { success, data: { messageId, conversationId } }
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * POST /api/chat/agent-response
 * {
 *   "content": "Task completed successfully. The API endpoint is live.",
 *   "senderName": "Orchestrator",
 *   "senderType": "orchestrator",
 *   "conversationId": "conv-abc123"
 * }
 * ```
 */
export async function agentResponse(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Trace ids are harness plumbing: never shown to the owner.
    if (typeof req.body?.content === 'string') req.body.content = stripTraceMarkers(req.body.content);
    const { content, senderName, senderType, conversationId } = req.body;
    // `reply-chat --thread <key>`: the Slack thread this answer belongs to.
    const threadParts = parseSlackThreadKey(req.body?.slackThread);
    const slackThreadKey = threadParts ? formatSlackThreadKey(threadParts.slackChannelId, threadParts.threadTs) : undefined;

    if (!content || (typeof content === 'string' && content.trim().length === 0)) {
      res.status(400).json({
        success: false,
        error: 'Message content is required',
      });
      return;
    }

    if (!senderName) {
      res.status(400).json({
        success: false,
        error: 'senderName is required',
      });
      return;
    }

    const chatService = getChatService();

    // Resolve conversation: use provided ID or get/create the current one.
    //
    // Whether the caller NAMED the conversation matters downstream: the
    // fallback below picks the globally-current conversation, which is a fine
    // default for storing a message but is NOT evidence that this message
    // belongs to that thread (issue #731).
    let conversationIdWasExplicit = Boolean(conversationId);
    let resolvedConversationId = conversationId;

    // The orchestrator answers where its turn came from (2026-09-26: a
    // system turn right after a Slack-DM turn posted its summary — with the
    // owner's pending question in it — to #think-tank, because the
    // "current conversation" fallback never sees the owner's orchestrator
    // DM). A stale named conversation is re-routed; an unnamed one defaults
    // to the origin. `crossPost: true` keeps a deliberate cross-post.
    // The X-Agent-Session header is authoritative when present (skills send
    // it); without it, fall back to the sender the body claims.
    const agentHeader = readAgentSessionHeader(req);
    const { isOrchestratorSender: isOrcName } = await import(
      '../../services/orc/orc-delivery-enforcer.service.js'
    );
    // A sub-agent whose skill shell inherited the orchestrator's
    // CREWLY_SESSION_NAME (Codex's shared app-server, 2026-09-30) sends the
    // orc's header with its own name. That is not the orchestrator speaking:
    // re-routing it to the orc's turn origin would misfile the agent's answer.
    const headerContradictsSender =
      agentHeader === ORCHESTRATOR_SESSION_NAME &&
      senderType !== 'orchestrator' &&
      !isOrcName(String(senderName));
    if (headerContradictsSender) {
      logger.warn('agent-response carries the orchestrator session header but a non-orchestrator sender — treating it as that agent', {
        senderName,
        conversationId,
      });
    }
    const isOrchestratorPost = agentHeader && !headerContradictsSender
      ? agentHeader === ORCHESTRATOR_SESSION_NAME
      : senderType === 'orchestrator' || isOrcName(String(senderName));
    if (isOrchestratorPost) {
      const route = OrcReplyRouteService.getInstance().resolveConversationReply(
        ORCHESTRATOR_SESSION_NAME,
        typeof conversationId === 'string' && conversationId ? conversationId : undefined,
        { crossPost: req.body?.crossPost === true },
      );
      if (route.action === 'rerouted-to-origin') {
        logger.warn('Orchestrator reply re-routed to the conversation its turn came from', {
          requestedConversationId: conversationId,
          routedTo: route.conversationId,
          originReceivedAt: route.origin ? new Date(route.origin.receivedAt).toISOString() : undefined,
          reason: route.reason,
          preview: String(content).substring(0, 80),
        });
      } else if (route.action === 'defaulted-to-origin') {
        logger.info('Orchestrator reply with no conversation — using its turn origin', {
          routedTo: route.conversationId,
        });
      }
      if (route.conversationId) {
        resolvedConversationId = route.conversationId;
        conversationIdWasExplicit = true;
      }
    }

    // An agent's message to a person (anything that is not a status line)
    // goes where the harness resolves it — never to the globally current
    // conversation, never filed as status while answering success
    // (specs/2026-10-02-harness-owned-routing.md §1–3; TKT-187: Owen's
    // `reply-chat --thread <#pro-ce key>` landed in an unrelated huddle and
    // was swallowed as status).
    // Only when the caller says it is a message for a person
    // (`intent: "message"` — reply-chat, send-chat-response): status
    // payloads ([MILESTONE], [HANDOFF], `---\n[VERIFICATION REQUEST]`, …)
    // without the flag keep the status path, exactly as before.
    const agentSenderGuess = (senderType || 'agent') === 'agent';
    const isMessageForPerson = req.body?.intent === 'message';
    if (isMessageForPerson && agentSenderGuess && !isOrchestratorPost && !isOrcName(String(senderName)) && !isAgentStatusMarker(String(content))) {
      const replier =
        agentHeader && !headerContradictsSender
          ? agentHeader
          : await sessionOfSender(String(senderName), typeof conversationId === 'string' ? conversationId : undefined);
      const { deliverReply } = await import('../../services/orc/reply-destination.wiring.js');
      const { referenceOf } = await import('./agent-reply.controller.js');
      const reference = referenceOf((req.body ?? {}) as Record<string, unknown>);
      const delivery = await deliverReply({
        session: replier,
        content: String(content),
        interim: req.body?.interim === true,
        ...(reference ? { reference } : {}),
        ...(conversationId || req.body?.slackThread
          ? {
              hints: {
                ...(typeof conversationId === 'string' && conversationId ? { conversationId } : {}),
                ...(typeof req.body?.slackThread === 'string' && req.body.slackThread ? { thread: req.body.slackThread } : {}),
              },
            }
          : {}),
      });
      if (!delivery.ok) {
        logger.warn('Agent message to a person could not be delivered — told the agent (not filed as status)', {
          senderName,
          replier,
          error: delivery.error,
          preview: String(content).substring(0, 120),
        });
        res.status(409).json({ success: false, error: delivery.error });
        return;
      }
      res.status(201).json({
        success: true,
        data: {
          ...(delivery.messageId ? { messageId: delivery.messageId, conversationId: delivery.conversationId } : {}),
          ...(delivery.slackChannelId ? { slackChannelId: delivery.slackChannelId, messageTs: delivery.messageTs } : {}),
          ...(delivery.threadTs ? { threadTs: delivery.threadTs } : {}),
          via: delivery.destination.source,
        },
      });
      return;
    }

    if (!resolvedConversationId) {
      const current = await chatService.getCurrentConversation();
      if (current) {
        resolvedConversationId = current.id;
      } else {
        const newConversation = await chatService.createNewConversation('Agent Chat');
        resolvedConversationId = newConversation.id;
      }
    }

    const resolvedSenderType = senderType || 'agent';

    // Agent messages (status reports, [DONE], [WORKING], [IDLE], etc.) are internal
    // system communications that should be routed to the orchestrator only — NOT
    // saved to the user-facing chat conversation. Only orchestrator/system messages
    // appear in the user's chat.
    const isAgentSender = resolvedSenderType === 'agent';

    // The orchestrator's own status report (report-status with
    // senderType 'agent', senderName 'crewly-orc') must not be routed back
    // to the orchestrator as an "agent status" event, nor tracked as an
    // undelivered deliverable, nor announced to Slack as "Agent Completed".
    // Each of those made ORC react to its own [DONE], reply again, and file
    // another [DONE] — the thread never went quiet (2026-09-13).
    const { isOrchestratorSender } = await import(
      '../../services/orc/orc-delivery-enforcer.service.js'
    );
    const isOrchestratorSelfReport = isAgentSender && isOrchestratorSender(String(senderName));

    let savedMessageId: string | undefined;

    // An agent answering on its own chat-v2 DM channel (the dispatcher
    // delivered "reply-chat … conversationId=<channel>"): the reply IS the
    // deliverable. Record it as the agent's turn on that channel — the WS
    // gateway shows the bubble and the Slack DM bridge mirrors it — instead
    // of routing it to the orchestrator as a status report.
    if (isAgentSender && !isOrchestratorSelfReport && conversationIdWasExplicit) {
      const hdr = req.headers['x-agent-session'] ?? req.headers['x-crewly-agent-session'];
      const recorded = await recordChatV2AgentReply(
        String(resolvedConversationId),
        String(senderName),
        String(content),
        typeof hdr === 'string' && hdr.length > 0 ? hdr : undefined,
        req.body?.interim === true,
        slackThreadKey,
      );
      if (recorded) {
        res.status(201).json({ success: true, data: { messageId: recorded, conversationId: resolvedConversationId } });
        return;
      }
      // An answer into a Slack room (the huddle behind a Slack channel —
      // also listed as that channel's conversation) goes to the owner's
      // thread as the agent, exactly as `reply-channel` would post it.
      const roomReply = await recordSlackRoomAgentReply({
        channelId: String(resolvedConversationId),
        senderName: String(senderName),
        content: String(content),
        headerSession: typeof hdr === 'string' && hdr.length > 0 ? hdr : undefined,
        interim: req.body?.interim === true,
        rawThread: typeof req.body?.slackThread === 'string' ? req.body.slackThread : undefined,
      });
      if (roomReply) {
        res.status(201).json({ success: true, data: { messageId: roomReply, conversationId: resolvedConversationId } });
        return;
      }
    }

    // The answer would be filed as a status report (no conversation, a
    // legacy/foreign id): if the agent owes the owner an answer where its
    // turn came from, it goes there (specs/2026-09-30-owner-message-guarantee.md §B).
    if (isAgentSender && !isOrchestratorSelfReport && !isAgentStatusMarker(String(content))) {
      const hdr = readAgentSessionHeader(req);
      const replier = hdr && !headerContradictsSender ? hdr : String(senderName);
      const owed = await deliverOwedAnswerToOrigin(replier, String(content), req.body?.interim === true);
      if (owed) {
        res.status(201).json({ success: true, data: { messageId: owed.messageId, conversationId: owed.conversationId, reroutedToOrigin: true } });
        return;
      }
    }

    if (!isAgentSender) {
      // Save orchestrator/system messages to the chat conversation
      const savedMessage = await chatService.addDirectMessage(
        resolvedConversationId,
        content,
        {
          type: resolvedSenderType as ChatSenderType,
          name: senderName,
        },
        slackThreadKey ? { [SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]: slackThreadKey } : undefined,
      );
      savedMessageId = savedMessage.id;

      logger.info('Agent response stored via REST', {
        senderName,
        senderType: resolvedSenderType,
        conversationId: resolvedConversationId,
        messageId: savedMessage.id,
      });
    }

    // Forward agent status reports to the orchestrator queue and Slack.
    // Agents call report-status with [DONE], [IDLE], [WORKING], or structured [STATUS REPORT].
    // All are forwarded so the orchestrator can take follow-up action
    // (assign next task, notify user, etc.) without waiting for ActivityMonitor polling.
    if (isOrchestratorSelfReport) {
      logger.info('Orchestrator self-report acknowledged (not echoed back)', {
        conversationId: resolvedConversationId,
        preview: content.substring(0, 80),
      });
    } else if (isAgentSender) {
      logger.info('Agent status report received (not saved to chat)', {
        senderName,
        conversationId: resolvedConversationId,
        preview: content.substring(0, 80),
      });
      // Not a status line: somebody was probably waiting for this, and from
      // here it only reaches the orchestrator (clipped). Say so loudly.
      if (!isAgentStatusMarker(String(content))) {
        logger.warn('Substantive agent content routed to the orchestrator as status — whoever asked will not see it unless the orchestrator relays it', {
          senderName,
          conversationId: resolvedConversationId,
          conversationWasNamed: conversationIdWasExplicit,
          chars: String(content).length,
          preview: String(content).substring(0, 120),
        });
      }

      // 2026-05-23 incident fix: agent-originating [DONE] / [COMPLETED]
      // / [DELIVERED] markers in a slack conversation are a delivery
      // signal — Steve is waiting for ORC to forward the result via
      // reply-slack. Record a pending delivery; if ORC doesn't reply
      // within the cadence, the enforcer will nudge it with
      // [DELIVER_REQUIRED]. The service no-ops on non-slack conversations
      // and on non-delivery markers (e.g. [IN_PROGRESS]).
      //
      // Only when the caller NAMED the thread (issue #731): a cron-driven
      // daily task reports completion with no conversationId, so the fallback
      // above hands back whatever thread happens to be globally current —
      // typically some long-resolved thread. Tracking that as a pending
      // delivery made the watchdog demand a deliverable in an unrelated thread
      // every single day, and because markPendingDelivery re-arms the reminder
      // counter, the nudges never aged out.
      let deliveryOwed = false;
      try {
        if (conversationIdWasExplicit) {
          const { OrcDeliveryEnforcerService } = await import(
            '../../services/orc/orc-delivery-enforcer.service.js'
          );
          deliveryOwed = OrcDeliveryEnforcerService.getInstance()?.markPendingDelivery({
            conversationId: resolvedConversationId,
            agentSender: senderName,
            text: content,
          }) === true;
        } else {
          logger.debug('Skipping delivery tracking — conversation was inferred, not named', {
            senderName,
            conversationId: resolvedConversationId,
          });
        }
      } catch (enforcerErr) {
        logger.warn('OrcDeliveryEnforcer.markPendingDelivery threw (swallowed)', {
          error: enforcerErr instanceof Error ? enforcerErr.message : String(enforcerErr),
        });
      }

      try {
        // 1. Route the report to whoever is responsible
        // (specs/2026-10-01-orc-status-wakes.md). Each orchestrator turn
        // re-reads its whole context; on 2026-09-29 134 of its turns were
        // members' [DONE]/[BLOCKED] lines about work their own lead owns.
        // Progress markers are recorded only; [DONE] wakes the orchestrator
        // only for work it delegated or a delivery the owner waits on;
        // [BLOCKED]/[FAILED] go to the sender's lead first; the rest is
        // batched into a 30-minute digest.
        if (messageQueueService) {
          await OrcStatusRouterService.getInstance().route({
            content: String(content),
            // The session header is authoritative (work items and leads are keyed by session).
            sender: agentHeader && !headerContradictsSender ? agentHeader : String(senderName),
            conversationId: String(resolvedConversationId),
            ...(typeof req.body?.workItemId === 'string' && req.body.workItemId ? { workItemId: req.body.workItemId } : {}),
            deliveryOwed,
            orcText: clipForOrchestrator(content, resolvedConversationId),
          });
        }

        // 2. Send Slack notification for task completions — only into a
        // thread the Slack thread store lists for this agent (as before),
        // and the one the reply resolver picks among those (its work item,
        // the thread it names, its prompt, its turn origin) — no longer the
        // agent's first-ever thread. No listed thread matches → no notice
        // (specs/2026-10-02-harness-owned-routing.md §6).
        if (content.startsWith('[DONE]')) {
          const reporter = agentHeader && !headerContradictsSender ? agentHeader : String(senderName);
          const { getSlackThreadStore } = await import('../../services/slack/slack-thread-store.service.js');
          const store = getSlackThreadStore();
          const listed = store
            ? [...store.findThreadsForAgent(reporter), ...(reporter !== senderName ? store.findThreadsForAgent(String(senderName)) : [])]
            : [];
          let target: { channelId: string; threadTs: string } | undefined;
          if (listed.length > 0) {
            const namedKey = slackThreadKey ?? (() => {
              const k = extractSlackThreadKeys(String(content))[0];
              return k ? formatSlackThreadKey(k.slackChannelId, k.threadTs) : undefined;
            })();
            const { resolveSlackPlace } = await import('../../services/orc/reply-destination.wiring.js');
            const place = await resolveSlackPlace({
              session: reporter,
              ...(typeof req.body?.workItemId === 'string' && req.body.workItemId ? { reference: { workItemId: req.body.workItemId } } : {}),
              ...(namedKey ? { hints: { thread: namedKey } } : {}),
              noOwnerDm: true,
            }).catch(() => null);
            target = place?.threadTs
              ? listed.find((t) => t.channelId === place.slackChannelId && t.threadTs === place.threadTs)
              : undefined;
          }
          const { getSlackOrchestratorBridge } = await import(
            '../../services/slack/slack-orchestrator-bridge.js'
          );
          const bridge = getSlackOrchestratorBridge();
          if (bridge && target) {
            const summaryText = content.replace(/^\[DONE\]\s*Agent\s+\S+:\s*/, '');
            await bridge.sendNotification({
              type: 'task_completed',
              title: 'Agent Completed',
              message: `Agent ${senderName} completed: ${summaryText}`,
              urgency: 'normal',
              timestamp: new Date().toISOString(),
              channelId: target.channelId,
              threadTs: target.threadTs,
            });

            // If a pending reaction was stored when the message arrived
            // (orchestrator-routed path sets a 👀 on the trigger message),
            // flip it to ✅ now that the agent reply has been delivered.
            // No-op when there's no pending entry for this thread.
            await bridge.addCompletionReaction(target.channelId, target.threadTs);
          } else if (!target) {
            logger.info('[DONE] notice not posted — no thread of this agent that the report belongs to', { senderName, listed: listed.length });
          }
        }
      } catch (notifyErr) {
        logger.warn('Failed to send agent status notification', {
          error: notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
          senderName,
        });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        messageId: savedMessageId,
        conversationId: resolvedConversationId,
      },
    });
  } catch (error) {
    logger.error('Failed to store agent response', {
      error: error instanceof Error ? error.message : String(error),
    });
    next(error);
  }
}

// =============================================================================
// Conversation Endpoints
// =============================================================================

/**
 * GET /api/chat/conversations
 *
 * List all conversations with optional filtering.
 *
 * @param req - Request with query params for filtering
 * @param res - Response with array of conversations
 */
export async function getConversations(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { includeArchived, search, limit, offset, channelType } = req.query;

    const filter: ConversationFilter = {
      includeArchived: includeArchived === 'true',
      search: search as string | undefined,
      channelType: (typeof channelType === 'string' && isValidChannelType(channelType))
        ? channelType as ChatChannelType
        : undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    };

    const chatService = getChatService();
    const conversations = await chatService.getConversations(filter);

    res.json({
      success: true,
      data: conversations,
      count: conversations.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/conversations/current
 *
 * Get the current (most recent active) conversation.
 * Creates a new conversation if none exists.
 *
 * @param req - Request
 * @param res - Response with current conversation
 */
export async function getCurrentConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const chatService = getChatService();
    const conversation = await chatService.getCurrentConversation();

    if (!conversation) {
      // Create a new conversation if none exists
      const newConversation = await chatService.createNewConversation('New Chat');
      res.json({
        success: true,
        data: newConversation,
        isNew: true,
      });
      return;
    }

    res.json({
      success: true,
      data: conversation,
      isNew: false,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/conversations/:id
 *
 * Get a single conversation by ID.
 *
 * @param req - Request with conversation ID param
 * @param res - Response with the conversation
 */
export async function getConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    const conversation = await chatService.getConversation(id);

    if (!conversation) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/chat/conversations
 *
 * Create a new conversation.
 *
 * @param req - Request with body: { title?: string }
 * @param res - Response with created conversation
 */
export async function createConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { title } = req.body;

    const chatService = getChatService();
    const conversation = await chatService.createNewConversation(title);

    res.status(201).json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * PUT /api/chat/conversations/:id
 *
 * Update a conversation's title.
 *
 * @param req - Request with conversation ID param and body: { title: string }
 * @param res - Response with updated conversation
 */
export async function updateConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const { title } = req.body;

    if (!title || typeof title !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Title is required',
      });
      return;
    }

    const chatService = getChatService();
    const conversation = await chatService.updateConversationTitle(id, title);

    res.json({
      success: true,
      data: conversation,
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }
    next(error);
  }
}

/**
 * PUT /api/chat/conversations/:id/archive
 *
 * Archive a conversation.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming archive
 */
export async function archiveConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.archiveConversation(id);

    res.json({
      success: true,
      message: 'Conversation archived',
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }
    next(error);
  }
}

/**
 * PUT /api/chat/conversations/:id/unarchive
 *
 * Unarchive a conversation.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming unarchive
 */
export async function unarchiveConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.unarchiveConversation(id);

    res.json({
      success: true,
      message: 'Conversation unarchived',
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      res.status(404).json({
        success: false,
        error: 'Conversation not found',
      });
      return;
    }
    next(error);
  }
}

/**
 * DELETE /api/chat/conversations/:id
 *
 * Delete a conversation and all its messages.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming deletion
 */
export async function deleteConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.deleteConversation(id);

    res.json({
      success: true,
      message: 'Conversation deleted',
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/chat/conversations/:id/clear
 *
 * Clear all messages in a conversation.
 *
 * @param req - Request with conversation ID param
 * @param res - Response confirming clear
 */
export async function clearConversation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;

    const chatService = getChatService();
    await chatService.clearConversation(id);

    res.json({
      success: true,
      message: 'Conversation cleared',
    });
  } catch (error) {
    next(error);
  }
}

// =============================================================================
// Statistics Endpoint
// =============================================================================

/**
 * GET /api/chat/statistics
 *
 * Get chat statistics.
 *
 * @param req - Request
 * @param res - Response with statistics
 */
export async function getStatistics(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const chatService = getChatService();
    const statistics = await chatService.getStatistics();

    res.json({
      success: true,
      data: statistics,
    });
  } catch (error) {
    next(error);
  }
}

// =============================================================================
// Thread Status Endpoints
// =============================================================================

/**
 * GET /api/chat/thread-status
 *
 * Returns all thread status entries. Supports optional status filter.
 *
 * @param req - Request with optional query: { status?: ThreadStatus }
 * @param res - Response with array of ThreadStatusEntry
 */
export function getThreadStatusList(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    if (!threadStatusQueueService) {
      res.status(503).json({
        success: false,
        error: 'Thread status queue service not initialized',
      });
      return;
    }

    const { status } = req.query;

    const entries = status
      ? threadStatusQueueService.getByStatus(status as string as import('../../types/thread-status.types.js').ThreadStatus)
      : threadStatusQueueService.getAllEntries();

    res.json({
      success: true,
      data: entries,
      count: entries.length,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/thread-status/stats
 *
 * Returns thread status queue statistics.
 *
 * @param req - Request
 * @param res - Response with ThreadStatusStats
 */
export function getThreadStatusStats(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    if (!threadStatusQueueService) {
      res.status(503).json({
        success: false,
        error: 'Thread status queue service not initialized',
      });
      return;
    }

    const stats = threadStatusQueueService.getStats();

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/chat/thread-status/:threadKey
 *
 * Returns a single thread status entry by threadKey.
 *
 * @param req - Request with threadKey param
 * @param res - Response with ThreadStatusEntry
 */
export function getThreadStatusByKey(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    if (!threadStatusQueueService) {
      res.status(503).json({
        success: false,
        error: 'Thread status queue service not initialized',
      });
      return;
    }

    const { threadKey } = req.params;
    const entry = threadStatusQueueService.get(decodeURIComponent(threadKey));

    if (!entry) {
      res.status(404).json({
        success: false,
        error: `Thread not found: ${threadKey}`,
      });
      return;
    }

    res.json({
      success: true,
      data: entry,
    });
  } catch (error) {
    next(error);
  }
}

// =============================================================================
// Highlights Endpoint
// =============================================================================

/**
 * GET /api/chat/highlights
 *
 * Retrieve highlighted messages (decisions, questions, blockers, task completions)
 * from all conversations. Useful for dashboard activity feeds.
 *
 * @param req - Request with query params: { since?: string, limit?: number }
 * @param res - Response with array of chat highlights
 * @param next - Express next function for error propagation
 *
 * @example
 * ```
 * GET /api/chat/highlights?since=2026-03-25T00:00:00.000Z&limit=10
 * ```
 */
export async function handleGetHighlights(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { since, limit } = req.query;

    const highlightsService = getChatHighlightsService();
    const highlights = await highlightsService.getHighlights({
      since: since as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
    });

    res.json({
      success: true,
      data: { highlights },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Shorten an agent status for the orchestrator, keeping where the rest is.
 *
 * @param content - The status as the agent posted it
 * @param conversationId - Conversation holding the full text
 * @returns The status, clipped to {@link ORC_STATUS_FORWARDING.MAX_FORWARD_CHARS}
 */
export function clipForOrchestrator(content: string, conversationId: string): string {
  const max = ORC_STATUS_FORWARDING.MAX_FORWARD_CHARS;
  if (content.length <= max) return content;
  return `${content.slice(0, max)}… [${content.length - max} more characters — full report in conversation ${conversationId}]`;
}
