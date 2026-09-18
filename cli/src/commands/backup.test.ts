/**
 * Tests for the `crewly backup` CLI command (P0: create).
 */

// chalk is ESM-only and not transformed by the CLI jest setup — mock it
// (mirrors the other CLI command tests, e.g. service.test.ts).
jest.mock('chalk', () => ({
  __esModule: true,
  default: new Proxy(
    {},
    {
      get: () => {
        const fn = (s: string) => s;
        return new Proxy(fn, {
          get: () => fn,
          apply: (_t: unknown, _this: unknown, args: string[]) => args[0],
        });
      },
    },
  ),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { backupCommand, backupCommandAndExit } from './backup.js';
import { CloudClientService } from '../../../backend/src/services/cloud/cloud-client.service.js';

let home: string;
let outFile: string;
let logSpy: jest.SpyInstance;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.CREWLY_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-home-'));
  process.env.CREWLY_HOME = home;
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
  fs.writeFileSync(path.join(home, 'projects.json'), '[]', 'utf8');
  outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-out-')), 'wb.tar.gz');
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  // getConfigPath() uses os.homedir() (the REAL ~/.crewly/cloud/config.json) —
  // point it at the temp home so cloud tests never read real creds or hit the
  // network.
  jest.spyOn(CloudClientService, 'getConfigPath').mockReturnValue(path.join(home, 'cloud', 'config.json'));
});

afterEach(() => {
  jest.restoreAllMocks();
  logSpy.mockRestore();
  if (prevHome === undefined) delete process.env.CREWLY_HOME;
  else process.env.CREWLY_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

describe('backupCommand', () => {
  it('create builds an archive at --out', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    expect(fs.existsSync(outFile)).toBe(true);
    expect(fs.statSync(outFile).size).toBeGreaterThan(0);
  });

  it('unknown action sets a non-zero exit code', async () => {
    process.exitCode = 0;
    await backupCommand('totally-unknown');
    expect(process.exitCode).toBe(1);
  });

  it('push/list without a cloud connection report not-connected (exit 1, no throw)', async () => {
    // CREWLY_HOME (temp) has no cloud/config.json → not connected.
    process.exitCode = 0;
    await expect(backupCommand('push', undefined, {})).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await expect(backupCommand('list', undefined, {})).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
  });

  it('pull without an id sets a non-zero exit code', async () => {
    process.exitCode = 0;
    await backupCommand('pull', undefined, {});
    expect(process.exitCode).toBe(1);
  });

  it('restore without a file sets a non-zero exit code', async () => {
    process.exitCode = 0;
    await backupCommand('restore', undefined, {});
    expect(process.exitCode).toBe(1);
  });

  it('restore dry-run previews without writing; --apply restores + snapshots', async () => {
    // Build an archive from this home, then restore it back.
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    const backupsDir = path.join(home, 'backups');

    // Dry-run: no pre-restore snapshot is created.
    await backupCommand('restore', outFile, {});
    const afterDryRun = fs.existsSync(backupsDir)
      ? fs.readdirSync(backupsDir).filter((d) => d.startsWith('pre-restore-'))
      : [];
    expect(afterDryRun).toHaveLength(0);

    // Apply: a pre-restore snapshot dir appears.
    await backupCommand('restore', outFile, { apply: true, mode: 'overwrite' });
    const afterApply = fs.readdirSync(backupsDir).filter((d) => d.startsWith('pre-restore-'));
    expect(afterApply.length).toBeGreaterThanOrEqual(1);
  });
});

describe('backupCommandAndExit (item 27: the process must end)', () => {
  /** Ref'd timers currently registered with the event loop. */
  const refdTimers = (): unknown[] =>
    (process as unknown as { _getActiveHandles(): Array<{ constructor: { name: string }; hasRef?: () => boolean }> })
      ._getActiveHandles()
      .filter((h) => h.constructor.name === 'Timeout' && h.hasRef?.() === true);

  it('create resolves, leaves no new ref\'d timers behind, and exits 0', async () => {
    const before = new Set(refdTimers());
    const exit = jest.fn();
    await backupCommandAndExit('create', undefined, { out: outFile, chatDb: false }, exit);
    expect(exit).toHaveBeenCalledWith(0);
    const leaked = refdTimers().filter((t) => !before.has(t));
    expect(leaked).toEqual([]);
  });

  it('restore --apply resolves and exits 0', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    const exit = jest.fn();
    await backupCommandAndExit('restore', outFile, { apply: true, mode: 'overwrite' }, exit);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('propagates a non-zero exit code', async () => {
    const exit = jest.fn();
    await backupCommandAndExit('restore', undefined, {}, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('turns a thrown error into exit 1 with a printed message', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exit = jest.fn();
    await backupCommandAndExit('restore', path.join(home, 'missing.tar.gz'), { apply: true }, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.map((c) => c[0]).join('\n')).toContain('Backup restore failed');
    errSpy.mockRestore();
  });
});
