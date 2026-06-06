/**
 * Wiki Search Service
 *
 * In-process full-text search across a wiki vault's `.md` files. Returns
 * per-file matches with line numbers + short snippets so the UI can render
 * a result list and let the user jump straight to a page.
 *
 * Ranking: Okapi **BM25** (term-frequency saturation via `k1`, length
 * normalisation via `b`, inverse-document-frequency weighting) computed
 * per request. No external index — the vaults here are O(100s) of pages so
 * a per-request scan + score is fine; revisit with a persisted index when
 * volumes justify it. Tokenisation is Unicode-aware: Latin word tokens plus
 * individual CJK characters, so Chinese/Japanese content is searchable.
 *
 * Scope: walks the vault directory AND the per-team overlay sources
 * (`sop/` → installed/custom SOPs, `team-norm/` → team norms) so SOP and
 * norm content is searchable even though it lives outside the vault.
 *
 * @module services/wiki/wiki-search.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { overlayRootFor } from './wiki-overlay.resolver.js';

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

/** BM25 term-frequency saturation parameter (standard default). */
const BM25_K1 = 1.2;
/** BM25 length-normalisation parameter (standard default). */
const BM25_B = 0.75;
/** Weight applied to filename/title tokens when folded into a doc's terms. */
const FILENAME_TOKEN_WEIGHT = 3;

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
  /** BM25 relevance score (higher = better). */
  score: number;
  /** Up to `WIKI_SEARCH_MAX_SNIPPETS_PER_FILE` matching lines. */
  snippets: WikiSearchSnippet[];
  /** Owning vault path (set for all-vault search; absent for single-vault). */
  vaultPath?: string;
  /** Human label for the owning vault (all-vault search only). */
  vaultLabel?: string;
}

export interface WikiSearchResult {
  ok: true;
  /** Searched vault path, or '' for an all-vault search. */
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

/** A vault to include in an all-vault search. */
export interface VaultRef {
  vaultPath: string;
  label?: string;
}

export interface WikiMultiSearchInput {
  vaults: VaultRef[];
  query: string;
}

/** A candidate document: where it lives (which vault) + how to read it. */
interface DocRef {
  vaultPath: string;
  relativePath: string;
  absPath: string;
}

/** A document gathered for scoring: where it lives + its term statistics. */
interface ScoredDoc {
  vaultPath: string;
  relativePath: string;
  absPath: string;
  filenameMatch: boolean;
  /** Token count (document length, including weighted filename tokens). */
  length: number;
  /** Per-query-term frequency in this doc. */
  termFreq: Map<string, number>;
}

/**
 * Tokenise text into searchable terms: lowercase Latin word runs
 * (`[a-z0-9]+`) plus individual CJK characters (Han, Hiragana, Katakana),
 * so both English and Chinese/Japanese content is matched.
 *
 * @param text - Raw text to tokenise.
 * @returns Array of lowercase tokens (order preserved, duplicates kept).
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const latin = lower.match(/[a-z0-9]+/g) ?? [];
  const cjk =
    lower.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? [];
  return [...latin, ...cjk];
}

/** Whether a query term is a Latin word (eligible for prefix matching). */
function isLatin(term: string): boolean {
  return /^[a-z0-9]+$/.test(term);
}

/**
 * Does a document token satisfy a query term? Exact match always; for Latin
 * query terms of length ≥ 3 a prefix match also counts (so `deploy` finds
 * `deployment`), preserving the leniency of the old substring search.
 */
function tokenMatches(docToken: string, queryTerm: string): boolean {
  if (docToken === queryTerm) return true;
  if (queryTerm.length >= 3 && isLatin(queryTerm) && docToken.startsWith(queryTerm)) {
    return true;
  }
  return false;
}

/**
 * Service exposing `search()`. Stateless singleton — matches the pattern of
 * the other wiki services (`WikiBookkeepService.getInstance()`, etc.).
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

  /** Validate + normalise a query, or return a structured failure. */
  private validateQuery(raw: string): { query: string } | WikiSearchFailure {
    const query = (raw ?? '').trim();
    if (query.length === 0) {
      return { ok: false, reason: 'invalid_query', message: 'query must be at least one non-whitespace character' };
    }
    if (query.length > WIKI_SEARCH_MAX_QUERY_LENGTH) {
      return { ok: false, reason: 'invalid_query', message: `query exceeds ${WIKI_SEARCH_MAX_QUERY_LENGTH} characters` };
    }
    return { query };
  }

  /**
   * Search a single vault and rank results with BM25. Returns either
   * `{ok:true, hits}` or a structured failure. Filesystem read errors are
   * silently skipped so one bad file doesn't blank the whole result.
   */
  async search(input: WikiSearchInput): Promise<WikiSearchResult | WikiSearchFailure> {
    const vaultPath = input.vaultPath;
    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      return { ok: false, reason: 'invalid_input', message: 'vaultPath must be an absolute path' };
    }
    if (!existsSync(vaultPath)) {
      return { ok: false, reason: 'vault_missing', message: `vault not found: ${vaultPath}` };
    }
    const v = this.validateQuery(input.query);
    if ('ok' in v) return v;

    const refs = (await this.collectDocs(vaultPath)).map((r) => ({ vaultPath, ...r }));
    const { hits, truncated } = await this._searchCorpus(refs, v.query);
    return { ok: true, vaultPath, query: v.query, hits, truncated };
  }

  /**
   * Search across MANY vaults and return one merged BM25-ranked list. IDF is
   * computed over the combined corpus so scores are comparable across vaults.
   * Each hit carries its owning `vaultPath` (+ `vaultLabel` when provided).
   */
  async searchAllVaults(input: WikiMultiSearchInput): Promise<WikiSearchResult | WikiSearchFailure> {
    const v = this.validateQuery(input.query);
    if ('ok' in v) return v;

    const labelByPath = new Map<string, string>();
    const refs: DocRef[] = [];
    for (const vault of input.vaults) {
      if (!vault.vaultPath || !existsSync(vault.vaultPath)) continue;
      if (vault.label) labelByPath.set(vault.vaultPath, vault.label);
      for (const r of await this.collectDocs(vault.vaultPath)) {
        refs.push({ vaultPath: vault.vaultPath, ...r });
        if (refs.length >= WIKI_SEARCH_MAX_FILES) break;
      }
      if (refs.length >= WIKI_SEARCH_MAX_FILES) break;
    }

    const { hits, truncated } = await this._searchCorpus(refs, v.query);
    for (const h of hits) {
      if (h.vaultPath) h.vaultLabel = labelByPath.get(h.vaultPath);
    }
    return { ok: true, vaultPath: '', query: v.query, hits, truncated };
  }

  /**
   * BM25-rank an explicit list of documents (rather than auto-collecting the
   * whole vault). Lets callers that need their own eligibility rules — e.g. the
   * `wiki-query` skill, which ranks only `llm-curated/` pages and skips
   * `log.md` — reuse the exact same Okapi BM25 scoring with IDF computed over
   * precisely the documents they supply.
   *
   * @param vaultPath - Owning vault (stamped on each hit's `vaultPath`).
   * @param docs - Candidate documents as `{ relativePath, absPath }`.
   * @param query - Raw query string (validated/normalised here).
   * @returns BM25-ranked hits, or an empty array for an invalid/empty query.
   */
  async searchCorpus(
    vaultPath: string,
    docs: Array<{ relativePath: string; absPath: string }>,
    query: string,
  ): Promise<WikiSearchHit[]> {
    const v = this.validateQuery(query);
    if ('ok' in v) return [];
    const refs: DocRef[] = docs.map((d) => ({ vaultPath, ...d }));
    const { hits } = await this._searchCorpus(refs, v.query);
    return hits;
  }

  /**
   * Core BM25 search over an arbitrary corpus of doc refs (one or many vaults).
   * Builds the combined corpus statistics, scores, ranks, and attaches snippets
   * for the top results. Each hit carries its owning `vaultPath`.
   */
  private async _searchCorpus(
    docRefs: DocRef[],
    query: string,
  ): Promise<{ hits: WikiSearchHit[]; truncated: boolean }> {
    const queryTerms = Array.from(new Set(tokenize(query)));
    const needleLower = query.toLowerCase();

    const truncatedFiles = docRefs.length >= WIKI_SEARCH_MAX_FILES;
    const slice = docRefs.slice(0, WIKI_SEARCH_MAX_FILES);

    // Pass 1: read + tokenise each doc, accumulate query-term frequencies + length.
    const docs: ScoredDoc[] = [];
    for (const ref of slice) {
      const doc = await this.statDoc(ref, queryTerms);
      if (doc) docs.push(doc);
    }
    if (queryTerms.length === 0) return { hits: [], truncated: truncatedFiles };

    const N = docs.length || 1;
    const avgdl = docs.reduce((s, d) => s + d.length, 0) / N || 1;

    // Document frequency per query term, then IDF (always positive).
    const idf = new Map<string, number>();
    for (const term of queryTerms) {
      let n = 0;
      for (const d of docs) if ((d.termFreq.get(term) ?? 0) > 0) n++;
      idf.set(term, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
    }

    const scored = docs
      .map((d) => ({ doc: d, score: this.bm25Score(d, queryTerms, idf, avgdl) }))
      .filter((s) => s.score > 0);

    // Rank: filename/title matches first, then BM25 score, then path for stability.
    scored.sort((a, b) => {
      if (a.doc.filenameMatch !== b.doc.filenameMatch) return a.doc.filenameMatch ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.doc.relativePath.localeCompare(b.doc.relativePath);
    });

    const truncatedResults = scored.length > WIKI_SEARCH_MAX_RESULTS;
    const top = scored.slice(0, WIKI_SEARCH_MAX_RESULTS);

    // Pass 2: build snippets only for the top results (re-read those files).
    const hits: WikiSearchHit[] = [];
    for (const { doc, score } of top) {
      const { matchCount, snippets } = await this.buildSnippets(doc.absPath, queryTerms, needleLower);
      hits.push({
        relativePath: doc.relativePath,
        filenameMatch: doc.filenameMatch,
        matchCount,
        score: Math.round(score * 1000) / 1000,
        snippets,
        vaultPath: doc.vaultPath,
      });
    }
    return { hits, truncated: truncatedFiles || truncatedResults };
  }

  /**
   * Collect candidate `.md` documents: the vault tree plus the per-team
   * overlay sources (`sop/`, `team-norm/`). Overlay paths are prefixed with
   * the folder name so they resolve back through the page endpoint.
   *
   * @param vaultPath - Absolute vault root.
   * @returns Deduped list of `{ relativePath, absPath }`, capped at the limit.
   */
  private async collectDocs(vaultPath: string): Promise<Array<{ relativePath: string; absPath: string }>> {
    const seen = new Set<string>();
    const out: Array<{ relativePath: string; absPath: string }> = [];

    const add = (relativePath: string, absPath: string): void => {
      if (seen.has(relativePath)) return;
      seen.add(relativePath);
      out.push({ relativePath, absPath });
    };

    for (const rel of await this.walkMd(vaultPath)) {
      if (out.length >= WIKI_SEARCH_MAX_FILES) return out;
      add(rel, path.join(vaultPath, rel));
    }

    for (const folder of ['sop', 'team-norm']) {
      const root = overlayRootFor(vaultPath, folder);
      if (!root || !existsSync(root)) continue;
      for (const rel of await this.walkMd(root)) {
        if (out.length >= WIKI_SEARCH_MAX_FILES) return out;
        add(`${folder}/${rel}`, path.join(root, rel));
      }
    }

    return out;
  }

  /**
   * Recursively collect `.md` files under `root`, returned as root-relative
   * POSIX paths. Skips dotfile dirs (`.git`, `.queue`) and stops at the cap.
   */
  private async walkMd(root: string): Promise<string[]> {
    const acc: string[] = [];
    const walk = async (dir: string): Promise<void> => {
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
          await walk(abs);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          acc.push(path.relative(root, abs).replace(/\\/g, '/'));
        }
      }
    };
    await walk(root);
    return acc;
  }

  /**
   * Read a doc and compute its length + per-query-term frequencies. Filename
   * tokens are folded in (weighted) so title relevance contributes to BM25.
   * Returns null only on unreadable/oversize files with no filename match.
   */
  private async statDoc(ref: DocRef, queryTerms: string[]): Promise<ScoredDoc | null> {
    const { vaultPath, relativePath, absPath } = ref;
    const filenameMatch = queryTerms.some((t) => relativePath.toLowerCase().includes(t));

    // Filename/title tokens, folded in with a weight.
    const nameTokens = tokenize(path.basename(relativePath, '.md'));
    const termFreq = new Map<string, number>();
    let length = 0;

    const tally = (tokens: string[], weight: number): void => {
      for (const tok of tokens) {
        length += weight;
        for (const term of queryTerms) {
          if (tokenMatches(tok, term)) {
            termFreq.set(term, (termFreq.get(term) ?? 0) + weight);
          }
        }
      }
    };

    tally(nameTokens, FILENAME_TOKEN_WEIGHT);

    let content = '';
    try {
      const stat = await fs.stat(absPath);
      if (stat.size <= WIKI_SEARCH_MAX_FILE_BYTES) {
        content = await fs.readFile(absPath, 'utf8');
      }
    } catch {
      // unreadable — fall through with filename tokens only
    }
    if (content) tally(tokenize(content), 1);

    // Keep filename-only matches discoverable even with no body match.
    if (length === 0) {
      return filenameMatch ? { vaultPath, relativePath, absPath, filenameMatch, length: 1, termFreq } : null;
    }
    return { vaultPath, relativePath, absPath, filenameMatch, length, termFreq };
  }

  /**
   * Standard Okapi BM25 score for a doc against the query terms.
   */
  private bm25Score(
    doc: ScoredDoc,
    queryTerms: string[],
    idf: Map<string, number>,
    avgdl: number,
  ): number {
    let score = 0;
    for (const term of queryTerms) {
      const f = doc.termFreq.get(term) ?? 0;
      if (f === 0) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgdl);
      score += (idf.get(term) ?? 0) * ((f * (BM25_K1 + 1)) / denom);
    }
    return score;
  }

  /**
   * Re-read a top-ranked file and extract matching-line snippets (a line
   * matches when it contains any query term as a substring). Returns the
   * total content match count + up to the snippet cap.
   */
  private async buildSnippets(
    absPath: string,
    queryTerms: string[],
    needleLower: string,
  ): Promise<{ matchCount: number; snippets: WikiSearchSnippet[] }> {
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      return { matchCount: 0, snippets: [] };
    }
    const lines = content.split(/\r?\n/);
    const snippets: WikiSearchSnippet[] = [];
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      const matched =
        lineLower.includes(needleLower) || queryTerms.some((t) => lineLower.includes(t));
      if (matched) {
        matchCount++;
        if (snippets.length < WIKI_SEARCH_MAX_SNIPPETS_PER_FILE) {
          snippets.push({ lineNumber: i + 1, text: lines[i].trim().slice(0, 300) });
        }
      }
    }
    return { matchCount, snippets };
  }
}
