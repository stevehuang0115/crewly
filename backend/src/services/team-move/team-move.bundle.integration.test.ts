/**
 * Moving git repositories the target cannot fetch, end to end between two
 * temporary Crewly homes: a repository without a remote (and one with
 * commits the remote lacks) is exported as a git bundle inside the encrypted
 * package, imported on the target, and ends up with the same history and
 * working tree. Also: the checks and the preflight word it as "carried in the
 * package" instead of blocking, and the size caps hold.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageService } from '../core/storage.service.js';
import { generateTargetKeyPair } from './team-move-crypto.js';
import { TeamMoveBlockedError, TeamMoveExporter, buildEncryptedPackage, type ExportDeps } from './team-move-exporter.js';
import { TeamMoveImporter } from './team-move-importer.js';
import { FIXTURE, buildSourceFixture, buildTargetPaths, type Fixture, emptyTriggerStore } from './team-move.fixture.js';

const MOVE_ID = 'move-bundle-00000001';
const F = FIXTURE;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

describe('team move: repositories carried as git bundles', () => {
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
    await fs.mkdir(path.join(fx.projectDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), 'export const level = 1;\n');
    git(fx.projectDir, 'add', '-A');
    git(fx.projectDir, 'commit', '-q', '-m', 'content');
    git(fx.projectDir, 'push', '-q');
  });

  afterEach(async () => {
    delete process.env['CREWLY_PROJECTS_ROOT'];
    delete process.env['CREWLY_TEAM_MOVE_BUNDLE_MAX_MB'];
    delete process.env['CREWLY_TEAM_MOVE_BUNDLES_MAX_MB'];
    await fx.cleanup();
  });

  const exporter = (extra: Partial<ExportDeps> = {}): TeamMoveExporter =>
    new TeamMoveExporter({
      getTriggers: async () => [],
      home: fx.home,
      getTeams: () => sourceStorage.getTeams(),
      getProjects: () => sourceStorage.getProjects(),
      crewlyVersion: '9.9.9',
      source: { instanceId: 'src-instance', deviceName: 'Mac' },
      knownSecrets: async () => [],
      ...extra,
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

  /** Make the repository one with no remote, a second branch, a tag, a dirty file and an untracked file. */
  async function noRemoteRepo(): Promise<void> {
    git(fx.projectDir, 'remote', 'remove', 'origin');
    git(fx.projectDir, 'checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(fx.projectDir, 'feature.txt'), 'on a branch\n');
    git(fx.projectDir, 'add', '-A');
    git(fx.projectDir, 'commit', '-q', '-m', 'feature work');
    git(fx.projectDir, 'tag', 'v1');
    git(fx.projectDir, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), 'export const level = 2;\n');
    await fs.writeFile(path.join(fx.projectDir, 'notes.txt'), 'untracked, not ignored\n');
    await fs.writeFile(path.join(fx.projectDir, 'scratch.log'), 'ignored by .gitignore below\n');
    await fs.appendFile(path.join(fx.projectDir, '.gitignore'), '*.log\n');
    git(fx.projectDir, 'update-index', '--assume-unchanged', '.gitignore');
  }

  async function buildPackage(exp: TeamMoveExporter, options: { carryChanges?: boolean } = {}) {
    const staging = path.join(fx.root, 'staging-out');
    const result = await exp.export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: staging, ...options });
    const key = generateTargetKeyPair();
    const file = path.join(fx.root, 'package.enc');
    const enc = await buildEncryptedPackage(staging, file, key.publicKey, MOVE_ID);
    return { result, key, enc, file, staging };
  }

  describe('a repository without a remote', () => {
    it('does not block: the check says it is carried in the package, with its size', async () => {
      await noRemoteRepo();
      const check = await exporter().checkRepos(F.teamId);
      expect(check.blocking).toEqual([]);
      expect(check.repos[0]!.note).toMatch(/^no remote — will be carried in the package \(\d+ KB\)$/);
      expect(check.repos[0]!.bundle).toMatchObject({ mode: 'full' });
    });

    it('moves history, branches, tags, edits and untracked files; the bundle is gone afterwards', async () => {
      await noRemoteRepo();
      const { result, key, enc, file } = await buildPackage(exporter());

      const repo = result.manifest.repos[0]!;
      expect(repo.bundle).toMatchObject({ mode: 'full', file: `projects/${F.projectId}/bundle/repo.bundle`, refs: expect.any(Number) });
      expect(repo.bundle!.bytes).toBeGreaterThan(0);
      expect(result.manifest.files.map((f) => f.path)).toContain(`projects/${F.projectId}/bundle/repo.bundle`);
      expect(repo.carry).toMatchObject({ patches: 1, untracked: 1, flattenedCommits: 0, baseSha: git(fx.projectDir, 'rev-parse', 'HEAD') });
      expect(result.manifest.totalBytes).toBeGreaterThan(repo.bundle!.bytes);

      const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
      const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;

      expect(report.repos.failed).toEqual([]);
      expect(report.repos.cloned).toEqual([expect.objectContaining({ name: 'Movers App', path: moved.path, branch: 'main', viaBundle: true })]);
      expect(git(moved.path, 'rev-parse', 'HEAD')).toBe(git(fx.projectDir, 'rev-parse', 'HEAD'));
      expect(git(moved.path, 'rev-list', '--count', '--all')).toBe(git(fx.projectDir, 'rev-list', '--count', '--all'));
      expect(git(moved.path, 'branch', '--format=%(refname:short)').split('\n').sort()).toEqual(['feature', 'main']);
      expect(git(moved.path, 'tag')).toBe('v1');
      expect(git(moved.path, 'remote')).toBe('');
      expect(await fs.readFile(path.join(moved.path, 'src', 'game.ts'), 'utf8')).toBe('export const level = 2;\n');
      expect(await fs.readFile(path.join(moved.path, 'notes.txt'), 'utf8')).toBe('untracked, not ignored\n');
      await expect(fs.stat(path.join(moved.path, 'scratch.log'))).rejects.toThrow(); // ignore rules apply
      expect(await fs.stat(path.join(moved.path, '.crewly', 'tickets')).then(() => true)).toBe(true);
      // The bundle is not left lying around (the staging copy is removed, nothing was copied next to the project).
      const leftovers: string[] = [];
      for await (const entry of walk(targetHome)) if (entry.endsWith('.bundle')) leftovers.push(entry);
      for await (const entry of walk(moved.path)) if (entry.endsWith('.bundle')) leftovers.push(entry);
      expect(leftovers).toEqual([]);
      const status = (cwd: string) => git(cwd, 'status', '--porcelain').split('\n').map((l) => l.slice(3)).sort();
      expect(status(moved.path)).toEqual(status(fx.projectDir));
    });

    it('does not run the text secret scan over the bundle but still scans the carried files', async () => {
      await noRemoteRepo();
      const fake = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-');
      await fs.writeFile(path.join(fx.projectDir, 'token.txt'), `t=${fake}\n`);
      await expect(buildPackage(exporter())).rejects.toThrow(/secret scan/i);
    });

    it('refuses a repository over the per-repository cap and names the env var', async () => {
      await noRemoteRepo();
      const tiny = { bundleLimits: { repoBytes: 100, totalBytes: 1024 ** 3 } };
      const check = await exporter(tiny).checkRepos(F.teamId);
      expect(check.blocking.join('\n')).toMatch(/Movers App.*not pushed.*could not be carried instead: the repository is about .* over the .* limit.*CREWLY_TEAM_MOVE_BUNDLE_MAX_MB/);
      await expect(exporter(tiny).export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 's') })).rejects.toBeInstanceOf(TeamMoveBlockedError);
    });

    it('refuses when the bundles together are over the total cap', async () => {
      await noRemoteRepo();
      const check = await exporter({ bundleLimits: { repoBytes: 1024 ** 3, totalBytes: 100 } }).checkRepos(F.teamId);
      expect(check.blocking.join('\n')).toMatch(/total about .* over the .* limit.*CREWLY_TEAM_MOVE_BUNDLES_MAX_MB/);
    });

    it('takes the caps from the environment', async () => {
      await noRemoteRepo();
      process.env['CREWLY_TEAM_MOVE_BUNDLE_MAX_MB'] = '0.0001';
      expect((await exporter().checkRepos(F.teamId)).blocking).toHaveLength(1);
      process.env['CREWLY_TEAM_MOVE_BUNDLE_MAX_MB'] = '512';
      expect((await exporter().checkRepos(F.teamId)).blocking).toEqual([]);
    });

    it('fails the export, not silently, when the real bundle turns out larger than the cap', async () => {
      await noRemoteRepo();
      // The estimate (object store) passes, the exact bundle is checked against the remaining total.
      const exp = exporter({ bundleLimits: { repoBytes: 1024 ** 3, totalBytes: 1024 ** 3 } });
      const { result } = await buildPackage(exp);
      const size = result.manifest.repos[0]!.bundle!.bytes;
      const tight = exporter({ bundleLimits: { repoBytes: 1024 ** 3, totalBytes: Math.max(size - 1, 1) } });
      // Estimate may exceed or not; either way the move does not go through with a missing repository.
      await expect(tight.export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 'tight') })).rejects.toBeInstanceOf(TeamMoveBlockedError);
    });

    it('the preflight reports "no remote — will be carried" with a size, builds no bundle and does not count it as work to push', async () => {
      await noRemoteRepo();
      const report = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf') });
      const repo = report.repos[0]!;
      expect(repo).toMatchObject({ noRemote: true, unpushed: 2 });
      expect(repo.bundle).toMatchObject({ mode: 'full', possible: true, message: expect.stringMatching(/^no remote — will be carried in the package \(\d+ KB\)$/) });
      expect(report.sizeBytes).toBeGreaterThanOrEqual(repo.bundle!.bytes!);
      expect(report.scan!.findings).toEqual([]);
      await expect(fs.stat(path.join(fx.root, 'pf'))).rejects.toThrow();
    });

    it('a clean repository without a remote travels with no patches', async () => {
      git(fx.projectDir, 'remote', 'remove', 'origin');
      const { result, key, enc, file } = await buildPackage(exporter());
      expect(result.manifest.repos[0]!.carry).toBeUndefined();
      await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
      const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;
      expect(git(moved.path, 'rev-parse', 'HEAD')).toBe(git(fx.projectDir, 'rev-parse', 'HEAD'));
      expect(git(moved.path, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    });
  });

  describe('a repository with a remote and commits the remote lacks', () => {
    async function unpushed(): Promise<void> {
      await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), `export const level = 2;\n${'// more\n'.repeat(200)}`);
      git(fx.projectDir, 'commit', '-q', '-am', 'local only');
      await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'uncommitted\n');
    }

    it('without carrying it still blocks (the owner can push)', async () => {
      await unpushed();
      expect((await exporter().checkRepos(F.teamId)).blocking.join('\n')).toMatch(/1 commit not pushed on main/);
    });

    it('keeps the commits as commits, via a bundle, when they do not fit as patches', async () => {
      await unpushed();
      const remoteHead = git(fx.remoteDir, 'rev-parse', 'main');
      const exp = exporter({ carryLimits: { totalBytes: 50, fileBytes: 50, maxFiles: 100 } });
      const preflight = await exp.preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), carryChanges: true, quick: true });
      expect(preflight.repos[0]!.bundle).toMatchObject({ mode: 'unpushed', possible: true, message: expect.stringMatching(/^1 commit not pushed — will be carried in the package as a git bundle/) });

      // wip.txt (13 bytes) fits the tiny carry cap, so the working tree travels on top of the bundle.
      const { result, key, enc, file } = await buildPackage(exp, { carryChanges: true });
      expect(result.manifest.repos[0]!.bundle).toMatchObject({ mode: 'unpushed' });
      expect(result.manifest.repos[0]!.carry).toMatchObject({ flattenedCommits: 0, untracked: 1, baseSha: git(fx.projectDir, 'rev-parse', 'HEAD') });

      const report = await importer().run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });
      const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;
      expect(report.repos.failed).toEqual([]);
      expect(git(moved.path, 'rev-parse', 'HEAD')).toBe(git(fx.projectDir, 'rev-parse', 'HEAD'));
      expect(git(moved.path, 'remote', 'get-url', 'origin')).toBe(fx.remoteDir);
      expect(git(moved.path, 'log', '-1', '--format=%s')).toBe('local only');
      expect(await fs.readFile(path.join(moved.path, 'wip.txt'), 'utf8')).toBe('uncommitted\n');
      expect(git(fx.remoteDir, 'rev-parse', 'main')).toBe(remoteHead); // nothing was pushed
    });

    it('still flattens small unpushed work into patches as before', async () => {
      await fs.writeFile(path.join(fx.projectDir, 'src', 'game.ts'), 'export const level = 2;\n');
      git(fx.projectDir, 'commit', '-q', '-am', 'local only');
      const { result } = await buildPackage(exporter(), { carryChanges: true });
      expect(result.manifest.repos[0]!.bundle).toBeUndefined();
      expect(result.manifest.repos[0]!.carry).toMatchObject({ flattenedCommits: 1 });
    });
  });

  describe('a private repository the target cannot read', () => {
    it('is carried whole as a bundle, keeps its remote, and asks the owner to sign in later', async () => {
      const remote = git(fx.projectDir, 'config', '--get', 'remote.origin.url');
      const check = await exporter().checkRepos(F.teamId);
      expect(check.repos[0]!.bundle).toBeUndefined(); // reachable as far as the source knows: cloned

      const staging = path.join(fx.root, 'staging-unreachable');
      const result = await exporter().export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: staging, unreachableRemotes: [remote] });
      const repo = result.manifest.repos[0]!;
      expect(repo.remoteUrl).toBe(remote);
      expect(repo.bundle).toMatchObject({ mode: 'full', why: 'remote_unreachable', file: `projects/${F.projectId}/bundle/repo.bundle` });
      expect(repo.note).toMatch(/can't reach this private repo; it will be carried in the package/);

      const key = generateTargetKeyPair();
      const file = path.join(fx.root, 'package-unreachable.enc');
      const enc = await buildEncryptedPackage(staging, file, key.publicKey, MOVE_ID);
      const report = await new TeamMoveImporter({
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
        machineName: () => 'iriss-air.lan',
      }).run({ moveId: MOVE_ID, packageFile: file, privateKey: key.privateKey, expectedSha256: enc.sha256 });

      const moved = (await targetStorage.getProjects()).find((p) => p.id === F.projectId)!;
      expect(report.repos.failed).toEqual([]);
      expect(report.repos.cloned[0]).toMatchObject({ viaBundle: true, remoteUnreachable: true });
      expect(git(moved.path, 'rev-parse', 'HEAD')).toBe(git(fx.projectDir, 'rev-parse', 'HEAD'));
      expect(git(moved.path, 'config', '--get', 'remote.origin.url')).toBe(remote);
      expect(report.warnings.join(' ')).toMatch(/iriss-air\.lan can't reach the private repo .*carried in the package .*Log in to GitHub on iriss-air\.lan later to push\/pull/);
      expect(report.started.ok).toBe(true);
    });

    it('words the preflight line with the target name and reports the repo as unreachable', async () => {
      const remote = git(fx.projectDir, 'config', '--get', 'remote.origin.url');
      const report = await exporter().preflight({ teamId: F.teamId, stagingDir: path.join(fx.root, 'pf'), quick: true, unreachableRemotes: [remote], targetName: 'iriss-air.lan' });
      expect(report.repos[0]).toMatchObject({ remoteUnreachable: true, bundle: { mode: 'full', possible: true } });
      expect(report.repos[0]!.bundle!.message).toMatch(/^iriss-air\.lan can't reach this private repo; it will be carried in the package \(.*\)\. Log in to GitHub on iriss-air\.lan later to push\/pull\.$/);
    });
  });

});

/** All files below a folder. */
async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
