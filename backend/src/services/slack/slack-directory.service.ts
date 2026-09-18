/**
 * Slack directory — "who can I @ here?" for agents.
 *
 * Two sources, merged:
 *   - Crewly Cloud's directory of this account: every registered instance,
 *     its teams and members, each member's Slack bot user. Tells an agent
 *     that "Mia" is on the Portal team on the mac-mini and how to @ her.
 *   - The Slack channel itself (`conversations.members` + `users.info`):
 *     every bot user actually in the channel, including agents of OTHER
 *     Crewly accounts (another company's Crewly sharing the workspace) and
 *     bots from other vendors. Those are @-able even though Cloud knows
 *     nothing about them.
 *
 * Results are cached per channel for a few minutes; Slack rate-limits
 * `users.info`.
 *
 * @module services/slack/slack-directory
 */

import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { SLACK_CLOUD_CONSTANTS } from '../../constants.js';

/** One colleague, as an agent should see it. */
export interface DirectoryEntry {
  name: string;
  /** `<@Uxxx>` when the colleague has a Slack bot user; null when only Crewly knows it. */
  mention: string | null;
  botUserId: string | null;
  /** Crewly agent session when the colleague is a Crewly agent of this account. */
  agentSession: string | null;
  team: string | null;
  /** Device name of the Crewly instance running it; 'this machine' for local agents. */
  machine: string | null;
  /** Where the entry came from. */
  source: 'this-machine' | 'this-account' | 'channel';
  /** True when the colleague is a member of the requested channel. */
  inChannel: boolean;
  /** Set for channel members that are not Crewly agents of this account (other accounts, other bots). */
  kind: 'agent' | 'bot' | 'human';
}

/** Cloud directory shape (`GET /api/cloud/slack/directory`). */
export interface CloudDirectoryInstance {
  instanceId: string;
  deviceName: string;
  live: boolean;
  teams: Array<{
    teamId: string;
    name: string;
    channelId: string | null;
    agents: Array<{ agentSession: string; displayName: string; botUserId: string | null; installed: boolean }>;
  }>;
}

/** Dependencies. */
export interface SlackDirectoryDeps {
  /** This instance's Cloud device id (to mark local agents). */
  getInstanceId: () => string | null;
  /** Cloud directory fetch; null when not signed in. */
  fetchCloudDirectory: () => Promise<CloudDirectoryInstance[] | null>;
  /** Slack: member user ids of a channel (bots included); null when Slack is down. */
  listChannelMembers: (channelId: string) => Promise<string[] | null>;
  /** Slack: user record for a member id. */
  getUser: (userId: string) => Promise<{ name: string; isBot: boolean } | null>;
  now?: () => number;
}

/** The directory service. */
export class SlackDirectoryService {
  private readonly logger: ComponentLogger;
  private readonly cache = new Map<string, { at: number; entries: DirectoryEntry[] }>();

  constructor(private readonly deps: SlackDirectoryDeps) {
    this.logger = LoggerService.getInstance().createComponentLogger('SlackDirectory');
  }

  /**
   * Colleagues an agent can address. With a channel id the result is scoped
   * to that channel (Cloud agents marked `inChannel`, plus channel-only bots
   * and humans); without one it is the account-wide roster.
   *
   * @param channelId - Slack channel id, optional
   * @returns Entries, local agents first
   */
  async list(channelId?: string): Promise<DirectoryEntry[]> {
    const key = channelId ?? '*';
    const cached = this.cache.get(key);
    const now = this.deps.now?.() ?? Date.now();
    if (cached && now - cached.at < SLACK_CLOUD_CONSTANTS.DIRECTORY_CACHE_MS) return cached.entries.map((e) => ({ ...e }));

    const entries: DirectoryEntry[] = [];
    const byBot = new Map<string, DirectoryEntry>();
    const me = this.deps.getInstanceId();
    const cloud = await this.deps.fetchCloudDirectory().catch((err: unknown) => {
      this.logger.debug('Cloud directory unavailable', { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    for (const inst of cloud ?? []) {
      const local = me !== null && inst.instanceId === me;
      for (const team of inst.teams) {
        for (const a of team.agents) {
          const entry: DirectoryEntry = {
            name: a.displayName,
            mention: a.botUserId ? `<@${a.botUserId}>` : null,
            botUserId: a.botUserId,
            agentSession: a.agentSession,
            team: team.name,
            machine: local ? 'this machine' : inst.deviceName,
            source: local ? 'this-machine' : 'this-account',
            inChannel: !!channelId && team.channelId === channelId,
            kind: 'agent',
          };
          entries.push(entry);
          if (a.botUserId) byBot.set(a.botUserId, entry);
        }
      }
    }

    if (channelId) {
      const members = await this.deps.listChannelMembers(channelId).catch(() => null);
      for (const userId of members ?? []) {
        const known = byBot.get(userId);
        if (known) {
          known.inChannel = true;
          continue;
        }
        const user = await this.deps.getUser(userId).catch(() => null);
        if (!user) continue;
        entries.push({
          name: user.name,
          mention: `<@${userId}>`,
          botUserId: user.isBot ? userId : null,
          agentSession: null,
          team: null,
          machine: null,
          source: 'channel',
          inChannel: true,
          kind: user.isBot ? 'bot' : 'human',
        });
      }
    }

    const rank = (e: DirectoryEntry) => (e.source === 'this-machine' ? 0 : e.source === 'this-account' ? 1 : e.kind === 'bot' ? 2 : 3);
    entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    this.cache.set(key, { at: now, entries });
    return entries.map((e) => ({ ...e }));
  }

  /**
   * One line for a channel prompt: who is in the channel and how to @ them.
   *
   * @param channelId - Slack channel id
   * @returns e.g. `Atlas (Think Tank, this machine) @Atlas · Mia (Portal, mac-mini) @Mia · Steve (human)`; '' when unknown
   */
  async rosterLine(channelId: string): Promise<string> {
    const entries = (await this.list(channelId)).filter((e) => e.inChannel);
    if (entries.length === 0) return '';
    return entries
      .map((e) => {
        const where = e.kind === 'agent' ? ` (${e.team ?? '?'}, ${e.machine ?? '?'})` : e.kind === 'bot' ? ' (bot, other system)' : ' (human)';
        return `${e.name}${where}${e.mention ? ` → @${e.name}` : ''}`;
      })
      .join(' · ');
  }

  /** Drop cached rosters (team saved, identity installed). */
  invalidate(): void {
    this.cache.clear();
  }
}

let instance: SlackDirectoryService | null = null;

/** Install the process-wide instance. */
export function setSlackDirectoryService(service: SlackDirectoryService | null): void {
  instance = service;
}

/** The process-wide instance, or null before wiring. */
export function getSlackDirectoryService(): SlackDirectoryService | null {
  return instance;
}
