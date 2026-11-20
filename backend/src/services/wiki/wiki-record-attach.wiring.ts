/**
 * Wiring for {@link WikiRecordAttachService}: the process-wide instance and
 * the vaults an agent reads from.
 *
 * @module services/wiki/wiki-record-attach.wiring
 */

import * as path from 'path';
import { existsSync } from 'fs';
import type { Project, Team, TeamMember } from '../../types/index.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { WikiRecordAttachService } from './wiki-record-attach.service.js';
import { WikiUsageService } from './wiki-usage.service.js';

/** The storage calls the vault lookup needs. */
export interface AgentScopeStorage {
  findMemberBySessionName(sessionName: string): Promise<{ team: Team; member: TeamMember } | null>;
  getProjects(): Promise<Project[]>;
}

let instance: WikiRecordAttachService | null = null;

/**
 * The process-wide service. What it attaches is written to each vault's
 * usage ledger, so a page that is shown counts as used.
 *
 * @returns The service
 */
export function getWikiRecordAttachService(): WikiRecordAttachService {
  if (!instance) {
    instance = new WikiRecordAttachService({
      recordUsage: (vaultPath, event) => {
        void WikiUsageService.getInstance().record(vaultPath, event);
      },
    });
  }
  return instance;
}

/**
 * Replace the process-wide service (tests).
 *
 * @param service - The service, or null to build a fresh one on next use
 */
export function setWikiRecordAttachService(service: WikiRecordAttachService | null): void {
  instance = service;
}

/**
 * Whether a directory is a wiki vault.
 *
 * @param vaultPath - Candidate vault root
 * @returns True when it carries a `SCHEMA.md`
 */
function isVault(vaultPath: string): boolean {
  return existsSync(path.join(vaultPath, 'SCHEMA.md'));
}

/**
 * The vaults an agent reads records from, and its role: the vaults of its
 * team's projects, its team's own vault, and the global vault. An agent that
 * is on no team (the orchestrator) reads the global vault only.
 *
 * @param storage - Team and project storage
 * @param agentSession - The agent
 * @returns Existing vault paths (possibly none) and the agent's role
 */
export async function vaultsForAgent(
  storage: AgentScopeStorage,
  agentSession: string,
): Promise<{ vaultPaths: string[]; viewerRole?: string }> {
  const home = getCrewlyHomePath();
  const vaults: string[] = [];
  let viewerRole: string | undefined;
  try {
    const found = await storage.findMemberBySessionName(agentSession);
    if (found) {
      viewerRole = typeof found.member.role === 'string' ? found.member.role : undefined;
      const projectIds = new Set(found.team.projectIds ?? []);
      if (projectIds.size > 0) {
        for (const project of await storage.getProjects()) {
          if (projectIds.has(project.id)) vaults.push(path.join(project.path, '.crewly', 'wiki'));
        }
      }
      vaults.push(path.join(home, 'teams', found.team.id, 'wiki'));
    }
  } catch {
    /* an unknown agent reads the global vault only */
  }
  vaults.push(path.join(home, 'global-wiki'));
  return { vaultPaths: [...new Set(vaults)].filter(isVault), ...(viewerRole ? { viewerRole } : {}) };
}
