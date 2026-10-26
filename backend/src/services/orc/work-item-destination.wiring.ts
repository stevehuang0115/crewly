/**
 * Effects of the work-item destination plan (specs/2026-10-01-decision-cards.md §6):
 * find the agent's current work, post its answer where that work came from
 * (ticket thread, trigger destination, new top-level post in the team
 * channel), and tell other services (decision cards) the Slack place of the
 * agent's current work.
 *
 * Every collaborator is injectable; {@link defaultWorkDestinationDeps} wires
 * the real services lazily.
 *
 * @module services/orc/work-item-destination.wiring
 */

import { recordWorkPost } from './work-post-record.js';
import { MESSAGE_ROUTE_CONSTANTS, WORK_ITEM_DESTINATION_CONSTANTS } from '../../constants.js';
import { describeRoute, formatRouteToken, isMessageRoute, replyCommandFor, type MessageRoute } from './message-route.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { TurnOrigin } from './orc-reply-route.service.js';
import { parseSlackThreadKey } from '../slack/slack-thread-key.js';
import {
  currentWorkItemOf,
  parseDestination,
  planWorkDestination,
  shortTopic,
  withTopicLine,
  type WorkDestination,
} from './work-item-destination.js';

/** One Slack post as an agent (SlackAgentPostService.post). */
export interface WorkDestinationPostRequest {
  agentSession: string;
  target: string;
  text: string;
  threadTs?: string;
  newTopLevel?: boolean;
}

/** Collaborators. */
export interface WorkDestinationDeps {
  /** Pool items (for the agent's current work item) */
  poolItems(): Promise<WorkItem[]>;
  /** The agent's last owner turn origin */
  ownerOrigin(session: string): TurnOrigin | undefined;
  /** Clock */
  now(): number;
  /** The Slack team channel of a team (hint) or of the agent's own team */
  teamChannelOf(session: string, teamIdHint?: string | null): Promise<{ slackChannelId: string; teamId: string } | null>;
  /** Ticket → Slack thread store, when wired */
  ticketThreads(): {
    get(projectPath: string, ticketId: string): Promise<{ slackChannelId: string; threadTs: string; teamId?: string } | null>;
    set(projectPath: string, ticketId: string, thread: { slackChannelId: string; threadTs: string; teamId?: string }): Promise<{ slackChannelId: string; threadTs: string; teamId?: string }>;
  } | null;
  /** A ticket's title and team */
  ticketInfo(projectPath: string, ticketId: string): Promise<{ title: string; team: string | null } | null>;
  /** Post as the agent (its own bot when installed) */
  post(req: WorkDestinationPostRequest): Promise<{ channelId: string; messageTs: string }>;
  /** Channel id for `#name` (optional) */
  findChannelId?(name: string): Promise<string | null>;
  /** The Slack DM a chat-v2 conversation is bridged to (optional) */
  dmOfConversation?(conversationId: string): { slackChannelId: string; threadTs?: string } | null;
  /**
   * Deliver an internal message to an agent (the delegator of work with an
   * agent origin, crewly#1357); true when it was taken. Optional: without it
   * such a result has nowhere to go and the reply reports that.
   */
  messageAgent?(toSession: string, text: string): Promise<boolean>;
}

/** Where an answer landed. */
export interface WorkDestinationDelivery {
  kind: WorkDestination['kind'];
  /** Slack channel (absent for an internal message to an agent) */
  slackChannelId?: string;
  /** Slack message ts (absent for an internal message to an agent) */
  messageTs?: string;
  /** Thread the answer is in (undefined = top level) */
  threadTs?: string;
  /** The agent an internal message went to */
  agentSession?: string;
  reason: string;
}

/** Sends an internal message to an agent; true when taken. */
export type AgentMessenger = (toSession: string, text: string) => Promise<boolean>;

let agentMessenger: AgentMessenger | null = null;

/**
 * Wire how results of agent-delegated work reach the delegating agent (boot:
 * the agent registration service's `sendMessageToAgent`).
 *
 * @param messenger - Messenger, or null to unwire
 */
export function setAgentMessenger(messenger: AgentMessenger | null): void {
  agentMessenger = messenger;
}

/**
 * The wired agent messenger (boot), or null.
 *
 * @returns Messenger
 */
export function getAgentMessenger(): AgentMessenger | null {
  return agentMessenger;
}

/**
 * The text a delegating agent gets with a result for work it handed out:
 * tagged, naming the sender and the work item, so it knows what it answers.
 *
 * @param fromSession - The agent reporting
 * @param text - Its message
 * @param workItem - The work item, when known
 * @returns Message text
 */
export function agentResultText(fromSession: string, text: string, workItem?: Pick<WorkItem, 'id' | 'title' | 'metadata'> | null): string {
  const about = workItem ? ` about WorkItem ${workItem.id} "${shortTopic(workItem.title)}"` : '';
  // The route the delegator was answering when it delegated travels back
  // with the result, so its consolidated answer lands where that request
  // came from (message-routing audit 2026-10-18).
  const parent = parentRouteOf(workItem);
  const why = parent
    ? `work you delegated while answering ${describeRoute(parent)} ${formatRouteToken(parent)}. Give the owner the consolidated answer with: ${replyCommandFor(parent)} — or a bare reply`
    : 'work you delegated; the owner did not ask for it in a thread — decide yourself what, if anything, the owner hears';
  return `${WORK_ITEM_DESTINATION_CONSTANTS.AGENT_RESULT_TAG} From ${fromSession}${about} (${why}):\n${text}`;
}

/**
 * The route a delegated work item carries back to its delegator
 * (`metadata.parentRoute`, stamped at delegation).
 *
 * @param workItem - Work item
 * @returns The route, or null
 */
export function parentRouteOf(workItem: Pick<WorkItem, 'metadata'> | null | undefined): MessageRoute | null {
  const v = ((workItem?.metadata ?? {}) as Record<string, unknown>)[MESSAGE_ROUTE_CONSTANTS.PARENT_ROUTE_METADATA_KEY];
  return isMessageRoute(v) ? v : null;
}

/**
 * The agent's current work and where its answer goes.
 *
 * @param session - Agent session
 * @param deps - Collaborators
 * @returns The plan and the work item behind it
 */
export async function planForSession(session: string, deps: WorkDestinationDeps): Promise<{ destination: WorkDestination; workItem: WorkItem | null }> {
  const items = await deps.poolItems().catch(() => [] as WorkItem[]);
  const workItem = currentWorkItemOf(items, session);
  const destination = planWorkDestination({ workItem, ownerOrigin: deps.ownerOrigin(session), now: deps.now() });
  return { destination, workItem };
}

/**
 * Post an answer at a non-owner destination. Owner origins are not handled
 * here (the existing chat-v2 reply path owns them) and return null.
 *
 * @param session - Answering agent
 * @param destination - From {@link planWorkDestination}
 * @param text - Answer
 * @param deps - Collaborators
 * @returns Where it landed, or null when there is nowhere to post (no team channel)
 */
export async function deliverToWorkDestination(
  session: string,
  destination: WorkDestination,
  text: string,
  deps: WorkDestinationDeps,
): Promise<WorkDestinationDelivery | null> {
  switch (destination.kind) {
    case 'owner-origin':
      return null;
    case 'slack': {
      const posted = await deps.post({
        agentSession: session,
        target: destination.target,
        text: destination.threadTs ? text : withTopicLine(destination.topic, text),
        ...(destination.threadTs ? { threadTs: destination.threadTs } : { newTopLevel: true }),
      });
      return { kind: 'slack', slackChannelId: posted.channelId, messageTs: posted.messageTs, ...(destination.threadTs ? { threadTs: destination.threadTs } : {}), reason: destination.reason };
    }
    case 'new-top-level': {
      const channel = await deps.teamChannelOf(session, destination.teamId);
      if (!channel) return null;
      const posted = await deps.post({ agentSession: session, target: channel.slackChannelId, text: withTopicLine(destination.topic, text), newTopLevel: true });
      return { kind: 'new-top-level', slackChannelId: posted.channelId, messageTs: posted.messageTs, reason: destination.reason };
    }
    case 'ticket-thread': {
      const thread = await ensureTicketThread(session, destination, deps);
      if (!thread) return null;
      if ('topLevelOnly' in thread) {
        const posted = await deps.post({ agentSession: session, target: thread.slackChannelId, text: withTopicLine(thread.topic, text), newTopLevel: true });
        return { kind: 'ticket-thread', slackChannelId: posted.channelId, messageTs: posted.messageTs, reason: `${destination.reason} (no thread store)` };
      }
      const posted = await deps.post({ agentSession: session, target: thread.slackChannelId, text, threadTs: thread.threadTs });
      return { kind: 'ticket-thread', slackChannelId: posted.channelId, messageTs: posted.messageTs, threadTs: thread.threadTs, reason: destination.reason };
    }
    case 'agent': {
      if (!deps.messageAgent) return null;
      // The work item the answer is about — the one the destination names,
      // never the replier's newest item.
      const items = destination.workItemId ? await deps.poolItems().catch(() => [] as WorkItem[]) : [];
      const workItem = destination.workItemId ? items.find((w) => w.id === destination.workItemId) ?? null : null;
      const taken = await deps.messageAgent(destination.sessionName, agentResultText(session, text, workItem));
      if (!taken) return null;
      return { kind: 'agent', agentSession: destination.sessionName, reason: destination.reason };
    }
  }
}

/**
 * The ticket's Slack thread, created (root `*ID · title*` in the team channel,
 * posted by the agent) when it has none yet.
 *
 * @param session - Posting agent
 * @param dest - Ticket destination
 * @param deps - Collaborators
 * @returns The thread; `topLevelOnly` when no store is wired; null when there is no team channel
 */
async function ensureTicketThread(
  session: string,
  dest: Extract<WorkDestination, { kind: 'ticket-thread' }>,
  deps: WorkDestinationDeps,
): Promise<{ slackChannelId: string; threadTs: string } | { slackChannelId: string; topic: string; topLevelOnly: true } | null> {
  const store = deps.ticketThreads();
  const existing = store ? await store.get(dest.projectPath, dest.ticketId) : null;
  if (existing) return existing;
  const info = await deps.ticketInfo(dest.projectPath, dest.ticketId).catch(() => null);
  const title = info?.title ?? dest.title ?? '';
  const topic = shortTopic(title ? `${dest.ticketId} · ${title}` : dest.ticketId);
  const channel = await deps.teamChannelOf(session, dest.teamId ?? info?.team ?? null);
  if (!channel) return null;
  if (!store) return { slackChannelId: channel.slackChannelId, topic, topLevelOnly: true };
  const root = await deps.post({ agentSession: session, target: channel.slackChannelId, text: `*${topic}*`, newTopLevel: true });
  // First thread wins: a concurrent poster may have stored one meanwhile.
  return store.set(dest.projectPath, dest.ticketId, { slackChannelId: root.channelId, threadTs: root.messageTs, teamId: channel.teamId });
}

/**
 * `reply --new-thread "<title>"`: a new top-level post in the agent's team
 * channel, opened with the title in bold.
 *
 * @param session - Agent
 * @param title - Thread title
 * @param text - Body
 * @param deps - Collaborators
 * @returns Where it landed, or null when the agent has no team channel
 */
export async function postNewThread(session: string, title: string, text: string, deps: WorkDestinationDeps): Promise<WorkDestinationDelivery | null> {
  const channel = await deps.teamChannelOf(session, null);
  if (!channel) return null;
  const posted = await deps.post({ agentSession: session, target: channel.slackChannelId, text: withTopicLine(title, text), newTopLevel: true });
  return { kind: 'new-top-level', slackChannelId: posted.channelId, messageTs: posted.messageTs, reason: 'agent started a new thread' };
}

/**
 * The Slack place of an agent's current work, for posts that must go there
 * (decision cards). No posting happens: a ticket without a thread yields its
 * team channel (the caller starts the thread).
 *
 * @param session - Agent session
 * @param deps - Collaborators (default: the real services)
 * @returns Channel (+ thread, + team; + topic line for a new top-level post), or null when the work is not in a Slack place
 */
export async function resolveAgentSlackDestination(
  session: string,
  deps?: WorkDestinationDeps,
): Promise<{ slackChannelId: string; threadTs?: string; teamId?: string; topic?: string } | null> {
  const d = deps ?? (await defaultWorkDestinationDeps());
  const { destination } = await planForSession(session, d);
  switch (destination.kind) {
    case 'owner-origin': {
      const o = destination.origin;
      const key = parseSlackThreadKey(o.slackThreadKey);
      if (key) return { slackChannelId: key.slackChannelId, threadTs: key.threadTs };
      if (o.slackChannelId) return { slackChannelId: o.slackChannelId, ...(o.slackThreadTs ? { threadTs: o.slackThreadTs } : {}) };
      return d.dmOfConversation?.(o.conversationId) ?? null;
    }
    case 'slack': {
      const parsed = parseDestination(destination.target);
      if (!parsed) return null;
      const id = parsed.target.startsWith('#') ? await d.findChannelId?.(parsed.target.slice(1)).catch(() => null) : parsed.target;
      if (!id) return null;
      return destination.threadTs
        ? { slackChannelId: id, threadTs: destination.threadTs }
        : { slackChannelId: id, ...(destination.topic ? { topic: destination.topic } : {}) };
    }
    case 'ticket-thread': {
      const existing = await d.ticketThreads()?.get(destination.projectPath, destination.ticketId);
      if (existing) return { slackChannelId: existing.slackChannelId, threadTs: existing.threadTs, ...(existing.teamId ? { teamId: existing.teamId } : {}) };
      const info = await d.ticketInfo(destination.projectPath, destination.ticketId).catch(() => null);
      return d.teamChannelOf(session, destination.teamId ?? info?.team ?? null);
    }
    case 'new-top-level': {
      const channel = await d.teamChannelOf(session, destination.teamId ?? null);
      return channel ? { ...channel, ...(destination.topic ? { topic: destination.topic } : {}) } : null;
    }
    case 'agent':
      // An internal message to the delegating agent is not a Slack place.
      return null;
  }
}

/**
 * The real collaborators (lazy imports keep this module light for tests).
 *
 * @returns Deps
 */
export async function defaultWorkDestinationDeps(): Promise<WorkDestinationDeps> {
  const [{ TaskPoolService }, { OrcReplyRouteService }, { getSlackTeamChannelService }, { StorageService }, { getTicketThreadStore }, { ProjectTicketService }, { getSlackAgentPostService }, { getSlackAgentDmService }] =
    await Promise.all([
      import('../task-pool/task-pool.service.js'),
      import('./orc-reply-route.service.js'),
      import('../slack/slack-team-channel.service.js'),
      import('../core/storage.service.js'),
      import('../decisions/ticket-thread-store.js'),
      import('../project-tickets/project-ticket.service.js'),
      import('../slack/slack-agent-post.service.js'),
      import('../slack/slack-agent-dm.service.js'),
    ]);
  return {
    poolItems: () => TaskPoolService.getInstance().getAllItems(),
    ownerOrigin: (session) => OrcReplyRouteService.getInstance().getLastOrigin(session),
    now: () => Date.now(),
    teamChannelOf: async (session, teamIdHint) => {
      const service = getSlackTeamChannelService();
      if (!service) return null;
      const mappings = await service.listMappings();
      const byTeam = (id: string) => mappings.find((m) => m.teamId === id);
      if (teamIdHint) {
        const m = byTeam(teamIdHint);
        if (m) return { slackChannelId: m.slackChannelId, teamId: m.teamId };
      }
      const teams = await StorageService.getInstance().getTeams().catch(() => []);
      for (const team of teams) {
        if (team.archived || !(team.members ?? []).some((mem) => mem.sessionName === session)) continue;
        const m = byTeam(team.id);
        if (m) return { slackChannelId: m.slackChannelId, teamId: m.teamId };
      }
      return null;
    },
    ticketThreads: () => getTicketThreadStore(),
    ticketInfo: async (projectPath, ticketId) => {
      const t = await ProjectTicketService.getInstance().get(projectPath, ticketId);
      return t ? { title: t.title, team: t.team } : null;
    },
    post: async (req) => {
      const service = getSlackAgentPostService();
      if (!service) throw new Error('Slack is not set up');
      const r = await service.post(req);
      // CREW-877: this post went straight to Slack with the chat mirror off, so it
      // would have no chat row and `search-chat` could not find it. File one,
      // quietly (nothing is woken, delivered or re-posted). Best-effort: the post
      // already landed.
      await recordWorkPost({
        agentSession: req.agentSession,
        slackChannelId: r.channelId,
        messageTs: r.messageTs,
        ...(req.threadTs ? { threadTs: req.threadTs } : {}),
        text: req.text,
      });
      return { channelId: r.channelId, messageTs: r.messageTs };
    },
    findChannelId: async (name) => {
      const { getSlackService } = await import('../slack/slack.service.js');
      return (await getSlackService().findChannelByName(name))?.id ?? null;
    },
    dmOfConversation: (conversationId) => {
      const link = getSlackAgentDmService()?.findByChatChannelId(conversationId);
      return link ? { slackChannelId: link.slackChannelId, ...(link.replyThreadTs ? { threadTs: link.replyThreadTs } : {}) } : null;
    },
    ...(agentMessenger ? { messageAgent: agentMessenger } : {}),
  };
}
