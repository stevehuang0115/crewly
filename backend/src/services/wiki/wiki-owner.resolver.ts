/**
 * Who owns a vault's curation work: the team leader of the vault's team
 * (team vault) or of a team assigned to the project (project vault). The
 * global vault has no team — it stays with the orchestrator.
 *
 * Processing was routed to the orchestrator for every vault, which made
 * it a single choke point (and a token sink on Codex). Team leaders own
 * their team's knowledge.
 *
 * @module services/wiki/wiki-owner.resolver
 */

import * as path from 'path';
import type { Team } from '../../types/index.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { resolveMemberSessionName } from '../../utils/member-session-name.utils.js';

/** Storage slice. */
export interface OwnerResolverStorage {
  getTeams(): Promise<Team[]>;
  getProjects(): Promise<Array<{ id: string; path: string }>>;
}

/**
 * Resolve the team-leader session for a vault path or project root.
 *
 * @param storage - Teams + projects
 * @param key - `~/.crewly/teams/<id>/wiki`, `<project>/.crewly/wiki`, or a project root
 * @returns The TL session name, or null (caller falls back to the orchestrator)
 */
export async function resolveWikiOwner(storage: OwnerResolverStorage, key: string): Promise<string | null> {
  const teams = await storage.getTeams();
  const normalized = path.resolve(key);

  // Team vault: ~/.crewly/teams/<team-id>/wiki
  const teamsRoot = path.resolve(getCrewlyHomePath(), 'teams');
  if (normalized.startsWith(teamsRoot + path.sep)) {
    const teamId = normalized.slice(teamsRoot.length + 1).split(path.sep)[0];
    const team = teams.find((t) => t.id === teamId);
    return team ? leaderOf(team) : null;
  }

  // Project vault or project root: match a project, then a team assigned to it.
  const projectRoot = normalized.endsWith(path.join('.crewly', 'wiki'))
    ? path.resolve(normalized, '..', '..')
    : normalized;
  const projects = await storage.getProjects();
  const project = projects.find((p) => path.resolve(p.path) === projectRoot);
  if (!project) return null;
  for (const team of teams) {
    if ((team.projectIds ?? []).includes(project.id)) {
      const leader = leaderOf(team);
      if (leader) return leader;
    }
  }
  return null;
}

function leaderOf(team: Team): string | null {
  const tl = (team.members ?? []).find((m) => String(m.role) === 'team-leader' || String(m.role) === 'tech-lead');
  if (!tl) return null;
  return resolveMemberSessionName(team.name, tl);
}
