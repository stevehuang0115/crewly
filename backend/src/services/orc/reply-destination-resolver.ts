/**
 * Where an agent's message to the owner goes — decided by the harness from
 * references, never from places the agent guessed
 * (specs/2026-10-02-harness-owned-routing.md §1).
 *
 * Incident (TKT-187, 2026-10-02): Owen ran `reply-chat --thread <#pro-ce key>`
 * with no conversation; the endpoint stored it against the globally newest
 * conversation (an unrelated huddle), filed it as status for the
 * orchestrator and answered `success: true`. The follow-up work item knew the
 * right thread the whole time.
 *
 * Order:
 *  1. the referenced message's conversation / thread;
 *  2. the referenced ticket's thread (request ticket chat thread, project
 *     ticket thread binding) or decision card's thread;
 *  3. the referenced work item's origin / destination;
 *  4. validated hints (agent-supplied conversation / thread ids);
 *  5. the reference the harness last prompted the agent about, when newer
 *     than its last owner turn;
 *  6. the agent's turn origin / current work;
 *  7. the agent's owner DM.
 *
 * Pure decision logic; collaborators are injected
 * (`reply-destination.wiring.ts` wires the real ones).
 *
 * @module services/orc/reply-destination-resolver
 */

import { REPLY_ROUTING_CONSTANTS, SLACK_THREAD_KEY_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { parseTicketNumber } from '../../types/v2/ticket.types.js';
import { formatSlackThreadKey, parseSlackThreadKey } from '../slack/slack-thread-key.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import { hasReference, type PromptReference, type ReplyReference } from './agent-prompt-reference.service.js';
import { currentWorkItemOf, originOfWorkItem, planWorkDestination, type WorkDestination } from './work-item-destination.js';

export type { ReplyReference } from './agent-prompt-reference.service.js';

/** Agent-supplied ids: hints only. */
export interface ReplyHints {
  /** `--conversation` / `--channel` (chat-v2 id) */
  conversationId?: string;
  /** `--thread`: a Slack thread key `C…:ts` or a chat-v2 message id */
  thread?: string;
  /** `slack-post --target` / upload channel (a Slack channel id), when one was named */
  slackChannelId?: string;
}

/** Which step decided. */
export type ReplyDestinationSource =
  | 'message'
  | 'ticket'
  | 'decision'
  | 'work-item'
  | 'hint'
  | 'prompt'
  | 'turn-origin'
  | 'current-work'
  | 'owner-dm';

/** Where the message goes. */
export type ReplyDestination =
  /** A chat-v2 conversation the agent belongs to (DM / room / huddle), in `thread` (Slack key or chat-v2 root id) */
  | { kind: 'conversation'; conversationId: string; thread?: string; source: ReplyDestinationSource; reason: string }
  /** A Slack place outside any chat conversation (ticket thread, trigger destination, team channel top level) */
  | { kind: 'work'; destination: Exclude<WorkDestination, { kind: 'owner-origin' }>; source: ReplyDestinationSource; reason: string }
  /** Nothing the harness can stand behind; `fix` is the command to tell the agent */
  | { kind: 'unresolved'; reason: string; fix: string };

/** A hint that was not used, and why (logged by the caller). */
export interface IgnoredHint {
  hint: string;
  why: string;
}

/** Result of {@link resolveReplyDestination}. */
export interface ReplyResolution {
  destination: ReplyDestination;
  ignoredHints: IgnoredHint[];
}

/** The chat-v2 message fields the resolver reads. */
export interface ResolverChatMessage {
  id: string;
  channelId: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
}

/** A request ticket's conversation. */
export interface ResolverRequestTicket {
  id: string;
  label: string;
  conversationId?: string;
  threadRootId?: string;
  slackChannelId?: string;
  threadTs?: string;
}

/** A decision's card place. */
export interface ResolverDecision {
  id: string;
  asker: string;
  requestedBy?: string;
  slackChannelId?: string;
  threadTs?: string;
  ticket?: { projectPath: string; id: string; title?: string };
  teamId?: string;
}

/** Collaborators. */
export interface ReplyResolverDeps {
  /** A chat-v2 message by id */
  getMessage(id: string): ResolverChatMessage | null;
  /** Whether the agent may post in a chat-v2 conversation (its DM, a room it is in) */
  ownsConversation(session: string, conversationId: string): Promise<boolean>;
  /** The Slack channel a chat-v2 conversation is mirrored to (team channel / DM link), or null */
  slackChannelOfConversation(conversationId: string): string | null;
  /** The chat-v2 conversation (and thread root) a Slack thread lives in, or null */
  conversationOfSlackThread(slackChannelId: string, threadTs: string): { conversationId: string; threadRootId?: string } | null;
  /** A request ticket by number */
  requestTicket(ticketNumber: number): Promise<ResolverRequestTicket | null>;
  /** A project ticket the agent can be talking about */
  projectTicket(session: string, ticketId: string): Promise<{ projectPath: string; ticketId: string; title?: string; teamId?: string } | null>;
  /** A decision by id */
  decision(id: string): Promise<ResolverDecision | null>;
  /** A work item by id */
  workItem(id: string): Promise<WorkItem | null>;
  /** Every pool item (for the agent's current work) */
  poolItems(): Promise<WorkItem[]>;
  /** The agent's last owner turn origin */
  turnOrigin(session: string): TurnOrigin | undefined;
  /** What the harness last prompted the agent about */
  promptReference(session: string): PromptReference | undefined;
  /** The agent's owner DM conversation (chat-v2), or null */
  ownerDm(session: string): Promise<string | null>;
  /** Clock (epoch ms) */
  now(): number;
}

/** Input of {@link resolveReplyDestination}. */
export interface ReplyResolveInput {
  session: string;
  reference?: ReplyReference;
  hints?: ReplyHints;
  /**
   * Skip the owner-DM fallback (step 7) — for posts that must not land in
   * the DM, e.g. the `[DONE]` notice.
   */
  noOwnerDm?: boolean;
}

/**
 * The thread an answer to `msg` belongs in: its Slack thread key when the
 * conversation is mirrored to Slack and the message knows its Slack thread,
 * else its chat-v2 thread root.
 *
 * @param msg - chat-v2 message
 * @param slackChannelId - The conversation's Slack channel, if any
 * @returns Thread reference
 */
export function threadOfMessage(msg: ResolverChatMessage, slackChannelId: string | null): string {
  const meta = msg.metadata ?? {};
  const named = parseSlackThreadKey(meta[SLACK_THREAD_KEY_CONSTANTS.METADATA_KEY]);
  if (named) return formatSlackThreadKey(named.slackChannelId, named.threadTs);
  const ts = typeof meta.slackThreadTs === 'string' && meta.slackThreadTs ? meta.slackThreadTs : undefined;
  if (ts && slackChannelId) return formatSlackThreadKey(slackChannelId, ts);
  return msg.threadId ?? msg.id;
}

/**
 * The command the agent should run when its message could not be placed.
 *
 * @param prompt - The agent's last prompt reference, if any
 * @returns An English instruction
 */
export function fixCommand(prompt?: ReplyReference): string {
  if (prompt?.ticket) return `reply --ticket ${prompt.ticket} "<your message>"`;
  if (prompt?.decisionId) return `reply --decision ${prompt.decisionId} "<your message>"`;
  if (prompt?.workItemId) return `reply --work-item ${prompt.workItemId} "<your message>"`;
  if (prompt?.messageId) return `reply --to ${prompt.messageId} "<your message>"`;
  return 'reply --ticket <TKT-id from your prompt> "<your message>" (or reply --to <message id from your prompt>)';
}

/**
 * Resolve one reference (steps 1–3).
 *
 * @param session - Agent
 * @param ref - Reference
 * @param deps - Collaborators
 * @returns A destination; `unresolved` when the reference is wrong; null when it names nothing usable (continue)
 */
export async function resolveReference(
  session: string,
  ref: ReplyReference,
  deps: ReplyResolverDeps,
): Promise<ReplyDestination | null> {
  if (ref.messageId) {
    const msg = deps.getMessage(ref.messageId);
    if (!msg) return { kind: 'unresolved', reason: `there is no message ${ref.messageId}`, fix: fixCommand() };
    if (!(await deps.ownsConversation(session, msg.channelId))) {
      return { kind: 'unresolved', reason: `you are not in the conversation of message ${ref.messageId}`, fix: fixCommand() };
    }
    return {
      kind: 'conversation',
      conversationId: msg.channelId,
      thread: threadOfMessage(msg, deps.slackChannelOfConversation(msg.channelId)),
      source: 'message',
      reason: `answering message ${ref.messageId}`,
    };
  }

  if (ref.ticket) {
    const label = ref.ticket.trim();
    const n = REPLY_ROUTING_CONSTANTS.REQUEST_TICKET_PATTERN.test(label) ? parseTicketNumber(label) : null;
    if (n !== null) {
      const t = await deps.requestTicket(n);
      if (!t) return { kind: 'unresolved', reason: `there is no ticket ${label}`, fix: fixCommand() };
      const key = t.slackChannelId && t.threadTs ? formatSlackThreadKey(t.slackChannelId, t.threadTs) : undefined;
      if (t.conversationId) {
        return {
          kind: 'conversation',
          conversationId: t.conversationId,
          ...(key || t.threadRootId ? { thread: key ?? t.threadRootId } : {}),
          source: 'ticket',
          reason: `ticket ${t.label}'s thread`,
        };
      }
      if (t.slackChannelId && t.threadTs) {
        const mapped = deps.conversationOfSlackThread(t.slackChannelId, t.threadTs);
        if (mapped) return { kind: 'conversation', conversationId: mapped.conversationId, thread: key, source: 'ticket', reason: `ticket ${t.label}'s thread` };
        return {
          kind: 'work',
          destination: { kind: 'slack', target: t.slackChannelId, threadTs: t.threadTs, reason: `ticket ${t.label}'s Slack thread` },
          source: 'ticket',
          reason: `ticket ${t.label}'s Slack thread`,
        };
      }
      return { kind: 'unresolved', reason: `ticket ${t.label} has no conversation to answer in`, fix: 'reply --to <message id from your prompt> "<your message>"' };
    }
    if (REPLY_ROUTING_CONSTANTS.PROJECT_TICKET_PATTERN.test(label)) {
      const pt = await deps.projectTicket(session, label);
      if (!pt) return { kind: 'unresolved', reason: `there is no project ticket ${label} you are working on`, fix: fixCommand() };
      return {
        kind: 'work',
        destination: {
          kind: 'ticket-thread',
          projectPath: pt.projectPath,
          ticketId: pt.ticketId,
          ...(pt.title ? { title: pt.title } : {}),
          ...(pt.teamId ? { teamId: pt.teamId } : {}),
          reason: `ticket ${pt.ticketId}'s thread`,
        },
        source: 'ticket',
        reason: `ticket ${pt.ticketId}'s thread`,
      };
    }
    return { kind: 'unresolved', reason: `"${label}" is not a ticket id (TKT-187 or CE-7)`, fix: fixCommand() };
  }

  if (ref.decisionId) {
    const d = await deps.decision(ref.decisionId.trim().toUpperCase());
    if (!d) return { kind: 'unresolved', reason: `there is no decision ${ref.decisionId}`, fix: fixCommand() };
    if (d.asker !== session && d.requestedBy !== session) {
      return { kind: 'unresolved', reason: `decision ${d.id} was not asked by you`, fix: fixCommand() };
    }
    if (d.slackChannelId && d.threadTs) {
      const mapped = deps.conversationOfSlackThread(d.slackChannelId, d.threadTs);
      if (mapped && (await deps.ownsConversation(session, mapped.conversationId))) {
        return { kind: 'conversation', conversationId: mapped.conversationId, thread: formatSlackThreadKey(d.slackChannelId, d.threadTs), source: 'decision', reason: `decision ${d.id}'s thread` };
      }
      return {
        kind: 'work',
        destination: { kind: 'slack', target: d.slackChannelId, threadTs: d.threadTs, reason: `decision ${d.id}'s card thread` },
        source: 'decision',
        reason: `decision ${d.id}'s card thread`,
      };
    }
    if (d.ticket) {
      return {
        kind: 'work',
        destination: { kind: 'ticket-thread', projectPath: d.ticket.projectPath, ticketId: d.ticket.id, ...(d.ticket.title ? { title: d.ticket.title } : {}), ...(d.teamId ? { teamId: d.teamId } : {}), reason: `decision ${d.id}'s ticket thread` },
        source: 'decision',
        reason: `decision ${d.id}'s ticket thread`,
      };
    }
    return null;
  }

  if (ref.workItemId) {
    const wi = await deps.workItem(ref.workItemId);
    if (!wi) return { kind: 'unresolved', reason: `there is no work item ${ref.workItemId}`, fix: fixCommand() };
    return fromWorkItem(wi, 'work-item', deps);
  }
  return null;
}

/**
 * Where a work item's answer goes (its origin / destination). A work item
 * with no recorded origin gives null (continue with the next step).
 *
 * @param wi - Work item
 * @param source - Step label
 * @param deps - Collaborators (clock)
 * @returns Destination or null
 */
function fromWorkItem(wi: WorkItem, source: ReplyDestinationSource, deps: Pick<ReplyResolverDeps, 'now'>): ReplyDestination | null {
  if (!originOfWorkItem(wi)) return null;
  const planned = planWorkDestination({ workItem: wi, now: deps.now() });
  if (planned.kind === 'owner-origin') {
    const o = planned.origin;
    const thread = o.slackThreadKey ?? o.chatThreadId;
    return { kind: 'conversation', conversationId: o.conversationId, ...(thread ? { thread } : {}), source, reason: planned.reason };
  }
  return { kind: 'work', destination: planned, source, reason: planned.reason };
}

/**
 * Validate agent-supplied ids (step 4).
 *
 * @param session - Agent
 * @param hints - Its ids
 * @param origin - Its turn origin (an origin in the same conversation supplies the thread)
 * @param deps - Collaborators
 * @returns The conversation they validly name (or null) and every hint ignored
 */
export async function validateHints(
  session: string,
  hints: ReplyHints,
  origin: TurnOrigin | undefined,
  deps: ReplyResolverDeps,
): Promise<{ destination: ReplyDestination | null; ignored: IgnoredHint[] }> {
  const ignored: IgnoredHint[] = [];
  const conv = hints.conversationId?.trim() || undefined;
  const rawThread = hints.thread?.trim() || undefined;
  const key = parseSlackThreadKey(rawThread);
  const target = hints.slackChannelId?.trim() || undefined;

  if (key) {
    const keyText = formatSlackThreadKey(key.slackChannelId, key.threadTs);
    if (target && target !== key.slackChannelId) {
      ignored.push({ hint: `target ${target}`, why: `thread ${keyText} is in channel ${key.slackChannelId}, not ${target}` });
    }
    if (conv) {
      const convSlack = deps.slackChannelOfConversation(conv);
      if (convSlack === key.slackChannelId && (await deps.ownsConversation(session, conv))) {
        return { destination: { kind: 'conversation', conversationId: conv, thread: keyText, source: 'hint', reason: 'named its conversation and thread' }, ignored };
      }
      ignored.push({
        hint: `conversation ${conv}`,
        why: convSlack === key.slackChannelId ? 'you are not in that conversation' : `thread ${keyText} is not in that conversation (its Slack channel is ${convSlack ?? 'none'})`,
      });
    }
    const mapped = deps.conversationOfSlackThread(key.slackChannelId, key.threadTs);
    if (mapped && (await deps.ownsConversation(session, mapped.conversationId))) {
      return { destination: { kind: 'conversation', conversationId: mapped.conversationId, thread: keyText, source: 'hint', reason: `Slack thread ${keyText} mapped to its conversation` }, ignored };
    }
    ignored.push({ hint: `thread ${keyText}`, why: mapped ? 'you are not in the conversation of that thread' : 'no known conversation has that Slack thread' });
    return { destination: null, ignored };
  }

  if (rawThread) {
    const msg = deps.getMessage(rawThread);
    if (msg && (!conv || msg.channelId === conv) && (await deps.ownsConversation(session, msg.channelId))) {
      return {
        destination: { kind: 'conversation', conversationId: msg.channelId, thread: threadOfMessage(msg, deps.slackChannelOfConversation(msg.channelId)), source: 'hint', reason: 'named a thread in its conversation' },
        ignored,
      };
    }
    ignored.push({ hint: `thread ${rawThread}`, why: !msg ? 'no such message' : msg.channelId !== conv && conv ? `that message is not in conversation ${conv}` : 'you are not in its conversation' });
    // A thread that is ANOTHER conversation's message contradicts the
    // conversation: neither is used. An unknown id only loses the thread.
    if (conv && msg) {
      ignored.push({ hint: `conversation ${conv}`, why: 'its thread is in another conversation' });
      return { destination: null, ignored };
    }
    if (!conv) return { destination: null, ignored };
  }

  if (conv) {
    if (await deps.ownsConversation(session, conv)) {
      const thread = origin?.conversationId === conv ? origin.slackThreadKey ?? origin.chatThreadId : undefined;
      return { destination: { kind: 'conversation', conversationId: conv, ...(thread ? { thread } : {}), source: 'hint', reason: 'named its own conversation' }, ignored };
    }
    ignored.push({ hint: `conversation ${conv}`, why: 'not a conversation you are in' });
  }
  return { destination: null, ignored };
}

/**
 * Decide where an agent's message goes. See module docs for the order.
 *
 * @param input - Agent, references, hints
 * @param deps - Collaborators
 * @returns The destination and the hints that were ignored
 */
export async function resolveReplyDestination(input: ReplyResolveInput, deps: ReplyResolverDeps): Promise<ReplyResolution> {
  const { session } = input;
  const ignoredHints: IgnoredHint[] = [];
  const prompt = deps.promptReference(session);

  // 1–3. Explicit references are authoritative: a wrong one is an error.
  if (hasReference(input.reference)) {
    const d = await resolveReference(session, input.reference, deps);
    if (d) return { destination: d, ignoredHints };
  }

  const origin = deps.turnOrigin(session);

  // 4. Hints the harness can stand behind.
  if (input.hints && (input.hints.conversationId || input.hints.thread)) {
    const v = await validateHints(session, input.hints, origin, deps);
    ignoredHints.push(...v.ignored);
    if (v.destination) return { destination: v.destination, ignoredHints };
  }

  // 5. What the harness last prompted the agent about, unless the owner spoke since.
  if (prompt && (!origin || prompt.at >= origin.receivedAt)) {
    const d = await resolveReference(session, prompt.reference, deps);
    if (d && d.kind !== 'unresolved') return { destination: { ...d, source: 'prompt', reason: `the harness prompted you about it (${d.reason})` } as ReplyDestination, ignoredHints };
  }

  // 6. Turn origin / current work.
  const items = await deps.poolItems().catch(() => [] as WorkItem[]);
  const workItem = currentWorkItemOf(items, session);
  const planned = planWorkDestination({ workItem, ownerOrigin: origin, now: deps.now() });
  if (planned.kind === 'owner-origin') {
    const o = planned.origin;
    const thread = o.slackThreadKey ?? o.chatThreadId;
    const fromOwner = o === origin;
    return {
      destination: { kind: 'conversation', conversationId: o.conversationId, ...(thread ? { thread } : {}), source: fromOwner ? 'turn-origin' : 'current-work', reason: planned.reason },
      ignoredHints,
    };
  }
  const isScheduled = !!workItem && originOfWorkItem(workItem)?.kind === 'trigger';
  if (planned.kind !== 'new-top-level' || isScheduled) {
    return { destination: { kind: 'work', destination: planned, source: 'current-work', reason: planned.reason }, ignoredHints };
  }

  // 7. The owner DM; a team-channel top-level post only when there is none.
  if (!input.noOwnerDm) {
    const dm = await deps.ownerDm(session).catch(() => null);
    if (dm) return { destination: { kind: 'conversation', conversationId: dm, source: 'owner-dm', reason: `${planned.reason} — your DM with the owner` }, ignoredHints };
    return { destination: { kind: 'work', destination: planned, source: 'current-work', reason: `${planned.reason} (no owner DM)` }, ignoredHints };
  }
  return {
    destination: { kind: 'unresolved', reason: planned.reason, fix: fixCommand(prompt?.reference) },
    ignoredHints,
  };
}
