/**
 * Effects of the reply destination resolver
 * (specs/2026-10-02-harness-owned-routing.md): the real collaborators, and
 * delivering a message where the resolver says — or saying exactly why it
 * could not be delivered.
 *
 * @module services/orc/reply-destination.wiring
 */

import { REPLY_ROUTING_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { parseSlackThreadKey } from '../slack/slack-thread-key.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { AgentPromptReferenceService } from './agent-prompt-reference.service.js';
import {
  fixCommand,
  resolveReplyDestination,
  type ReplyDestination,
  type ReplyHints,
  type ReplyReference,
  type ReplyResolution,
  type ReplyResolverDeps,
} from './reply-destination-resolver.js';
import { defaultWorkDestinationDeps, deliverToWorkDestination, type WorkDestinationDeps } from './work-item-destination.wiring.js';
import { currentWorkItemOf, shortTopic, withTopicLine } from './work-item-destination.js';
import { isSlackDm } from './orc-reply-route.service.js';
import { traceOutboundReply } from '../trace/trace-recorder.js';
import { stripTraceMarkers } from '../trace/trace-markers.js';

const logger: ComponentLogger = LoggerService.getInstance().createComponentLogger('ReplyDestination');

/** Delivery into a chat-v2 conversation (chat.controller `deliverAgentReplyToConversation`). */
export type ConversationDeliver = (input: {
  conversationId: string;
  thread?: string;
  agentSession: string;
  content: string;
  interim?: boolean;
  metadata?: Record<string, unknown>;
}) => Promise<string | null>;

/** Collaborators of {@link deliverReply}. */
export interface ReplyDeliveryDeps {
  resolver: ReplyResolverDeps;
  deliverToConversation: ConversationDeliver;
  workDestination: () => Promise<WorkDestinationDeps>;
  /**
   * The reply gate: the answer a different agent already gave to the
   * owner's latest message in this room thread, when it did
   * (specs/2026-10-03-one-responder-per-message.md §2). Omitted: no gate.
   */
  priorRoomAnswer?: (input: { conversationId: string; thread?: string; agentSession: string }) => Promise<{ by: string; excerpt: string } | null>;
}

/** What a delivery did. */
export type ReplyDelivery =
  | {
      ok: true;
      destination: Exclude<ReplyDestination, { kind: 'unresolved' }>;
      messageId?: string;
      conversationId?: string;
      slackChannelId?: string;
      threadTs?: string;
      messageTs?: string;
    }
  | { ok: false; error: string; destination: ReplyDestination; held?: boolean };

/** Input of {@link deliverReply}. */
export interface DeliverReplyInput {
  session: string;
  content: string;
  reference?: ReplyReference;
  hints?: ReplyHints;
  interim?: boolean;
  noOwnerDm?: boolean;
  /** Post even when a colleague already answered the owner here (`--adds-new`) */
  addsNew?: boolean;
}

/**
 * Resolve and deliver an agent's message. Never guesses: a destination that
 * does not take the message is reported as an error with the command to run.
 *
 * When the chosen place refuses the message, only these real places are
 * tried next (each logged), never "the latest thread" or the global current
 * conversation:
 *  - a hint that did not take it → resolution without the hints;
 *  - the current work's owner conversation → a new top-level post in the
 *    team channel, opened with the work's topic;
 *  - the current work's Slack place → the owner's turn origin, else the DM.
 *
 * @param input - Agent, text, references, hints
 * @param deps - Collaborators (default: the real ones)
 * @returns Where it landed, or an English error
 */
export async function deliverReply(input: DeliverReplyInput, deps?: ReplyDeliveryDeps): Promise<ReplyDelivery> {
  // Trace ids are harness plumbing: never shown to the owner.
  const clean = { ...input, content: stripTraceMarkers(input.content) };
  const result = await deliverReplyUntraced(clean, deps);
  traceOutboundReply(clean, result);
  return result;
}

/**
 * {@link deliverReply} without the run-trace record.
 *
 * @param input - Agent, text, references, hints
 * @param deps - Collaborators (default: the real ones)
 * @returns Where it landed, or an English error
 */
async function deliverReplyUntraced(input: DeliverReplyInput, deps?: ReplyDeliveryDeps): Promise<ReplyDelivery> {
  const d = deps ?? (await defaultReplyDeliveryDeps());
  const resolve = async (hints: ReplyHints | undefined) => {
    const resolution = await resolveReplyDestination(
      { session: input.session, ...(input.reference ? { reference: input.reference } : {}), ...(hints ? { hints } : {}), ...(input.noOwnerDm ? { noOwnerDm: true } : {}) },
      d.resolver,
    );
    logResolution(input.session, resolution);
    return resolution.destination;
  };
  const prompt = d.resolver.promptReference(input.session)?.reference;
  let dest = await resolve(input.hints);
  if (dest.kind === 'unresolved') {
    return { ok: false, destination: dest, error: notDelivered(dest.reason, dest.fix) };
  }
  let result = await attempt(input, dest, prompt, d);
  if (result.ok || ('held' in result && result.held)) return result;

  // Work handed over from the owner's DM with another agent (a lead's
  // delegation): this agent's bot cannot post there, so the answer goes to
  // its own DM with the owner, opened with the work's topic (crewly#1083).
  const ownDm = await ownDmInsteadOfOthers(input, dest, d);
  if (ownDm) {
    logger.warn('Destination is another agent\'s DM with the owner — answering in this agent\'s own owner DM', {
      session: input.session,
      from: dest.kind === 'conversation' ? dest.conversationId : undefined,
      to: ownDm.dest.conversationId,
    });
    const viaDm = await attempt({ ...input, content: ownDm.content }, ownDm.dest, prompt, d);
    if (viaDm.ok) return viaDm;
  }

  if (dest.source === 'hint') {
    logger.warn('The conversation the agent named did not take its message — resolving without its ids', { session: input.session, error: result.error });
    dest = await resolve(undefined);
    if (dest.kind === 'unresolved') return { ok: false, destination: dest, error: notDelivered(dest.reason, dest.fix) };
    result = await attempt(input, dest, prompt, d);
    if (result.ok) return result;
  }

  // The current WORK's place refused it (the owner's own turn origin is not
  // swapped for another place: that is an error the agent sees).
  if (dest.source === 'current-work') {
    const fallback = await currentWorkFallback(input.session, dest, d);
    if (fallback) {
      logger.warn('Current work destination did not take the message — trying the next real place', {
        session: input.session,
        from: dest.kind === 'work' ? dest.destination.kind : 'conversation',
        to: fallback.kind === 'work' ? fallback.destination.kind : `conversation ${fallback.conversationId}`,
      });
      const retry = await attempt(input, fallback, prompt, d);
      if (retry.ok) return retry;
    }
  }
  return result;
}

/**
 * The agent's own owner DM, when the destination that refused its message is
 * ANOTHER agent's DM with the owner (work delegated from that DM). The text
 * is opened with `Re: <work title>` so the owner sees what it answers.
 *
 * @param input - Agent, text, references
 * @param failed - The destination that refused
 * @param d - Collaborators
 * @returns The DM destination and the text to post, or null
 */
async function ownDmInsteadOfOthers(
  input: DeliverReplyInput,
  failed: Exclude<ReplyDestination, { kind: 'unresolved' }>,
  d: ReplyDeliveryDeps,
): Promise<{ dest: Extract<ReplyDestination, { kind: 'conversation' }>; content: string } | null> {
  if (failed.kind !== 'conversation') return null;
  const slack = d.resolver.slackChannelOfConversation(failed.conversationId);
  if (!slack || !isSlackDm(slack)) return null;
  if (await d.resolver.ownsConversation(input.session, failed.conversationId).catch(() => true)) return null;
  const dm = await d.resolver.ownerDm(input.session).catch(() => null);
  if (!dm || dm === failed.conversationId) return null;
  const wi = input.reference?.workItemId
    ? await d.resolver.workItem(input.reference.workItemId).catch(() => null)
    : currentWorkItemOf(await d.resolver.poolItems().catch(() => [] as WorkItem[]), input.session);
  const topic = wi ? `Re: ${shortTopic(wi.title)}` : undefined;
  return {
    dest: { kind: 'conversation', conversationId: dm, source: 'owner-dm', reason: 'the owner asked in a DM with another agent — your DM with the owner' },
    content: withTopicLine(topic, input.content),
  };
}

/**
 * The next real place after the current work's destination refused a message.
 *
 * @param session - Agent
 * @param failed - The destination that refused
 * @param d - Collaborators
 * @returns A fallback destination, or null
 */
async function currentWorkFallback(
  session: string,
  failed: Exclude<ReplyDestination, { kind: 'unresolved' }>,
  d: ReplyDeliveryDeps,
): Promise<Exclude<ReplyDestination, { kind: 'unresolved' }> | null> {
  if (failed.kind === 'conversation') {
    const items = await d.resolver.poolItems().catch(() => [] as WorkItem[]);
    const wi = currentWorkItemOf(items, session);
    return {
      kind: 'work',
      destination: { kind: 'new-top-level', ...(wi ? { topic: shortTopic(wi.title) } : {}), reason: `conversation ${failed.conversationId} did not take the reply` },
      source: 'current-work',
      reason: `conversation ${failed.conversationId} did not take the reply — new top-level post`,
    };
  }
  const origin = d.resolver.turnOrigin(session);
  if (origin) {
    const thread = origin.slackThreadKey ?? origin.chatThreadId;
    return { kind: 'conversation', conversationId: origin.conversationId, ...(thread ? { thread } : {}), source: 'turn-origin', reason: 'the work destination did not take the reply — your last owner conversation' };
  }
  const dm = await d.resolver.ownerDm(session).catch(() => null);
  return dm ? { kind: 'conversation', conversationId: dm, source: 'owner-dm', reason: 'the work destination did not take the reply — your DM with the owner' } : null;
}

/**
 * Deliver to one resolved destination.
 *
 * @param input - Agent, text
 * @param dest - Destination
 * @param prompt - The agent's prompt reference (for the error's fix command)
 * @param d - Collaborators
 * @returns Delivery result
 */
async function attempt(
  input: DeliverReplyInput,
  dest: Exclude<ReplyDestination, { kind: 'unresolved' }>,
  prompt: ReplyReference | undefined,
  d: ReplyDeliveryDeps,
): Promise<ReplyDelivery> {
  // A follow-up delivered by naming its ticket is the delivery (open items close it).
  const ticket = dest.source === 'ticket' ? input.reference?.ticket : dest.source === 'prompt' ? prompt?.ticket : undefined;
  const deliversTicket = ticket ? { [REPLY_ROUTING_CONSTANTS.DELIVERS_TICKET_METADATA_KEY]: ticket } : undefined;
  const answeredReference = dest.source === 'prompt' || dest.source === 'ticket' || dest.source === 'decision' || dest.source === 'work-item' || dest.source === 'message';
  if (dest.kind === 'conversation') {
    if (input.interim !== true && input.addsNew !== true && dest.thread && d.priorRoomAnswer) {
      const prior = await d.priorRoomAnswer({ conversationId: dest.conversationId, thread: dest.thread, agentSession: input.session }).catch(() => null);
      if (prior) {
        const { heldReplyMessage } = await import('../slack/room-responder.js');
        logger.info('Agent reply held: a colleague already answered the owner in this room thread', {
          session: input.session,
          conversationId: dest.conversationId,
          answeredBy: prior.by,
        });
        return { ok: false, destination: dest, error: heldReplyMessage(prior), held: true };
      }
    }
    const messageId = await d.deliverToConversation({
      conversationId: dest.conversationId,
      ...(dest.thread ? { thread: dest.thread } : {}),
      agentSession: input.session,
      content: input.content,
      interim: input.interim === true,
      ...(deliversTicket ? { metadata: deliversTicket } : {}),
    });
    if (!messageId) {
      return {
        ok: false,
        destination: dest,
        error: notDelivered(`conversation ${dest.conversationId} (${dest.reason}) did not take it — you may not be a member there`, fixCommand(prompt)),
      };
    }
    if (answeredReference && input.interim !== true) AgentPromptReferenceService.getInstance().clear(input.session);
    return { ok: true, destination: dest, messageId, conversationId: dest.conversationId };
  }
  try {
    const wd = await d.workDestination();
    const posted = await deliverToWorkDestination(input.session, dest.destination, input.content, wd);
    if (!posted) {
      return { ok: false, destination: dest, error: notDelivered(`${dest.reason}: there is no Slack channel to post in`, fixCommand(prompt)) };
    }
    if (answeredReference && input.interim !== true) AgentPromptReferenceService.getInstance().clear(input.session);
    return {
      ok: true,
      destination: dest,
      slackChannelId: posted.slackChannelId,
      messageTs: posted.messageTs,
      ...(posted.threadTs ? { threadTs: posted.threadTs } : {}),
    };
  } catch (err) {
    return { ok: false, destination: dest, error: notDelivered(`posting to Slack failed (${err instanceof Error ? err.message : String(err)})`, fixCommand(prompt)) };
  }
}

/**
 * The Slack place (channel + thread) the resolver gives, without posting —
 * for files and the `[DONE]` notice. Ticket threads that do not exist yet
 * yield their team channel only.
 *
 * @param input - Agent, references, hints
 * @param deps - Collaborators (default: the real ones)
 * @returns The place, or null (not a Slack place / unresolved)
 */
export async function resolveSlackPlace(
  input: Omit<DeliverReplyInput, 'content' | 'interim'>,
  deps?: ReplyDeliveryDeps,
): Promise<{ slackChannelId: string; threadTs?: string; topic?: string; conversationId?: string; destination: ReplyDestination } | null> {
  const d = deps ?? (await defaultReplyDeliveryDeps());
  const resolution = await resolveReplyDestination(
    { session: input.session, ...(input.reference ? { reference: input.reference } : {}), ...(input.hints ? { hints: input.hints } : {}), ...(input.noOwnerDm ? { noOwnerDm: true } : {}) },
    d.resolver,
  );
  logResolution(input.session, resolution);
  const dest = resolution.destination;
  if (dest.kind === 'unresolved') return null;
  if (dest.kind === 'conversation') {
    const key = parseSlackThreadKey(dest.thread);
    if (key) return { slackChannelId: key.slackChannelId, threadTs: key.threadTs, conversationId: dest.conversationId, destination: dest };
    const channel = d.resolver.slackChannelOfConversation(dest.conversationId);
    if (!channel) return null;
    if (dest.thread) {
      const root = d.resolver.getMessage(dest.thread);
      const ts = typeof root?.metadata?.slackThreadTs === 'string' ? (root.metadata.slackThreadTs as string) : undefined;
      if (ts) return { slackChannelId: channel, threadTs: ts, conversationId: dest.conversationId, destination: dest };
    }
    return { slackChannelId: channel, conversationId: dest.conversationId, destination: dest };
  }
  const wd = await d.workDestination();
  const w = dest.destination;
  switch (w.kind) {
    case 'slack': {
      const id = w.target.startsWith('#') ? await wd.findChannelId?.(w.target.slice(1)).catch(() => null) : w.target;
      if (!id) return null;
      return w.threadTs ? { slackChannelId: id, threadTs: w.threadTs, destination: dest } : { slackChannelId: id, ...(w.topic ? { topic: w.topic } : {}), destination: dest };
    }
    case 'ticket-thread': {
      const existing = await wd.ticketThreads()?.get(w.projectPath, w.ticketId);
      if (existing) return { slackChannelId: existing.slackChannelId, threadTs: existing.threadTs, destination: dest };
      const info = await wd.ticketInfo(w.projectPath, w.ticketId).catch(() => null);
      const channel = await wd.teamChannelOf(input.session, w.teamId ?? info?.team ?? null);
      return channel ? { slackChannelId: channel.slackChannelId, topic: `${w.ticketId}${info?.title ? ` · ${info.title}` : ''}`, destination: dest } : null;
    }
    case 'new-top-level': {
      const channel = await wd.teamChannelOf(input.session, w.teamId ?? null);
      return channel ? { slackChannelId: channel.slackChannelId, ...(w.topic ? { topic: w.topic } : {}), destination: dest } : null;
    }
  }
}

/**
 * The English error an agent gets for an undelivered message.
 *
 * @param why - What went wrong
 * @param fix - Command to run
 * @returns Error text
 */
export function notDelivered(why: string, fix: string): string {
  return `Your message was NOT delivered: ${why}. Run: ${fix}`;
}

/**
 * Log the decision; ignored hints at warn (an agent passed ids the harness overrode).
 *
 * @param session - Agent
 * @param r - Resolution
 */
function logResolution(session: string, r: ReplyResolution): void {
  const d = r.destination;
  if (r.ignoredHints.length > 0) {
    logger.warn('Agent-supplied ids ignored — they do not name a conversation the agent is in', { session, ignored: r.ignoredHints });
  }
  logger.info('Reply destination resolved', {
    session,
    kind: d.kind,
    ...(d.kind === 'conversation' ? { conversationId: d.conversationId, thread: d.thread } : {}),
    ...(d.kind === 'work' ? { work: d.destination.kind } : {}),
    ...(d.kind !== 'unresolved' ? { source: d.source } : {}),
    reason: d.reason,
  });
}

/**
 * The real collaborators (lazy imports keep this module light for tests).
 *
 * @returns Deps
 */
export async function defaultReplyDeliveryDeps(): Promise<ReplyDeliveryDeps> {
  const [{ getChatV2Service }, { getSlackTeamChannelService }, { getSlackAgentDmService }, { TaskPoolService }, { OrcReplyRouteService }, { RequestService }, { slackPlaceOf }, { DecisionService }, { ProjectTicketService }] =
    await Promise.all([
      import('../chat-v2/chat-v2.singleton.js'),
      import('../slack/slack-team-channel.service.js'),
      import('../slack/slack-agent-dm.service.js'),
      import('../task-pool/task-pool.service.js'),
      import('./orc-reply-route.service.js'),
      import('../v3/request.service.js'),
      import('../open-items/open-items.service.js'),
      import('../decisions/decision.service.js'),
      import('../project-tickets/project-ticket.service.js'),
    ]);
  const { getOwnerMessageWatchdog } = await import('../messaging/owner-message-watchdog.service.js');
  const { SLACK_AGENT_DM_CONSTANTS } = await import('../../constants.js');
  const chat = () => {
    try {
      return getChatV2Service();
    } catch {
      return null;
    }
  };
  const pool = () => TaskPoolService.getInstance().getAllItems().catch(() => [] as WorkItem[]);
  const resolver: ReplyResolverDeps = {
    getMessage: (id) => {
      const m = chat()?.getMessageForBridge(id);
      return m ? { id: m.id, channelId: m.channelId, ...(m.threadId ? { threadId: m.threadId } : {}), ...(m.metadata ? { metadata: m.metadata as Record<string, unknown> } : {}) } : null;
    },
    ownsConversation: async (session, conversationId) => {
      const c = chat();
      if (!c) return false;
      const channel = c.getChannelForBridge(conversationId);
      if (!channel || channel.archivedAt) return false;
      if (channel.type === 'dm') return channel.agentSession === session;
      return c.queryHuddleMembersForDispatch(conversationId).includes(session);
    },
    slackChannelOfConversation: (conversationId) =>
      getSlackTeamChannelService()?.findByChatChannelId(conversationId)?.slackChannelId ??
      getSlackAgentDmService()?.findByChatChannelId(conversationId)?.slackChannelId ??
      null,
    conversationOfSlackThread: (slackChannelId, threadTs) => {
      const mapping = getSlackTeamChannelService()?.findBySlackChannelId(slackChannelId);
      if (mapping) {
        const root = chat()?.findSlackThreadRoot(mapping.chatChannelId, threadTs);
        return { conversationId: mapping.chatChannelId, ...(root ? { threadRootId: root.id } : {}) };
      }
      const link = getSlackAgentDmService()?.findBySlackChannelId(slackChannelId);
      return link ? { conversationId: link.chatChannelId } : null;
    },
    requestTicket: async (n) => {
      const all = await RequestService.getInstance().listAll().catch(() => []);
      const r = all.find((x) => x.ticketNumber === n);
      if (!r) return null;
      const place = slackPlaceOf(r);
      const { formatTicketNumber } = await import('../../types/v2/ticket.types.js');
      return {
        id: r.id,
        label: formatTicketNumber(n),
        ...(r.chatRef ? { conversationId: r.chatRef.channelId, threadRootId: r.chatRef.threadRootId } : {}),
        ...(place ? { slackChannelId: place.slackChannelId, threadTs: place.threadTs } : {}),
      };
    },
    projectTicket: async (session, ticketId) => {
      const items = await pool();
      const linked = items
        .filter((w) => {
          const link = (w.metadata ?? {}).projectTicket as { id?: unknown; projectPath?: unknown } | undefined;
          return link?.id === ticketId && typeof link.projectPath === 'string';
        })
        .sort((a, b) => Number(b.target === session) - Number(a.target === session));
      const link = linked[0]?.metadata?.projectTicket as { projectPath: string } | undefined;
      if (!link) return null;
      const t = await ProjectTicketService.getInstance().get(link.projectPath, ticketId).catch(() => null);
      return { projectPath: link.projectPath, ticketId, ...(t?.title ? { title: t.title } : {}) };
    },
    decision: async (id) => {
      const d = await DecisionService.getInstance()?.get(id).catch(() => null);
      if (!d) return null;
      return {
        id: d.id,
        asker: d.asker,
        requestedBy: d.requestedBy,
        ...(d.card ? { slackChannelId: d.card.slackChannelId, threadTs: d.card.threadTs ?? d.card.messageTs } : {}),
        ...(d.ticket ? { ticket: { projectPath: d.ticket.projectPath, id: d.ticket.id, title: d.ticket.title } } : {}),
        ...(d.teamId ? { teamId: d.teamId } : {}),
      };
    },
    workItem: async (id) => (await pool()).find((w) => w.id === id) ?? null,
    poolItems: pool,
    turnOrigin: (session) => OrcReplyRouteService.getInstance().getLastOrigin(session),
    promptReference: (session) => AgentPromptReferenceService.getInstance().get(session),
    owesOwner: (session) => (getOwnerMessageWatchdog()?.owedBy(session).length ?? 0) > 0,
    lastDelivered: (session) => OrcReplyRouteService.getInstance().getLastDelivered(session),
    ownerDm: async (session) => {
      const link = getSlackAgentDmService()?.findByAgentSession(session);
      if (link) return link.chatChannelId;
      const c = chat();
      if (!c) return null;
      // Only a real team member gets a DM — never one made up for an unknown name.
      const { StorageService } = await import('../core/storage.service.js');
      const teams = await StorageService.getInstance().getTeams().catch(() => []);
      if (!teams.some((t) => (t.members ?? []).some((m) => m.sessionName === session))) return null;
      const { channel } = c.ensureDmChannel({ agentSession: session, principal: { userId: SLACK_AGENT_DM_CONSTANTS.OWNER_USER_ID, source: 'oss' } });
      return channel.id;
    },
    now: () => Date.now(),
  };
  const { deliverAgentReplyToConversation } = await import('../../controllers/chat/chat.controller.js');
  return {
    resolver,
    deliverToConversation: deliverAgentReplyToConversation,
    workDestination: defaultWorkDestinationDeps,
    priorRoomAnswer: async (input) => {
      const { getSlackTeamChannelService } = await import('../slack/slack-team-channel.service.js');
      return (await getSlackTeamChannelService()?.heldReplyFor(input)) ?? null;
    },
  };
}
