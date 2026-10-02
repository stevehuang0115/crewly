/**
 * Spend cap gate — the process-wide hook the delivery and wake paths ask
 * "may this agent start a new turn?". Kept apart from the service so the
 * hot paths (agent registration, the orc queue processor, the owner-message
 * watchdog) import a tiny module with no dependencies of its own.
 *
 * specs/2026-10-02-spend-cap.md
 *
 * @module services/spend/spend-cap.gate
 */

/** Why an agent may not start a new turn today. */
export interface SpendStop {
  session: string;
  /** `agent`: its own cap; `total`: the all-agents daily total cap */
  scope: 'agent' | 'total';
  /** The cap in force (USD) */
  capUsd: number;
  /** What was spent today against it (USD) */
  spentUsd: number;
}

/** What the service exposes to the gate. */
export interface SpendCapGate {
  /** The stop in force for a session, or null when it may run */
  stopOf(session: string): SpendStop | null;
  /** Owner-facing name of a session ("Orc", "Ella") */
  displayNameOf?(session: string): string;
}

let gate: SpendCapGate | null = null;

/**
 * Install (or clear) the gate.
 *
 * @param next - Gate, or null
 */
export function setSpendCapGate(next: SpendCapGate | null): void {
  gate = next;
}

/**
 * The stop in force for a session. Never throws: a broken gate lets the
 * agent run rather than silently dropping its work.
 *
 * @param session - Agent session
 * @returns Stop, or null
 */
export function spendCapStopOf(session: string): SpendStop | null {
  try {
    return gate?.stopOf(session) ?? null;
  } catch {
    return null;
  }
}

/**
 * Owner-facing name of a session.
 *
 * @param session - Agent session
 * @returns Name (the session name when unknown)
 */
export function spendCapNameOf(session: string): string {
  try {
    return gate?.displayNameOf?.(session) || session;
  } catch {
    return session;
  }
}

/**
 * USD for owner text.
 *
 * @param usd - Amount
 * @returns e.g. `$5.00`
 */
export function formatUsd(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

/**
 * The one-line reason, e.g. "Orc hit its daily spend cap ($5.00)".
 *
 * @param stop - The stop
 * @param name - Owner-facing name (default: looked up)
 * @returns Reason text
 */
export function spendCapReason(stop: SpendStop, name: string = spendCapNameOf(stop.session)): string {
  if (stop.scope === 'total') {
    return `${name} is stopped: all agents together hit the daily total spend cap (${formatUsd(stop.capUsd)})`;
  }
  return `${name} hit its daily spend cap (${formatUsd(stop.capUsd)})`;
}
