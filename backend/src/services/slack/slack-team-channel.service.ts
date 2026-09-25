/**
 * Slack Team Channel Service
 *
 * Makes a Crewly team a first-class Slack participant: one Slack channel per
 * team, backed by one chat-v2 huddle whose roster is the team's members.
 *
 *   Slack #team-alpha  ──inbound──▶  chat-v2 huddle  ──dispatcher──▶ every member
 *          ▲                                                           (@'d must reply)
 *          └──outbound, posted as the agent (username/icon)──  reply-channel
 *
 * Responsibilities:
 *  - Mapping store (`~/.crewly/slack-team-channels.json`): create/link/unlink.
 *  - Lifecycle sync via `StorageService.onStorageEvent`: newly created team →
 *    channel + huddle + welcome (existing teams are opted in from Settings);
 *    member change → roster; archive/delete → archive both.
 *  - Inbound routing for mapped channels (called by the orchestrator bridge):
 *    persist into the huddle with Slack thread correlation, resolve `@name`
 *    mentions, dispatch, answer typos with "did you mean".
 *  - Outbound mirror: agent messages recorded in a mapped huddle are posted to
 *    the Slack thread under the agent's own name and icon.
 *
 * Nothing here is orchestrator-specific — the orchestrator keeps handling DMs
 * and unmapped channels exactly as before.
 *
 * @module services/slack/slack-team-channel.service
 */

import { getTicketIntakeService } from '../v3/ticket-intake.service.js';
import { intakeWithin, slackIntakeMessage, ticketOfOutcome, markAndLinkTicket } from '../v3/ticket-channel-hooks.js';
import type { Request } from '../../types/v2/request.types.js';
import { CREWLY_CONSTANTS } from '../../constants.js';
import { isInterim } from './slack-typing-placeholder.service.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Team, TeamMember } from '../../types/index.js';
import type {
  SlackIncomingMessage,
  SlackRoomPresence,
  SlackOutgoingMessage,
  SlackTeamChannelMapping,
  SlackTeamChannelsFile,
  SlackChannelInfo,
} from '../../types/slack.types.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import { describeSlackError } from './slack.service.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import type {
  ChatV2DispatcherService,
  DispatchMessageResult,
  HuddleRoomState,
} from '../chat-v2/chat-v2.dispatcher.service.js';
import type { StorageEvent } from '../core/storage.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getSlackDirectoryService } from './slack-directory.service.js';
import { SLACK_TEAM_CHANNEL_CONSTANTS, OWNER_EVIDENCE_METADATA } from '../../constants.js';
import { resolveSlackMentions, type MentionCandidate } from './slack-mention-resolver.js';
import { toSlackMrkdwn } from './slack-mrkdwn.js';
import type { SlackAgentIdentityService } from './slack-agent-identity.service.js';
import type { SlackTypingPlaceholderService } from './slack-typing-placeholder.service.js';

// ---------------------------------------------------------------------------
// Dependency contracts (narrow so tests can pass plain fakes)
// ---------------------------------------------------------------------------

/** The slice of SlackService this service uses. */
export interface TeamChannelSlackApi {
  isConnected(): boolean;
  createChannel(name: string): Promise<SlackChannelInfo>;
  renameChannel(channelId: string, name: string): Promise<string | null>;
  getChannelInfo(channelId: string): Promise<SlackChannelInfo | null>;
  joinChannel(channelId: string): Promise<void>;
  archiveChannel(channelId: string): Promise<void>;
  setChannelPurpose(channelId: string, purpose: string): Promise<void>;
  sendMessage(message: SlackOutgoingMessage): Promise<string>;
  addReaction(channelId: string, messageTs: string, emoji: string, botToken?: string): Promise<void>;
  inviteToChannel(channelId: string, userIds: string[]): Promise<void>;
  /** Names of a Slack user (for turning `@Their Name` into a mention). Optional. */
  getUserInfo?(userId: string): Promise<{ name: string; realName: string }>;
  /** Member user ids of a channel, bots included — picks between same-named agents. */
  listChannelMembers?(channelId: string): Promise<string[]>;
  uploadFile(options: {
    channelId: string;
    filePath: string;
    filename?: string;
    title?: string;
    initialComment?: string;
    threadTs?: string;
    botToken?: string;
  }): Promise<{ fileId?: string }>;
}

/** The slice of SlackAgentIdentityService this service uses (optional). */
export type TeamChannelIdentityApi = Pick<
  SlackAgentIdentityService,
  'isAvailable' | 'load' | 'provision' | 'get' | 'getInstalled' | 'markChannel' | 'onInstalled'
>;

/** The slice of ChatV2Service this service uses. */
export type TeamChannelChatApi = Pick<
  ChatV2Service,
  | 'createHuddle'
  | 'setHuddleMembers'
  | 'getChannelForBridge'
  | 'archiveChannelForBridge'
  | 'findSlackThreadRoot'
  | 'findLatestSlackRoot'
  | 'getMessageForBridge'
  | 'recordTurn'
  | 'on'
  | 'off'
>;

/** The slice of StorageService this service uses. */
export interface TeamChannelStorageApi {
  getTeams(): Promise<Team[]>;
  onStorageEvent(listener: (event: StorageEvent) => Promise<void> | void): () => void;
}

/** Dispatcher slice — resolved lazily because it is built after the bridge. */
export type TeamChannelDispatcherApi = Pick<ChatV2DispatcherService, 'dispatchMessage'> &
  Partial<Pick<ChatV2DispatcherService, 'planHuddleTargets'>>;

/** Constructor dependencies. */
export interface SlackTeamChannelServiceDeps {
  slack: TeamChannelSlackApi;
  chat: TeamChannelChatApi;
  storage: TeamChannelStorageApi;
  /** Returns the live dispatcher, or null before it is wired. */
  getDispatcher: () => TeamChannelDispatcherApi | null;
  /**
   * Real per-agent Slack identities (Cloud-provisioned bot users). Optional:
   * without it agents post under the cosmetic username/icon override.
   */
  identities?: TeamChannelIdentityApi | null;
  /** "Is typing…" placeholders for @-mentioned agents; optional. */
  typing?: Pick<SlackTypingPlaceholderService, 'begin' | 'resolve' | 'setPhase' | 'fail'> | null;
  /** Whether an agent's runtime session exists right now (false = it must be woken first). */
  isAgentAwake?: (agentSession: string) => boolean;
  /** Whether an agent session runs on this instance (its own Slack copy is not re-recorded). */
  isLocalAgent?: (agentSession: string) => boolean;
  /** Mapping store path; defaults to `<CREWLY_HOME>/slack-team-channels.json`. */
  storePath?: string;
  /**
   * Slack user id of the workspace owner (the person who installed the
   * app). A channel the bot creates is invisible to everyone until they
   * join it, so the owner is invited right after creation.
   */
  getOwnerUserId?: () => string | null;
  /** This machine's Cloud instance id — to tell whether Cloud picked this machine to wake someone. */
  resolveInstanceId?: () => Promise<string | null>;
  /** An ad-hoc room gained a member: tell Cloud soon, not at the next 5-minute heartbeat. */
  onRoomsChanged?: () => void;
  /** Ask Cloud to deliver a room message to an agent on another machine. */
  handoffViaCloud?: (body: {
    agentSession: string;
    event: { channel: string; ts: string; thread_ts?: string; text?: string; user?: string };
  }) => Promise<void>;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Result of {@link SlackTeamChannelService.handoffForAgent}. */
export type HandoffResult =
  | { ok: true; agentSession: string; displayName: string; via: 'here' | 'cloud' }
  | { ok: false; reason: string; candidates?: string[] };

/** Settings half of the store, exposed over REST. */
export interface SlackTeamChannelSettings {
  autoCreate: boolean;
  channelPrefix: string;
}

/** Result of {@link SlackTeamChannelService.routeInbound}. */
export interface RouteInboundResult {
  /** The mapping the message matched. */
  mapping: SlackTeamChannelMapping;
  /** The persisted chat-v2 message. */
  message: ChatMessageDTO;
  /** Sessions that were `@`-mentioned. */
  mentions: string[];
  /** Dispatcher outcome, or null when no dispatcher is wired yet. */
  dispatch: DispatchMessageResult | null;
  /** True when this was a repeated copy of a message already routed. */
  duplicate?: boolean;
}

const EMPTY_STORE: SlackTeamChannelsFile = {
  version: 1,
  autoCreate: true,
  channelPrefix: '',
  mappings: [],
};

/**
 * Turn a team name into a Slack-legal channel name: lower-case, letters of
 * any script, digits, `-` and `_`; whitespace and punctuation collapse to
 * `-`; at most 80 characters.
 *
 * @param teamName - The team display name
 * @param prefix - Optional prefix (e.g. `crew-`), sanitised the same way
 * @returns The channel name without `#`, never empty
 *
 * @example
 * slackChannelNameFor('Growth Team!', 'crew-') // 'crew-growth-team'
 */
export function slackChannelNameFor(teamName: string, prefix = ''): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '');
  const body = clean(teamName) || 'team';
  const p = clean(prefix);
  const joined = p ? `${p}-${body}` : body;
  return joined.slice(0, SLACK_TEAM_CHANNEL_CONSTANTS.MAX_CHANNEL_NAME_LENGTH).replace(/-+$/g, '') || 'team';
}

/**
 * Whether a mapping is an ad-hoc channel (no Crewly team behind it).
 *
 * @param mapping - The mapping
 * @returns True for `adhoc:<channel>` mappings
 */
export function isAdhocMapping(mapping: Pick<SlackTeamChannelMapping, 'teamId'>): boolean {
  return mapping.teamId.startsWith(SLACK_TEAM_CHANNEL_CONSTANTS.ADHOC_TEAM_PREFIX);
}

/**
 * The agents that take part in a team channel: every member except the
 * orchestrator role (the orc is not a huddle participant — the point of
 * team channels is talking to the team without it).
 *
 * An idle member has no stored `sessionName` (the controller clears it on
 * stop), so it is derived — otherwise a stopped agent would vanish from
 * the Slack roster and its bot would be pruned.
 *
 * @param team - The team
 * @returns Members with a (stored or derived) session name, orchestrator excluded
 */
/** What every machine's orchestrator is called before it needs qualifying. */
export const ORCHESTRATOR_APP_NAME = 'Crewly Orc';

/** The team id the orchestrator's Slack app is filed under, per instance. */
export const ORCHESTRATOR_SYNC_TEAM_ID = 'orchestrator';

/**
 * The pseudo-team the orchestrator's app is filed under.
 *
 * Qualified by instance for the same reason the session is, and then one
 * more: Cloud prunes an app whose team appears in a sync but whose session
 * does not. With both machines filing under a bare `orchestrator`, each
 * sync would see the other's orchestrator sitting in a team it just synced,
 * not recognise the session, and delete the app — every time, in both
 * directions. Their real teams have distinct ids and were never at risk;
 * this one was hardcoded (spotted by the agent on the Air, 2026-09-21).
 *
 * @param instanceId - This instance's id
 * @returns The team id to file the orchestrator's app under
 */
export function orchestratorSyncTeamId(instanceId: string): string {
  return `${ORCHESTRATOR_SYNC_TEAM_ID}${ORCHESTRATOR_INSTANCE_SEPARATOR}${instanceId}`;
}

/** Separates the orchestrator's session from the instance it runs on. */
const ORCHESTRATOR_INSTANCE_SEPARATOR = '@';

/**
 * The session the orchestrator is registered with Cloud under.
 *
 * Every machine calls its orchestrator `crewly-orc`, and Cloud keys an
 * agent's Slack app on `(account, agentSession)` — so two machines on one
 * Cloud account would collapse into a single app, a single bot and a single
 * DM, which is the very thing the per-machine app exists to avoid. The
 * instance id makes the key unique; the suffix is stripped again the moment
 * an event comes back, so nothing downstream has to know about it.
 *
 * @param instanceId - This instance's id from the registry
 * @returns The session to register with Cloud
 */
export function orchestratorSyncSession(instanceId: string): string {
  return `${CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME}${ORCHESTRATOR_INSTANCE_SEPARATOR}${instanceId}`;
}

/**
 * The local session name for an inbound agent session.
 *
 * Only the orchestrator is qualified, and only towards Cloud. Everything on
 * this side — dispatch, the local roster, chat channels — knows it as
 * `crewly-orc`.
 *
 * @param agentSession - The session as Cloud sent it
 * @returns The local session name
 */
export function localAgentSession(agentSession: string): string {
  const orc = CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME;
  return agentSession.startsWith(`${orc}${ORCHESTRATOR_INSTANCE_SEPARATOR}`) ? orc : agentSession;
}

/**
 * The orchestrator as an entry for the agent-app roster.
 *
 * The Orchestrator Team is assembled by the teams API for display; it is
 * not stored, so `storage.getTeams()` — what the registry syncs from — never
 * contains it and {@link agentAppMembers} alone would never see an orc.
 * The registry appends this instead.
 *
 * @param deviceName - This machine's name; without one there is nothing to
 *   tell two machines' orchestrators apart, so no app is asked for
 * @param instanceId - This instance's id, which keys the app per machine
 * @returns The roster entry, or null when either is not known yet
 */
export function orchestratorSyncEntry(
  deviceName?: string,
  instanceId?: string,
): { teamId: string; name: string; agentSession: string; displayName: string } | null {
  const machine = (deviceName ?? '').trim();
  const instance = (instanceId ?? '').trim();
  if (!machine || !instance) return null;
  return {
    teamId: orchestratorSyncTeamId(instance),
    // The machine goes in the *team* name, not the display name. Cloud
    // strips a trailing "(...)" from a display name before comparing and
    // then re-appends the team when two agents share a name — so sending
    // "Crewly Orc (macbookpro.lan)" would be reduced back to "Crewly Orc"
    // and re-qualified with whatever the team is called. Naming the team
    // after the machine makes Cloud's own suffix the right one:
    // "Crewly Orc" alone while it is the only one, "Crewly Orc
    // (macbookpro.lan)" as soon as a second machine appears.
    name: machine,
    agentSession: orchestratorSyncSession(instance),
    displayName: ORCHESTRATOR_APP_NAME,
  };
}

export function teamChannelMembers(team: Team): TeamMember[] {
  return (team.members ?? [])
    .filter((m) => m.role !== 'orchestrator' && !!m.id)
    .map((m) => (m.sessionName ? m : { ...m, sessionName: resolveMemberSessionName(team.name, m) }));
}

/**
 * Pick the Slack identity an agent posts under.
 *
 * `username` is the member's display name. The icon is the member avatar
 * when it is a Slack emoji name (`:rocket:`) or a URL; otherwise a per-role
 * emoji, then the default robot.
 *
 * @param member - The team member, or undefined when the session is unknown
 * @param sessionName - Fallback display name
 * @returns The identity fields for SlackOutgoingMessage
 */
export function slackIdentityFor(
  member: TeamMember | undefined,
  sessionName: string,
): Pick<SlackOutgoingMessage, 'username' | 'iconEmoji' | 'iconUrl'> {
  const username = member?.name?.trim() || sessionName;
  const avatar = member?.avatar?.trim() ?? '';
  if (/^:[a-z0-9_+-]+:$/i.test(avatar)) {
    return { username, iconEmoji: avatar };
  }
  if (/^https?:\/\//i.test(avatar)) {
    return { username, iconUrl: avatar };
  }
  const roleEmoji = member?.role
    ? SLACK_TEAM_CHANNEL_CONSTANTS.ROLE_ICON_EMOJI[member.role]
    : undefined;
  return { username, iconEmoji: roleEmoji ?? SLACK_TEAM_CHANNEL_CONSTANTS.DEFAULT_ICON_EMOJI };
}

/**
 * Service — see module docs.
 */
export class SlackTeamChannelService {
  private readonly logger: ComponentLogger;
  private readonly deps: SlackTeamChannelServiceDeps;
  private readonly storePath: string;
  private store: SlackTeamChannelsFile | null = null;
  private loading: Promise<SlackTeamChannelsFile> | null = null;
  private unsubscribeStorage: (() => void) | null = null;
  private unsubscribeIdentity: (() => void) | null = null;
  /** Slack `channel:ts` of messages already routed → the persisted turn. */
  private readonly seenInbound = new Map<string, ChatMessageDTO>();
  /** The last room presence Cloud sent per Slack channel — names for a hand-off. */
  private readonly lastRooms = new Map<string, SlackRoomPresence>();
  /** People (not agents) by lower-cased name → Slack user id, for `@Name` in agent replies. */
  private readonly humanNames = new Map<string, string>();
  /** Whether the owner's names were looked up yet. */
  private ownerNamesLoaded = false;
  /** channelId → members, with fetch time; decides between same-named agents. */
  private readonly channelMembers = new Map<string, { at: number; ids: Set<string> }>();

  private readonly onChatMessage = (dto: ChatMessageDTO): void => {
    void this.mirrorOutbound(dto);
  };
  private started = false;
  /** Per-team serialisation so two team-saved events cannot create two channels. */
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(deps: SlackTeamChannelServiceDeps) {
    this.deps = deps;
    this.storePath =
      deps.storePath ?? path.join(getCrewlyHomePath(), SLACK_TEAM_CHANNEL_CONSTANTS.STORE_FILENAME);
    this.logger = LoggerService.getInstance().createComponentLogger('SlackTeamChannels');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Subscribe to team lifecycle events and chat-v2 agent messages. Idempotent.
   * Safe to call before Slack is connected — every Slack call is guarded by
   * `isConnected()` at the time it runs.
   */
  async start(): Promise<void> {
    if (this.started) return;
    await this.load();
    this.unsubscribeStorage = this.deps.storage.onStorageEvent((event) => this.handleStorageEvent(event));
    this.deps.chat.on('chat_message', this.onChatMessage);
    // A freshly installed agent bot gets invited into every channel of a
    // team it belongs to, so it can post there under its own identity.
    this.unsubscribeIdentity =
      this.deps.identities?.onInstalled((record) => {
        void this.inviteInstalledEverywhere(record.agentSession);
      }) ?? null;
    this.started = true;
    this.logger.info('Slack team channels started', {
      mappings: this.store?.mappings.length ?? 0,
      autoCreate: this.store?.autoCreate ?? true,
    });
    // Every team gets its channel by default (owner, 2026-09-19) — not just
    // teams created after the feature shipped. Runs in the background so a
    // slow Slack call never delays boot; idempotent per team.
    void this.reconcileAllTeams().catch((err) => {
      this.logger.warn('Team channel reconcile failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    });
    void this.rejoinMappedChannels();
  }

  /**
   * Make sure the master bot is still a member of every channel we map.
   *
   * Reinstalling the workspace app drops the bot out of every channel it
   * had joined, and nothing put it back: joining only ever happened when a
   * channel was first linked. A channel the bot has left delivers no
   * events at all, so a message there reached neither Cloud nor any
   * instance — the owner saw no reaction, no reply and nothing in any log,
   * because from Slack's side nothing had happened (`#rednote-team`,
   * 2026-09-21).
   *
   * Best-effort and idempotent: `conversations.join` on a channel we are
   * already in is a no-op, and a private channel cannot be joined at all —
   * that one needs a human to invite the bot, so say so.
   *
   * @returns When every mapping has been checked
   */
  private async rejoinMappedChannels(): Promise<void> {
    if (!this.deps.slack.isConnected()) return;
    const mappings = (this.store?.mappings ?? []).filter((m) => !isAdhocMapping(m));
    let rejoined = 0;
    for (const mapping of mappings) {
      try {
        await this.deps.slack.joinChannel(mapping.slackChannelId);
        rejoined += 1;
      } catch (err) {
        this.logger.warn('Could not rejoin a team channel — invite the bot manually if it is private', {
          channel: mapping.slackChannelName ?? mapping.slackChannelId,
          error: describeSlackError(err).code,
        });
      }
    }
    if (rejoined > 0) this.logger.info('Team channel membership checked', { channels: rejoined });
    await this.inviteOwnerWhereMissing();
  }

  /**
   * Invite the workspace owner into a channel.
   *
   * @param channelId - Slack channel id
   * @param channelName - For the log
   * @returns True when the owner is now in it (invited, or already there)
   */
  private async inviteOwner(channelId: string, channelName: string): Promise<boolean> {
    const owner = this.deps.getOwnerUserId?.() ?? null;
    if (!owner) {
      this.logger.info('No owner id known yet to invite into a team channel — will retry', { channel: channelName });
      return false;
    }
    try {
      await this.deps.slack.inviteToChannel(channelId, [owner]);
      this.logger.info('Owner invited into a team channel', { channel: channelName });
      return true;
    } catch (err) {
      const code = describeSlackError(err).code;
      if (code === 'already_in_channel') return true;
      this.logger.warn('Could not invite the owner into a team channel — search for it in Slack and join', {
        channel: channelName,
        error: code,
      });
      return false;
    }
  }

  /**
   * Put the owner into every channel Crewly created that they never got into.
   *
   * The invite used to happen once, when the channel was created. At boot the
   * owner's Slack id arrives with the Cloud config a moment after the first
   * channels can already be created, and the first one of a batch was made
   * with no one to invite: `#crewly-marketing` existed for four days with
   * only bots in it, invisible in the owner's sidebar (2026-09-19 → 09-23).
   * Retried on every (re)connect until it lands; once it has, never again.
   *
   * @returns When every such channel has been tried
   */
  async inviteOwnerWhereMissing(): Promise<void> {
    if (!this.deps.slack.isConnected() || !this.deps.getOwnerUserId?.()) return;
    const pending = (this.store?.mappings ?? []).filter((m) => m.autoCreated && !m.ownerInvited && !isAdhocMapping(m));
    let changed = false;
    for (const mapping of pending) {
      if (await this.inviteOwner(mapping.slackChannelId, mapping.slackChannelName)) {
        mapping.ownerInvited = true;
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  /**
   * Give every team with members a Slack channel when auto-create is on.
   * Existing mappings are left alone; teams without a (non-orchestrator)
   * member are skipped so the workspace is not carpeted with empty rooms.
   * Safe to call any time Slack (re)connects.
   *
   * @returns Which teams got a channel this pass
   */
  async reconcileAllTeams(): Promise<{ created: string[]; skipped: number }> {
    const settings = await this.getSettings();
    const result = { created: [] as string[], skipped: 0 };
    // Runs on every (re)connect, when the owner's id is usually known.
    await this.inviteOwnerWhereMissing().catch(() => undefined);
    if (!settings.autoCreate || !this.deps.slack.isConnected()) return result;
    for (const team of await this.deps.storage.getTeams()) {
      if (this.findByTeamId(team.id)) continue;
      if (teamChannelMembers(team).length === 0) {
        result.skipped++;
        continue;
      }
      try {
        await this.ensureTeamChannel(team);
        result.created.push(team.name);
      } catch (err) {
        this.logger.warn('Auto-create team channel failed', { teamId: team.id, teamName: team.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (result.created.length > 0) {
      this.logger.info('Team channels auto-created for existing teams', { teams: result.created, skippedEmpty: result.skipped });
    }
    return result;
  }

  /** Undo {@link start}. */
  stop(): void {
    if (!this.started) return;
    this.unsubscribeStorage?.();
    this.unsubscribeStorage = null;
    this.unsubscribeIdentity?.();
    this.unsubscribeIdentity = null;
    this.deps.chat.off('chat_message', this.onChatMessage);
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  /** Read the store from disk once; later calls return the cached copy. */
  private async load(): Promise<SlackTeamChannelsFile> {
    if (this.store) return this.store;
    if (!this.loading) {
      this.loading = safeReadJson<SlackTeamChannelsFile>(this.storePath, EMPTY_STORE).then((raw) => {
        const store: SlackTeamChannelsFile = {
          version: 1,
          autoCreate: raw?.autoCreate !== false,
          channelPrefix: typeof raw?.channelPrefix === 'string' ? raw.channelPrefix : '',
          mappings: Array.isArray(raw?.mappings) ? raw.mappings.filter(isMapping) : [],
        };
        this.store = store;
        return store;
      });
    }
    return this.loading;
  }

  private async save(): Promise<void> {
    const store = await this.load();
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await atomicWriteJson(this.storePath, store);
  }

  /**
   * Current settings (auto-create + prefix).
   *
   * @returns The settings half of the store
   */
  async getSettings(): Promise<SlackTeamChannelSettings> {
    const s = await this.load();
    return { autoCreate: s.autoCreate, channelPrefix: s.channelPrefix };
  }

  /**
   * Update settings. Only the keys present in `patch` change.
   *
   * @param patch - Partial settings
   * @returns The settings after the update
   */
  async updateSettings(patch: Partial<SlackTeamChannelSettings>): Promise<SlackTeamChannelSettings> {
    const s = await this.load();
    if (typeof patch.autoCreate === 'boolean') s.autoCreate = patch.autoCreate;
    const prefixGiven = typeof patch.channelPrefix === 'string';
    if (prefixGiven) s.channelPrefix = patch.channelPrefix!.trim();
    await this.save();
    // Saving a prefix is a request to rename, not just a note for the next
    // channel. The existing channels did follow it eventually, because every
    // team save runs syncChannelName and status writes arrive as team saves —
    // so an active team renamed within minutes and an idle one kept the old
    // name indefinitely (owner, 2026-09-21).
    //
    // Reconciled on every save, not only on a change: a prefix saved before
    // this existed would otherwise be stuck, with no way to ask for it again.
    // Re-saving the same value costs nothing — syncChannelName returns
    // without calling Slack when the name already matches.
    if (prefixGiven) await this.applyPrefixToExistingChannels();
    return this.getSettings();
  }

  /**
   * Rename every auto-created channel to match the current prefix.
   *
   * Each one goes through {@link syncChannelName}, so the protections hold:
   * a channel Crewly did not create is left alone, and so is one the owner
   * has renamed by hand. A failure on one channel does not stop the rest —
   * a half-renamed workspace is still better than stopping at the first
   * channel Slack refuses.
   *
   * @returns The channels renamed, old name → new name
   */
  async applyPrefixToExistingChannels(): Promise<Array<{ teamId: string; from: string; to: string }>> {
    const renamed: Array<{ teamId: string; from: string; to: string }> = [];
    const teams = await this.deps.storage.getTeams();
    for (const team of teams) {
      const mapping = this.findByTeamId(team.id);
      if (!mapping) continue;
      const from = mapping.derivedName ?? mapping.slackChannelName;
      try {
        const to = await this.syncChannelName(team, mapping);
        if (to) renamed.push({ teamId: team.id, from, to });
      } catch (error) {
        this.logger.warn('Could not rename a team channel for the new prefix', {
          teamId: team.id,
          channel: from,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (renamed.length > 0) {
      this.logger.info('Team channels renamed for the new prefix', { count: renamed.length });
    }
    return renamed;
  }

  /**
   * All mappings, in creation order.
   *
   * @returns Copies of every mapping
   */
  async listMappings(): Promise<SlackTeamChannelMapping[]> {
    const s = await this.load();
    return s.mappings.map((m) => ({ ...m }));
  }

  /**
   * Mapping for a team, if any. Synchronous read of the cached store — the
   * bridge calls this on every inbound Slack message.
   *
   * @param teamId - Crewly team id
   * @returns The mapping, or null
   */
  findByTeamId(teamId: string): SlackTeamChannelMapping | null {
    return this.store?.mappings.find((m) => m.teamId === teamId) ?? null;
  }

  /**
   * Mapping for a Slack channel, if any (sync, cached store).
   *
   * @param slackChannelId - Slack channel id
   * @returns The mapping, or null
   */
  findBySlackChannelId(slackChannelId: string): SlackTeamChannelMapping | null {
    return this.store?.mappings.find((m) => m.slackChannelId === slackChannelId) ?? null;
  }

  /**
   * Mapping for a chat-v2 huddle, if any (sync, cached store).
   *
   * @param chatChannelId - chat-v2 channel id
   * @returns The mapping, or null
   */
  findByChatChannelId(chatChannelId: string): SlackTeamChannelMapping | null {
    return this.store?.mappings.find((m) => m.chatChannelId === chatChannelId) ?? null;
  }

  /**
   * Every non-archived team with its mapping (or null). One call for the
   * Settings UI.
   *
   * @returns Teams in storage order
   */
  async listTeamsWithMappings(): Promise<
    Array<{ teamId: string; teamName: string; memberCount: number; mapping: SlackTeamChannelMapping | null }>
  > {
    await this.load();
    const teams = await this.deps.storage.getTeams();
    return teams
      .filter((t) => !t.archived)
      .map((t) => ({
        teamId: t.id,
        teamName: t.name,
        memberCount: teamChannelMembers(t).length,
        mapping: this.findByTeamId(t.id),
      }));
  }

  /**
   * Look a team up by id.
   *
   * @param teamId - Crewly team id
   * @returns The team, or null
   */
  async getTeam(teamId: string): Promise<Team | null> {
    const teams = await this.deps.storage.getTeams();
    return teams.find((t) => t.id === teamId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Create / link / unlink
  // -------------------------------------------------------------------------

  /**
   * Make sure `team` has a Slack channel and a huddle. Creates the Slack
   * channel (or reuses one with the same name) unless `slackChannelId`
   * names an existing channel to link. Idempotent: an existing mapping is
   * returned after a roster sync.
   *
   * @param team - The team
   * @param options - `slackChannelId` to link an existing channel instead of creating
   * @returns The mapping
   * @throws Error when Slack is not connected or the channel cannot be created/found
   */
  async ensureTeamChannel(
    team: Team,
    options: { slackChannelId?: string } = {},
  ): Promise<SlackTeamChannelMapping> {
    return this.serialised(team.id, async () => {
      await this.load();
      const existing = this.findByTeamId(team.id);
      if (existing) {
        await this.syncTeamMembers(team, existing);
        return existing;
      }
      if (!this.deps.slack.isConnected()) {
        throw new Error('Slack is not connected');
      }

      let channel: SlackChannelInfo;
      let autoCreated: boolean;
      let derived: string | undefined;
      let ownerInvited = false;
      if (options.slackChannelId) {
        const info = await this.deps.slack.getChannelInfo(options.slackChannelId);
        if (!info) throw new Error(`Slack channel not found: ${options.slackChannelId}`);
        if (info.isArchived) throw new Error(`Slack channel is archived: ${info.name}`);
        await this.deps.slack.joinChannel(info.id).catch((err: unknown) => {
          // Private channels cannot be joined; the bot must be invited by a human.
          this.logger.warn('Could not join linked channel — invite the bot manually', {
            channel: info.name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        channel = info;
        autoCreated = false;
      } else {
        const store = await this.load();
        derived = slackChannelNameFor(team.name, store.channelPrefix);
        channel = await this.deps.slack.createChannel(derived);
        autoCreated = true;
        ownerInvited = await this.inviteOwner(channel.id, channel.name);
        const purpose = team.description?.trim() || `Crewly team "${team.name}"`;
        await this.deps.slack.setChannelPurpose(channel.id, purpose).catch((err: unknown) => {
          this.logger.debug('setPurpose failed (non-critical)', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      const members = teamChannelMembers(team);
      const huddle = this.deps.chat.createHuddle({
        name: `#${channel.name}`,
        purpose: `Slack team channel for ${team.name}`,
        // A brand-new team may have no members yet; keep the huddle valid
        // with a placeholder that the first roster sync replaces.
        memberSessions: members.length > 0 ? members.map((m) => m.sessionName) : [`team:${team.id}`],
        principal: { userId: 'system', source: 'oss' },
      });

      const mapping: SlackTeamChannelMapping = {
        teamId: team.id,
        slackChannelId: channel.id,
        slackChannelName: channel.name,
        chatChannelId: huddle.id,
        createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
        autoCreated,
        ...(derived ? { derivedName: derived } : {}),
        ...(ownerInvited ? { ownerInvited: true } : {}),
      };
      const store = await this.load();
      store.mappings.push(mapping);
      await this.save();

      this.logger.info('Team channel ready', {
        teamId: team.id,
        teamName: team.name,
        slackChannel: `#${channel.name}`,
        huddle: huddle.id,
        members: members.length,
        autoCreated,
      });

      await this.postWelcome(mapping, team, members);
      await this.ensureIdentities(team, mapping);
      return mapping;
    });
  }

  /**
   * Make sure an extra channel for a set of agents exists (solution bundles:
   * e.g. an approvals channel with the lead and the writer). It is stored
   * like an ad-hoc channel (`adhoc:<channelId>` with a member roster), so
   * routing, outbound mirroring and room presence treat it the same way.
   *
   * Idempotent: `existingChannelId`, or an auto-created ad-hoc channel with
   * the same derived name, is reused; its roster gains the given agents.
   * The owner is invited on creation, and agents whose Slack bot is already
   * installed are invited into it.
   *
   * @param input - Channel name, purpose, agent sessions, a known channel id
   * @returns The mapping
   * @throws Error when Slack is not connected or the channel cannot be created
   */
  async ensureAgentChannel(input: {
    name: string;
    purpose: string;
    memberSessions: string[];
    existingChannelId?: string;
  }): Promise<SlackTeamChannelMapping> {
    const store = await this.load();
    const derived = slackChannelNameFor(input.name, store.channelPrefix);
    return this.serialised(`agent-channel:${derived}`, async () => {
      if (!this.deps.slack.isConnected()) throw new Error('Slack is not connected');
      const current = await this.load();
      let mapping =
        (input.existingChannelId ? current.mappings.find((m) => m.slackChannelId === input.existingChannelId) : undefined) ??
        current.mappings.find((m) => isAdhocMapping(m) && m.autoCreated && (m.derivedName ?? m.slackChannelName) === derived);
      const sessions = [...new Set(input.memberSessions.filter((s) => !!s))];

      if (mapping) {
        const roster = [...new Set([...(mapping.members ?? []), ...sessions])];
        if (roster.length !== (mapping.members ?? []).length) {
          mapping.members = roster;
          this.deps.chat.setHuddleMembers(mapping.chatChannelId, roster);
          await this.save();
          this.deps.onRoomsChanged?.();
        }
      } else {
        const channel = await this.deps.slack.createChannel(derived);
        const ownerInvited = await this.inviteOwner(channel.id, channel.name);
        if (input.purpose.trim()) {
          await this.deps.slack.setChannelPurpose(channel.id, input.purpose.trim()).catch((err: unknown) => {
            this.logger.debug('setPurpose failed (non-critical)', { error: err instanceof Error ? err.message : String(err) });
          });
        }
        const huddle = this.deps.chat.createHuddle({
          name: `#${channel.name}`,
          purpose: input.purpose.trim() || `Slack channel #${channel.name}`,
          memberSessions: sessions.length > 0 ? sessions : [`channel:${channel.id}`],
          principal: { userId: 'system', source: 'oss' },
        });
        mapping = {
          teamId: `${SLACK_TEAM_CHANNEL_CONSTANTS.ADHOC_TEAM_PREFIX}${channel.id}`,
          slackChannelId: channel.id,
          slackChannelName: channel.name,
          chatChannelId: huddle.id,
          createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
          autoCreated: true,
          derivedName: derived,
          members: sessions,
          ...(ownerInvited ? { ownerInvited: true } : {}),
        };
        current.mappings.push(mapping);
        await this.save();
        this.deps.onRoomsChanged?.();
        this.logger.info('Agent channel ready', { slackChannel: `#${channel.name}`, huddle: huddle.id, agents: sessions });
      }

      const identities = this.deps.identities;
      if (identities?.isAvailable()) {
        await identities.load();
        for (const session of mapping.members ?? []) {
          const record = identities.get(session);
          if (record?.status === 'installed' && record.botUserId && !record.invitedTo.includes(mapping.slackChannelId)) {
            await this.inviteBot(mapping, session, record.botUserId);
          }
        }
      }
      return mapping;
    });
  }

  /**
   * Remove a team's mapping. Optionally archives the Slack channel; the
   * huddle is always archived (it is Crewly's own object).
   *
   * @param teamId - Crewly team id
   * @param options - `archiveSlackChannel` (default false — leave the humans' channel alone)
   * @returns True when a mapping existed
   */
  async unlinkTeam(teamId: string, options: { archiveSlackChannel?: boolean } = {}): Promise<boolean> {
    return this.serialised(teamId, async () => {
      const store = await this.load();
      const idx = store.mappings.findIndex((m) => m.teamId === teamId);
      if (idx < 0) return false;
      const [mapping] = store.mappings.splice(idx, 1);
      await this.save();
      this.deps.chat.archiveChannelForBridge(mapping.chatChannelId);
      if (options.archiveSlackChannel && this.deps.slack.isConnected()) {
        await this.deps.slack.archiveChannel(mapping.slackChannelId).catch((err: unknown) => {
          this.logger.warn('Could not archive Slack channel', {
            channel: mapping.slackChannelName,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      this.logger.info('Team channel unlinked', {
        teamId,
        slackChannel: `#${mapping.slackChannelName}`,
        archivedSlack: !!options.archiveSlackChannel,
      });
      return true;
    });
  }

  /**
   * Keep an auto-created channel's name in step with its team's.
   *
   * Renaming a team used to leave its Slack channel on the old name for good,
   * so #strategy stayed #strategy after the team became "crewly-strategy-team"
   * and the owner had to rename it by hand (2026-09-20).
   *
   * Three things it will not do. It never touches a channel Crewly did not
   * create — that one is the owner's, linked deliberately. It never touches a
   * channel whose live name has drifted from what Crewly last derived, because
   * that means the owner renamed it themselves and their choice outranks the
   * team name. And it never fails the team update: a rename Slack refuses
   * (the name is taken, the bot lacks the scope) is logged and dropped.
   *
   * Costs nothing on the common path: the derived name is compared against the
   * stored one first, and team-saved events fire on every status write, so
   * asking Slack each time would hammer the API for nothing.
   *
   * @param team - The team, after the change
   * @param mapping - Its mapping
   * @returns The new channel name, or null when nothing was renamed
   */
  async syncChannelName(team: Team, mapping: SlackTeamChannelMapping): Promise<string | null> {
    if (!mapping.autoCreated || isAdhocMapping(mapping)) return null;
    const store = await this.load();
    const desired = slackChannelNameFor(team.name, store.channelPrefix);
    const lastDerived = mapping.derivedName ?? mapping.slackChannelName;
    if (desired === lastDerived) return null;
    if (!this.deps.slack.isConnected()) return null;

    // Only now, on the rare path, ask Slack — and only to check the owner has
    // not renamed it out from under us.
    const live = await this.deps.slack.getChannelInfo(mapping.slackChannelId).catch(() => null);
    if (live && live.name !== lastDerived) {
      this.logger.info('Leaving a channel the owner renamed; recording their name instead', {
        teamId: team.id, ourName: lastDerived, theirName: live.name,
      });
      mapping.slackChannelName = live.name;
      mapping.derivedName = live.name;
      await this.save();
      return null;
    }

    const applied = await this.deps.slack.renameChannel(mapping.slackChannelId, desired);
    if (!applied) return null;
    mapping.slackChannelName = applied;
    mapping.derivedName = desired;
    await this.save();
    this.logger.info('Team channel renamed to follow its team', {
      teamId: team.id, from: lastDerived, to: applied,
    });
    return applied;
  }

  /**
   * Reconcile the huddle roster with the team's current members.
   *
   * @param team - The team
   * @param mapping - Its mapping (looked up when omitted)
   * @returns The roster diff, or null when the team is unmapped
   */
  async syncTeamMembers(
    team: Team,
    mapping?: SlackTeamChannelMapping,
  ): Promise<{ added: string[]; removed: string[] } | null> {
    await this.load();
    const m = mapping ?? this.findByTeamId(team.id);
    if (!m) return null;
    const sessions = teamChannelMembers(team).map((x) => x.sessionName);
    if (sessions.length === 0) return { added: [], removed: [] };
    const diff = this.deps.chat.setHuddleMembers(m.chatChannelId, sessions);
    if (diff.added.length || diff.removed.length) {
      this.logger.info('Team channel roster synced', { teamId: team.id, ...diff });
    }
    await this.ensureIdentities(team, m);
    return diff;
  }

  // -------------------------------------------------------------------------
  // Team lifecycle
  // -------------------------------------------------------------------------

  /**
   * React to a storage event. Public so the bridge/tests can drive it
   * directly; `start()` subscribes it.
   *
   * @param event - The storage event
   */
  async handleStorageEvent(event: StorageEvent): Promise<void> {
    try {
      if (event.kind === 'team-deleted') {
        await this.unlinkTeam(event.teamId, { archiveSlackChannel: true });
        return;
      }
      const team = event.team;
      await this.load();
      const mapping = this.findByTeamId(team.id);
      if (team.archived) {
        if (mapping) await this.unlinkTeam(team.id, { archiveSlackChannel: true });
        return;
      }
      if (mapping) {
        await this.syncTeamMembers(team, mapping);
        await this.syncChannelName(team, mapping);
        return;
      }
      // Auto-create only for teams that were just created. Every status
      // write (activity monitor, registration) also lands here as a
      // team-saved event; turning each of those into a Slack channel would
      // carpet the workspace with channels for teams that pre-date this
      // feature. Existing teams get a channel from Settings → Team Channels.
      if (!event.created) return;
      const settings = await this.getSettings();
      if (!settings.autoCreate || !this.deps.slack.isConnected()) return;
      await this.ensureTeamChannel(team);
    } catch (err) {
      this.logger.warn('Team lifecycle sync failed', {
        kind: event.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Inbound (Slack → huddle)
  // -------------------------------------------------------------------------

  /**
   * Route an inbound Slack message that arrived in a mapped channel.
   *
   * 1. Persist into the huddle: a top-level Slack message becomes a chat-v2
   *    root carrying `slackThreadTs = ts`; a Slack thread reply is filed
   *    under the root that carries `slackThreadTs = thread_ts` (or becomes
   *    a root itself when that root predates the mapping).
   * 2. Resolve `@name` tokens against the team's members → `mentions`.
   * 3. Dispatch through the chat-v2 dispatcher (`huddle-broadcast`) with
   *    the thread id and the `reply-channel` hint.
   * 4. Answer unknown `@names` in-thread with suggestions.
   *
   * @param message - The inbound Slack message
   * @returns The routing result, or null when the channel is not mapped
   */
  async routeInbound(message: SlackIncomingMessage): Promise<RouteInboundResult | null> {
    await this.load();
    if (message.userId && !message.authorAgentSession) {
      this.rememberHuman(message.userId, [message.user?.realName, message.user?.name]);
    }
    let mapping = this.findBySlackChannelId(message.channelId);
    if (!mapping) mapping = await this.ensureAdhocChannel(message);
    if (!mapping) return null;

    // Slack delivers a channel message to every app in the channel, so a copy
    // that arrived through one of our agents' own apps proves that agent is
    // in the room — whether or not anyone has ever @'d it there. An ad-hoc
    // roster used to be "agents that were @'d here", which left an agent the
    // owner had added to a private channel out of it until someone happened
    // to address it by name.
    const receiving = await this.localReceivingAgent(message);
    if (receiving && isAdhocMapping(mapping) && !(mapping.members ?? []).includes(receiving)) {
      mapping.members = [...(mapping.members ?? []), receiving];
      this.deps.chat.setHuddleMembers(mapping.chatChannelId, mapping.members);
      await this.save();
      this.deps.onRoomsChanged?.();
    }
    if (message.room) {
      this.lastRooms.set(message.channelId, message.room);
      if (this.lastRooms.size > SLACK_TEAM_CHANNEL_CONSTANTS.SEEN_INBOUND_MAX) {
        const oldest = this.lastRooms.keys().next().value;
        if (oldest !== undefined) this.lastRooms.delete(oldest);
      }
    }

    // A hand-off: the room's router picked one of our agents to answer a
    // message this machine already has. Deliver it again, addressed to that
    // agent, instead of dropping it as a repeat.
    const handoffTo =
      message.handoffTo && (this.deps.isLocalAgent?.(message.handoffTo) ?? true) ? message.handoffTo : null;

    // One Slack message can reach us twice with different event types
    // (`app_mention` for an @'d agent's app plus `message.channels`); the
    // team must see it once — a second copy is acknowledged, not dispatched.
    const seenKey = `${message.channelId}:${message.ts}`;
    const seen = this.seenInbound.get(seenKey);
    if (seen && !handoffTo) {
      this.logger.debug('Repeated copy of a team channel message — not dispatched again', { key: seenKey });
      return { mapping, message: seen, mentions: [], dispatch: null, duplicate: true };
    }

    const channel = this.deps.chat.getChannelForBridge(mapping.chatChannelId);
    if (!channel || channel.archivedAt) {
      this.logger.warn('Mapped huddle missing or archived — dropping mapping', {
        teamId: mapping.teamId,
        huddle: mapping.chatChannelId,
      });
      await this.unlinkTeam(mapping.teamId);
      return null;
    }

    const teams = await this.deps.storage.getTeams();
    const team = teams.find((t) => t.id === mapping.teamId);
    // A team channel resolves @names against its team; an ad-hoc channel
    // (any Slack channel where an agent bot was @'d) against every local agent.
    const members = team ? teamChannelMembers(team) : isAdhocMapping(mapping) ? teams.flatMap((t) => teamChannelMembers(t)) : [];
    if (this.deps.identities) await this.deps.identities.load();
    const candidates: MentionCandidate[] = members.map((m) => ({
      name: m.name,
      sessionName: m.sessionName,
      botUserId: this.deps.identities?.get(m.sessionName)?.botUserId,
    }));
    const resolved = resolveSlackMentions(message.text ?? '', candidates);
    if (handoffTo && !resolved.mentions.includes(handoffTo)) resolved.mentions.push(handoffTo);
    // @-mentions of agents on OTHER machines. The resolver only knows local
    // agents, so an @ of Atlas (on the Mac) arrived on the Air as "nobody
    // addressed" and went to Ella, who was awake — the owner asked one agent
    // and two machines could both answer (2026-09-23, #daily-info). Cloud
    // lists every agent the message @'s; one addressed only elsewhere is
    // that machine's to handle.
    const isLocal = (sess: string) => this.deps.isLocalAgent?.(sess) ?? members.some((m) => m.sessionName === sess);
    const mentionedElsewhere = (message.mentionedAgentSessions ?? []).filter((sess) => !isLocal(sess));
    const addressedElsewhereOnly = !handoffTo && resolved.mentions.length === 0 && mentionedElsewhere.length > 0;

    // Thread correlation.
    const slackThreadTs = message.threadTs || message.ts;
    let threadId: string | undefined;
    if (message.threadTs) {
      const root = this.deps.chat.findSlackThreadRoot(mapping.chatChannelId, message.threadTs);
      threadId = root?.id;
    }

    // A colleague agent on another machine is recorded under its display
    // name, as a user turn: the dispatcher delivers user turns and skips
    // agent turns (self-loop guard), and to this team it IS an outside voice.
    const remoteAgent = message.authorAgentSession ?? null;
    const senderId = remoteAgent
      ? `${message.authorDisplayName || remoteAgent} (agent)`
      : message.user?.name || message.userId || 'slack-user';
    // An agent running HERE already has its reply in the huddle (it posted
    // it with reply-channel); its Slack copy only serves to reach the
    // colleagues it @'d, so it is dispatched from a transient turn and not
    // recorded a second time.
    const localAuthor = !!remoteAgent && (this.deps.isLocalAgent?.(remoteAgent) ?? false);
    const turn = {
      channelId: mapping.chatChannelId,
      senderType: 'user' as const,
      senderId,
      content: message.text ?? '',
      threadId,
      mentions: resolved.mentions,
      metadata: {
        source: 'slack' as const,
        slackChannelId: message.channelId,
        slackThreadTs,
        slackTs: message.ts,
        slackUserId: message.userId,
        // Marks the row as agent-authored: the commitment-approval gate must
        // never read a colleague agent's post as owner approval (#730).
        ...(remoteAgent ? { [OWNER_EVIDENCE_METADATA.REMOTE_AGENT_SESSION]: remoteAgent } : {}),
      },
    };
    const persisted: ChatMessageDTO = handoffTo && seen
      ? { ...seen, mentions: [...new Set([...(seen.mentions ?? []), handoffTo])] }
      : localAuthor
      ? ({
          id: `slack-echo-${message.channelId}-${message.ts}`,
          channelId: mapping.chatChannelId,
          seq: 0,
          senderType: 'user',
          senderId,
          content: turn.content,
          contentType: 'markdown',
          createdAt: Date.now(),
          attachments: [],
          mentions: resolved.mentions,
          threadId,
          metadata: turn.metadata,
        } as ChatMessageDTO)
      : this.deps.chat.recordTurn(turn).message;

    this.seenInbound.set(seenKey, persisted);
    if (this.seenInbound.size > SLACK_TEAM_CHANNEL_CONSTANTS.SEEN_INBOUND_MAX) {
      const oldest = this.seenInbound.keys().next().value;
      if (oldest !== undefined) this.seenInbound.delete(oldest);
    }

    // Ad-hoc channels grow their huddle as new agents get @'d there.
    if (isAdhocMapping(mapping) && resolved.mentions.length > 0) {
      const next = [...new Set([...(mapping.members ?? []), ...resolved.mentions])];
      if (next.length !== (mapping.members ?? []).length) {
        mapping.members = next;
        this.deps.chat.setHuddleMembers(mapping.chatChannelId, next);
        await this.save();
        this.deps.onRoomsChanged?.();
      }
    }

    // Who will receive this, and who owes a reply — decided by the same rules
    // delivery uses, but *before* delivery, which can take a minute or two
    // when an agent has to be cold-started. The owner should not look at an
    // unacknowledged message for that long.
    const dispatcherForPlan = this.deps.getDispatcher();
    const presence = await this.roomStateFor(message, mapping, team ? teamChannelMembers(team) : null);
    const dispatchOptions = {
      threadId: threadId ?? persisted.id,
      replyVia: 'reply-channel' as const,
      // A local agent's own message (fanned out to the colleagues it @'d)
      // must not come back to its author.
      ...(remoteAgent ? { excludeSessions: [remoteAgent] } : {}),
      ...(presence ? { room: presence.state, ...(presence.line ? { roomPresence: presence.line } : {}) } : {}),
    };
    if (addressedElsewhereOnly) {
      // Kept for context (the next question in the thread may be ours), but
      // no eyes, no placeholder, and nobody here is told.
      this.logger.info('Slack team message addressed to an agent on another machine — recorded, not dispatched', {
        teamId: mapping.teamId,
        slackChannel: `#${mapping.slackChannelName}`,
        mentionedElsewhere,
      });
      return { mapping, message: persisted, mentions: [], dispatch: null };
    }

    const planned: Map<string, 'required' | 'optional'> | null = dispatcherForPlan?.planHuddleTargets
      ? await dispatcherForPlan.planHuddleTargets(channel, persisted, dispatchOptions).catch(() => null)
      : null;

    // Ticket loop (specs/ticket-loop.md §2): the owner's message goes through
    // the single intake. Started now, awaited just before dispatch, so the
    // receipt and the agent's `[TICKET:…]` marker do not hold up the eyes /
    // placeholders below.
    const ticketPromise = this.intakeTicket(message, mapping, resolved.mentions, planned, handoffTo, remoteAgent);

    await this.acknowledgeSeen(message, mapping, resolved.mentions, planned);

    // Agents that must reply get a placeholder straight away — "waking up…"
    // for an idle agent (a cold start is 1–2 minutes), "is working on it…"
    // once it holds the message. Agents that were only told, and may or may
    // not decide to answer, get none: a placeholder is a promise of a reply,
    // and they announce their own with `reply-channel --working` if they
    // take it on. With a plan this covers the case the old heuristic missed —
    // a bare follow-up in a thread, which the last speaker must answer.
    let owing: string[];
    if (planned) {
      // An agent that is asleep and still gets the message is being woken
      // for it — the room's leader when nobody was awake — so it owns the
      // message and the owner should see that at once, not after the one or
      // two minutes a cold start takes (#pro-crewly-marketing, 2026-09-23).
      // Awake agents that were only told announce themselves with --working.
      // The orchestrator is left out: its bot is usually not in the room.
      const isAwake = this.deps.isAgentAwake;
      owing = [...planned]
        .filter(
          ([session, mode]) =>
            mode === 'required' ||
            (isAwake !== undefined && !isAwake(session) && session !== CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME),
        )
        .map(([session]) => session);
    } else {
      owing = resolved.mentions;
      if (owing.length === 0 && !message.threadTs && team) {
        // Same rule as the dispatcher's huddleLeaderFor: the team leader, else the first member.
        const leader = members.find((m) => String(m.role) === 'team-leader' || String(m.role) === 'tech-lead') ?? members[0];
        if (leader) owing = [leader.sessionName];
      }
    }
    const typingTargets: Array<{ session: string; key: { agentSession: string; slackChannelId: string; threadTs: string } }> = [];
    if (this.deps.typing) {
      for (const session of owing) {
        const member = members.find((m) => m.sessionName === session);
        const installed = this.deps.identities?.getInstalled(session);
        // Own bot when installed; otherwise the master bot wearing the agent's
        // name/icon — the person should see *something* during a cold start.
        const identity = installed
          ? { botToken: installed.botToken, displayName: member?.name ?? session }
          : { displayName: member?.name ?? session, ...slackIdentityFor(member, session) };
        const key = { agentSession: session, slackChannelId: message.channelId, threadTs: slackThreadTs };
        const awake = this.deps.isAgentAwake ? this.deps.isAgentAwake(session) : true;
        await this.deps.typing.begin(key, identity, awake ? 'typing' : 'waking', message.ts);
        typingTargets.push({ session, key });
      }
    }

    const dispatcher = this.deps.getDispatcher();
    let dispatch: DispatchMessageResult | null = null;
    if (dispatcher) {
      let roster = await getSlackDirectoryService()?.rosterLine(message.channelId).catch(() => '');
      // The directory needs the master bot to list a channel's members; in a
      // private ad-hoc channel it is not a member, so fall back to the local
      // huddle roster (with roles) — enough to answer "who leads this?".
      if (!roster && isAdhocMapping(mapping)) {
        roster = members
          .filter((m) => (mapping.members ?? []).includes(m.sessionName))
          .map((m) => `${m.name} (${teams.find((t) => (t.members ?? []).some((x) => x.id === m.id))?.name ?? '?'}, ${String(m.role)}, this machine)`)
          .join(' · ');
      }
      const ticket = await ticketPromise;
      dispatch = await dispatcher.dispatchMessage(channel, markAndLinkTicket(persisted, ticket), {
        ...dispatchOptions,
        ...(roster ? { channelRoster: roster } : {}),
      });
    } else {
      this.logger.warn('No chat dispatcher wired — message persisted but not delivered', {
        huddle: mapping.chatChannelId,
      });
    }

    if (resolved.unknown.length > 0) {
      await this.postUnknownMentionHint(message, resolved.unknown, candidates);
    }

    // Dispatch is done: each placeholder now reflects whether its agent
    // actually holds the message.
    if (this.deps.typing && typingTargets.length > 0) {
      const outcomes = new Map((dispatch?.huddleOutcomes ?? []).map((o) => [o.sessionName, o.dispatched]));
      for (const { session, key } of typingTargets) {
        const delivered = outcomes.get(session) ?? dispatch?.dispatched ?? false;
        if (delivered) await this.deps.typing.setPhase(key, 'typing');
        else await this.deps.typing.fail(key);
      }
    }

    this.logger.info('Slack team message routed', {
      teamId: mapping.teamId,
      slackChannel: `#${mapping.slackChannelName}`,
      mentions: resolved.mentions,
      ...(mentionedElsewhere.length > 0 ? { mentionedElsewhere } : {}),
      unknown: resolved.unknown.map((u) => u.token),
      strategy: dispatch?.strategy ?? 'none',
      threaded: !!threadId,
    });

    return { mapping, message: persisted, mentions: resolved.mentions, dispatch };
  }

  /**
   * Ticket intake for a team-channel / shared-room message.
   *
   * Only the owner's messages count (a colleague agent's post never files a
   * ticket). In a room shared across machines every machine sees the
   * message, so only the machine that owns it files the ticket: the one with
   * the team, or — in an ad-hoc room — the one whose agent was @'d or handed
   * the message. Never throws; null when no ticket applies.
   *
   * @param message - Inbound Slack message
   * @param mapping - Its channel mapping
   * @param mentions - Local sessions @'d
   * @param planned - Dispatch plan (session → required/optional), when known
   * @param handoffTo - Local agent the room's router handed it to
   * @param remoteAgent - Authoring agent, when an agent wrote it
   * @returns The ticket the message belongs to, or null
   */
  private async intakeTicket(
    message: SlackIncomingMessage,
    mapping: SlackTeamChannelMapping,
    mentions: readonly string[],
    planned: Map<string, 'required' | 'optional'> | null,
    handoffTo: string | null,
    remoteAgent: string | null,
  ): Promise<Request | null> {
    try {
      const intake = getTicketIntakeService();
      if (!intake || remoteAgent) return null;
      const required = planned ? [...planned].filter(([, mode]) => mode === 'required').map(([s]) => s) : [...mentions];
      const ownsMessage = !isAdhocMapping(mapping) || !!handoffTo || required.length > 0;
      if (!ownsMessage) return null;
      const targetAgent = handoffTo ?? (mentions.length === 1 ? mentions[0] : required.length === 1 ? required[0] : undefined);
      // The workspace bot is not a member of a private ad-hoc room; post the
      // receipt as the agent that will answer, when it has its own bot.
      const postAs = isAdhocMapping(mapping)
        ? [targetAgent, ...required].find((s): s is string => !!s && !!this.deps.identities?.getInstalled(s))
        : undefined;
      const outcome = await intakeWithin(
        intake,
        slackIntakeMessage(
          {
            text: message.text ?? '',
            slackChannelId: message.channelId,
            ts: message.ts,
            threadTs: message.threadTs,
            userId: message.userId,
            userName: message.user?.realName || message.user?.name,
            hasFiles: message.hasFiles,
            ownerUserId: this.deps.getOwnerUserId?.() ?? null,
          },
          'team-channel',
          { ...(targetAgent ? { targetAgent } : {}), ...(postAs ? { receiptPostAs: postAs } : {}) },
        ),
      );
      return ticketOfOutcome(outcome);
    } catch (err) {
      this.logger.warn('Ticket intake failed for a team channel message (still delivered)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Who in this room is awake, from this machine's point of view.
   *
   * Local members are judged by what is running here now; members on other
   * machines by what Cloud last heard from them. Cloud names the one machine
   * that wakes someone when nobody is awake. One case it cannot see: it may
   * believe an agent of ours is awake when that agent has just stopped.
   * Then nobody would be woken anywhere — every other machine thinks we have
   * it — so this machine, the only one that knows better, wakes the router.
   *
   * @param message - Inbound message (carries Cloud's presence, when any)
   * @param mapping - Its channel mapping
   * @param teamMembers - Team channel members, or null for an ad-hoc room
   * @returns State for the dispatcher and a line for the prompt; null without an awake check
   */
  private async roomStateFor(
    message: SlackIncomingMessage,
    mapping: SlackTeamChannelMapping,
    teamMembers: ReturnType<typeof teamChannelMembers> | null,
  ): Promise<{ state: HuddleRoomState; line?: string } | null> {
    const isAwake = this.deps.isAgentAwake;
    if (!isAwake) return null;
    const localMembers = teamMembers ? teamMembers.map((m) => m.sessionName) : (mapping.members ?? []);
    const awakeHere = localMembers.filter((m) => isAwake(m));
    const room = message.room;
    if (!room) return { state: { awakeHere, awakeElsewhere: false } };

    const me = this.deps.resolveInstanceId ? await this.deps.resolveInstanceId().catch(() => null) : null;
    const isHere = (m: { instanceId: string; agentSession: string }): boolean =>
      me ? m.instanceId === me : (this.deps.isLocalAgent?.(localAgentSession(m.agentSession)) ?? false);
    const awakeElsewhere = room.members.some((m) => !isHere(m) && m.awake);

    let wakeWhenAllAsleep: HuddleRoomState['wakeWhenAllAsleep'] = null;
    if (room.fallback) {
      const here = me ? room.fallback.instanceId === me : (this.deps.isLocalAgent?.(localAgentSession(room.fallback.agentSession)) ?? false);
      if (here) wakeWhenAllAsleep = { agentSession: localAgentSession(room.fallback.agentSession), kind: room.fallback.kind };
    } else if (!awakeElsewhere && awakeHere.length === 0 && room.members.some((m) => isHere(m) && m.awake)) {
      const leader = teamMembers
        ? (teamMembers.find((m) => String(m.role) === 'team-leader' || String(m.role) === 'tech-lead') ?? teamMembers[0])
        : undefined;
      wakeWhenAllAsleep = leader
        ? { agentSession: leader.sessionName, kind: 'team-leader' }
        : { agentSession: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME, kind: 'orchestrator' };
    }

    const line = room.members
      .map((m) => {
        const here = isHere(m);
        const awake = here ? awakeHere.includes(localAgentSession(m.agentSession)) : m.awake;
        return `${m.displayName}（${awake ? '醒着' : '在睡'}，${here ? '本机' : m.deviceName}）`;
      })
      .join(' · ');
    return { state: { awakeHere, awakeElsewhere, wakeWhenAllAsleep }, line };
  }

  /**
   * Hand a room message to one agent, wherever it runs.
   *
   * Used by the room's router — the orchestrator of a private room, woken
   * because nobody in it was awake. Its own bot is usually not in the room,
   * so it cannot @ the agent there the way a member would. An agent on this
   * machine gets the message delivered again as if @'d (👀 and a "waking
   * up…" placeholder from its own bot); one on another machine gets it
   * through Cloud, which does the same over there.
   *
   * @param input - Chat channel, the message to pass on, and who should answer it
   * @returns Who it went to, or why it could not
   */
  async handoffForAgent(input: {
    chatChannelId: string;
    messageId?: string;
    threadId?: string;
    name: string;
  }): Promise<HandoffResult> {
    await this.load();
    const mapping = (this.store?.mappings ?? []).find((m) => m.chatChannelId === input.chatChannelId);
    if (!mapping) return { ok: false, reason: 'not_a_slack_channel' };
    const source = input.messageId ?? input.threadId;
    const original = source ? this.deps.chat.getMessageForBridge(source) : null;
    const meta = (original?.metadata ?? {}) as Record<string, unknown>;
    const slackTs = typeof meta['slackTs'] === 'string' ? (meta['slackTs'] as string) : '';
    if (!original || meta['source'] !== 'slack' || !slackTs) return { ok: false, reason: 'not_a_slack_message' };
    const threadTs = typeof meta['slackThreadTs'] === 'string' && meta['slackThreadTs'] !== slackTs ? (meta['slackThreadTs'] as string) : undefined;
    const userId = typeof meta['slackUserId'] === 'string' ? (meta['slackUserId'] as string) : '';

    // Names: everyone Cloud last said is in the room, plus this machine's agents.
    const wanted = input.name.trim().replace(/^@/, '').toLowerCase();
    const candidates: Array<{ session: string; name: string }> = [];
    for (const m of this.lastRooms.get(mapping.slackChannelId)?.members ?? []) {
      candidates.push({ session: m.agentSession, name: m.displayName });
    }
    const localSessions = new Set<string>();
    for (const team of await this.deps.storage.getTeams()) {
      for (const m of teamChannelMembers(team)) {
        candidates.push({ session: m.sessionName, name: m.name });
        localSessions.add(m.sessionName);
      }
    }
    const hit = candidates.find((c) => c.name.toLowerCase() === wanted || c.session.toLowerCase() === wanted);
    if (!hit) {
      return { ok: false, reason: 'unknown_agent', candidates: [...new Set(candidates.map((c) => c.name))].slice(0, 20) };
    }

    const local = this.deps.isLocalAgent?.(localAgentSession(hit.session)) ?? localSessions.has(hit.session);
    if (local) {
      await this.routeInbound({
        id: slackTs,
        type: 'message',
        text: original.content,
        userId,
        channelId: mapping.slackChannelId,
        ...(threadTs ? { threadTs } : {}),
        ts: slackTs,
        teamId: '',
        eventTs: slackTs,
        source: 'cloud',
        handoffTo: localAgentSession(hit.session),
      });
      this.logger.info('Room message handed to a local agent', { agentSession: hit.session, slackChannel: mapping.slackChannelName });
      return { ok: true, agentSession: localAgentSession(hit.session), displayName: hit.name, via: 'here' };
    }
    if (!this.deps.handoffViaCloud) return { ok: false, reason: 'cloud_unavailable' };
    await this.deps.handoffViaCloud({
      agentSession: hit.session,
      event: {
        channel: mapping.slackChannelId,
        ts: slackTs,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: original.content,
        ...(userId ? { user: userId } : {}),
      },
    });
    this.logger.info('Room message handed to an agent on another machine', { agentSession: hit.session, slackChannel: mapping.slackChannelName });
    return { ok: true, agentSession: hit.session, displayName: hit.name, via: 'cloud' };
  }

  /**
   * The ad-hoc rooms this machine's agents are in, for the Cloud heartbeat —
   * Cloud builds each room's cross-machine roster from these.
   *
   * @returns Slack channel → local member sessions
   */
  async listRooms(): Promise<Array<{ channelId: string; agents: string[] }>> {
    await this.load();
    return (this.store?.mappings ?? [])
      .filter((m) => isAdhocMapping(m) && (m.members ?? []).length > 0)
      .map((m) => ({ channelId: m.slackChannelId, agents: [...(m.members ?? [])] }));
  }

  /**
   * The local agent whose own app delivered this copy, if any.
   *
   * A direct message is never a room: an agent's DM is handled by the DM
   * service, and anything that falls through from there belongs to the
   * orchestrator path, not to an ad-hoc huddle.
   *
   * @param message - The inbound message
   * @returns The agent's session name, or null
   */
  private async localReceivingAgent(message: SlackIncomingMessage): Promise<string | null> {
    const session = message.receivedVia ?? message.agentSession;
    if (!session || message.channelId.startsWith('D')) return null;
    if (this.deps.isLocalAgent) return this.deps.isLocalAgent(session) ? session : null;
    const teams = await this.deps.storage.getTeams();
    return teams.some((t) => teamChannelMembers(t).some((m) => m.sessionName === session)) ? session : null;
  }

  /**
   * Put 👀 on the message — one per agent that will receive it.
   *
   * It used to be a single reaction meaning "Crewly got this". The owner
   * reads it as "how many agents saw this", and with several agents in a
   * room that is the more useful answer: three agents who will each weigh a
   * message should show three eyes, and an agent that was not handed the
   * message should show none, so the count is honest rather than "everyone
   * in the channel". Each agent reacts with its own bot.
   *
   * When nobody in particular receives it, or no receiving agent has a bot
   * of its own, one reaction still goes on so the owner can see the message
   * arrived — the 2026-09-21 lesson: no eyes reads as nothing arrived.
   *
   * @param message - The inbound message
   * @param mapping - Its channel mapping
   * @param mentions - Agents @'d in it
   * @param planned - Who will receive it, from the dispatcher; null when unknown
   */
  private async acknowledgeSeen(
    message: SlackIncomingMessage,
    mapping: SlackTeamChannelMapping,
    mentions: readonly string[],
    planned: Map<string, 'required' | 'optional'> | null,
  ): Promise<void> {
    const react = (token?: string) =>
      this.deps.slack.addReaction(message.channelId, message.ts, SLACK_TEAM_CHANNEL_CONSTANTS.INBOUND_REACTION, token);

    let seen = 0;
    const absent: string[] = [];
    for (const session of planned?.keys() ?? []) {
      const token = this.deps.identities?.getInstalled(session)?.botToken;
      if (!token) continue;
      try {
        await react(token);
        seen += 1;
      } catch (err: unknown) {
        const code = describeSlackError(err).code;
        if (code === 'channel_not_found' || code === 'not_in_channel') absent.push(session);
      }
    }
    if (absent.length > 0) {
      // The agent still gets the message; its bot is just not in the room
      // (removed from a private channel after it joined the roster, say).
      this.logger.info('Agent bot not in the channel — no eyes from it', {
        slackChannel: mapping.slackChannelName ?? message.channelId,
        agents: absent,
      });
    }
    if (seen > 0) return;

    // Nobody in particular, or nobody with a bot of their own. In an ad-hoc
    // (often private) channel the master bot may not be a member, so try the
    // agents' bots — @'d ones first — and the master bot last. Only a
    // not-a-member failure is worth another identity: already-reacted, rate
    // limits and a bad ts fail identically for every bot.
    const fallback: Array<string | undefined> = isAdhocMapping(mapping)
      ? [
          ...new Set(
            [...mentions, ...(mapping.members ?? [])]
              .map((m) => this.deps.identities?.getInstalled(m)?.botToken)
              .filter((t): t is string => !!t),
          ),
          undefined,
        ]
      : [undefined];
    let lastError = '';
    for (const token of fallback) {
      try {
        await react(token);
        return;
      } catch (err: unknown) {
        lastError = describeSlackError(err).code;
        if (lastError !== 'channel_not_found') break;
      }
    }
    // Swallowing this outright cost an evening (2026-09-21): cosmetic, so
    // non-fatal, but never silent.
    this.logger.warn('Could not acknowledge the message with a reaction', {
      slackChannel: mapping.slackChannelName ?? message.channelId,
      adhoc: isAdhocMapping(mapping),
      identitiesTried: fallback.length,
      error: lastError,
    });
  }

  /**
   * Any Slack channel becomes routable the moment a local agent's bot is
   * @'d in it, or a message reaches us through a local agent's own app
   * (Slack only delivers to apps that are members, so that proves the bot
   * is in the channel). The owner invited agents from different teams into
   * a private channel, say: a huddle is created for the channel with those
   * agents as members and mapped under the synthetic team id
   * `adhoc:<channel>`. Anything else is left to the caller (orchestrator
   * path).
   *
   * @param message - The inbound message
   * @returns The new mapping, or null when no local agent was @'d
   */
  private async ensureAdhocChannel(message: SlackIncomingMessage): Promise<SlackTeamChannelMapping | null> {
    const teams = await this.deps.storage.getTeams();
    const members = teams.flatMap((t) => teamChannelMembers(t));
    if (members.length === 0) return null;
    if (this.deps.identities) await this.deps.identities.load();
    const candidates: MentionCandidate[] = members.map((m) => ({
      name: m.name,
      sessionName: m.sessionName,
      botUserId: this.deps.identities?.get(m.sessionName)?.botUserId,
    }));
    // Only a real Slack mention of an agent's bot user counts here — a bare
    // "@name" in some unrelated channel must not hijack it.
    const botIds = new Set(candidates.map((c) => c.botUserId).filter((id): id is string => !!id));
    const text = message.text ?? '';
    const mentionedBots = [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]).filter((id) => botIds.has(id));
    const sessions = candidates.filter((c) => c.botUserId && mentionedBots.includes(c.botUserId)).map((c) => c.sessionName);
    // The copy came through a local agent's own app: that agent's bot is in
    // this channel, which makes the channel a room it belongs to even if
    // nobody has addressed it yet.
    const receiving = await this.localReceivingAgent(message);
    if (receiving && !sessions.includes(receiving)) sessions.push(receiving);
    if (sessions.length === 0) return null;

    // The master bot is usually not in this channel (private); the name is
    // best-effort and falls back to the id.
    const info = await this.deps.slack.getChannelInfo(message.channelId).catch(() => null);
    const channelName = info?.name || message.channelId;
    const huddle = this.deps.chat.createHuddle({
      name: `#${channelName}`,
      purpose: `Slack channel #${channelName}`,
      memberSessions: sessions,
      principal: { userId: 'system', source: 'oss' },
    });
    const mapping: SlackTeamChannelMapping = {
      teamId: `${SLACK_TEAM_CHANNEL_CONSTANTS.ADHOC_TEAM_PREFIX}${message.channelId}`,
      slackChannelId: message.channelId,
      slackChannelName: channelName,
      chatChannelId: huddle.id,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      autoCreated: false,
      members: sessions,
    };
    const store = await this.load();
    store.mappings.push(mapping);
    await this.save();
    this.deps.onRoomsChanged?.();
    this.logger.info('Ad-hoc Slack channel linked (agents @\'d outside a team channel)', {
      slackChannel: `#${channelName}`,
      huddle: huddle.id,
      agents: sessions,
    });
    return mapping;
  }

  // -------------------------------------------------------------------------
  // Outbound (huddle → Slack)
  // -------------------------------------------------------------------------

  /**
   * Post an agent's huddle message to the mapped Slack channel under the
   * agent's identity. Called for every chat-v2 `chat_message`; ignores
   * anything that is not an agent message in a mapped huddle.
   *
   * @param dto - The chat-v2 message
   * @returns True when a Slack post was attempted
   */
  async mirrorOutbound(dto: ChatMessageDTO): Promise<boolean> {
    try {
      // Every reason a reply does not reach Slack is logged. Until now all
      // four were silent `return false`, so an agent could answer, be told
      // the reply was delivered, and leave the owner staring at an unanswered
      // thread with nothing in the log to explain it (2026-09-19, #think-tank).
      const skip = (reason: string): false => {
        this.logger.info('Agent reply not mirrored to Slack', {
          reason,
          channelId: dto.channelId,
          sender: dto.senderId,
        });
        return false;
      };
      if (dto.senderType !== 'agent') return skip(`senderType=${dto.senderType}`);
      if (dto.metadata?.source === 'slack') return skip('inbound-from-slack');
      await this.load();
      const mapping = this.findByChatChannelId(dto.channelId);
      if (!mapping) return skip('channel-not-mapped-to-slack');
      if (!this.deps.slack.isConnected()) return skip('slack-not-connected');

      const threadTs = this.resolveOutboundThreadTs(mapping, dto);
      const team = (await this.deps.storage.getTeams()).find((t) => t.id === mapping.teamId);
      const member = team?.members.find((m) => m.sessionName === dto.senderId);
      // A real bot user (Cloud-provisioned identity) beats the cosmetic
      // username/icon override.
      const installed = this.deps.identities?.getInstalled(dto.senderId) ?? null;
      const identity = installed ? { botToken: installed.botToken } : slackIdentityFor(member, dto.senderId);

      const text = await this.linkAgentMentions(toSlackMrkdwn(dto.content), mapping.slackChannelId);
      if (this.deps.typing) {
        const typingKey = { agentSession: dto.senderId, slackChannelId: mapping.slackChannelId, ...(threadTs ? { threadTs } : {}) };
        const typingIdentity = installed
          ? { botToken: installed.botToken, displayName: member?.name ?? dto.senderId }
          : { displayName: member?.name ?? dto.senderId, ...slackIdentityFor(member, dto.senderId) };
        await this.deps.typing.resolve(typingKey, text, typingIdentity);
        // An interim note ("got it — here is the plan"): the agent is still
        // working, so the working-on-it placeholder goes back under it and
        // the real answer replaces that one (owner, 2026-09-24).
        if (isInterim(dto)) await this.deps.typing.begin(typingKey, typingIdentity, 'typing');
        this.logger.info('Agent reply mirrored to Slack', {
          slackChannel: mapping.slackChannelName,
          sender: dto.senderId,
          threaded: Boolean(threadTs),
          via: 'typing-placeholder',
        });
        return true;
      }

      await this.deps.slack.sendMessage({
        channelId: mapping.slackChannelId,
        text,
        threadTs,
        skipChatV2Mirror: true,
        ...identity,
      });
      this.logger.info('Agent reply mirrored to Slack', {
        slackChannel: mapping.slackChannelName,
        sender: dto.senderId,
        threaded: Boolean(threadTs),
      });
      return true;
    } catch (err) {
      this.logger.warn('Outbound mirror to Slack failed', {
        channelId: dto.channelId,
        sender: dto.senderId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Turn `@Name` in an agent's reply into a real Slack mention of that
   * agent's bot user, for every agent of the account with an installed bot
   * — including agents on other machines (the identity cache holds the
   * whole account). Names nobody owns are left as typed.
   *
   * @param text - Reply text
   * @param channelId - Slack channel the text goes to; when two agents share
   *   a first name, the one in this channel is meant
   * @returns Text with `<@Uxxx>` mentions
   */
  async linkAgentMentions(text: string, channelId?: string): Promise<string> {
    if (!text || !text.includes('@')) return text;
    text = await this.linkHumanMentions(text);
    if (!this.deps.identities) return text;
    const store = await this.deps.identities.load();
    const byName = new Map<string, string>();
    // A duplicated first name carries its team in the bot's display name —
    // "Ella (Crewly Marketing)" — while agents write "@Ella" (2026-09-25:
    // Atlas's "@Ella" stayed plain text). Index the bare name too, but only
    // when exactly one agent has it; an ambiguous bare name stays unlinked.
    const bareOwners = new Map<string, Set<string>>();
    const fullNames: Array<{ name: string; id: string }> = [];
    for (const r of store.identities) {
      if (r.status !== 'installed' || !r.botUserId || !r.displayName) continue;
      const full = r.displayName.trim();
      byName.set(full.toLowerCase(), r.botUserId);
      const bare = full.replace(/\s*\([^)]*\)\s*$/u, '').trim();
      if (bare && bare !== full) {
        fullNames.push({ name: full, id: r.botUserId });
        const set = bareOwners.get(bare.toLowerCase()) ?? new Set<string>();
        set.add(r.botUserId);
        bareOwners.set(bare.toLowerCase(), set);
      }
    }
    for (const [bare, ids] of bareOwners) {
      if (byName.has(bare)) continue;
      if (ids.size === 1) {
        byName.set(bare, [...ids][0]);
        continue;
      }
      // Two Ellas (Crewly Marketing / Personal Assistant Team): the one in
      // this channel is meant. Only asked when the text names her.
      if (!channelId || !new RegExp(`@${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(text)) continue;
      // First the room's own roster (agents Crewly put in this channel —
      // no Slack scope needed; agent bots can't read private-channel
      // members), then Slack's member list.
      await this.load();
      const roster = this.rosterBotIds(channelId, store.identities);
      let here = [...ids].filter((id) => roster.has(id));
      if (here.length !== 1) {
        const members = await this.membersOf(channelId);
        here = [...ids].filter((id) => members?.has(id));
      }
      if (here.length === 1) byName.set(bare, here[0]);
    }
    if (byName.size === 0) return text;
    // "@Ella (Crewly Marketing)" written out in full — longest names first.
    for (const { name, id } of fullNames.sort((a, b) => b.name.length - a.name.length)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`(?<![\\w<@])@${escaped}`, 'giu'), `<@${id}>`);
    }
    return text.replace(/(?<![\w<@])@([\p{L}\p{N}_.-]+)/gu, (whole, name: string) => {
      const id = byName.get(name.replace(/[.-]+$/u, '').toLowerCase());
      return id ? `<@${id}>` : whole;
    });
  }

  /**
   * Agent sessions on the Crewly room mapped to a Slack channel — the agents
   * that are in that channel. Empty when the channel isn't mapped (or the
   * store hasn't loaded yet).
   *
   * @param slackChannelId - Slack channel id
   * @returns Agent session names
   */
  rosterSessions(slackChannelId: string): string[] {
    const mapping = this.findBySlackChannelId(slackChannelId);
    const room = mapping ? this.deps.chat.getChannelForBridge(mapping.chatChannelId) : null;
    return (room?.members ?? []).map((m) => m.sessionName);
  }

  /**
   * Bot user ids of the agents on the Crewly room mapped to a Slack channel.
   *
   * @param slackChannelId - Slack channel id
   * @param identities - The account's agent identities
   * @returns Bot user ids (empty when the channel isn't mapped)
   */
  private rosterBotIds(
    slackChannelId: string,
    identities: ReadonlyArray<{ agentSession: string; botUserId?: string | null }>,
  ): Set<string> {
    const sessions = new Set(this.rosterSessions(slackChannelId));
    const ids = new Set<string>();
    for (const r of identities) if (r.botUserId && sessions.has(r.agentSession)) ids.add(r.botUserId);
    return ids;
  }

  /**
   * Members of a Slack channel, cached briefly. Null when Slack can't say.
   *
   * @param channelId - Slack channel id
   * @returns Member user ids, or null
   */
  private async membersOf(channelId: string): Promise<Set<string> | null> {
    const cached = this.channelMembers.get(channelId);
    if (cached && Date.now() - cached.at < SLACK_TEAM_CHANNEL_CONSTANTS.MEMBER_CACHE_TTL_MS) return cached.ids;
    if (!this.deps.slack.listChannelMembers) return null;
    try {
      const ids = new Set(await this.deps.slack.listChannelMembers(channelId));
      this.channelMembers.set(channelId, { at: Date.now(), ids });
      return ids;
    } catch (err) {
      this.logger.warn('Could not list channel members to pick between same-named agents', {
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Remember a person's names so an agent writing `@Their Name` reaches them.
   *
   * @param userId - Slack user id
   * @param names - Real name, handle, … (blanks ignored)
   */
  rememberHuman(userId: string, names: ReadonlyArray<string | undefined>): void {
    for (const n of names) {
      const key = (n ?? '').trim().toLowerCase();
      if (key && key !== userId.toLowerCase()) this.humanNames.set(key, userId);
    }
  }

  /**
   * Turn `@Steve Huang` (a person, possibly a multi-word name) into a real
   * Slack mention. Agents wrote the owner's name and Slack showed plain text —
   * no notification — because only agent bots were ever linked, and only
   * single-word names (2026-09-24). The owner's names are looked up once; any
   * other person is known once they have spoken in a mapped channel.
   *
   * @param text - Reply text
   * @returns Text with `<@Uxxx>` for known people
   */
  private async linkHumanMentions(text: string): Promise<string> {
    if (!this.ownerNamesLoaded) {
      this.ownerNamesLoaded = true;
      const owner = this.deps.getOwnerUserId?.() ?? null;
      if (owner && this.deps.slack.getUserInfo) {
        try {
          const info = await this.deps.slack.getUserInfo(owner);
          this.rememberHuman(owner, [info.realName, info.name]);
        } catch {
          this.ownerNamesLoaded = false; // try again next reply
        }
      }
    }
    if (this.humanNames.size === 0) return text;
    // Longest names first, so "Steve Huang" wins over a person called "Steve".
    const names = [...this.humanNames.keys()].sort((a, b) => b.length - a.length);
    let out = text;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(?<![\\w<@])@${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
      out = out.replace(re, `<@${this.humanNames.get(name)}>`);
    }
    return out;
  }

  /**
   * Which Slack thread an agent reply belongs to: its chat-v2 thread root's
   * `slackThreadTs`; failing that, the latest Slack-origin root in the
   * huddle; failing that, the channel top level.
   */
  /**
   * Show "<agent> is working on it…" in the thread, at the agent's request.
   *
   * Agents that must answer get this placeholder the moment the message
   * arrives. Agents that were only *told* — a message nobody addressed to
   * them, passed along so they can judge whether it concerns them — get none,
   * because a placeholder promises a reply and most of them will not send
   * one. When one of them does decide to answer, it calls this, so the owner
   * sees who has taken the message on: two agents deciding to answer show two
   * placeholders, which is exactly the signal the owner asked for.
   *
   * The key matches the one the reply is mirrored under, so the agent's
   * actual answer replaces the placeholder rather than landing beside it.
   *
   * @param input - Chat channel and thread the agent is answering in
   * @returns Whether a placeholder is now showing, or why not
   */
  async beginWorkingForAgent(input: {
    chatChannelId: string;
    agentSession: string;
    threadId?: string;
  }): Promise<{ ok: true; slackChannelId: string; threadTs?: string } | { ok: false; reason: string }> {
    const mapping = (this.store?.mappings ?? []).find((m) => m.chatChannelId === input.chatChannelId);
    if (!mapping) return { ok: false, reason: 'not_a_slack_channel' };
    if (!this.deps.typing) return { ok: false, reason: 'placeholders_unavailable' };
    if (!this.deps.slack.isConnected()) return { ok: false, reason: 'slack_not_connected' };

    const threadTs = this.resolveOutboundThreadTs(mapping, {
      channelId: input.chatChannelId,
      senderId: input.agentSession,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    } as ChatMessageDTO);

    const team = (await this.deps.storage.getTeams()).find((t) => (t.members ?? []).some((m) => m.sessionName === input.agentSession));
    const member = team?.members.find((m) => m.sessionName === input.agentSession);
    const installed = this.deps.identities?.getInstalled(input.agentSession) ?? null;
    const displayName = member?.name ?? input.agentSession;
    const identity = installed
      ? { botToken: installed.botToken, displayName }
      : { displayName, ...slackIdentityFor(member, input.agentSession) };

    await this.deps.typing.begin(
      { agentSession: input.agentSession, slackChannelId: mapping.slackChannelId, ...(threadTs ? { threadTs } : {}) },
      identity,
      'typing',
    );
    this.logger.info('Agent took a message on', {
      agentSession: input.agentSession,
      slackChannel: mapping.slackChannelName,
      threaded: Boolean(threadTs),
    });
    return { ok: true, slackChannelId: mapping.slackChannelId, ...(threadTs ? { threadTs } : {}) };
  }

  /**
   * Put a file into the Slack channel an agent is replying in.
   *
   * Agents reply through `reply-channel`, which posts a chat-v2 message that
   * the outbound mirror turns into Slack text. That path carries words and
   * nothing else, so an agent asked for a PDF had no way to hand one over:
   * it uploaded to Drive and pasted a link, and when asked why, correctly
   * reported that the interface it was told to use only sends text.
   *
   * This gives it the other half. The agent names the chat channel it
   * already knows — it has no reason to know Slack channel ids — and we
   * resolve the Slack channel, the thread its reply belongs in, and its own
   * bot token, so the file arrives from the same identity as its words
   * rather than from the workspace app.
   *
   * @param input - Chat channel, agent, file and optional caption/thread
   * @returns What was uploaded, or why it could not be
   */
  async attachFileForAgent(input: {
    chatChannelId: string;
    agentSession: string;
    filePath: string;
    filename?: string;
    title?: string;
    comment?: string;
    threadId?: string;
  }): Promise<
    | { ok: true; slackChannelId: string; threadTs?: string; fileId?: string; asAgentBot: boolean }
    | { ok: false; reason: string }
  > {
    const mapping = (this.store?.mappings ?? []).find((m) => m.chatChannelId === input.chatChannelId);
    if (!mapping) return { ok: false, reason: 'not_a_slack_channel' };
    if (!this.deps.slack.isConnected()) return { ok: false, reason: 'slack_not_connected' };

    // Same thread the agent's words go to, so the file lands beside them.
    const threadTs = this.resolveOutboundThreadTs(mapping, {
      channelId: input.chatChannelId,
      senderId: input.agentSession,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    } as ChatMessageDTO);

    const installed = this.deps.identities?.getInstalled(input.agentSession) ?? null;

    try {
      const result = await this.deps.slack.uploadFile({
        channelId: mapping.slackChannelId,
        filePath: input.filePath,
        ...(input.filename ? { filename: input.filename } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.comment ? { initialComment: input.comment } : {}),
        ...(threadTs ? { threadTs } : {}),
        ...(installed ? { botToken: installed.botToken } : {}),
      });
      this.logger.info('Agent attached a file to its Slack channel', {
        agentSession: input.agentSession,
        slackChannel: mapping.slackChannelName,
        threaded: Boolean(threadTs),
        asAgentBot: Boolean(installed),
      });
      return {
        ok: true,
        slackChannelId: mapping.slackChannelId,
        ...(threadTs ? { threadTs } : {}),
        ...(result.fileId ? { fileId: result.fileId } : {}),
        asAgentBot: Boolean(installed),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn('Agent file attach failed', { agentSession: input.agentSession, reason });
      return { ok: false, reason };
    }
  }

  private resolveOutboundThreadTs(mapping: SlackTeamChannelMapping, dto: ChatMessageDTO): string | undefined {
    if (dto.threadId) {
      const root = this.deps.chat.getMessageForBridge(dto.threadId);
      const ts = root?.metadata?.slackThreadTs;
      if (typeof ts === 'string' && ts) return ts;
    }
    const latest = this.deps.chat.findLatestSlackRoot(mapping.chatChannelId);
    const ts = latest?.metadata?.slackThreadTs;
    return typeof ts === 'string' && ts ? ts : undefined;
  }

  // -------------------------------------------------------------------------
  // Agent identities (real bot users)
  // -------------------------------------------------------------------------

  /**
   * Give every member of a mapped team a real Slack identity: ask Cloud for
   * one where missing, announce the owner's install links in the team's
   * channel (once per agent per channel), and invite installed bots into the
   * channel (once). Silent no-op when identities are unavailable (no Cloud
   * login) or the owner has not stored a config token yet.
   *
   * @param team - The team
   * @param mapping - Its channel mapping
   * @returns Counts, for logging and the REST surface
   */
  async ensureIdentities(
    team: Team,
    mapping: SlackTeamChannelMapping,
  ): Promise<{ provisioned: number; announced: number; invited: number; skipped: string | null }> {
    const identities = this.deps.identities;
    const result = { provisioned: 0, announced: 0, invited: 0, skipped: null as string | null };
    if (!identities || !identities.isAvailable()) {
      result.skipped = 'identities unavailable';
      return result;
    }
    await identities.load();
    const pendingLinks: Array<{ name: string; url: string; session: string }> = [];
    for (const member of teamChannelMembers(team)) {
      let record = identities.get(member.sessionName);
      if (!record || record.status !== 'installed') {
        try {
          record = await identities.provision(member.sessionName, member.name, `${member.name} — ${member.role} on ${team.name} (Crewly)`);
          result.provisioned += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // A missing/invalid config token stops the whole pass — every
          // member would fail the same way. Anything else is per-member.
          if (/config_token|not_configured|not_logged_in/i.test(message) || /config(uration)? token/i.test(message)) {
            this.logger.info('Agent identities skipped', { reason: message });
            result.skipped = message;
            break;
          }
          this.logger.warn('Could not provision Slack identity', { agent: member.sessionName, error: message });
          continue;
        }
      }
      if (record.status === 'pending_install' && record.installUrl && !record.announcedIn.includes(mapping.slackChannelId)) {
        pendingLinks.push({ name: member.name, url: record.installUrl, session: member.sessionName });
      }
      if (record.status === 'installed' && record.botUserId && !record.invitedTo.includes(mapping.slackChannelId)) {
        if (await this.inviteBot(mapping, member.sessionName, record.botUserId)) result.invited += 1;
      }
    }
    if (pendingLinks.length > 0) {
      const lines = pendingLinks.map((p) => `• *${p.name}* → <${p.url}|安装 ${p.name}>`);
      await this.deps.slack
        .sendMessage({
          channelId: mapping.slackChannelId,
          text: [
            `:id: 给 *${team.name}* 的 ${pendingLinks.length} 位成员创建了 Slack 身份，点一下安装（每个各一次）：`,
            ...lines,
            '_安装后它们会以自己的名字出现在成员列表里，可以直接 @。_',
          ].join('\n'),
          skipChatV2Mirror: true,
        })
        .then(async () => {
          for (const p of pendingLinks) await identities.markChannel(p.session, { announcedIn: mapping.slackChannelId });
          result.announced = pendingLinks.length;
        })
        .catch((err: unknown) => {
          this.logger.warn('Could not announce install links', { error: err instanceof Error ? err.message : String(err) });
        });
    }
    return result;
  }

  /**
   * Invite a newly installed agent bot into every channel of every team it
   * belongs to. Runs from the identity service's `onInstalled` hook.
   *
   * @param agentSession - The agent that just got its bot user
   */
  async inviteInstalledEverywhere(agentSession: string): Promise<void> {
    const identities = this.deps.identities;
    if (!identities) return;
    const record = identities.get(agentSession);
    if (!record?.botUserId) return;
    await this.load();
    const teams = await this.deps.storage.getTeams();
    for (const team of teams) {
      if (!teamChannelMembers(team).some((m) => m.sessionName === agentSession)) continue;
      const mapping = this.findByTeamId(team.id);
      if (!mapping || record.invitedTo.includes(mapping.slackChannelId)) continue;
      await this.inviteBot(mapping, agentSession, record.botUserId);
    }
    // Channels Crewly created for a set of agents (ensureAgentChannel).
    for (const mapping of this.store?.mappings ?? []) {
      if (!isAdhocMapping(mapping) || !mapping.autoCreated) continue;
      if (!(mapping.members ?? []).includes(agentSession) || record.invitedTo.includes(mapping.slackChannelId)) continue;
      await this.inviteBot(mapping, agentSession, record.botUserId);
    }
  }

  /** Invite one bot user into a mapped channel and remember it. */
  private async inviteBot(mapping: SlackTeamChannelMapping, agentSession: string, botUserId: string): Promise<boolean> {
    try {
      await this.deps.slack.inviteToChannel(mapping.slackChannelId, [botUserId]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/already_in_channel/.test(message)) {
        this.logger.warn('Could not invite agent bot into channel', { agentSession, channel: mapping.slackChannelName, error: message });
        return false;
      }
    }
    await this.deps.identities?.markChannel(agentSession, { invitedTo: mapping.slackChannelId });
    this.logger.info('Agent bot invited into team channel', { agentSession, channel: `#${mapping.slackChannelName}` });
    return true;
  }

  // -------------------------------------------------------------------------
  // Slack-side messages
  // -------------------------------------------------------------------------

  private async postWelcome(
    mapping: SlackTeamChannelMapping,
    team: Team,
    members: TeamMember[],
  ): Promise<void> {
    const roster =
      members.length > 0
        ? members.map((m) => `• *${m.name}* (${m.role}) — \`@${m.name}\``).join('\n')
        : '_（还没有成员，成员加入后会自动同步）_';
    const text = [
      `:tada: 团队 *${team.name}* 的频道已就绪。`,
      '',
      '成员：',
      roster,
      '',
      '直接发言，全队都能看到；`@名字` 可以点名某个 agent 必须回复。回复会以各自的名字出现在 thread 里。',
    ].join('\n');
    await this.deps.slack
      .sendMessage({ channelId: mapping.slackChannelId, text, skipChatV2Mirror: true })
      .catch((err: unknown) => {
        this.logger.debug('Welcome message failed (non-critical)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private async postUnknownMentionHint(
    message: SlackIncomingMessage,
    unknown: Array<{ token: string; suggestions: string[] }>,
    candidates: MentionCandidate[],
  ): Promise<void> {
    const lines = unknown.map((u) =>
      u.suggestions.length > 0
        ? `没有叫 \`@${u.token}\` 的成员，你是想找 ${u.suggestions.map((s) => `\`@${s}\``).join(' / ')} 吗？`
        : `没有叫 \`@${u.token}\` 的成员。`,
    );
    const rosterHint =
      candidates.length > 0
        ? `本频道的成员：${candidates.map((c) => `\`@${c.name}\``).join(' ')}`
        : '本频道目前没有成员。';
    await this.deps.slack
      .sendMessage({
        channelId: message.channelId,
        threadTs: message.threadTs || message.ts,
        text: `${lines.join('\n')}\n${rosterHint}\n_（消息已经发给全队；只有被正确 @ 的成员会被要求必须回复。）_`,
        skipChatV2Mirror: true,
      })
      .catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Run `fn` after any in-flight operation for the same team finishes. */
  private serialised<T>(teamId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.inflight.get(teamId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.inflight.set(teamId, next);
    const cleanup = (): void => {
      if (this.inflight.get(teamId) === next) this.inflight.delete(teamId);
    };
    // `then(cleanup, cleanup)` rather than `finally`: a rejected `next` is
    // returned to the caller, and a second derived promise must not turn
    // that same rejection into an unhandled one.
    next.then(cleanup, cleanup);
    return next;
  }
}

/** Type guard for persisted mapping rows. */
function isMapping(value: unknown): value is SlackTeamChannelMapping {
  const v = value as Partial<SlackTeamChannelMapping> | null;
  return (
    !!v &&
    typeof v.teamId === 'string' &&
    typeof v.slackChannelId === 'string' &&
    typeof v.chatChannelId === 'string'
  );
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: SlackTeamChannelService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The configured service
 */
export function setSlackTeamChannelService(service: SlackTeamChannelService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before the composition root wires it
 * (e.g. Slack not configured).
 *
 * @returns The service or null
 */
export function getSlackTeamChannelService(): SlackTeamChannelService | null {
  return instance;
}
