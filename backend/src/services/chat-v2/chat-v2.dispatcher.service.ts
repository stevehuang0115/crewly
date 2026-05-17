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
import type {
  ChatV2MentionResolver,
  MentionResolverContext,
  MentionTarget,
} from './chat-v2.mention-resolver.js';
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

/** One per-recipient outcome produced by `dispatchMessage`. */
export interface MentionDispatchOutcome {
  /** The mention target the dispatcher attempted to deliver to. */
  target: MentionTarget;
  /** Underlying delivery result from `AgentMessageSink.sendMessageToAgent`. */
  dispatched: boolean;
  /** Error message, if delivery failed. */
  error?: string;
}

/**
 * Phase B-2 (2026-05-17) — one per-member outcome for huddle dispatch.
 *
 * Huddles don't go through `MentionResolver` — their roster is read
 * directly from `chat_channel_members`. The outcome records whether
 * the member was @-mentioned (which controls `responseMode` in the
 * prompt) and whether the underlying sink call succeeded.
 */
export interface HuddleDispatchOutcome {
  /** Member's agent session name. */
  sessionName: string;
  /**
   * `'required'` when the member appeared in `message.mentions[]`
   * (they MUST reply); `'optional'` otherwise (they MAY reply if it
   * makes sense). Surfaced in the formatted prompt.
   */
  responseMode: 'required' | 'optional';
  /** Whether the prompt was successfully queued for the member. */
  dispatched: boolean;
  /** Error message, if delivery failed. */
  error?: string;
}

/**
 * Aggregate result of `dispatchMessage`. Reports the chosen routing
 * strategy and per-recipient outcomes so callers (and tests) can assert
 * exactly what fan-out happened without re-running the resolver.
 */
export interface DispatchMessageResult {
  /**
   * - `'dm'`: legacy 1:1 path — used by `type='dm'` channels.
   * - `'channel-mentions'`: Phase C BE.3 fan-out — used by `type='channel'`
   *   channels with at least one resolved mention.
   * - `'skip'`: nothing was dispatched (non-user message, no recipients,
   *   archived/unbound channel, etc.). `reason` is filled.
   */
  strategy: 'dm' | 'channel-mentions' | 'huddle-broadcast' | 'skip';
  /** True when at least one underlying delivery succeeded. */
  dispatched: boolean;
  /** Filled when `strategy === 'skip'`. */
  reason?: string;
  /** Populated for `strategy === 'dm'`. */
  dmResult?: DispatchResult;
  /**
   * Populated for `strategy === 'channel-mentions'`. One entry per
   * resolved target. Empty when no mentions resolved.
   */
  mentionOutcomes?: MentionDispatchOutcome[];
  /**
   * Phase B-2 — populated for `strategy === 'huddle-broadcast'`. One
   * entry per huddle member. Mentioned members carry
   * `responseMode: 'required'`; the rest are `'optional'`.
   */
  huddleOutcomes?: HuddleDispatchOutcome[];
}

/** Constructor options for {@link ChatV2DispatcherService}. */
export interface ChatV2DispatcherOptions {
  agentSink: AgentMessageSink;
  /**
   * Override the prompt formatter for tests / future customization. The
   * default matches the `reply-channel` skill's parser exactly.
   */
  formatPrompt?: (args: FormatPromptArgs) => string;
  /**
   * Phase C BE.3 — resolver used when dispatching a `type='channel'`
   * message to its mentioned recipients. When omitted, channel-typed
   * messages skip dispatch entirely (preserves the BE.1+BE.2 contract
   * for callers that haven't wired the resolver yet, e.g. legacy unit
   * tests). The production composition root injects a resolver backed
   * by `StorageService.getTeams()`.
   */
  mentionResolver?: ChatV2MentionResolver;
  /**
   * Phase B-2 (2026-05-17) — roster lookup used when dispatching a
   * `type='huddle'` message to every member. Synchronous because the
   * production implementation is a direct SQLite read against
   * `chat_channel_members`. When omitted, huddle messages skip
   * dispatch (mirrors how `mentionResolver` gates `'channel'` rows).
   *
   * Returns the list of `agentSession` ids for the huddle's members.
   * Order doesn't matter — the dispatcher loops over the whole list.
   */
  huddleMembersFor?: (channelId: string) => readonly string[];
}

/** Inputs to the prompt formatter. */
export interface FormatPromptArgs {
  channelId: string;
  channelName: string;
  agentSession: string;
  senderId: string;
  content: string;
  clientMessageId?: string;
  /**
   * Phase B-2 — in a huddle, every member receives the prompt but
   * only the @-mentioned ones MUST reply. The default formatter
   * appends a "你必须回复" (mandatory) or "你可以选择是否回复" (optional)
   * tag so the agent's prompt-following heuristics can branch. Defaults
   * to `'required'` for DMs and `'channel'` (single-mention) dispatches
   * where every recipient was explicitly addressed.
   */
  responseMode?: 'required' | 'optional';
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
  const { channelId, channelName, senderId, content, clientMessageId, responseMode } = args;
  const trimmed = content.trim();
  const idHint = clientMessageId ? ` [cmid:${clientMessageId}]` : '';
  // Default to "required" so DM and single-mention channel dispatches
  // preserve the legacy "must reply" semantic. Only huddles flip this
  // to "optional" for non-@'d members.
  const mode = responseMode ?? 'required';
  const replyHint = mode === 'optional'
    ? `回复本频道: 你在此 huddle 中收到此消息但未被 @ — 如有必要可用 \`reply-channel\` skill (channelId="${channelId}") 回复，否则不回复也可以。`
    : `回复本频道: 用 \`reply-channel\` skill, 参数 channelId="${channelId}"、content="<your reply>"。`;
  return [
    `[CHAT:${channelId}]${idHint} <${senderId}@${channelName}>`,
    ``,
    trimmed,
    ``,
    `---`,
    replyHint,
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
  private readonly mentionResolver?: ChatV2MentionResolver;
  private readonly huddleMembersFor?: (channelId: string) => readonly string[];
  private readonly logger: ComponentLogger;

  constructor(options: ChatV2DispatcherOptions) {
    this.agentSink = options.agentSink;
    this.formatPrompt = options.formatPrompt ?? defaultFormatPrompt;
    this.mentionResolver = options.mentionResolver;
    this.huddleMembersFor = options.huddleMembersFor;
    this.logger = LoggerService.getInstance().createComponentLogger('ChatV2Dispatcher');
  }

  /**
   * Phase C BE.3 entry point — choose the routing strategy from
   * `channel.type` and the message's mentions, then fan out.
   *
   * Routing rules (SEALED §2.1):
   *   - `type='dm'` → existing 1:1 path via `dispatchToAgent`. Mentions
   *     in DMs are advisory only (the channel already binds to one
   *     agent); the dispatcher does not currently re-route them.
   *   - `type='channel'` → resolve `message.mentions` via the injected
   *     `mentionResolver`, then dispatch the formatted prompt to each
   *     resolved sessionName. No mentions → no dispatch (the message
   *     still persists; nobody is paged).
   *   - Agent-origin messages always skip dispatch (no self-loopback).
   *
   * Always resolves; per-recipient errors are captured in
   * {@link DispatchMessageResult.mentionOutcomes} and never thrown.
   *
   * @param channel - The channel DTO (provides `type`, name, agentSession).
   * @param message - The persisted message DTO (provides senderType, mentions).
   * @returns Aggregate result describing the strategy + outcomes.
   */
  async dispatchMessage(
    channel: ChatChannelDTO,
    message: ChatMessageDTO,
  ): Promise<DispatchMessageResult> {
    if (message.senderType !== 'user') {
      return {
        strategy: 'skip',
        dispatched: false,
        reason: 'not a user-origin message',
      };
    }

    if (channel.type === 'channel') {
      return this.dispatchChannelMentions(channel, message);
    }

    if (channel.type === 'huddle') {
      return this.dispatchHuddleBroadcast(channel, message);
    }

    // Default to the DM path for any other type (including legacy /
    // missing — `type` is non-null after Phase A migration but defensive
    // here keeps the dispatcher robust).
    const dmResult = await this.dispatchToAgent(channel, message);
    return {
      strategy: 'dm',
      dispatched: dmResult.dispatched,
      dmResult,
    };
  }

  /**
   * Phase B-2 — fan a user message out to every member of a huddle.
   *
   * Resolution path:
   *   1. Look up the roster via the injected `huddleMembersFor`. No
   *      resolver wired → return `strategy: 'skip'` (the message still
   *      persists; nobody is paged).
   *   2. Empty roster → same skip path. Should not happen since
   *      `createHuddle` rejects empty membership, but defensive.
   *   3. For each member, derive `responseMode` from whether their
   *      session appears in `message.mentions[]`. Format the prompt
   *      accordingly and call `sendMessageToAgent`.
   *
   * Always resolves; per-member errors are captured in
   * {@link DispatchMessageResult.huddleOutcomes} and never thrown.
   *
   * @param channel - The huddle channel.
   * @param message - The persisted user message.
   * @returns Aggregate result with one outcome per member.
   */
  private async dispatchHuddleBroadcast(
    channel: ChatChannelDTO,
    message: ChatMessageDTO,
  ): Promise<DispatchMessageResult> {
    if (!this.huddleMembersFor) {
      this.logger.debug('chat-v2 huddle dispatch skipped — no roster lookup wired', {
        channelId: channel.id,
        messageId: message.id,
      });
      return {
        strategy: 'skip',
        dispatched: false,
        reason: 'no huddleMembersFor resolver wired',
      };
    }

    const members = this.huddleMembersFor(channel.id);
    if (members.length === 0) {
      return {
        strategy: 'skip',
        dispatched: false,
        reason: 'huddle has no members',
      };
    }

    // Pre-build the mention set so each member lookup is O(1). The
    // wire mention is the agent session id (same shape as the roster
    // entries) so a simple Set membership check is enough.
    const mentioned = new Set(Array.isArray(message.mentions) ? message.mentions : []);

    const outcomes: HuddleDispatchOutcome[] = [];
    let anyDispatched = false;

    for (const sessionName of members) {
      const responseMode: 'required' | 'optional' = mentioned.has(sessionName) ? 'required' : 'optional';
      const prompt = this.formatPrompt({
        channelId: channel.id,
        channelName: channel.name,
        agentSession: sessionName,
        senderId: message.senderId,
        content: message.content,
        clientMessageId:
          typeof message.metadata?.clientMessageId === 'string'
            ? (message.metadata.clientMessageId as string)
            : undefined,
        responseMode,
      });

      try {
        const result = await this.agentSink.sendMessageToAgent(sessionName, prompt);
        if (result.success) {
          outcomes.push({ sessionName, responseMode, dispatched: true });
          anyDispatched = true;
        } else {
          this.logger.warn('chat-v2 huddle dispatch reported failure', {
            channelId: channel.id,
            sessionName,
            err: result.error,
          });
          outcomes.push({
            sessionName,
            responseMode,
            dispatched: false,
            error: result.error ?? 'unknown sink failure',
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('chat-v2 huddle dispatch threw', {
          channelId: channel.id,
          sessionName,
          err: errMsg,
        });
        outcomes.push({ sessionName, responseMode, dispatched: false, error: errMsg });
      }
    }

    return {
      strategy: 'huddle-broadcast',
      dispatched: anyDispatched,
      huddleOutcomes: outcomes,
    };
  }

  /**
   * Dispatch a `type='channel'` message to its resolved mentions.
   *
   * Skips entirely when:
   *   - No mention resolver is wired (return strategy=skip).
   *   - `mentions` is empty (return strategy=skip).
   *   - The resolver returns no targets (return strategy=channel-mentions
   *     with empty `mentionOutcomes`; `dispatched=false`).
   *
   * @param channel - The team channel.
   * @param message - The persisted user message.
   * @returns Aggregate result with one outcome per resolved recipient.
   */
  private async dispatchChannelMentions(
    channel: ChatChannelDTO,
    message: ChatMessageDTO,
  ): Promise<DispatchMessageResult> {
    if (!this.mentionResolver) {
      this.logger.debug('chat-v2 dispatch skipped — no mention resolver wired', {
        channelId: channel.id,
        messageId: message.id,
      });
      return {
        strategy: 'skip',
        dispatched: false,
        reason: 'no mention resolver wired for type=channel',
      };
    }

    const mentions = Array.isArray(message.mentions) ? message.mentions : [];
    if (mentions.length === 0) {
      return {
        strategy: 'skip',
        dispatched: false,
        reason: 'no mentions on type=channel message',
      };
    }

    const ctx: MentionResolverContext = { teamId: channel.teamId };
    const targets = await this.mentionResolver.resolve(mentions, ctx);

    const outcomes: MentionDispatchOutcome[] = [];
    let anyDispatched = false;

    for (const target of targets) {
      const prompt = this.formatPrompt({
        channelId: channel.id,
        channelName: channel.name,
        agentSession: target.sessionName,
        senderId: message.senderId,
        content: message.content,
        clientMessageId:
          typeof message.metadata?.clientMessageId === 'string'
            ? (message.metadata.clientMessageId as string)
            : undefined,
      });

      try {
        const result = await this.agentSink.sendMessageToAgent(target.sessionName, prompt);
        if (result.success) {
          outcomes.push({ target, dispatched: true });
          anyDispatched = true;
        } else {
          this.logger.warn('chat-v2 mention dispatch reported failure', {
            channelId: channel.id,
            sessionName: target.sessionName,
            err: result.error,
          });
          outcomes.push({
            target,
            dispatched: false,
            error: result.error ?? 'unknown sink failure',
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.error('chat-v2 mention dispatch threw', {
          channelId: channel.id,
          sessionName: target.sessionName,
          err: errMsg,
        });
        outcomes.push({ target, dispatched: false, error: errMsg });
      }
    }

    return {
      strategy: 'channel-mentions',
      dispatched: anyDispatched,
      mentionOutcomes: outcomes,
    };
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
   * @deprecated Issue #334 — `dispatchToAgent` is the legacy 1:1 entry
   * point. New callers MUST go through `dispatchMessage`, which routes
   * type='dm' messages here and adds the type='channel' (@mentions /
   * @team) path. Direct callers of `dispatchToAgent` silently bypass
   * the mention-resolution layer.
   *
   * Conversion: replace `dispatchToAgent(channel, message)` with
   * `dispatchMessage(channel, message)` and read the `dmResult` field
   * of the returned object. See chat-v2.dispatcher.service.ts:dispatchMessage
   * for the contract.
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
