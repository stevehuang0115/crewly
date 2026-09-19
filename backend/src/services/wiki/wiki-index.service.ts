/**
 * WikiIndexService — the one-line-per-page index that makes retrieval a
 * two-step read: read the whole index → pick 3–5 pages → read them in
 * full. No embeddings, no vector store; the index IS the retrieval.
 *
 * `llm-curated/index.md` is owned by the system: every page write updates
 * its line, every delete removes it, and `rebuild()` regenerates it from
 * the pages' frontmatter (also the migration path for vaults whose index
 * nobody maintained). Pages are grouped by their top-level curated folder.
 *
 * @module services/wiki/wiki-index.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WIKI_KB_CONSTANTS } from '../../constants.js';
import { parsePage, indexLineFor, type WikiPageFrontmatter } from './wiki-page.js';
import { walkCuratedPages, isSeedFile } from './wiki-vault-walk.js';

/** One entry of the parsed index. */
export interface WikiIndexEntry {
  relativePath: string;
  title: string;
  summary: string;
  supersededBy?: string;
  /** Top-level folder under llm-curated (e.g. `decisions`), or `_root`. */
  group: string;
}

/** Parsed index + raw text. */
export interface WikiIndex {
  entries: WikiIndexEntry[];
  raw: string;
  bytes: number;
}

/** Coverage report: pages the index does not know and vice versa. */
export interface WikiIndexCoverage {
  pages: number;
  indexed: number;
  missingFromIndex: string[];
  indexedButMissing: string[];
}

const HEADER = '# Index\n\nOne line per page — read this first, then open 3–5 pages. `⟶ superseded by` marks a page whose conclusion has been replaced.\n';
const LINE_RE = /^- \[(.+?)\]\(([^)]+)\)(?: — (.*?))?(?: ⟶ superseded by (\S+))?$/;

/**
 * Maintains `llm-curated/index.md` per vault.
 */
export class WikiIndexService {
  private static instance: WikiIndexService | null = null;
  private readonly logger: ComponentLogger;
  /** Per-vault write serialisation (index edits are read-modify-write). */
  private readonly locks = new Map<string, Promise<void>>();

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiIndex');
  }

  static getInstance(): WikiIndexService {
    if (!this.instance) this.instance = new WikiIndexService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Absolute path of a vault's index file.
   *
   * @param vaultPath - Vault root
   * @returns `<vault>/llm-curated/index.md`
   */
  indexPath(vaultPath: string): string {
    return path.join(vaultPath, 'llm-curated', WIKI_KB_CONSTANTS.INDEX_FILENAME);
  }

  /**
   * Read and parse the index (empty when absent).
   *
   * @param vaultPath - Vault root
   * @returns Parsed entries + raw text
   */
  async read(vaultPath: string): Promise<WikiIndex> {
    let raw = '';
    try {
      raw = await fs.readFile(this.indexPath(vaultPath), 'utf8');
    } catch {
      return { entries: [], raw: '', bytes: 0 };
    }
    return { entries: parseIndex(raw), raw, bytes: Buffer.byteLength(raw, 'utf8') };
  }

  /**
   * Insert or replace the line for one page.
   *
   * @param vaultPath - Vault root
   * @param relativePath - Vault-relative page path
   * @param fm - The page's frontmatter (title/summary/superseded_by are used)
   */
  async upsert(vaultPath: string, relativePath: string, fm: Partial<WikiPageFrontmatter>): Promise<void> {
    await this.withLock(vaultPath, async () => {
      const index = await this.read(vaultPath);
      const rel = relativePath.replace(/\\/g, '/');
      const entries = index.entries.filter((e) => e.relativePath !== rel);
      entries.push(entryFrom(rel, fm));
      await this.write(vaultPath, entries);
    });
  }

  /**
   * Remove a page's line (no-op when absent).
   *
   * @param vaultPath - Vault root
   * @param relativePath - Vault-relative page path
   */
  async remove(vaultPath: string, relativePath: string): Promise<void> {
    await this.withLock(vaultPath, async () => {
      const index = await this.read(vaultPath);
      const rel = relativePath.replace(/\\/g, '/');
      const entries = index.entries.filter((e) => e.relativePath !== rel);
      if (entries.length !== index.entries.length) await this.write(vaultPath, entries);
    });
  }

  /**
   * Regenerate the whole index from the pages on disk. Pages without a
   * `summary` still get a line (title only) so nothing is invisible, and
   * they show up in {@link coverage} as work for the bookkeeping agent.
   *
   * @param vaultPath - Vault root
   * @returns Number of entries written
   */
  async rebuild(vaultPath: string): Promise<number> {
    return this.withLock(vaultPath, async () => {
      const entries: WikiIndexEntry[] = [];
      for (const page of await walkCuratedPages(vaultPath)) {
        if (isSeedFile(page.relativePath)) continue;
        let raw: string;
        try {
          raw = await fs.readFile(page.absPath, 'utf8');
        } catch {
          continue;
        }
        const { frontmatter, body } = parsePage(raw);
        const fm = { ...frontmatter };
        if (!fm.title) fm.title = firstHeading(body) ?? path.basename(page.relativePath, '.md');
        entries.push(entryFrom(page.relativePath, fm));
      }
      await this.write(vaultPath, entries);
      this.logger.info('Wiki index rebuilt', { vaultPath, entries: entries.length });
      return entries.length;
    });
  }

  /**
   * Compare the index against the pages on disk.
   *
   * @param vaultPath - Vault root
   * @returns Coverage report
   */
  async coverage(vaultPath: string): Promise<WikiIndexCoverage> {
    const index = await this.read(vaultPath);
    const indexed = new Set(index.entries.map((e) => e.relativePath));
    const onDisk = new Set(
      (await walkCuratedPages(vaultPath)).map((p) => p.relativePath).filter((p) => !isSeedFile(p)),
    );
    return {
      pages: onDisk.size,
      indexed: indexed.size,
      missingFromIndex: [...onDisk].filter((p) => !indexed.has(p)).sort(),
      indexedButMissing: [...indexed].filter((p) => !onDisk.has(p)).sort(),
    };
  }

  /**
   * The index text an agent should read first, cut to the folders most
   * relevant to a query when the full index would not fit the budget.
   *
   * @param vaultPath - Vault root
   * @param queryTokens - Lower-cased query terms (for folder selection when trimming)
   * @param maxBytes - Budget (default {@link WIKI_KB_CONSTANTS.INDEX_MAX_BYTES})
   * @returns Text plus whether it was trimmed
   */
  async readForQuery(vaultPath: string, queryTokens: string[], maxBytes = WIKI_KB_CONSTANTS.INDEX_MAX_BYTES): Promise<{ text: string; truncated: boolean; entries: number }> {
    const index = await this.read(vaultPath);
    if (index.bytes <= maxBytes) return { text: index.raw, truncated: false, entries: index.entries.length };
    // Trim: keep groups whose lines mention a query term first, then fill.
    const terms = new Set(queryTokens.map((t) => t.toLowerCase()).filter((t) => t.length > 1));
    const score = (e: WikiIndexEntry): number => {
      const hay = `${e.title} ${e.summary} ${e.relativePath}`.toLowerCase();
      let n = 0;
      for (const t of terms) if (hay.includes(t)) n++;
      return n;
    };
    const ranked = [...index.entries].sort((a, b) => score(b) - score(a) || a.relativePath.localeCompare(b.relativePath));
    const kept: WikiIndexEntry[] = [];
    let bytes = Buffer.byteLength(HEADER, 'utf8');
    for (const e of ranked) {
      const line = indexLineFor(e.relativePath, { title: e.title, summary: e.summary, superseded_by: e.supersededBy }) + '\n';
      const b = Buffer.byteLength(line, 'utf8');
      if (bytes + b > maxBytes) break;
      bytes += b;
      kept.push(e);
    }
    return { text: render(kept) + `\n_(index trimmed to ${kept.length} of ${index.entries.length} entries for this query)_\n`, truncated: true, entries: kept.length };
  }

  private async write(vaultPath: string, entries: WikiIndexEntry[]): Promise<void> {
    const file = this.indexPath(vaultPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, render(entries), 'utf8');
    await fs.rename(tmp, file);
  }

  private async withLock<T>(vaultPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(vaultPath) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    this.locks.set(vaultPath, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(vaultPath) === gate) this.locks.delete(vaultPath);
    }
  }
}

/**
 * Parse index lines back into entries.
 *
 * @param raw - index.md text
 * @returns Entries in file order
 */
export function parseIndex(raw: string): WikiIndexEntry[] {
  const entries: WikiIndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const relativePath = m[2];
    entries.push({
      relativePath,
      title: m[1],
      summary: m[3] ?? '',
      ...(m[4] ? { supersededBy: m[4] } : {}),
      group: groupOf(relativePath),
    });
  }
  return entries;
}

function entryFrom(relativePath: string, fm: Partial<WikiPageFrontmatter>): WikiIndexEntry {
  const line = indexLineFor(relativePath, fm);
  const parsed = parseIndex(line)[0];
  return parsed ?? { relativePath, title: relativePath, summary: '', group: groupOf(relativePath) };
}

function groupOf(relativePath: string): string {
  const parts = relativePath.replace(/^llm-curated\//, '').split('/');
  return parts.length > 1 ? parts[0] : '_root';
}

function render(entries: WikiIndexEntry[]): string {
  const groups = new Map<string, WikiIndexEntry[]>();
  for (const e of entries) {
    const g = groups.get(e.group) ?? [];
    g.push(e);
    groups.set(e.group, g);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '_root' ? 1 : b === '_root' ? -1 : a.localeCompare(b)));
  const out: string[] = [HEADER];
  for (const name of names) {
    out.push(`\n## ${name === '_root' ? 'Other' : name}\n`);
    for (const e of groups.get(name)!.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
      out.push(indexLineFor(e.relativePath, { title: e.title, summary: e.summary, superseded_by: e.supersededBy }));
    }
  }
  return out.join('\n') + '\n';
}

function firstHeading(body: string): string | null {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Whether a vault has an index file at all. */
export function hasIndex(vaultPath: string): boolean {
  return existsSync(path.join(vaultPath, 'llm-curated', WIKI_KB_CONSTANTS.INDEX_FILENAME));
}
