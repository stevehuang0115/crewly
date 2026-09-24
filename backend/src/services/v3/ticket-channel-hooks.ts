/**
 * Ticket loop — per-channel glue (specs/ticket-loop.md, Phase 1 §2).
 *
 * The intake service is channel-agnostic; this module holds what the channel
 * call sites share:
 *
 * - conversation / thread refs (`slack:<channel>:<root>`, `chatv2:<channel>:<root>`)
 *   so a follow-up finds its thread's ticket and a top-level "不用记" finds
 *   the latest ticket of its conversation;
 * - the owner test for chat-v2 rows (PR #786's authorship markers);
 * - the line added to a delivered message (`[TICKET:TKT-123 <id>] …`);
 * - a bounded wait on intake, so a slow disk never holds a message back;
 * - the two receipt sinks (Slack thread reply, chat-v2 system row).
 *
 * @module services/v3/ticket-channel-hooks
 */

import { ORCHESTRATOR_SESSION_NAME, OWNER_EVIDENCE_METADATA, TICKET_CONSTANTS } from '../../constants.js';
import { getTicketReviewService } from './ticket-review.service.js';
import type { Request } from '../../types/v2/request.types.js';
import {
  formatTicketMarker,
  formatTicketNumber,
  type TicketReceipt,
} from '../../types/v2/ticket.types.js';
import type { SlackBlock } from '../../types/slack.types.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { TicketOriginChannel } from '../../types/v2/ticket.types.js';
import type {
  IntakeMessage,
  IntakeOutcome,
  ReceiptTarget,
  TicketIntakeService,
  TicketReceiptSink,
} from './ticket-intake.service.js';

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

/**
 * Conversation ref of a Slack channel or DM.
 *
 * @param slackChannelId - Slack conversation id
 * @returns `slack:<channel>`
 */
export function slackConversationRef(slackChannelId: string): string {
  return `slack:${slackChannelId}`;
}

/**
 * Thread ref of a Slack thread (a top-level message is its own thread root).
 *
 * @param slackChannelId - Slack conversation id
 * @param threadRootTs - Thread root ts
 * @returns `slack:<channel>:<root ts>`
 */
export function slackThreadRef(slackChannelId: string, threadRootTs: string): string {
  return `${slackConversationRef(slackChannelId)}:${threadRootTs}`;
}

/**
 * Conversation ref of a chat-v2 channel.
 *
 * @param chatChannelId - chat-v2 channel id
 * @returns `chatv2:<channel>`
 */
export function chatV2ConversationRef(chatChannelId: string): string {
  return `chatv2:${chatChannelId}`;
}

/**
 * Thread ref of a chat-v2 thread (a root message is its own thread).
 *
 * @param chatChannelId - chat-v2 channel id
 * @param rootMessageId - Thread root message id
 * @returns `chatv2:<channel>:<root id>`
 */
export function chatV2ThreadRef(chatChannelId: string, rootMessageId: string): string {
  return `${chatV2ConversationRef(chatChannelId)}:${rootMessageId}`;
}

// ---------------------------------------------------------------------------
// Owner test
// ---------------------------------------------------------------------------

/**
 * Whether a chat-v2 row carries the owner's own words.
 *
 * Mirrors the commitment gate's read (PR #786): a `user` row counts only when
 * no agent authorship marker is set and its source is not an agent-reply
 * source. A colleague agent's Slack post and an agent calling a user-turn API
 * are stored as `user` rows but carry the marker.
 *
 * @param message - Persisted chat-v2 message
 * @returns True for the owner's message
 */
export function isOwnerChatMessage(message: Pick<ChatMessageDTO, 'senderType' | 'metadata'>): boolean {
  if (message.senderType !== 'user') return false;
  const meta = message.metadata ?? {};
  if (meta[OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION] !== undefined) return false;
  if (meta[OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION] !== undefined) return false;
  const source = typeof meta.source === 'string' ? meta.source : '';
  return !(OWNER_EVIDENCE_METADATA.AGENT_REPLY_SOURCES as readonly string[]).includes(source);
}

// ---------------------------------------------------------------------------
// Delivered-message marker
// ---------------------------------------------------------------------------

/**
 * The ticket a delivered message belongs to, from an intake outcome.
 *
 * @param outcome - Intake outcome (or null when intake did not run)
 * @returns The ticket, or null
 */
export function ticketOfOutcome(outcome: IntakeOutcome | null): Request | null {
  if (!outcome) return null;
  return outcome.action === 'ignored' || outcome.action === 'dismissed' ? null : outcome.ticket;
}

/**
 * The line added to a message delivered to an agent: the machine-readable
 * marker plus how to link work to it.
 *
 * @param ticket - The ticket (null → '')
 * @returns The line, or '' when there is no numbered ticket
 */
export function ticketDeliveryLine(ticket: Pick<Request, 'id' | 'ticketNumber'> | null): string {
  if (!ticket) return '';
  const marker = formatTicketMarker(ticket);
  if (!marker) return '';
  const tkt = formatTicketNumber(ticket.ticketNumber as number);
  return (
    `${marker} 这条消息已记为工单 ${tkt}。为它创建 WorkItem（delegate-task / create-task / decompose-goal）时加上 --request-id ${ticket.id}。` +
    `回答前用 ticket-check --ticket ${tkt} 看验收标准（有「打回」来源的先查）。`
  );
}

/**
 * Append the ticket line to a text delivered through the message queue.
 *
 * @param text - Text to deliver
 * @param ticket - Its ticket, if any
 * @returns The text, with the ticket line appended when there is one
 */
export function appendTicketLine(text: string, ticket: Pick<Request, 'id' | 'ticketNumber'> | null): string {
  const line = ticketDeliveryLine(ticket);
  return line ? `${text}\n\n${line}` : text;
}

/**
 * A copy of a chat-v2 message carrying the ticket line in its metadata, for
 * the dispatcher to render into the agent's prompt. The persisted row is not
 * changed.
 *
 * @param message - Persisted message
 * @param ticket - Its ticket, if any
 * @returns The same message when there is no ticket, else a copy
 */
export function withTicketMarker(message: ChatMessageDTO, ticket: Pick<Request, 'id' | 'ticketNumber'> | null): ChatMessageDTO {
  const line = ticketDeliveryLine(ticket);
  if (!line) return message;
  return {
    ...message,
    metadata: { ...(message.metadata ?? {}), [TICKET_CONSTANTS.MESSAGE_MARKER_METADATA_KEY]: line },
  };
}

/**
 * {@link withTicketMarker}, and remember that this chat-v2 turn opened the
 * ticket, so the agent's answer in the same thread can be matched to it
 * (Phase 2 review). The link is fire-and-forget; delivery never waits on it.
 *
 * @param message - The persisted owner message about to be dispatched
 * @param ticket - The ticket it belongs to, or null
 * @returns The message to dispatch (see {@link withTicketMarker})
 */
export function markAndLinkTicket(message: ChatMessageDTO, ticket: Pick<Request, 'id' | 'ticketNumber'> | null): ChatMessageDTO {
  if (ticket && typeof ticket.ticketNumber === 'number') {
    void getTicketReviewService()
      ?.noteChatTurn(ticket.id, message)
      .catch(() => undefined);
  }
  return withTicketMarker(message, ticket);
}

/**
 * The ticket line a dispatcher should render for a message (see {@link withTicketMarker}).
 *
 * @param message - Message about to be dispatched
 * @returns The line, or undefined
 */
export function ticketLineOf(message: Pick<ChatMessageDTO, 'metadata'>): string | undefined {
  const v = message.metadata?.[TICKET_CONSTANTS.MESSAGE_MARKER_METADATA_KEY];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Run intake, but give up waiting after {@link TICKET_CONSTANTS.INTAKE_TIMEOUT_MS}.
 * Intake keeps running in the background (the ticket and its receipt still
 * appear); only the delivered copy goes out without the marker.
 *
 * @param intake - The intake service, or null when not wired
 * @param message - The message
 * @param timeoutMs - Override for tests
 * @returns The outcome, or null when intake is not wired or timed out
 */
export async function intakeWithin(
  intake: Pick<TicketIntakeService, 'intakeWithOutcome'> | null,
  message: IntakeMessage,
  timeoutMs: number = TICKET_CONSTANTS.INTAKE_TIMEOUT_MS,
): Promise<IntakeOutcome | null> {
  if (!intake) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([intake.intakeWithOutcome(message), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Receipt texts
// ---------------------------------------------------------------------------

/**
 * Receipt text for a new ticket. Just the fact — no "不用记？" question
 * (owner, 2026-09-24: asking every time is noise); 「不用记」 still works.
 *
 * @param ticket - The ticket
 * @returns `已记成 TKT-123`
 */
export function receiptText(ticket: Pick<Request, 'ticketNumber'>): string {
  return TICKET_CONSTANTS.RECEIPT.RECORDED(formatTicketNumber(ticket.ticketNumber ?? 0));
}

/**
 * Receipt text after "不用记".
 *
 * @param ticket - The ticket
 * @returns `TKT-123 已取消记录`
 */
export function dismissedReceiptText(ticket: Pick<Request, 'ticketNumber'>): string {
  return TICKET_CONSTANTS.RECEIPT.DISMISSED(formatTicketNumber(ticket.ticketNumber ?? 0));
}

/**
 * Receipt text once the ticket is accepted.
 *
 * @param ticket - The ticket
 * @returns `TKT-123 已完成`
 */
export function doneReceiptText(ticket: Pick<Request, 'ticketNumber'>): string {
  return TICKET_CONSTANTS.RECEIPT.DONE(formatTicketNumber(ticket.ticketNumber ?? 0));
}

// ---------------------------------------------------------------------------
// Slack receipt sink
// ---------------------------------------------------------------------------

/** The slice of SlackService the Slack receipt sink uses. */
export interface ReceiptSlackApi {
  addReaction?(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void>;
  removeReaction?(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void>;
  updateMessage(channelId: string, messageTs: string, text: string, blocks?: SlackBlock[], botToken?: string): Promise<void>;
}

/** Slack receipt sink dependencies. */
export interface SlackReceiptSinkDeps {
  slack: ReceiptSlackApi;
  /** Bot token of an agent's own Slack app, when it has one */
  botTokenFor?: (agentSession: string) => string | undefined;
}

/**
 * Receipts as a reply in the Slack thread the owner wrote in, through the same
 * SlackService the channel already posts with. The dismiss button is added
 * only when button clicks reach this process (socket mode); on the Cloud
 * transport they do not, and the receipt tells the owner to reply 「不用记」.
 *
 * @param deps - Slack API and bot-token lookup
 * @returns The sink
 */
export function createSlackReceiptSink(deps: SlackReceiptSinkDeps): TicketReceiptSink {
  const tokenFor = (session?: string): string | undefined => (session ? deps.botTokenFor?.(session) : undefined);
  return {
    async post(ticket: Request, target: ReceiptTarget): Promise<TicketReceipt | null> {
      if (target.kind !== 'slack') return null;
      const botToken = tokenFor(target.postAs);
      // Silent receipt (owner, 2026-09-24: asking "不用记？" every time is
      // noise). Only a 🎫 on the owner's own message — no extra message, no
      // notification. No message ts, or the bot can't react: no receipt at
      // all; the ticket still exists on the board.
      if (!target.messageTs || !deps.slack.addReaction) return null;
      try {
        await deps.slack.addReaction(target.slackChannelId, target.messageTs, TICKET_CONSTANTS.RECEIPT.REACTION, botToken);
      } catch {
        return null;
      }
      return {
        kind: 'slack',
        slackChannelId: target.slackChannelId,
        ts: target.messageTs,
        threadTs: target.threadTs,
        reaction: TICKET_CONSTANTS.RECEIPT.REACTION,
        ...(botToken && target.postAs ? { postedAs: target.postAs } : {}),
      };
    },
    async markDismissed(ticket: Request, receipt: TicketReceipt): Promise<void> {
      if (receipt.kind !== 'slack') return;
      if (receipt.reaction) {
        await deps.slack.removeReaction?.(receipt.slackChannelId, receipt.ts, receipt.reaction, tokenFor(receipt.postedAs));
        return;
      }
      // `blocks: []` drops the button; Slack keeps old blocks when omitted.
      await deps.slack.updateMessage(receipt.slackChannelId, receipt.ts, dismissedReceiptText(ticket), [], tokenFor(receipt.postedAs));
    },
    async markDone(_ticket: Request, receipt: TicketReceipt): Promise<void> {
      // Only reaction receipts change: 🎫 → ✅, still no message.
      if (receipt.kind !== 'slack' || !receipt.reaction) return;
      const token = tokenFor(receipt.postedAs);
      await deps.slack.removeReaction?.(receipt.slackChannelId, receipt.ts, receipt.reaction, token).catch(() => undefined);
      await deps.slack.addReaction?.(receipt.slackChannelId, receipt.ts, TICKET_CONSTANTS.RECEIPT.DONE_REACTION, token);
    },
  };
}

// ---------------------------------------------------------------------------
// chat-v2 receipt sink
// ---------------------------------------------------------------------------

/** The slice of ChatV2Service the chat-v2 receipt sink uses. */
export interface ReceiptChatApi {
  recordTurn(input: {
    channelId: string;
    senderType: 'system';
    senderId: string;
    content: string;
    contentType?: 'system_note';
    threadId?: string;
    metadata: { source: 'system'; [key: string]: unknown };
  }): { message: ChatMessageDTO };
  updateSystemMessage(messageId: string, content: string, metadataPatch?: Record<string, unknown>): ChatMessageDTO | null;
}

/** chat-v2 receipt sink dependencies. */
export interface ChatV2ReceiptSinkDeps {
  chat: ReceiptChatApi;
  /** Push a row to live views (the chat-v2 WebSocket gateway), when wired */
  broadcast?: (message: ChatMessageDTO) => void;
}

/**
 * Receipts as a system row under the owner's chat-v2 message. The row's
 * metadata names the ticket and the dismiss endpoint, so a client can render
 * a button; replying 「不用记」 works everywhere.
 *
 * @param deps - chat-v2 API and optional broadcaster
 * @returns The sink
 */
export function createChatV2ReceiptSink(deps: ChatV2ReceiptSinkDeps): TicketReceiptSink {
  return {
    async post(ticket: Request, target: ReceiptTarget): Promise<TicketReceipt | null> {
      if (target.kind !== 'chat-v2') return null;
      const { message } = deps.chat.recordTurn({
        channelId: target.chatChannelId,
        senderType: 'system',
        senderId: 'system',
        content: receiptText(ticket),
        contentType: 'system_note',
        ...(target.threadId ? { threadId: target.threadId } : {}),
        metadata: {
          source: 'system',
          [TICKET_CONSTANTS.RECEIPT_METADATA_KEY]: {
            ticketId: ticket.id,
            tkt: formatTicketNumber(ticket.ticketNumber ?? 0),
            status: 'recorded',
            dismissPath: `/api/tickets/${ticket.id}/dismiss`,
          },
        },
      });
      deps.broadcast?.(message);
      return { kind: 'chat-v2', chatChannelId: target.chatChannelId, messageId: message.id };
    },
    async markDismissed(ticket: Request, receipt: TicketReceipt): Promise<void> {
      if (receipt.kind !== 'chat-v2') return;
      const updated = deps.chat.updateSystemMessage(receipt.messageId, dismissedReceiptText(ticket), {
        [TICKET_CONSTANTS.RECEIPT_METADATA_KEY]: {
          ticketId: ticket.id,
          tkt: formatTicketNumber(ticket.ticketNumber ?? 0),
          status: 'dismissed',
        },
      });
      if (updated) deps.broadcast?.(updated);
    },
    async markDone(ticket: Request, receipt: TicketReceipt): Promise<void> {
      if (receipt.kind !== 'chat-v2') return;
      const updated = deps.chat.updateSystemMessage(receipt.messageId, doneReceiptText(ticket), {
        [TICKET_CONSTANTS.RECEIPT_METADATA_KEY]: {
          ticketId: ticket.id,
          tkt: formatTicketNumber(ticket.ticketNumber ?? 0),
          status: 'done',
        },
      });
      if (updated) deps.broadcast?.(updated);
    },
  };
}

// ---------------------------------------------------------------------------
// chat-v2 intake (dashboard REST, portal relay, mobile)
// ---------------------------------------------------------------------------

/**
 * Canonical chat-v2 sourceConversationItemId the SLA subscriber parses
 * (`chatv2-<channel>__<message>`). `__` because channel and message ids are
 * UUIDs with dashes in them.
 *
 * @param channelId - chat-v2 channel id
 * @param messageId - chat-v2 message id
 * @returns The source id
 */
export function buildChatV2SourceId(channelId: string, messageId: string): string {
  return `chatv2-${channelId}__${messageId}`;
}

/**
 * Source id for a chat-v2 ticket NOT routed to the orchestrator. A different
 * prefix on purpose: the SLA subscriber closes any open Request whose source
 * starts with `chatv2-` as soon as an agent replies in that channel, which is
 * right for the orc's respond-to-user tracking and wrong for a ticket.
 *
 * @param channelId - chat-v2 channel id
 * @param messageId - chat-v2 message id
 * @returns `chatv2t-<channel>__<message>`
 */
export function buildChatV2TicketSourceId(channelId: string, messageId: string): string {
  return `chatv2t-${channelId}__${messageId}`;
}

/**
 * Whether a chat-v2 channel is the owner's DM with the orchestrator — the
 * only chat-v2 channel whose tickets keep the SLA (`chat-v2` tag).
 *
 * @param channel - The channel
 * @returns True for the orc DM
 */
export function isOrchestratorRoutedChatV2Channel(channel: Pick<ChatChannelDTO, 'type' | 'agentSession'>): boolean {
  return channel.type === 'dm' && !!channel.agentSession && channel.agentSession === ORCHESTRATOR_SESSION_NAME;
}

/**
 * Build the intake message for an owner's chat-v2 message.
 *
 * @param channel - Its channel
 * @param message - The persisted message
 * @param originChannel - `chat` (dashboard), `portal` (relay) or `mobile`
 * @returns The intake message, or null when it is not the owner's
 */
export function chatV2IntakeMessage(
  channel: ChatChannelDTO,
  message: ChatMessageDTO,
  originChannel: Extract<TicketOriginChannel, 'chat' | 'portal' | 'mobile'>,
): IntakeMessage | null {
  if (!isOwnerChatMessage(message)) return null;
  const orcRouted = isOrchestratorRoutedChatV2Channel(channel);
  const root = message.threadId ?? message.id;
  return {
    text: message.content ?? '',
    isOwner: true,
    origin: {
      channel: originChannel,
      ref: orcRouted ? buildChatV2SourceId(channel.id, message.id) : buildChatV2TicketSourceId(channel.id, message.id),
      threadRef: chatV2ThreadRef(channel.id, root),
      author: message.senderId,
    },
    conversationRef: chatV2ConversationRef(channel.id),
    ...(channel.type === 'dm' && channel.agentSession ? { targetAgent: channel.agentSession } : {}),
    ...(orcRouted && message.threadId ? { legacyThreadParentRef: buildChatV2SourceId(channel.id, message.threadId) } : {}),
    ...(orcRouted ? { tags: ['chat-v2'] } : {}),
    receipt: { kind: 'chat-v2', chatChannelId: channel.id, threadId: root },
  };
}

/**
 * Ticket intake for an owner's chat-v2 message (specs/ticket-loop.md §2),
 * shared by the REST controller and the portal relay adapter. Waits at most
 * `TICKET_CONSTANTS.INTAKE_TIMEOUT_MS`; never throws.
 *
 * @param intake - The intake service (null → no-op)
 * @param channel - The message's channel
 * @param message - The persisted message
 * @param origin - `chat`, `portal` or `mobile`
 * @returns The message to dispatch — a copy carrying the ticket line when it
 *   belongs to a ticket, otherwise the message itself
 */
export async function intakeChatV2OwnerMessage(
  intake: Pick<TicketIntakeService, 'intakeWithOutcome'> | null,
  channel: ChatChannelDTO,
  message: ChatMessageDTO,
  origin: Extract<TicketOriginChannel, 'chat' | 'portal' | 'mobile'>,
): Promise<ChatMessageDTO> {
  try {
    const intakeMessage = chatV2IntakeMessage(channel, message, origin);
    if (!intakeMessage) return message;
    const outcome = await intakeWithin(intake, intakeMessage);
    return markAndLinkTicket(message, ticketOfOutcome(outcome));
  } catch {
    // Ticket intake must never stop a message from being delivered.
    return message;
  }
}

// ---------------------------------------------------------------------------
// Slack intake (team channels / shared rooms, agent DMs, legacy bridge)
// ---------------------------------------------------------------------------

/** What the Slack call sites know about an inbound message. */
export interface SlackIntakeInput {
  text: string;
  slackChannelId: string;
  ts: string;
  threadTs?: string;
  userId: string;
  userName?: string;
  /** Set when a bot (one of the account's agents) wrote it */
  authorAgentSession?: string;
  hasFiles?: boolean;
  /**
   * Slack user id of the owner (the Cloud app's installer), when known. Then
   * only that user's messages file tickets; other people in the workspace do
   * not (Phase 1). Unknown (self-hosted socket mode) = any human.
   */
  ownerUserId?: string | null;
}

/**
 * Build the intake message for a Slack message.
 *
 * The source id prefix is per surface: the legacy bridge keeps `slack-…`
 * (the SLA subscriber and status updater key on it), team channels use
 * `slackch-…` and agent DMs `slackdm-…` so an orc reply in the same thread
 * cannot close a ticket that belongs to a team.
 *
 * @param input - The Slack message
 * @param surface - Which Slack path received it
 * @param options - Assignee and where the receipt goes
 * @returns The intake message
 */
export function slackIntakeMessage(
  input: SlackIntakeInput,
  surface: 'legacy-bridge' | 'team-channel' | 'agent-dm',
  options: { targetAgent?: string; receiptPostAs?: string } = {},
): IntakeMessage {
  const root = input.threadTs || input.ts;
  const isReply = !!input.threadTs && input.threadTs !== input.ts;
  const prefix = surface === 'legacy-bridge' ? 'slack' : surface === 'team-channel' ? 'slackch' : 'slackdm';
  // Legacy shape (2026-05-13): top level `slack-<ch>-<ts>`, reply `slack-<ch>-<root>-msg-<ts>`.
  const ref = isReply
    ? `${prefix}-${input.slackChannelId}-${root}-msg-${input.ts}`
    : `${prefix}-${input.slackChannelId}-${input.ts}`;
  const channel: TicketOriginChannel =
    surface === 'agent-dm' ? 'slack-dm' : surface === 'team-channel' ? 'slack-channel' : input.slackChannelId.startsWith('D') ? 'slack-dm' : 'slack-channel';
  return {
    text: input.text ?? '',
    isOwner: !input.authorAgentSession && (!input.ownerUserId || input.userId === input.ownerUserId),
    origin: {
      channel,
      ref,
      threadRef: slackThreadRef(input.slackChannelId, root),
      author: input.userId,
      ...(input.userName ? { authorName: input.userName } : {}),
    },
    conversationRef: slackConversationRef(input.slackChannelId),
    ...(isReply ? { legacyThreadParentRef: `${prefix}-${input.slackChannelId}-${root}` } : {}),
    ...(input.hasFiles ? { attachments: [{}] } : {}),
    ...(options.targetAgent ? { targetAgent: options.targetAgent } : {}),
    // `slack` makes the SLA subscriber put a respond-to-user WorkItem on the
    // orchestrator — right only when the orchestrator is the one answering.
    ...(surface === 'legacy-bridge' && (!options.targetAgent || options.targetAgent === ORCHESTRATOR_SESSION_NAME)
      ? { tags: ['slack'] }
      : {}),
    receipt: {
      kind: 'slack',
      slackChannelId: input.slackChannelId,
      threadTs: root,
      messageTs: input.ts,
      ...(options.receiptPostAs ? { postAs: options.receiptPostAs } : {}),
    },
  };
}
