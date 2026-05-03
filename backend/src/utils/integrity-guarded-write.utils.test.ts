/**
 * Integrity-Guarded Atomic Write Utility Tests
 *
 * Covers the four critical decision branches called out in the
 * Persistence Fix spec §7.1 (A1):
 *  - first-ever write (no prior file) succeeds
 *  - prior count > 0, next count === 0 → rejected
 *  - decrease > maxDecreasePct → rejected
 *  - allowExplicitDelete bypasses both guards
 *  - countOf works for non-array (object/dict-shaped) state
 *  - corrupted prior file does NOT block recovery write
 *
 * @module utils/integrity-guarded-write.utils.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { mkdirSync, rmSync, existsSync } from 'fs';
import {
  atomicWriteJsonWithGuard,
  IntegrityViolationError,
} from './integrity-guarded-write.utils.js';

jest.mock('../services/core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

describe('atomicWriteJsonWithGuard', () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `integrity-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    testFile = path.join(testDir, 'state.json');
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('first-ever write', () => {
    it('writes successfully when no prior file exists', async () => {
      await atomicWriteJsonWithGuard(testFile, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toHaveLength(3);
    });

    it('writes successfully when next is an empty array (no prior)', async () => {
      // Empty-to-empty is fine (this is the legit "fresh install" case)
      await atomicWriteJsonWithGuard(testFile, []);

      expect(existsSync(testFile)).toBe(true);
      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toEqual([]);
    });
  });

  describe('collapse-to-empty guard', () => {
    it('rejects write when prior has items and next is empty', async () => {
      await atomicWriteJsonWithGuard(testFile, [{ id: 'a' }, { id: 'b' }]);

      await expect(
        atomicWriteJsonWithGuard(testFile, []),
      ).rejects.toThrow(IntegrityViolationError);
    });

    it('attaches diagnostic metadata to the rejection', async () => {
      await atomicWriteJsonWithGuard(testFile, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

      try {
        await atomicWriteJsonWithGuard(testFile, []);
        fail('Expected IntegrityViolationError');
      } catch (err) {
        expect(err).toBeInstanceOf(IntegrityViolationError);
        const violation = err as IntegrityViolationError;
        expect(violation.reason).toBe('collapse-to-empty');
        expect(violation.prevCount).toBe(3);
        expect(violation.nextCount).toBe(0);
        expect(violation.path).toBe(testFile);
      }
    });

    it('preserves the prior file content when the write is rejected', async () => {
      await atomicWriteJsonWithGuard(testFile, [{ id: 'a' }, { id: 'b' }]);

      await expect(atomicWriteJsonWithGuard(testFile, [])).rejects.toThrow();

      // Prior content untouched
      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toHaveLength(2);
    });
  });

  describe('decrease-exceeds-threshold guard', () => {
    it('rejects 60% drop with default 50% threshold', async () => {
      await atomicWriteJsonWithGuard(
        testFile,
        Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })),
      );

      await expect(
        atomicWriteJsonWithGuard(
          testFile,
          Array.from({ length: 4 }, (_, i) => ({ id: `t${i}` })),
        ),
      ).rejects.toThrow(IntegrityViolationError);
    });

    it('allows 40% drop with default 50% threshold (under the limit)', async () => {
      await atomicWriteJsonWithGuard(
        testFile,
        Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })),
      );

      // 10 → 6 = 40% decrease, within 50% threshold
      await atomicWriteJsonWithGuard(
        testFile,
        Array.from({ length: 6 }, (_, i) => ({ id: `t${i}` })),
      );

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toHaveLength(6);
    });

    it('allows any decrease when maxDecreasePct: 100', async () => {
      await atomicWriteJsonWithGuard(
        testFile,
        Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })),
      );

      // Without collapse-to-empty (1 item), should pass at 100%
      await atomicWriteJsonWithGuard(testFile, [{ id: 'last' }], { maxDecreasePct: 100 });

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toHaveLength(1);
    });

    it('rejection carries reason: decrease-exceeds-threshold', async () => {
      await atomicWriteJsonWithGuard(
        testFile,
        Array.from({ length: 10 }, (_, i) => ({ id: `t${i}` })),
      );

      try {
        await atomicWriteJsonWithGuard(
          testFile,
          Array.from({ length: 2 }, (_, i) => ({ id: `t${i}` })),
        );
        fail('Expected IntegrityViolationError');
      } catch (err) {
        expect(err).toBeInstanceOf(IntegrityViolationError);
        expect((err as IntegrityViolationError).reason).toBe('decrease-exceeds-threshold');
      }
    });
  });

  describe('allowExplicitDelete bypass', () => {
    it('allows collapse-to-empty when explicitly opted in', async () => {
      await atomicWriteJsonWithGuard(testFile, [{ id: 'a' }, { id: 'b' }]);
      await atomicWriteJsonWithGuard(testFile, [], { allowExplicitDelete: true });

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toEqual([]);
    });

    it('allows large decrease when explicitly opted in', async () => {
      await atomicWriteJsonWithGuard(
        testFile,
        Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` })),
      );
      await atomicWriteJsonWithGuard(testFile, [{ id: 'survivor' }], { allowExplicitDelete: true });

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toHaveLength(1);
    });
  });

  describe('countOf customization', () => {
    it('works with non-array dict-shaped state', async () => {
      // For a dict like { teams: [...], orchestrator: {...} } we count via teams
      type DictState = { teams: Array<{ id: string }>; orchestrator: { name: string } };
      const countTeams = (d: DictState) => d.teams.length;

      await atomicWriteJsonWithGuard<DictState>(
        testFile,
        { teams: [{ id: 'a' }, { id: 'b' }], orchestrator: { name: 'orc' } },
        { countOf: countTeams },
      );

      await expect(
        atomicWriteJsonWithGuard<DictState>(
          testFile,
          { teams: [], orchestrator: { name: 'orc' } },
          { countOf: countTeams },
        ),
      ).rejects.toThrow(IntegrityViolationError);
    });

    it('default countOf returns 0 for non-arrays (no guard fires for object→object)', async () => {
      // First write: object (defaultCountOf → 0)
      await atomicWriteJsonWithGuard(testFile, { foo: 'bar' });
      // Second write: also object → no decrease detected
      await atomicWriteJsonWithGuard(testFile, { foo: 'baz' });

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toEqual({ foo: 'baz' });
    });
  });

  describe('corrupted prior file', () => {
    it('proceeds with the write when prior file is unparseable', async () => {
      // Create a corrupted prior file
      await fs.writeFile(testFile, 'this is not json {{{', 'utf-8');

      // Recovery write should not throw — the guard treats prevCount as null
      await atomicWriteJsonWithGuard(testFile, [{ id: 'recovered' }]);

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toEqual([{ id: 'recovered' }]);
    });

    it('proceeds with the write when prior file is empty', async () => {
      await fs.writeFile(testFile, '', 'utf-8');

      await atomicWriteJsonWithGuard(testFile, [{ id: 'fresh' }]);

      const content = JSON.parse(await fs.readFile(testFile, 'utf-8'));
      expect(content).toEqual([{ id: 'fresh' }]);
    });
  });

  describe('IntegrityViolationError', () => {
    it('is a subclass of Error with correct name', () => {
      const err = new IntegrityViolationError('test', {
        path: '/tmp/x',
        prevCount: 5,
        nextCount: 0,
        reason: 'collapse-to-empty',
      });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('IntegrityViolationError');
      expect(err.message).toBe('test');
      expect(err.prevCount).toBe(5);
      expect(err.nextCount).toBe(0);
      expect(err.reason).toBe('collapse-to-empty');
    });
  });
});
