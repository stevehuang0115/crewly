/**
 * Drive mode keep-warm (specs/2026-10-09-drive-mode-v3.md §5): while the
 * owner is in a Drive mode session, the agents he names and the team leads
 * he talks to stay running, so the next thing he says to them is answered in
 * seconds instead of after a cold start.
 *
 * Crewly Cloud tells this machine which of its agents to keep warm (relay
 * push `op:'warm'`, the list read back from `machine/state` with this
 * machine's token) and repeats it every few minutes while the phone is
 * connected. Each list holds until its `until` time (or the session's end),
 * so a phone that drops never pins agents for long.
 *
 * Consulted by every path that stops an idle agent or frees a running slot
 * (idle stop, memory-pressure stop, slot freeing, reconciler wake eviction)
 * and by the start gate, which lets a warm agent's start go ahead of
 * ordinary starts.
 *
 * @module services/drive/drive-keep-warm
 */

/** The agents one Drive mode session keeps warm. */
interface WarmSet {
  agents: Set<string>;
  until: number;
}

/** Which agents Drive mode keeps running right now. */
export class DriveKeepWarm {
  private readonly sessions = new Map<string, WarmSet>();

  /**
   * @param now - Clock (ms)
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Replace a session's warm list.
   *
   * @param driveSessionId - Drive mode session
   * @param agents - Agent sessions to keep warm
   * @param untilMs - Until when (ms)
   * @returns The agents that were not warm before (to pre-start)
   */
  set(driveSessionId: string, agents: readonly string[], untilMs: number): string[] {
    const before = new Set(this.warmAgents());
    if (agents.length === 0 || untilMs <= this.now()) this.sessions.delete(driveSessionId);
    else this.sessions.set(driveSessionId, { agents: new Set(agents), until: untilMs });
    return agents.filter((a) => !before.has(a));
  }

  /**
   * The session ended: its agents are no longer kept warm.
   *
   * @param driveSessionId - Drive mode session
   */
  end(driveSessionId: string): void {
    this.sessions.delete(driveSessionId);
  }

  /**
   * Whether an agent is kept warm by any live session.
   *
   * @param agentSession - Agent session name
   * @returns True while a session's list holds it
   */
  isWarm(agentSession: string): boolean {
    return this.warmAgents().includes(agentSession);
  }

  /**
   * Every agent kept warm now (expired lists are dropped).
   *
   * @returns Agent sessions
   */
  warmAgents(): string[] {
    const now = this.now();
    const out = new Set<string>();
    for (const [id, s] of this.sessions) {
      if (s.until <= now) {
        this.sessions.delete(id);
        continue;
      }
      for (const a of s.agents) out.add(a);
    }
    return [...out];
  }
}

let instance = new DriveKeepWarm();

/** @returns The process-wide keep-warm registry */
export function getDriveKeepWarm(): DriveKeepWarm {
  return instance;
}

/**
 * Replace the registry (tests).
 *
 * @param registry - Registry
 */
export function setDriveKeepWarm(registry: DriveKeepWarm): void {
  instance = registry;
}

/**
 * Whether Drive mode keeps an agent running right now. Never throws.
 *
 * @param agentSession - Agent session name
 * @returns True while the owner's Drive mode session keeps it warm
 */
export function isDriveWarm(agentSession: string): boolean {
  try {
    return instance.isWarm(agentSession);
  } catch {
    return false;
  }
}
