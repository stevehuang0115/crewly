/**
 * Resolve the name an agent typed (`--to Pia`) to one colleague of the account
 * directory. Pure: the directory entries are passed in.
 *
 * @module services/colleague/colleague-resolver
 */

import type { DirectoryEntry } from '../slack/slack-directory.service.js';
import { COLLEAGUE_MESSAGE_CONSTANTS } from '../../constants.js';

/** A Crewly agent of the account, addressable by session. */
export type ColleagueEntry = DirectoryEntry & { agentSession: string };

/** A candidate shown in a not-found or ambiguous answer. */
export interface ColleagueCandidate {
  name: string;
  team: string | null;
  machine: string | null;
  session: string | null;
}

/** Result of {@link resolveColleague}. */
export type ColleagueResolution =
  | { kind: 'found'; entry: ColleagueEntry }
  | { kind: 'ambiguous'; candidates: ColleagueCandidate[] }
  | { kind: 'self' }
  | { kind: 'none'; candidates: ColleagueCandidate[] };

/**
 * The directory entries that are Crewly agents with a session (people, bots
 * of other systems and agents of other accounts cannot be messaged this way).
 *
 * @param entries - Directory entries
 * @returns The agents
 */
export function agentEntries(entries: readonly DirectoryEntry[]): ColleagueEntry[] {
  return entries.filter((e): e is ColleagueEntry => e.kind === 'agent' && !!e.agentSession);
}

/**
 * @param entry - Directory entry
 * @returns The compact form shown to an agent
 */
export function toCandidate(entry: DirectoryEntry): ColleagueCandidate {
  return { name: entry.name, team: entry.team, machine: entry.machine, session: entry.agentSession };
}

/**
 * Pick the colleague a query names. Matches the agent session exactly, or the
 * display name case-insensitively (a leading `@` is ignored). `team` narrows a
 * name two machines share. Two matches are never guessed between.
 *
 * @param entries - The account directory
 * @param query - What the agent typed
 * @param opts.fromSession - The asking agent (never resolves to itself)
 * @param opts.team - Team name to narrow by
 * @returns The match, an ambiguity, the asker itself, or nothing (with the closest names)
 *
 * @example
 * ```typescript
 * resolveColleague(entries, 'Pia', { fromSession: 'steamfun-fern' }); // { kind: 'found', entry: <Pia, Flopost, this machine> }
 * ```
 */
export function resolveColleague(
  entries: readonly DirectoryEntry[],
  query: string,
  opts: { fromSession?: string; team?: string } = {},
): ColleagueResolution {
  const q = query.trim().replace(/^@/, '');
  const agents = agentEntries(entries);
  if (!q) return { kind: 'none', candidates: agents.filter((e) => e.agentSession !== opts.fromSession).slice(0, COLLEAGUE_MESSAGE_CONSTANTS.MAX_SUGGESTIONS).map(toCandidate) };

  const lower = q.toLowerCase();
  const team = opts.team?.trim().toLowerCase();
  const matches = agents.filter(
    (e) =>
      (e.agentSession === q || e.name.toLowerCase() === lower) &&
      (!team || (e.team ?? '').toLowerCase() === team),
  );
  const others = matches.filter((e) => e.agentSession !== opts.fromSession);
  // The same colleague listed twice (Cloud and local both know it) is one.
  const unique = [...new Map(others.map((e) => [e.agentSession, e])).values()];
  if (unique.length === 1) return { kind: 'found', entry: unique[0] };
  if (unique.length > 1) return { kind: 'ambiguous', candidates: unique.map(toCandidate) };
  if (matches.length > 0) return { kind: 'self' };

  const close = agents
    .filter((e) => e.agentSession !== opts.fromSession)
    .filter((e) => {
      const n = e.name.toLowerCase();
      return n.includes(lower) || lower.includes(n) || (e.agentSession ?? '').toLowerCase().includes(lower);
    })
    .slice(0, COLLEAGUE_MESSAGE_CONSTANTS.MAX_SUGGESTIONS)
    .map(toCandidate);
  return { kind: 'none', candidates: close };
}
