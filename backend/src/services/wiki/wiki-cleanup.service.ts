/**
 * WikiCleanupService — detect + remove low-quality pages from a wiki vault.
 *
 * Origin: the 2026-05-27 migration dumped every agent's `memory.json`
 * roleKnowledge entries as their own wiki page (~3,277 pages across 6
 * project vaults). Many are stream-of-consciousness daily memory rather
 * than team-level patterns. Symptom: each project vault has 500+ pages
 * under `patterns/`, most low-quality (confidence < 0.5, verbatim memory
 * dump shape). Karpathy's wiki spec says "frequently-read distilled
 * knowledge" — 500 stream-of-consciousness pages violates that.
 *
 * Detection is **rule-based + mechanical** (OSS does this). The actual
 * keep/delete decision can be deferred to an agent via the bridge —
 * this service exposes both `scan(rules)` (mechanical candidate list)
 * and `apply(pages)` (executes the explicit page list provided).
 *
 * Design rules (mirror WikiMigrateService):
 *  - Default DRY-RUN. Caller must pass `{ apply: true }` to delete.
 *  - Idempotent + reversible. Every deleted page body + frontmatter is
 *    archived to `<vault>/.wiki-cleanup-archive.json` BEFORE the file
 *    is removed. Re-running with the same input is a no-op.
 *  - Migrate manifest is updated so the SAME source entry is not
 *    re-imported by the next `wiki-migrate --apply` (would defeat the
 *    cleanup).
 *  - LEGACY FILES (`memory.json`, `.crewly/knowledge/*`) are NEVER
 *    touched. The cleanup ONLY removes pages from the wiki vault.
 *  - Frozen folders (`memory/`, `sop/`, `sop-overrides/`, `okr/`,
 *    `decisions/manual/`) are never scanned.
 *
 * @module services/wiki/wiki-cleanup.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync } from 'fs';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { atomicWriteJson, safeReadJson, ensureDir } from '../../utils/file-io.utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WIKI_CLEANUP_ARCHIVE_FILENAME = '.wiki-cleanup-archive.json';
export const WIKI_CLEANUP_ARCHIVE_VERSION = 1;

/** Folders we never scan — managed by OSS code path, not LLM-editable. */
const FROZEN_FOLDERS: ReadonlySet<string> = new Set([
  'memory',
  'sop',
  'sop-overrides',
  'okr',
]);

/** Folder under the vault where llm-curated pages live. */
const LLM_CURATED_DIR = 'llm-curated';

/** Hard cap on candidates returned per scan — defensive (prevents OOM on a
 *  corrupted vault with 100k+ files). */
const SCAN_HARD_CAP = 5_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WikiCleanupRules {
  /** Drop pages whose frontmatter `confidence` is below this. Default 0.5. */
  minConfidence?: number;
  /** Drop pages whose `migrated_from` starts with `agent/`. Default true. */
  dropAgentMemoryDumps?: boolean;
  /**
   * Keep at most N pages per `original_author`. Pages outside the top-N
   * (sorted by confidence desc, then original_date desc) are flagged.
   * Default: 0 (cap disabled).
   */
  maxPerAgent?: number;
}

export interface WikiCleanupCandidate {
  /** Path relative to the vault root (e.g. `llm-curated/patterns/x.md`). */
  relPath: string;
  /** Why this page is a cleanup candidate (one or more rule names). */
  reasons: string[];
  /** Parsed `confidence` (if present in frontmatter), used for ranking. */
  confidence: number | null;
  /** Parsed `original_author` (if present), used by the per-agent cap. */
  originalAuthor: string | null;
  /** Parsed `migrated_from` (if present), used to invalidate manifest entry. */
  migratedFrom: string | null;
  /** Parsed `original_id` (if present), used to invalidate manifest entry. */
  originalId: string | null;
  /** File size in bytes. */
  bytes: number;
}

export interface WikiCleanupScanInput {
  /** Absolute vault path (the dir containing `SCHEMA.md`). */
  vaultPath: string;
  /** Rule overrides; defaults applied for any missing key. */
  rules?: WikiCleanupRules;
}

export interface WikiCleanupScanResult {
  ok: true;
  vaultPath: string;
  /** Pages flagged by at least one rule. Capped at {@link SCAN_HARD_CAP}. */
  candidates: WikiCleanupCandidate[];
  /** Total pages walked (whether candidate or not). */
  scannedCount: number;
  /** Did the scan hit {@link SCAN_HARD_CAP}? */
  truncated: boolean;
  /** Per-reason counts for quick eyeballing. */
  summary: {
    lowConfidence: number;
    agentMemoryDump: number;
    perAgentCapped: number;
  };
}

export interface WikiCleanupApplyInput {
  vaultPath: string;
  /**
   * Explicit list of relative paths to delete. The bridge / agent passes
   * this in after deciding which scan candidates to actually act on. We
   * deliberately do NOT take a rule set here — `apply` is the mechanical
   * deletion step, the decision happened upstream.
   */
  pages: string[];
}

export interface WikiCleanupApplyResult {
  ok: true;
  vaultPath: string;
  /** Pages actually deleted in this run. */
  deleted: string[];
  /** Pages requested but not deleted (missing on disk, already archived, etc). */
  skipped: Array<{ relPath: string; reason: 'not_found' | 'outside_vault' | 'frozen' }>;
  archivePath: string;
  /** Migrate manifest entries removed so cleanup-deleted pages don't get re-migrated. */
  manifestEntriesInvalidated: number;
}

export type WikiCleanupOutcome =
  | WikiCleanupScanResult
  | WikiCleanupApplyResult
  | { ok: false; reason: 'invalid_input' | 'vault_missing'; message: string };

interface ArchiveEntry {
  relPath: string;
  archivedAt: string;
  reasons: string[];
  body: string;
  frontmatter: Record<string, unknown>;
}

interface ArchiveFile {
  version: number;
  entries: ArchiveEntry[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WikiCleanupService {
  private static instance: WikiCleanupService | null = null;
  private readonly logger: ComponentLogger;

  constructor() {
    this.logger = LoggerService.getInstance().createComponentLogger('WikiCleanup');
  }

  static getInstance(): WikiCleanupService {
    if (!this.instance) this.instance = new WikiCleanupService();
    return this.instance;
  }

  /** Test-only reset. */
  static resetInstance(): void {
    this.instance = null;
  }

  /**
   * Walk the vault's `llm-curated/` tree, parse frontmatter, return all
   * pages matching at least one cleanup rule. Pure read — no writes.
   */
  async scan(input: WikiCleanupScanInput): Promise<WikiCleanupOutcome> {
    const validation = this.validateVault(input.vaultPath);
    if (!validation.ok) return validation;

    const rules: Required<WikiCleanupRules> = {
      minConfidence: input.rules?.minConfidence ?? 0.5,
      dropAgentMemoryDumps: input.rules?.dropAgentMemoryDumps ?? true,
      maxPerAgent: input.rules?.maxPerAgent ?? 0,
    };

    const llmCuratedRoot = path.join(input.vaultPath, LLM_CURATED_DIR);
    const allPages: Array<{ relPath: string; frontmatter: Record<string, unknown>; bytes: number }> = [];
    let truncated = false;
    if (existsSync(llmCuratedRoot)) {
      truncated = await this.walkPages(llmCuratedRoot, input.vaultPath, allPages, SCAN_HARD_CAP);
    }

    // First pass — collect rule hits per page (excluding the per-agent cap,
    // which needs the global view of all pages first).
    type Flag = { reasons: string[]; meta: { confidence: number | null; originalAuthor: string | null; originalDate: string | null } };
    const flagged = new Map<string, Flag>();
    const summary = { lowConfidence: 0, agentMemoryDump: 0, perAgentCapped: 0 };

    for (const page of allPages) {
      const fm = page.frontmatter;
      const reasons: string[] = [];

      const conf = parseConfidence(fm['confidence']);
      if (conf !== null && conf < rules.minConfidence) {
        reasons.push(`confidence ${conf} < ${rules.minConfidence}`);
        summary.lowConfidence++;
      }

      const migratedFrom = typeof fm['migrated_from'] === 'string' ? fm['migrated_from'] : null;
      if (rules.dropAgentMemoryDumps && migratedFrom?.startsWith('agent/') && migratedFrom.endsWith('/memory.json')) {
        reasons.push('migrated from agent memory.json');
        summary.agentMemoryDump++;
      }

      if (reasons.length > 0) {
        flagged.set(page.relPath, {
          reasons,
          meta: {
            confidence: conf,
            originalAuthor: typeof fm['original_author'] === 'string' ? fm['original_author'] : null,
            originalDate: typeof fm['original_date'] === 'string' ? fm['original_date'] : null,
          },
        });
      }
    }

    // Second pass — per-agent cap. Only considers pages NOT already flagged
    // by other rules (so a low-confidence page doesn't take a "cap slot").
    if (rules.maxPerAgent > 0) {
      const byAuthor = new Map<string, Array<{ relPath: string; confidence: number; date: string }>>();
      for (const page of allPages) {
        if (flagged.has(page.relPath)) continue;
        const fm = page.frontmatter;
        const author = typeof fm['original_author'] === 'string' ? fm['original_author'] : null;
        if (!author) continue;
        const conf = parseConfidence(fm['confidence']) ?? 0;
        const date = typeof fm['original_date'] === 'string' ? fm['original_date'] : '';
        const arr = byAuthor.get(author) ?? [];
        arr.push({ relPath: page.relPath, confidence: conf, date });
        byAuthor.set(author, arr);
      }
      for (const [author, arr] of byAuthor) {
        if (arr.length <= rules.maxPerAgent) continue;
        // Keep top-N by confidence desc, then date desc.
        arr.sort((a, b) => (b.confidence - a.confidence) || b.date.localeCompare(a.date));
        for (const overflow of arr.slice(rules.maxPerAgent)) {
          const existing = flagged.get(overflow.relPath);
          if (existing) {
            existing.reasons.push(`per-agent cap (${author}: keep ${rules.maxPerAgent})`);
          } else {
            flagged.set(overflow.relPath, {
              reasons: [`per-agent cap (${author}: keep ${rules.maxPerAgent})`],
              meta: { confidence: overflow.confidence, originalAuthor: author, originalDate: overflow.date },
            });
          }
          summary.perAgentCapped++;
        }
      }
    }

    const candidates: WikiCleanupCandidate[] = [];
    for (const page of allPages) {
      const flag = flagged.get(page.relPath);
      if (!flag) continue;
      const fm = page.frontmatter;
      candidates.push({
        relPath: page.relPath,
        reasons: flag.reasons,
        confidence: flag.meta.confidence,
        originalAuthor: flag.meta.originalAuthor,
        migratedFrom: typeof fm['migrated_from'] === 'string' ? fm['migrated_from'] : null,
        originalId: typeof fm['original_id'] === 'string' ? fm['original_id'] : null,
        bytes: page.bytes,
      });
      if (candidates.length >= SCAN_HARD_CAP) {
        truncated = true;
        break;
      }
    }

    this.logger.info('Wiki cleanup scan complete', {
      vaultPath: input.vaultPath,
      scannedCount: allPages.length,
      candidateCount: candidates.length,
      truncated,
      summary,
    });

    return {
      ok: true,
      vaultPath: input.vaultPath,
      candidates,
      scannedCount: allPages.length,
      truncated,
      summary,
    };
  }

  /**
   * Delete the listed pages from the vault, archive each one (body +
   * frontmatter) to `.wiki-cleanup-archive.json`, and invalidate the
   * corresponding entry in the migrate manifest so the same source can't
   * resurrect the page on the next `wiki-migrate --apply`.
   */
  async apply(input: WikiCleanupApplyInput): Promise<WikiCleanupOutcome> {
    const validation = this.validateVault(input.vaultPath);
    if (!validation.ok) return validation;
    if (!Array.isArray(input.pages) || input.pages.length === 0) {
      return { ok: false, reason: 'invalid_input', message: 'pages must be a non-empty array' };
    }

    const archivePath = path.join(input.vaultPath, WIKI_CLEANUP_ARCHIVE_FILENAME);
    const archive = await safeReadJson<ArchiveFile>(
      archivePath,
      { version: WIKI_CLEANUP_ARCHIVE_VERSION, entries: [] },
      this.logger,
    );
    if (archive.version !== WIKI_CLEANUP_ARCHIVE_VERSION) {
      // Migrate-style: don't trust an unknown version, just start fresh.
      archive.version = WIKI_CLEANUP_ARCHIVE_VERSION;
      archive.entries = [];
    }

    const deleted: string[] = [];
    const skipped: WikiCleanupApplyResult['skipped'] = [];

    for (const relPath of input.pages) {
      const safe = this.normalizeRelPath(relPath);
      if (!safe) {
        skipped.push({ relPath, reason: 'outside_vault' });
        continue;
      }
      // Defence: even if the caller passes a frozen-folder path, refuse.
      // The top-level segment is the folder name (`memory/secret.md` →
      // `memory`); pages directly under the vault root are never frozen.
      const segments = safe.split('/');
      if (segments.length >= 2 && FROZEN_FOLDERS.has(segments[0])) {
        skipped.push({ relPath, reason: 'frozen' });
        continue;
      }
      const abs = path.join(input.vaultPath, safe);
      if (!existsSync(abs)) {
        skipped.push({ relPath, reason: 'not_found' });
        continue;
      }

      // Read + parse before delete so we can archive shape.
      const raw = await fs.readFile(abs, 'utf8');
      const { frontmatter, body } = parseFrontmatter(raw);
      archive.entries.push({
        relPath: safe,
        archivedAt: new Date().toISOString(),
        reasons: ['apply-list'],
        body,
        frontmatter,
      });

      await fs.unlink(abs);
      deleted.push(safe);
    }

    // Persist archive — the rollback source of truth.
    //
    // **Manifest is deliberately NOT modified** (2026-05-28 fix). Earlier
    // versions removed the matching entries from `.migration-state.json`
    // on the theory "now nothing pins the page in place." That was
    // exactly backwards: the migrate manifest is what makes
    // `wiki-migrate --apply` IDEMPOTENT. With the entry present + hash
    // match, migrate sees "already migrated" → skips. With the entry
    // removed, migrate sees "new content" → re-imports → the
    // just-deleted page reappears on the next bridge tick. Symptom seen
    // 2026-05-28 ~05:30: 20 pages deleted, then 20 re-imported by the
    // next migrate tick, candidate count never dropped. The page on
    // disk is gone; that is sufficient. Manifest stays intact.
    await ensureDir(input.vaultPath);
    await atomicWriteJson(archivePath, archive);

    this.logger.info('Wiki cleanup apply complete', {
      vaultPath: input.vaultPath,
      requested: input.pages.length,
      deleted: deleted.length,
      skipped: skipped.length,
      archivePath,
    });

    return {
      ok: true,
      vaultPath: input.vaultPath,
      deleted,
      skipped,
      archivePath,
      manifestEntriesInvalidated: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private validateVault(vaultPath: string): { ok: true } | { ok: false; reason: 'invalid_input' | 'vault_missing'; message: string } {
    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      return { ok: false, reason: 'invalid_input', message: 'vaultPath must be an absolute path' };
    }
    if (!existsSync(vaultPath)) {
      return { ok: false, reason: 'vault_missing', message: `vault not found: ${vaultPath}` };
    }
    return { ok: true };
  }

  /**
   * Best-effort safe-rel normalisation. Returns null if the path would
   * resolve outside the vault (`..` traversal etc).
   */
  private normalizeRelPath(rel: string): string | null {
    const normalised = path.posix.normalize(rel.replace(/\\/g, '/'));
    if (normalised.startsWith('..') || path.isAbsolute(normalised)) return null;
    return normalised;
  }

  /**
   * Walk the vault tree, parsing frontmatter on each `.md` file. Skips
   * frozen folders + non-md files. Returns true if the scan was truncated
   * by the hard cap.
   */
  private async walkPages(
    dir: string,
    vaultPath: string,
    accumulator: Array<{ relPath: string; frontmatter: Record<string, unknown>; bytes: number }>,
    cap: number,
  ): Promise<boolean> {
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (accumulator.length >= cap) return true;
      // Skip frozen folders only at the vault-root level (`llm-curated/`
      // sits next to them, so we never recurse INTO sibling frozen dirs
      // — but defence-in-depth this check covers anyone who calls
      // `walkPages` with the vault root directly).
      if (entry.isDirectory()) {
        const relParent = path.relative(vaultPath, path.join(dir, entry.name));
        const topLevel = relParent.split(path.sep)[0];
        if (FROZEN_FOLDERS.has(topLevel)) continue;
        const truncated = await this.walkPages(path.join(dir, entry.name), vaultPath, accumulator, cap);
        if (truncated) return true;
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const abs = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(abs);
        const raw = await fs.readFile(abs, 'utf8');
        const { frontmatter } = parseFrontmatter(raw);
        accumulator.push({
          relPath: path.relative(vaultPath, abs).split(path.sep).join('/'),
          frontmatter,
          bytes: stat.size,
        });
      } catch (err) {
        this.logger.debug('walkPages: skipping unreadable file', {
          path: abs,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return false;
  }

}

// ---------------------------------------------------------------------------
// Helpers (module-private, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse `confidence` from frontmatter into a number, or null if absent /
 * unparseable. Accepts both numeric (`0.3`) and string (`"0.3"`) shapes
 * because YAML quoting is inconsistent across older migrated pages.
 */
export function parseConfidence(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Minimal YAML frontmatter parser. Handles the shapes our migrate service
 * emits — `key: value` lines, with optional quotes around values. NOT a
 * general YAML parser. Returns `{}` when no frontmatter is present.
 */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const fm: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const lineMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!lineMatch) continue;
    let value: string | number | boolean = lineMatch[2].trim();
    // Strip wrapping quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Coerce a few common scalar shapes.
    if (value === 'true') fm[lineMatch[1]] = true;
    else if (value === 'false') fm[lineMatch[1]] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) fm[lineMatch[1]] = parseFloat(value);
    else fm[lineMatch[1]] = value;
  }
  return { frontmatter: fm, body: match[2] };
}
