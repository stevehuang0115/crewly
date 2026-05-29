/**
 * WikiLintService — deterministic validation pass over a vault.
 *
 * Per v2.1 spec §3, the third Phase 1 skill (alongside `wiki-ingest` and
 * `wiki-query`). Unlike `wiki-bookkeep` (vault HEALTH metrics — counts,
 * recent activity, duplicate clusters), lint focuses on CORRECTNESS:
 *
 *   - **frozenPathRespected** — no markdown content in folders flagged
 *     `frozen: true` in SCHEMA.md (other than the SCHEMA.md itself /
 *     legitimate frozen content). Lint refuses to alter frozen paths.
 *   - **missingEntities** — `[[wikilinks]]` that don't resolve to any
 *     page in the vault. Either the target was renamed, deleted, or the
 *     wikilink was made up. The lint flags them; the agent decides.
 *   - **orphanPages** — pages with zero incoming wikilinks, excluding
 *     seed pages (log.md, index.md, README*). These are candidates for
 *     either deletion or new linking.
 *   - **staleClaims** — files un-touched for `staleDays` (default 90).
 *   - **restructureProposals** — heuristics for llm-curated/ only: large
 *     un-indexed folders, near-duplicate filenames.
 *
 * The service never writes. The agent's LLM reads the report and decides
 * whether to ingest a consolidation, archive stale pages, etc.
 *
 * @module services/wiki/wiki-lint.service
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import { SchemaLoaderService } from './schema-loader.service.js';
import type { VaultSchema } from './wiki.types.js';

/** Default age threshold (days) for marking a page stale. */
export const WIKI_LINT_DEFAULT_STALE_DAYS = 90;
/** Folder size threshold above which lint proposes an `index.md` rollup. */
export const WIKI_LINT_ROLLUP_THRESHOLD = 20;
/** Max number of pages walked per lint pass. */
export const WIKI_LINT_MAX_PAGES = 1000;
/** Cap per category to keep the payload bounded. */
export const WIKI_LINT_MAX_ROWS_PER_SECTION = 50;
/** Pages with these basenames never count as "orphans". */
export const WIKI_LINT_SEED_BASENAMES = new Set([
  'log.md',
  'index.md',
  'readme.md',
  'schema.md',
]);

/**
 * A `[[wikilink]]` target is "concept-shaped" (vs a dangling typo) when
 * it appears at least this many times across the vault. Below this, the
 * unresolved target is just noise; at or above this, the concept is
 * load-bearing and deserves its own page.
 */
export const WIKI_LINT_MISSING_CONCEPT_THRESHOLD = 3;

/** `[[target]]` or `[[target|alias]]`. */
const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]/g;

export interface WikiLintInput {
  vaultPath: string;
  staleDays?: number;
}

export interface WikiLintFrozenViolation {
  /** Relative path of the offending file. */
  path: string;
  /** The frozen folder it lives in. */
  frozenFolder: string;
}

export interface WikiLintMissingEntity {
  /** Page that contains the dangling wikilink. */
  sourcePath: string;
  /** The unresolved wikilink target. */
  target: string;
  /** Line number in the source page (1-based). */
  lineNumber: number;
}

export interface WikiLintRestructureProposal {
  /** Plain-English description of the proposal, e.g. "folder X has 31 pages without an index.md — propose llm-curated/X/index.md". */
  description: string;
  /** Optional related path (folder or page). */
  path?: string;
}

/**
 * A wikilink target that appears repeatedly across the vault but has no
 * dedicated page. Karpathy's lint contract names this explicitly:
 * *"important concepts mentioned but lacking their own page."* Different
 * from `missingEntities` (which is one-off dangling refs / typos):
 * `missingConcepts` is **frequency-weighted** signal that the team keeps
 * mentioning a thing → write a page for it.
 */
export interface WikiLintMissingConcept {
  /** The wikilink target referenced (e.g. `verify-output`). */
  target: string;
  /** How many distinct wikilink occurrences resolved to nothing. */
  referenceCount: number;
  /** Sample sources (capped) that reference this concept. */
  sources: string[];
}

export interface WikiLintReport {
  vault: { scope: string; id: string; path: string };
  generatedAt: string;
  staleDays: number;
  frozenPathRespected: boolean;
  frozenViolations: WikiLintFrozenViolation[];
  missingEntities: WikiLintMissingEntity[];
  /** New 2026-05-26: frequency-weighted "missing concept" signals. */
  missingConcepts: WikiLintMissingConcept[];
  orphanPages: string[];
  staleClaims: string[];
  restructureProposals: WikiLintRestructureProposal[];
  truncated: boolean;
}

export type WikiLintOutcome =
  | { ok: true; report: WikiLintReport }
  | {
      ok: false;
      reason: 'vault_missing' | 'schema_missing' | 'invalid_input';
      message: string;
    };

/**
 * Singleton lint service. Stateless — pattern mirrors the other wiki
 * services so the controller wiring is uniform.
 */
export class WikiLintService {
  private static instance: WikiLintService | null = null;
  private readonly logger: ComponentLogger;
  private readonly schemaLoader: SchemaLoaderService;

  private constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiLintService');
    this.schemaLoader = new SchemaLoaderService();
  }

  static getInstance(): WikiLintService {
    if (!this.instance) this.instance = new WikiLintService();
    return this.instance;
  }

  static resetInstance(): void {
    this.instance = null;
  }

  /**
   * Generate a lint report for the given vault.
   */
  async generate(input: WikiLintInput): Promise<WikiLintOutcome> {
    const { vaultPath } = input;
    const staleDays = input.staleDays ?? WIKI_LINT_DEFAULT_STALE_DAYS;

    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'vaultPath must be an absolute path',
      };
    }
    if (staleDays <= 0) {
      return {
        ok: false,
        reason: 'invalid_input',
        message: 'staleDays must be positive',
      };
    }
    if (!existsSync(vaultPath)) {
      return { ok: false, reason: 'vault_missing', message: `vault not found: ${vaultPath}` };
    }
    if (!existsSync(path.join(vaultPath, 'SCHEMA.md'))) {
      return {
        ok: false,
        reason: 'schema_missing',
        message: `SCHEMA.md not found inside ${vaultPath}`,
      };
    }

    let schema: VaultSchema;
    try {
      schema = await this.schemaLoader.load(vaultPath);
    } catch (err) {
      this.logger.warn('WikiLintService: schema load failed', {
        vault: vaultPath,
        error: (err as Error).message,
      });
      return {
        ok: false,
        reason: 'schema_missing',
        message: `SCHEMA.md unparseable: ${(err as Error).message}`,
      };
    }

    const frozenFolders = this.schemaLoader
      .getFrozenPaths(schema)
      .map((p) => p.replace(/[/\\]+$/, ''));

    const allFiles: PageMeta[] = [];
    await this.collectFiles(vaultPath, vaultPath, allFiles);
    const truncated = allFiles.length >= WIKI_LINT_MAX_PAGES;
    const files = allFiles.slice(0, WIKI_LINT_MAX_PAGES);

    const frozenViolations = this.detectFrozenViolations(files, frozenFolders);
    const { missingEntities, incomingMap, unresolvedFrequency } =
      await this.scanWikilinks(vaultPath, files);
    const orphanPages = this.detectOrphans(files, incomingMap);
    const staleClaims = this.detectStale(files, staleDays);
    const restructureProposals = this.proposeRestructures(files);
    const missingConcepts = this.detectMissingConcepts(unresolvedFrequency);

    const report: WikiLintReport = {
      vault: {
        scope: schema.vault_scope,
        id: schema.vault_id,
        path: vaultPath,
      },
      generatedAt: new Date().toISOString(),
      staleDays,
      frozenPathRespected: frozenViolations.length === 0,
      frozenViolations: frozenViolations.slice(0, WIKI_LINT_MAX_ROWS_PER_SECTION),
      missingEntities: missingEntities.slice(0, WIKI_LINT_MAX_ROWS_PER_SECTION),
      missingConcepts: missingConcepts.slice(0, WIKI_LINT_MAX_ROWS_PER_SECTION),
      orphanPages: orphanPages.slice(0, WIKI_LINT_MAX_ROWS_PER_SECTION),
      staleClaims: staleClaims.slice(0, WIKI_LINT_MAX_ROWS_PER_SECTION),
      restructureProposals: restructureProposals.slice(0, WIKI_LINT_MAX_ROWS_PER_SECTION),
      truncated,
    };
    return { ok: true, report };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Recursive walk collecting `.md` files. Honors `WIKI_LINT_MAX_PAGES`.
   */
  private async collectFiles(rootDir: string, dir: string, acc: PageMeta[]): Promise<void> {
    if (acc.length >= WIKI_LINT_MAX_PAGES) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (acc.length >= WIKI_LINT_MAX_PAGES) return;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectFiles(rootDir, abs, acc);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const rel = path.relative(rootDir, abs).replace(/\\/g, '/');
        try {
          const stat = await fs.stat(abs);
          // Peek at the first few hundred bytes only to extract a possible
          // `original_date:` field from a YAML frontmatter block. We avoid
          // reading the whole file in this pass — scanWikilinks() does the
          // full read separately.
          const originalDateMs = await peekOriginalDate(abs);
          acc.push({
            relativePath: rel,
            basename: entry.name,
            modifiedMs: stat.mtimeMs,
            originalDateMs,
          });
        } catch {
          // unreadable file — skip
        }
      }
    }
  }

  /**
   * Find `.md` files that live inside any frozen folder. SCHEMA.md and
   * legitimate sibling files inside frozen dirs (e.g. `sop/<role>.md`)
   * are excluded — frozen folders ARE allowed to contain content; what's
   * NOT allowed is `wiki-ingest` writing INTO them. That's a runtime
   * check elsewhere. Lint surfaces files only when they look like they
   * were created by ingest patterns (timestamp-prefixed slugs).
   */
  private detectFrozenViolations(
    files: PageMeta[],
    frozenFolders: string[],
  ): WikiLintFrozenViolation[] {
    const out: WikiLintFrozenViolation[] = [];
    if (frozenFolders.length === 0) return out;
    const ingestNamePattern = /^\d{4}-\d{2}-\d{2}-/;
    for (const f of files) {
      // Match if the file lives strictly inside a frozen folder.
      for (const folder of frozenFolders) {
        if (!folder) continue;
        if (
          f.relativePath === `${folder}/${f.basename}` ||
          f.relativePath.startsWith(`${folder}/`)
        ) {
          // Only flag ingest-shaped names (date-prefixed) — preexisting
          // frozen content is fine.
          if (ingestNamePattern.test(f.basename) || f.basename === 'log.md') {
            out.push({ path: f.relativePath, frozenFolder: folder });
          }
          break;
        }
      }
    }
    return out;
  }

  /**
   * One read pass per file: pulls `[[wikilink]]` references, builds the
   * inverse "incoming" map for orphan detection, and emits missing-entity
   * rows for any link that resolves to nothing.
   */
  private async scanWikilinks(
    vaultPath: string,
    files: PageMeta[],
  ): Promise<{
    missingEntities: WikiLintMissingEntity[];
    incomingMap: Map<string, string[]>;
    /**
     * `target (lower-cased) → { count, sources }` for every wikilink that
     * resolved to nothing. Feeds `detectMissingConcepts` so a repeatedly-
     * mentioned-but-page-less concept gets surfaced as load-bearing.
     */
    unresolvedFrequency: Map<string, { count: number; sources: Set<string> }>;
  }> {
    const incomingMap = new Map<string, string[]>();
    const missingEntities: WikiLintMissingEntity[] = [];
    const unresolvedFrequency = new Map<
      string,
      { count: number; sources: Set<string> }
    >();

    // Normalize the page set for fast resolution.
    const allPaths = files.map((f) => f.relativePath.toLowerCase());

    for (const file of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(vaultPath, file.relativePath), 'utf8');
      } catch {
        continue;
      }
      if (!content.includes('[[')) continue;

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.includes('[[')) continue;
        WIKILINK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WIKILINK_RE.exec(line)) !== null) {
          const rawTarget = m[1]?.trim();
          if (!rawTarget) continue;
          const resolved = resolveAgainstFiles(rawTarget, allPaths, files);
          if (!resolved) {
            missingEntities.push({
              sourcePath: file.relativePath,
              target: rawTarget,
              lineNumber: i + 1,
            });
            // Accumulate frequency for missing-concepts detection.
            const key = rawTarget.toLowerCase();
            const slot = unresolvedFrequency.get(key) ?? {
              count: 0,
              sources: new Set<string>(),
            };
            slot.count++;
            slot.sources.add(file.relativePath);
            unresolvedFrequency.set(key, slot);
          } else {
            const arr = incomingMap.get(resolved) ?? [];
            if (!arr.includes(file.relativePath)) arr.push(file.relativePath);
            incomingMap.set(resolved, arr);
          }
        }
      }
    }
    return { missingEntities, incomingMap, unresolvedFrequency };
  }

  /**
   * A page is an orphan when no other page wikilinks to it AND it is
   * not a seed page (log.md / index.md / README.md / SCHEMA.md).
   */
  private detectOrphans(files: PageMeta[], incomingMap: Map<string, string[]>): string[] {
    const out: string[] = [];
    for (const f of files) {
      if (WIKI_LINT_SEED_BASENAMES.has(f.basename.toLowerCase())) continue;
      const incoming = incomingMap.get(f.relativePath) ?? [];
      if (incoming.length === 0) out.push(f.relativePath);
    }
    return out;
  }

  /**
   * Find load-bearing concepts referenced repeatedly across the vault
   * but lacking a dedicated page. Karpathy's lint contract names this:
   * *"important concepts mentioned but lacking their own page."*
   *
   * Frequency-filtered (`WIKI_LINT_MISSING_CONCEPT_THRESHOLD`, default 3)
   * so we ignore typos and inline-code-style `[[X]]` brackets that aren't
   * meant as wikilinks. Distinct from `missingEntities`, which flags every
   * dangling ref individually.
   *
   * Results sort by referenceCount desc — highest-leverage concepts first.
   */
  private detectMissingConcepts(
    unresolvedFrequency: Map<string, { count: number; sources: Set<string> }>,
  ): WikiLintMissingConcept[] {
    const out: WikiLintMissingConcept[] = [];
    for (const [target, { count, sources }] of unresolvedFrequency) {
      if (count < WIKI_LINT_MISSING_CONCEPT_THRESHOLD) continue;
      out.push({
        target,
        referenceCount: count,
        // Cap sources at 10 to keep payload bounded; full list lives in
        // `missingEntities` (which lists every individual occurrence).
        sources: [...sources].slice(0, 10),
      });
    }
    out.sort((a, b) => b.referenceCount - a.referenceCount);
    return out;
  }

  /**
   * Files whose content is older than `staleDays`.
   *
   * Migrated pages may have an `original_date` frontmatter field
   * (e.g. the legacy decision was made 2026-02-01 but we wrote the
   * markdown TODAY). Stale detection should respect the original date
   * when present — otherwise every freshly-migrated old page would look
   * "new" by mtime alone. Falls back to mtime when frontmatter is absent.
   */
  private detectStale(files: PageMeta[], staleDays: number): string[] {
    const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
    return files
      .filter((f) => {
        const ageMarker = f.originalDateMs ?? f.modifiedMs;
        return ageMarker < cutoff;
      })
      .map((f) => f.relativePath);
  }

  /**
   * Heuristic restructure proposals — only for `llm-curated/` since
   * frozen folders cannot be restructured.
   *
   * (1) A subfolder with > WIKI_LINT_ROLLUP_THRESHOLD pages and NO `index.md`
   *     gets an "add an index.md rollup" proposal.
   * (2) Near-duplicate filename prefixes (e.g. `pricing-v1.md`, `pricing-v2.md`)
   *     get a "consider merging" proposal.
   */
  private proposeRestructures(files: PageMeta[]): WikiLintRestructureProposal[] {
    const proposals: WikiLintRestructureProposal[] = [];

    // (1) Index proposals.
    const folderToFiles = new Map<string, PageMeta[]>();
    for (const f of files) {
      if (!f.relativePath.startsWith('llm-curated/')) continue;
      const parts = f.relativePath.split('/');
      if (parts.length < 3) continue; // top-level llm-curated/page.md — skip
      const folder = parts.slice(0, -1).join('/');
      const arr = folderToFiles.get(folder) ?? [];
      arr.push(f);
      folderToFiles.set(folder, arr);
    }
    for (const [folder, fs2] of folderToFiles) {
      if (fs2.length < WIKI_LINT_ROLLUP_THRESHOLD) continue;
      const hasIndex = fs2.some((f) => f.basename.toLowerCase() === 'index.md');
      if (hasIndex) continue;
      proposals.push({
        description: `${folder}/ has ${fs2.length} pages and no index.md — propose adding ${folder}/index.md to summarize + link.`,
        path: folder,
      });
    }

    // (2) Near-duplicate filename prefixes (8+ chars shared, llm-curated only).
    //
    // IMPORTANT: strip the `YYYY-MM-DD-` date prefix before clustering.
    // Migrated pages all start with their `original_date` (e.g.
    // `2026-05-04-...`), so clustering on raw filename would dump every
    // file from that month into one bogus "near-duplicate" cluster.
    // What we actually want is to cluster on the CONTENT slug after the
    // date — that's where real near-duplicates live (`pricing-v1`,
    // `pricing-v2`, etc.).
    const grouped = new Map<string, PageMeta[]>();
    const prefixLen = 8;
    for (const f of files) {
      if (!f.relativePath.startsWith('llm-curated/')) continue;
      const baseNoMd = f.basename.replace(/\.md$/i, '').toLowerCase();
      // Some migrated memory entries have NESTED date prefixes (the
      // original content body started with its own date, which got
      // slugified, then the migrator prepended the entry's createdAt
      // date in front). Strip date prefixes REPEATEDLY until none remain.
      let contentSlug = baseNoMd;
      while (DATE_PREFIX_RE.test(contentSlug)) {
        contentSlug = contentSlug.replace(DATE_PREFIX_RE, '');
      }
      if (contentSlug.length < prefixLen) continue;
      const key = path.dirname(f.relativePath) + '/' + contentSlug.slice(0, prefixLen);
      const arr = grouped.get(key) ?? [];
      arr.push(f);
      grouped.set(key, arr);
    }
    for (const [key, group] of grouped) {
      if (group.length < 2) continue;
      proposals.push({
        description: `${group.length} pages share the prefix "${path.basename(key)}" — consider merging into one canonical page.`,
        path: group.map((g) => g.relativePath).join(' | '),
      });
    }
    return proposals;
  }
}

/**
 * Read the first ~1KB of a markdown file and look for an
 * `original_date: "<iso>"` field inside a YAML frontmatter block at the
 * very top. Returns the parsed timestamp in ms, or undefined when the
 * file lacks a parseable frontmatter date.
 *
 * Tolerant of unquoted, single-quoted, and double-quoted values.
 */
async function peekOriginalDate(absPath: string): Promise<number | undefined> {
  let head: string;
  try {
    // Open the file directly so we can read at most ~1KB without slurping the whole thing.
    const fh = await fs.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(1024);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      head = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
  if (!head.startsWith('---')) return undefined;
  // Frontmatter ends at the next `---` line.
  const end = head.indexOf('\n---', 3);
  const block = end === -1 ? head.slice(3) : head.slice(3, end);
  const m = block.match(/^\s*original_date:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (!m) return undefined;
  const ts = Date.parse(m[1].trim());
  return Number.isFinite(ts) ? ts : undefined;
}

interface PageMeta {
  relativePath: string;
  basename: string;
  /** Filesystem mtime in ms — falls back to this for staleness when frontmatter has no date. */
  modifiedMs: number;
  /**
   * Parsed `original_date` from YAML frontmatter (ms since epoch), when
   * the page has a frontmatter block carrying that field. Migrated pages
   * set this to the legacy entry's createdAt/decidedAt; freshly-ingested
   * pages typically don't have it. Used by stale detection.
   */
  originalDateMs?: number;
}

/**
 * Matches a leading date prefix at the start of a basename (no `.md`).
 *
 * Handles both plain-date `YYYY-MM-DD-` AND ISO-timestamp-as-slug
 * `YYYY-MM-DDtHH-MMz` / `YYYY-MM-DDtHHz-` forms (legacy agent memory
 * often embedded full ISO timestamps as content prefixes; the slugifier
 * replaced the `:` colons with `-` hyphens).
 */
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}(?:t\d{2}(?:-\d{2})?z?)?-?/;

/**
 * Mirror of the frontend's wikilink resolver — used during lint to find
 * the canonical page a `[[target]]` resolves to. Returns the relativePath
 * of the matching page (case preserved), or null when nothing matches.
 */
function resolveAgainstFiles(
  target: string,
  allPathsLower: string[],
  files: PageMeta[],
): string | null {
  const t = target.trim().toLowerCase();
  if (!t) return null;
  const tWithMd = t.endsWith('.md') ? t : `${t}.md`;
  const tNoMd = t.endsWith('.md') ? t.slice(0, -3) : t;

  let suffixIdx = -1;
  let basenameIdx = -1;

  for (let i = 0; i < allPathsLower.length; i++) {
    const p = allPathsLower[i];
    if (p === tWithMd || p === t) return files[i].relativePath;
    if (suffixIdx === -1 && (p.endsWith(`/${tWithMd}`) || p.endsWith(`/${t}`))) {
      suffixIdx = i;
    }
    if (basenameIdx === -1) {
      const base = p.split('/').pop() ?? '';
      const baseNoMd = base.endsWith('.md') ? base.slice(0, -3) : base;
      if (baseNoMd === tNoMd) basenameIdx = i;
    }
  }
  if (suffixIdx !== -1) return files[suffixIdx].relativePath;
  if (basenameIdx !== -1) return files[basenameIdx].relativePath;
  return null;
}
