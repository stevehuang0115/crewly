/**
 * Shared vault walker: every `.md` page under `llm-curated/`, skipping
 * dot-dirs, `node_modules`, the proposals folder and history snapshots.
 *
 * @module services/wiki/wiki-vault-walk
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { WIKI_KB_CONSTANTS } from '../../constants.js';

/** A page reference. */
export interface WikiPageRef {
  /** POSIX path relative to the vault root, e.g. `llm-curated/decisions/x.md`. */
  relativePath: string;
  absPath: string;
}

/** Files that are not knowledge pages (index, log, readme). */
export function isSeedFile(relativePath: string): boolean {
  const base = relativePath.split('/').pop()?.toLowerCase() ?? '';
  return base === 'index.md' || base === 'log.md' || base === 'readme.md' || base === 'schema.md';
}

/**
 * Walk `<vault>/llm-curated/` and list every `.md` page.
 *
 * @param vaultPath - Vault root
 * @param options - `includeProposed` also lists `_proposed/` pages
 * @returns Page refs, sorted by relative path
 */
export async function walkCuratedPages(
  vaultPath: string,
  options: { includeProposed?: boolean } = {},
): Promise<WikiPageRef[]> {
  const root = path.join(vaultPath, 'llm-curated');
  const proposedAbs = path.join(vaultPath, WIKI_KB_CONSTANTS.PROPOSED_DIR);
  const out: WikiPageRef[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (abs === proposedAbs && !options.includeProposed) continue;
        stack.push(abs);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push({ relativePath: path.relative(vaultPath, abs).replace(/\\/g, '/'), absPath: abs });
      }
    }
  }
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
