/**
 * Tests for the one-time task-pool archive (specs/ticket-loop.md §4).
 *
 * Runs against a fixture pool in a temp dir through the real PoolStorage —
 * never against ~/.crewly/task-pool.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PoolStorage } from './pool-storage.js';
import {
  runPoolArchiveMigration,
  selectItemsToArchive,
  archiveReasonFor,
  archiveFileName,
  type PoolArchiveFile,
} from './pool-archive-migration.js';
import { createWorkItem, type WorkItem, type WorkItemStatus, type WorkItemType } from '../../types/v2/work-item.types.js';
import { POOL_ARCHIVE_CONSTANTS } from '../../constants.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/**
 * Fixture WorkItem.
 *
 * @param id - Id
 * @param status - Status
 * @param ageDays - Age in days (createdAt and, for finished items, completedAt)
 * @param type - WorkItem type
 * @returns WorkItem
 */
function wi(id: string, status: WorkItemStatus, ageDays: number, type: WorkItemType = 'delegate'): WorkItem {
  const at = new Date(NOW.getTime() - ageDays * DAY).toISOString();
  const item = createWorkItem({ id, type, owner: 'agent', title: id });
  return {
    ...item,
    status,
    createdAt: at,
    ...(['verified', 'done', 'failed', 'cancelled'].includes(status) ? { completedAt: at } : {}),
  };
}

/** A pool shaped like the one in the spec, in miniature. */
const FIXTURE: WorkItem[] = [
  wi('verified-old', 'verified', 120),
  wi('done-old', 'done', 30),
  wi('failed-old', 'failed', 8),
  wi('cancelled-old', 'cancelled', 9),
  wi('review-queued-old', 'queued', 10, 'review'),
  // kept
  wi('verified-recent', 'verified', 2),
  wi('review-queued-recent', 'queued', 3, 'review'),
  wi('delegate-queued-old', 'queued', 40),
  wi('running-old', 'running', 40),
  wi('blocked-old', 'blocked', 40),
  wi('review-running-old', 'running', 40, 'review'),
];

let dir: string;
let storage: PoolStorage;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-archive-'));
  await fs.writeFile(
    path.join(dir, 'pool.json'),
    JSON.stringify({ workItems: FIXTURE, claims: [{ id: 'claim-1', workItemId: 'done-old' }], lastUpdatedAt: NOW.toISOString() }),
  );
  storage = new PoolStorage({ dataDir: dir });
});

afterEach(async () => {
  await storage.destroy();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('selection', () => {
  it('archives old terminal items and old queued reviews only', () => {
    const picked = selectItemsToArchive(FIXTURE, NOW.getTime());
    expect(picked.map((p) => [p.workItem.id, p.reason])).toEqual([
      ['verified-old', 'terminal'],
      ['done-old', 'terminal'],
      ['failed-old', 'terminal'],
      ['cancelled-old', 'terminal'],
      ['review-queued-old', 'stale_review'],
    ]);
  });

  it('keeps anything without a usable date', () => {
    expect(archiveReasonFor({ ...wi('x', 'done', 30), completedAt: undefined, createdAt: 'garbage' }, NOW.getTime())).toBeNull();
  });

  it('measures finished items from completion, not creation', () => {
    const item = { ...wi('x', 'done', 30), completedAt: new Date(NOW.getTime() - DAY).toISOString() };
    expect(archiveReasonFor(item, NOW.getTime())).toBeNull();
  });

  it('names the archive after the run date', () => {
    expect(archiveFileName(NOW)).toBe('pool-archive-2026-09-24.json');
  });
});

describe('runPoolArchiveMigration', () => {
  it('moves the selected items to the archive, keeps the rest, writes the marker and logs counts', async () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const result = await runPoolArchiveMigration(storage, { now: NOW, logger });

    expect(result).toMatchObject({
      skipped: false,
      total: 11,
      archived: 5,
      kept: 6,
      staleReviews: 1,
      byStatus: { verified: 1, done: 1, failed: 1, cancelled: 1, queued: 1 },
    });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('archive'), expect.objectContaining({ archived: 5, kept: 6 }));

    // Live pool on disk: the kept six, claims untouched.
    const live = JSON.parse(await fs.readFile(path.join(dir, 'pool.json'), 'utf-8'));
    expect(live.workItems.map((w: WorkItem) => w.id).sort()).toEqual(
      ['blocked-old', 'delegate-queued-old', 'review-queued-recent', 'review-running-old', 'running-old', 'verified-recent'],
    );
    expect(live.claims).toHaveLength(1);

    // Archive: every moved item, whole, with its reason.
    const archive: PoolArchiveFile = JSON.parse(
      await fs.readFile(path.join(dir, POOL_ARCHIVE_CONSTANTS.ARCHIVE_DIRNAME, 'pool-archive-2026-09-24.json'), 'utf-8'),
    );
    expect(archive.workItems.map((w) => w.id).sort()).toEqual(
      ['cancelled-old', 'done-old', 'failed-old', 'review-queued-old', 'verified-old'],
    );
    expect(archive.workItems.find((w) => w.id === 'review-queued-old')?.archiveReason).toBe('stale_review');
    expect(archive.workItems.find((w) => w.id === 'verified-old')).toMatchObject({ title: 'verified-old', status: 'verified' });
    expect(archive.runs).toHaveLength(1);

    // Marker.
    const marker = JSON.parse(await fs.readFile(path.join(dir, POOL_ARCHIVE_CONSTANTS.MARKER_FILENAME), 'utf-8'));
    expect(marker).toMatchObject({ archived: 5, kept: 6 });
  });

  it('runs once: a second run is skipped and changes nothing', async () => {
    await runPoolArchiveMigration(storage, { now: NOW });
    const again = await runPoolArchiveMigration(storage, { now: new Date(NOW.getTime() + 30 * DAY) });
    expect(again).toMatchObject({ skipped: true, archived: 0, kept: 6 });
    const live = JSON.parse(await fs.readFile(path.join(dir, 'pool.json'), 'utf-8'));
    expect(live.workItems).toHaveLength(6);
  });

  it('is append-only: an existing archive file is merged by id, never rewritten away', async () => {
    const archiveDir = path.join(dir, POOL_ARCHIVE_CONSTANTS.ARCHIVE_DIRNAME);
    await fs.mkdir(archiveDir, { recursive: true });
    const prior: PoolArchiveFile = {
      version: 1,
      runs: [{ archivedAt: 'earlier', migration: 'x', added: 2 }],
      workItems: [wi('from-before', 'done', 200), wi('done-old', 'done', 30)],
    };
    await fs.writeFile(path.join(archiveDir, archiveFileName(NOW)), JSON.stringify(prior));
    await runPoolArchiveMigration(storage, { now: NOW });
    const archive: PoolArchiveFile = JSON.parse(await fs.readFile(path.join(archiveDir, archiveFileName(NOW)), 'utf-8'));
    const ids = archive.workItems.map((w) => w.id);
    expect(ids).toContain('from-before');
    expect(ids.filter((id) => id === 'done-old')).toHaveLength(1);
    expect(ids).toHaveLength(6);
    expect(archive.runs).toHaveLength(2);
    expect(archive.runs[1].added).toBe(4);
  });

  it('never overwrites an unreadable archive file — writes beside it', async () => {
    const archiveDir = path.join(dir, POOL_ARCHIVE_CONSTANTS.ARCHIVE_DIRNAME);
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, archiveFileName(NOW)), '{ not json');
    const result = await runPoolArchiveMigration(storage, { now: NOW });
    expect(await fs.readFile(path.join(archiveDir, archiveFileName(NOW)), 'utf-8')).toBe('{ not json');
    expect(result.archiveFile).toMatch(/pool-archive-2026-09-24-\d+\.json$/);
    const archive: PoolArchiveFile = JSON.parse(await fs.readFile(result.archiveFile!, 'utf-8'));
    expect(archive.workItems).toHaveLength(5);
  });

  it('writes the archive before touching the pool: a failed archive write leaves the pool as it was', async () => {
    // A FILE where the archive directory should be makes the archive write fail.
    await fs.writeFile(path.join(dir, POOL_ARCHIVE_CONSTANTS.ARCHIVE_DIRNAME), 'not a dir');
    await expect(runPoolArchiveMigration(storage, { now: NOW })).rejects.toThrow();
    expect(await storage.getWorkItems()).toHaveLength(11);
    await expect(fs.access(path.join(dir, POOL_ARCHIVE_CONSTANTS.MARKER_FILENAME))).rejects.toThrow();
  });

  it('goes through the storage cache, so a later flush cannot resurrect archived items', async () => {
    await runPoolArchiveMigration(storage, { now: NOW });
    await storage.addWorkItem(wi('new-one', 'queued', 0));
    await storage.flush();
    const live = JSON.parse(await fs.readFile(path.join(dir, 'pool.json'), 'utf-8'));
    expect(live.workItems).toHaveLength(7);
    expect(live.workItems.some((w: WorkItem) => w.id === 'verified-old')).toBe(false);
  });

  it('a pool with nothing to archive still gets its marker, and no archive file', async () => {
    await fs.writeFile(path.join(dir, 'pool.json'), JSON.stringify({ workItems: [wi('fresh', 'done', 1)], claims: [], lastUpdatedAt: NOW.toISOString() }));
    storage = new PoolStorage({ dataDir: dir });
    const result = await runPoolArchiveMigration(storage, { now: NOW });
    expect(result).toMatchObject({ archived: 0, kept: 1 });
    expect(result.archiveFile).toBeUndefined();
    await expect(fs.access(path.join(dir, POOL_ARCHIVE_CONSTANTS.ARCHIVE_DIRNAME))).rejects.toThrow();
    await expect(fs.access(path.join(dir, POOL_ARCHIVE_CONSTANTS.MARKER_FILENAME))).resolves.toBeUndefined();
  });
});
