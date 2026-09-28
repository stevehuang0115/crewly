/**
 * Locking and id allocation for a project's tickets folder
 * (specs/2026-09-28-project-tickets.md §2 "Concurrency").
 *
 * Two layers, because writers live in more than one process (the backend,
 * a `crewly tickets migrate` run, a second backend on the same machine):
 * - an in-process operation lock keyed on the folder, so concurrent async
 *   callers in one process queue up instead of polling the lockfile;
 * - a lockfile created with `O_EXCL` (`wx`), so other processes wait too. A
 *   lockfile older than {@link PROJECT_TICKET_CONSTANTS.LOCK_STALE_MS} was left
 *   by a crashed writer and is taken over.
 *
 * @module services/project-tickets/ticket-folder-lock
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PROJECT_TICKET_CONSTANTS } from '../../constants.js';
import { atomicWriteJson, ensureDir, withOperationLock } from '../../utils/file-io.utils.js';

/** Counter file shape. */
export interface TicketCounter {
  prefix: string;
  next: number;
}

/**
 * Sleep helper.
 *
 * @param ms - Milliseconds
 * @returns Resolves after `ms`
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Take the cross-process lockfile, waiting for another holder.
 *
 * @param lockPath - Lockfile path
 * @throws When the lock cannot be taken within the timeout
 */
async function acquireLockfile(lockPath: string): Promise<void> {
  const { LOCK_STALE_MS, LOCK_RETRY_MS, LOCK_TIMEOUT_MS } = PROJECT_TICKET_CONSTANTS;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      const stat = await fs.stat(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
    } catch {
      // Released between our open and stat — try again right away.
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for the tickets lock (${lockPath})`);
    await sleep(LOCK_RETRY_MS);
  }
}

/**
 * Run `fn` while holding the folder's in-process and cross-process locks.
 * Creates the folder (and its own `.gitignore` for the lock and temp files)
 * when missing.
 *
 * @param dir - Absolute tickets folder
 * @param fn - Critical section
 * @returns Whatever `fn` returns
 * @throws When the lock cannot be taken, or whatever `fn` throws
 *
 * @example
 * ```typescript
 * await withTicketFolderLock(dir, async () => writeTicket(...));
 * ```
 */
export async function withTicketFolderLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  return withOperationLock(`project-tickets:${path.resolve(dir)}`, async () => {
    await ensureDir(dir);
    await ensureFolderGitignore(dir);
    const lockPath = path.join(dir, PROJECT_TICKET_CONSTANTS.LOCK_FILENAME);
    await acquireLockfile(lockPath);
    try {
      return await fn();
    } finally {
      await fs.unlink(lockPath).catch(() => undefined);
    }
  });
}

/**
 * Write the folder's own `.gitignore` (lockfile + temp files) once.
 *
 * @param dir - Tickets folder
 */
async function ensureFolderGitignore(dir: string): Promise<void> {
  const p = path.join(dir, '.gitignore');
  try {
    await fs.access(p);
  } catch {
    await fs.writeFile(p, PROJECT_TICKET_CONSTANTS.FOLDER_GITIGNORE_CONTENT, 'utf8');
  }
}

/**
 * Derive a ticket id prefix from a project name: up to four letters/digits,
 * preferring word initials for multi-word names.
 *
 * @param projectName - Project display name
 * @returns Uppercase prefix (never empty)
 *
 * @example
 * ```typescript
 * derivePrefix('crewly');           // 'CREW'
 * derivePrefix('Steam Fun Portal'); // 'SFP'
 * ```
 */
export function derivePrefix(projectName: string): string {
  const { MAX_PREFIX_LENGTH, FALLBACK_PREFIX } = PROJECT_TICKET_CONSTANTS;
  const words = projectName
    .normalize('NFKD')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return FALLBACK_PREFIX;
  const raw = words.length > 1 ? words.map((w) => w[0]).join('') : words[0];
  return raw.slice(0, MAX_PREFIX_LENGTH);
}

/**
 * Read the counter file (missing or corrupt → null).
 *
 * @param dir - Tickets folder
 * @returns Counter, or null
 */
export async function readCounter(dir: string): Promise<TicketCounter | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, PROJECT_TICKET_CONSTANTS.COUNTER_FILENAME), 'utf8')) as Partial<TicketCounter>;
    if (typeof raw.prefix !== 'string' || !/^[A-Za-z0-9]+$/.test(raw.prefix)) return null;
    const next = typeof raw.next === 'number' && Number.isInteger(raw.next) && raw.next > 0 ? raw.next : 1;
    return { prefix: raw.prefix, next };
  } catch {
    return null;
  }
}

/**
 * Highest ticket number already used in the folder for a prefix, read from
 * the file names (`CRW-12-foo.md` → 12).
 *
 * @param dir - Tickets folder
 * @param prefix - Id prefix
 * @returns Highest number, or 0
 */
async function highestUsedNumber(dir: string, prefix: string): Promise<number> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const re = new RegExp(`^${prefix}-(\\d+)(?:-|\\.md$)`, 'i');
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Allocate the next ticket id. MUST be called while holding
 * {@link withTicketFolderLock} for the same folder.
 *
 * Takes `max(counter.next, highest used + 1)` so ids that arrive through a
 * git merge are never reused, then advances the counter.
 *
 * @param dir - Tickets folder
 * @param projectName - Used to derive the prefix the first time
 * @returns The new id, e.g. `CREW-13`
 */
export async function allocateTicketId(dir: string, projectName: string): Promise<string> {
  const counter = await readCounter(dir);
  const prefix = counter?.prefix ?? derivePrefix(projectName);
  const used = await highestUsedNumber(dir, prefix);
  const n = Math.max(counter?.next ?? 1, used + 1);
  await atomicWriteJson(path.join(dir, PROJECT_TICKET_CONSTANTS.COUNTER_FILENAME), { prefix, next: n + 1 });
  return `${prefix}-${n}`;
}
