/**
 * Tests for RuntimePidRegistry — the orphan runtime-process reaper (#715).
 *
 * Reap tests spy on `process.kill` so a "verified orphan" is never actually
 * signalled to a real process, and inject a stub cmdline reader so identity
 * verification is deterministic and platform-independent.
 *
 * @module services/session/runtime-pid-registry.service.test
 */

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
  },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RuntimePidRegistry,
  RUNTIME_PID_FILE,
  isPidAlive,
  readProcessCmdline,
} from './runtime-pid-registry.service.js';

/** A process.kill mock: signal 0 = liveness probe over `alive`, others = no-op record. */
function mockProcessKill(alive: Set<number>): jest.SpyInstance {
  return jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (signal === 0) {
      if (alive.has(Math.abs(Number(pid)))) return true;
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
    return true; // SIGKILL etc — recorded by the spy, no real signal sent
  }) as typeof process.kill);
}

describe('RuntimePidRegistry', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pidreg-'));
    file = path.join(dir, RUNTIME_PID_FILE);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe('record / remove / clear', () => {
    it('records spawns with a normalised signature and persists them', () => {
      const reg = RuntimePidRegistry.resetForTesting({ filePath: file });
      reg.record(1234, 's1', 'gemini', ['--yolo']);
      reg.record(5678, 's2', 'claude', ['--dangerously-skip-permissions']);

      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ pid: 1234, sessionName: 's1', signature: 'gemini --yolo' });
    });

    it('replaces a prior record for the same session', () => {
      const reg = RuntimePidRegistry.resetForTesting({ filePath: file });
      reg.record(1234, 's1', 'gemini', ['--yolo']);
      reg.record(9999, 's1', 'gemini', ['--yolo']); // session restarted, new pid

      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(data).toHaveLength(1);
      expect(data[0].pid).toBe(9999);
    });

    it('remove() drops a session record', () => {
      const reg = RuntimePidRegistry.resetForTesting({ filePath: file });
      reg.record(1234, 's1', 'gemini', ['--yolo']);
      reg.record(5678, 's2', 'claude', []);
      reg.remove('s1');

      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(data).toHaveLength(1);
      expect(data[0].sessionName).toBe('s2');
    });

    it('ignores invalid pids (<=1)', () => {
      const reg = RuntimePidRegistry.resetForTesting({ filePath: file });
      reg.record(1, 's1', 'init', []);
      expect(fs.existsSync(file)).toBe(false);
    });
  });

  describe('reapOrphans', () => {
    it('returns 0 on an empty registry', () => {
      const reg = RuntimePidRegistry.resetForTesting({ filePath: file });
      expect(reg.reapOrphans()).toBe(0);
    });

    it('reaps a live PID whose cmdline still matches, and clears the file', () => {
      const reg = RuntimePidRegistry.resetForTesting({
        filePath: file,
        cmdlineReader: (pid) => (pid === 4242 ? 'gemini --yolo' : null),
      });
      reg.record(4242, 'orc', 'gemini', ['--yolo']);
      const killSpy = mockProcessKill(new Set([4242]));

      const reaped = reg.reapOrphans();

      expect(reaped).toBe(1);
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGKILL');
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL'); // process group
      expect(fs.readFileSync(file, 'utf8').trim()).toBe('[]');
    });

    it('does NOT reap when the live cmdline no longer matches (PID reuse)', () => {
      const reg = RuntimePidRegistry.resetForTesting({
        filePath: file,
        cmdlineReader: () => 'nginx: master process', // PID reused by something else
      });
      reg.record(4242, 'orc', 'gemini', ['--yolo']);
      const killSpy = mockProcessKill(new Set([4242]));

      const reaped = reg.reapOrphans();

      expect(reaped).toBe(0);
      expect(killSpy).not.toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('skips dead PIDs', () => {
      const reg = RuntimePidRegistry.resetForTesting({
        filePath: file,
        cmdlineReader: () => 'gemini --yolo',
      });
      reg.record(4242, 'orc', 'gemini', ['--yolo']);
      const killSpy = mockProcessKill(new Set()); // nothing alive

      expect(reg.reapOrphans()).toBe(0);
      expect(killSpy).not.toHaveBeenCalledWith(4242, 'SIGKILL');
    });

    it('reaps only the matching subset across mixed records', () => {
      const reg = RuntimePidRegistry.resetForTesting({
        filePath: file,
        cmdlineReader: (pid) => {
          if (pid === 100) return 'gemini --yolo'; // match → reap
          if (pid === 200) return 'unrelated daemon'; // reused → skip
          return null; // 300 dead/gone → skip
        },
      });
      reg.record(100, 'a', 'gemini', ['--yolo']);
      reg.record(200, 'b', 'gemini', ['--yolo']);
      reg.record(300, 'c', 'gemini', ['--yolo']);
      const killSpy = mockProcessKill(new Set([100, 200])); // 300 dead

      expect(reg.reapOrphans()).toBe(1);
      expect(killSpy).toHaveBeenCalledWith(100, 'SIGKILL');
      expect(killSpy).not.toHaveBeenCalledWith(200, 'SIGKILL');
    });
  });

  describe('helpers (real OS, no killing)', () => {
    it('isPidAlive is true for the current process, false for a clearly-dead pid', () => {
      expect(isPidAlive(process.pid)).toBe(true);
      expect(isPidAlive(2_000_000_000)).toBe(false);
      expect(isPidAlive(1)).toBe(false); // guarded
    });

    it('readProcessCmdline returns a cmdline for the current process and null for a dead pid', () => {
      expect(readProcessCmdline(process.pid)).toBeTruthy();
      expect(readProcessCmdline(2_000_000_000)).toBeNull();
    });
  });
});
