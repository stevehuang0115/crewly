/**
 * Wiki Backlinks Service
 *
 * Given a target page in a vault, scan every other page for `[[wikilink]]`
 * references that resolve to it. Powers the UI's right-side "References"
 * panel.
 *
 * Phase 1: plain scan, no incremental index. Vaults are small enough that
 * a single regex pass per file is fine.
 *
 * @module services/wiki/wiki-backlinks.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

/** Hard cap on scanned files to avoid pathological vaults. */
export const WIKI_BACKLINKS_MAX_FILES = 500;
/** Cap on per-file size to read; larger files are skipped. */
export const WIKI_BACKLINKS_MAX_FILE_BYTES = 256 * 1024;
/** Max snippets surfaced per source page. */
export const WIKI_BACKLINKS_MAX_SNIPPETS_PER_FILE = 2;
/** Total backlink rows returned. */
export const WIKI_BACKLINKS_MAX_RESULTS = 50;

/** `[[target]]` or `[[target|alias]]`. */
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;

export interface WikiBacklinkSnippet {
  lineNumber: number;
  text: string;
}

export interface WikiBacklink {
  /** Source page that links to the target. */
  relativePath: string;
  /** Up to N snippets where the link appears. */
  snippets: WikiBacklinkSnippet[];
}

export interface WikiBacklinksInput {
  vaultPath: string;
  /** The page being backlinked TO. */
  relativePath: string;
}

export interface WikiBacklinksResult {
  ok: true;
  vaultPath: string;
  relativePath: string;
  backlinks: WikiBacklink[];
  truncated: boolean;
}

export interface WikiBacklinksFailure {
  ok: false;
  reason: 'vault_missing' | 'invalid_input';
  message: string;
}

/**
 * Resolve a wikilink target string against a known target page.
 *
 * The matcher mirrors the frontend's `resolveWikilink` semantics so a
 * `[[customers/anthropic]]` reference matches the page at
 * `llm-curated/customers/anthropic.md`.
 *
 * @param wikilinkTarget - Raw target from `[[…]]` (no alias, trimmed).
 * @param normalizedTargetPath - The target page path, normalized (lowercase,
 *   forward slashes, with `.md` suffix).
 * @returns true when the wikilink would resolve to the target page.
 */
export function wikilinkMatchesTarget(
  wikilinkTarget: string,
  normalizedTargetPath: string,
): boolean {
  const raw = wikilinkTarget.trim().toLowerCase();
  if (!raw) return false;

  const withMd = raw.endsWith('.md') ? raw : `${raw}.md`;
  if (withMd === normalizedTargetPath) return true;
  if (normalizedTargetPath.endsWith(`/${withMd}`)) return true;

  // Basename match — only if the wikilink target has no slashes (it's just
  // a name) so we don't over-match on partial paths.
  if (!raw.includes('/')) {
    const baseNoMd = raw.endsWith('.md') ? raw.slice(0, -3) : raw;
    const targetBase = normalizedTargetPath.split('/').pop() ?? '';
    const targetBaseNoMd = targetBase.endsWith('.md')
      ? targetBase.slice(0, -3)
      : targetBase;
    if (baseNoMd === targetBaseNoMd) return true;
  }
  return false;
}

/**
 * Backlinks service. Singleton pattern to match the other wiki services.
 */
export class WikiBacklinksService {
  private static instance: WikiBacklinksService | null = null;

  static getInstance(): WikiBacklinksService {
    if (!this.instance) this.instance = new WikiBacklinksService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  async find(
    input: WikiBacklinksInput,
  ): Promise<WikiBacklinksResult | WikiBacklinksFailure> {
    const { vaultPath, relativePath } = input;

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
    if (!relativePath || !relativePath.endsWith('.md')) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'relativePath is required and must end in .md',
      };
    }

    const normalizedTarget = relativePath.replace(/\\/g, '/').toLowerCase();

    const allFiles: string[] = [];
    await this.collectMdFiles(vaultPath, vaultPath, allFiles);
    const truncatedFiles = allFiles.length >= WIKI_BACKLINKS_MAX_FILES;
    const slice = allFiles.slice(0, WIKI_BACKLINKS_MAX_FILES);

    const backlinks: WikiBacklink[] = [];
    for (const source of slice) {
      if (backlinks.length >= WIKI_BACKLINKS_MAX_RESULTS) break;
      // A page does not backlink to itself.
      if (source.toLowerCase() === normalizedTarget) continue;
      const found = await this.scanFile(vaultPath, source, normalizedTarget);
      if (found) backlinks.push(found);
    }

    return {
      ok: true,
      vaultPath,
      relativePath,
      backlinks,
      truncated: truncatedFiles || backlinks.length >= WIKI_BACKLINKS_MAX_RESULTS,
    };
  }

  private async collectMdFiles(rootDir: string, dir: string, acc: string[]): Promise<void> {
    if (acc.length >= WIKI_BACKLINKS_MAX_FILES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (acc.length >= WIKI_BACKLINKS_MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectMdFiles(rootDir, abs, acc);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
        acc.push(rel);
      }
    }
  }

  private async scanFile(
    vaultPath: string,
    relativePath: string,
    normalizedTarget: string,
  ): Promise<WikiBacklink | null> {
    const abs = path.join(vaultPath, relativePath);
    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      return null;
    }
    if (stat.size > WIKI_BACKLINKS_MAX_FILE_BYTES) return null;
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch {
      return null;
    }
    if (!content.includes('[[')) return null;

    const lines = content.split(/\r?\n/);
    const snippets: WikiBacklinkSnippet[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('[[')) continue;
      WIKILINK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = WIKILINK_RE.exec(line)) !== null) {
        if (wikilinkMatchesTarget(m[1], normalizedTarget)) {
          if (snippets.length < WIKI_BACKLINKS_MAX_SNIPPETS_PER_FILE) {
            snippets.push({
              lineNumber: i + 1,
              text: line.trim().slice(0, 300),
            });
          }
          break; // one snippet per line
        }
      }
      if (snippets.length >= WIKI_BACKLINKS_MAX_SNIPPETS_PER_FILE) break;
    }
    return snippets.length > 0 ? { relativePath, snippets } : null;
  }
}
