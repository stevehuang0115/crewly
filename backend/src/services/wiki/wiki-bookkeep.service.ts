/**
 * WikiBookkeepService — vault health metrics + consolidation signals.
 *
 * Per Steve's 2026-05-22 design point #5: "还要时不时让 agent 针对自己的
 * vault 进行 bookkeeping (可以根据存入的 md 数量来 trigger), 譬如过去 N
 * 天超过 X 个 md, 然后总结一下."
 *
 * This service produces the report the bookkeeping agent reads:
 *   - md count per top-level llm-curated subfolder
 *   - new mds in the last N days
 *   - filename clusters (likely-duplicates by Jaccard of token sets)
 *   - queue stats (so the agent sees pending items too)
 *
 * The agent uses this report (+ its LLM) to decide:
 *   - which pages to consolidate / dedupe (calls wiki-ingest with a new
 *     consolidated body + deletes the originals via a separate skill —
 *     deletion is OUT of scope for Phase 1; surface as proposals).
 *   - which topics deserve a summary "rollup" page.
 *
 * The service does NOT delete or rewrite anything. It reports.
 *
 * @module services/wiki/wiki-bookkeep.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SchemaLoaderService } from './schema-loader.service.js';
import { WikiQueueService } from './wiki-queue.service.js';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_MD_THRESHOLD = 10;
const MAX_PAGES_SCANNED = 1000;

export interface WikiBookkeepInput {
  /** Absolute vault path. */
  vaultPath: string;
  /** Window for "recent activity" stats. Default 7 days. */
  windowDays?: number;
  /** Md-count threshold used by `shouldFire` (default 10). */
  threshold?: number;
}

export interface WikiPageRef {
  path: string;
  bytes: number;
  modifiedAt: string;
}

export interface WikiDuplicateCluster {
  /** Shared base — the longest filename prefix across the cluster. */
  basis: string;
  /** Member pages (relative paths). */
  pages: string[];
}

export interface WikiBookkeepReport {
  vault: { scope: string; id: string; path: string };
  generatedAt: string;
  windowDays: number;
  threshold: number;
  /** Did we cross the threshold for "trigger a consolidation pass"? */
  shouldFire: boolean;
  /** Total md files under the vault (recursive). */
  totalMdCount: number;
  /** Newly created/touched mds within `windowDays`. */
  recentMdCount: number;
  /** Per-folder counts under llm-curated/<x>/. */
  countsByFolder: Record<string, number>;
  /** Likely-duplicate clusters by filename Jaccard. */
  duplicateCandidates: WikiDuplicateCluster[];
  /** Mds that haven't been touched in 90 days — stale candidates. */
  staleCount: number;
  /** Queue snapshot for this vault. */
  queue: {
    pending: number;
    claimed: number;
    processed: number;
    skipped: number;
    total: number;
  };
  /** Recommendations the agent's LLM should act on. */
  recommendations: string[];
}

export type WikiBookkeepOutcome =
  | { ok: true; report: WikiBookkeepReport }
  | { ok: false; reason: 'invalid_input' | 'schema_missing' | 'vault_missing'; message: string };

/**
 * Vault health + bookkeeping report generator. Stateless; uses the
 * schema loader + queue services it composes.
 */
export class WikiBookkeepService {
  private static instance: WikiBookkeepService | null = null;
  private readonly logger: ComponentLogger;
  private readonly schemaLoader: SchemaLoaderService;
  private readonly queue: WikiQueueService;

  constructor(
    schemaLoader?: SchemaLoaderService,
    queue?: WikiQueueService,
  ) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiBookkeep');
    this.schemaLoader = schemaLoader ?? new SchemaLoaderService();
    this.queue = queue ?? WikiQueueService.getInstance();
  }

  static getInstance(): WikiBookkeepService {
    if (!this.instance) this.instance = new WikiBookkeepService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Build the bookkeeping report. Caller (skill / cron / agent) decides
   * whether to act on `shouldFire`. The service never writes; it reports.
   */
  async generate(input: WikiBookkeepInput): Promise<WikiBookkeepOutcome> {
    if (!input.vaultPath || !path.isAbsolute(input.vaultPath)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'vaultPath must be absolute',
      };
    }
    if (!existsSync(input.vaultPath)) {
      return {
        ok: false,
        reason: 'vault_missing',
        message: `vault directory does not exist: ${input.vaultPath}`,
      };
    }
    let schema;
    try {
      schema = await this.schemaLoader.load(input.vaultPath);
    } catch (err) {
      return {
        ok: false,
        reason: 'schema_missing',
        message: (err as Error).message,
      };
    }

    const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
    const threshold = input.threshold ?? DEFAULT_MD_THRESHOLD;
    const windowMs = windowDays * 24 * 3600 * 1000;
    const now = Date.now();
    const staleMs = 90 * 24 * 3600 * 1000;

    const pages = await this.collectPages(input.vaultPath, schema.llm_curated.map((l) => l.path));
    const totalMdCount = pages.length;

    let recentMdCount = 0;
    let staleCount = 0;
    const countsByFolder: Record<string, number> = {};
    for (const p of pages) {
      const mtime = Date.parse(p.modifiedAt);
      if (Number.isFinite(mtime)) {
        if (now - mtime <= windowMs) recentMdCount++;
        if (now - mtime > staleMs) staleCount++;
      }
      // Folder bucket: first directory segment under llm-curated/.
      const rel = p.path;
      const parts = rel.split('/').filter(Boolean);
      // rel looks like "llm-curated/<folder>/<page>.md" → bucket = "llm-curated/<folder>".
      if (parts.length >= 2) {
        const bucket = `${parts[0]}/${parts[1]}`;
        countsByFolder[bucket] = (countsByFolder[bucket] ?? 0) + 1;
      } else if (parts.length === 1) {
        const bucket = parts[0];
        countsByFolder[bucket] = (countsByFolder[bucket] ?? 0) + 1;
      }
    }

    const duplicateCandidates = this.findDuplicateClusters(pages);
    const queueStats = await this.queue.getStats(input.vaultPath);

    const shouldFire = recentMdCount >= threshold || duplicateCandidates.length > 0;

    const recommendations = this.buildRecommendations({
      shouldFire,
      recentMdCount,
      threshold,
      duplicates: duplicateCandidates,
      countsByFolder,
      staleCount,
      queueStats,
    });

    const report: WikiBookkeepReport = {
      vault: {
        scope: schema.vault_scope,
        id: schema.vault_id,
        path: input.vaultPath,
      },
      generatedAt: new Date().toISOString(),
      windowDays,
      threshold,
      shouldFire,
      totalMdCount,
      recentMdCount,
      countsByFolder,
      duplicateCandidates,
      staleCount,
      queue: queueStats,
      recommendations,
    };

    this.logger.info('WikiBookkeep generated', {
      vault: input.vaultPath,
      totalMd: totalMdCount,
      recentMd: recentMdCount,
      duplicates: duplicateCandidates.length,
      shouldFire,
    });

    return { ok: true, report };
  }

  // ---------------------------------------------------------------------------

  private async collectPages(
    vaultPath: string,
    llmCuratedFolders: string[],
  ): Promise<WikiPageRef[]> {
    const pages: WikiPageRef[] = [];
    let scanned = 0;
    for (const folder of llmCuratedFolders) {
      const root = path.join(vaultPath, folder.replace(/[/\\]+$/, ''));
      if (!existsSync(root)) continue;
      const stack: string[] = [root];
      while (stack.length > 0 && scanned < MAX_PAGES_SCANNED) {
        const current = stack.pop()!;
        let entries: import('fs').Dirent[];
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
          scanned++;
          try {
            const stat = await fs.stat(full);
            pages.push({
              path: path.relative(vaultPath, full).replace(/\\/g, '/'),
              bytes: stat.size,
              modifiedAt: new Date(stat.mtimeMs).toISOString(),
            });
          } catch {
            // ignore
          }
        }
      }
    }
    return pages;
  }

  /**
   * Find filename clusters by Jaccard over name tokens.
   * Two pages with ≥ 0.6 overlap on their non-trivial filename tokens
   * are flagged as potential duplicates. Token = anything ≥ 3 chars
   * after splitting on `[-_./]`, lowercased, minus date prefix.
   */
  private findDuplicateClusters(pages: WikiPageRef[]): WikiDuplicateCluster[] {
    if (pages.length < 2) return [];
    const tokens = pages.map((p) => ({
      path: p.path,
      tokens: this.tokenizeFilename(p.path),
    }));
    const used = new Set<number>();
    const clusters: WikiDuplicateCluster[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (used.has(i)) continue;
      const peers: number[] = [i];
      for (let j = i + 1; j < tokens.length; j++) {
        if (used.has(j)) continue;
        if (this.jaccard(tokens[i].tokens, tokens[j].tokens) >= 0.6) {
          peers.push(j);
        }
      }
      if (peers.length >= 2) {
        peers.forEach((p) => used.add(p));
        const memberPaths = peers.map((p) => tokens[p].path);
        clusters.push({
          basis: this.longestCommonPrefix(memberPaths),
          pages: memberPaths,
        });
      }
    }
    return clusters;
  }

  private tokenizeFilename(relPath: string): Set<string> {
    const basename = relPath.split('/').pop()?.replace(/\.md$/, '') ?? '';
    // Strip ISO-date prefix (YYYY-MM-DD-)
    const withoutDate = basename.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const tokens = withoutDate
      .toLowerCase()
      .split(/[-_./\s]+/)
      .filter((t) => t.length >= 3);
    return new Set(tokens);
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  }

  private longestCommonPrefix(paths: string[]): string {
    if (paths.length === 0) return '';
    let prefix = paths[0];
    for (const p of paths.slice(1)) {
      while (p.indexOf(prefix) !== 0) {
        prefix = prefix.slice(0, -1);
        if (!prefix) return '';
      }
    }
    return prefix;
  }

  private buildRecommendations(args: {
    shouldFire: boolean;
    recentMdCount: number;
    threshold: number;
    duplicates: WikiDuplicateCluster[];
    countsByFolder: Record<string, number>;
    staleCount: number;
    queueStats: { pending: number };
  }): string[] {
    const recs: string[] = [];
    if (!args.shouldFire) {
      recs.push(
        `Quiet vault — only ${args.recentMdCount} new md(s) in the window (threshold ${args.threshold}). No action required.`,
      );
    } else {
      recs.push(
        `Window has ${args.recentMdCount} new md(s) — at or above threshold (${args.threshold}). Consider a consolidation pass.`,
      );
    }
    if (args.duplicates.length > 0) {
      recs.push(
        `${args.duplicates.length} likely-duplicate cluster(s) detected. Review each with your LLM and call wiki-ingest with a consolidated body when you can merge.`,
      );
      args.duplicates.slice(0, 3).forEach((c) => {
        recs.push(`  • cluster "${c.basis}": ${c.pages.join(', ')}`);
      });
    }
    if (args.queueStats.pending > 5) {
      recs.push(
        `${args.queueStats.pending} pending queue items. Drain via wiki-process-queue before doing other bookkeeping.`,
      );
    }
    const folderEntries = Object.entries(args.countsByFolder).sort((a, b) => b[1] - a[1]);
    if (folderEntries.length > 0) {
      const top = folderEntries[0];
      recs.push(
        `Hottest folder: \`${top[0]}\` (${top[1]} pages). If it's grown >20 pages without a rollup, write a summary index page.`,
      );
    }
    if (args.staleCount > 0) {
      recs.push(
        `${args.staleCount} page(s) untouched in 90+ days. Consider whether they're still authoritative — flag stale or archive.`,
      );
    }
    return recs;
  }
}
