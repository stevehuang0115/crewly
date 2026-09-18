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
import { BackupArchiveService } from '../../../backend/src/services/backup/backup-archive.service.js';
import { PROJECT_FILES_SIZE_WARN_BYTES } from '../../../backend/src/services/backup/backup.types.js';

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

describe('backupCommand project files (item 26)', () => {
  let proj: string;
  let restoreTarget: string;

  /** All console.log output so far, joined. */
  const output = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-proj-'));
    restoreTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'crewly-restore-'));
    fs.mkdirSync(path.join(proj, '.crewly'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.crewly', 'notes.md'), 'n', 'utf8');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'src', 'a.ts'), 'a', 'utf8');
    fs.mkdirSync(path.join(proj, 'node_modules', 'm'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'node_modules', 'm', 'i.js'), '1', 'utf8');
    fs.writeFileSync(path.join(proj, 'big.log'), 'log', 'utf8');
    fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ id: 'p1', name: 'web', path: proj }]), 'utf8');
  });

  afterEach(() => {
    fs.rmSync(proj, { recursive: true, force: true });
    fs.rmSync(restoreTarget, { recursive: true, force: true });
  });

  it('create without the flag leaves project files out and says how to include them', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    expect(output()).toContain('not included (add --include-project-files)');
  });

  it('create --include-project-files prints sizes, honours --exclude, and restore --map writes the files', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false, includeProjectFiles: true, exclude: ['*.log'] });
    const created = output();
    expect(created).toContain('web (' + proj + ')');
    expect(created).toMatch(/Files\s+\d+ project files/);
    expect(created).toContain('excludes: node_modules, .crewly, .DS_Store, *.log');
    expect(process.exitCode).toBe(0);

    logSpy.mockClear();
    await backupCommand('restore', outFile, { map: [`${proj}=${restoreTarget}`] });
    expect(output()).toContain('archive carries project source files');

    await backupCommand('restore', outFile, { apply: true, mode: 'overwrite', map: [`${proj}=${restoreTarget}`] });
    expect(fs.readFileSync(path.join(restoreTarget, 'src', 'a.ts'), 'utf8')).toBe('a');
    expect(fs.existsSync(path.join(restoreTarget, 'big.log'))).toBe(false);
    expect(fs.existsSync(path.join(restoreTarget, 'node_modules'))).toBe(false);
    expect(fs.readFileSync(path.join(restoreTarget, '.crewly', 'notes.md'), 'utf8')).toBe('n');
    expect(output()).toMatch(/Files\s+1 project files/);
  });

  it('restore refuses a non-empty mapped target in abort mode (exit 1), overwrite proceeds', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false, includeProjectFiles: true });
    fs.writeFileSync(path.join(restoreTarget, 'other.txt'), 'x', 'utf8');

    process.exitCode = 0;
    await backupCommand('restore', outFile, { apply: true, map: [`${proj}=${restoreTarget}`] });
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('non-empty');
    expect(fs.existsSync(path.join(restoreTarget, 'src', 'a.ts'))).toBe(false);

    process.exitCode = 0;
    await backupCommand('restore', outFile, { apply: true, mode: 'overwrite', map: [`${proj}=${restoreTarget}`] });
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(path.join(restoreTarget, 'src', 'a.ts'))).toBe(true);
  });

  it('warns and stops above the 2 GB threshold unless --yes', async () => {
    const huge = PROJECT_FILES_SIZE_WARN_BYTES + 1;
    const estimateSpy = jest
      .spyOn(BackupArchiveService.prototype, 'estimateProjectFiles')
      .mockResolvedValue([{ id: 'p1', name: 'web', path: proj, bytes: huge, fileCount: 1 }]);

    process.exitCode = 0;
    await backupCommand('create', undefined, { out: outFile, chatDb: false, includeProjectFiles: true });
    expect(process.exitCode).toBe(1);
    expect(output()).toContain('above the 2.0 GB warning threshold');
    expect(output()).toContain('--yes');
    expect(fs.existsSync(outFile)).toBe(false);

    process.exitCode = 0;
    logSpy.mockClear();
    await backupCommand('create', undefined, { out: outFile, chatDb: false, includeProjectFiles: true, yes: true });
    expect(process.exitCode).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
    expect(estimateSpy).toHaveBeenCalledTimes(2);
  });
});

describe('backupCommand Slack ownership (item 29)', () => {
  const output = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'slack-credentials.json'), '{"botToken":"xoxb-1"}', 'utf8');
  });

  it('restore preview prints the prominent ownership warning when credentials are in the archive', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    logSpy.mockClear();
    await backupCommand('restore', outFile, {});
    const out = output();
    expect(out).toContain('SLACK OWNERSHIP');
    expect(out).toContain('BOTH instances will answer');
    expect(out).toContain('--skip-slack');
  });

  it('--skip-slack restores without the credentials and says so', async () => {
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    fs.unlinkSync(path.join(home, 'slack-credentials.json'));
    logSpy.mockClear();
    await backupCommand('restore', outFile, { apply: true, mode: 'overwrite', skipSlack: true });
    const out = output();
    expect(out).not.toContain('SLACK OWNERSHIP');
    expect(out).toContain('SKIPPED (--skip-slack)');
    expect(out).toContain('credentials skipped (--skip-slack)');
    expect(fs.existsSync(path.join(home, 'slack-credentials.json'))).toBe(false);
  });

  it('no warning when the archive has no Slack credentials', async () => {
    fs.unlinkSync(path.join(home, 'slack-credentials.json'));
    await backupCommand('create', undefined, { out: outFile, chatDb: false });
    logSpy.mockClear();
    await backupCommand('restore', outFile, {});
    expect(output()).not.toContain('SLACK OWNERSHIP');
  });
});
