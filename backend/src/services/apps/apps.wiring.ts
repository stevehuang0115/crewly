/**
 * Crewly Apps wiring: the shared registry / Cloud client / service the
 * `/api/apps` controller uses, and the change poller started at boot
 * (specs/2026-10-04-crewly-apps-p2.md).
 *
 * @module services/apps/apps.wiring
 */

import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { getSlackInstanceRegistryService } from '../slack/slack-instance-registry.service.js';
import { AppsCloudClient } from './apps-cloud.client.js';
import { AppsRegistryService } from './apps-registry.service.js';
import { AppsService, type AppCardPoster, type AppsDirectory } from './apps.service.js';
import type { TeamMemberRole } from '../../types/index.js';
import { getTeamLeadIds } from '../../utils/team.utils.js';
import { ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { AppWakeService } from './app-wake.service.js';
import { AppThumbnailService } from './app-thumbnail.service.js';
import { withQueueMeta } from '../messaging/queue-priority.js';
import { AppRosterService, isRosterAgent } from './app-roster.service.js';
import { AppCommentsSlackService, commentsSlackOff, type CommentRoomRef } from './app-comments-slack.service.js';
import { AppCommentRoomService, type ResolvedRoom } from './app-comment-room.service.js';
import type { RosterChannelEntry } from './app-roster.service.js';
import type { OwnerTargets } from './apps.service.js';
import { AppCollaboratorsService } from './app-collaborators.service.js';

/** The team shape the apps code reads. */
export interface AppsTeam {
  name?: string;
  leaderIds?: string[];
  leaderId?: string;
  archived?: boolean;
  paused?: unknown;
  members?: Array<{ id?: string; role?: string; sessionName?: string; agentId?: string; name?: string }>;
}

/** Where teams come from. */
export type AppsTeamsSource = () => Promise<AppsTeam[]>;

interface AppsParts {
  client: AppsCloudClient;
  registry: AppsRegistryService;
  service: AppsService;
  /** Absent in tests that replace the parts */
  thumbnails?: AppThumbnailService;
  /** Pushes the agent roster for comment @mentions (absent in tests that replace the parts) */
  roster?: AppRosterService;
  /** Owner-approved collaborators (absent in tests that replace the parts) */
  collaborators?: AppCollaboratorsService;
}

let parts: AppsParts | null = null;
let commentsSlack: AppCommentsSlackService | null = null;
/** Slack-side modules the synchronous mirror hooks read (loaded by the interceptor attach). */
let slackSync: {
  dm: typeof import('../slack/slack-agent-dm.service.js');
  decisions: typeof import('../decisions/decision.wiring.js');
  watchdog: typeof import('../messaging/owner-message-watchdog.service.js');
} | null = null;

/**
 * The App comments <-> Slack mirror over the real Slack services (built on first use).
 *
 * @returns The shared service
 */
export function getAppCommentsSlack(): AppCommentsSlackService {
  if (commentsSlack) return commentsSlack;
  const home = getCrewlyHomePath();
  commentsSlack = new AppCommentsSlackService({
    homeDir: home,
    post: async (req) => {
      const { getSlackAgentPostService } = await import('../slack/slack-agent-post.service.js');
      const svc = getSlackAgentPostService();
      if (!svc) throw new Error('Slack is not connected');
      const r = await svc.post({ agentSession: req.agentSession, target: req.target, text: req.text, ...(req.threadTs ? { threadTs: req.threadTs } : { newTopLevel: true }) });
      return { channelId: r.channelId, messageTs: r.messageTs };
    },
    dmChannelOf: (session) => {
      // Sync lookup: the modules are preloaded by `loadSlackSync` before comments flow.
      return slackSync?.dm.getSlackAgentDmService()?.findByAgentSession(session)?.slackChannelId ?? null;
    },
    teamChannelOf: async (session) => {
      const teams = await defaultTeams();
      const team = teams.find((t) => (t.members ?? []).some((m) => m.sessionName === session)) as (AppsTeam & { id?: string }) | undefined;
      if (!team?.id) return null;
      const { getSlackTeamChannelService } = await import('../slack/slack-team-channel.service.js');
      return getSlackTeamChannelService()?.findByTeamId(team.id)?.slackChannelId ?? null;
    },
    nameOf: (session) => session,
    relayOwnerReply: async (appId, commentId, text, slackUserId) => {
      await getAppsParts().client.request('POST', `/apps/${appId}/comments/${commentId}/owner-replies`, { body: { body: text, via: 'slack', slackUserId } });
    },
    isOwner: (userId) => {
      // Same owner rule as decision cards.
      return slackSync ? slackSync.decisions.isDecisionOwner(userId) : false;
    },
    noteHandled: (channel, threadTs) => {
      slackSync?.watchdog.getOwnerMessageWatchdog()?.noteSlackAnswer(channel, threadTs, 'app comment reply');
    },
    log: (level, msg, meta) => console[level === 'warn' ? 'warn' : 'log'](`[AppCommentsSlack] ${msg}`, meta ?? ''),
  });
  return commentsSlack;
}

/** Replace the mirror (tests). */
export function setAppCommentsSlack(next: AppCommentsSlackService | null): void {
  commentsSlack = next;
}

// ---------------------------------------------------------------------------
// App owners (crewly-services apps/SPEC.md §15): teams and Crewly channels
// that own apps, and the room their comments are posted into.
// ---------------------------------------------------------------------------

let commentRoom: AppCommentRoomService | null = null;
/** Set by {@link startAppWake}: whether a session runs, and the skills root. */
let roomRuntime: { isRunning: (session: string) => boolean; skillsPath?: string } = { isRunning: () => false };

/** This machine's Crewly channels as the roster pushes them. */
async function rosterChannels(): Promise<RosterChannelEntry[]> {
  const { getCrewlyChannelService } = await import('../channels/crewly-channel.service.js');
  const svc = getCrewlyChannelService();
  if (!svc) return [];
  return (await svc.list()).map((c) => ({ id: c.id, name: c.name, members: c.members.map((m) => m.sessionName), slack: !!c.slack }));
}

/**
 * Where a team / channel that owns an app lives on this machine: a Crewly
 * channel's huddle (and its Slack channel), or a team's Slack team channel
 * huddle. A team without a Slack team channel has no room here (its lead
 * gets the comments instead, {@link roomFallbackFrom}).
 *
 * @param teams - Teams source
 * @returns Resolver (null: no such room here)
 */
export function roomResolverFrom(teams: AppsTeamsSource): (room: CommentRoomRef) => Promise<ResolvedRoom | null> {
  return async (room) => {
    if (room.kind === 'channel') {
      const { getCrewlyChannelService } = await import('../channels/crewly-channel.service.js');
      const svc = getCrewlyChannelService();
      if (!svc) return null;
      const dto = await svc.get(room.id).catch(() => null);
      if (!dto) return null;
      const { getSlackTeamChannelService } = await import('../slack/slack-team-channel.service.js');
      const slackOn = !!getSlackTeamChannelService()?.isConnected();
      return {
        chatChannelId: dto.id,
        label: `#${dto.name}`,
        slackChannelId: slackOn ? (dto.slack?.channelId ?? null) : null,
        members: dto.members.map((m) => m.sessionName),
      };
    }
    const team = (await teams()).find((t) => (t as AppsTeam & { id?: string }).id === room.id && !t.archived);
    if (!team) return null;
    const { getSlackTeamChannelService, teamChannelMembers } = await import('../slack/slack-team-channel.service.js');
    const rooms = getSlackTeamChannelService();
    const mapping = rooms?.findByTeamId(room.id) ?? null;
    if (!mapping) return null;
    const members = teamChannelMembers(team as Parameters<typeof teamChannelMembers>[0]).flatMap((m) => (m.sessionName ? [m.sessionName] : []));
    return {
      chatChannelId: mapping.chatChannelId,
      label: `${team.name ?? room.name} team`,
      slackChannelId: rooms?.isConnected() ? mapping.slackChannelId : null,
      members,
    };
  };
}

/**
 * Who gets a room-owned comment when the room is not here: a team's lead (by
 * the shared lead rule); a channel has none (the orchestrator).
 *
 * @param teams - Teams source
 * @returns Fallback resolver
 */
export function roomFallbackFrom(teams: AppsTeamsSource): (room: CommentRoomRef) => Promise<string | null> {
  return async (room) => {
    if (room.kind !== 'team') return null;
    const team = (await teams()).find((t) => (t as AppsTeam & { id?: string }).id === room.id && !t.archived);
    if (!team) return null;
    const members = (team.members ?? []).flatMap((m) => (m.id ? [{ id: m.id, role: (m.role ?? '') as TeamMemberRole }] : []));
    const leadId = getTeamLeadIds({ members, leaderIds: team.leaderIds, leaderId: team.leaderId })[0];
    const lead = (team.members ?? []).find((m) => m.id === leadId) ?? (team.members ?? []).find((m) => m.sessionName && m.role !== 'orchestrator');
    return lead?.sessionName ?? null;
  };
}

/**
 * What can own an app on this machine: agents and teams from the teams
 * source, channels from the Crewly channel registry.
 *
 * @param teams - Teams source
 * @returns Lookups
 */
export function ownerTargetsFrom(teams: AppsTeamsSource): OwnerTargets {
  const norm = (s: string): string => s.trim().replace(/^@/, '').toLowerCase();
  return {
    agent: async (ref) => {
      const want = norm(ref);
      if (want === ORCHESTRATOR_SESSION_NAME || want === 'orc') return { session: ORCHESTRATOR_SESSION_NAME, name: 'Orc' };
      for (const t of await teams()) {
        if (t.archived) continue;
        const m = (t.members ?? []).find((x) => !!x.sessionName && (x.sessionName.toLowerCase() === want || (x.name ?? '').trim().toLowerCase() === want));
        if (m?.sessionName) return { session: m.sessionName, name: m.name ?? m.sessionName };
      }
      return null;
    },
    team: async (ref) => {
      const want = norm(ref);
      const all = (await teams()).filter((t) => !t.archived) as Array<AppsTeam & { id?: string }>;
      const t = all.find((x) => x.id === ref.trim()) ?? all.find((x) => (x.name ?? '').trim().toLowerCase() === want);
      return t?.id ? { id: t.id, name: t.name ?? t.id } : null;
    },
    channel: async (ref) => {
      const { getCrewlyChannelService } = await import('../channels/crewly-channel.service.js');
      const dto = await getCrewlyChannelService()?.get(ref.trim()).catch(() => null);
      return dto ? { id: dto.id, name: dto.name } : null;
    },
  };
}

/**
 * The room side of app comments over the real services (built on first use).
 *
 * @param teams - Teams source
 * @returns The shared service
 */
export function getAppCommentRoom(teams: AppsTeamsSource = defaultTeams): AppCommentRoomService {
  if (commentRoom) return commentRoom;
  commentRoom = new AppCommentRoomService({
    resolveRoom: roomResolverFrom(teams),
    chat: () => chatV2Sync,
    dispatch: () => {
      const d = chatV2Dispatcher();
      return d ? (channel, message, options) => d.dispatchMessage(channel, message, options) : null;
    },
    isRunning: (session) => roomRuntime.isRunning(session),
    slackPost: async (req) => {
      const { getSlackAgentPostService } = await import('../slack/slack-agent-post.service.js');
      const svc = getSlackAgentPostService();
      if (!svc) throw new Error('Slack is not connected');
      const r = await svc.post({ agentSession: req.agentSession, target: req.target, text: req.text, ...(req.threadTs ? { threadTs: req.threadTs } : { newTopLevel: true }) });
      return { channelId: r.channelId, messageTs: r.messageTs };
    },
    links: getAppCommentsSlack(),
    publisherOf: async (appId) => (await getAppsParts().registry.get(appId))?.agentSession ?? null,
    instanceId: currentInstanceId,
    relayAgentReply: async (appId, commentId, agentSession, text) => {
      await getAppsParts().client.request('POST', `/apps/${appId}/comments/${commentId}/replies`, { body: { body: text }, agent: agentSession });
    },
    get skillsPath() {
      return roomRuntime.skillsPath;
    },
    slackOff: () => commentsSlackOff(),
    log: (level, msg, meta) => console[level === 'warn' ? 'warn' : 'log'](`[AppCommentRoom] ${msg}`, meta ?? ''),
  });
  return commentRoom;
}

/** Replace the room service (tests). */
export function setAppCommentRoom(next: AppCommentRoomService | null): void {
  commentRoom = next;
}

/** chat-v2 pieces the room service reads synchronously (set when the poller starts). */
let chatV2Sync: import('./app-comment-room.service.js').RoomChatApi | null = null;
let chatV2Dispatcher: () => { dispatchMessage: import('../chat-v2/chat-v2.dispatcher.service.js').ChatV2DispatcherService['dispatchMessage'] } | null = () => null;

/**
 * Wire the room service to chat-v2: the service it writes into, the
 * dispatcher, and agents' replies in room comment threads (relayed to the
 * app). Called once at boot.
 *
 * @returns Remove function
 */
export async function attachAppCommentRoom(): Promise<() => void> {
  const [{ getChatV2Service }, { getChatV2RealtimeDeps }] = await Promise.all([
    import('../chat-v2/chat-v2.singleton.js'),
    import('../chat-v2/chat-v2.realtime-holder.js'),
  ]);
  const chat = getChatV2Service();
  chatV2Sync = chat;
  chatV2Dispatcher = () => getChatV2RealtimeDeps().dispatcher ?? null;
  const room = getAppCommentRoom();
  const onMessage = (dto: import('../chat-v2/types.js').ChatMessageDTO): void => {
    void room.onChatMessage(dto).catch(() => undefined);
  };
  chat.on('chat_message', onMessage);
  return () => chat.off('chat_message', onMessage);
}

/**
 * Let the owner's replies in a mapped Slack thread go to the app comment
 * (an inbound interceptor on the Slack bridge).
 *
 * @returns Remove function
 */
export async function attachAppCommentsSlackInterceptor(): Promise<() => void> {
  const svc = getAppCommentsSlack();
  const [dm, decisions, watchdog] = await Promise.all([
    import('../slack/slack-agent-dm.service.js'),
    import('../decisions/decision.wiring.js'),
    import('../messaging/owner-message-watchdog.service.js'),
  ]);
  slackSync = { dm, decisions, watchdog };
  await svc.load();
  const { getSlackOrchestratorBridge } = await import('../slack/slack-orchestrator-bridge.js');
  return getSlackOrchestratorBridge().addInboundInterceptor('an app comment thread reply', (m) => svc.interceptInbound(m));
}
let wake: AppWakeService | null = null;

/** Default teams source: the storage service, loaded lazily. */
const defaultTeams: AppsTeamsSource = async () => {
  const { StorageService } = await import('../core/storage.service.js');
  return StorageService.getInstance().getTeams();
};

/**
 * This instance's Cloud device id (what `X-Crewly-Instance` names).
 *
 * @returns The id, or null before the Slack instance registry resolved it
 */
export async function currentInstanceId(): Promise<string | null> {
  const registry = getSlackInstanceRegistryService();
  if (!registry) return null;
  return registry.getInstanceId() ?? (await registry.resolveInstanceId());
}

/**
 * The team that has this session as a member.
 *
 * @param teams - Teams
 * @param session - Agent session
 * @returns The team, or undefined
 */
function teamOf(teams: AppsTeam[], session: string): AppsTeam | undefined {
  return teams.find((t) => (t.members ?? []).some((m) => m.sessionName === session));
}

/**
 * Whether two sessions are members of the same team.
 *
 * @param teams - Teams source
 * @returns Predicate
 */
export function sameTeamFrom(teams: AppsTeamsSource): (a: string, b: string) => Promise<boolean> {
  return async (a, b) => {
    const team = teamOf(await teams(), a);
    return !!team && (team.members ?? []).some((m) => m.sessionName === b);
  };
}

/**
 * Team lookups for app transfers: a target must be a member of an existing,
 * non-archived team; a lead is a lead of the publisher's team by the shared
 * lead rule.
 *
 * @param teams - Teams source
 * @returns Directory
 */
export function directoryFrom(teams: AppsTeamsSource): AppsDirectory {
  return {
    member: async (session) => {
      for (const t of await teams()) {
        if (t.archived) continue;
        const m = (t.members ?? []).find((x) => x.sessionName === session);
        if (m) return { session, name: m.name ?? session, team: t.name ?? null };
      }
      return null;
    },
    leadsTeamOf: async (lead, publisher) => {
      const team = teamOf(await teams(), publisher);
      const me = (team?.members ?? []).find((m) => m.sessionName === lead);
      if (!team || !me?.id) return false;
      const members = (team.members ?? []).flatMap((m) => (m.id ? [{ id: m.id, role: (m.role ?? '') as TeamMemberRole }] : []));
      return getTeamLeadIds({ members, leaderIds: team.leaderIds, leaderId: team.leaderId }).includes(me.id);
    },
  };
}

/** Delivers a message to an agent; set once the app poller starts (it owns the delivery callbacks). */
let agentNotifier: ((session: string, text: string, activate: boolean) => Promise<boolean>) | null = null;

/**
 * Resolve an `ask` target name to a session — only inside the publisher's
 * own team (by session or display name, case-insensitive).
 *
 * @param teams - Teams source
 * @returns Resolver
 */
export function teamAgentResolver(teams: AppsTeamsSource): (name: string, publisher: string) => Promise<string | null> {
  return async (name, publisher) => {
    const team = teamOf(await teams(), publisher);
    if (!team) return null;
    const wanted = name.trim().toLowerCase();
    for (const m of team.members ?? []) {
      if (!m.sessionName) continue;
      if (m.sessionName.toLowerCase() === wanted || (m.name ?? '').trim().toLowerCase() === wanted) return m.sessionName;
    }
    return null;
  };
}

/**
 * The real card poster (specs/2026-10-04-crewly-apps-p3.md §1).
 *
 * - `ownerDm`: the agent's DM with the owner — the same lookup `reply` uses
 *   for its last step (Slack DM link, else the dashboard DM of a real team
 *   member). Cloud forwards only the owner's Slack DMs to an agent bot, so a
 *   linked Slack DM is one-to-one with the owner.
 * - `postToOwnerDm`: straight into that conversation, with no resolver and
 *   no fallback, so a signed link can never be re-routed into a room. Not
 *   traced either: the run trace records reply text, and this text holds
 *   the token.
 * - `postReply`: the P2 path (`deliverReply`), for the plain-URL card.
 */
export const defaultCardPoster: AppCardPoster = {
  ownerDm: async (agentSession) => {
    const { defaultReplyDeliveryDeps } = await import('../orc/reply-destination.wiring.js');
    return (await defaultReplyDeliveryDeps()).resolver.ownerDm(agentSession);
  },
  postToOwnerDm: async (agentSession, conversationId, text) => {
    const { deliverAgentReplyToConversation } = await import('../../controllers/chat/chat.controller.js');
    const id = await deliverAgentReplyToConversation({ conversationId, agentSession, content: text });
    return id ? { ok: true } : { ok: false, error: 'the DM did not take the card' };
  },
  postReply: async (agentSession, text) => {
    const { deliverReply } = await import('../orc/reply-destination.wiring.js');
    const r = await deliverReply({ session: agentSession, content: text, addsNew: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  },
};

/** The running decision service (set once decision cards start), for collaborator requests. */
let decisionsOf: () => import('./app-collaborators.service.js').CollaboratorDecisions | null = () => null;

/**
 * Let collaborator requests ask the owner, and act on the owner's tap. Called
 * once decision cards run.
 *
 * @param decisions - The running decision service
 * @param register - Registers the `app_collaborator` kind handler (`DecisionService.registerKindHandler`)
 */
export function attachAppCollaboratorDecisions(
  decisions: import('./app-collaborators.service.js').CollaboratorDecisions,
  register: (kind: 'app_collaborator', handler: AppCollaboratorsService | null) => void,
): void {
  decisionsOf = () => decisions;
  const collaborators = getAppsParts().collaborators;
  if (collaborators) register('app_collaborator', collaborators);
}

/**
 * The shared Apps parts, built on first use.
 *
 * @param teams - Teams source (default: the storage service)
 * @returns Client, registry and service
 */
export function getAppsParts(teams: AppsTeamsSource = defaultTeams): AppsParts {
  if (!parts) {
    const client = new AppsCloudClient({ instanceId: currentInstanceId });
    const registry = new AppsRegistryService(getCrewlyHomePath());
    const thumbnails = new AppThumbnailService({ client, registry });
    const roster = new AppRosterService({ client, getTeams: teams, getChannels: rosterChannels });
    const directory = directoryFrom(teams);
    parts = {
      client,
      registry,
      thumbnails,
      roster,
      collaborators: new AppCollaboratorsService({
        client,
        directory,
        instanceId: currentInstanceId,
        decisions: () => decisionsOf(),
        notifyAgent: async (session, text, activate) => (agentNotifier ? agentNotifier(session, text, activate) : false),
      }),
      // Under jest nothing may launch a real browser unless a test injects its own parts.
      service: new AppsService({
        client,
        registry,
        cards: defaultCardPoster,
        sameTeam: sameTeamFrom(teams),
        directory,
        notifyAgent: async (session, text, activate) => (agentNotifier ? agentNotifier(session, text, activate) : false),
        roster,
        commentsSlack: {
          // A room-owned comment is answered in its room thread; others in the DM / team-channel mirror.
          agentReplied: async (appId, commentId, agent, text) => {
            if (await getAppCommentRoom(teams).agentReplied(appId, commentId, agent, text)) return;
            await getAppCommentsSlack().agentReplied(appId, commentId, agent, text);
          },
          statusChanged: async (appId, commentId, agent, action) => {
            if (await getAppCommentRoom(teams).statusChanged(appId, commentId, agent, action)) return;
            await getAppCommentsSlack().statusChanged(appId, commentId, agent, action);
          },
        },
        instanceId: currentInstanceId,
        ownerTargets: ownerTargetsFrom(teams),
        ...(process.env.NODE_ENV === 'test' ? {} : { thumbnails }),
      }),
    };
  }
  return parts;
}

/**
 * Replace the shared parts (tests), or null to rebuild lazily.
 *
 * @param next - Parts or null
 */
export function setAppsParts(next: AppsParts | null): void {
  parts = next;
}

/** Inputs of {@link startAppWake}. */
export interface StartAppWakeInput {
  /** Agent skills root (`config/skills/agent`) */
  skillsPath: string;
  /** Wake an agent with a message; `activate` = start it first when it is down */
  sendToAgent: (session: string, text: string, activate: boolean) => Promise<boolean>;
  /** Hand a message to the orchestrator */
  sendToOrchestrator: (text: string) => Promise<boolean>;
  /** Whether an agent's session is running */
  sessionExists: (session: string) => boolean;
  /** Teams on this instance */
  getTeams: AppsTeamsSource;
}

/**
 * Start the app change poller (idempotent).
 *
 * @param input - Delivery callbacks and paths
 * @returns The running service
 */
export function startAppWake(input: StartAppWakeInput): AppWakeService {
  if (wake) return wake;
  const { client, registry, roster } = getAppsParts(input.getTeams);
  agentNotifier = input.sendToAgent;
  roomRuntime = { isRunning: input.sessionExists, skillsPath: input.skillsPath };
  const room = getAppCommentRoom(input.getTeams);
  const resolveRoom = roomResolverFrom(input.getTeams);
  wake = new AppWakeService({
    client,
    registry,
    skillsPath: input.skillsPath,
    deliver: (session, text, opts) => {
      if (!session) return input.sendToOrchestrator(text);
      const send = () => input.sendToAgent(session, text, opts.activate);
      // The owner's changes (comments, data, notify/ask): owner-authored, so a
      // busy agent's queue puts them ahead of system traffic (crewly#1105),
      // and a resent copy of the same batch is recognised as a duplicate.
      return opts.owner ? withQueueMeta(session, text, { owner: true, ...(opts.ref ? { ref: opts.ref } : {}) }, send) : send();
    },
    resolveAgent: teamAgentResolver(input.getTeams),
    isRunning: input.sessionExists,
    isLocalAgent: async (session) => isRosterAgent(await input.getTeams(), session),
    instanceId: currentInstanceId,
    ...(roster ? { roster } : {}),
    onCommentsDelivered: (info) => void getAppCommentsSlack().mirrorOwnerComments(info.session, info.appId, info.appName, info.comments),
    roomMembers: async (r) => (await resolveRoom(r))?.members ?? null,
    deliverRoom: (d) => room.deliver(d),
    roomFallback: roomFallbackFrom(input.getTeams),
  });
  wake.start();
  return wake;
}

/** Stop the poller (shutdown; tests). */
export function stopAppWake(): void {
  wake?.stop();
  wake = null;
  agentNotifier = null;
}
