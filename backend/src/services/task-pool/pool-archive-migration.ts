/**
 * One-time task-pool archive (specs/ticket-loop.md, Phase 1 §4).
 *
 * The live pool had grown to ~880 WorkItems, ~830 of them non-terminal on
 * paper, hundreds `verified` since May, plus a pile of `review` items queued
 * on the orchestrator that nobody will ever pick up. This moves, once:
 *
 * - every WorkItem that is `verified` / `done` / `failed` / `cancelled` and
 *   older than 7 days, and
 * - every `queued` `review` WorkItem older than 7 days
 *
 * into `task-pool/archive/pool-archive-YYYY-MM-DD.json`. Nothing is deleted:
 * the archive is written (and merged by id, append-only) BEFORE the items
 * leave the live pool, so a crash in between only means the next boot moves
 * the same items again without duplicating them. A marker file
 * (`task-pool/.archived-2026-09-ticket-loop`) makes it run once.
 *
 * It goes through {@link PoolStorage} — the same in-memory cache every other
 * pool writer uses — so a later debounced flush can never write the archived
 * items back.
 *
 * @module services/task-pool/pool-archive-migration
 */

import * as path from 'path';
import { promises as fs } from 'fs';
import { atomicWriteJson, ensureDir } from '../../utils/file-io.utils.js';
import { POOL_ARCHIVE_CONSTANTS } from '../../constants.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import type { ComponentLogger } from '../core/logger.service.js';

/** Why an item was archived. */
export type ArchiveReason = 'terminal' | 'stale_review';

/** The pool surface the migration needs. */
export interface ArchivablePool {
  getWorkItems(): Promise<WorkItem[]>;
  removeWorkItems(ids: ReadonlySet<string>): Promise<number>;
  flush(): Promise<void>;
  getDataDir(): string;
}

/** On-disk archive file. Append-only. */
export interface PoolArchiveFile {
  version: 1;
  /** One entry per run that added items */
  runs: Array<{ archivedAt: string; migration: string; added: number }>;
  workItems: Array<WorkItem & { archiveReason?: ArchiveReason }>;
}

/** Counts reported (and logged) by a run. */
export interface PoolArchiveResult {
  /** True when the marker was already there */
  skipped: boolean;
  /** Items in the pool before */
  total: number;
  /** Items moved to the archive */
  archived: number;
  /** Items left in the live pool */
  kept: number;
  /** Archived by status */
  byStatus: Record<string, number>;
  /** Of `archived`, how many were queued review items */
  staleReviews: number;
  /** Archive file written, when anything was archived */
  archiveFile?: string;
}

/**
 * Epoch ms an item's age is measured from: completion for finished items,
 * creation otherwise.
 *
 * @param wi - WorkItem
 * @returns Epoch ms, or NaN when the item carries no usable date
 */
function ageAnchor(wi: WorkItem): number {
  const completed = wi.completedAt ? Date.parse(wi.completedAt) : NaN;
  return Number.isFinite(completed) ? completed : Date.parse(wi.createdAt);
}

/**
 * Why a WorkItem should be archived, or null to keep it.
 *
 * Items with no parseable date are kept — the migration only moves what it
 * can prove is old.
 *
 * @param wi - WorkItem
 * @param now - Current time (ms)
 * @returns The reason, or null
 */
export function archiveReasonFor(wi: WorkItem, now: number): ArchiveReason | null {
  const anchor = ageAnchor(wi);
  if (!Number.isFinite(anchor) || now - anchor < POOL_ARCHIVE_CONSTANTS.MIN_AGE_MS) return null;
  if ((POOL_ARCHIVE_CONSTANTS.TERMINAL_STATUSES as readonly string[]).includes(wi.status)) return 'terminal';
  if (wi.type === 'review' && wi.status === 'queued') {
    const created = Date.parse(wi.createdAt);
    if (Number.isFinite(created) && now - created >= POOL_ARCHIVE_CONSTANTS.MIN_AGE_MS) return 'stale_review';
  }
  return null;
}

/**
 * Select the items to archive (pure).
 *
 * @param items - Every WorkItem in the pool
 * @param now - Current time (ms)
 * @returns Items with their reason
 */
export function selectItemsToArchive(
  items: readonly WorkItem[],
  now: number,
): Array<{ workItem: WorkItem; reason: ArchiveReason }> {
  const out: Array<{ workItem: WorkItem; reason: ArchiveReason }> = [];
  for (const wi of items) {
    const reason = archiveReasonFor(wi, now);
    if (reason) out.push({ workItem: wi, reason });
  }
  return out;
}

/**
 * Archive file name for a run date.
 *
 * @param now - Run time
 * @returns `pool-archive-YYYY-MM-DD.json` (UTC date)
 */
export function archiveFileName(now: Date): string {
  return `${POOL_ARCHIVE_CONSTANTS.ARCHIVE_FILE_PREFIX}${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Whether a file exists.
 *
 * @param p - Path
 * @returns True when it does
 */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an existing archive file.
 *
 * @param file - Archive path
 * @returns The parsed archive, or null when it cannot be read as one
 */
async function readArchive(file: string): Promise<PoolArchiveFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as Partial<PoolArchiveFile>;
    if (!parsed || !Array.isArray(parsed.workItems)) return null;
    return { version: 1, runs: Array.isArray(parsed.runs) ? parsed.runs : [], workItems: parsed.workItems };
  } catch {
    return null;
  }
}

/**
 * Run the one-time archive. Idempotent: returns `skipped` when the marker
 * file is present.
 *
 * @param pool - The live pool (PoolStorage)
 * @param options - Clock and logger
 * @returns Counts
 * @throws When the archive or marker cannot be written — the live pool is
 *   left untouched in that case (the archive is written first)
 */
export async function runPoolArchiveMigration(
  pool: ArchivablePool,
  options: { now?: Date; logger?: Pick<ComponentLogger, 'info' | 'warn'> } = {},
): Promise<PoolArchiveResult> {
  const now = options.now ?? new Date();
  const dir = pool.getDataDir();
  const markerPath = path.join(dir, POOL_ARCHIVE_CONSTANTS.MARKER_FILENAME);
  // A copy: the storage hands out its live array, which the removal below
  // shrinks in place.
  const items = [...(await pool.getWorkItems())];
  if (await exists(markerPath)) {
    return { skipped: true, total: items.length, archived: 0, kept: items.length, byStatus: {}, staleReviews: 0 };
  }

  const selected = selectItemsToArchive(items, now.getTime());
  const byStatus: Record<string, number> = {};
  let staleReviews = 0;
  for (const { workItem, reason } of selected) {
    byStatus[workItem.status] = (byStatus[workItem.status] ?? 0) + 1;
    if (reason === 'stale_review') staleReviews += 1;
  }

  let archiveFile: string | undefined;
  if (selected.length > 0) {
    const archiveDir = path.join(dir, POOL_ARCHIVE_CONSTANTS.ARCHIVE_DIRNAME);
    await ensureDir(archiveDir);
    archiveFile = path.join(archiveDir, archiveFileName(now));
    let existing: PoolArchiveFile = { version: 1, runs: [], workItems: [] };
    if (await exists(archiveFile)) {
      const read = await readArchive(archiveFile);
      if (read) {
        existing = read;
      } else {
        // Unreadable archive: never overwrite it — write beside it instead.
        archiveFile = archiveFile.replace(/\.json$/, `-${now.getTime()}.json`);
        options.logger?.warn('Existing pool archive is unreadable — writing a new file beside it', { archiveFile });
      }
    }
    const archived = existing.workItems;
    const known = new Set(archived.map((w) => w.id));
    const added = selected.filter(({ workItem }) => !known.has(workItem.id));
    const next: PoolArchiveFile = {
      version: 1,
      runs: [
        ...existing.runs,
        { archivedAt: now.toISOString(), migration: POOL_ARCHIVE_CONSTANTS.MARKER_FILENAME, added: added.length },
      ],
      workItems: [...archived, ...added.map(({ workItem, reason }) => ({ ...workItem, archiveReason: reason }))],
    };
    // Archive first: only once it is on disk do the items leave the pool.
    await atomicWriteJson(archiveFile, next);
    await pool.removeWorkItems(new Set(selected.map(({ workItem }) => workItem.id)));
    await pool.flush();
  }

  const result: PoolArchiveResult = {
    skipped: false,
    total: items.length,
    archived: selected.length,
    kept: items.length - selected.length,
    byStatus,
    staleReviews,
    ...(archiveFile ? { archiveFile } : {}),
  };
  await atomicWriteJson(markerPath, { ranAt: now.toISOString(), ...result });
  options.logger?.info('Task pool one-time archive (ticket loop) complete', { ...result });
  return result;
}
