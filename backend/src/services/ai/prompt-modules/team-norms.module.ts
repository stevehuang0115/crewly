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
 * Applied AFTER frontmatter filtering, so deprecated/off-role norms do not
 * consume a slot.
 */
const MAX_NORM_FILES = 5;

/**
 * Parsed frontmatter fields recognised by this module.
 *
 * - `deprecated: true` — skip entirely (retired SOP).
 * - `appliesTo: [role, ...]` — only include when the agent's role matches
 *   one of the listed roles. Accepts a scalar or comma-separated string too.
 * - `priority: number` — sort key (higher first) so critical norms win the
 *   limited slots under MAX_NORM_FILES.
 * - `title`, `version`, `trigger`, etc. are tolerated but not acted on here;
 *   the `get-team-norms` skill consumes the same format.
 */
interface NormFrontmatter {
  deprecated?: boolean;
  appliesTo?: string[];
  priority?: number;
}

/**
 * Parse a `---`-delimited YAML frontmatter block at the start of the file.
 * Returns the parsed fields plus the remaining content. Only supports the
 * handful of simple scalar/sequence forms we care about — intentionally
 * avoids adding a YAML dependency to this hot path.
 */
function parseFrontmatter(raw: string): {
  meta: NormFrontmatter;
  content: string;
} {
  if (!raw.startsWith('---')) {
    return { meta: {}, content: raw };
  }
  const lines = raw.split('\n');
  // Find the closing --- (first delimiter is line 0)
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { meta: {}, content: raw };
  }

  const meta: NormFrontmatter = {};
  for (const line of lines.slice(1, end)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip inline comment
    const hashIdx = value.indexOf(' #');
    if (hashIdx >= 0) value = value.slice(0, hashIdx).trim();

    if (key === 'deprecated') {
      meta.deprecated = /^(true|yes|1)$/i.test(value);
    } else if (key === 'appliesTo') {
      // Accept: `appliesTo: [a, b]` | `appliesTo: a` | `appliesTo: a, b`
      const stripped = value.replace(/^\[|\]$/g, '');
      meta.appliesTo = stripped
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    } else if (key === 'priority') {
      const n = Number(value);
      if (!Number.isNaN(n)) meta.priority = n;
    }
  }
  return { meta, content: lines.slice(end + 1).join('\n') };
}

/**
 * Decides whether a norm applies to the current agent given parsed frontmatter.
 * Universal (no `appliesTo`) norms always apply. Role-scoped norms apply when
 * the agent's role is listed.
 */
function normApplies(meta: NormFrontmatter, role: string | undefined): boolean {
  if (meta.deprecated) return false;
  if (!meta.appliesTo || meta.appliesTo.length === 0) return true;
  if (!role) return false;
  return meta.appliesTo.includes(role);
}

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
   * Build the team norms prompt section by loading relevant .md files from
   * the norms directory.
   *
   * Selection is a two-stage pipeline designed to keep the marketing team's
   * 50+ SOP files from blowing the prompt budget:
   *
   * 1. **Filter**: parse each file's YAML frontmatter, skip `deprecated: true`
   *    and skip files whose `appliesTo` does not include the agent's role.
   * 2. **Rank + cap**: sort survivors by descending `priority` (default 0),
   *    then alphabetically for stable ordering, then keep at most
   *    `MAX_NORM_FILES`.
   *
   * Frontmatter is stripped from the emitted content — agents see the SOP
   * body, not the routing metadata.
   *
   * @param config - Module configuration with teamNormsPath and role
   * @returns Formatted markdown section with the applicable norms
   */
  async build(config: ModuleConfig): Promise<string> {
    const normsPath = config.teamNormsPath!;
    const sections: string[] = ['## Team Norms & SOPs\n'];

    try {
      const dirExists = await fs.promises
        .access(normsPath)
        .then(() => true)
        .catch(() => false);
      if (!dirExists) {
        return '';
      }

      const allEntries = await fs.promises.readdir(normsPath);
      const mdFiles = allEntries.filter((f) => f.endsWith('.md')).sort();

      // Stage 1: read + parse frontmatter, filter on role/deprecated.
      type Candidate = {
        fileName: string;
        content: string;
        priority: number;
      };
      const candidates: Candidate[] = [];

      for (const entry of mdFiles) {
        const filePath = path.join(normsPath, entry);
        try {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const { meta, content } = parseFrontmatter(raw);
          if (!normApplies(meta, config.role)) continue;
          const trimmed = content.trim();
          if (!trimmed) continue;
          candidates.push({
            fileName: entry,
            content: trimmed,
            priority: meta.priority ?? 0,
          });
        } catch {
          // Skip unreadable files silently — one bad file shouldn't kill the module.
        }
      }

      if (candidates.length === 0) {
        return '';
      }

      // Stage 2: rank by priority desc, then filename asc, then cap.
      candidates.sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.fileName.localeCompare(b.fileName);
      });
      const chosen = candidates.slice(0, MAX_NORM_FILES);

      for (const item of chosen) {
        sections.push(item.content);
        sections.push(''); // blank line separator
      }

      return sections.join('\n');
    } catch {
      return '';
    }
  }
}
