/**
 * Wiki Search Service
 *
 * In-process full-text search across a wiki vault's `.md` files. Returns
 * per-file matches with line numbers + short snippets so the UI can render
 * a result list and let the user jump straight to a page.
 *
 * Phase 1: simple case-insensitive substring search. No tokenization,
 * stemming, or inverted index. The vaults here are O(100s) of pages so
 * walking + grepping per request is fine; we'll revisit when volumes
 * justify a real index.
 *
 * @module services/wiki/wiki-search.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';

/** Cap on how many .md files are inspected per search. */
export const WIKI_SEARCH_MAX_FILES = 500;
/** Cap on how many results returned to the caller. */
export const WIKI_SEARCH_MAX_RESULTS = 50;
/** Cap on how many snippets surfaced per matching file. */
export const WIKI_SEARCH_MAX_SNIPPETS_PER_FILE = 3;
/** Maximum query length — guards against pathological input. */
export const WIKI_SEARCH_MAX_QUERY_LENGTH = 200;
/** Cap on per-file size we will read; larger files are skipped. */
export const WIKI_SEARCH_MAX_FILE_BYTES = 256 * 1024;

export interface WikiSearchSnippet {
  /** 1-based line number where the match was found. */
  lineNumber: number;
  /** The matching line (trimmed for display). */
  text: string;
}

export interface WikiSearchHit {
  /** Relative path inside the vault, with forward slashes. */
  relativePath: string;
  /** True when the filename itself contains the query. */
  filenameMatch: boolean;
  /** Number of total content matches across the file. */
  matchCount: number;
  /** Up to `WIKI_SEARCH_MAX_SNIPPETS_PER_FILE` matching lines. */
  snippets: WikiSearchSnippet[];
}

export interface WikiSearchResult {
  ok: true;
  vaultPath: string;
  query: string;
  hits: WikiSearchHit[];
  /** True when the file/result cap was hit; UI should hint "narrow your search". */
  truncated: boolean;
}

export interface WikiSearchFailure {
  ok: false;
  reason: 'vault_missing' | 'invalid_input' | 'invalid_query';
  message: string;
}

export interface WikiSearchInput {
  vaultPath: string;
  query: string;
}

/**
 * Service exposing `search()`. Stateless singleton — the constructor is
 * empty but we use the class pattern to match the rest of the wiki
 * services (`WikiBookkeepService.getInstance()`, etc.).
 */
export class WikiSearchService {
  private static instance: WikiSearchService | null = null;

  /** Singleton accessor. */
  static getInstance(): WikiSearchService {
    if (!this.instance) this.instance = new WikiSearchService();
    return this.instance;
  }

  /** Reset for tests. */
  static resetInstance(): void {
    this.instance = null;
  }

  /**
   * Search a vault. Returns either `{ok:true, hits}` or a structured
   * failure. The handler never throws on filesystem read errors — they
   * are silently skipped so one bad file doesn't blank the whole result.
   */
  async search(input: WikiSearchInput): Promise<WikiSearchResult | WikiSearchFailure> {
    const vaultPath = input.vaultPath;
    const rawQuery = input.query ?? '';

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

    const query = rawQuery.trim();
    if (query.length === 0) {
      return {
        ok: false,
        reason: 'invalid_query',
        message: 'query must be at least one non-whitespace character',
      };
    }
    if (query.length > WIKI_SEARCH_MAX_QUERY_LENGTH) {
      return {
        ok: false,
        reason: 'invalid_query',
        message: `query exceeds ${WIKI_SEARCH_MAX_QUERY_LENGTH} characters`,
      };
    }

    const needle = query.toLowerCase();
    const allFiles: string[] = [];
    await this.collectMdFiles(vaultPath, vaultPath, allFiles);
    const truncatedFiles = allFiles.length >= WIKI_SEARCH_MAX_FILES;
    const slice = allFiles.slice(0, WIKI_SEARCH_MAX_FILES);

    const hits: WikiSearchHit[] = [];
    for (const relativePath of slice) {
      const hit = await this.searchFile(vaultPath, relativePath, needle);
      if (hit) hits.push(hit);
    }

    // Rank: filename matches first, then matchCount desc, then path asc for stability.
    hits.sort((a, b) => {
      if (a.filenameMatch !== b.filenameMatch) return a.filenameMatch ? -1 : 1;
      if (a.matchCount !== b.matchCount) return b.matchCount - a.matchCount;
      return a.relativePath.localeCompare(b.relativePath);
    });

    const truncatedResults = hits.length > WIKI_SEARCH_MAX_RESULTS;
    const capped = hits.slice(0, WIKI_SEARCH_MAX_RESULTS);
    const truncated = truncatedFiles || truncatedResults;
    return { ok: true, vaultPath, query, hits: capped, truncated };
  }

  /**
   * Recursive walk collecting `.md` files. Skips dotfile dirs (e.g.
   * `.git`, `.queue`) and stops once `WIKI_SEARCH_MAX_FILES` is reached.
   *
   * @param rootDir - vault root (used to compute relativePath).
   * @param dir - current directory being walked.
   * @param acc - accumulator populated with relative paths.
   */
  private async collectMdFiles(rootDir: string, dir: string, acc: string[]): Promise<void> {
    if (acc.length >= WIKI_SEARCH_MAX_FILES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (acc.length >= WIKI_SEARCH_MAX_FILES) return;
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

  /**
   * Read one file and accumulate up to `WIKI_SEARCH_MAX_SNIPPETS_PER_FILE`
   * snippets. Returns null when the file matches nothing.
   */
  private async searchFile(
    vaultPath: string,
    relativePath: string,
    needle: string,
  ): Promise<WikiSearchHit | null> {
    const absPath = path.join(vaultPath, relativePath);
    const filenameMatch = relativePath.toLowerCase().includes(needle);

    let stat: import('fs').Stats;
    try {
      stat = await fs.stat(absPath);
    } catch {
      return filenameMatch
        ? { relativePath, filenameMatch: true, matchCount: 0, snippets: [] }
        : null;
    }
    if (stat.size > WIKI_SEARCH_MAX_FILE_BYTES) {
      return filenameMatch
        ? { relativePath, filenameMatch: true, matchCount: 0, snippets: [] }
        : null;
    }

    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      return filenameMatch
        ? { relativePath, filenameMatch: true, matchCount: 0, snippets: [] }
        : null;
    }

    const lines = content.split(/\r?\n/);
    const snippets: WikiSearchSnippet[] = [];
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.toLowerCase().includes(needle)) {
        matchCount++;
        if (snippets.length < WIKI_SEARCH_MAX_SNIPPETS_PER_FILE) {
          snippets.push({
            lineNumber: i + 1,
            text: line.trim().slice(0, 300),
          });
        }
      }
    }

    if (matchCount === 0 && !filenameMatch) return null;
    return {
      relativePath,
      filenameMatch,
      matchCount,
      snippets,
    };
  }
}
