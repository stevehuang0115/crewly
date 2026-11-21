/**
 * Account-wide requests and the default primary machine.
 *
 * One Crewly account may run on several machines, each with its own
 * orchestrator. The workspace "Crewly" DM is account-wide: Cloud hands it to
 * the account's primary machine. Two gaps showed on 2026-11-19, with four
 * machines and no primary: each DM went to whichever machine had the most
 * recent heartbeat, and the orchestrator that got "move team X" did not hold
 * team X and sat on the request.
 *
 *  - {@link pickDefaultPrimary}: with no primary on the account, every
 *    machine computes the same choice from the same Cloud list, and only the
 *    chosen one claims the flag.
 *  - {@link requestScopeOf} / {@link renderRequestScope}: the orchestrator is
 *    told whether a DM came through the account-wide Crewly DM (it may be
 *    about any machine) or through this machine's own orchestrator bot, and
 *    for the first kind which machine holds which teams.
 *
 * @module services/slack/slack-request-scope
 */

/** A machine of the account as Cloud's registry lists it (fields used here). */
export interface AccountInstance {
  instanceId: string;
  deviceName: string;
  primary: boolean;
  /**
   * On the primary: `owner` when it was chosen, `default` when Cloud picked
   * it. Present only when Cloud owns the setting (auth with the account-level
   * primary); machines then neither claim nor give up the flag themselves.
   */
  primarySetBy?: 'owner' | 'default';
  /** Heartbeat seen recently enough for Cloud to route to it */
  live: boolean;
  crewlyVersion?: string;
  /** Team names on that machine, without its orchestrator pseudo-team */
  teams: string[];
}

/** Where a DM to the orchestrator came from. */
export type RequestScope = 'account' | 'machine';

/** Slack channel ids of direct messages start with this letter. */
const DM_CHANNEL_PREFIX = 'D';

/** Most team names listed per machine in the scope note. */
const MAX_TEAMS_LISTED = 30;

/**
 * Normalise one registry entry from Cloud.
 *
 * @param raw - An element of `GET /instances`
 * @returns The instance, or null when it has no id
 */
export function toAccountInstance(raw: unknown): AccountInstance | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['instanceId'] !== 'string' || !r['instanceId']) return null;
  const deviceName = typeof r['deviceName'] === 'string' ? r['deviceName'] : '';
  const teams = Array.isArray(r['teams'])
    ? (r['teams'] as unknown[])
        .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>)['name'] : undefined))
        .filter((n): n is string => typeof n === 'string' && n.length > 0 && n !== deviceName)
    : [];
  return {
    instanceId: r['instanceId'],
    deviceName,
    primary: r['primary'] === true,
    ...(r['primarySetBy'] === 'owner' || r['primarySetBy'] === 'default' ? { primarySetBy: r['primarySetBy'] } : {}),
    live: r['live'] === true,
    ...(typeof r['crewlyVersion'] === 'string' ? { crewlyVersion: r['crewlyVersion'] } : {}),
    teams,
  };
}

/**
 * Compare two `major.minor.patch` versions numerically.
 *
 * @param a - A version
 * @param b - Another version
 * @returns Negative when a < b, 0 when equal, positive when a > b
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The machine that should become primary when the account has none.
 *
 * Deterministic over the Cloud list, so every machine reaches the same
 * answer: the live machine with the most teams, ties broken by instance id.
 * Machines older than `minVersion` cannot claim the flag and are skipped,
 * so the choice never lands on one that will not act on it.
 *
 * @param instances - The account's machines
 * @param minVersion - First version that claims a default primary
 * @returns The instance id to promote, or null when a live primary exists or
 *   nothing qualifies
 */
export function pickDefaultPrimary(instances: readonly AccountInstance[], minVersion: string): string | null {
  if (instances.some((i) => i.primary && i.live)) return null;
  const candidates = instances.filter(
    (i) => i.live && typeof i.crewlyVersion === 'string' && compareVersions(i.crewlyVersion, minVersion) >= 0,
  );
  if (candidates.length === 0) return null;
  const best = [...candidates].sort(
    (a, b) => b.teams.length - a.teams.length || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0),
  )[0];
  return best ? best.instanceId : null;
}

/**
 * Whether this machine should give up a primary flag it holds locally:
 * Cloud no longer lists it as primary and another live machine holds the
 * flag (the last machine to claim it wins).
 *
 * @param instances - The account's machines
 * @param selfId - This machine's instance id
 * @returns True when another live machine is the primary
 */
export function primaryTakenByAnother(instances: readonly AccountInstance[], selfId: string): boolean {
  const self = instances.find((i) => i.instanceId === selfId);
  if (!self || self.primary) return false;
  return instances.some((i) => i.instanceId !== selfId && i.primary && i.live);
}

/**
 * Classify a message delivered to the orchestrator.
 *
 * @param message - Channel id and, for a DM to an agent's own bot, that agent
 * @returns `account` for the workspace Crewly DM, `machine` for a DM to this
 *   machine's orchestrator bot, null for anything that is not a DM
 */
export function requestScopeOf(message: { channelId: string; agentSession?: string }): RequestScope | null {
  if (!message.channelId.startsWith(DM_CHANNEL_PREFIX)) return null;
  return message.agentSession ? 'machine' : 'account';
}

/**
 * The note appended to the copy of a DM delivered to the orchestrator.
 *
 * @param scope - From {@link requestScopeOf}
 * @param self - This machine's name and instance id
 * @param instances - The account's machines (may be empty when Cloud is unreachable)
 * @returns The note, one paragraph
 */
export function renderRequestScope(
  scope: RequestScope,
  self: { deviceName: string; instanceId: string | null },
  instances: readonly AccountInstance[],
): string {
  const here = self.deviceName || 'this machine';
  if (scope === 'machine') {
    return `[Request scope: this machine. The owner wrote to the orchestrator of ${here} directly, so it is about ${here}.]`;
  }
  const others = instances.filter((i) => i.instanceId !== self.instanceId && i.deviceName);
  const lines = [
    `[Request scope: account-wide. This came through the account's Crewly DM, which reaches one machine (${here}) on behalf of all of them, so it may be about a team or machine that is not here.`,
  ];
  if (others.length > 0) {
    lines.push('The owner\'s other machines and their teams:');
    for (const o of others) {
      const teams = o.teams.slice(0, MAX_TEAMS_LISTED).join(', ') || 'no teams yet';
      lines.push(`- ${o.deviceName}${o.live ? '' : ' (offline)'}: ${teams}`);
    }
    lines.push(
      'If the request is about a team or machine in that list and not one of yours, do not queue it here: ' +
        'find that machine\'s orchestrator with list-colleagues, hand it the request with message-colleague ' +
        '(include this Slack channel and thread so the answer comes back here), and tell the owner in one line which machine is handling it. ' +
        'A request that involves this machine too (for example moving one of your teams to another machine) is yours to do.]',
    );
  } else {
    lines.push('No other machine of the account is known right now.]');
  }
  return lines.join('\n');
}
