/**
 * ChatV2DispatcherService — deliver user-origin chat messages to the
 * bound agent session.
 *
 * Flow:
 *   HTTP POST /api/chat/channels/:id/messages
 *     → ChatV2Service.sendMessage (persist + dedupe)
 *     → controller broadcasts WS message frame (user bubble)
 *     → controller calls ChatV2Dispatcher.dispatchToAgent(channel, messageDTO)
 *     → sendMessageToAgent(agent_session, "[CHAT:<id>] <content>\n<hint>")
 *     → agent processes + calls `reply-channel` skill
 *     → skill POSTs back to /api/chat/channels/:id/messages as the agent
 *     → same controller path → WS message frame (agent bubble)
 *
 * This service is intentionally thin — a couple of dozen lines of glue
 * around the AgentRegistrationService's `sendMessageToAgent` primitive.
 * The dispatch prompt is extracted so tests can assert the format, which
 * is the contract the `reply-channel` skill relies on.
 *
 * @module services/chat-v2/chat-v2.dispatcher.service
 */

import type { ChatChannelDTO, ChatMessageDTO } from './types.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Minimal surface the dispatcher needs from the agent-registration service.
 * Typed explicitly so tests can pass a stub without pulling in the full
 * AgentRegistrationService class.
 */
export interface AgentMessageSink {
  sendMessageToAgent(
    sessionName: string,
    message: string,
  ): Promise<{ success: boolean; error?: string; message?: string; queued?: boolean }>;
}

/** Result returned by `dispatchToAgent`. */
export interface DispatchResult {
  /** True when the runtime accepted the message (or queued it for delivery). */
  dispatched: boolean;
  /** Filled when `dispatched === false`. */
  error?: string;
}

/** Constructor options for {@link ChatV2DispatcherService}. */
export interface ChatV2DispatcherOptions {
  agentSink: AgentMessageSink;
  /**
   * Override the prompt formatter for tests / future customization. The
   * default matches the `reply-channel` skill's parser exactly.
   */
  formatPrompt?: (args: FormatPromptArgs) => string;
}

/** Inputs to the prompt formatter. */
export interface FormatPromptArgs {
  channelId: string;
  channelName: string;
  agentSession: string;
  senderId: string;
  content: string;
  clientMessageId?: string;
}

// ---------------------------------------------------------------------------
// Prompt formatter
// ---------------------------------------------------------------------------

/**
 * Default prompt formatter the agent sees when a user sends in their
 * chat channel.
 *
 * Format is intentionally stable and tag-prefixed so the `reply-channel`
 * skill (and future tooling) can reliably extract the channelId without
 * regex ambiguity. The `回复:` hint line gives the agent a one-step
 * instruction on how to reply.
 */
export function defaultFormatPrompt(args: FormatPromptArgs): string {
  const { channelId, channelName, senderId, content, clientMessageId } = args;
  const trimmed = content.trim();
  const idHint = clientMessageId ? ` [cmid:${clientMessageId}]` : '';
  return [
    `[CHAT:${channelId}]${idHint} <${senderId}@${channelName}>`,
    ``,
    trimmed,
    ``,
    `---`,
    `回复本频道: 用 \`reply-channel\` skill, 参数 channelId="${channelId}"、content="<your reply>"。`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Dispatches user-origin chat messages to the agent session bound to the
 * channel. Invoked from the chat controller after `ChatV2Service.sendMessage`
 * returns.
 */
export class ChatV2DispatcherService {
  private readonly agentSink: AgentMessageSink;
  private readonly formatPrompt: (args: FormatPromptArgs) => string;
  private readonly logger: ComponentLogger;

  constructor(options: ChatV2DispatcherOptions) {
    this.agentSink = options.agentSink;
    this.formatPrompt = options.formatPrompt ?? defaultFormatPrompt;
    this.logger = LoggerService.getInstance().createComponentLogger('ChatV2Dispatcher');
  }

  /**
   * Push a newly-persisted user message to the agent.
   *
   * Dispatch is fire-and-forget at the API-response level (the HTTP 201 has
   * already been serialized), but we still await the write so tests can
   * observe the outcome and the logger can record failures.
   *
   * Messages where `senderType !== "user"` are a no-op — we never loop an
   * agent's own reply back into its own PTY.
   *
   * @param channel - Channel DTO (provides `agentSession` + display name)
   * @param message - Persisted message DTO
   */
  async dispatchToAgent(
    channel: ChatChannelDTO,
    message: ChatMessageDTO,
  ): Promise<DispatchResult> {
    if (message.senderType !== 'user') {
      return { dispatched: false, error: 'not a user-origin message' };
    }
    if (!channel.agentSession) {
      this.logger.warn('chat-v2 dispatch skipped — no agentSession', {
        channelId: channel.id,
      });
      return { dispatched: false, error: 'channel has no bound agent' };
    }

    const prompt = this.formatPrompt({
      channelId: channel.id,
      channelName: channel.name,
      agentSession: channel.agentSession,
      senderId: message.senderId,
      content: message.content,
      clientMessageId:
        typeof message.metadata?.clientMessageId === 'string'
          ? (message.metadata.clientMessageId as string)
          : undefined,
    });

    let result: Awaited<ReturnType<AgentMessageSink['sendMessageToAgent']>>;
    try {
      result = await this.agentSink.sendMessageToAgent(channel.agentSession, prompt);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error('chat-v2 dispatch threw', {
        channelId: channel.id,
        agentSession: channel.agentSession,
        err: errMsg,
      });
      return { dispatched: false, error: errMsg };
    }

    if (!result.success) {
      this.logger.warn('chat-v2 dispatch reported failure', {
        channelId: channel.id,
        agentSession: channel.agentSession,
        err: result.error,
      });
      return { dispatched: false, error: result.error ?? 'unknown sink failure' };
    }

    this.logger.debug('chat-v2 dispatched', {
      channelId: channel.id,
      agentSession: channel.agentSession,
      queued: result.queued ?? false,
    });
    return { dispatched: true };
  }
}
