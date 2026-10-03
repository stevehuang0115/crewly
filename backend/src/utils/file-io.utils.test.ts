/**
 * Tests for the centralized file I/O utility module.
 *
 * @module utils/file-io.utils.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, mkdirSync, rmSync } from 'fs';
import {
  atomicWriteFile,
  atomicWriteJson,
  safeReadJson,
  withFileLock,
  withOperationLock,
  modifyJsonFile,
  ensureDir,
  _clearAllLocks,
  atomicWriteFileSync,
  readJsonStore,
  readJsonStoreSync,
  quarantinePathFor,
  CorruptJsonFileError,
} from './file-io.utils.js';
import fsSync from 'fs';

/** The real fs/promises object (the namespace import above is not spyable). */
const fsp = fsSync.promises;

// ─── Helpers ────────────────────────────────────────────────────────

const TEST_DIR = path.join(__dirname, '__test-file-io__');

function testPath(name: string): string {
  return path.join(TEST_DIR, name);
}

// ─── Setup / Teardown ──────────────────────────────────────────────

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  _clearAllLocks();
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ─── ensureDir ─────────────────────────────────────────────────────

describe('ensureDir', () => {
  it('creates a directory recursively', async () => {
    const dir = testPath('ensure/deep/nested');
    await ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
  });

  it('is a no-op if the directory already exists', async () => {
    const dir = testPath('ensure/deep/nested');
    await ensureDir(dir); // should not throw
    expect(existsSync(dir)).toBe(true);
  });
});

// ─── atomicWriteFile ───────────────────────────────────────────────

describe('atomicWriteFile', () => {
  it('writes content to the target file', async () => {
    const fp = testPath('atomic-write.txt');
    await atomicWriteFile(fp, 'hello world');
    const content = await fs.readFile(fp, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('overwrites existing content', async () => {
    const fp = testPath('atomic-overwrite.txt');
    await atomicWriteFile(fp, 'first');
    await atomicWriteFile(fp, 'second');
    const content = await fs.readFile(fp, 'utf-8');
    expect(content).toBe('second');
  });

  it('does not leave temp files on success', async () => {
    const fp = testPath('no-temp.txt');
    await atomicWriteFile(fp, 'data');
    const files = await fs.readdir(TEST_DIR);
    const temps = files.filter((f) => f.startsWith('no-temp.txt.tmp'));
    expect(temps).toHaveLength(0);
  });

  it('works when parent directory is pre-created with ensureDir', async () => {
    const dir = testPath('deep/nested/dir');
    await ensureDir(dir);
    const fp = path.join(dir, 'write.txt');
    await atomicWriteFile(fp, 'nested content');
    const content = await fs.readFile(fp, 'utf-8');
    expect(content).toBe('nested content');
  });

  it('serializes concurrent writes to the same path', async () => {
    const fp = testPath('concurrent-write.txt');
    const results: string[] = [];

    // Launch 5 concurrent writes
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        atomicWriteFile(fp, `write-${i}`).then(() => results.push(`done-${i}`))
      )
    );

    // File should contain one of the writes (the last to complete)
    const content = await fs.readFile(fp, 'utf-8');
    expect(content).toMatch(/^write-\d$/);
    // All 5 should have completed
    expect(results).toHaveLength(5);
  });
});

// ─── atomicWriteJson ───────────────────────────────────────────────

describe('atomicWriteJson', () => {
  it('writes formatted JSON', async () => {
    const fp = testPath('json-write.json');
    await atomicWriteJson(fp, { key: 'value', num: 42 });
    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual({ key: 'value', num: 42 });
    // Verify pretty-printed (2-space indent)
    expect(content).toContain('  "key"');
  });

  it('writes arrays', async () => {
    const fp = testPath('json-array.json');
    await atomicWriteJson(fp, [1, 2, 3]);
    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual([1, 2, 3]);
  });
});

// ─── safeReadJson ──────────────────────────────────────────────────

describe('safeReadJson', () => {
  it('reads and parses a valid JSON file', async () => {
    const fp = testPath('safe-read-valid.json');
    await fs.writeFile(fp, '{"a":1}');
    const result = await safeReadJson(fp, { a: 0 });
    expect(result).toEqual({ a: 1 });
  });

  it('returns defaultValue when file does not exist', async () => {
    const fp = testPath('does-not-exist.json');
    const result = await safeReadJson(fp, { fallback: true });
    expect(result).toEqual({ fallback: true });
  });

  it('returns defaultValue and backs up corrupt file', async () => {
    const fp = testPath('corrupt.json');
    await fs.writeFile(fp, '{not valid json!!!');

    const mockLogger = { warn: jest.fn() };
    const result = await safeReadJson(fp, [], mockLogger);

    expect(result).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Backed up corrupt JSON file',
      expect.objectContaining({ filePath: fp })
    );

    // Verify backup file exists
    const files = await fs.readdir(TEST_DIR);
    const backups = files.filter((f) => f.startsWith('corrupt.json.corrupt.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('returns null defaultValue for nullable reads', async () => {
    const fp = testPath('nullable-missing.json');
    const result = await safeReadJson<{ x: number } | null>(fp, null);
    expect(result).toBeNull();
  });

  it('handles corrupt file silently when no logger is provided', async () => {
    const fp = testPath('corrupt-no-logger.json');
    await fs.writeFile(fp, '<<invalid>>');

    // Should not throw, even without a logger
    const result = await safeReadJson(fp, { safe: true });
    expect(result).toEqual({ safe: true });
  });

  it('handles empty JSON object file', async () => {
    const fp = testPath('empty-object.json');
    await fs.writeFile(fp, '{}');

    const result = await safeReadJson(fp, { fallback: true });
    expect(result).toEqual({});
  });

  it('handles JSON null literal', async () => {
    const fp = testPath('json-null.json');
    await fs.writeFile(fp, 'null');

    const result = await safeReadJson(fp, { fallback: true });
    expect(result).toBeNull();
  });
});

// ─── withFileLock ──────────────────────────────────────────────────

describe('withFileLock', () => {
  it('returns the result of the operation', async () => {
    const result = await withFileLock('test-key', async () => 42);
    expect(result).toBe(42);
  });

  it('serializes concurrent operations on the same key', async () => {
    const order: number[] = [];

    const op = (id: number, delay: number) =>
      withFileLock('same-key', async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, delay));
        order.push(id * 10);
      });

    await Promise.all([op(1, 20), op(2, 10), op(3, 5)]);

    // Operations should not interleave: each start-end pair should be adjacent
    // e.g., [1, 10, 2, 20, 3, 30] — never [1, 2, 10, ...]
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i + 1]).toBe(order[i] * 10);
    }
  });

  it('allows concurrent operations on different keys', async () => {
    const running: Set<string> = new Set();
    let maxConcurrent = 0;

    const op = (key: string) =>
      withFileLock(key, async () => {
        running.add(key);
        maxConcurrent = Math.max(maxConcurrent, running.size);
        await new Promise((r) => setTimeout(r, 20));
        running.delete(key);
      });

    await Promise.all([op('a'), op('b'), op('c')]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('releases lock even when operation throws', async () => {
    const key = 'throw-key';

    await expect(
      withFileLock(key, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Lock should be released — next operation should succeed immediately
    const result = await withFileLock(key, async () => 'ok');
    expect(result).toBe('ok');
  });
});

// ─── withOperationLock ─────────────────────────────────────────────

describe('withOperationLock', () => {
  it('serializes operations on the same key', async () => {
    const order: number[] = [];

    const op = (id: number) =>
      withOperationLock('op-key', async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 10));
        order.push(id * 10);
      });

    await Promise.all([op(1), op(2)]);

    // Should not interleave
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i + 1]).toBe(order[i] * 10);
    }
  });

  it('releases lock even when operation throws', async () => {
    const key = 'op-throw-key';

    await expect(
      withOperationLock(key, async () => {
        throw new Error('op-boom');
      })
    ).rejects.toThrow('op-boom');

    // Lock should be released — next operation should succeed
    const result = await withOperationLock(key, async () => 'recovered');
    expect(result).toBe('recovered');
  });
});

// ─── modifyJsonFile ────────────────────────────────────────────────

describe('modifyJsonFile', () => {
  it('creates file from default when missing, applies mutation, writes result', async () => {
    const fp = testPath('modify-new.json');

    await modifyJsonFile(fp, { count: 0 }, (data) => {
      data.count = 1;
    });

    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual({ count: 1 });
  });

  it('reads existing file, applies mutation, writes result', async () => {
    const fp = testPath('modify-existing.json');
    await atomicWriteJson(fp, { items: ['a'] });

    await modifyJsonFile(fp, { items: [] as string[] }, (data) => {
      data.items.push('b');
    });

    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual({ items: ['a', 'b'] });
  });

  it('returns the value from the mutator', async () => {
    const fp = testPath('modify-return.json');
    await atomicWriteJson(fp, { x: 5 });

    const result = await modifyJsonFile(fp, { x: 0 }, (data) => {
      return data.x * 2;
    });

    expect(result).toBe(10);
  });

  it('writes the returned object when mutator returns a new value', async () => {
    const fp = testPath('modify-return-new.json');
    await atomicWriteJson(fp, { old: true });

    const result = await modifyJsonFile(fp, { old: true }, () => {
      // Return a completely new object instead of mutating in place
      return { replaced: true };
    });

    expect(result).toEqual({ replaced: true });
    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual({ replaced: true });
  });

  it('propagates error and releases lock when mutator throws', async () => {
    const fp = testPath('modify-throw.json');
    await atomicWriteJson(fp, { safe: true });

    await expect(
      modifyJsonFile(fp, { safe: true }, () => {
        throw new Error('mutator-failed');
      })
    ).rejects.toThrow('mutator-failed');

    // Original file should be unchanged
    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual({ safe: true });

    // Lock should be released — next operation should succeed
    await modifyJsonFile(fp, { safe: true }, (data) => {
      (data as Record<string, unknown>).recovered = true;
    });
    const after = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(after)).toEqual({ safe: true, recovered: true });
  });

  it('serializes concurrent modifications', async () => {
    const fp = testPath('modify-concurrent.json');
    await atomicWriteJson(fp, { count: 0 });

    // Run 5 concurrent increments
    await Promise.all(
      Array.from({ length: 5 }, () =>
        modifyJsonFile(fp, { count: 0 }, (data) => {
          data.count += 1;
        })
      )
    );

    const content = await fs.readFile(fp, 'utf-8');
    expect(JSON.parse(content)).toEqual({ count: 5 });
  });
});


// ─── Disk full (ENOSPC) and corrupt-store quarantine ───────────────
// specs/2026-10-03-usage-ledger-durability.md

/**
 * A real ENOSPC: the write truncates the target, gets part of the data
 * out, then fails.
 */
function enospc(): NodeJS.ErrnoException {
  const err = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
  err.code = 'ENOSPC';
  return err;
}

describe('atomic writes on a full disk', () => {
  afterEach(() => jest.restoreAllMocks());

  it('atomicWriteFile keeps the old file and leaves no temp file when the disk is full', async () => {
    const fp = testPath('enospc-async.json');
    await fs.writeFile(fp, JSON.stringify({ history: 'big' }));
    const realWrite = fsp.writeFile.bind(fsp);
    jest.spyOn(fsp, 'writeFile').mockImplementation(async (file, data) => {
      await realWrite(file as string, String(data).slice(0, 3));
      throw enospc();
    });

    await expect(atomicWriteFile(fp, JSON.stringify({ history: 'new' }))).rejects.toMatchObject({ code: 'ENOSPC' });

    jest.restoreAllMocks();
    expect(JSON.parse(await fs.readFile(fp, 'utf-8'))).toEqual({ history: 'big' });
    expect((await fs.readdir(TEST_DIR)).filter((f) => f.startsWith('enospc-async.json.tmp'))).toEqual([]);
  });

  it('atomicWriteFileSync writes, and on ENOSPC keeps the old file and removes the temp file', () => {
    const fp = testPath('enospc-sync.json');
    atomicWriteFileSync(fp, '{"v":1}');
    expect(fsSync.readFileSync(fp, 'utf-8')).toBe('{"v":1}');

    jest.spyOn(fsSync, 'writeFileSync').mockImplementation(() => {
      throw enospc();
    });
    expect(() => atomicWriteFileSync(fp, '{"v":2}')).toThrow(/ENOSPC/);
    jest.restoreAllMocks();

    expect(fsSync.readFileSync(fp, 'utf-8')).toBe('{"v":1}');
    expect(fsSync.readdirSync(TEST_DIR).filter((f) => f.startsWith('enospc-sync.json.tmp'))).toEqual([]);
  });
});

describe('readJsonStore / readJsonStoreSync', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports a missing file as missing (start fresh)', async () => {
    expect(await readJsonStore(testPath('store-missing.json'))).toEqual({ status: 'missing' });
    expect(readJsonStoreSync(testPath('store-missing.json'))).toEqual({ status: 'missing' });
  });

  it('returns the data of a good file', async () => {
    const fp = testPath('store-ok.json');
    await fs.writeFile(fp, '[1,2]');
    expect(await readJsonStore(fp)).toEqual({ status: 'ok', data: [1, 2] });
    expect(readJsonStoreSync(fp)).toEqual({ status: 'ok', data: [1, 2] });
  });

  it('copies a truncated file aside as <file>.corrupt-<ts> and logs an error', async () => {
    const fp = testPath('store-truncated.json');
    await fs.writeFile(fp, '[{"sessionName":"a","eve');
    const logger = { warn: jest.fn(), error: jest.fn() };

    const read = await readJsonStore(fp, { logger });

    expect(read.status).toBe('quarantined');
    const aside = (read as { quarantinedTo: string }).quarantinedTo;
    expect(aside).toMatch(/store-truncated\.json\.corrupt-\d{4}-\d{2}-\d{2}T/);
    expect(await fs.readFile(aside, 'utf-8')).toBe('[{"sessionName":"a","eve');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('copied aside'), expect.objectContaining({ filePath: fp }));
  });

  it('quarantines a file the validator rejects', () => {
    const fp = testPath('store-shape.json');
    fsSync.writeFileSync(fp, '{"not":"an array"}');
    const read = readJsonStoreSync(fp, { validate: (d) => (Array.isArray(d) ? null : 'not an array') });
    expect(read).toMatchObject({ status: 'quarantined', reason: 'not an array' });
  });

  it('throws CorruptJsonFileError (so nothing overwrites the file) when the copy fails', async () => {
    const fp = testPath('store-nocopy.json');
    await fs.writeFile(fp, '{broken');
    jest.spyOn(fsp, 'copyFile').mockRejectedValue(enospc());
    await expect(readJsonStore(fp)).rejects.toBeInstanceOf(CorruptJsonFileError);

    jest.spyOn(fsSync, 'copyFileSync').mockImplementation(() => {
      throw enospc();
    });
    expect(() => readJsonStoreSync(fp)).toThrow(CorruptJsonFileError);
    jest.restoreAllMocks();
    expect(await fs.readFile(fp, 'utf-8')).toBe('{broken');
  });

  it('names quarantine files with a filesystem-safe timestamp', () => {
    expect(quarantinePathFor('/x/token-usage.json', new Date('2026-10-03T12:34:56.789Z'))).toBe(
      '/x/token-usage.json.corrupt-2026-10-03T12-34-56-789Z',
    );
  });
});

describe('safeReadJson when the backup itself fails', () => {
  afterEach(() => jest.restoreAllMocks());

  it('throws instead of returning the default the caller would write over the file', async () => {
    const fp = testPath('safe-nobackup.json');
    await fs.writeFile(fp, '{trunc');
    jest.spyOn(fsp, 'copyFile').mockRejectedValue(enospc());

    await expect(safeReadJson(fp, { fresh: true })).rejects.toBeInstanceOf(CorruptJsonFileError);
    await expect(modifyJsonFile(fp, { n: 0 }, (d) => { d.n = 1; })).rejects.toBeInstanceOf(CorruptJsonFileError);

    jest.restoreAllMocks();
    expect(await fs.readFile(fp, 'utf-8')).toBe('{trunc');
  });
});
