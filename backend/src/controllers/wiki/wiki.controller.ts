/**
 * Wiki REST Controller
 *
 * Exposes the LLM-wiki ingest/query operations over HTTP so the bash
 * skills (`wiki-ingest`, `wiki-query`) and in-process subscribers
 * (`WikiChatSubscriberService`) all funnel through the same code path.
 *
 * @module controllers/wiki/wiki.controller
 */

import type { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../../services/core/logger.service.js';
import {
  WikiIngestService,
  WikiSourceType,
} from '../../services/wiki/wiki-ingest.service.js';
import { WikiQueryService } from '../../services/wiki/wiki-query.service.js';
import {
  WikiQueueService,
  WikiQueueStatus,
} from '../../services/wiki/wiki-queue.service.js';
import { WikiProcessService } from '../../services/wiki/wiki-process.service.js';
import { WikiBookkeepService } from '../../services/wiki/wiki-bookkeep.service.js';
import { WikiBookkeepTriggerService } from '../../services/wiki/wiki-bookkeep-trigger.service.js';
import { discoverWikiVaults } from '../../services/wiki/wiki-bookkeep-trigger.service.js';
import { WikiReflectTriggerService } from '../../services/wiki/wiki-reflect-trigger.service.js';
import { SchemaLoaderService } from '../../services/wiki/schema-loader.service.js';
import { WikiSearchService } from '../../services/wiki/wiki-search.service.js';
import { WikiBacklinksService } from '../../services/wiki/wiki-backlinks.service.js';
import { WikiLintService } from '../../services/wiki/wiki-lint.service.js';
import { WikiRecentService } from '../../services/wiki/wiki-recent.service.js';
import { WikiMigrateService } from '../../services/wiki/wiki-migrate.service.js';
import { WikiCleanupService } from '../../services/wiki/wiki-cleanup.service.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';

const logger = LoggerService.getInstance().createComponentLogger('WikiController');

const VALID_SOURCE_TYPES: ReadonlySet<WikiSourceType> = new Set<WikiSourceType>([
  'user_chat',
  'slack_message',
  'spec_file',
  'pr_merge',
  'record_learning',
  'task_verified',
]);

/**
 * POST /api/wiki/ingest
 *
 * Write a single source into a vault's `llm-curated/log.md` (or other
 * non-frozen target). The handler enforces request validation; per-call
 * routing / frozen-path / size limits live in `WikiIngestService`.
 *
 * Request body:
 *   {
 *     vaultPath: string,
 *     sourceType: WikiSourceType,
 *     sourceRef: string,
 *     sourceBody: string,
 *     callerSession?: string,
 *     targetRelativePath?: string
 *   }
 *
 * Response:
 *   200 { success: true,  result: WikiIngestOutcome (ok=true variant) }
 *   400 { success: false, error: string, outcome?: WikiIngestOutcome }
 *   422 { success: false, error: 'frozen_path', outcome: WikiIngestOutcome }
 */
export async function ingest(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const {
      vaultPath,
      sourceType,
      sourceRef,
      sourceBody,
      callerSession,
      targetRelativePath,
    } = req.body ?? {};

    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      res.status(400).json({ success: false, error: 'vaultPath (string) is required' });
      return;
    }
    if (typeof sourceType !== 'string' || !VALID_SOURCE_TYPES.has(sourceType as WikiSourceType)) {
      res.status(400).json({
        success: false,
        error: `sourceType must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}`,
      });
      return;
    }
    if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
      res.status(400).json({ success: false, error: 'sourceRef (string) is required' });
      return;
    }
    if (typeof sourceBody !== 'string') {
      res.status(400).json({ success: false, error: 'sourceBody (string) is required' });
      return;
    }
    if (callerSession !== undefined && typeof callerSession !== 'string') {
      res.status(400).json({ success: false, error: 'callerSession must be a string when provided' });
      return;
    }
    if (targetRelativePath !== undefined && typeof targetRelativePath !== 'string') {
      res.status(400).json({ success: false, error: 'targetRelativePath must be a string when provided' });
      return;
    }

    const outcome = await WikiIngestService.getInstance().ingest({
      vaultPath,
      sourceType: sourceType as WikiSourceType,
      sourceRef,
      sourceBody,
      callerSession,
      targetRelativePath,
    });

    if (outcome.ok) {
      res.status(200).json({ success: true, result: outcome });
      return;
    }

    // Refusal — surface a stable status code per reason so callers can branch.
    if (outcome.reason === 'frozen_path') {
      res.status(422).json({ success: false, error: 'frozen_path', outcome });
      return;
    }
    if (outcome.reason === 'schema_missing') {
      res.status(404).json({ success: false, error: 'schema_missing', outcome });
      return;
    }
    res.status(400).json({ success: false, error: outcome.reason, outcome });
  } catch (err) {
    logger.error('wiki/ingest threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/query
 *
 * Build the system-context payload for a single-vault read. The skill /
 * caller's runtime concatenates this with its per-LLM task-instruction
 * prompt (`config/skills/<role>/wiki-query/prompts/<runtime>.md`) before
 * the actual LLM call.
 *
 * Request body:
 *   {
 *     vaultPath: string,
 *     query: string,
 *     topK?: number,
 *     recentLogEntries?: number
 *   }
 *
 * Response:
 *   200 { success: true,  result: { context: WikiQuerySystemContext } }
 *   400 { success: false, error: string, outcome?: failure }
 *   404 { success: false, error: 'schema_missing', outcome }
 */
export async function queryVault(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { vaultPath, query, topK, recentLogEntries } = req.body ?? {};

    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      res.status(400).json({ success: false, error: 'vaultPath (string) is required' });
      return;
    }
    if (typeof query !== 'string' || query.length === 0) {
      res.status(400).json({ success: false, error: 'query (string) is required' });
      return;
    }
    if (topK !== undefined && (!Number.isInteger(topK) || topK <= 0)) {
      res.status(400).json({ success: false, error: 'topK must be a positive integer' });
      return;
    }
    if (
      recentLogEntries !== undefined &&
      (!Number.isInteger(recentLogEntries) || recentLogEntries < 0)
    ) {
      res.status(400).json({
        success: false,
        error: 'recentLogEntries must be a non-negative integer',
      });
      return;
    }

    const outcome = await WikiQueryService.getInstance().query({
      vaultPath,
      query,
      topK,
      recentLogEntries,
    });

    if (outcome.ok) {
      res.status(200).json({ success: true, result: { context: outcome.context } });
      return;
    }

    if (outcome.reason === 'schema_missing') {
      res.status(404).json({ success: false, error: 'schema_missing', outcome });
      return;
    }
    res.status(400).json({ success: false, error: outcome.reason, outcome });
  } catch (err) {
    logger.error('wiki/query threw', { error: (err as Error).message });
    next(err);
  }
}

// =============================================================================
// Wiki Queue (Steve 2026-05-22 redesign — agents enqueue, agents process)
// =============================================================================

const VALID_QUEUE_STATUSES: ReadonlySet<WikiQueueStatus> = new Set<WikiQueueStatus>([
  'pending',
  'claimed',
  'processed',
  'skipped',
]);

// Note: VALID_SOURCE_TYPES is already declared above for the /ingest route.
// The queue-add handler below reuses that same set.

/**
 * POST /api/wiki/queue
 *
 * Enqueue a candidate item. Agents call this when a turn produces
 * content worth saving to the wiki. The `reason` is REQUIRED — the
 * agent has to justify why this is wiki-worthy (audit trail + helps
 * the processor decide where it goes).
 */
export async function queueAdd(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { vaultPath, queuedBy, sourceType, sourceRef, content, reason } =
      req.body ?? {};
    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      res.status(400).json({ success: false, error: 'vaultPath (string) is required' });
      return;
    }
    if (typeof queuedBy !== 'string' || queuedBy.length === 0) {
      res.status(400).json({ success: false, error: 'queuedBy (string) is required' });
      return;
    }
    if (
      typeof sourceType !== 'string' ||
      !VALID_SOURCE_TYPES.has(sourceType as WikiSourceType)
    ) {
      res.status(400).json({
        success: false,
        error: `sourceType must be one of: ${[...VALID_SOURCE_TYPES].join(', ')}`,
      });
      return;
    }
    if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
      res.status(400).json({ success: false, error: 'sourceRef (string) is required' });
      return;
    }
    if (typeof content !== 'string' || content.length === 0) {
      res.status(400).json({ success: false, error: 'content (string) is required' });
      return;
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      res.status(400).json({
        success: false,
        error: 'reason (string) is required — agents must justify why this is wiki-worthy',
      });
      return;
    }
    const item = await WikiQueueService.getInstance().add({
      vaultPath,
      queuedBy,
      sourceType: sourceType as Parameters<WikiQueueService['add']>[0]['sourceType'],
      sourceRef,
      content,
      reason,
    });
    res.status(201).json({ success: true, item });
  } catch (err) {
    // Service-level validation errors bubble up as 400; everything else 500.
    const msg = (err as Error).message;
    if (/exceeds|empty|absolute|required/i.test(msg)) {
      res.status(400).json({ success: false, error: msg });
      return;
    }
    logger.error('wiki/queue add threw', { error: msg });
    next(err);
  }
}

/**
 * GET /api/wiki/queue?vaultPath=…&status=…&queuedBy=…&limit=…
 */
export async function queueList(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : undefined;
    const queuedBy = typeof req.query.queuedBy === 'string' ? req.query.queuedBy : undefined;
    const statusRaw = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (statusRaw !== undefined && !VALID_QUEUE_STATUSES.has(statusRaw as WikiQueueStatus)) {
      res.status(400).json({
        success: false,
        error: `status must be one of: ${[...VALID_QUEUE_STATUSES].join(', ')}`,
      });
      return;
    }
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw <= 0)) {
      res.status(400).json({ success: false, error: 'limit must be a positive integer' });
      return;
    }
    const items = await WikiQueueService.getInstance().list({
      vaultPath,
      queuedBy,
      status: statusRaw as WikiQueueStatus | undefined,
      limit: limitRaw,
    });
    res.status(200).json({ success: true, items, count: items.length });
  } catch (err) {
    logger.error('wiki/queue list threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/queue/:id/claim
 *   body: { claimedBy: string }
 */
export async function queueClaim(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const { claimedBy } = req.body ?? {};
    if (typeof claimedBy !== 'string' || claimedBy.length === 0) {
      res.status(400).json({ success: false, error: 'claimedBy (string) is required' });
      return;
    }
    const item = await WikiQueueService.getInstance().claim(id, claimedBy);
    res.status(200).json({ success: true, item });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/i.test(msg)) {
      res.status(404).json({ success: false, error: msg });
      return;
    }
    if (/pending|claimed|status/i.test(msg)) {
      res.status(409).json({ success: false, error: msg });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/wiki/queue/:id/process
 *   body: { ingested: boolean, pagesWritten?: string[], targetPath?: string, summary?: string }
 *
 * Cascade audit (2026-05-26 — Karpathy 10-15-pages-per-source rule):
 *   The response includes `cascadeAudit: { pageCount, classification }` so
 *   callers can self-assess whether they did the cascade work. Single-page
 *   ingests (i.e. just the primary write, no cross-link, no related-page
 *   update) emit a `warn`-level audit log so we can later quantify how
 *   often agents skip cascade — the wiki's compounding value lives in
 *   cascade touches, not in the primary write.
 *
 * Classification:
 *   - `single`     — 1 page written. Likely a missed cascade. Audited (warn).
 *   - `light`      — 2 pages. Acceptable for routine learnings.
 *   - `cascading`  — 3+ pages. Karpathy-shaped: load-bearing content with cross-refs.
 */
export async function queueProcess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const { ingested, pagesWritten, targetPath, summary } = req.body ?? {};
    if (typeof ingested !== 'boolean') {
      res.status(400).json({ success: false, error: 'ingested (boolean) is required' });
      return;
    }
    if (pagesWritten !== undefined && !Array.isArray(pagesWritten)) {
      res.status(400).json({ success: false, error: 'pagesWritten must be an array' });
      return;
    }
    const item = await WikiQueueService.getInstance().markProcessed(id, {
      ingested,
      pagesWritten,
      targetPath,
      summary,
    });

    // Cascade audit. Only when the agent actually wrote (ingested === true).
    let cascadeAudit: {
      pageCount: number;
      classification: 'single' | 'light' | 'cascading' | 'n/a';
    } = { pageCount: 0, classification: 'n/a' };
    if (ingested) {
      const pageCount = Array.isArray(pagesWritten) ? pagesWritten.length : 0;
      const classification: 'single' | 'light' | 'cascading' =
        pageCount <= 1 ? 'single' : pageCount === 2 ? 'light' : 'cascading';
      cascadeAudit = { pageCount, classification };
      if (classification === 'single') {
        logger.warn('wiki-process: cascade missed — single-page ingest', {
          queueItemId: id,
          targetPath,
          pageCount,
          summary: typeof summary === 'string' ? summary.slice(0, 80) : undefined,
          karpathy: '"a single source might touch 10-15 wiki pages" — see wiki-process-queue SKILL.md',
        });
      }
    }

    res.status(200).json({ success: true, item, cascadeAudit });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/i.test(msg)) {
      res.status(404).json({ success: false, error: msg });
      return;
    }
    if (/claimed|status/i.test(msg)) {
      res.status(409).json({ success: false, error: msg });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/wiki/queue/:id/skip
 *   body: { skipReason: string }
 */
export async function queueSkip(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { id } = req.params;
    const { skipReason } = req.body ?? {};
    if (typeof skipReason !== 'string' || skipReason.length === 0) {
      res.status(400).json({ success: false, error: 'skipReason (string) is required' });
      return;
    }
    const item = await WikiQueueService.getInstance().markSkipped(id, skipReason);
    res.status(200).json({ success: true, item });
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found/i.test(msg)) {
      res.status(404).json({ success: false, error: msg });
      return;
    }
    if (/claimed|status/i.test(msg)) {
      res.status(409).json({ success: false, error: msg });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/wiki/queue/claim-next
 *   body: { claimedBy: string, vaultPath?: string, offset?: number, topK?: number, recentLogEntries?: number }
 *
 * Claims the next pending item AND returns the vault context the
 * agent's LLM should classify against. The agent then picks a target
 * page, calls /wiki/ingest, and commits via /queue/:id/process.
 */
export async function queueClaimNext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { claimedBy, vaultPath, offset, topK, recentLogEntries } = req.body ?? {};
    if (typeof claimedBy !== 'string' || claimedBy.length === 0) {
      res.status(400).json({ success: false, error: 'claimedBy (string) is required' });
      return;
    }
    if (vaultPath !== undefined && typeof vaultPath !== 'string') {
      res.status(400).json({ success: false, error: 'vaultPath must be a string when provided' });
      return;
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      res.status(400).json({ success: false, error: 'offset must be a non-negative integer' });
      return;
    }
    const outcome = await WikiProcessService.getInstance().claimNext({
      claimedBy,
      vaultPath,
      offset,
      topK,
      recentLogEntries,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, result: outcome.result });
      return;
    }
    if (outcome.reason === 'no_pending_items') {
      res.status(404).json({ success: false, error: 'no_pending_items', message: outcome.message });
      return;
    }
    res.status(400).json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/queue claim-next threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/bookkeep
 *   body: { vaultPath: string, windowDays?: number, threshold?: number }
 */
export async function bookkeep(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { vaultPath, windowDays, threshold } = req.body ?? {};
    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      res.status(400).json({ success: false, error: 'vaultPath (string) is required' });
      return;
    }
    if (windowDays !== undefined && (!Number.isInteger(windowDays) || windowDays <= 0)) {
      res.status(400).json({ success: false, error: 'windowDays must be a positive integer' });
      return;
    }
    if (threshold !== undefined && (!Number.isInteger(threshold) || threshold <= 0)) {
      res.status(400).json({ success: false, error: 'threshold must be a positive integer' });
      return;
    }
    const outcome = await WikiBookkeepService.getInstance().generate({
      vaultPath,
      windowDays,
      threshold,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, report: outcome.report });
      return;
    }
    const status =
      outcome.reason === 'vault_missing' || outcome.reason === 'schema_missing' ? 404 : 400;
    res.status(status).json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/bookkeep threw', { error: (err as Error).message });
    next(err);
  }
}

// =============================================================================
// Browse endpoints — power the OSS /wiki UI.
// =============================================================================

const MAX_TREE_ENTRIES = 500;
const MAX_PAGE_BYTES = 256 * 1024;

interface WikiTreeNode {
  name: string;
  /** Path relative to the vault root, with forward slashes. */
  relativePath: string;
  type: 'file' | 'directory';
  /** Frozen flag (per SCHEMA.md hardcoded list). */
  frozen?: boolean;
  /**
   * Human-readable description of the frozen folder, pulled from
   * `hardcoded[].description` in SCHEMA.md. Populated for the FROZEN
   * directory node (not its children). Surfaces as a hover tooltip.
   */
  frozenDescription?: string;
  /** File size in bytes. Files only. */
  bytes?: number;
  /** Last-modified ISO timestamp. Files only. */
  modifiedAt?: string;
  /** Sorted children. Directories only. */
  children?: WikiTreeNode[];
}

/**
 * GET /api/wiki/vaults
 *
 * Returns the list of all known vaults (project + team + global) with
 * stats so the UI can render a sidebar. Discovery uses the same logic
 * the bookkeep trigger uses.
 */
export async function listVaults(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPaths = await discoverWikiVaults();
    const schemaLoader = new SchemaLoaderService();
    const entries = await Promise.all(
      vaultPaths.map(async (vaultPath) => {
        let scope = 'unknown' as 'project' | 'team' | 'global' | 'unknown';
        let vaultId = '';
        try {
          const schema = await schemaLoader.load(vaultPath);
          scope = schema.vault_scope;
          vaultId = schema.vault_id;
        } catch {
          // skip — vault present but malformed; still surface to UI
        }

        let bookkeepReport: { totalMdCount: number; recentMdCount: number; queue: { pending: number; processed: number; total: number } } | null = null;
        try {
          const outcome = await WikiBookkeepService.getInstance().generate({ vaultPath });
          if (outcome.ok) {
            bookkeepReport = {
              totalMdCount: outcome.report.totalMdCount,
              recentMdCount: outcome.report.recentMdCount,
              queue: {
                pending: outcome.report.queue.pending,
                processed: outcome.report.queue.processed,
                total: outcome.report.queue.total,
              },
            };
          }
        } catch {
          // ignore — show vault anyway with null stats
        }

        // Human-readable label.
        //
        // Default: schema vault_id (good for global + project where the id IS
        // a human-readable slug). For TEAM vaults the schema's vault_id is
        // the team UUID, which makes the sidebar unreadable — fall back to
        // the team's `name` field from `<team-dir>/config.json` when we can.
        // For PROJECT vaults whose vault_id is generic (e.g. "project"), look
        // it up in `~/.crewly/projects.json` by path so the sidebar shows
        // the registered project name (Closie / Flopost / CE / Stevesprompt).
        let label = vaultId || path.basename(path.dirname(vaultPath));
        if (scope === 'team') {
          const teamDir = path.dirname(vaultPath);
          try {
            const cfgRaw = await fs.readFile(path.join(teamDir, 'config.json'), 'utf8');
            const cfg = JSON.parse(cfgRaw) as { name?: string; teamName?: string };
            const friendly = cfg.name ?? cfg.teamName;
            if (typeof friendly === 'string' && friendly.length > 0) {
              label = friendly;
            }
          } catch {
            // ignore — fall back to UUID label
          }
        } else if (scope === 'project') {
          // Look up project name from projects.json by matching the vault
          // path's parent (project root). Falls back to vault_id/path.
          try {
            const projectsJsonPath = path.join(os.homedir(), '.crewly/projects.json');
            const raw = await fs.readFile(projectsJsonPath, 'utf8');
            const projects = JSON.parse(raw) as Array<{ name?: string; path?: string }>;
            const projectRoot = path.dirname(path.dirname(vaultPath)); // strip /.crewly/wiki
            const hit = projects.find((p) => p.path === projectRoot);
            if (hit && typeof hit.name === 'string' && hit.name.length > 0) {
              label = hit.name;
            }
          } catch {
            // ignore — fall back to vault_id / basename
          }
        }

        return {
          vaultPath,
          scope,
          vaultId,
          label,
          stats: bookkeepReport,
        };
      }),
    );
    res.status(200).json({ success: true, vaults: entries });
  } catch (err) {
    logger.error('wiki/vaults threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/wiki/tree?vaultPath=...
 *
 * Walks the vault directory and returns the file tree. Frozen folders
 * are marked so the UI can render them differently. SCHEMA.md is
 * surfaced as a top-level file.
 */
export async function getVaultTree(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : undefined;
    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      res.status(400).json({ success: false, error: 'vaultPath (absolute) is required' });
      return;
    }
    if (!existsSync(vaultPath)) {
      res.status(404).json({ success: false, error: 'vault_missing' });
      return;
    }

    const schemaLoader = new SchemaLoaderService();
    let frozenSet = new Set<string>();
    // path (without trailing slash) → description from SCHEMA.md hardcoded[]
    const frozenDescriptions = new Map<string, string>();
    try {
      const schema = await schemaLoader.load(vaultPath);
      for (const entry of schema.hardcoded) {
        const folder = entry.path.replace(/[/\\]+$/, '');
        frozenSet.add(folder);
        if (entry.description) frozenDescriptions.set(folder, entry.description);
      }
    } catch {
      // proceed without frozen markers
    }

    let scanned = 0;
    const buildTree = async (absDir: string): Promise<WikiTreeNode[]> => {
      const out: WikiTreeNode[] = [];
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return [];
      }
      for (const entry of entries) {
        if (scanned >= MAX_TREE_ENTRIES) break;
        if (entry.name.startsWith('.')) continue;
        scanned++;
        const abs = path.join(absDir, entry.name);
        const rel = path.relative(vaultPath, abs).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          const folderKey = rel.replace(/[/\\]+$/, '');
          const isFrozen =
            frozenSet.has(folderKey) || frozenSet.has(`${folderKey}/`);
          const children = await buildTree(abs);
          out.push({
            name: entry.name,
            relativePath: rel,
            type: 'directory',
            frozen: isFrozen || undefined,
            frozenDescription: isFrozen
              ? frozenDescriptions.get(folderKey)
              : undefined,
            children: children.sort((a, b) => sortTree(a, b)),
          });
        } else if (entry.isFile()) {
          // Surface markdown + SCHEMA.md only — skip other binaries.
          if (!entry.name.endsWith('.md')) continue;
          try {
            const stat = await fs.stat(abs);
            // Determine frozen via parent dir.
            const parts = rel.split('/');
            const parentRel = parts.slice(0, -1).join('/');
            const isFrozen =
              frozenSet.has(parentRel) || frozenSet.has(`${parentRel}/`);
            out.push({
              name: entry.name,
              relativePath: rel,
              type: 'file',
              frozen: isFrozen || undefined,
              bytes: stat.size,
              modifiedAt: new Date(stat.mtimeMs).toISOString(),
            });
          } catch {
            // ignore unreadable file
          }
        }
      }
      return out;
    };

    const tree = (await buildTree(vaultPath)).sort((a, b) => sortTree(a, b));
    res.status(200).json({
      success: true,
      vaultPath,
      tree,
      truncated: scanned >= MAX_TREE_ENTRIES,
    });
  } catch (err) {
    logger.error('wiki/tree threw', { error: (err as Error).message });
    next(err);
  }
}

function sortTree(a: WikiTreeNode, b: WikiTreeNode): number {
  // Directories first, then files; both alphabetical.
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * GET /api/wiki/page?vaultPath=...&relativePath=...
 *
 * Returns the raw markdown content of a single page. The relativePath
 * is validated to ensure it doesn't escape the vault directory.
 */
export async function getPage(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : undefined;
    const relativePath =
      typeof req.query.relativePath === 'string' ? req.query.relativePath : undefined;
    if (!vaultPath || !path.isAbsolute(vaultPath)) {
      res.status(400).json({ success: false, error: 'vaultPath (absolute) is required' });
      return;
    }
    if (!relativePath || relativePath.length === 0) {
      res.status(400).json({ success: false, error: 'relativePath is required' });
      return;
    }
    if (!relativePath.endsWith('.md')) {
      res.status(400).json({ success: false, error: 'only .md files can be read' });
      return;
    }
    // Resolve and verify containment — path-traversal guard.
    const requested = path.resolve(vaultPath, relativePath);
    const vaultRoot = path.resolve(vaultPath);
    if (!requested.startsWith(vaultRoot + path.sep) && requested !== vaultRoot) {
      res.status(400).json({ success: false, error: 'relativePath escapes vault root' });
      return;
    }
    if (!existsSync(requested)) {
      res.status(404).json({ success: false, error: 'page_not_found' });
      return;
    }
    const stat = await fs.stat(requested);
    if (stat.size > MAX_PAGE_BYTES) {
      res.status(413).json({
        success: false,
        error: 'page_too_large',
        bytes: stat.size,
        maxBytes: MAX_PAGE_BYTES,
      });
      return;
    }
    const content = await fs.readFile(requested, 'utf8');
    res.status(200).json({
      success: true,
      vaultPath,
      relativePath,
      bytes: stat.size,
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      content,
    });
  } catch (err) {
    logger.error('wiki/page threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/wiki/search?vaultPath=…&q=…
 *
 * Full-text search across the vault. Walks every `.md` file, matches
 * case-insensitive substrings, returns up to `WIKI_SEARCH_MAX_RESULTS`
 * hits with line-number snippets.
 */
export async function searchVault(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : '';
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const outcome = await WikiSearchService.getInstance().search({ vaultPath, query });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'vault_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/search threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/wiki/backlinks?vaultPath=…&relativePath=…
 *
 * For the target page, find every other page in the vault whose markdown
 * contains a `[[wikilink]]` that resolves to it. Used by the UI's right
 * sidebar.
 */
export async function getBacklinks(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : '';
    const relativePath =
      typeof req.query.relativePath === 'string' ? req.query.relativePath : '';
    const outcome = await WikiBacklinksService.getInstance().find({ vaultPath, relativePath });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'vault_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/backlinks threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/migrate/scan
 *
 * Dry-run preview of a migration from the legacy `.crewly/knowledge/`
 * stores (+ optional agent memory.json copies) into the v2.1 vault.
 *
 * Body: `{ projectRoot: string, includeAgentMemory?: boolean }`
 */
export async function migrateScan(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const projectRoot =
      typeof body.projectRoot === 'string' ? body.projectRoot : process.cwd();
    const includeAgentMemory =
      typeof body.includeAgentMemory === 'boolean' ? body.includeAgentMemory : true;
    const outcome = await WikiMigrateService.getInstance().scan({
      projectRoot,
      includeAgentMemory,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'project_root_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/migrate/scan threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/migrate/apply
 *
 * Execute the migration: bootstrap missing vaults, write proposed pages,
 * persist manifest. Legacy files are never deleted.
 *
 * Body: `{ projectRoot: string, includeAgentMemory?: boolean, confirm: true }`
 * `confirm: true` is mandatory — guards against accidental triggering.
 */
export async function migrateApply(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    if (body.confirm !== true) {
      res.status(400).json({
        success: false,
        error: 'confirm_required',
        message: 'Pass `confirm: true` to execute. Use /migrate/scan for dry-run.',
      });
      return;
    }
    const projectRoot =
      typeof body.projectRoot === 'string' ? body.projectRoot : process.cwd();
    const includeAgentMemory =
      typeof body.includeAgentMemory === 'boolean' ? body.includeAgentMemory : true;
    const outcome = await WikiMigrateService.getInstance().apply({
      projectRoot,
      includeAgentMemory,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'project_root_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/migrate/apply threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/cleanup/scan
 *
 * Dry-run: walk the vault's `llm-curated/` tree and return a list of
 * pages flagged by the cleanup rules (low confidence, agent memory
 * dump, per-agent cap). No filesystem mutation.
 *
 * Body: `{ vaultPath: string, rules?: { minConfidence?, dropAgentMemoryDumps?, maxPerAgent? } }`
 */
export async function cleanupScan(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    if (typeof body.vaultPath !== 'string') {
      res
        .status(400)
        .json({ success: false, error: 'invalid_input', message: 'vaultPath is required' });
      return;
    }
    const outcome = await WikiCleanupService.getInstance().scan({
      vaultPath: body.vaultPath,
      rules: body.rules,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'vault_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/cleanup/scan threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/cleanup/apply
 *
 * Execute the cleanup: delete the listed pages, archive their bodies
 * to `.wiki-cleanup-archive.json`, and invalidate matching migrate
 * manifest entries so the same source can't re-import the page.
 *
 * Body: `{ vaultPath: string, pages: string[], confirm: true }`
 *   - `pages`: explicit relative paths to delete (caller has already
 *     decided which scan candidates to act on)
 *   - `confirm: true` is mandatory — guards against accidental triggering.
 */
export async function cleanupApply(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    if (body.confirm !== true) {
      res.status(400).json({
        success: false,
        error: 'confirm_required',
        message: 'Pass `confirm: true` to execute. Use /cleanup/scan for dry-run.',
      });
      return;
    }
    if (typeof body.vaultPath !== 'string') {
      res
        .status(400)
        .json({ success: false, error: 'invalid_input', message: 'vaultPath is required' });
      return;
    }
    if (!Array.isArray(body.pages) || body.pages.length === 0) {
      res
        .status(400)
        .json({ success: false, error: 'invalid_input', message: 'pages must be a non-empty array' });
      return;
    }
    const outcome = await WikiCleanupService.getInstance().apply({
      vaultPath: body.vaultPath,
      pages: body.pages,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'vault_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/cleanup/apply threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/migrate/oss-sops
 *
 * Migrate OSS-distributed SOPs (`config/sops`, `config/domain-sops`,
 * `config/templates/pro-sops/norms`) into the global vault's
 * `llm-curated/sops/` tree so `wiki-query` can find them.
 *
 * Body: `{ crewlySourceRoot?: string, confirm?: true }`
 *   - When `confirm: true` is set, writes files (apply). Otherwise dry-run.
 *   - Default crewlySourceRoot = process.cwd() (works when OSS runs from its own source).
 */
export async function migrateOssSops(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const crewlySourceRoot =
      typeof body.crewlySourceRoot === 'string' ? body.crewlySourceRoot : undefined;
    const apply = body.confirm === true;
    const outcome = await WikiMigrateService.getInstance().migrateOssSops({
      crewlySourceRoot,
      apply,
    });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'project_root_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/migrate/oss-sops threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/reflect/trigger-now
 *
 * Fire ONE WikiReflectTrigger tick on demand. Used for verification —
 * confirms the trigger emits `[REFLECT-WIKI]` messages to the right
 * channel without waiting for the scheduled interval to elapse.
 *
 * Production cadence remains the scheduled scan.
 */
export async function reflectTriggerNow(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const trigger = WikiReflectTriggerService.getInstance();
    if (!trigger) {
      res.status(503).json({
        success: false,
        error: 'wiki reflect trigger is not registered — boot wiring did not complete',
      });
      return;
    }
    // Force a fire past the debounce window so a manual trigger is never
    // silently suppressed by an earlier scheduled tick. Unlike clearing the
    // ledger, this leaves other vaults' debounce + the persisted state intact,
    // so the next scheduled tick won't re-burst.
    const result = await trigger.tick({ ignoreDebounce: true });
    res.status(200).json({ success: true, result });
  } catch (err) {
    logger.error('wiki/reflect/trigger-now threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/wiki/recent?vaultPath=…&limit=…
 *
 * Returns the most-recently-modified `.md` pages in the vault. Powers
 * the "What's new" widget in the page-pane empty state.
 */
export async function getRecent(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : '';
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const limit = limitRaw && Number.isFinite(limitRaw) ? limitRaw : undefined;
    const outcome = await WikiRecentService.getInstance().list({ vaultPath, limit });
    if (outcome.ok) {
      res.status(200).json({ success: true, ...outcome });
      return;
    }
    const status = outcome.reason === 'vault_missing' ? 404 : 400;
    res
      .status(status)
      .json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/recent threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/lint
 *
 * Run a deterministic validation pass over the vault. Reports frozen-path
 * violations, dangling wikilinks, orphan pages, stale claims, and
 * restructure proposals. The service does not modify the vault — the
 * agent reads the report and decides next actions.
 */
export async function lintVault(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const vaultPath = typeof body.vaultPath === 'string' ? body.vaultPath : '';
    const staleDays = typeof body.staleDays === 'number' ? body.staleDays : undefined;
    const outcome = await WikiLintService.getInstance().generate({ vaultPath, staleDays });
    if (outcome.ok) {
      res.status(200).json({ success: true, report: outcome.report });
      return;
    }
    const status =
      outcome.reason === 'vault_missing' || outcome.reason === 'schema_missing' ? 404 : 400;
    res.status(status).json({ success: false, error: outcome.reason, message: outcome.message });
  } catch (err) {
    logger.error('wiki/lint threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * POST /api/wiki/bookkeep/trigger-now
 *
 * Force one tick of the bookkeep trigger NOW. Used for manual testing
 * (curl, the chat UI, an admin button) — production cadence is the
 * automatic interval scan, but operators sometimes want to invoke it
 * synchronously to verify wiring or to clear a backlog.
 */
export async function bookkeepTriggerNow(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const trigger = WikiBookkeepTriggerService.getInstance();
    if (!trigger) {
      res.status(503).json({
        success: false,
        error: 'wiki bookkeep trigger is not registered — boot wiring did not complete',
      });
      return;
    }
    const result = await trigger.tick();
    res.status(200).json({ success: true, result });
  } catch (err) {
    logger.error('wiki/bookkeep/trigger-now threw', { error: (err as Error).message });
    next(err);
  }
}

/**
 * GET /api/wiki/queue/stats?vaultPath=…
 */
export async function queueStats(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vaultPath = typeof req.query.vaultPath === 'string' ? req.query.vaultPath : undefined;
    const stats = await WikiQueueService.getInstance().getStats(vaultPath);
    res.status(200).json({ success: true, stats, vaultPath: vaultPath ?? null });
  } catch (err) {
    next(err);
  }
}
