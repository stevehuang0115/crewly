/**
 * AppRosterService — tells Crewly Cloud which agents this instance runs, so
 * the owner can @mention them in a Crewly App comment (crewly-services
 * apps/SPEC.md §12.1).
 *
 * - The roster is every member of a team that is neither archived nor paused
 *   (a paused team is hidden from other agents), plus the orchestrator as
 *   "Orc". Session, display name and team name only.
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
}

/** The team shape the roster reads. */
export interface RosterTeam {
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
      out.push({ session, name, team });
      if (out.length >= C.ROSTER.MAX_AGENTS - 1) break;
    }
    if (out.length >= C.ROSTER.MAX_AGENTS - 1) break;
  }
  out.push({ session: ORCHESTRATOR_SESSION_NAME, name: 'Orc', team: null });
  return out;
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

const hashOf = (agents: RosterAgent[]): string =>
  createHash('sha256').update(JSON.stringify(agents.map((a) => [a.session, a.name, a.team]))).digest('hex');

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
    try {
      agents = buildRoster(await this.deps.getTeams());
    } catch (err) {
      this.logger.warn('Could not read teams for the app roster', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
    const hash = hashOf(agents);
    if (hash === this.lastHash && this.now() - this.lastPushAt < C.ROSTER.REFRESH_MS) return false;
    try {
      await this.deps.client.request('PUT', '/roster', { body: { agents }, timeoutMs: C.POLL_REQUEST_TIMEOUT_MS });
      if (hash !== this.lastHash) this.logger.info('Pushed the agent roster for app comment @mentions', { agents: agents.length });
      this.lastHash = hash;
      this.lastPushAt = this.now();
      return true;
    } catch (err) {
      this.logger.warn('Pushing the agent roster failed; will retry', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
}
