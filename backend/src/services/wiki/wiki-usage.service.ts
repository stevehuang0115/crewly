/**
 * WikiUsageService — the retrieval ledger.
 *
 * Every query against a vault appends one JSONL line: who asked, what,
 * which pages were read, and whether it was a miss (nothing relevant).
 * This is the only honest signal for "is the knowledge base alive":
 * pages nobody reads and questions nobody could answer both come out of
 * it, and the bookkeeping report turns them into work.
 *
 * @module services/wiki/wiki-usage.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { WIKI_KB_CONSTANTS } from '../../constants.js';

/** One retrieval event. */
export interface WikiUsageEvent {
  at: string;
  /** `wiki-query` | `recall` | `search` | `page` */
  via: string;
  agent: string;
  query: string;
  /** Vault-relative pages returned/read. */
  hits: string[];
  /** True when nothing relevant came back — a capture gap. */
  miss: boolean;
}

/** Aggregate over a window. */
export interface WikiUsageReport {
  windowDays: number;
  queries: number;
  misses: number;
  /** Distinct pages read at least once in the window. */
  pagesRead: number;
  /** Most-read pages, descending. */
  topPages: Array<{ path: string; reads: number }>;
  /** Queries that found nothing (deduped, most recent first). */
  missedQueries: string[];
  /** Agents that queried, with counts. */
  byAgent: Array<{ agent: string; queries: number }>;
}

/**
 * Appends and summarises `llm-curated/usage.jsonl` per vault.
 */
export class WikiUsageService {
  private static instance: WikiUsageService | null = null;
  private readonly logger: ComponentLogger;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiUsage');
  }

  static getInstance(): WikiUsageService {
    if (!this.instance) this.instance = new WikiUsageService();
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Ledger path for a vault.
   *
   * @param vaultPath - Vault root
   * @returns `<vault>/llm-curated/usage.jsonl`
   */
  ledgerPath(vaultPath: string): string {
    return path.join(vaultPath, 'llm-curated', WIKI_KB_CONSTANTS.USAGE_FILENAME);
  }

  /**
   * Append one event. Never throws (a ledger failure must not fail a query).
   *
   * @param vaultPath - Vault root
   * @param event - Event fields (`at` is filled in)
   */
  async record(vaultPath: string, event: Omit<WikiUsageEvent, 'at'>): Promise<void> {
    const line = JSON.stringify({ at: this.now().toISOString(), ...event, query: event.query.slice(0, 300) }) + '\n';
    try {
      const file = this.ledgerPath(vaultPath);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, line, 'utf8');
      await this.rotateIfLarge(file);
    } catch (err) {
      this.logger.debug('usage ledger append failed (non-fatal)', { vaultPath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Read events in the last N days.
   *
   * @param vaultPath - Vault root
   * @param windowDays - Window (default {@link WIKI_KB_CONSTANTS.USAGE_WINDOW_DAYS})
   * @returns Events, oldest first
   */
  async events(vaultPath: string, windowDays: number = WIKI_KB_CONSTANTS.USAGE_WINDOW_DAYS): Promise<WikiUsageEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.ledgerPath(vaultPath), 'utf8');
    } catch {
      return [];
    }
    const since = this.now().getTime() - windowDays * 24 * 3600 * 1000;
    const out: WikiUsageEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as WikiUsageEvent;
        if (Date.parse(e.at) >= since) out.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  /**
   * Summarise the window: read counts, misses, unread work.
   *
   * @param vaultPath - Vault root
   * @param windowDays - Window
   * @returns Report
   */
  async report(vaultPath: string, windowDays: number = WIKI_KB_CONSTANTS.USAGE_WINDOW_DAYS): Promise<WikiUsageReport> {
    const events = await this.events(vaultPath, windowDays);
    const reads = new Map<string, number>();
    const byAgent = new Map<string, number>();
    const missed: string[] = [];
    for (const e of events) {
      for (const p of e.hits) reads.set(p, (reads.get(p) ?? 0) + 1);
      byAgent.set(e.agent, (byAgent.get(e.agent) ?? 0) + 1);
      if (e.miss) missed.push(e.query);
    }
    return {
      windowDays,
      queries: events.length,
      misses: missed.length,
      pagesRead: reads.size,
      topPages: [...reads.entries()].map(([p, n]) => ({ path: p, reads: n })).sort((a, b) => b.reads - a.reads).slice(0, 20),
      missedQueries: [...new Set(missed.reverse())].slice(0, 20),
      byAgent: [...byAgent.entries()].map(([agent, queries]) => ({ agent, queries })).sort((a, b) => b.queries - a.queries),
    };
  }

  /**
   * Pages never read in the window (given the full page list).
   *
   * @param vaultPath - Vault root
   * @param allPages - Vault-relative page paths
   * @param windowDays - Window
   * @returns Unread pages
   */
  async unreadPages(vaultPath: string, allPages: string[], windowDays: number = WIKI_KB_CONSTANTS.USAGE_WINDOW_DAYS): Promise<string[]> {
    const read = new Set<string>();
    for (const e of await this.events(vaultPath, windowDays)) for (const p of e.hits) read.add(p);
    return allPages.filter((p) => !read.has(p));
  }

  private async rotateIfLarge(file: string): Promise<void> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || stat.size <= WIKI_KB_CONSTANTS.USAGE_MAX_BYTES) return;
    const raw = await fs.readFile(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    await fs.writeFile(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
  }
}
