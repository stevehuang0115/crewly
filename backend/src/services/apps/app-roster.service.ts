/**
 * AppRosterService — tells Crewly Cloud which agents this instance runs, so
 * the owner can @mention them in a Crewly App comment (crewly-services
 * apps/SPEC.md §12.1).
 *
 * - The roster is every member of a team that is neither archived nor paused
 *   (a paused team is hidden from other agents), plus the orchestrator as
 *   "Orc". Session, display name, team name and team id.
 * - With it go the teams (`{ id, name }`, archived ones left out) and the
 *   Crewly channels (`{ id, name, members, slack }`) — what can own an app
 *   (crewly-services apps/SPEC.md §15). Cloud checks owners and owner agents
 *   against these lists.
 * - `pushIfChanged()` sends `PUT /roster` when the list changed since the
 *   last successful push, or when the last push is older than
 *   ROSTER.REFRESH_MS (Cloud stops offering a roster it has not heard from
 *   for 14 days). It is cheap to call often: the app poller calls it every
 *   tick, and a publish calls it once.
 * - Pushes are serialised; a failure is logged and retried on the next call.
 *
 * @module services/apps/app-roster.service
 */

import { createHash } from 'crypto';
import { CREWLY_APPS_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';

const C = CREWLY_APPS_CONSTANTS;

/** One agent the owner can @mention. */
export interface RosterAgent {
  session: string;
  name: string;
  /** Team name; null for the orchestrator */
  team: string | null;
  /** Team id (app owners by team, crewly-services apps/SPEC.md §15) */
  teamId?: string;
}

/** A team that can own an app. */
export interface RosterTeamEntry {
  id: string;
  name: string;
}

/** A Crewly channel (cross-team room) that can own an app; `id` is its huddle id. */
export interface RosterChannelEntry {
  id: string;
  name: string;
  members: string[];
  slack?: boolean;
}

/** The team shape the roster reads. */
export interface RosterTeam {
  id?: string;
  name?: string;
  archived?: boolean;
  paused?: unknown;
  members?: Array<{ sessionName?: string; agentId?: string; name?: string }>;
}

/** The Apps API slice the roster needs. */
export interface RosterClient {
  isAvailable(): boolean;
  request<T>(method: string, path: string, opts?: { body?: unknown; timeoutMs?: number }): Promise<T>;
}

/** Constructor dependencies. */
export interface AppRosterServiceDeps {
  client: RosterClient;
  getTeams: () => Promise<RosterTeam[]>;
  /** This instance's Crewly channels (absent: none are pushed) */
  getChannels?: () => Promise<RosterChannelEntry[]>;
  now?: () => number;
  logger?: ComponentLogger;
}

const SESSION_RE = /^[A-Za-z0-9_.@:-]{1,128}$/;

/**
 * The agents of an instance, as the owner sees them in the @ list.
 *
 * @param teams - Teams on this instance
 * @returns Members of active, unpaused teams (de-duplicated by session), then the orchestrator
 */
export function buildRoster(teams: RosterTeam[]): RosterAgent[] {
  const out: RosterAgent[] = [];
  const seen = new Set<string>();
  for (const t of teams) {
    if (!t || t.archived || t.paused) continue;
    for (const m of t.members ?? []) {
      const session = m.sessionName || m.agentId || '';
      if (!SESSION_RE.test(session) || seen.has(session) || session === ORCHESTRATOR_SESSION_NAME) continue;
      seen.add(session);
      const name = (m.name ?? '').replace(/\s+/g, ' ').trim().slice(0, C.ROSTER.MAX_NAME_CHARS) || session;
      const team = (t.name ?? '').replace(/\s+/g, ' ').trim().slice(0, C.ROSTER.MAX_TEAM_CHARS) || null;
      out.push({ session, name, team, ...(t.id && ID_RE.test(t.id) ? { teamId: t.id } : {}) });
      if (out.length >= C.ROSTER.MAX_AGENTS - 1) break;
    }
    if (out.length >= C.ROSTER.MAX_AGENTS - 1) break;
  }
  out.push({ session: ORCHESTRATOR_SESSION_NAME, name: 'Orc', team: null });
  return out;
}

/** Team and channel ids Cloud accepts. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The teams that can own an app: every non-archived team with an id (a
 * paused team still owns its apps).
 *
 * @param teams - Teams on this instance
 * @returns `{ id, name }` per team
 */
export function buildRosterTeams(teams: RosterTeam[]): RosterTeamEntry[] {
  const out: RosterTeamEntry[] = [];
  for (const t of teams) {
    if (!t || t.archived || !t.id || !ID_RE.test(t.id)) continue;
    const name = (t.name ?? '').replace(/\s+/g, ' ').trim().slice(0, C.ROSTER.MAX_TEAM_CHARS) || t.id;
    out.push({ id: t.id, name });
    if (out.length >= C.ROSTER.MAX_TEAMS) break;
  }
  return out;
}

/**
 * Channels as Cloud takes them: valid ids and member sessions, capped.
 *
 * @param channels - This instance's channels
 * @returns Clean entries
 */
export function cleanRosterChannels(channels: RosterChannelEntry[]): RosterChannelEntry[] {
  return channels
    .filter((c) => c && ID_RE.test(c.id))
    .slice(0, C.ROSTER.MAX_CHANNELS)
    .map((c) => ({
      id: c.id,
      name: (c.name ?? '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, C.ROSTER.MAX_NAME_CHARS) || c.id,
      members: [...new Set((c.members ?? []).filter((m) => SESSION_RE.test(m)))].slice(0, C.ROSTER.MAX_CHANNEL_MEMBERS),
      ...(c.slack ? { slack: true } : {}),
    }));
}

/**
 * Whether a session is one of this instance's mentionable agents.
 *
 * @param teams - Teams on this instance
 * @param session - Agent session
 * @returns True for a member of an active, unpaused team, or the orchestrator
 */
export function isRosterAgent(teams: RosterTeam[], session: string): boolean {
  return buildRoster(teams).some((a) => a.session === session);
}

const hashOf = (agents: RosterAgent[], teams: RosterTeamEntry[], channels: RosterChannelEntry[]): string =>
  createHash('sha256').update(JSON.stringify([agents.map((a) => [a.session, a.name, a.team, a.teamId ?? null]), teams, channels])).digest('hex');

/**
 * Pushes this instance's roster to Crewly Cloud when it changes.
 */
export class AppRosterService {
  private readonly now: () => number;
  private readonly logger: ComponentLogger;
  private lastHash: string | null = null;
  private lastPushAt = 0;
  private running: Promise<boolean> | null = null;

  constructor(private readonly deps: AppRosterServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.logger = deps.logger ?? LoggerService.getInstance().createComponentLogger('AppRoster');
  }

  /**
   * Push the roster when it changed or the last push is getting old.
   *
   * @returns Whether a push was sent and accepted
   */
  pushIfChanged(): Promise<boolean> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<boolean> {
    if (!this.deps.client.isAvailable()) return false;
    let agents: RosterAgent[];
    let teams: RosterTeamEntry[];
    try {
      const all = await this.deps.getTeams();
      agents = buildRoster(all);
      teams = buildRosterTeams(all);
    } catch (err) {
      this.logger.warn('Could not read teams for the app roster', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    let channels: RosterChannelEntry[] = [];
    if (this.deps.getChannels) {
      try {
        channels = cleanRosterChannels(await this.deps.getChannels());
      } catch (err) {
        // Channels are optional: push agents and teams without them.
        this.logger.warn('Could not read channels for the app roster', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const hash = hashOf(agents, teams, channels);
    if (hash === this.lastHash && this.now() - this.lastPushAt < C.ROSTER.REFRESH_MS) return false;
    try {
      await this.deps.client.request('PUT', '/roster', { body: { agents, teams, channels }, timeoutMs: C.POLL_REQUEST_TIMEOUT_MS });
      if (hash !== this.lastHash) this.logger.info('Pushed the agent roster for app comment @mentions and app owners', { agents: agents.length, teams: teams.length, channels: channels.length });
      this.lastHash = hash;
      this.lastPushAt = this.now();
      return true;
    } catch (err) {
      this.logger.warn('Pushing the agent roster failed; will retry', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}
