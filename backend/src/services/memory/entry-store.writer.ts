/**
 * Guarded writer for the project memory stores (`knowledge/*.json`): arrays
 * of entries that people and agents add to over months, with no other copy.
 *
 * A write may drop only the entries its caller names. Anything else (a caller
 * that loaded an empty or stale list, a bug) is refused and the file stays as
 * it is. The previous version is kept as `<file>.bak`.
 *
 * @module services/memory/entry-store.writer
 */

import * as fs from 'fs/promises';
import { atomicWriteFile, atomicWriteJson, quarantineCorruptFile, withOperationLock, type FileIOLogger } from '../../utils/file-io.utils.js';
import { MEMORY_CONSTANTS } from '../../constants.js';

/** Lock namespace, apart from other users of the shared operation locks. */
const LOCK_PREFIX = 'entry-store:';

/** A write would have dropped entries nobody asked to remove. */
export class EntryStoreShrinkError extends Error {
  /**
   * @param filePath - The store
   * @param stored - Entries in the file
   * @param writing - Entries in the refused write
   * @param lost - How many would have been dropped without being named
   */
  constructor(readonly filePath: string, readonly stored: number, readonly writing: number, readonly lost: number) {
    super(`Refused to write ${filePath}: it holds ${stored} entries, the write has ${writing} and would drop ${lost} that nobody asked to remove. The file was not changed.`);
    this.name = 'EntryStoreShrinkError';
  }
}

/** Options for {@link writeEntryStore}. */
export interface WriteEntryStoreOptions {
  /** Ids this write removes on purpose (a delete, an eviction, an archive move) */
  removing?: readonly string[];
  logger?: FileIOLogger;
}

/**
 * Id of a stored entry.
 *
 * @param entry - Any stored value
 * @returns Its id, or undefined
 */
function idOf(entry: unknown): string | undefined {
  const id = (entry as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * How many stored entries a write would drop without naming them.
 *
 * @param stored - Entries in the file
 * @param next - Entries about to be written
 * @param removing - Ids removed on purpose
 * @returns Named entries that vanish unasked, or the unexplained drop in length when larger (entries without an id)
 */
function countLost(stored: readonly unknown[], next: readonly unknown[], removing: ReadonlySet<string>): number {
  const kept = new Set(next.map(idOf));
  const gone = stored.map(idOf).filter((id): id is string => id !== undefined && !kept.has(id));
  const unasked = gone.filter((id) => !removing.has(id)).length;
  const asked = gone.length - unasked;
  // `next` may also hold new entries, so a length drop alone is a lower bound.
  return Math.max(unasked, stored.length - asked - next.length);
}

/**
 * Run a read-modify-write of one store with no other one in between, so two
 * adds cannot each save a list without the other's entry.
 *
 * @param filePath - The store
 * @param operation - Loads, changes and saves it
 * @returns The operation's result
 */
export function withEntryStore<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  return withOperationLock(`${LOCK_PREFIX}${filePath}`, operation);
}

/**
 * Replace an entry store, keeping the previous version.
 *
 * - missing file: written;
 * - unreadable (permissions, I/O): the read error is thrown, nothing written;
 * - not a JSON array: copied aside first ({@link quarantineCorruptFile});
 * - entries dropped that `removing` does not name: {@link EntryStoreShrinkError};
 * - otherwise the old text is saved to `<file>.bak`, then the new one is
 *   written atomically. A removal of several entries also keeps a dated copy,
 *   which later writes do not replace.
 *
 * @param filePath - The store
 * @param entries - Its new content
 * @param options - Ids removed on purpose
 * @throws EntryStoreShrinkError, or the read/backup error; the store is unchanged either way
 */
export async function writeEntryStore<T>(filePath: string, entries: readonly T[], options: WriteEntryStoreOptions = {}): Promise<void> {
  let previous: string | null = null;
  try {
    previous = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  if (previous !== null) {
    let stored: unknown = null;
    try {
      stored = JSON.parse(previous);
    } catch {
      stored = null;
    }
    if (!Array.isArray(stored)) {
      await quarantineCorruptFile(filePath, 'not a JSON array of entries', options.logger);
    } else {
      const removing = new Set(options.removing ?? []);
      const lost = countLost(stored, entries, removing);
      if (lost > 0) {
        const refusal = new EntryStoreShrinkError(filePath, stored.length, entries.length, lost);
        options.logger?.error?.(refusal.message, { filePath, stored: stored.length, writing: entries.length, lost });
        throw refusal;
      }
      await atomicWriteFile(`${filePath}${MEMORY_CONSTANTS.STORE_BACKUP.PREVIOUS_SUFFIX}`, previous);
      const dropped = stored.filter((e) => removing.has(idOf(e) ?? '')).length;
      if (dropped > 1) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        await atomicWriteFile(`${filePath}${MEMORY_CONSTANTS.STORE_BACKUP.REMOVAL_SUFFIX}${stamp}`, previous);
      }
    }
  }

  await atomicWriteJson(filePath, entries);
}
