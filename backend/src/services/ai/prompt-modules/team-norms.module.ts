/**
 * Team Norms Module
 *
 * Loads team-level norms/SOPs from the team's norms directory.
 * These norms originate from template application — when a template
 * is applied, its norms/*.md files are copied into the team directory.
 *
 * Priority 9.5: after DomainSOP (9), before lower-priority modules.
 * Compactable: yes — can be truncated under token pressure.
 *
 * @module services/ai/prompt-modules/team-norms
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PromptModule, ModuleConfig } from './prompt-module.interface.js';

/**
 * Maximum number of norm files to load per team to prevent prompt bloat.
 */
const MAX_NORM_FILES = 5;

/**
 * TeamNormsModule loads all markdown norm files from the team's norms directory
 * and injects them as team-level SOPs into the agent prompt.
 *
 * The norms directory path comes from `config.teamNormsPath`, which is set
 * during template application when a template has a `norms/` directory.
 *
 * @example
 * ```typescript
 * const mod = new TeamNormsModule();
 * mod.shouldInclude({ teamNormsPath: '/home/user/.crewly/teams/abc/norms' });
 * const content = await mod.build(config);
 * ```
 */
export class TeamNormsModule implements PromptModule {
  name = 'team-norms';
  priority = 9.5;
  maxTokens = 1500;
  compactable = true;

  /**
   * Include this module only when a teamNormsPath is configured and the directory exists.
   *
   * @param config - Module configuration
   * @returns True if team norms directory exists and contains files
   */
  shouldInclude(config: ModuleConfig): boolean {
    if (!config.teamNormsPath) return false;
    try {
      return fs.existsSync(config.teamNormsPath) &&
        fs.statSync(config.teamNormsPath).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Build the team norms prompt section by loading all .md files from the norms directory.
   *
   * @param config - Module configuration with teamNormsPath
   * @returns Formatted markdown section with all team norms
   */
  async build(config: ModuleConfig): Promise<string> {
    const normsPath = config.teamNormsPath!;
    const sections: string[] = ['## Team Norms & SOPs\n'];

    try {
      const entries = fs.readdirSync(normsPath)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .slice(0, MAX_NORM_FILES);

      if (entries.length === 0) {
        return '';
      }

      for (const entry of entries) {
        const filePath = path.join(normsPath, entry);
        try {
          const content = fs.readFileSync(filePath, 'utf-8').trim();
          if (content) {
            sections.push(content);
            sections.push(''); // blank line separator
          }
        } catch {
          // Skip unreadable files
        }
      }

      if (sections.length <= 1) {
        return '';
      }

      return sections.join('\n');
    } catch {
      return '';
    }
  }
}
