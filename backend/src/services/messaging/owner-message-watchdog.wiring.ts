/**
 * Wiring for the unanswered-owner-message watchdog: turns deliveries into
 * tracked entries, turns what the owner can see into "answered", and
 * implements the nudge and the note on top of the real transports.
 *
 * Kept apart from the service so the timeline logic stays transport-free and
 * the transport glue stays small and testable with plain fakes.
 *
 * @module services/messaging/owner-message-watchdog.wiring
 * @see specs/2026-09-30-owner-message-guarantee.md
 */

import * as path from 'path';
import {
  AGENT_REPLY_CONSTANTS,
  MESSAGE_SOURCES,
  ORCHESTRATOR_SESSION_NAME,
  OWNER_EVIDENCE_METADATA,
  OWNER_MESSAGE_WATCHDOG_CONSTANTS as C,
  SLACK_TYPING_CONSTANTS,
} from '../../constants.js';
import { LoggerService } from '../core/logger.service.js';
import type { ChatChannelDTO, ChatMessageDTO } from '../chat-v2/types.js';
import type { DispatchMessageResult } from '../chat-v2/chat-v2.dispatcher.service.js';
import { slackThreadTag } from '../slack/slack-thread-key.js';
import { spendCapStopOf } from '../spend/spend-cap.gate.js';
import {
  OwnerMessageWatchdogService,
  setOwnerMessageWatchdog,
  type LoginHint,
  type NudgeOutcome,
  type OwnerMessageEntry,
  type OwnerMessageTrackInput,
} from './owner-message-watchdog.service.js';

const logger = LoggerService.getInstance().createComponentLogger('OwnerMessageWatchdogWiring');

// ---------------------------------------------------------------------------
// Delivery → tracked entry
// ---------------------------------------------------------------------------

/**
 * Whether a chat-v2 user turn was written by the owner: not by an agent (here
 * or on another machine), and — for a Slack row, when the owner is known — by
 * the owner's Slack user.
 *
 * @param message - The turn
 * @param ownerSlackUserId - The workspace owner's Slack user id, when known
 * @returns True for the owner's message
 */
export function isOwnerChatTurn(
  message: Pick<ChatMessageDTO, 'senderType' | 'metadata'>,
  ownerSlackUserId: string | null | undefined,
): boolean {
  if (message.senderType !== 'user') return false;
  const meta = message.metadata ?? {};
  if (meta[OWNER_EVIDENCE_METADATA.AUTHOR_AGENT_SESSION] || meta[OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION]) return false;
  const source = typeof meta.source === 'string' ? meta.source : '';
  if ((OWNER_EVIDENCE_METADATA.AGENT_REPLY_SOURCES as readonly string[]).includes(source)) return false;
  if (source === 'slack') {
    const slackUserId = typeof meta.slackUserId === 'string' ? meta.slackUserId : '';
    if (!slackUserId) return false;
    return !ownerSlackUserId || slackUserId === ownerSlackUserId;
  }
  return true;
}

/**
 * Build the entry for a chat-v2 dispatch that reached at least one agent.
 *
 * Responsible agent: the first recipient that had to answer; with nobody
 * required (an un-addressed room message the awake agents were only told
 * about), the room lead when it got the message, else the first non-
 * orchestrator recipient. An orchestrator that was only woken to route a
 * private room's message is never made responsible: its hand-off re-dispatches
 * the message, and that dispatch is tracked under the same key.
 *
 * @param channel - Channel the message was recorded in
 * @param message - The owner's turn
 * @param result - Dispatch outcome
 * @param ctx - Owner id and the room lead, when known
 * @returns Track input, or null when nothing should be tracked
 */
export function trackInputFromDispatch(
  channel: Pick<ChatChannelDTO, 'id' | 'type' | 'agentSession'>,
  message: ChatMessageDTO,
  result: DispatchMessageResult,
  ctx: { ownerSlackUserId?: string | null; leader?: string | null } = {},
): OwnerMessageTrackInput | null {
  if (!result.dispatched) return null;
  if (!isOwnerChatTurn(message, ctx.ownerSlackUserId)) return null;

  let recipients: string[] = [];
  let required: string[] = [];
  if (result.strategy === 'dm') {
    if (channel.agentSession) recipients = required = [channel.agentSession];
  } else if (result.strategy === 'huddle-broadcast') {
    // A recipient told to stay silent by default owes no answer.
    const got = (result.huddleOutcomes ?? []).filter((o) => o.dispatched && !o.silentByDefault);
    recipients = got.map((o) => o.sessionName);
    required = got.filter((o) => o.responseMode === 'required').map((o) => o.sessionName);
  } else if (result.strategy === 'channel-mentions') {
    recipients = required = (result.mentionOutcomes ?? []).filter((o) => o.dispatched).map((o) => o.target.sessionName);
  }
  if (recipients.length === 0) return null;

  let responsible = required[0];
  if (!responsible) {
    const nonOrc = recipients.filter((s) => s !== ORCHESTRATOR_SESSION_NAME);
    responsible = ctx.leader && nonOrc.includes(ctx.leader) ? ctx.leader : nonOrc[0];
  }
  if (!responsible) return null;

  const meta = message.metadata ?? {};
  const isHuddle = channel.type !== 'dm';
  // When the owner wrote it: the timeline starts there, and an answer that
  // beat this call (a fast agent while a colleague cold-starts) still counts.
  const receivedAt = typeof message.createdAt === 'number' && message.createdAt > 0 ? { receivedAt: message.createdAt } : {};
  const chatThreadId = isHuddle ? message.threadId ?? message.id : undefined;
  const slackChannelId = meta.source === 'slack' && typeof meta.slackChannelId === 'string' ? meta.slackChannelId : undefined;
  if (slackChannelId) {
    const sourceTs = typeof meta.slackTs === 'string' ? meta.slackTs : undefined;
    const threadTs = typeof meta.slackThreadTs === 'string' ? meta.slackThreadTs : sourceTs;
    return {
      surface: 'slack',
      slackChannelId,
      ...(threadTs ? { threadTs } : {}),
      ...(sourceTs ? { sourceTs } : {}),
      chatChannelId: channel.id,
      ...(chatThreadId ? { chatThreadId } : {}),
      messageId: message.id,
      responsible,
      recipients,
      required: required.length > 0,
      text: message.content ?? '',
      ...receivedAt,
    };
  }
  return {
    surface: 'chat',
    chatChannelId: channel.id,
    ...(chatThreadId ? { chatThreadId } : {}),
    messageId: message.id,
    responsible,
    recipients,
    required: required.length > 0,
    text: message.content ?? '',
    ...receivedAt,
  };
}

/**
 * Login hint for a runtime waiting on a sign-in ("reply `relogin claude`").
 *
 * @param runtimeType - The runtime type recorded with the login request, if any
 * @returns The hint
 */
export function loginHintFor(runtimeType: string | null | undefined): LoginHint {
  const rt = (runtimeType ?? '').toLowerCase();
  if (rt.includes('codex')) return { runtime: 'Codex', runtimeCmd: 'codex' };
  if (rt.includes('gemini') || rt.includes('antigravity')) return { runtime: 'Gemini', runtimeCmd: 'gemini' };
  return { runtime: 'Claude', runtimeCmd: 'claude' };
}

/**
 * The reminder delivered to the responsible agent. Carries the same routing
 * header a normal delivery does, so the agent's `reply` goes back to the
 * owner's conversation (and thread).
 *
 * @param entry - The unanswered message
 * @param waitedMinutes - How long it has waited
 * @param opts - `withHeader: false` when the transport adds its own `[CHAT:…]` header (the orchestrator's queue)
 * @returns The text to deliver
 */
export function buildNudgeMessage(entry: OwnerMessageEntry, waitedMinutes: number, opts: { withHeader?: boolean } = {}): string {
  const identity = /^[A-Za-z0-9._-]+$/.test(entry.responsible) ? `CREWLY_SESSION_NAME=${entry.responsible} ` : '';
  const replyCmd = `${identity}bash ${AGENT_REPLY_CONSTANTS.SKILL_PATH} "<你的回复>"`;
  const noneCmd = `${identity}bash ${AGENT_REPLY_CONSTANTS.SKILL_PATH} --none`;
  const withHeader = opts.withHeader ?? true;
  const head = withHeader && entry.chatChannelId ? `[CHAT:${entry.chatChannelId}] <owner@reminder>` : null;
  const threadTag =
    entry.surface === 'slack' && entry.slackChannelId && (entry.threadTs ?? entry.sourceTs)
      ? slackThreadTag(entry.slackChannelId, (entry.threadTs ?? entry.sourceTs) as string)
      : null;
  return [
    ...(head ? [head] : []),
    ...(threadTag ? [threadTag] : []),
    '',
    C.NUDGE_TEXT.replace('{waited}', String(waitedMinutes)).replace('{replyCmd}', replyCmd).replace('{noneCmd}', noneCmd),
    '',
    `owner 的原话: ${entry.preview}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** What the wiring needs from the rest of the backend. */
export interface OwnerWatchdogWiringDeps {
  crewlyHome: string;
  /** PTY / in-process delivery (sub-agents) */
  sendToAgent: (session: string, text: string) => Promise<{ success: boolean; error?: string }>;
  /** Whether the agent's runtime session exists */
  sessionExists: (session: string) => boolean;
  /** User-initiated activation (same path as the dispatcher's activate-on-send) */
  activate: (session: string) => Promise<{ success: boolean; error?: string }>;
  /** Orchestrator delivery (its message queue) */
  enqueueForOrchestrator: (input: {
    content: string;
    conversationId: string;
    source: string;
    sourceMetadata?: Record<string, unknown>;
  }) => void;
  isBusy: (session: string) => boolean;
  /** Pending sign-in record for the session, if any */
  loginRequired: (session: string) => { runtimeType?: string | null } | null | undefined;
  displayNameOf?: (session: string) => string;
  /** Slack posting (null while Slack is not wired) */
  slack: () => {
    isConnected(): boolean;
    sendMessage(m: { channelId: string; text: string; threadTs?: string; botToken?: string; notAnAnswer?: boolean; skipChatV2Mirror?: boolean }): Promise<string>;
  } | null;
  /** Whether a placeholder shows in a Slack thread */
  owesThread: (slackChannelId: string, threadTs: string) => boolean;
  /** Bot token of the agent whose own app owns this Slack DM (the master bot cannot post there) */
  agentDmBotToken: (slackChannelId: string) => string | undefined;
  /** An agent's own bot token, when installed */
  botTokenOf: (session: string) => string | undefined;
  /** Record a system note in a chat-v2 channel; false when it could not be recorded */
  recordChatNote: (chatChannelId: string, threadId: string | undefined, text: string) => boolean;
  /** Tell the reply router which chat thread a nudge is about */
  noteOriginThread?: (session: string, chatChannelId: string, threadId: string | undefined) => void;
}

/** chat-v2 metadata flag on the watchdog's own chat notes (never taken as an answer). */
export const OWNER_WATCHDOG_NOTE_METADATA_KEY = 'ownerWatchdogNote';

/**
 * Re-deliver an unanswered message to its responsible agent.
 *
 * @param deps - Wiring deps
 * @param entry - The message
 * @param waited - Minutes waited
 * @returns Sent, or blocked with the reason
 */
export async function nudgeAgent(deps: OwnerWatchdogWiringDeps, entry: OwnerMessageEntry, waited: number): Promise<NudgeOutcome> {
  const session = entry.responsible;
  if (session === ORCHESTRATOR_SESSION_NAME) {
    const text = buildNudgeMessage(entry, waited, { withHeader: false });
    if (!entry.chatChannelId) return { outcome: 'blocked', reason: 'error', detail: 'no conversation to re-deliver to' };
    try {
      deps.enqueueForOrchestrator({
        content: text,
        conversationId: entry.chatChannelId,
        source: entry.surface === 'slack' ? MESSAGE_SOURCES.SLACK : MESSAGE_SOURCES.WEB_CHAT,
        ...(entry.surface === 'slack' && entry.slackChannelId
          ? { sourceMetadata: { channelId: entry.slackChannelId, threadTs: entry.threadTs ?? entry.sourceTs } }
          : {}),
      });
      return { outcome: 'sent' };
    } catch (err) {
      return { outcome: 'blocked', reason: 'error', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const text = buildNudgeMessage(entry, waited);
  let woke = false;
  if (!deps.sessionExists(session)) {
    const res = await deps.activate(session).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.success) return { outcome: 'blocked', reason: 'asleep', detail: res.error ?? 'activation failed' };
    woke = true;
  }
  let result = await deps.sendToAgent(session, text).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
  if (!result.success && !woke && !deps.sessionExists(session)) {
    const res = await deps.activate(session).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
    if (!res.success) return { outcome: 'blocked', reason: 'asleep', detail: res.error ?? 'activation failed' };
    result = await deps.sendToAgent(session, text).catch((err: unknown) => ({ success: false, error: err instanceof Error ? err.message : String(err) }));
  }
  if (!result.success) return { outcome: 'blocked', reason: 'error', detail: result.error ?? 'delivery failed' };
  if (entry.chatChannelId) deps.noteOriginThread?.(session, entry.chatChannelId, entry.chatThreadId);
  return { outcome: 'sent' };
}

/**
 * Post the note where the owner wrote: the Slack thread (Crewly's master bot;
 * in an agent-owned DM the agent's bot, the only one that can post there), or
 * a system turn in the chat channel.
 *
 * @param deps - Wiring deps
 * @param entry - The message
 * @param text - The note
 * @returns True when posted
 */
export async function postOwnerNote(deps: OwnerWatchdogWiringDeps, entry: OwnerMessageEntry, text: string): Promise<boolean> {
  if (entry.surface === 'chat') {
    if (!entry.chatChannelId) return false;
    return deps.recordChatNote(entry.chatChannelId, entry.chatThreadId, text);
  }
  const slack = deps.slack();
  if (!slack?.isConnected() || !entry.slackChannelId) return false;
  const threadTs = entry.threadTs ?? entry.sourceTs;
  const base = { channelId: entry.slackChannelId, text, ...(threadTs ? { threadTs } : {}), notAnAnswer: true, skipChatV2Mirror: true };
  const dmToken = deps.agentDmBotToken(entry.slackChannelId);
  try {
    await slack.sendMessage(dmToken ? { ...base, botToken: dmToken } : base);
    return true;
  } catch (err) {
    const fallback = !dmToken ? deps.botTokenOf(entry.responsible) : undefined;
    if (!fallback) throw err;
    await slack.sendMessage({ ...base, botToken: fallback });
    return true;
  }
}

/**
 * Build the watchdog on the real transports and expose it as the singleton.
 *
 * @param deps - Wiring deps
 * @returns The started watchdog
 */
export function createOwnerMessageWatchdog(deps: OwnerWatchdogWiringDeps): OwnerMessageWatchdogService {
  const service = new OwnerMessageWatchdogService({
    isBusy: deps.isBusy,
    hasVisiblePlaceholder: (entry) => {
      const threadTs = entry.threadTs ?? entry.sourceTs;
      return !!entry.slackChannelId && !!threadTs && deps.owesThread(entry.slackChannelId, threadTs);
    },
    nudge: (entry, waited) => nudgeAgent(deps, entry, waited),
    postNote: (entry, text) => postOwnerNote(deps, entry, text),
    loginRequired: (session) => {
      const info = deps.loginRequired(session);
      return info ? loginHintFor(info.runtimeType) : null;
    },
    spendCapped: (session) => spendCapStopOf(session),
    ...(deps.displayNameOf ? { displayNameOf: deps.displayNameOf } : {}),
    storePath: path.join(deps.crewlyHome, C.STORE_FILENAME),
  });
  setOwnerMessageWatchdog(service);
  service.start();
  return service;
}

// ---------------------------------------------------------------------------
// Answer signals
// ---------------------------------------------------------------------------

/**
 * Feed a chat-v2 turn to the watchdog: an agent turn in a watched chat
 * channel is the answer (an interim one is a visible "working on it").
 *
 * @param service - The watchdog
 * @param dto - The recorded turn
 */
export function onChatTurn(service: Pick<OwnerMessageWatchdogService, 'noteChatAnswer'>, dto: ChatMessageDTO): void {
  if (dto.senderType !== 'agent') return;
  if (dto.metadata?.[OWNER_WATCHDOG_NOTE_METADATA_KEY]) return;
  const interim = dto.metadata?.[SLACK_TYPING_CONSTANTS.INTERIM_METADATA_KEY] === true;
  service.noteChatAnswer(dto.channelId, dto.threadId ?? null, interim);
}

/**
 * Feed a Slack post made through this machine's SlackService.
 *
 * @param service - The watchdog
 * @param post - Channel, thread and whether it was flagged as not an answer
 */
export function onSlackOutbound(
  service: Pick<OwnerMessageWatchdogService, 'noteSlackAnswer'>,
  post: { channelId: string; threadTs?: string; notAnAnswer?: boolean; kind?: string },
): void {
  if (post.notAnAnswer) return;
  service.noteSlackAnswer(post.channelId, post.threadTs, post.kind ?? 'post');
}

/**
 * Feed an inbound Slack message: a colleague agent (any machine) posting in
 * a watched thread answered it.
 *
 * @param service - The watchdog
 * @param message - Inbound message fields
 */
export function onSlackInbound(
  service: Pick<OwnerMessageWatchdogService, 'noteSlackAnswer'>,
  message: { channelId: string; threadTs?: string; authorAgentSession?: string },
): void {
  if (!message.authorAgentSession || !message.threadTs) return;
  service.noteSlackAnswer(message.channelId, message.threadTs, `agent ${message.authorAgentSession} posted`);
}

/** Log once when wiring is skipped (kept here so index.ts stays thin). */
export function logWiringSkipped(reason: string): void {
  logger.warn('Owner message watchdog not started', { reason });
}
