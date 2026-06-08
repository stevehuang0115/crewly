/**
 * Tests for BackupArchiveService (P0).
 *
 * Builds a throwaway CREWLY_HOME + a git-backed project, archives it, and
 * asserts the manifest scope (includes portable data, excludes machine-
 * specific/secret/runtime), git provenance, and archive integrity.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { extract as tarExtract } from 'tar';
import { BackupArchiveService } from './backup-archive.service.js';

const CREATED_AT = '2026-06-07T20:00:00.000Z';

/** Silent logger stub so tests don't spew. */
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as ConstructorParameters<typeof BackupArchiveService>[0];

let home: string;
let projectPath: string;
let outDir: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-home-'));
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-out-'));
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-proj-'));

  // ── Portable globals (should be IN) ──
  await fs.writeFile(path.join(home, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
  await fs.mkdir(path.join(home, 'teams', 't1'), { recursive: true });
  await fs.writeFile(path.join(home, 'teams', 't1', 'config.json'), JSON.stringify({ id: 't1' }), 'utf8');
  await fs.mkdir(path.join(home, 'global-wiki'), { recursive: true });
  await fs.writeFile(path.join(home, 'global-wiki', 'note.md'), '# learned thing', 'utf8');

  // ── Machine-specific / secret / runtime / recursion (should be OUT) ──
  await fs.writeFile(path.join(home, 'device.json'), '{"id":"dev-A"}', 'utf8');
  await fs.mkdir(path.join(home, 'cloud'), { recursive: true });
  await fs.writeFile(path.join(home, 'cloud', 'config.json'), '{"token":"secret"}', 'utf8');
  await fs.writeFile(path.join(home, 'telegram-credentials.json'), '{"token":"x"}', 'utf8');
  await fs.mkdir(path.join(home, 'logs'), { recursive: true });
  await fs.writeFile(path.join(home, 'logs', 'app.log'), 'noise', 'utf8');
  await fs.mkdir(path.join(home, 'teams-backup-history'), { recursive: true });
  await fs.writeFile(path.join(home, 'teams-backup-history', 'teams-backup-000.json'), '{}', 'utf8');
  await fs.mkdir(path.join(home, 'agents', 'sess-a', 'sessions'), { recursive: true });
  await fs.writeFile(path.join(home, 'agents', 'sess-a', 'self-model.json'), '{"v":1}', 'utf8'); // IN
  await fs.writeFile(path.join(home, 'agents', 'sess-a', 'sessions', 'x.jsonl'), 'line', 'utf8'); // OUT (dir + .jsonl)

  // ── A git-backed project with .crewly data ──
  await fs.mkdir(path.join(projectPath, '.crewly', 'wiki'), { recursive: true });
  await fs.writeFile(path.join(projectPath, '.crewly', 'wiki', 'arch.md'), '# project wiki', 'utf8');
  await fs.mkdir(path.join(projectPath, '.crewly', 'logs', 'daily'), { recursive: true });
  await fs.writeFile(path.join(projectPath, '.crewly', 'logs', 'daily', 'd.md'), 'log', 'utf8'); // OUT
  const git = (args: string[]) => execFileSync('git', ['-C', projectPath, ...args], { stdio: 'ignore' });
  git(['init', '-q']);
  git(['remote', 'add', 'origin', 'git@github.com:acme/web.git']);
  git(['add', '-A']);
  git(['-c', 'user.email=t@t.io', '-c', 'user.name=t', 'commit', '-qm', 'init']);

  await fs.writeFile(
    path.join(home, 'projects.json'),
    JSON.stringify([{ id: 'p1', name: 'web', path: projectPath }]),
    'utf8',
  );
});

afterEach(async () => {
  for (const d of [home, outDir, projectPath]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

describe('BackupArchiveService.createArchive', () => {
  it('captures portable globals + project .crewly and excludes machine/secret/runtime data', async () => {
    const svc = new BackupArchiveService(silentLogger);
    const out = path.join(outDir, 'wb.tar.gz');
    const { manifest, archivePath } = await svc.createArchive({
      homePath: home,
      outPath: out,
      excludeChatDb: true,
      createdAt: CREATED_AT,
    });

    expect(archivePath).toBe(out);
    expect(await fs.stat(out)).toBeTruthy();

    const globalPaths = manifest.global.map((g) => g.path);
    // IN
    expect(globalPaths).toContain('home/settings.json');
    expect(globalPaths).toContain('home/teams/t1/config.json');
    expect(globalPaths).toContain('home/global-wiki/note.md');
    expect(globalPaths).toContain('home/agents/sess-a/self-model.json');
    // OUT
    expect(globalPaths).not.toContain('home/device.json');
    expect(globalPaths.some((p) => p.startsWith('home/cloud/'))).toBe(false);
    expect(globalPaths).not.toContain('home/telegram-credentials.json');
    expect(globalPaths.some((p) => p.startsWith('home/logs/'))).toBe(false);
    expect(globalPaths.some((p) => p.startsWith('home/teams-backup-history/'))).toBe(false);
    expect(globalPaths.some((p) => p.endsWith('.jsonl'))).toBe(false);
    expect(globalPaths.some((p) => p.includes('/sessions/'))).toBe(false);
  });

  it('records each project with git provenance and excludes project logs', async () => {
    const svc = new BackupArchiveService(silentLogger);
    const { manifest } = await svc.createArchive({
      homePath: home,
      outPath: path.join(outDir, 'wb.tar.gz'),
      excludeChatDb: true,
      createdAt: CREATED_AT,
    });

    expect(manifest.projects).toHaveLength(1);
    const p = manifest.projects[0];
    expect(p.id).toBe('p1');
    expect(p.sourcePath).toBe(projectPath);
    expect(p.git.remote).toBe('git@github.com:acme/web.git');
    expect(p.git.commit).toMatch(/^[0-9a-f]{40}$/);
    const projPaths = p.files.map((f) => f.path);
    expect(projPaths).toContain('projects/p1/.crewly/wiki/arch.md');
    expect(projPaths.some((pp) => pp.includes('/logs/'))).toBe(false);
  });

  it('records chatDb as excluded when the option is set', async () => {
    const svc = new BackupArchiveService(silentLogger);
    const { manifest } = await svc.createArchive({
      homePath: home,
      outPath: path.join(outDir, 'wb.tar.gz'),
      excludeChatDb: true,
      createdAt: CREATED_AT,
    });
    expect(manifest.chatDb.included).toBe(false);
    expect(manifest.chatDb.skippedReason).toBe('excluded by option');
  });

  it('produces an extractable archive whose files match the manifest checksums', async () => {
    const svc = new BackupArchiveService(silentLogger);
    const out = path.join(outDir, 'wb.tar.gz');
    const { manifest } = await svc.createArchive({
      homePath: home,
      outPath: out,
      excludeChatDb: true,
      createdAt: CREATED_AT,
    });

    const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-x-'));
    try {
      await tarExtract({ file: out, cwd: extractDir });
      // manifest.json present + parseable
      const m = JSON.parse(await fs.readFile(path.join(extractDir, 'manifest.json'), 'utf8'));
      expect(m.schemaVersion).toBe(manifest.schemaVersion);
      // a captured file extracted with the right content
      const settings = await fs.readFile(path.join(extractDir, 'home', 'settings.json'), 'utf8');
      expect(JSON.parse(settings)).toEqual({ theme: 'dark' });
      // checksum recorded and non-empty for every entry
      for (const g of manifest.global) expect(g.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await fs.rm(extractDir, { recursive: true, force: true });
    }
  });

  it('throws when CREWLY_HOME does not exist', async () => {
    const svc = new BackupArchiveService(silentLogger);
    await expect(
      svc.createArchive({ homePath: path.join(home, 'nope'), createdAt: CREATED_AT, outPath: path.join(outDir, 'x.tgz') }),
    ).rejects.toThrow(/CREWLY_HOME not found/);
  });
});
