/**
 * Private-source tracker (issue #969): which agent sessions recently read
 * from a connector grant, and for whom.
 *
 * A connector grant belongs to a person (#968). What an agent reads
 * through it is that person's data, so a wiki page the agent writes right
 * after must not be readable by everyone in the instance. The connector
 * gate notes every allowed use here; the wiki ingest asks, when a page is
 * written, which people the writing session read for inside the window,
 * and tags the page `visible_to_people` with them. Reads filter on it.
 *
 * The window stands in for a turn: the backend has no turn boundary, so a
 * use counts for `PEOPLE_CONSTANTS.PRIVATE_SOURCE_WINDOW_MS` after it
 * happened. A page tagged by mistake is hidden from other people, never
 * from the owner, so the error is on the safe side.
 *
 * @module services/people/private-source.service
 */

import { PEOPLE_CONSTANTS } from '../../constants.js';

/** One remembered use. */
export interface PrivateSourceUse {
  /** Person the session acted for */
  personId: string;
  /** Connector read (`google-workspace`, `canva`, `mcp:<id>`, …) */
  connectorId: string;
  /** Epoch ms */
  at: number;
}

/** Injectable pieces. */
export interface PrivateSourceDeps {
  now?: () => number;
  /** How long a use counts for later writes */
  windowMs?: number;
  /** Most sessions remembered before the oldest are dropped */
  maxSessions?: number;
}

/**
 * Remembers, per agent session, the people whose grants it read recently.
 */
export class PrivateSourceTracker {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly maxSessions: number;
  /** Session → last use per `person|connector` */
  private readonly uses = new Map<string, Map<string, PrivateSourceUse>>();

  /**
   * @param deps - Clock and limits (defaults: `Date.now` and the constants)
   */
  constructor(deps: PrivateSourceDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.windowMs = deps.windowMs ?? PEOPLE_CONSTANTS.PRIVATE_SOURCE_WINDOW_MS;
    this.maxSessions = deps.maxSessions ?? PEOPLE_CONSTANTS.PRIVATE_SOURCE_SESSIONS_MAX;
  }

  /**
   * Note that a session read a connector for a person.
   *
   * @param session - Agent session name (ignored when empty)
   * @param personId - Person the session acted for
   * @param connectorId - Connector read
   */
  note(session: string | undefined, personId: string, connectorId: string): void {
    if (!session || !personId) return;
    // Re-insert so the session moves to the newest end of the map.
    const prior = this.uses.get(session);
    this.uses.delete(session);
    const perSession = new Map<string, PrivateSourceUse>();
    if (prior) for (const [k, v] of prior) perSession.set(k, v);
    perSession.set(`${personId}|${connectorId}`, { personId, connectorId, at: this.now() });
    this.uses.set(session, perSession);
    while (this.uses.size > this.maxSessions) {
      const oldest = this.uses.keys().next().value;
      if (oldest === undefined) break;
      this.uses.delete(oldest);
    }
  }

  /**
   * The uses of a session still inside the window, newest first.
   *
   * @param session - Agent session name
   * @returns Uses, empty for an unknown session
   */
  recent(session: string | undefined): PrivateSourceUse[] {
    if (!session) return [];
    const perSession = this.uses.get(session);
    if (!perSession) return [];
    const cutoff = this.now() - this.windowMs;
    const live: PrivateSourceUse[] = [];
    for (const [k, use] of perSession) {
      if (use.at >= cutoff) live.push(use);
      else perSession.delete(k);
    }
    if (perSession.size === 0) this.uses.delete(session);
    return live.sort((a, b) => b.at - a.at);
  }

  /**
   * The distinct people a session read for inside the window.
   *
   * @param session - Agent session name
   * @returns Person ids, newest use first
   */
  recentPeople(session: string | undefined): string[] {
    const out: string[] = [];
    for (const use of this.recent(session)) if (!out.includes(use.personId)) out.push(use.personId);
    return out;
  }

  /** Forget every session (tests). */
  reset(): void {
    this.uses.clear();
  }
}

let instance: PrivateSourceTracker | null = null;

/**
 * The process-wide tracker.
 *
 * @returns The tracker
 */
export function getPrivateSourceTracker(): PrivateSourceTracker {
  if (!instance) instance = new PrivateSourceTracker();
  return instance;
}

/**
 * Replace the tracker in tests (null restores the default).
 *
 * @param tracker - Replacement
 */
export function setPrivateSourceTrackerForTesting(tracker: PrivateSourceTracker | null): void {
  instance = tracker;
}
