/**
 * Exclude-pattern matching for project source trees captured by the backup.
 *
 * Deliberately small (no glob dependency): patterns without a `/` match a
 * single path segment at any depth (`node_modules`, `*.log`, `dist`);
 * patterns with a `/` match the whole project-relative POSIX path, where `*`
 * matches within one segment and a double star matches across segments
 * (e.g. `build/` + double star, or `src/` + double star + `/*.snap`). A
 * pattern that matches a directory prunes the whole subtree.
 *
 * @module services/backup/project-file-filter
 */

/** Compiled exclude matcher. */
export interface ProjectFileFilter {
  /** True when the project-relative POSIX path (file or directory) is excluded. */
  isExcluded(relPath: string): boolean;
  /** The source patterns, for the manifest. */
  patterns: string[];
}

/**
 * Escape regex metacharacters except the glob tokens handled separately.
 *
 * @param s - Literal text
 * @returns Escaped text
 */
function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert one glob pattern to a RegExp.
 *
 * @param pattern - Glob (see module docs)
 * @param wholePath - True to match a full relative path (double star allowed)
 * @returns Anchored RegExp
 */
export function globToRegExp(pattern: string, wholePath: boolean): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (wholePath && pattern[i + 1] === '*') {
        // double star + slash → zero or more segments; trailing double star → anything
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Build a matcher from exclude patterns.
 *
 * @param patterns - Glob patterns (empty → nothing excluded)
 * @returns The compiled filter
 */
export function createProjectFileFilter(patterns: readonly string[]): ProjectFileFilter {
  const segmentRules: RegExp[] = [];
  const pathRules: RegExp[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pattern) continue;
    if (pattern.includes('/')) pathRules.push(globToRegExp(pattern, true));
    else segmentRules.push(globToRegExp(pattern, false));
  }
  return {
    patterns: [...patterns],
    isExcluded(relPath: string): boolean {
      const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!normalized) return false;
      if (pathRules.some((r) => r.test(normalized))) return true;
      if (segmentRules.length === 0) return false;
      return normalized.split('/').some((seg) => segmentRules.some((r) => r.test(seg)));
    },
  };
}
