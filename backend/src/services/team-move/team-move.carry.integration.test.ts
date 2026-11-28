/**
 * "Carry uncommitted changes" and the preflight, end to end between two
 * temporary Crewly homes: a dirty repository is exported (nothing is pushed),
 * encrypted, imported on the target and ends up with the same working tree;
 * the preflight reports what the owner needs to decide.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageService } from '../core/storage.service.js';
import { generateTargetKeyPair } from './team-move-crypto.js';
import { TeamMoveBlockedError, TeamMoveExporter, buildEncryptedPackage } from './team-move-exporter.js';
import { TeamMoveImporter } from './team-move-importer.js';
import { TeamMoveSecretScanError } from './team-move-secret-scan.js';
import { FIXTURE, buildSourceFixture, buildTargetPaths, type Fixture, emptyTriggerStore } from './team-move.fixture.js';
import type { CarryIndex } from './team-move.types.js';

// Fake credentials are assembled at run time so secret scanners do not flag this file.
const FAKE_SLACK = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-');

const MOVE_ID = 'move-carry-000000001';
const F = FIXTURE;
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255, 254, 0]);

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('team move: carry uncommitted changes and preflight', () => {
  let fx: Fixture;
  let sourceStorage: StorageService;
  let targetHome: string;
  let targetStorage: StorageService;

  beforeEach(async () => {
    fx = await buildSourceFixture();
    const target = await buildTargetPaths(fx.root);
    targetHome = target.home;
    process.env['CREWLY_PROJECTS_ROOT'] = target.projectsRoot;
    sourceStorage = new StorageService(fx.home);
    targetStorage = new StorageService(targetHome);
    // The project already has pushed files to edit and delete.
    await fs.mkdir(path.join(fx.projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), 'export const level = 1;\n');
    await fs.writeFile(path.join(fx.projectDir, 'old.md'), 'remove me\n');
    await fs.writeFile(path.join(fx.projectDir, 'sprite.png'), BINARY);
    git(fx.projectDir, 'add', '-A');
    git(fx.projectDir, 'commit', '-q', '-m', 'content');
    git(fx.projectDir, 'push', '-q');
  });

  afterEach(async () => {
    delete process.env['CREWLY_PROJECTS_ROOT'];
    await fx.cleanup();
  });

  const exporter = (): TeamMoveExporter =>
    new TeamMoveExporter({
      getTriggers: async () => [],
      home: fx.home,
      getTeams: () => sourceStorage.getTeams(),
      getProjects: () => sourceStorage.getProjects(),
      crewlyVersion: '9.9.9',
      source: { instanceId: 'src-instance', deviceName: 'Mac' },
      knownSecrets: async () => [],
    });

  const importer = (): TeamMoveImporter =>
    new TeamMoveImporter({
      triggers: emptyTriggerStore(),
      home: targetHome,
      crewlyVersion: '9.9.9',
      storage: targetStorage,
      addWorkItems: async () => 0,
      addDecisions: async () => 0,
      adoptSlackMapping: async () => true,
      startTeam: async () => ({ ok: true }),
      hasCommand: () => true,
      runtimeLogins: async () => ({ 'claude-code': true }),
    });

  /** Dirty the working tree: edit, delete, binary edit, unpushed commit, untracked text and binary files. */
  async function dirty(): Promise<void> {
    await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), 'export const level = 2;\n');
    git(fx.projectDir, 'commit', '-q', '-am', 'local only');
    await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), 'export const level = 3;\nexport const boss = true;\n');
    await fs.rm(path.join(fx.projectDir, 'old.md'));
    await fs.writeFile(path.join(fx.projectDir, 'sprite.png'), Buffer.concat([BINARY, Buffer.from([9, 0, 9])]));
    await fs.writeFile(path.join(fx.projectDir, 'src', 'levels.json'), '{"levels":[1,2,3]}\n');
    await fs.writeFile(path.join(fx.projectDir, 'music.ogg'), BINARY);
  }

  async function exportCarry(options: { skipFlagged?: boolean } = {}) {
    const staging = path.join(fx.root, 'staging-out');
    const result = await exporter().export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: staging, carryChanges: true, ...options });
    const key = generateTargetKeyPair();
    const file = path.join(fx.root, 'package.enc');
    const enc = await buildEncryptedPackage(staging, file, key.publicKey, MOVE_ID);
    return { result, key, enc, file };
  }

  it('without carrying, uncommitted work still blocks the move', async () => {
    await dirty();
    await expect(exporter().export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 's') })).rejects.toBeInstanceOf(TeamMoveBlockedError);
  });

  it('carries edits, deletions, binary files, untracked files and local commits to the target, and pushes nothing', async () => {
    await dirty();
    const remoteHead = git(fx.remoteDir, 'rev-parse', 'main');
    const { result, key, enc, file } = await exportCarry();

    expect(result.dirtyRepos).toEqual([]);
    const repo = result.manifest.repos[0]!;
    expect(repo.carry).toMatchObject({ patches: 3, untracked: 2, flattenedCommits: 1, leftBehind: [] });
    const paths = result.manifest.files.map((f) => f.path);
    expect(paths).toContain(`projects/${F.projectId}/carry/carry.json`);
    expect(paths.filter((p) => p.includes('/carry/patches/'))).toHaveLength(3);
    expect(paths).toContain(`projects/${F.projectId}/carry/files/music.ogg`);

    const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
    const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;

    expect(await fs.readFile(path.join(moved.path, 'src', 'game.ts'), 'utf8')).toBe('export const level = 3;\nexport const boss = true;\n');
    await expect(fs.stat(path.join(moved.path, 'old.md'))).rejects.toThrow();
    expect((await fs.readFile(path.join(moved.path, 'sprite.png'))).equals(Buffer.concat([BINARY, Buffer.from([9, 0, 9])]))).toBe(true);
    expect(await fs.readFile(path.join(moved.path, 'src', 'levels.json'), 'utf8')).toBe('{"levels":[1,2,3]}\n');
    expect((await fs.readFile(path.join(moved.path, 'music.ogg'))).equals(BINARY)).toBe(true);

    // Same changes as on the source, uncommitted; the branch sits on a commit the remote has.
    const status = (cwd: string) => git(cwd, 'status', '--porcelain').split('\n').map((l) => l.slice(3)).sort();
    expect(status(moved.path)).toEqual(status(fx.projectDir));
    expect(git(moved.path, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(git(fx.remoteDir, 'rev-parse', 'main')).toBe(remoteHead);
    expect(git(fx.projectDir, 'rev-list', '--count', '@{u}..HEAD')).toBe('1'); // the source still has its own unpushed commit

    expect(report.repos.failed).toEqual([]);
    expect(report.repos.carried).toEqual([{ name: 'Movers App', applied: 3, untracked: 2, failed: [], flattenedCommits: 1, leftBehind: 0 }]);
    expect(report.warnings.join('\n')).toMatch(/1 local commit from the source arrived as uncommitted changes/);
  });

  it('reports a carried change that cannot be applied and keeps its patch', async () => {
    await dirty();
    const { key, enc, file } = await exportCarry();
    const remoteHead = git(fx.remoteDir, 'rev-parse', 'main');
    // Someone put another music.ogg on the target before the import.
    const preset = path.join(fx.root, 'target-projects', 'movers-app');
    await fs.mkdir(preset, { recursive: true });
    const imp = new TeamMoveImporter({
      ...(importer() as unknown as { deps: ConstructorParameters<typeof TeamMoveImporter>[0] }).deps,
      restoreRepo: async (dest, repo) => {
        const { restoreRepo } = await import('./team-move-git.js');
        const res = await restoreRepo(dest, repo);
        await fs.writeFile(path.join(dest, 'music.ogg'), 'not the same');
        return res;
      },
    });
    const report = await imp.run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
    expect(report.repos.carried![0]!.failed).toEqual([{ path: 'music.ogg', reason: 'a different file is already there' }]);
    expect(report.warnings.join('\n')).toMatch(/1 carried change could not be applied \(music.ogg\)/);
    const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;
    expect(await fs.readFile(path.join(moved.path, 'music.ogg'), 'utf8')).toBe('not the same');
    expect((await fs.readdir(path.join(moved.path, '.crewly', 'move-carry-failed'))).length).toBe(1);
    expect(git(moved.path, 'rev-parse', 'HEAD')).toBe(remoteHead);
  });

  it('still blocks a repository whose changes do not fit, and says why', async () => {
    await dirty();
    const small = new TeamMoveExporter({
      getTriggers: async () => [],
      home: fx.home,
      getTeams: () => sourceStorage.getTeams(),
      getProjects: () => sourceStorage.getProjects(),
      crewlyVersion: '9.9.9',
      source: { instanceId: null, deviceName: null },
      knownSecrets: async () => [],
      carryLimits: { totalBytes: 1024 * 1024, fileBytes: 10, maxFiles: 100 },
    });
    const err = await small.export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 's'), carryChanges: true }).catch((e) => e);
    expect(err).toBeInstanceOf(TeamMoveBlockedError);
    expect(err.message).toMatch(/could not be carried instead: .*too large/);
    // Moving anyway leaves the work on the source.
    const allowed = await small.export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 's2'), carryChanges: true, allowDirty: true });
    expect(allowed.manifest.repos[0]!.carry).toBeUndefined();
    expect(allowed.dirtyRepos).toHaveLength(1);
  });

  it('scans carried files: a credential blocks the move, or leaves just that change behind with skipFlagged', async () => {
    await dirty();
    await fs.writeFile(path.join(fx.projectDir, 'src', 'config.local.ts'), `export const t = '${FAKE_SLACK}';\n`);
    await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), `export const level = 4; // key ${FAKE_SLACK}\n`);
    await expect(exportCarry()).rejects.toBeInstanceOf(TeamMoveSecretScanError);

    const { result, key, enc, file } = await exportCarry({ skipFlagged: true });
    const repo = result.manifest.repos[0]!;
    expect([...repo.carry!.leftBehind].sort()).toEqual(['src/config.local.ts', 'src/game.ts']);
    expect(result.manifest.files.some((f) => f.path.endsWith('config.local.ts'))).toBe(false);
    const index = JSON.parse(await fs.readFile(path.join(result.staging.root, 'projects', F.projectId, 'carry', 'carry.json'), 'utf8')) as CarryIndex;
    expect(index.patches.map((p) => p.path).sort()).toEqual(['old.md', 'sprite.png']);

    const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
    const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;
    await expect(fs.stat(path.join(moved.path, 'src', 'config.local.ts'))).rejects.toThrow();
    expect(await fs.readFile(path.join(moved.path, 'src', 'game.ts'), 'utf8')).toBe('export const level = 1;\n');
    expect(report.warnings.join('\n')).toMatch(/2 changed files were left on the source/);
  });

  describe('preflight', () => {
    it('reports a clean team as ready, with size, tools and no findings', async () => {
      const report = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf') });
      expect(report).toMatchObject({ teamId: F.teamId, teamName: 'Movers', members: 2, carryRequested: false });
      expect(report.repos).toHaveLength(1);
      expect(report.repos[0]).toMatchObject({ projectName: 'Movers App', isRepo: true, branch: 'main', modified: 0, untracked: 0, unpushed: 0, topFiles: [], carry: null, noRemote: false });
      expect(report.repos[0]!.remote).not.toContain('://');
      expect(report.scan).toEqual({ filesScanned: expect.any(Number), findings: [] });
      expect(report.sizeBytes).toBeGreaterThan(0);
      expect(report.requiredTools).toContain('ffmpeg');
      expect(report.requiredRuntimes).toEqual(['claude-code']);
      await expect(fs.stat(path.join(fx.root, 'pf'))).rejects.toThrow();
    });

    it('describes dirty work per repository, and whether it can be carried', async () => {
      await dirty();
      const report = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), carryChanges: true });
      const repo = report.repos[0]!;
      expect(repo).toMatchObject({ modified: 3, untracked: 2, unpushed: 1 });
      expect(repo.topFiles.map((f) => [f.status, f.path]).slice(0, 3).sort()).toEqual([['deleted', 'old.md'], ['modified', 'sprite.png'], ['modified', 'src/game.ts']]);
      expect(repo.carry).toMatchObject({ possible: true, files: 5, flattenedCommits: 1 });
      expect(repo.carry!.bytes).toBeGreaterThan(0);
      expect(report.carryRequested).toBe(true);
    });

    it('lists secret findings by the owner\'s names, including carried changes, and which can be left behind', async () => {
      await dirty();
      await fs.writeFile(path.join(fx.projectDir, 'src', 'config.local.ts'), `export const t = '${FAKE_SLACK}';\n`);
      await fs.writeFile(path.join(fx.projectDir, '.crewly', 'findings', 'leak.md'), `token: ${FAKE_SLACK}\n`);
      const report = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), carryChanges: true });
      expect(report.scan!.findings.map((f) => f.file).sort()).toEqual(['Movers App/.crewly/findings/leak.md', 'Movers App/src/config.local.ts']);
      expect(report.scan!.findings.every((f) => f.removable && f.matches > 0)).toBe(true);
      // Never a matched value.
      expect(JSON.stringify(report)).not.toContain(FAKE_SLACK);

      const config = JSON.parse(await fs.readFile(path.join(fx.home, 'teams', F.teamId, 'config.json'), 'utf8')) as { members: Array<{ systemPrompt: string }> };
      config.members[0]!.systemPrompt = `use ${FAKE_SLACK}`;
      await fs.writeFile(path.join(fx.home, 'teams', F.teamId, 'config.json'), JSON.stringify(config));
      const second = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf2'), carryChanges: true, force: true });
      expect(second.scan!.findings.find((f) => f.file === 'team/config.json')).toMatchObject({ removable: false });
    });

    it('reuses the package dry run while nothing changed, and redoes it when the repository changes', async () => {
      const ex = exporter();
      const spy = jest.spyOn(ex, 'export');
      await ex.preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf') });
      await ex.preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf') });
      expect(spy).toHaveBeenCalledTimes(1);
      await ex.preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), force: true });
      expect(spy).toHaveBeenCalledTimes(2);
      await fs.writeFile(path.join(fx.projectDir, 'fresh.txt'), 'new');
      await ex.preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf') });
      expect(spy).toHaveBeenCalledTimes(3);
      const quick = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), quick: true });
      expect(quick.scan).toBeNull();
      expect(quick.sizeBytes).toBeNull();
      expect(quick.repos[0]!.untracked).toBe(1);
    });

    it('says a repository without a remote will be carried in the package, with its size', async () => {
      git(fx.projectDir, 'remote', 'remove', 'origin');
      await fs.writeFile(path.join(fx.projectDir, 'x.txt'), 'x');
      const report = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), carryChanges: true, quick: true });
      expect(report.repos[0]).toMatchObject({ noRemote: true, remote: null });
      expect(report.repos[0]!.carry).toMatchObject({ possible: true, files: 1, flattenedCommits: 0 });
      expect(report.repos[0]!.bundle).toMatchObject({ mode: 'full', possible: true, message: expect.stringMatching(/^no remote — will be carried in the package \(\d+ KB\)$/) });
    });
  });
});
