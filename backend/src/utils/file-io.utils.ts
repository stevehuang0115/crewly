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
import * as fsSync from 'fs';
import * as path from 'path';

/**
 * Minimal logger interface accepted by safeReadJson / modifyJsonFile.
 * Compatible with ComponentLogger from LoggerService.
 */
export interface FileIOLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

/**
 * A JSON store file exists but cannot be read or parsed, AND it could not be
 * copied aside. The caller must not overwrite it: that would destroy the only
 * copy of whatever it still holds (the 2026-10-03 token-ledger loss).
 */
export class CorruptJsonFileError extends Error {
  /** The store file that is bad */
  readonly filePath: string;
  /** Why it could not be used (parse or read error) */
  readonly reason: string;

  /**
   * @param filePath - The bad store file
   * @param reason - Parse / read error text
   * @param copyError - Why copying it aside failed
   */
  constructor(filePath: string, reason: string, copyError: string) {
    super(`Store file ${filePath} is unreadable (${reason}) and could not be set aside (${copyError}); refusing to overwrite it`);
    this.name = 'CorruptJsonFileError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

/** Result of {@link readJsonStore} / {@link readJsonStoreSync}. */
export type JsonStoreRead<T> =
  | { status: 'missing' }
  | { status: 'ok'; data: T }
  | { status: 'quarantined'; quarantinedTo: string; reason: string };

/**
 * Error text of an unknown thrown value.
 *
 * @param err - Thrown value
 * @returns Message
 */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Log at error level when the logger has one, else warn.
 *
 * @param logger - Optional logger
 * @param message - Message
 * @param meta - Metadata
 */
function logError(logger: FileIOLogger | undefined, message: string, meta: Record<string, unknown>): void {
  if (!logger) return;
  if (logger.error) logger.error(message, meta);
  else logger.warn(message, meta);
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

      await fs.rename(tempPath, filePath);
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

/**
 * Synchronous {@link atomicWriteFile} for stores that persist synchronously
 * (temp file in the same directory → fsync → rename).
 *
 * A failure (ENOSPC, EACCES) leaves the destination untouched, removes the
 * temp file and rethrows. No in-process lock: a synchronous call cannot
 * interleave with another one in the same process.
 *
 * **Precondition:** the parent directory must already exist.
 *
 * @param filePath - Destination file path
 * @param content - String content to write
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(2)}`;
  let fd: number | null = null;
  try {
    fd = fsSync.openSync(tempPath, 'w');
    fsSync.writeFileSync(fd, content, 'utf8');
    fsSync.fsyncSync(fd);
    fsSync.closeSync(fd);
    fd = null;
    fsSync.renameSync(tempPath, filePath);
  } catch (error) {
    if (fd !== null) {
      try { fsSync.closeSync(fd); } catch { /* ignore */ }
    }
    try { fsSync.unlinkSync(tempPath); } catch { /* ignore */ }
    throw error;
  }
}

// ──────────────────────────────────────────────────────────────────────
//  Corrupt-store quarantine
// ──────────────────────────────────────────────────────────────────────

/**
 * Where a bad store file is copied: `<file>.corrupt-<ISO timestamp>`
 * (colons and dots replaced so the name is valid everywhere).
 *
 * @param filePath - Store file
 * @param now - Clock (tests)
 * @returns Quarantine path
 */
export function quarantinePathFor(filePath: string, now: Date = new Date()): string {
  return `${filePath}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Copy a store file that cannot be used to `<file>.corrupt-<ts>` and log an
 * error. After this returns, the caller may start empty and overwrite the
 * original.
 *
 * @param filePath - The bad store file
 * @param reason - Why it cannot be used
 * @param logger - Optional logger
 * @returns The quarantine path
 * @throws CorruptJsonFileError when the copy fails — the caller must then NOT
 *   overwrite the original
 */
export async function quarantineCorruptFile(filePath: string, reason: string, logger?: FileIOLogger): Promise<string> {
  const target = quarantinePathFor(filePath);
  try {
    await fs.copyFile(filePath, target);
  } catch (copyErr) {
    logError(logger, 'Store file is unreadable and could not be set aside; it will not be overwritten', {
      filePath, reason, copyError: errText(copyErr),
    });
    throw new CorruptJsonFileError(filePath, reason, errText(copyErr));
  }
  logError(logger, 'Store file was unreadable; copied aside and starting empty', { filePath, quarantinedTo: target, reason });
  return target;
}

/**
 * Synchronous {@link quarantineCorruptFile}.
 *
 * @param filePath - The bad store file
 * @param reason - Why it cannot be used
 * @param logger - Optional logger
 * @returns The quarantine path
 * @throws CorruptJsonFileError when the copy fails
 */
export function quarantineCorruptFileSync(filePath: string, reason: string, logger?: FileIOLogger): string {
  const target = quarantinePathFor(filePath);
  try {
    fsSync.copyFileSync(filePath, target);
  } catch (copyErr) {
    logError(logger, 'Store file is unreadable and could not be set aside; it will not be overwritten', {
      filePath, reason, copyError: errText(copyErr),
    });
    throw new CorruptJsonFileError(filePath, reason, errText(copyErr));
  }
  logError(logger, 'Store file was unreadable; copied aside and starting empty', { filePath, quarantinedTo: target, reason });
  return target;
}

/**
 * Read a JSON store, telling "missing" apart from "bad".
 *
 * - missing (`ENOENT`) → `{ status: 'missing' }` — start fresh;
 * - parses (and passes `validate`) → `{ status: 'ok', data }`;
 * - exists but unreadable, invalid JSON, or rejected by `validate` → copied
 *   to `<file>.corrupt-<ts>`, error logged, `{ status: 'quarantined' }`.
 *
 * @param filePath - Store file
 * @param options.validate - Optional shape check; return an error text to reject
 * @param options.logger - Optional logger
 * @returns What was found
 * @throws CorruptJsonFileError when the file is bad and could not be copied aside
 */
export async function readJsonStore<T>(
  filePath: string,
  options: { validate?: (data: unknown) => string | null; logger?: FileIOLogger } = {},
): Promise<JsonStoreRead<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    const reason = `read failed: ${errText(err)}`;
    return { status: 'quarantined', quarantinedTo: await quarantineCorruptFile(filePath, reason, options.logger), reason };
  }
  const parsed = parseStore(raw, options.validate);
  if (parsed.ok) return { status: 'ok', data: parsed.data as T };
  return { status: 'quarantined', quarantinedTo: await quarantineCorruptFile(filePath, parsed.reason, options.logger), reason: parsed.reason };
}

/**
 * Synchronous {@link readJsonStore}.
 *
 * @param filePath - Store file
 * @param options.validate - Optional shape check; return an error text to reject
 * @param options.logger - Optional logger
 * @returns What was found
 * @throws CorruptJsonFileError when the file is bad and could not be copied aside
 */
export function readJsonStoreSync<T>(
  filePath: string,
  options: { validate?: (data: unknown) => string | null; logger?: FileIOLogger } = {},
): JsonStoreRead<T> {
  let raw: string;
  try {
    raw = fsSync.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    const reason = `read failed: ${errText(err)}`;
    return { status: 'quarantined', quarantinedTo: quarantineCorruptFileSync(filePath, reason, options.logger), reason };
  }
  const parsed = parseStore(raw, options.validate);
  if (parsed.ok) return { status: 'ok', data: parsed.data as T };
  return { status: 'quarantined', quarantinedTo: quarantineCorruptFileSync(filePath, parsed.reason, options.logger), reason: parsed.reason };
}

/**
 * Parse store text and run the optional shape check.
 *
 * @param raw - File text
 * @param validate - Optional shape check
 * @returns Parsed data, or why it was rejected
 */
function parseStore(raw: string, validate?: (data: unknown) => string | null): { ok: true; data: unknown } | { ok: false; reason: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON (${raw.length} bytes): ${errText(err)}` };
  }
  const rejected = validate?.(data) ?? null;
  return rejected ? { ok: false, reason: rejected } : { ok: true, data };
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
 * - If that backup fails (a full disk, permissions) → throws
 *   {@link CorruptJsonFileError}. Returning the default would let the caller
 *   write it over the only copy of the data.
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
  } catch (parseErr) {
    // Corrupt JSON — back up the file before anyone can write over it
    const backupPath = `${filePath}.corrupt.${Date.now()}`;
    try {
      await fs.copyFile(filePath, backupPath);
      logger?.warn('Backed up corrupt JSON file', { filePath, backupPath });
    } catch (copyErr) {
      logError(logger, 'Failed to back up corrupt JSON file; refusing to fall back to the default', { filePath });
      throw new CorruptJsonFileError(filePath, `invalid JSON: ${errText(parseErr)}`, errText(copyErr));
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
