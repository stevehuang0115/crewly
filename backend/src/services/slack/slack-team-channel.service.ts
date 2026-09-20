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

import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';
import * as path from 'path';
import { promises as fs } from 'fs';
import type { Team, TeamMember } from '../../types/index.js';
import type {
  SlackIncomingMessage,
  SlackOutgoingMessage,
  SlackTeamChannelMapping,
  SlackTeamChannelsFile,
  SlackChannelInfo,
} from '../../types/slack.types.js';
import type { ChatMessageDTO } from '../chat-v2/types.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import type {
  ChatV2DispatcherService,
  DispatchMessageResult,
} from '../chat-v2/chat-v2.dispatcher.service.js';
import type { StorageEvent } from '../core/storage.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getSlackDirectoryService } from './slack-directory.service.js';
import { SLACK_TEAM_CHANNEL_CONSTANTS } from '../../constants.js';
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
export type TeamChannelDispatcherApi = Pick<ChatV2DispatcherService, 'dispatchMessage'>;

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
  /** Clock override for tests. */
  now?: () => Date;
}

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
    if (typeof patch.channelPrefix === 'string') s.channelPrefix = patch.channelPrefix.trim();
    await this.save();
    return this.getSettings();
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
        const owner = this.deps.getOwnerUserId?.() ?? null;
        if (owner) {
          await this.deps.slack.inviteToChannel(channel.id, [owner]).catch((err: unknown) => {
            this.logger.warn('Could not invite the owner into the new channel — search for it in Slack and join', {
              channel: channel.name,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } else {
          this.logger.info('New channel created; no owner id known to invite — search for it in Slack and join', {
            channel: channel.name,
          });
        }
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
    let mapping = this.findBySlackChannelId(message.channelId);
    if (!mapping) mapping = await this.ensureAdhocChannel(message);
    if (!mapping) return null;

    // One Slack message can reach us twice with different event types
    // (`app_mention` for an @'d agent's app plus `message.channels`); the
    // team must see it once — a second copy is acknowledged, not dispatched.
    const seenKey = `${message.channelId}:${message.ts}`;
    const seen = this.seenInbound.get(seenKey);
    if (seen) {
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
        ...(remoteAgent ? { remoteAgentSession: remoteAgent } : {}),
      },
    };
    const persisted: ChatMessageDTO = localAuthor
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

    // In an ad-hoc (often private) channel the master bot may not be a
    // member; an agent's own bot reacts instead — the first @'d agent, or
    // (nobody @'d, e.g. "@Crewly who leads content?") any agent already in
    // the huddle, whose bot is by definition in the channel.
    const reactAs = isAdhocMapping(mapping)
      ? [...resolved.mentions, ...(mapping.members ?? [])]
          .map((m) => this.deps.identities?.getInstalled(m)?.botToken)
          .find((t): t is string => !!t)
      : undefined;
    await this.deps.slack
      .addReaction(message.channelId, message.ts, SLACK_TEAM_CHANNEL_CONSTANTS.INBOUND_REACTION, reactAs)
      .catch(() => undefined);

    // Ad-hoc channels grow their huddle as new agents get @'d there.
    if (isAdhocMapping(mapping) && resolved.mentions.length > 0) {
      const next = [...new Set([...(mapping.members ?? []), ...resolved.mentions])];
      if (next.length !== (mapping.members ?? []).length) {
        mapping.members = next;
        this.deps.chat.setHuddleMembers(mapping.chatChannelId, next);
        await this.save();
      }
    }

    // @'d agents must reply: show the honest state in the thread for each
    // one that has its own bot — "waking up…" for an idle agent (a cold
    // start is 1–2 minutes), "is working on it…" once it holds the message.
    // Who will be asked to reply: the @'d members, or (nobody @'d, top-level
    // message) the team leader alone. Mirrors the dispatcher's targeting so
    // the placeholder matches who actually gets the message.
    const typingTargets: Array<{ session: string; key: { agentSession: string; slackChannelId: string; threadTs: string } }> = [];
    if (this.deps.typing) {
      let sessions = resolved.mentions;
      if (sessions.length === 0 && !message.threadTs && team) {
        // Same rule as the dispatcher's huddleLeaderFor: the team leader, else the first member.
        const leader = members.find((m) => String(m.role) === 'team-leader' || String(m.role) === 'tech-lead') ?? members[0];
        if (leader) sessions = [leader.sessionName];
      }
      for (const session of sessions) {
        const member = members.find((m) => m.sessionName === session);
        const installed = this.deps.identities?.getInstalled(session);
        // Own bot when installed; otherwise the master bot wearing the agent's
        // name/icon — the person should see *something* during a cold start.
        const identity = installed
          ? { botToken: installed.botToken, displayName: member?.name ?? session }
          : { displayName: member?.name ?? session, ...slackIdentityFor(member, session) };
        const key = { agentSession: session, slackChannelId: message.channelId, threadTs: slackThreadTs };
        const awake = this.deps.isAgentAwake ? this.deps.isAgentAwake(session) : true;
        await this.deps.typing.begin(key, identity, awake ? 'typing' : 'waking');
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
      dispatch = await dispatcher.dispatchMessage(channel, persisted, {
        threadId: threadId ?? persisted.id,
        replyVia: 'reply-channel',
        ...(roster ? { channelRoster: roster } : {}),
        // A local agent's own message (fanned out to the colleagues it @'d)
        // must not come back to its author.
        ...(remoteAgent ? { excludeSessions: [remoteAgent] } : {}),
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
      unknown: resolved.unknown.map((u) => u.token),
      strategy: dispatch?.strategy ?? 'none',
      threaded: !!threadId,
    });

    return { mapping, message: persisted, mentions: resolved.mentions, dispatch };
  }

  /**
   * Any Slack channel becomes routable the moment a local agent's bot is
   * @'d in it (the owner invited agents from different teams into a private
   * channel, say): a huddle is created for the channel with the @'d agents
   * as members and mapped under the synthetic team id `adhoc:<channel>`.
   * Messages that @ nobody local are left to the caller (orchestrator path).
   *
   * @param message - The inbound message
   * @returns The new mapping, or null when no local agent was @'d
   */
  private async ensureAdhocChannel(message: SlackIncomingMessage): Promise<SlackTeamChannelMapping | null> {
    if (!message.text || !message.text.includes('<@') && !message.text.includes('@')) return null;
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
    const mentionedBots = [...message.text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]).filter((id) => botIds.has(id));
    if (mentionedBots.length === 0) return null;
    const sessions = candidates.filter((c) => c.botUserId && mentionedBots.includes(c.botUserId)).map((c) => c.sessionName);

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

      const text = await this.linkAgentMentions(toSlackMrkdwn(dto.content));
      if (this.deps.typing) {
        await this.deps.typing.resolve(
          { agentSession: dto.senderId, slackChannelId: mapping.slackChannelId, ...(threadTs ? { threadTs } : {}) },
          text,
          installed
            ? { botToken: installed.botToken, displayName: member?.name ?? dto.senderId }
            : { displayName: member?.name ?? dto.senderId, ...slackIdentityFor(member, dto.senderId) },
        );
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
   * @returns Text with `<@Uxxx>` mentions
   */
  async linkAgentMentions(text: string): Promise<string> {
    if (!text || !text.includes('@') || !this.deps.identities) return text;
    const store = await this.deps.identities.load();
    const byName = new Map<string, string>();
    for (const r of store.identities) {
      if (r.status === 'installed' && r.botUserId && r.displayName) byName.set(r.displayName.toLowerCase(), r.botUserId);
    }
    if (byName.size === 0) return text;
    return text.replace(/(?<![\w<@])@([\p{L}\p{N}_.-]+)/gu, (whole, name: string) => {
      const id = byName.get(name.replace(/[.-]+$/u, '').toLowerCase());
      return id ? `<@${id}>` : whole;
    });
  }

  /**
   * Which Slack thread an agent reply belongs to: its chat-v2 thread root's
   * `slackThreadTs`; failing that, the latest Slack-origin root in the
   * huddle; failing that, the channel top level.
   */
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
