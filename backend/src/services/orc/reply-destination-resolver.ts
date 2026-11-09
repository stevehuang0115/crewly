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
 *  5. the sender of the agent's latest input, when that was another
 *     agent's message (crewly#1375) — never the owner's last thread;
 *  6. the reference the harness last prompted the agent about, when newer
 *     than its last owner turn;
 *  7. the route of the input the agent is answering (message-route.ts): the
 *     owner message it was given last (its turn origin), the route a
 *     delegated result carries back, or the work item a dispatch handed
 *     over; with no such input, the agent's one live work item.
 *
 * Nothing else. There is no guess (message-routing audit 2026-10-18, R2):
 * not the newest owner turn when the input was something else, not the
 * newest of several work items, not the owner DM, not a channel's top
 * level. When nothing names the destination the reply is refused with the
 * ids that would work.
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
import type { TurnTrigger } from '../trace/turn-trigger.js';
import { hasReference, type PromptReference, type ReplyReference } from './agent-prompt-reference.service.js';
import { leadReportOf, originOfWorkItem, planWorkDestination, type WorkDestination } from './work-item-destination.js';
import { describeRoute, replyCommandFor, type MessageRoute } from './message-route.js';

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
  | 'agent-message'
  | 'turn-origin'
  | 'current-work'
  | 'route'
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

/**
 * The agent's latest input, as far as routing cares: the owner, another
 * agent (with its session), a harness dispatch of work, or anything else.
 */
export interface LatestInput {
  kind: 'owner' | 'agent' | 'dispatch' | 'result' | 'other';
  /** Sending agent, for `agent` and `result` */
  sender?: string;
  /** When it was delivered (epoch ms) */
  at: number;
  /** Conversation of an owner message */
  conversationId?: string;
  /** Slack thread key of an owner message, when it named one */
  thread?: string;
  /** The work item a dispatch hands over, or a result is about */
  workItemId?: string;
  /** The route an agent message or a result carries (what the chain answers) */
  route?: MessageRoute;
}

/**
 * What the resolver needs to know about an agent's latest input, from its
 * turn trigger.
 *
 * @param trigger - The session's current turn trigger, or null
 * @returns The latest input, or null when unknown
 */
export function latestInputOf(trigger: TurnTrigger | null): LatestInput | null {
  if (!trigger) return null;
  const route = trigger.route ? { route: trigger.route } : {};
  switch (trigger.triggerKind) {
    case 'owner_message':
      return { kind: 'owner', at: trigger.at, ...(trigger.conversationId ? { conversationId: trigger.conversationId } : {}), ...(trigger.thread ? { thread: trigger.thread } : {}) };
    case 'agent_message':
      return trigger.sender ? { kind: 'agent', sender: trigger.sender, at: trigger.at, ...route } : { kind: 'other', at: trigger.at };
    case 'delegated_result':
      return { kind: 'result', at: trigger.at, ...(trigger.sender ? { sender: trigger.sender } : {}), ...(trigger.workItemId ? { workItemId: trigger.workItemId } : {}), ...route };
    // New work the harness handed over; a reminder or a redelivery nag is not.
    case 'dispatch':
    case 'scheduled':
      return { kind: 'dispatch', at: trigger.at, ...(trigger.workItemId ? { workItemId: trigger.workItemId } : {}) };
    default:
      return { kind: 'other', at: trigger.at };
  }
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
  /**
   * Whether the agent has open work delegated INTO this Slack thread (a lead's
   * `delegate-task --thread`): such an agent may answer there under its own
   * name although it is not a member of the thread's conversation (#1109).
   */
  delegatedThread?(session: string, slackChannelId: string, threadTs: string): Promise<boolean>;
  /** Whether the agent owes the owner an answer (owner-message watchdog) */
  owesOwner(session: string): boolean;
  /** Head of the last message delivered to the agent */
  lastDelivered(session: string): string | undefined;
  /** The agent's owner DM conversation (chat-v2), or null */
  ownerDm(session: string): Promise<string | null>;
  /**
   * Conversations of owner messages shown to the agent mid-turn (at a tool
   * boundary) that it has not answered yet. A bare reply could be meant for
   * any of them or for the turn origin, so it is not guessed.
   */
  surfacedOwnerConversations?(session: string): string[];
  /**
   * The agent's latest input (turn-trigger tracker). A bare reply after
   * another agent's message goes back to that agent; an owner turn origin
   * older than a dispatch is not guessed (crewly#1375). Omitted: unknown.
   */
  latestInput?(session: string): LatestInput | null;
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
  return 'reply "<your message>"';
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
    // Work delegated into this thread: the delegate answers there itself.
    if (await deps.delegatedThread?.(session, key.slackChannelId, key.threadTs).catch(() => false)) {
      const reason = `Slack thread ${keyText} was delegated to you`;
      return {
        destination: { kind: 'work', destination: { kind: 'slack', target: key.slackChannelId, threadTs: key.threadTs, reason }, source: 'hint', reason },
        ignored,
      };
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
    // Work delegated into this thread (the delegate is not in the room): the
    // thread named by its chat id is the same Slack thread as its key (#1109).
    if (msg && (!conv || msg.channelId === conv)) {
      const delegated = await delegatedSlackThread(session, parseSlackThreadKey(threadOfMessage(msg, deps.slackChannelOfConversation(msg.channelId))), deps);
      if (delegated) return { destination: delegated, ignored };
    }
    ignored.push({ hint: `thread ${rawThread}`, why: !msg ? 'no such message' : msg.channelId !== conv && conv ? `that message is not in conversation ${conv}` : 'you are not in its conversation' });
    // A thread that is ANOTHER conversation's message contradicts the
    // conversation: neither is used. An unknown id only loses the thread.
    if (conv && msg) {
      ignored.push({ hint: `conversation ${conv}`, why: msg.channelId === conv ? 'you are not in that conversation' : 'its thread is in another conversation' });
      return { destination: null, ignored };
    }
    if (!conv) return { destination: null, ignored };
  }

  if (conv) {
    if (await deps.ownsConversation(session, conv)) {
      // The thread comes only from the owner message the agent is answering
      // (`origin` is passed only then), never from its last owner thread in
      // that conversation (message-routing audit 2026-10-18, R2).
      const thread = origin?.conversationId === conv ? origin.slackThreadKey ?? origin.chatThreadId : undefined;
      if (!thread && needsThread(deps.slackChannelOfConversation(conv))) {
        ignored.push({ hint: `conversation ${conv}`, why: 'it is a Slack channel, no usable thread was named, and the message you are answering is not in it; name the thread with --thread <[SLACK-THREAD:…] key or message id>' });
        return { destination: null, ignored };
      }
      return { destination: { kind: 'conversation', conversationId: conv, ...(thread ? { thread } : {}), source: 'hint', reason: thread ? 'named the conversation of the owner message it answers' : 'named its own conversation' }, ignored };
    }
    // Not in the room, but the current work was delegated into one of its
    // Slack threads: that thread, never the room's top level (2026-10-18:
    // Kai's PDF for Steve's #daily-info thread was posted top level).
    const workThread = await currentWorkThreadIn(session, conv, deps);
    const delegated = await delegatedSlackThread(session, workThread, deps);
    if (delegated) return { destination: delegated, ignored };
    ignored.push({ hint: `conversation ${conv}`, why: 'not a conversation you are in' });
  }
  return { destination: null, ignored };
}

/**
 * The Slack thread a non-member may post in because its open work was
 * delegated into it (#1109), as a destination.
 *
 * @param session - Agent
 * @param key - The thread, if known
 * @param deps - Collaborators
 * @returns The Slack destination, or null when the thread was not delegated to the agent
 */
async function delegatedSlackThread(
  session: string,
  key: { slackChannelId: string; threadTs: string } | null,
  deps: ReplyResolverDeps,
): Promise<ReplyDestination | null> {
  if (!key || !deps.delegatedThread) return null;
  if (!(await deps.delegatedThread(session, key.slackChannelId, key.threadTs).catch(() => false))) return null;
  const keyText = formatSlackThreadKey(key.slackChannelId, key.threadTs);
  const reason = `Slack thread ${keyText} was delegated to you`;
  return { kind: 'work', destination: { kind: 'slack', target: key.slackChannelId, threadTs: key.threadTs, reason }, source: 'hint', reason };
}

/**
 * The Slack thread of a conversation the agent's open work came from (an
 * owner origin in that conversation with a Slack thread). Only when that is
 * ONE thread: with two pieces of work from different threads of the room,
 * the newest is not a safe guess, and the caller fails loudly instead.
 *
 * @param session - Agent
 * @param conversationId - chat-v2 conversation
 * @param deps - Collaborators
 * @returns The thread, or null when there is none or more than one
 */
async function currentWorkThreadIn(session: string, conversationId: string, deps: ReplyResolverDeps): Promise<{ slackChannelId: string; threadTs: string } | null> {
  const items = await deps.poolItems().catch(() => [] as WorkItem[]);
  const threads = new Map<string, { slackChannelId: string; threadTs: string }>();
  for (const wi of items) {
    if (wi.target !== session || !OPEN_WORK_STATUSES.has(wi.status)) continue;
    const origin = originOfWorkItem(wi);
    if (origin?.kind !== 'owner' || origin.conversationId !== conversationId || !origin.slackChannelId || !origin.threadTs) continue;
    threads.set(formatSlackThreadKey(origin.slackChannelId, origin.threadTs), { slackChannelId: origin.slackChannelId, threadTs: origin.threadTs });
  }
  return threads.size === 1 ? [...threads.values()][0] : null;
}

/** Work an agent still owes an answer for. */
const OPEN_WORK_STATUSES: ReadonlySet<WorkItem['status']> = new Set<WorkItem['status']>(['queued', 'proposed', 'accepted', 'running', 'blocked', 'escalated']);

/**
 * Whether a post into a conversation must name a thread: a Slack channel
 * (not a DM). A chat-only conversation or a Slack DM takes a post at its
 * top level.
 *
 * @param slackChannelId - The conversation's Slack channel, or null
 * @returns True for a Slack channel
 */
function needsThread(slackChannelId: string | null): boolean {
  return !!slackChannelId && /^[CG]/.test(slackChannelId);
}

/**
 * Whether a prompt reference may steer a bare reply: the agent owes the
 * owner nothing, and the last message delivered to it is that prompt.
 *
 * @param session - Agent
 * @param prompt - Its prompt reference
 * @param deps - Collaborators
 * @returns True to use it
 */
export function promptIsCurrent(session: string, prompt: PromptReference, deps: Pick<ReplyResolverDeps, 'owesOwner' | 'lastDelivered'>): boolean {
  if (!prompt.marker) return false;
  if (deps.owesOwner(session)) return false;
  return (deps.lastDelivered(session) ?? '').includes(prompt.marker);
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
  const latest = deps.latestInput?.(session) ?? null;
  // The owner message the agent is answering: its turn origin, only while
  // that message is the latest input naming what the agent answers.
  const answered = answeredOwnerOrigin(origin, latest);

  // 4. Hints the harness can stand behind.
  if (input.hints && (input.hints.conversationId || input.hints.thread)) {
    const v = await validateHints(session, input.hints, answered, deps);
    ignoredHints.push(...v.ignored);
    if (v.destination) return { destination: v.destination, ignoredHints };
    // An explicit --thread / --conversation that names nothing this agent may
    // post in fails loudly: it is never swapped for a guessed place (#1136).
    return {
      destination: {
        kind: 'unresolved',
        reason: `the ${v.ignored.length > 0 ? v.ignored.map((i) => `${i.hint} was not used: ${i.why}`).join('; ') : 'conversation / thread you named cannot be used'}`,
        fix: 'reply "<your message>" (to answer where your current work came from), or ask your team lead to post it in that thread',
      },
      ignoredHints,
    };
  }

  // 5. The latest input was another agent's message: the answer goes back to
  // that agent (agent-to-agent), never into the owner's last thread
  // (crewly#1375: Pia's answer to Atlas landed in the owner's video thread).
  if (latest?.kind === 'agent' && latest.sender && latest.sender !== session) {
    return { destination: await answerToAgent(session, latest, origin, deps), ignoredHints };
  }

  // 6. What the harness last prompted the agent about — only when the agent
  // owes the owner nothing and that prompt is the last thing it was given:
  // a bare answer to a 10:00 owner question must not land in the thread of
  // a 10:02 TKT-150 nudge (and close its promise).
  if (prompt && promptIsCurrent(session, prompt, deps)) {
    const d = await resolveReference(session, prompt.reference, deps);
    if (d && d.kind !== 'unresolved') return { destination: { ...d, source: 'prompt', reason: `the harness prompted you about it (${d.reason})` } as ReplyDestination, ignoredHints };
  }

  // 7. The route of the input being answered. An owner message from another
  // conversation shown mid-turn makes even that unsafe: the answer to it
  // landed in the turn origin's thread (Ella, 2026-10-06).
  const routed = await fromLatestInput(input, deps, origin, answered, latest);
  const pending = deps.surfacedOwnerConversations?.(session) ?? [];
  const routedConv = routed.kind === 'conversation' ? routed.conversationId : undefined;
  const others = [...new Set(pending.filter((c) => c !== routedConv))];
  if (others.length > 0 && routed.kind !== 'unresolved') {
    const options = [...(routedConv ? [routedConv] : []), ...others];
    return {
      destination: {
        kind: 'unresolved',
        reason: `more than one owner conversation is waiting on you (${options.join(', ')}) — say which one this reply is for`,
        fix: `reply --conversation ${others[0]} --thread <its thread> "<your message>"  (or ${answered ? `--conversation ${answered.conversationId}${answered.slackThreadKey ?? answered.chatThreadId ? ` --thread ${answered.slackThreadKey ?? answered.chatThreadId}` : ''}` : '--conversation <id> --thread <thread>'} for the message your turn started with)`,
      },
      ignoredHints,
    };
  }
  return { destination: routed, ignoredHints };
}

/**
 * The owner's turn origin, when the owner message behind it is the latest
 * input that names what the agent answers. Otherwise the origin is just
 * "the agent's last owner thread", which says nothing about this reply.
 *
 * @param origin - The agent's turn origin
 * @param latest - Its latest routed input
 * @returns The origin, or undefined
 */
export function answeredOwnerOrigin(origin: TurnOrigin | undefined, latest: LatestInput | null): TurnOrigin | undefined {
  if (!origin || latest?.kind !== 'owner') return undefined;
  if (latest.conversationId && latest.conversationId !== origin.conversationId) return undefined;
  return origin;
}

/**
 * Whether a route is the replying agent's own: an owner conversation it is in,
 * or a work item targeted at it. A message from another agent that carries
 * such a route is about the replier's own request, so a bare reply could be
 * meant for that agent or for the owner.
 *
 * @param session - Replying agent
 * @param route - The route the message carries
 * @param deps - Collaborators
 * @returns True when the route is the replier's
 */
async function isOwnRoute(session: string, route: MessageRoute, deps: ReplyResolverDeps): Promise<boolean> {
  if (route.kind === 'owner') return deps.ownsConversation(session, route.conversationId).catch(() => false);
  const wi = await deps.workItem(route.workItemId).catch(() => null);
  return wi?.target === session;
}

/**
 * Step 5 of {@link resolveReplyDestination}: the answer to another agent's
 * message goes back to that agent — unless the agent also owes the owner an
 * answer, holds work whose answer goes elsewhere, or the message is about the
 * agent's own request (its route): then a bare reply could mean either, and
 * the agent is told to name it.
 *
 * @param session - Replying agent
 * @param latest - The other agent's message (the latest input)
 * @param origin - The replying agent's owner turn origin, if any
 * @param deps - Collaborators
 * @returns The sender as destination, or `unresolved` with both commands
 */
async function answerToAgent(
  session: string,
  latest: LatestInput,
  origin: TurnOrigin | undefined,
  deps: ReplyResolverDeps,
): Promise<ReplyDestination> {
  const sender = latest.sender as string;
  const toAgent = `send-message --to ${sender} "<your answer>"  (to answer ${sender})`;
  const ownRoute = latest.route && (await isOwnRoute(session, latest.route, deps)) ? latest.route : undefined;
  if (ownRoute) {
    return {
      kind: 'unresolved',
      reason: `your latest message is from ${sender} (another agent) about ${describeRoute(ownRoute)}, which you answer — say whether this reply is for ${sender} or for the owner`,
      fix: `${toAgent}, or ${replyCommandFor(ownRoute)}  (the consolidated answer for the owner)`,
    };
  }
  const forOwner = origin
    ? `reply --conversation ${origin.conversationId}${origin.slackThreadKey ?? origin.chatThreadId ? ` --thread ${origin.slackThreadKey ?? origin.chatThreadId}` : ''} "<message>"`
    : 'reply --to <message id from the owner\'s message> "<message>"';
  const pendingOwner = deps.owesOwner(session) || (deps.surfacedOwnerConversations?.(session) ?? []).length > 0;
  if (pendingOwner) {
    return {
      kind: 'unresolved',
      reason: `your latest message is from ${sender} (another agent, not the owner), and you also owe the owner an answer — say which one this reply is for`,
      fix: `${toAgent}, or ${forOwner}  (to answer the owner)`,
    };
  }
  const items = await deps.poolItems().catch(() => [] as WorkItem[]);
  for (const workItem of liveItemsOf(items, session)) {
    if (!originOfWorkItem(workItem)) continue;
    const planned = planWorkDestination({ workItem, now: deps.now() });
    if (!(planned.kind === 'agent' && planned.sessionName === sender)) {
      return {
        kind: 'unresolved',
        reason: `your latest message is from ${sender} (another agent), but you are also on work item ${workItem.id} whose answer goes elsewhere — say which one this reply is for`,
        fix: `${toAgent}, or reply --work-item ${workItem.id} "<message>"  (for the work item)`,
      };
    }
  }
  const reason = `answering ${sender}'s message (another agent, not the owner)`;
  return { kind: 'work', destination: { kind: 'agent', sessionName: sender, reason }, source: 'agent-message', reason };
}

/** Statuses in which a work item is live work of its target. */
const LIVE_STATUSES: ReadonlySet<WorkItem['status']> = new Set<WorkItem['status']>(['running', 'accepted']);

/**
 * The agent's live work items (running / accepted), oldest first.
 *
 * @param items - Pool items
 * @param session - Agent
 * @returns Its live items
 */
export function liveItemsOf(items: readonly WorkItem[], session: string): WorkItem[] {
  return items
    .filter((w) => w.target === session && LIVE_STATUSES.has(w.status))
    .sort((a, b) => (Date.parse(a.startedAt ?? a.createdAt) || 0) - (Date.parse(b.startedAt ?? b.createdAt) || 0));
}

/**
 * Where a work item's answer goes, refusing the places that are not a
 * destination it names: a work item with no origin, or an owner origin with
 * no place, is not posted at a channel's top level.
 *
 * @param wi - Work item
 * @param session - Replying agent
 * @param deps - Collaborators
 * @returns The destination, or `unresolved`
 */
function destinationOfWorkItem(wi: WorkItem, session: string, deps: Pick<ReplyResolverDeps, 'now'>): ReplyDestination {
  const noPlace: ReplyDestination = {
    kind: 'unresolved',
    reason: `work item ${wi.id} names no conversation or thread to answer in`,
    fix: 'reply --to <owner message id> "<message>", or reply --conversation <id> --thread <thread> "<message>"',
  };
  const origin = originOfWorkItem(wi);
  if (!origin) return noPlace;
  const planned = planWorkDestination({ workItem: wi, now: deps.now() });
  if (planned.kind === 'owner-origin') {
    const o = planned.origin;
    const thread = o.slackThreadKey ?? o.chatThreadId;
    return { kind: 'conversation', conversationId: o.conversationId, ...(thread ? { thread } : {}), source: 'current-work', reason: planned.reason };
  }
  if (planned.kind === 'agent' && planned.sessionName === session) return noPlace;
  // A top-level post only for work whose origin says so: a scheduled task, or
  // team work its lead reports in the team channel (crewly#1371).
  if (planned.kind === 'new-top-level' && origin.kind !== 'trigger' && !leadReportOf(wi)) return noPlace;
  return { kind: 'work', destination: planned, source: 'current-work', reason: planned.reason };
}

/**
 * Where a route goes.
 *
 * @param session - Replying agent
 * @param route - The route
 * @param deps - Collaborators
 * @returns The destination (source `route`), or `unresolved`
 */
export async function resolveRoute(session: string, route: MessageRoute, deps: ReplyResolverDeps): Promise<ReplyDestination> {
  if (route.kind === 'work-item') {
    const wi = await deps.workItem(route.workItemId).catch(() => null);
    if (!wi) return { kind: 'unresolved', reason: `there is no work item ${route.workItemId}`, fix: 'reply --to <owner message id> "<message>"' };
    const d = destinationOfWorkItem(wi, session, deps);
    return d.kind === 'unresolved' ? d : ({ ...d, source: 'route', reason: `the request this answers (${describeRoute(route)}): ${d.reason}` } as ReplyDestination);
  }
  const v = await validateHints(session, { conversationId: route.conversationId, ...(route.thread ? { thread: route.thread } : {}) }, undefined, deps);
  if (v.destination) return { ...v.destination, source: 'route', reason: `the request this answers (${describeRoute(route)})` } as ReplyDestination;
  return {
    kind: 'unresolved',
    reason: `the request this answers is ${describeRoute(route)}, and you cannot post there (${v.ignored.map((i) => `${i.hint}: ${i.why}`).join('; ') || 'not a conversation you are in'})`,
    fix: 'send the answer to the agent who asked you (send-message --to <agent>), so it answers the owner',
  };
}

/**
 * Step 7 of {@link resolveReplyDestination}: the route of the latest input
 * that names what the agent answers. Never a guess: when that input names no
 * place, the agent is told which ids would work.
 *
 * @param input - Agent
 * @param deps - Collaborators
 * @param origin - Its turn origin
 * @param answered - Its turn origin when the owner message behind it is the input answered
 * @param latest - Its latest routed input
 * @returns The destination, or `unresolved`
 */
async function fromLatestInput(
  input: ReplyResolveInput,
  deps: ReplyResolverDeps,
  origin: TurnOrigin | undefined,
  answered: TurnOrigin | undefined,
  latest: LatestInput | null,
): Promise<ReplyDestination> {
  const { session } = input;
  const items = await deps.poolItems().catch(() => [] as WorkItem[]);
  const live = liveItemsOf(items, session);
  const options = [
    ...live.map((w) => `reply --work-item ${w.id} "<message>"  (${JSON.stringify(w.title.slice(0, 60))})`),
    ...(origin ? [`reply --conversation ${origin.conversationId}${origin.slackThreadKey ?? origin.chatThreadId ? ` --thread ${origin.slackThreadKey ?? origin.chatThreadId}` : ''} "<message>"  (the owner's last message to you)`] : []),
  ];
  const refuse = (reason: string): ReplyDestination => ({
    kind: 'unresolved',
    reason,
    fix: options.length > 0 ? options.join('; or ') : 'reply --to <message id from your prompt> "<message>" (or --work-item <id> / --ticket <id>)',
  });

  if (latest?.kind === 'owner') {
    if (!answered) return refuse('Crewly does not know which thread the owner message you are answering is in');
    const thread = answered.slackThreadKey ?? answered.chatThreadId;
    return { kind: 'conversation', conversationId: answered.conversationId, ...(thread ? { thread } : {}), source: 'turn-origin', reason: 'answering the owner message you were given last' };
  }

  if (latest?.kind === 'result') {
    const sender = latest.sender ?? 'your delegate';
    if (!latest.route) {
      return refuse(`your latest message is ${sender}'s result for work you delegated, and nothing names where the answer goes (you delegated it while answering no owner message or work item)`);
    }
    return resolveRoute(session, latest.route, deps);
  }

  if (latest?.kind === 'dispatch' && latest.workItemId) {
    const wi = await deps.workItem(latest.workItemId).catch(() => null);
    if (!wi) return refuse(`the work item you were handed (${latest.workItemId}) is not in the pool`);
    // An owner message delivered before the dispatch is still unanswered:
    // a bare reply could be for either (crewly#1375).
    if (origin && origin.receivedAt < latest.at && deps.owesOwner(session)) {
      return refuse(`a dispatch came in after the owner's message in conversation ${origin.conversationId}, and you still owe the owner an answer — say which one this reply is for`);
    }
    return destinationOfWorkItem(wi, session, deps);
  }

  // Nothing names what this reply answers: only the agent's ONE live work
  // item is unambiguous. Several are never resolved to the newest.
  if (live.length === 1) return destinationOfWorkItem(live[0], session, deps);
  if (live.length > 1) return refuse(`you have ${live.length} live work items and your latest input names none of them — say which one this reply is for`);
  return refuse('nothing you were given names where this reply goes (no owner message, work item or agent message you are answering)');
}
