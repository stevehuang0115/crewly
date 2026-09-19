/**
 * WikiQueryService — read a vault and build the `system-context` payload
 * that the caller's runtime feeds to its LLM for synthesis.
 *
 * Retrieval is two-step: the payload leads with the vault's one-line
 * index (`llm-curated/index.md`, trimmed to the query's neighbourhood
 * when it would not fit), then BM25 candidate pages; the caller picks
 * 3–5 paths and asks again with `pages` to get them in full. Superseded
 * pages and pages the viewer's role may not see never appear. Every call
 * is written to the vault's usage ledger (what was asked, what was read,
 * whether it was a miss).
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
import { WikiSearchService, tokenize, type WikiSearchFilters } from './wiki-search.service.js';
import { VaultSchema } from './wiki.types.js';
import { WikiIndexService } from './wiki-index.service.js';
import { WikiUsageService } from './wiki-usage.service.js';
import { parsePage, isVisibleTo, type WikiPageFrontmatter } from './wiki-page.js';
import { walkCuratedPages, isSeedFile } from './wiki-vault-walk.js';

const DEFAULT_RECENT_LOG_ENTRIES = 20;
const DEFAULT_TOP_K_PAGES = 5;
const MAX_PAGE_BYTES = 8 * 1024;          // truncate per-page excerpt
const MAX_FULL_PAGE_BYTES = 64 * 1024;    // cap for a page returned in full (step 2)
const MAX_FULL_PAGES = 8;                 // how many full pages one call may return

export interface WikiQueryInput {
  /** Absolute path to the vault root. */
  vaultPath: string;
  /** Natural-language query. Used for naive keyword ranking. */
  query: string;
  /** How many candidate pages to return (default 5). */
  topK?: number;
  /** How many tail log.md entries to include (default 20). */
  recentLogEntries?: number;
  /** Step 2: vault-relative pages to return in full (max 8). */
  pages?: string[];
  /** Who is asking (session name) — for the usage ledger. */
  agent?: string;
  /** Reader's role — pages whose `visibility` excludes it are hidden. Undefined = owner. */
  viewerRole?: string;
  /** Include superseded pages (default false). */
  includeSuperseded?: boolean;
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

/** A page returned in full (step 2). */
export interface WikiFullPage {
  path: string;
  frontmatter: Partial<WikiPageFrontmatter>;
  content: string;
  truncated: boolean;
}

export interface WikiQuerySystemContext {
  vault: { scope: VaultSchema['vault_scope']; id: string; path: string };
  /** Step 1: the one-line-per-page index (trimmed to the query when large). */
  index: { text: string; truncated: boolean; entries: number };
  /** Step 2: pages the caller asked for in full. */
  pages: WikiFullPage[];
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

  private readonly index: WikiIndexService;
  private readonly usage: WikiUsageService;

  constructor(schemaLoader?: SchemaLoaderService, index?: WikiIndexService, usage?: WikiUsageService) {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiQuery');
    this.schemaLoader = schemaLoader ?? new SchemaLoaderService();
    this.index = index ?? WikiIndexService.getInstance();
    this.usage = usage ?? WikiUsageService.getInstance();
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
    const filters: WikiSearchFilters = { viewerRole: input.viewerRole, includeSuperseded: input.includeSuperseded === true };

    const index = await this.index.readForQuery(input.vaultPath, tokenize(input.query));
    const recentLog = await this.readRecentLog(input.vaultPath, recentN);
    const candidatePages = await this.findCandidatePages(input.vaultPath, input.query, topK, filters);
    const pages = await this.readFullPages(input.vaultPath, schema, input.pages ?? [], filters);

    // Usage ledger: what was read counts as a hit; a query that surfaced
    // nothing (no full pages, no candidates) is a capture gap.
    const hits = [...new Set([...pages.map((p) => p.path), ...candidatePages.map((c) => c.path)])];
    await this.usage.record(input.vaultPath, {
      via: 'wiki-query',
      agent: input.agent ?? 'unknown',
      query: input.query,
      hits,
      miss: hits.length === 0,
    });

    const context: WikiQuerySystemContext = {
      vault: {
        scope: schema.vault_scope,
        id: schema.vault_id,
        path: input.vaultPath,
      },
      index,
      pages,
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
        'Two-step retrieval: read `index` first, pick 3–5 relevant paths, then call wiki-query again with `pages` set to read them in full. Do not answer from index lines alone.',
        'Cite pages by their relative path inside the vault.',
        'Do not propose writes into any frozenPaths — refuse or redirect to llm-curated/.',
        'candidatePages.excerpt is truncated; `pages` returns full content.',
        'Pages marked superseded are hidden; ask with includeSuperseded when you need the history of a judgement.',
        'The recentLog is append-only audit; never propose rewrites to its content.',
        'If nothing here answers the question, say so — that miss is recorded as a capture gap.',
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
   * Rank the vault's `llm-curated/` pages by Okapi BM25 against the query,
   * reusing {@link WikiSearchService.searchCorpus} so the agent-facing
   * skill scores identically to the wiki UI search. Seed files (index,
   * log) are excluded; superseded/invisible/proposed pages are dropped by
   * the search filters.
   *
   * @param vaultPath - Vault root
   * @param query - Query text
   * @param topK - How many candidates
   * @param filters - Viewer/superseded filters
   * @returns Candidates with truncated excerpts
   */
  private async findCandidatePages(
    vaultPath: string,
    query: string,
    topK: number,
    filters: WikiSearchFilters,
  ): Promise<WikiCandidatePage[]> {
    const docs = (await walkCuratedPages(vaultPath)).filter((p) => !isSeedFile(p.relativePath));
    if (docs.length === 0) return [];
    const hits = await WikiSearchService.getInstance().searchCorpus(vaultPath, docs, query, filters);
    const candidates: WikiCandidatePage[] = [];
    for (const hit of hits.slice(0, topK)) {
      const excerpt = await this.readExcerpt(path.join(vaultPath, hit.relativePath));
      candidates.push({ path: hit.relativePath, excerpt, score: hit.score });
    }
    return candidates;
  }

  /**
   * Step 2: return the requested pages in full (frontmatter + content),
   * honouring frozen paths, visibility and supersession. Unknown paths
   * are skipped silently (the caller sees which ones came back).
   *
   * @param vaultPath - Vault root
   * @param schema - Vault schema (frozen folders are readable — SOPs/norms are knowledge too)
   * @param requested - Vault-relative paths
   * @param filters - Viewer/superseded filters
   * @returns Pages in request order
   */
  private async readFullPages(
    vaultPath: string,
    schema: VaultSchema,
    requested: string[],
    filters: WikiSearchFilters,
  ): Promise<WikiFullPage[]> {
    void schema;
    const out: WikiFullPage[] = [];
    for (const raw of requested.slice(0, MAX_FULL_PAGES)) {
      const rel = String(raw).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel.endsWith('.md') || rel.includes('..')) continue;
      const abs = path.resolve(vaultPath, rel);
      if (!abs.startsWith(path.resolve(vaultPath) + path.sep)) continue;
      let content: string;
      try {
        content = await fs.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const page = parsePage(content);
      if (page.frontmatter.superseded_by && !filters.includeSuperseded) continue;
      if (!isVisibleTo(page.frontmatter, filters.viewerRole)) continue;
      const truncated = Buffer.byteLength(content, 'utf8') > MAX_FULL_PAGE_BYTES;
      out.push({
        path: rel,
        frontmatter: page.frontmatter,
        content: truncated ? content.slice(0, MAX_FULL_PAGE_BYTES) + '\n\n…[truncated]' : content,
        truncated,
      });
    }
    return out;
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
