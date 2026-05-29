/**
 * WikiRecentService — surface the N most-recently-modified `.md` pages
 * in a vault. Powers the "What's new" widget in the page-pane empty
 * state, so a human landing on a vault sees the freshest content
 * without expanding the tree.
 *
 * Cheap to call: one filesystem walk + sort by mtime. Vaults are small
 * (O(100s) pages), so no caching for Phase 1.
 *
 * @module services/wiki/wiki-recent.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

/** Default number of recent pages returned when caller passes no limit. */
export const WIKI_RECENT_DEFAULT_LIMIT = 8;
/** Upper bound on the limit param to prevent unbounded responses. */
export const WIKI_RECENT_MAX_LIMIT = 50;
/** Cap on .md files walked per request. */
export const WIKI_RECENT_MAX_FILES = 500;

export interface WikiRecentEntry {
  /** Path relative to vault root. */
  relativePath: string;
  /** File size in bytes. */
  bytes: number;
  /** ISO timestamp of last modification. */
  modifiedAt: string;
  /** True if this file lives inside a folder whose name starts with `llm-curated/`. */
  llmCurated: boolean;
}

export type WikiRecentOutcome =
  | { ok: true; vaultPath: string; entries: WikiRecentEntry[] }
  | { ok: false; reason: 'vault_missing' | 'invalid_input'; message: string };

export interface WikiRecentInput {
  vaultPath: string;
  limit?: number;
}

/**
 * Singleton service for the recent-pages list.
 */
export class WikiRecentService {
  private static instance: WikiRecentService | null = null;

  static getInstance(): WikiRecentService {
    if (!this.instance) this.instance = new WikiRecentService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  async list(input: WikiRecentInput): Promise<WikiRecentOutcome> {
    const { vaultPath } = input;
    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'vaultPath must be an absolute path',
      };
    }
    if (!existsSync(vaultPath)) {
      return { ok: false, reason: 'vault_missing', message: `vault not found: ${vaultPath}` };
    }
    const requested = input.limit ?? WIKI_RECENT_DEFAULT_LIMIT;
    if (!Number.isFinite(requested) || requested <= 0) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'limit must be a positive number',
      };
    }
    const limit = Math.min(Math.floor(requested), WIKI_RECENT_MAX_LIMIT);

    const collected: WikiRecentEntry[] = [];
    await this.collectMdFiles(vaultPath, vaultPath, collected);

    collected.sort((a, b) => {
      // Most-recent first; ties broken by path for stability.
      if (a.modifiedAt !== b.modifiedAt) return a.modifiedAt < b.modifiedAt ? 1 : -1;
      return a.relativePath.localeCompare(b.relativePath);
    });

    return { ok: true, vaultPath, entries: collected.slice(0, limit) };
  }

  private async collectMdFiles(
    rootDir: string,
    dir: string,
    acc: WikiRecentEntry[],
  ): Promise<void> {
    if (acc.length >= WIKI_RECENT_MAX_FILES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (acc.length >= WIKI_RECENT_MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectMdFiles(rootDir, abs, acc);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const stat = await fs.stat(abs);
          const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
          acc.push({
            relativePath: rel,
            bytes: stat.size,
            modifiedAt: new Date(stat.mtimeMs).toISOString(),
            llmCurated: rel.startsWith('llm-curated/') || rel === 'llm-curated',
          });
        } catch {
          // unreadable — skip
        }
      }
    }
  }
}
