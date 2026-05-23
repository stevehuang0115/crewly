/**
 * WikiQueryService — read a vault and build the `system-context` payload
 * that the caller's runtime feeds to its LLM for synthesis.
 *
 * Per v2.1 spec §3 the skill is split into two halves:
 *   - System-context (LLM-agnostic) → what this service produces
 *   - Task-instruction (per-LLM)    → lives on disk under
 *     `config/skills/<role>/wiki-<verb>/prompts/<runtime>.md` and is
 *     concatenated by the caller's runtime, NOT by us.
 *
 * Phase 1 scope (this file): single-vault read. Cross-vault synthesis is
 * Phase 2 work (`wiki-recall-cross-scope` reducer, §1 amended v2.1).
 *
 * @module services/wiki/wiki-query.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SchemaLoaderService } from './schema-loader.service.js';
import { VaultSchema } from './wiki.types.js';

const DEFAULT_RECENT_LOG_ENTRIES = 20;
const DEFAULT_TOP_K_PAGES = 5;
const MAX_PAGE_BYTES = 8 * 1024;          // truncate per-page excerpt
const MAX_TOTAL_PAGES_SCANNED = 200;      // safety cap on filesystem walk

export interface WikiQueryInput {
  /** Absolute path to the vault root. */
  vaultPath: string;
  /** Natural-language query. Used for naive keyword ranking. */
  query: string;
  /** How many candidate pages to return (default 5). */
  topK?: number;
  /** How many tail log.md entries to include (default 20). */
  recentLogEntries?: number;
}

export interface WikiLogEntry {
  timestamp: string;
  sourceType: string;
  caller: string;
  ref: string;
  body: string;
}

export interface WikiCandidatePage {
  /** Path relative to vault root. */
  path: string;
  /** First ~MAX_PAGE_BYTES bytes of the file (UTF-8). */
  excerpt: string;
  /** Simple keyword overlap score; higher = more relevant. */
  score: number;
}

export interface WikiQuerySystemContext {
  vault: { scope: VaultSchema['vault_scope']; id: string; path: string };
  schemaSummary: {
    hardcoded: Array<{ path: string; description: string }>;
    llmCurated: Array<{ path: string; seedSubdirs: string[] }>;
    frozenPaths: string[];
    writePolicy: VaultSchema['write_policy'];
  };
  query: string;
  recentLog: WikiLogEntry[];
  candidatePages: WikiCandidatePage[];
  /** Synthesis instructions the caller's LLM should honor. */
  callerNotes: string[];
}

export interface WikiQueryFailure {
  ok: false;
  reason: 'invalid_input' | 'schema_missing' | 'vault_missing';
  message: string;
}

export type WikiQueryResult =
  | { ok: true; context: WikiQuerySystemContext }
  | WikiQueryFailure;

/**
 * Reads a vault and builds the system-context payload the caller's LLM
 * synthesizes against. Stateless. No LLM calls inside this service.
 */
export class WikiQueryService {
  private static instance: WikiQueryService | null = null;
  private readonly logger: ComponentLogger;
  private readonly schemaLoader: SchemaLoaderService;

  constructor(schemaLoader?: SchemaLoaderService) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiQuery');
    this.schemaLoader = schemaLoader ?? new SchemaLoaderService();
  }

  static getInstance(): WikiQueryService {
    if (!this.instance) {
      this.instance = new WikiQueryService();
    }
    return this.instance;
  }

  /** Test-only reset. */
  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Build a system-context payload for `query` against the vault at
   * `vaultPath`. Caller's LLM consumes this + its task-instruction prompt.
   */
  async query(input: WikiQueryInput): Promise<WikiQueryResult> {
    const validation = this.validate(input);
    if (validation) return validation;

    let schema: VaultSchema;
    try {
      schema = await this.schemaLoader.load(input.vaultPath);
    } catch (err) {
      return {
        ok: false,
        reason: 'schema_missing',
        message: (err as Error).message,
      };
    }

    const topK = input.topK ?? DEFAULT_TOP_K_PAGES;
    const recentN = input.recentLogEntries ?? DEFAULT_RECENT_LOG_ENTRIES;

    const recentLog = await this.readRecentLog(input.vaultPath, recentN);
    const candidatePages = await this.findCandidatePages(
      input.vaultPath,
      schema,
      input.query,
      topK,
    );

    const context: WikiQuerySystemContext = {
      vault: {
        scope: schema.vault_scope,
        id: schema.vault_id,
        path: input.vaultPath,
      },
      schemaSummary: {
        hardcoded: schema.hardcoded.map((h) => ({
          path: h.path,
          description: h.description,
        })),
        llmCurated: schema.llm_curated.map((l) => ({
          path: l.path,
          seedSubdirs: l.seed_subdirs,
        })),
        frozenPaths: this.schemaLoader.getFrozenPaths(schema),
        writePolicy: schema.write_policy,
      },
      query: input.query,
      recentLog,
      candidatePages,
      callerNotes: [
        'Cite pages by their relative path inside the vault.',
        'Do not propose writes into any frozenPaths — refuse or redirect to llm-curated/.',
        'Treat candidatePages.excerpt as truncated; ask wiki-query again with a refined query if you need full content.',
        'The recentLog is append-only audit; never propose rewrites to its content.',
      ],
    };

    this.logger.debug('WikiQuery built system-context', {
      vault: input.vaultPath,
      queryLen: input.query.length,
      logEntries: recentLog.length,
      candidatePages: candidatePages.length,
    });

    return { ok: true, context };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private validate(input: WikiQueryInput): WikiQueryFailure | null {
    if (!input.vaultPath || !path.isAbsolute(input.vaultPath)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: `vaultPath must be an absolute path, got "${input.vaultPath ?? ''}"`,
      };
    }
    if (typeof input.query !== 'string' || input.query.trim().length === 0) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'query must be a non-empty string',
      };
    }
    if (input.topK !== undefined && (!Number.isInteger(input.topK) || input.topK <= 0)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'topK must be a positive integer when provided',
      };
    }
    if (
      input.recentLogEntries !== undefined &&
      (!Number.isInteger(input.recentLogEntries) || input.recentLogEntries < 0)
    ) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'recentLogEntries must be a non-negative integer when provided',
      };
    }
    return null;
  }

  /**
   * Parse the last N entries from `llm-curated/log.md`. Entries follow the
   * format written by `WikiIngestService.formatLogEntry`:
   *
   *   ## [<ISO>] <sourceType> | <caller>
   *
   *   ref: <ref>
   *
   *   <body lines>
   */
  private async readRecentLog(
    vaultPath: string,
    limit: number,
  ): Promise<WikiLogEntry[]> {
    const logPath = path.join(vaultPath, 'llm-curated', 'log.md');
    let raw: string;
    try {
      raw = await fs.readFile(logPath, 'utf8');
    } catch {
      return [];
    }
    const headerRe = /^## \[([^\]]+)\]\s+(\S+)\s+\|\s+(.+)$/gm;
    const entries: WikiLogEntry[] = [];
    const matches: Array<{ idx: number; ts: string; sourceType: string; caller: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(raw))) {
      matches.push({
        idx: m.index,
        ts: m[1],
        sourceType: m[2],
        caller: m[3].trim(),
      });
    }
    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].idx;
      const end = i + 1 < matches.length ? matches[i + 1].idx : raw.length;
      const block = raw.slice(start, end);
      const refMatch = block.match(/^ref:\s*(.+)$/m);
      // Body is everything after the `ref:` line (skipping the blank line).
      let body = '';
      if (refMatch) {
        const refLineEnd = block.indexOf(refMatch[0]) + refMatch[0].length;
        body = block.slice(refLineEnd).replace(/^\n+/, '').trim();
      }
      entries.push({
        timestamp: matches[i].ts,
        sourceType: matches[i].sourceType,
        caller: matches[i].caller,
        ref: refMatch ? refMatch[1].trim() : '',
        body,
      });
    }
    // Most-recent-first; cap to requested limit.
    return entries.slice(-limit).reverse();
  }

  /**
   * Walk the vault's NON-frozen subtrees and rank pages by keyword overlap
   * with the query. Phase 1 is intentionally simple — Phase 2 will swap in
   * embedding-based scoring.
   */
  private async findCandidatePages(
    vaultPath: string,
    schema: VaultSchema,
    query: string,
    topK: number,
  ): Promise<WikiCandidatePage[]> {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    const llmCuratedRoots = schema.llm_curated.map((l) =>
      path.join(vaultPath, l.path.replace(/[/\\]+$/, '')),
    );

    const candidates: WikiCandidatePage[] = [];
    let scanned = 0;

    for (const root of llmCuratedRoots) {
      const stack: string[] = [root];
      while (stack.length > 0 && scanned < MAX_TOTAL_PAGES_SCANNED) {
        const current = stack.pop()!;
        let entries: import('fs').Dirent[];
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith('.md')) continue;
          // Skip log.md — it's surfaced separately as recentLog.
          if (
            path.relative(vaultPath, full).replace(/\\/g, '/') ===
            'llm-curated/log.md'
          ) {
            continue;
          }
          scanned++;
          const score = await this.scorePage(full, queryTerms);
          if (score > 0) {
            const excerpt = await this.readExcerpt(full);
            candidates.push({
              path: path.relative(vaultPath, full).replace(/\\/g, '/'),
              excerpt,
              score,
            });
          }
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, topK);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length >= 2);
  }

  private async scorePage(absolutePath: string, queryTerms: string[]): Promise<number> {
    let content: string;
    try {
      content = (await fs.readFile(absolutePath, 'utf8')).toLowerCase();
    } catch {
      return 0;
    }
    let score = 0;
    for (const term of queryTerms) {
      // Bounded count: don't reward spammy repetition above 10.
      let count = 0;
      let idx = 0;
      while (count < 10) {
        const found = content.indexOf(term, idx);
        if (found < 0) break;
        count++;
        idx = found + term.length;
      }
      score += count;
    }
    return score;
  }

  private async readExcerpt(absolutePath: string): Promise<string> {
    try {
      const raw = await fs.readFile(absolutePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') <= MAX_PAGE_BYTES) return raw;
      return raw.slice(0, MAX_PAGE_BYTES) + '\n\n…[truncated]';
    } catch {
      return '';
    }
  }
}
