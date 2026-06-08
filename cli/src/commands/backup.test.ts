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
import { backupCommand } from './backup.js';

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
});

afterEach(() => {
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

  it('not-yet-implemented actions report gracefully without throwing', async () => {
    await expect(backupCommand('push')).resolves.toBeUndefined();
    await expect(backupCommand('list')).resolves.toBeUndefined();
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
