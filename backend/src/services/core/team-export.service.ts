/**
 * Team Export/Import Service
 *
 * Bundles a team's config, prompts, norms, and cron tasks into a single
 * portable JSON document, and recreates a team from one (issue #880,
 * specs/2026-10-25-team-export-portable.md).
 *
 * A package is portable and secret-free:
 * - the running agent's state (session, status, tickets in hand, login /
 *   usage flags) is stripped — the package describes the team, not this
 *   install's processes;
 * - every string passes through the secret redactor
 *   (`utils/secret-redactor`), and the whole package is scanned once more
 *   before it is returned;
 * - the connectors the team's prompts, skills and schedules refer to are
 *   listed under `portability.connectors` so the importer knows what to
 *   reconnect — grants themselves never travel.
 *
 * @module services/core/team-export.service
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Team, TeamMember } from '../../types/index.js';
import type { CronTask, CronTaskStore } from '../../types/cron-task.types.js';
import type { StorageService } from './storage.service.js';
import { redactSecretsWithCount } from '../../utils/secret-redactor.js';
import type { SecretEnvValue } from '../../utils/secret-env.js';
import { TEAM_EXPORT_CONSTANTS } from '../../constants.js';

// =============================================================================
// Types
// =============================================================================

/** What makes a package portable: what was stripped, masked and must be reconnected. */
export interface TeamExportPortability {
  /** Secrets masked across the package */
  redactions: number;
  /** Whether a final scan of the serialized package found nothing left to mask */
  scanClean: boolean;
  /** Connectors the team refers to; none of their grants are in the package */
  connectors: string[];
  /** Member fields removed because they describe the running agent, not the team */
  strippedFields: string[];
}

/**
 * Complete team export bundle containing all team data.
 *
 * This is the portable format for team backup, migration, and sharing.
 */
export interface TeamExport {
  /** Format version for forward compatibility */
  version: '1.0' | '1.1';
  /** ISO timestamp when the export was created */
  exportedAt: string;
  /** Team configuration (config.json content), runtime state stripped */
  team: Team;
  /** Member prompts: memberId → prompt content */
  prompts: Record<string, string>;
  /** Team norms/SOPs: filename → markdown content */
  norms: Record<string, string>;
  /** Team-scoped cron tasks */
  cronTasks: CronTask[];
  /** What was stripped, masked and must be reconnected (1.1+) */
  portability?: TeamExportPortability;
}

/**
 * Result of a team import operation.
 */
export interface TeamImportResult {
  /** The created team (may have new ID if conflict) */
  team: Team;
  /** Number of prompts written */
  promptsImported: number;
  /** Number of norms written */
  normsImported: number;
  /** Number of cron tasks created (with new IDs) */
  cronTasksImported: number;
  /** Connectors the package says the team uses; reconnect them on this install */
  connectorsToReconnect: string[];
}

/** Options of {@link TeamExportService.exportTeam}. */
export interface TeamExportOptions {
  /** Exact secret values to mask wherever they appear (see collectSecretEnvValues) */
  knownSecrets?: readonly SecretEnvValue[];
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * A copy of a team without this install's runtime state: every member is
 * inactive and idle with no session, and the fields that describe the
 * running agent are gone.
 *
 * @param team - Team as stored
 * @returns The portable team and the member field names that were removed
 */
export function stripRuntimeState(team: Team): { team: Team; strippedFields: string[] } {
  const stripped = new Set<string>();
  const members = team.members.map((member) => {
    const copy: Record<string, unknown> = { ...member };
    for (const field of TEAM_EXPORT_CONSTANTS.RUNTIME_MEMBER_FIELDS) {
      if (field in copy) {
        delete copy[field];
        stripped.add(field);
      }
    }
    copy['sessionName'] = '';
    copy['agentStatus'] = 'inactive';
    copy['workingStatus'] = 'idle';
    return copy as unknown as TeamMember;
  });
  return { team: { ...team, members }, strippedFields: [...stripped].sort() };
}

/**
 * Mask secrets in every string of a JSON-ish value, recursively.
 *
 * @param value - Any JSON value
 * @param knownSecrets - Exact values to mask
 * @returns The masked value and how many secrets were masked
 */
export function redactDeep<T>(value: T, knownSecrets: readonly SecretEnvValue[] = []): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactSecretsWithCount(v, knownSecrets);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) out[k] = walk(inner);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}

/**
 * The connectors a team refers to, from its members' prompts, skills and
 * roles, its norms and its schedules. Matching is by the words in
 * `TEAM_EXPORT_CONSTANTS.CONNECTOR_HINTS`; a hit means "reconnect this
 * after import", never that a grant is included.
 *
 * @param team - Team
 * @param prompts - Member prompts
 * @param norms - Norms
 * @param cronTasks - Schedules
 * @returns Connector ids, sorted
 */
export function referencedConnectors(team: Team, prompts: Record<string, string>, norms: Record<string, string>, cronTasks: CronTask[]): string[] {
  const texts: string[] = [
    ...team.members.flatMap((m) => [m.systemPrompt ?? '', m.role ?? '', ...(m.skillOverrides ?? []), ...(m.skills ?? [])]),
    ...Object.values(prompts),
    ...Object.values(norms),
    ...cronTasks.map((t) => t.taskDescription),
  ];
  const haystack = texts.join('\n');
  return Object.entries(TEAM_EXPORT_CONSTANTS.CONNECTOR_HINTS)
    .filter(([, re]) => re.test(haystack))
    .map(([id]) => id)
    .sort();
}

/**
 * Whether a package version can be imported.
 *
 * @param version - `version` of a package
 * @returns True for a supported version
 */
export function isSupportedExportVersion(version: unknown): version is TeamExport['version'] {
  return typeof version === 'string' && (TEAM_EXPORT_CONSTANTS.SUPPORTED_VERSIONS as readonly string[]).includes(version);
}

// =============================================================================
// Service
// =============================================================================

/**
 * Service for exporting and importing complete team bundles.
 *
 * Export collects: config.json + prompts/*.md + norms/*.md + cron-tasks.json
 * Import creates: team directory + prompts + norms + cron tasks with new IDs
 */
export class TeamExportService {
  private storageService: StorageService;

  /**
   * Create a new TeamExportService.
   *
   * @param storageService - StorageService for team data access
   */
  constructor(storageService: StorageService) {
    this.storageService = storageService;
  }

  /**
   * Export a team and all its associated data as a single portable JSON
   * bundle: runtime state stripped, secrets masked, connectors listed.
   *
   * Collects:
   * - Team config (config.json)
   * - Member prompts (prompts/*.md)
   * - Norms/SOPs (norms/*.md)
   * - Cron tasks (cron-tasks.json)
   *
   * @param teamId - ID of the team to export
   * @param options - Known secret values to mask
   * @returns Complete team export bundle
   * @throws Error if team not found
   */
  async exportTeam(teamId: string, options: TeamExportOptions = {}): Promise<TeamExport> {
    const teams = await this.storageService.getTeams();
    const stored = teams.find((t) => t.id === teamId);
    if (!stored) {
      throw new Error(`Team not found: ${teamId}`);
    }

    const teamDir = this.storageService.getTeamDir(teamId);

    // Read prompts
    const prompts: Record<string, string> = {};
    const promptsDir = path.join(teamDir, 'prompts');
    if (existsSync(promptsDir)) {
      try {
        const files = await fs.readdir(promptsDir);
        for (const file of files) {
          if (file.endsWith('.md')) {
            const memberId = file.replace('.md', '');
            prompts[memberId] = await fs.readFile(path.join(promptsDir, file), 'utf8');
          }
        }
      } catch {
        // prompts dir doesn't exist or unreadable — skip
      }
    }

    // Read norms
    const norms: Record<string, string> = {};
    const normsDir = path.join(teamDir, 'norms');
    if (existsSync(normsDir)) {
      try {
        const files = await fs.readdir(normsDir);
        for (const file of files) {
          norms[file] = await fs.readFile(path.join(normsDir, file), 'utf8');
        }
      } catch {
        // norms dir doesn't exist or unreadable — skip
      }
    }

    // Read cron tasks
    const cronTasks = await this.readCronTasks(teamDir);

    const { team, strippedFields } = stripRuntimeState(stored);
    const connectors = referencedConnectors(team, prompts, norms, cronTasks);
    const masked = redactDeep({ team, prompts, norms, cronTasks }, options.knownSecrets);
    const portability: TeamExportPortability = { redactions: masked.count, scanClean: true, connectors, strippedFields };
    const bundle: TeamExport = {
      version: TEAM_EXPORT_CONSTANTS.VERSION,
      exportedAt: new Date().toISOString(),
      ...masked.value,
      portability,
    };
    // One more pass over the serialized package: anything the deep walk could
    // not see (a key name, a number rendered as text) would show up here.
    portability.scanClean = redactSecretsWithCount(JSON.stringify(bundle), options.knownSecrets).count === 0;
    return bundle;
  }

  /**
   * Import a team from a complete export bundle.
   *
   * Creates:
   * - Team via storageService.saveTeam() (runtime state stripped, so a 1.0
   *   package taken from a running team comes in idle too)
   * - Prompts written to teams/{teamId}/prompts/
   * - Norms written to teams/{teamId}/norms/
   * - Cron tasks with NEW IDs to teams/{teamId}/cron-tasks.json
   *
   * @param data - The team export bundle to import
   * @returns Import result with counts
   * @throws Error if import data is invalid or of an unsupported version
   */
  async importTeam(data: TeamExport): Promise<TeamImportResult> {
    if (!data.version || !data.team) {
      throw new Error('Invalid team export format: missing version or team data');
    }
    if (!isSupportedExportVersion(data.version)) {
      throw new Error(`Unsupported team export version: ${String(data.version)} (this Crewly reads ${TEAM_EXPORT_CONSTANTS.SUPPORTED_VERSIONS.join(', ')})`);
    }

    // Save the team config
    const { team } = stripRuntimeState(data.team);
    await this.storageService.saveTeam(team);
    const teamDir = this.storageService.getTeamDir(team.id);

    // Write prompts
    let promptsImported = 0;
    if (data.prompts && Object.keys(data.prompts).length > 0) {
      for (const [memberId, content] of Object.entries(data.prompts)) {
        await this.storageService.saveMemberPrompt(team.id, memberId, content);
        promptsImported++;
      }
    }

    // Write norms
    let normsImported = 0;
    if (data.norms && Object.keys(data.norms).length > 0) {
      const normsDir = path.join(teamDir, 'norms');
      mkdirSync(normsDir, { recursive: true });
      for (const [filename, content] of Object.entries(data.norms)) {
        await fs.writeFile(path.join(normsDir, filename), content, 'utf8');
        normsImported++;
      }
    }

    // Write cron tasks with new IDs and remapped targetTeamId
    let cronTasksImported = 0;
    if (data.cronTasks && data.cronTasks.length > 0) {
      const remapped: CronTask[] = data.cronTasks.map((task) => ({
        ...task,
        id: generateCronId(),
        targetTeamId: team.id,
      }));

      const cronStore: CronTaskStore = { tasks: remapped };
      const cronPath = path.join(teamDir, 'cron-tasks.json');
      await fs.writeFile(cronPath, JSON.stringify(cronStore, null, 2), 'utf8');
      cronTasksImported = remapped.length;
    }

    const connectorsToReconnect =
      data.portability?.connectors ?? referencedConnectors(team, data.prompts ?? {}, data.norms ?? {}, data.cronTasks ?? []);

    return {
      team,
      promptsImported,
      normsImported,
      cronTasksImported,
      connectorsToReconnect,
    };
  }

  /**
   * Read cron tasks from a team directory.
   *
   * @param teamDir - Path to the team directory
   * @returns Array of cron tasks, empty if file doesn't exist
   */
  private async readCronTasks(teamDir: string): Promise<CronTask[]> {
    const cronPath = path.join(teamDir, 'cron-tasks.json');
    try {
      const raw = await fs.readFile(cronPath, 'utf8');
      const store: CronTaskStore = JSON.parse(raw);
      return store.tasks ?? [];
    } catch {
      return [];
    }
  }
}

/**
 * Generate a unique cron task ID.
 *
 * @returns ID in format "cron-xxxxxxxx"
 */
export function generateCronId(): string {
  return `cron-${crypto.randomUUID().slice(0, 8)}`;
}
