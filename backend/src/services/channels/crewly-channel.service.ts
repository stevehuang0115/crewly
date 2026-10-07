/**
 * Crewly Channel Service
 *
 * A Crewly channel is a named room whose members are agents from any team —
 * the Slack channel concept, next to teams. Every channel is a chat-v2 huddle
 * (so routing, threads and replies are the huddle's), and its id is the
 * huddle id. When Slack is connected the channel is one Slack channel:
 *
 *   Crewly → Slack: creating a channel creates the Slack channel and invites
 *     the owner and each member's bot; adding/removing a member invites/removes
 *     its bot; renaming renames the Slack channel (Slack's normalised name is
 *     what Crewly shows); archiving archives it (or, for a channel found in
 *     Slack, takes the bots out).
 *   Slack → Crewly: a Slack channel agent bots were invited to (an ad-hoc room
 *     of the team-channel service) shows up as a channel automatically; its
 *     name and members follow Slack on the periodic/lazy refresh.
 *
 * The Slack side lives in {@link SlackTeamChannelService} (ad-hoc rooms);
 * this service owns the registry (`~/.crewly/crewly-channels.json`) and the
 * owner-facing operations. Without Slack, channels are Crewly-only huddles.
 *
 * @module services/channels/crewly-channel.service
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { CREWLY_CHANNEL_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import type { ChatV2Service } from '../chat-v2/chat-v2.service.js';
import type { Team } from '../../types/index.js';
import {
  isAdhocMapping,
  slackChannelNameFor,
  teamChannelMembers,
  type RoomMembershipChange,
  type SlackTeamChannelService,
} from '../slack/slack-team-channel.service.js';
import {
  isCrewlyChannelRecord,
  type CrewlyChannelDTO,
  type CrewlyChannelMember,
  type CrewlyChannelRecord,
  type CrewlyChannelsFile,
} from '../../types/crewly-channel.types.js';

/** The chat-v2 slice this service uses. */
export type CrewlyChannelChatApi = Pick<
  ChatV2Service,
  | 'createHuddle'
  | 'setHuddleMembers'
  | 'getChannelForBridge'
  | 'archiveChannelForBridge'
  | 'queryHuddleMembersForDispatch'
  | 'renameChannelForBridge'
  | 'setSharedChannelResolver'
>;

/** The Slack ad-hoc room slice this service uses. */
export type CrewlyChannelRoomsApi = Pick<
  SlackTeamChannelService,
  | 'isConnected'
  | 'listMappings'
  | 'findByChatChannelId'
  | 'ensureAgentChannel'
  | 'setRoomMembers'
  | 'renameRoom'
  | 'archiveRoom'
  | 'syncRoomsFromSlack'
>;

/** An agent that can be put in a channel. */
export interface CrewlyChannelAgent {
  sessionName: string;
  name: string;
  teamId: string;
  teamName: string;
}

/** Constructor dependencies. */
export interface CrewlyChannelServiceDeps {
  chat: CrewlyChannelChatApi;
  /** The Slack room service, or null while Slack is not set up (resolved on every call). */
  getRooms: () => CrewlyChannelRoomsApi | null;
  /** Every agent of every team on this machine. */
  listAgents: () => Promise<CrewlyChannelAgent[]>;
  /** Registry path; defaults to `<CREWLY_HOME>/crewly-channels.json`. */
  storePath?: string;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Error with an HTTP status for the REST layer. */
export class CrewlyChannelError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code: 'validation_error' | 'not_found' | 'conflict' | 'slack_error',
  ) {
    super(message);
    this.name = 'CrewlyChannelError';
  }
}

/** Member-change result returned to the REST layer. */
export interface CrewlyChannelMembershipResult {
  channel: CrewlyChannelDTO;
  change: RoomMembershipChange;
}

/** Placeholder rosters bridges put in a huddle that has no real member yet. */
const PLACEHOLDER_MEMBER = /^(team|channel):/;
const SYSTEM_PRINCIPAL = { userId: 'system', source: 'oss' as const };

/**
 * Owner-facing Crewly channels: list, create, rename, members, archive.
 */
export class CrewlyChannelService {
  private readonly deps: CrewlyChannelServiceDeps;
  private readonly storePath: string;
  private readonly logger: ComponentLogger;
  private store: CrewlyChannelsFile | null = null;
  private loading: Promise<CrewlyChannelsFile> | null = null;
  private lastSlackRefresh = 0;
  private refreshing: Promise<void> | null = null;

  constructor(deps: CrewlyChannelServiceDeps) {
    this.deps = deps;
    this.storePath = deps.storePath ?? path.join(getCrewlyHomePath(), CREWLY_CHANNEL_CONSTANTS.STORE_FILENAME);
    this.logger = LoggerService.getInstance().createComponentLogger('CrewlyChannels');
  }

  /**
   * Load the registry and open Crewly channels to the owner in chat-v2
   * (they are created under the `'system'` owner). Idempotent.
   */
  async start(): Promise<void> {
    await this.load();
    this.deps.chat.setSharedChannelResolver((id) => this.isChannel(id));
  }

  /**
   * Whether a chat-v2 channel id is a live Crewly channel (sync — the chat
   * read path asks on every request).
   *
   * @param chatChannelId - chat-v2 channel id
   * @returns True for a registered, non-archived channel or a Slack room
   */
  isChannel(chatChannelId: string): boolean {
    const rec = this.store?.channels.find((c) => c.id === chatChannelId);
    if (rec) return !rec.archivedAt;
    const mapping = this.deps.getRooms()?.findByChatChannelId(chatChannelId);
    return !!mapping && isAdhocMapping(mapping);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Every channel, with members and Slack link. Picks up Slack rooms found
   * since the last call; at most once a minute it also asks Slack for
   * renames and new members (in the background — this call does not wait).
   *
   * @param options - `member` (session) to list only that agent's channels; `includeArchived`
   * @returns Channels, newest first
   */
  async list(options: { member?: string; includeArchived?: boolean } = {}): Promise<CrewlyChannelDTO[]> {
    await this.reconcile();
    this.refreshInBackground();
    const agents = await this.agentIndex();
    const out = (this.store?.channels ?? [])
      .filter((c) => options.includeArchived || !c.archivedAt)
      .map((c) => this.toDTO(c, agents))
      .filter((c) => !options.member || c.members.some((m) => m.sessionName === options.member));
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * One channel by id, `#name`, name or Slack channel id.
   *
   * @param ref - What to look for
   * @returns The channel
   * @throws CrewlyChannelError 404 when no live channel matches
   */
  async get(ref: string): Promise<CrewlyChannelDTO> {
    await this.reconcile();
    return this.toDTO(this.requireRecord(ref), await this.agentIndex());
  }

  /**
   * Ask Slack now for renames and new members, then return the list.
   *
   * @returns Channels after the refresh
   */
  async refresh(): Promise<CrewlyChannelDTO[]> {
    await this.refreshFromSlack();
    return this.list();
  }

  // -------------------------------------------------------------------------
  // Mutations (owner only — enforced by the routes)
  // -------------------------------------------------------------------------

  /**
   * Create a channel. With Slack connected the Slack channel is created (or
   * an existing one of that name reused), the owner and the members' bots
   * are invited; without Slack it is a Crewly-only channel.
   *
   * @param input - Name (normalised the Slack way), optional purpose, agent sessions from any team
   * @returns The channel
   * @throws CrewlyChannelError 400 on a bad name/roster, 409 on a name in use, 502 when Slack refuses
   */
  async create(input: { name: string; purpose?: string; memberSessions: string[] }): Promise<CrewlyChannelDTO> {
    const name = this.normaliseName(input.name);
    const purpose = this.validatePurpose(input.purpose);
    const members = await this.validateMembers(input.memberSessions, { min: 1 });
    await this.reconcile();
    this.assertNameFree(name);
    const store = await this.load();
    const rooms = this.deps.getRooms();
    let record: CrewlyChannelRecord;
    if (rooms?.isConnected()) {
      let mapping;
      try {
        mapping = await rooms.ensureAgentChannel({
          name,
          purpose: purpose ?? CREWLY_CHANNEL_CONSTANTS.DEFAULT_PURPOSE,
          memberSessions: members,
          applyPrefix: false,
        });
      } catch (err) {
        throw new CrewlyChannelError(`Slack could not create #${name}: ${err instanceof Error ? err.message : String(err)}`, 502, 'slack_error');
      }
      record = {
        id: mapping.chatChannelId,
        name: mapping.slackChannelName,
        ...(purpose ? { purpose } : {}),
        slackChannelId: mapping.slackChannelId,
        origin: 'crewly',
        createdAt: this.nowIso(),
      };
    } else {
      const huddle = this.deps.chat.createHuddle({
        name: `#${name}`,
        purpose: purpose ?? CREWLY_CHANNEL_CONSTANTS.DEFAULT_PURPOSE,
        memberSessions: members,
        principal: SYSTEM_PRINCIPAL,
      });
      record = { id: huddle.id, name, ...(purpose ? { purpose } : {}), origin: 'crewly', createdAt: this.nowIso() };
    }
    store.channels = store.channels.filter((c) => c.id !== record.id);
    store.channels.push(record);
    await this.save();
    this.logger.info('Channel created', { id: record.id, name: record.name, slack: record.slackChannelId ?? null, members });
    return this.toDTO(record, await this.agentIndex());
  }

  /**
   * Rename a channel. A linked Slack channel is renamed first; Crewly then
   * shows the name Slack applied.
   *
   * @param ref - Channel id / name
   * @param rawName - The new name
   * @returns The channel
   * @throws CrewlyChannelError 400/404/409, 502 when Slack refuses
   */
  async rename(ref: string, rawName: string): Promise<CrewlyChannelDTO> {
    await this.reconcile();
    const record = this.requireRecord(ref);
    const name = this.normaliseName(rawName);
    if (name !== record.name) this.assertNameFree(name, record.id);
    let applied = name;
    const rooms = this.deps.getRooms();
    if (record.slackChannelId && rooms) {
      try {
        applied = await rooms.renameRoom(record.slackChannelId, name);
      } catch (err) {
        throw new CrewlyChannelError(err instanceof Error ? err.message : String(err), 502, 'slack_error');
      }
    } else {
      this.deps.chat.renameChannelForBridge(record.id, `#${applied}`);
    }
    record.name = applied;
    await this.save();
    return this.toDTO(record, await this.agentIndex());
  }

  /**
   * Add one agent (any team).
   *
   * @param ref - Channel id / name
   * @param sessionName - The agent's session
   * @returns The channel and what Slack did
   */
  async addMember(ref: string, sessionName: string): Promise<CrewlyChannelMembershipResult> {
    await this.reconcile();
    const record = this.requireRecord(ref);
    const [session] = await this.validateMembers([sessionName], { min: 1 });
    const current = this.memberSessions(record.id);
    if (current.includes(session)) {
      return { channel: this.toDTO(record, await this.agentIndex()), change: emptyChange() };
    }
    if (current.length >= CREWLY_CHANNEL_CONSTANTS.MAX_MEMBERS) {
      throw new CrewlyChannelError(`A channel holds at most ${CREWLY_CHANNEL_CONSTANTS.MAX_MEMBERS} agents`, 400, 'validation_error');
    }
    return this.setMembers(record, [...current, session]);
  }

  /**
   * Remove one agent.
   *
   * @param ref - Channel id / name
   * @param sessionName - The agent's session
   * @returns The channel and what Slack did
   */
  async removeMember(ref: string, sessionName: string): Promise<CrewlyChannelMembershipResult> {
    await this.reconcile();
    const record = this.requireRecord(ref);
    const current = this.memberSessions(record.id);
    if (!current.includes(sessionName)) {
      throw new CrewlyChannelError(`${sessionName} is not in #${record.name}`, 404, 'not_found');
    }
    return this.setMembers(record, current.filter((s) => s !== sessionName));
  }

  /**
   * Archive a channel. A Slack channel Crewly created is archived too; one
   * found in Slack is left to its people (the agents' bots leave it).
   *
   * @param ref - Channel id / name
   * @returns The archived channel
   */
  async archive(ref: string): Promise<CrewlyChannelDTO> {
    await this.reconcile();
    const record = this.requireRecord(ref);
    const rooms = this.deps.getRooms();
    if (record.slackChannelId && rooms) {
      await rooms.archiveRoom(record.slackChannelId, { archiveSlackChannel: record.origin === 'crewly' });
    }
    this.deps.chat.archiveChannelForBridge(record.id);
    record.archivedAt = this.nowIso();
    await this.save();
    this.logger.info('Channel archived', { id: record.id, name: record.name });
    return this.toDTO(record, await this.agentIndex());
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async setMembers(record: CrewlyChannelRecord, sessions: string[]): Promise<CrewlyChannelMembershipResult> {
    const rooms = this.deps.getRooms();
    let change: RoomMembershipChange;
    if (record.slackChannelId && rooms) {
      change = await rooms.setRoomMembers(record.slackChannelId, sessions);
    } else {
      const diff = this.deps.chat.setHuddleMembers(record.id, sessions);
      change = { ...emptyChange(), added: diff.added, removed: diff.removed };
    }
    return { channel: this.toDTO(record, await this.agentIndex()), change };
  }

  /**
   * Bring the registry in step with the Slack rooms: a room not yet listed
   * becomes a channel (origin `slack`); a listed one takes its current Slack
   * name; a channel whose room is gone loses the link (or is archived when
   * its huddle was archived).
   */
  private async reconcile(): Promise<void> {
    const store = await this.load();
    const rooms = this.deps.getRooms();
    if (!rooms) return;
    const mappings = (await rooms.listMappings()).filter((m) => isAdhocMapping(m));
    let changed = false;
    for (const m of mappings) {
      const rec = store.channels.find((c) => c.id === m.chatChannelId);
      if (!rec) {
        store.channels.push({
          id: m.chatChannelId,
          name: m.slackChannelName,
          slackChannelId: m.slackChannelId,
          origin: m.autoCreated ? 'crewly' : 'slack',
          createdAt: m.createdAt,
        });
        changed = true;
        this.logger.info('Slack channel found — listed as a Crewly channel', { name: m.slackChannelName, members: m.members ?? [] });
        continue;
      }
      if (rec.name !== m.slackChannelName || rec.slackChannelId !== m.slackChannelId) {
        rec.name = m.slackChannelName;
        rec.slackChannelId = m.slackChannelId;
        changed = true;
      }
    }
    const linked = new Set(mappings.map((m) => m.chatChannelId));
    for (const rec of store.channels) {
      if (rec.archivedAt || !rec.slackChannelId || linked.has(rec.id)) continue;
      const huddle = this.deps.chat.getChannelForBridge(rec.id);
      if (!huddle || huddle.archivedAt) rec.archivedAt = this.nowIso();
      else delete rec.slackChannelId;
      changed = true;
    }
    if (changed) await this.save();
  }

  /** Throttled background Slack refresh (names + members). */
  private refreshInBackground(): void {
    const now = this.deps.now?.().getTime() ?? Date.now();
    if (this.refreshing || now - this.lastSlackRefresh < CREWLY_CHANNEL_CONSTANTS.SLACK_REFRESH_MIN_INTERVAL_MS) return;
    this.lastSlackRefresh = now;
    void this.refreshFromSlack();
  }

  private refreshFromSlack(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const rooms = this.deps.getRooms();
    if (!rooms) return Promise.resolve();
    this.refreshing = rooms
      .syncRoomsFromSlack()
      .then(() => this.reconcile())
      .catch((err: unknown) => {
        this.logger.warn('Channel refresh from Slack failed (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private requireRecord(ref: string): CrewlyChannelRecord {
    const key = (ref ?? '').trim();
    const name = key.replace(/^#/, '').toLowerCase();
    const live = (this.store?.channels ?? []).filter((c) => !c.archivedAt);
    const rec =
      live.find((c) => c.id === key) ??
      live.find((c) => c.slackChannelId === key) ??
      live.find((c) => c.name.toLowerCase() === name);
    if (!rec) throw new CrewlyChannelError(`No channel ${key}`, 404, 'not_found');
    return rec;
  }

  private memberSessions(chatChannelId: string): string[] {
    return this.deps.chat.queryHuddleMembersForDispatch(chatChannelId).filter((s) => !PLACEHOLDER_MEMBER.test(s));
  }

  private normaliseName(raw: string): string {
    const trimmed = (raw ?? '').trim().replace(/^#/, '');
    if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) {
      throw new CrewlyChannelError('name is required', 400, 'validation_error');
    }
    return slackChannelNameFor(trimmed);
  }

  private validatePurpose(raw: string | undefined): string | undefined {
    const purpose = (raw ?? '').trim();
    if (purpose.length > CREWLY_CHANNEL_CONSTANTS.MAX_PURPOSE_LENGTH) {
      throw new CrewlyChannelError(`purpose exceeds ${CREWLY_CHANNEL_CONSTANTS.MAX_PURPOSE_LENGTH} characters`, 400, 'validation_error');
    }
    return purpose || undefined;
  }

  private async validateMembers(raw: string[] | undefined, opts: { min: number }): Promise<string[]> {
    const sessions = [...new Set((Array.isArray(raw) ? raw : []).map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean))];
    if (sessions.length < opts.min) throw new CrewlyChannelError('pick at least one agent', 400, 'validation_error');
    if (sessions.length > CREWLY_CHANNEL_CONSTANTS.MAX_MEMBERS) {
      throw new CrewlyChannelError(`A channel holds at most ${CREWLY_CHANNEL_CONSTANTS.MAX_MEMBERS} agents`, 400, 'validation_error');
    }
    const known = new Set((await this.deps.listAgents()).map((a) => a.sessionName));
    const unknown = sessions.filter((s) => !known.has(s));
    if (unknown.length > 0) throw new CrewlyChannelError(`Unknown agent: ${unknown.join(', ')}`, 400, 'validation_error');
    return sessions;
  }

  private assertNameFree(name: string, exceptId?: string): void {
    const taken = (this.store?.channels ?? []).some((c) => !c.archivedAt && c.id !== exceptId && c.name === name);
    if (taken) throw new CrewlyChannelError(`#${name} already exists`, 409, 'conflict');
  }

  private async agentIndex(): Promise<Map<string, CrewlyChannelAgent>> {
    const agents = await this.deps.listAgents().catch(() => [] as CrewlyChannelAgent[]);
    return new Map(agents.map((a) => [a.sessionName, a]));
  }

  private toDTO(rec: CrewlyChannelRecord, agents: Map<string, CrewlyChannelAgent>): CrewlyChannelDTO {
    const members: CrewlyChannelMember[] = this.memberSessions(rec.id).map((sessionName) => {
      const a = agents.get(sessionName);
      return a ? { sessionName, name: a.name, teamId: a.teamId, teamName: a.teamName } : { sessionName };
    });
    return {
      id: rec.id,
      name: rec.name,
      ...(rec.purpose ? { purpose: rec.purpose } : {}),
      origin: rec.origin,
      createdAt: rec.createdAt,
      ...(rec.archivedAt ? { archivedAt: rec.archivedAt } : {}),
      slack: rec.slackChannelId ? { channelId: rec.slackChannelId, channelName: rec.name } : null,
      members,
    };
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private async load(): Promise<CrewlyChannelsFile> {
    if (this.store) return this.store;
    if (!this.loading) {
      this.loading = safeReadJson<CrewlyChannelsFile>(this.storePath, { version: 1, channels: [] })
        .then((raw) => {
          const store: CrewlyChannelsFile = {
            version: 1,
            channels: Array.isArray(raw?.channels) ? raw.channels.filter(isCrewlyChannelRecord) : [],
          };
          this.store = store;
          return store;
        })
        .catch((err: unknown) => {
          this.loading = null;
          throw err;
        });
    }
    return this.loading;
  }

  private async save(): Promise<void> {
    const store = await this.load();
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await atomicWriteJson(this.storePath, store);
  }
}

/**
 * Every agent that can join a channel: the members of every live team, with
 * their team (an agent on two teams is listed once, under its first team).
 *
 * @param teams - Teams from storage
 * @returns Agents
 */
export function agentsFromTeams(teams: Team[]): CrewlyChannelAgent[] {
  const seen = new Set<string>();
  const out: CrewlyChannelAgent[] = [];
  for (const team of teams) {
    if (team.archived) continue;
    for (const m of teamChannelMembers(team)) {
      if (seen.has(m.sessionName)) continue;
      seen.add(m.sessionName);
      out.push({ sessionName: m.sessionName, name: m.name, teamId: team.id, teamName: team.name });
    }
  }
  return out;
}

/** A membership change with nothing in it. */
function emptyChange(): RoomMembershipChange {
  return { added: [], removed: [], invited: [], notInvited: [], removedFromSlack: [], stillInSlack: [] };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: CrewlyChannelService | null = null;

/**
 * Install the process-wide instance (composition root).
 *
 * @param service - The configured service, or null to clear
 */
export function setCrewlyChannelService(service: CrewlyChannelService | null): void {
  instance = service;
}

/**
 * The process-wide instance, or null before the composition root wires it.
 *
 * @returns The service or null
 */
export function getCrewlyChannelService(): CrewlyChannelService | null {
  return instance;
}
