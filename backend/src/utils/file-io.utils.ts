/**
 * Centralized Atomic File I/O Utilities
 *
 * Provides safe, atomic file operations for all JSON persistence in Crewly.
 * Uses temp-file + fsync + rename to prevent corruption on crash,
 * and in-process locks to serialize concurrent writes to the same file.
 *
 * @module utils/file-io.utils
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Minimal logger interface accepted by safeReadJson / modifyJsonFile.
 * Compatible with ComponentLogger from LoggerService.
 */
export interface FileIOLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

// ──────────────────────────────────────────────────────────────────────
//  Module-level lock maps (singleton per process — no class needed)
// ──────────────────────────────────────────────────────────────────────

const fileLocks: Map<string, Promise<void>> = new Map();
const operationLocks: Map<string, Promise<void>> = new Map();

// ──────────────────────────────────────────────────────────────────────
//  Directory helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Ensures a directory exists, creating it recursively if necessary.
 *
 * @param dirPath - Absolute path to the directory
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────
//  Locking
// ──────────────────────────────────────────────────────────────────────

/**
 * Acquire and hold a lock from the given map for the duration of the operation.
 *
 * Uses promise-chaining so each caller queues behind the previous one.
 * This avoids the race condition where multiple awaiters of the same
 * promise all wake up and proceed past a `while` check simultaneously.
 */
async function withLock<T>(
  lockMap: Map<string, Promise<void>>,
  lockKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Chain behind whatever is currently queued (or resolve immediately)
  const prevLock = lockMap.get(lockKey) ?? Promise.resolve();

  let releaseLock: () => void;
  const myLock = new Promise<void>((resolve) => { releaseLock = resolve; });
  lockMap.set(lockKey, myLock);

  // Wait for the previous holder to finish
  await prevLock;

  try {
    return await operation();
  } finally {
    releaseLock!();
    // Only clean up if we're still the tail of the chain
    if (lockMap.get(lockKey) === myLock) {
      lockMap.delete(lockKey);
    }
  }
}

/**
 * Serialize concurrent writes to the same file.
 *
 * @param lockKey - Unique key for the lock (typically the file path)
 * @param operation - Async operation to run while holding the lock
 * @returns The result of the operation
 */
export async function withFileLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  return withLock(fileLocks, lockKey, operation);
}

/**
 * Serialize read-modify-write cycles on a logical resource.
 *
 * Uses a separate lock map from {@link withFileLock} so that callers
 * can hold an operation lock across a read + write without deadlocking
 * on the inner file lock.
 *
 * @param lockKey - Unique key for the lock
 * @param operation - Async operation to run while holding the lock
 * @returns The result of the operation
 */
export async function withOperationLock<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
  return withLock(operationLocks, lockKey, operation);
}

// ──────────────────────────────────────────────────────────────────────
//  Atomic write
// ──────────────────────────────────────────────────────────────────────

/**
 * Write a string to a file atomically (temp file → fsync → rename).
 *
 * Acquires a per-path file lock so concurrent callers targeting the
 * same path are serialized.
 *
 * **Precondition:** The parent directory must already exist. This function
 * does not create intermediate directories — use {@link ensureDir} first
 * if the directory may not exist.
 *
 * @param filePath - Destination file path
 * @param content - String content to write
 */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await withFileLock(filePath, async () => {
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2)}`;

    try {
      await fs.writeFile(tempPath, content, 'utf8');

      // Ensure data hits the disk before the atomic rename
      const handle = await fs.open(tempPath, 'r+');
      await handle.sync();
      await handle.close();

      try {
        await fs.rename(tempPath, filePath);
      } catch (renameError: unknown) {
        // #265: If rename fails with ENOENT, ensure parent dir exists and retry
        if (renameError instanceof Error && 'code' in renameError && (renameError as NodeJS.ErrnoException).code === 'ENOENT') {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.rename(tempPath, filePath);
        } else {
          throw renameError;
        }
      }
    } catch (error) {
      // Clean up temp file on failure
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  });
}

/**
 * Serialize a JavaScript value to JSON and write it atomically.
 *
 * @param filePath - Destination file path
 * @param data - Value to serialize (via `JSON.stringify`)
 */
export async function atomicWriteJson<T>(filePath: string, data: T): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2));
}

// ──────────────────────────────────────────────────────────────────────
//  Safe read
// ──────────────────────────────────────────────────────────────────────

/**
 * Read and parse a JSON file safely.
 *
 * - On `ENOENT` → returns `defaultValue` silently.
 * - On parse error → backs up the corrupt file as `<path>.corrupt.<ts>`
 *   and returns `defaultValue`.
 *
 * @param filePath - Path to the JSON file
 * @param defaultValue - Value to return when the file is missing or corrupt
 * @param logger - Optional logger for warnings on corruption
 * @returns Parsed value or `defaultValue`
 */
export async function safeReadJson<T>(filePath: string, defaultValue: T, logger?: FileIOLogger): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    // File does not exist — totally normal, return default
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultValue;
    }
    throw error; // Permission errors etc. should bubble
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt JSON — back up the file so we can debug later
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await fs.copyFile(filePath, backupPath);
      logger?.warn('Backed up corrupt JSON file', { filePath, backupPath });
    } catch {
      logger?.warn('Failed to back up corrupt JSON file', { filePath });
    }
    return defaultValue;
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Read-modify-write helper
// ──────────────────────────────────────────────────────────────────────

/**
 * Locked read → mutate → atomic write cycle.
 *
 * This is the most common persistence pattern: load a JSON file,
 * apply a mutation, and write it back atomically — all while holding
 * an operation lock to prevent concurrent read-modify-write races.
 *
 * **Important:** If the mutator returns `undefined` (void), the mutated
 * `data` object is written back. If it returns any other value — including
 * falsy values like `null`, `0`, or `false` — that value is written instead.
 * Beware of methods like `Array.push()` which return a number: an accidental
 * `return records.push(item)` will write the array length to the file.
 *
 * @param filePath - Path to the JSON file
 * @param defaultValue - Value to use if the file is missing or corrupt
 * @param mutator - Function that receives the current data and mutates it in place (or returns new data)
 * @param logger - Optional logger
 * @returns The value returned by `mutator` (or void)
 */
export async function modifyJsonFile<T, R = void>(
  filePath: string,
  defaultValue: T,
  mutator: (data: T) => R | Promise<R>,
  logger?: FileIOLogger,
): Promise<R> {
  return withOperationLock(filePath, async () => {
    const data = await safeReadJson(filePath, defaultValue, logger);
    const result = await mutator(data);
    // If mutator returns undefined (void), write the mutated data in place;
    // otherwise write the returned value (including null, 0, false, etc.)
    const toWrite = result === undefined ? data : result;
    await atomicWriteJson(filePath, toWrite);
    return result;
  });
}

// ──────────────────────────────────────────────────────────────────────
//  Test helper
// ──────────────────────────────────────────────────────────────────────

/**
 * Reset all lock maps. **Test-only** — never call in production.
 */
export function _clearAllLocks(): void {
  fileLocks.clear();
  operationLocks.clear();
}
