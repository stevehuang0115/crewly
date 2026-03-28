/**
 * Team Export/Import Service
 *
 * Bundles a team's config, prompts, norms, and cron tasks into a single
 * exportable JSON document. Supports importing from that format to create
 * a complete team with all associated data.
 *
 * Part of the team-scoped cron feature (Phase 3).
 *
 * @module services/core/team-export.service
 */

import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Team } from '../../types/index.js';
import type { CronTask, CronTaskStore } from '../../types/cron-task.types.js';
import type { StorageService } from './storage.service.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Complete team export bundle containing all team data.
 *
 * This is the portable format for team backup, migration, and sharing.
 */
export interface TeamExport {
  /** Format version for forward compatibility */
  version: '1.0';
  /** ISO timestamp when the export was created */
  exportedAt: string;
  /** Team configuration (config.json content) */
  team: Team;
  /** Member prompts: memberId → prompt content */
  prompts: Record<string, string>;
  /** Team norms/SOPs: filename → markdown content */
  norms: Record<string, string>;
  /** Team-scoped cron tasks */
  cronTasks: CronTask[];
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
   * Export a team and all its associated data as a single JSON bundle.
   *
   * Collects:
   * - Team config (config.json)
   * - Member prompts (prompts/*.md)
   * - Norms/SOPs (norms/*.md)
   * - Cron tasks (cron-tasks.json)
   *
   * @param teamId - ID of the team to export
   * @returns Complete team export bundle
   * @throws Error if team not found
   */
  async exportTeam(teamId: string): Promise<TeamExport> {
    const teams = await this.storageService.getTeams();
    const team = teams.find((t) => t.id === teamId);
    if (!team) {
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

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      team,
      prompts,
      norms,
      cronTasks,
    };
  }

  /**
   * Import a team from a complete export bundle.
   *
   * Creates:
   * - Team via storageService.saveTeam()
   * - Prompts written to teams/{teamId}/prompts/
   * - Norms written to teams/{teamId}/norms/
   * - Cron tasks with NEW IDs to teams/{teamId}/cron-tasks.json
   *
   * @param data - The team export bundle to import
   * @returns Import result with counts
   * @throws Error if import data is invalid
   */
  async importTeam(data: TeamExport): Promise<TeamImportResult> {
    if (!data.version || !data.team) {
      throw new Error('Invalid team export format: missing version or team data');
    }

    // Save the team config
    const team = data.team;
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

    return {
      team,
      promptsImported,
      normsImported,
      cronTasksImported,
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
