/**
 * Tests for the worktree janitor's low-level helpers.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	canonicalPath,
	discoverLinkedWorktreeRepos,
	diskUsageBytes,
	findGitCheckouts,
	formatBytes,
	isJanitorDisabled,
	latestTreeMtimeMs,
	mainRepoOfLinkedWorktree,
	isPathInside,
	latestWorktreeMtimeMs,
	listProcessCwds,
	parsePorcelainWorktrees,
	runCommand,
} from './worktree-janitor.git.js';

describe('parsePorcelainWorktrees', () => {
	it('parses main, branch, detached, locked and prunable entries', () => {
		const out = [
			'worktree /r',
			'HEAD aaa',
			'branch refs/heads/main',
			'',
			'worktree /r/.claude/worktrees/a',
			'HEAD bbb',
			'branch refs/heads/feat/x',
			'locked claude agent a (pid 1)',
			'',
			'worktree /tmp/d',
			'HEAD ccc',
			'detached',
			'',
			'worktree /gone',
			'HEAD ddd',
			'branch refs/heads/old',
			'prunable gitdir file points to non-existent location',
			'',
		].join('\n');
		const wts = parsePorcelainWorktrees(out);
		expect(wts).toHaveLength(4);
		expect(wts[0]).toMatchObject({ path: '/r', head: 'aaa', branch: 'main', isMain: true, locked: false });
		expect(wts[1]).toMatchObject({ branch: 'feat/x', isMain: false, locked: true, lockReason: 'claude agent a (pid 1)' });
		expect(wts[2]).toMatchObject({ branch: null, detached: true });
		expect(wts[3]).toMatchObject({ prunable: true });
	});

	it('handles a bare main entry, a bare "locked" line and empty input', () => {
		const wts = parsePorcelainWorktrees('worktree /b.git\nbare\n\nworktree /w\nHEAD e\nbranch refs/heads/b\nlocked\n');
		expect(wts[0]).toMatchObject({ bare: true, isMain: true });
		expect(wts[1]).toMatchObject({ locked: true });
		expect(wts[1].lockReason).toBeUndefined();
		expect(parsePorcelainWorktrees('')).toEqual([]);
	});
});

describe('path helpers', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtj-git-')));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('isPathInside matches the dir itself and children, not prefix siblings', () => {
		expect(isPathInside(path.join(dir, 'a'), path.join(dir, 'a'))).toBe(true);
		expect(isPathInside(path.join(dir, 'a', 'b'), path.join(dir, 'a'))).toBe(true);
		expect(isPathInside(path.join(dir, 'ab'), path.join(dir, 'a'))).toBe(false);
		expect(isPathInside(dir, path.join(dir, 'a'))).toBe(false);
	});

	it('isPathInside resolves symlinks on both sides', () => {
		fs.mkdirSync(path.join(dir, 'real'));
		fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
		expect(isPathInside(path.join(dir, 'link'), path.join(dir, 'real'))).toBe(true);
		expect(canonicalPath(path.join(dir, 'link'))).toBe(path.join(dir, 'real'));
		expect(canonicalPath(path.join(dir, 'missing', '..', 'x'))).toBe(path.join(dir, 'x'));
	});

	it('latestWorktreeMtimeMs returns the newest mtime, or null when nothing exists', () => {
		const gitDir = path.join(dir, 'gitdir');
		fs.mkdirSync(path.join(gitDir, 'logs'), { recursive: true });
		fs.writeFileSync(path.join(gitDir, 'index'), '');
		const old = new Date(Date.now() - 10 * 60 * 60 * 1000);
		fs.utimesSync(dir, old, old);
		fs.utimesSync(gitDir, old, old);
		fs.utimesSync(path.join(gitDir, 'logs'), old, old);
		const recent = new Date(Date.now() - 60 * 1000);
		fs.utimesSync(path.join(gitDir, 'index'), recent, recent);
		expect(latestWorktreeMtimeMs(dir, gitDir)).toBeCloseTo(recent.getTime(), -3);
		expect(latestWorktreeMtimeMs(path.join(dir, 'nope'), null)).toBeNull();
	});
});

describe('runCommand', () => {
	it('returns exit code 0 and stdout on success', async () => {
		const r = await runCommand('git', ['--version']);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/^git version/);
	});

	it('returns the non-zero exit code without throwing', async () => {
		const r = await runCommand('git', ['-C', os.tmpdir(), 'rev-parse', '--verify', '--quiet', 'refs/heads/definitely-missing-xyz']);
		expect(r.code).not.toBe(0);
		expect(r.code).not.toBeNull();
	});

	it('returns code null for a missing executable', async () => {
		const r = await runCommand('/definitely/not/a/binary', []);
		expect(r.code).toBeNull();
		expect(r.stderr).toBeTruthy();
	});

	it('returns code null on timeout', async () => {
		const r = await runCommand('sleep', ['5'], { timeoutMs: 100 });
		expect(r.code).toBeNull();
	});
});

describe('isJanitorDisabled', () => {
	it.each(['0', 'off', 'false', 'no', ' OFF '])('is disabled for %p', (v) => {
		expect(isJanitorDisabled({ CREWLY_WORKTREE_JANITOR: v })).toBe(true);
	});
	it.each([undefined, '1', 'on', ''])('is enabled for %p', (v) => {
		expect(isJanitorDisabled(v === undefined ? {} : { CREWLY_WORKTREE_JANITOR: v })).toBe(false);
	});
});

const describePosix = process.platform === 'win32' ? describe.skip : describe;
describePosix('listProcessCwds', () => {
	it('includes the cwd of a live child process', async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wtj-cwd-')));
		const child = spawn('sleep', ['30'], { cwd: dir, stdio: 'ignore' });
		try {
			await new Promise((r) => setTimeout(r, 200));
			const cwds = await listProcessCwds();
			expect(cwds).not.toBeNull();
			expect((cwds ?? []).map((c) => canonicalPath(c))).toContain(dir);
		} finally {
			child.kill('SIGKILL');
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('disk janitor fs helpers', () => {
	let root: string;

	beforeEach(() => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-helpers-')));
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('mainRepoOfLinkedWorktree reads the main repo from a worktree .git file, and ignores clones and submodules', () => {
		const wt = path.join(root, 'visa-cm-wt');
		fs.mkdirSync(wt);
		fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /src/ce-core/.git/worktrees/visa-cm-wt\n');
		expect(mainRepoOfLinkedWorktree(wt)).toBe('/src/ce-core');
		const sub = path.join(root, 'sub');
		fs.mkdirSync(sub);
		fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../.git/modules/sub\n');
		expect(mainRepoOfLinkedWorktree(sub)).toBeNull();
		const clone = path.join(root, 'clone');
		fs.mkdirSync(path.join(clone, '.git'), { recursive: true });
		expect(mainRepoOfLinkedWorktree(clone)).toBeNull();
		expect(mainRepoOfLinkedWorktree(path.join(root, 'missing'))).toBeNull();
	});

	it('findGitCheckouts stops at checkouts, skips node_modules, respects depth and never follows symlinks', () => {
		fs.mkdirSync(path.join(root, 'a', 'repo', '.git'), { recursive: true });
		fs.mkdirSync(path.join(root, 'a', 'repo', 'nested', '.git'), { recursive: true });
		fs.mkdirSync(path.join(root, 'node_modules', 'pkg', '.git'), { recursive: true });
		fs.mkdirSync(path.join(root, 'b', 'c', 'd', 'deep', '.git'), { recursive: true });
		fs.mkdirSync(path.join(root, 'wt'));
		fs.writeFileSync(path.join(root, 'wt', '.git'), 'gitdir: /x/.git/worktrees/wt\n');
		const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-outside-')));
		try {
			fs.mkdirSync(path.join(outside, 'r', '.git'), { recursive: true });
			fs.symlinkSync(outside, path.join(root, 'link'));
			const found = findGitCheckouts(root, 3);
			expect(found).toEqual(
				expect.arrayContaining([
					{ path: path.join(root, 'a', 'repo'), kind: 'dir' },
					{ path: path.join(root, 'wt'), kind: 'file' },
				]),
			);
			expect(found).toHaveLength(2);
			expect(findGitCheckouts(root, 4).map((f) => f.path)).toContain(path.join(root, 'b', 'c', 'd', 'deep'));
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it('discoverLinkedWorktreeRepos returns existing main repos of worktrees under the roots', () => {
		const main = path.join(root, 'main');
		fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
		const tmp = path.join(root, 'tmp');
		fs.mkdirSync(path.join(tmp, 'x', 'wt'), { recursive: true });
		fs.writeFileSync(path.join(tmp, 'x', 'wt', '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
		fs.mkdirSync(path.join(tmp, 'gone'));
		fs.writeFileSync(path.join(tmp, 'gone', '.git'), 'gitdir: /no/such/repo/.git/worktrees/gone\n');
		expect(discoverLinkedWorktreeRepos([tmp, path.join(root, 'missing-root')])).toEqual([main]);
	});

	it('latestTreeMtimeMs looks only at the requested depth', () => {
		const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		fs.mkdirSync(path.join(root, 'l1', 'l2', 'l3'), { recursive: true });
		for (const p of [root, path.join(root, 'l1'), path.join(root, 'l1', 'l2')]) fs.utimesSync(p, old, old);
		const deep = latestTreeMtimeMs(root, 2);
		expect(deep).toBeGreaterThan(old.getTime() - 1000);
		expect(deep).toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);
		expect(latestTreeMtimeMs(root, 3)).toBeGreaterThan(Date.now() - 60_000);
		expect(latestTreeMtimeMs(path.join(root, 'missing'), 2)).toBeNull();
	});

	it('diskUsageBytes measures a directory, null for a missing path', async () => {
		fs.writeFileSync(path.join(root, 'f'), Buffer.alloc(64 * 1024));
		expect(await diskUsageBytes(root)).toBeGreaterThanOrEqual(64 * 1024);
		expect(await diskUsageBytes(path.join(root, 'missing'))).toBeNull();
	});

	it('formatBytes', () => {
		expect(formatBytes(1.8 * 1024 ** 3)).toBe('1.8 GB');
		expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
		expect(formatBytes(2048)).toBe('2 KB');
	});
});
