import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
	runGit,
	getRepoRoot,
	resolveBaseRef,
	branchExists,
	sanitizeWorktreeId,
	listWorktrees,
	readIncludeFile,
	applySharedPaths,
	ensureExcluded,
	checkDirty,
	checkLanded,
	commitsBeyond,
	removeWorktree,
} from './worktree-git.js';
import { WORKTREE_CONSTANTS } from '../../constants.js';

/** Run git in a test and fail loudly when it fails. */
async function git(cwd: string, ...args: string[]): Promise<string> {
	const r = await runGit(cwd, args);
	if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	return r.stdout.trim();
}

/** A repo with one commit (a tracked README), author configured locally. */
async function makeRepo(dir: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	await git(dir, 'init', '-q', '-b', 'main');
	await git(dir, 'config', 'user.email', 't@example.com');
	await git(dir, 'config', 'user.name', 'T');
	await git(dir, 'config', 'commit.gpgsign', 'false');
	await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
	await fs.writeFile(path.join(dir, '.gitignore'), '.crewly/\n');
	await git(dir, 'add', '-A');
	await git(dir, 'commit', '-q', '-m', 'init');
	return fs.realpath(dir);
}

/** Add a worktree the way the service does. */
async function addWt(repo: string, id: string): Promise<string> {
	const wt = path.join(repo, WORKTREE_CONSTANTS.DIR, id);
	await git(repo, 'worktree', 'add', '-q', wt, '-b', `wi/${id}`, 'HEAD');
	return fs.realpath(wt);
}


// Real git on a loaded machine: checkouts can take seconds each.
jest.setTimeout(600_000);

describe('worktree-git', () => {
	let tmp: string;
	let repo: string;

	beforeEach(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wt-git-')));
		repo = await makeRepo(path.join(tmp, 'repo'));
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	describe('repo facts', () => {
		it('getRepoRoot finds the root from a subdirectory and returns null outside git', async () => {
			await fs.mkdir(path.join(repo, 'sub'));
			expect(await getRepoRoot(path.join(repo, 'sub'))).toBe(repo);
			expect(await getRepoRoot(tmp)).toBeNull();
		});

		it('resolveBaseRef prefers origin/HEAD and falls back to HEAD', async () => {
			expect(await resolveBaseRef(repo)).toEqual({ name: 'HEAD', sha: await git(repo, 'rev-parse', 'HEAD') });
			const clone = path.join(tmp, 'clone');
			await git(tmp, 'clone', '-q', repo, clone);
			expect((await resolveBaseRef(clone))?.name).toBe('origin/main');
		});

		describe('resolveBaseRef preferredBranch (#829 review: a verify worktree must see the worker\'s own commits)', () => {
			it('a preferred branch that exists wins over origin/HEAD and HEAD', async () => {
				await git(repo, 'branch', 'wi/worker-1');
				await fs.writeFile(path.join(repo, 'extra.txt'), 'x');
				await git(repo, 'add', '-A');
				await git(repo, 'commit', '-q', '-m', 'more work on HEAD, not on the preferred branch');
				const workerSha = await git(repo, 'rev-parse', 'wi/worker-1');
				expect(await resolveBaseRef(repo, 'wi/worker-1')).toEqual({ name: 'wi/worker-1', sha: workerSha });
			});

			it('falls back to the normal chain when the preferred branch does not exist', async () => {
				const r = await resolveBaseRef(repo, 'wi/no-such-branch');
				expect(r?.name).toBe('HEAD');
				expect(r?.sha).toBe(await git(repo, 'rev-parse', 'HEAD'));
			});
		});

		it('branchExists and listWorktrees reflect a new worktree (main checkout excluded)', async () => {
			expect(await listWorktrees(repo)).toEqual([]);
			const wt = await addWt(repo, 'wi-1');
			expect(await branchExists(repo, 'wi/wi-1')).toBe(true);
			expect(await branchExists(repo, 'wi/nope')).toBe(false);
			expect(await listWorktrees(repo)).toEqual([wt]);
			expect(await listWorktrees(tmp)).toBeNull();
		});
	});

	describe('.worktreeinclude', () => {
		it('accepts literal paths only, refuses globs / absolute / .. / .git, and caps the count', async () => {
			const many = Array.from({ length: WORKTREE_CONSTANTS.INCLUDE_MAX_ENTRIES + 3 }, (_, i) => `f${i}`);
			await fs.writeFile(path.join(repo, '.worktreeinclude'), ['# comment', '', '.env', 'config/local.json/', '*.env', '/etc/passwd', '../x', 'a/.git/config', '.env', ...many].join('\n'));
			const list = await readIncludeFile(repo);
			expect(list.entries.slice(0, 2)).toEqual(['.env', 'config/local.json']);
			expect(list.entries).toHaveLength(WORKTREE_CONSTANTS.INCLUDE_MAX_ENTRIES);
			expect(list.truncated).toBe(5); // 53 candidates + 2 already accepted, minus the cap of 50
			expect(list.rejected.map((r) => r.line)).toEqual(['*.env', '/etc/passwd', '../x', 'a/.git/config']);
		});

		it('a missing file is an empty list', async () => {
			expect(await readIncludeFile(repo)).toEqual({ entries: [], rejected: [], truncated: 0 });
		});
	});

	describe('applySharedPaths', () => {
		it('symlinks an untracked heavy dir, copies include files, and neither can be committed', async () => {
			await fs.mkdir(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
			await fs.writeFile(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'x');
			await fs.writeFile(path.join(repo, '.env'), 'SECRET=1\n');
			// Deliberately NOT gitignored in this repo — the exclude must protect it.
			const wt = await addWt(repo, 'wi-1');
			const res = await applySharedPaths(repo, wt, ['node_modules', 'cache'], ['.env', 'missing.json']);
			expect(res.symlinks).toEqual(['node_modules']);
			expect(res.copies).toEqual(['.env']);
			// A hash recorded for a later dirty-check to compare against (#829 review):
			// unlike existence alone, this catches an agent editing a copy's content.
			expect(res.copyHashes['.env']).toMatch(/^[0-9a-f]{64}$/);
			expect(res.skipped.map((s) => s.path)).toEqual(['cache', 'missing.json']);
			expect((await fs.lstat(path.join(wt, 'node_modules'))).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(path.join(wt, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('x');
			expect(await fs.readFile(path.join(wt, '.env'), 'utf8')).toBe('SECRET=1\n');

			await git(wt, 'add', '-A');
			expect(await git(wt, 'diff', '--cached', '--name-only')).toBe('');
			expect(await git(wt, 'status', '--porcelain')).toBe('');
		});

		it('never symlinks a directory the repo tracks (a repo that commits node_modules gets the real checkout)', async () => {
			await fs.mkdir(path.join(repo, 'node_modules'), { recursive: true });
			await fs.writeFile(path.join(repo, 'node_modules', 'vendored.js'), 'v');
			await git(repo, 'add', '-f', 'node_modules');
			await git(repo, 'commit', '-q', '-m', 'vendor');
			const wt = await addWt(repo, 'wi-2');
			const res = await applySharedPaths(repo, wt, ['node_modules'], []);
			expect(res.symlinks).toEqual([]);
			expect(res.skipped[0]).toMatchObject({ path: 'node_modules', reason: expect.stringContaining('tracked') });
			expect((await fs.lstat(path.join(wt, 'node_modules'))).isSymbolicLink()).toBe(false);
		});

		it('ensureExcluded is idempotent and writes rooted patterns under the marker', async () => {
			await ensureExcluded(repo, ['node_modules']);
			await ensureExcluded(repo, ['node_modules', '.env']);
			const file = await fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
			expect(file.split('\n').filter((l) => l === '/node_modules')).toHaveLength(1);
			expect(file.split('\n').filter((l) => l === WORKTREE_CONSTANTS.EXCLUDE_MARKER)).toHaveLength(1);
			expect(file).toContain('/.env');
		});
	});

	describe('checkDirty (destructive-operation guard)', () => {
		let wt: string;
		const owned = { symlinks: ['node_modules'], copies: [] as string[] };

		beforeEach(async () => {
			await fs.mkdir(path.join(repo, 'node_modules'));
			wt = await addWt(repo, 'wi-d');
			await applySharedPaths(repo, wt, ['node_modules'], []);
		});

		it('clean: reports what it examined and excludes exactly our symlink', async () => {
			const r = await checkDirty(wt, owned);
			expect(r.state).toBe('clean');
			expect(r.examined).toBeGreaterThan(0);
			expect(r.excludedOurs).toBe(1);
			expect(r.summary).toBe(`${r.examined} path(s) examined, 1 excluded as our symlinks/copies, 0 dirty`);
		});

		it('a real untracked file next to the symlink still reads dirty', async () => {
			await fs.writeFile(path.join(wt, 'notes.txt'), 'work in progress');
			const r = await checkDirty(wt, owned);
			expect(r.state).toBe('dirty');
			expect(r.dirtyPaths).toEqual(['notes.txt']);
		});

		it('an untracked file INSIDE a real (non-symlink) node_modules reads dirty when it is not ours', async () => {
			await fs.unlink(path.join(wt, 'node_modules'));
			await fs.mkdir(path.join(wt, 'node_modules'));
			await fs.writeFile(path.join(wt, 'node_modules', 'x.js'), 'x');
			const r = await checkDirty(wt, owned);
			expect(r.state).toBe('dirty');
			expect(r.dirtyPaths.join(' ')).toContain('was our symlink');
		});

		it('a modified tracked file reads dirty', async () => {
			await fs.writeFile(path.join(wt, 'README.md'), 'changed\n');
			expect((await checkDirty(wt, owned)).dirtyPaths).toEqual(['README.md']);
		});

		describe('an edited .worktreeinclude copy is never mistaken for "just our copy" (#829 review)', () => {
			let cwt: string;
			let cowned: { symlinks: string[]; copies: string[]; copyHashes: Record<string, string> };

			beforeEach(async () => {
				await fs.writeFile(path.join(repo, '.env'), 'TOKEN=original\n');
				cwt = await addWt(repo, 'wi-copy');
				const shared = await applySharedPaths(repo, cwt, [], ['.env']);
				cowned = { symlinks: [], copies: shared.copies, copyHashes: shared.copyHashes };
			});

			it('unedited: excluded as ours (clean)', async () => {
				const r = await checkDirty(cwt, cowned);
				expect(r.state).toBe('clean');
				expect(r.excludedOurs).toBe(1);
			});

			it('edited: reads dirty, not excluded — content differs from the recorded hash', async () => {
				await fs.writeFile(path.join(cwt, '.env'), 'TOKEN=agent-added-a-real-secret\n');
				const r = await checkDirty(cwt, cowned);
				expect(r.state).toBe('dirty');
				expect(r.dirtyPaths.join(' ')).toContain('.env (was our copy; content edited since)');
				expect(r.excludedOurs).toBe(0);
			});

			it('no recorded hash (older manifest): falls back to existence-only, same as before #829', async () => {
				const r = await checkDirty(cwt, { symlinks: [], copies: cowned.copies }); // no copyHashes
				expect(r.state).toBe('clean');
				expect(r.excludedOurs).toBe(1);
			});

			it('removeWorktree itself refuses outright and touches nothing — git\'s own check does not catch this (it is IGNORED, not untracked) (defence in depth)', async () => {
				await fs.writeFile(path.join(cwt, '.env'), 'TOKEN=agent-added-a-real-secret\n');
				const r = await removeWorktree(repo, cwt, cowned);
				expect(r.ok).toBe(false);
				expect(r.stderr).toContain('.env');
				expect(r.stderr).toContain('edited');
				expect(await fs.readFile(path.join(cwt, '.env'), 'utf8')).toBe('TOKEN=agent-added-a-real-secret\n');
				// The worktree itself is untouched too — this must not be a partial removal.
				await expect(fs.stat(cwt)).resolves.toBeDefined();
			});

			it('removeWorktree deletes an UNedited copy normally', async () => {
				const r = await removeWorktree(repo, cwt, cowned);
				expect(r.ok).toBe(true);
				await expect(fs.stat(path.join(cwt, '.env'))).rejects.toThrow();
			});
		});

		describe('exact recorded paths, never a name pattern (#829 review)', () => {
			const none = { symlinks: [] as string[], copies: [] as string[] };

			/** A fresh repo whose info/exclude has NO worktree patterns, plus one worktree. */
			const freshWorktree = async (): Promise<string> => {
				const other = await makeRepo(path.join(tmp, `other-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`));
				return addWt(other, 'u1');
			};

			describe('visible to git status (no exclude entry for the name)', () => {
				it('an unrecorded REAL node_modules dir with a file reads dirty', async () => {
					const w = await freshWorktree();
					await fs.mkdir(path.join(w, 'node_modules'));
					await fs.writeFile(path.join(w, 'node_modules', 'x.js'), 'x');
					const r = await checkDirty(w, none);
					expect(r.state).toBe('dirty');
					expect(r.dirtyPaths).toEqual(['node_modules/x.js']);
				});

				it('an unrecorded SYMLINK named node_modules reads dirty', async () => {
					const w = await freshWorktree();
					await fs.symlink(tmp, path.join(w, 'node_modules'), 'dir');
					expect((await checkDirty(w, none)).dirtyPaths).toEqual(['node_modules']);
				});

				it('an unrecorded .env (a .worktreeinclude-style name) reads dirty', async () => {
					const w = await freshWorktree();
					await fs.writeFile(path.join(w, '.env'), 'TOKEN=x');
					expect((await checkDirty(w, none)).dirtyPaths).toEqual(['.env']);
				});
			});

			describe('hidden by the SHARED exclude another worktree registered', () => {
				let other: string;
				beforeEach(async () => {
					// wi-d (outer beforeEach) registered /node_modules; register /.env as another worktree's copy would.
					await ensureExcluded(repo, ['.env']);
					other = await addWt(repo, 'wi-other');
				});

				it('an unrecorded REAL node_modules dir reads dirty although git status hides it', async () => {
					await fs.mkdir(path.join(other, 'node_modules'));
					await fs.writeFile(path.join(other, 'node_modules', 'x.js'), 'x');
					expect(await git(other, 'status', '--porcelain')).toBe(''); // plain status sees nothing
					const r = await checkDirty(other, none);
					expect(r.state).toBe('dirty');
					expect(r.dirtyPaths.join(' ')).toContain('node_modules (hidden by the shared worktree exclude');
				});

				it('an unrecorded SYMLINK named node_modules reads dirty', async () => {
					await fs.symlink(tmp, path.join(other, 'node_modules'), 'dir');
					expect((await checkDirty(other, none)).state).toBe('dirty');
				});

				it('an unrecorded .env reads dirty', async () => {
					await fs.writeFile(path.join(other, '.env'), 'TOKEN=x');
					const r = await checkDirty(other, none);
					expect(r.dirtyPaths.join(' ')).toContain('.env (hidden by the shared worktree exclude');
				});

				it('the same names RECORDED for this worktree are excluded (clean)', async () => {
					await fs.symlink(path.join(repo, 'node_modules'), path.join(other, 'node_modules'), 'dir');
					await fs.writeFile(path.join(other, '.env'), 'TOKEN=x');
					const r = await checkDirty(other, { symlinks: ['node_modules'], copies: ['.env'] });
					expect(r.state).toBe('clean');
					expect(r.excludedOurs).toBe(2);
				});
			});
		});

		it('only the RECORDED symlink is excluded — an unrecorded one is dirty', async () => {
			await fs.symlink(path.join(repo, 'README.md'), path.join(wt, 'other-link'));
			const r = await checkDirty(wt, owned);
			expect(r.dirtyPaths).toEqual(['other-link']);
		});

		it('a path that does not exist is UNKNOWN, never clean', async () => {
			const r = await checkDirty(path.join(repo, WORKTREE_CONSTANTS.DIR, 'no-such-id'), owned);
			expect(r.state).toBe('unknown');
			expect(r.summary).toContain('treated as NOT safe');
		});

		it('a directory that is not a worktree root (git would answer for the parent repo) is UNKNOWN', async () => {
			const stray = path.join(repo, WORKTREE_CONSTANTS.DIR, 'stray');
			await fs.mkdir(stray, { recursive: true });
			expect((await checkDirty(stray, owned)).state).toBe('unknown');
			await fs.mkdir(path.join(wt, 'sub'));
			expect((await checkDirty(path.join(wt, 'sub'), owned)).state).toBe('unknown');
		});

		it('a subdirectory WITH tracked files is still UNKNOWN (git would answer for the whole worktree)', async () => {
			await fs.mkdir(path.join(repo, 'lib'));
			await fs.writeFile(path.join(repo, 'lib', 'a.ts'), 'a');
			await git(repo, 'add', 'lib/a.ts');
			await git(repo, 'commit', '-q', '-m', 'lib');
			const wt2 = await addWt(repo, 'wi-sub');
			await fs.writeFile(path.join(wt2, 'README.md'), 'dirty at the root\n');
			const r = await checkDirty(path.join(wt2, 'lib'), owned);
			expect(r).toMatchObject({ state: 'unknown', reason: 'path is not a worktree root' });
		});

		it('a worktree with 0 tracked files is UNKNOWN — an empty examination is never "clean"', async () => {
			const empty = path.join(tmp, 'empty');
			await fs.mkdir(empty);
			await git(empty, 'init', '-q', '-b', 'main');
			await git(empty, 'config', 'user.email', 't@example.com');
			await git(empty, 'config', 'user.name', 'T');
			await git(empty, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'empty');
			const ewt = await addWt(await fs.realpath(empty), 'e1');
			const r = await checkDirty(ewt, { symlinks: [], copies: [] });
			expect(r).toMatchObject({ state: 'unknown', reason: '0 tracked files examined', examined: 0 });
		});

		it('context: git reports "no differences" for a pathspec matching nothing — which is why the guard never uses one', async () => {
			// The 2026-08-21 trap. Documented here so nobody "simplifies" the guard into this.
			const r = await runGit(wt, ['diff', '--quiet', 'HEAD', '--', 'definitely-not-a-real-path']);
			expect(r.ok).toBe(true);
			await fs.writeFile(path.join(wt, 'README.md'), 'changed\n');
			expect((await runGit(wt, ['diff', '--quiet', 'HEAD', '--', 'definitely-not-a-real-path'])).ok).toBe(true);
			expect((await checkDirty(wt, owned)).state).toBe('dirty');
		});
	});

	describe('checkLanded', () => {
		let origin: string;
		let clone: string;
		let wt: string;

		beforeEach(async () => {
			origin = path.join(tmp, 'origin.git');
			await git(tmp, 'clone', '-q', '--bare', repo, origin);
			clone = await fs.realpath(await (async () => { const c = path.join(tmp, 'clone'); await git(tmp, 'clone', '-q', origin, c); return c; })());
			await git(clone, 'config', 'user.email', 't@example.com');
			await git(clone, 'config', 'user.name', 'T');
			await git(clone, 'config', 'commit.gpgsign', 'false');
			wt = await addWt(clone, 'wi-l');
		});

		it('no new commits: HEAD is an ancestor of the base → landed', async () => {
			expect(await checkLanded(wt, 'origin/main')).toMatchObject({ state: 'landed', detail: 'HEAD is an ancestor of origin/main' });
		});

		it('an unpushed commit with origin reachable → not_landed', async () => {
			await fs.writeFile(path.join(wt, 'a.txt'), 'a');
			await git(wt, 'add', 'a.txt');
			await git(wt, 'commit', '-q', '-m', 'a');
			expect((await checkLanded(wt, 'origin/main')).state).toBe('not_landed');
			expect(await commitsBeyond(wt, await git(clone, 'rev-parse', 'origin/main'))).toBe(1);
		});

		it('pushed under ANY branch name → landed (agents push feature branches, not wi/<id>)', async () => {
			await fs.writeFile(path.join(wt, 'a.txt'), 'a');
			await git(wt, 'add', 'a.txt');
			await git(wt, 'commit', '-q', '-m', 'a');
			await git(wt, 'push', '-q', 'origin', 'HEAD:refs/heads/feat/whatever');
			expect(await checkLanded(wt, 'origin/main')).toMatchObject({ state: 'landed', detail: 'HEAD is the tip of a ref on origin' });
		});

		it('offline and not merged → UNKNOWN (keep), never landed', async () => {
			await fs.writeFile(path.join(wt, 'a.txt'), 'a');
			await git(wt, 'add', 'a.txt');
			await git(wt, 'commit', '-q', '-m', 'a');
			await git(clone, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
			expect(await checkLanded(wt, 'origin/main')).toMatchObject({ state: 'unknown', detail: 'origin unreachable and not merged locally' });
		});
	});

	describe('removeWorktree', () => {
		it('removes a clean worktree (our symlink first) and keeps the branch', async () => {
			await fs.mkdir(path.join(repo, 'node_modules'));
			const wt = await addWt(repo, 'wi-r');
			await applySharedPaths(repo, wt, ['node_modules'], []);
			const r = await removeWorktree(repo, wt, { symlinks: ['node_modules'], copies: [] });
			expect(r.ok).toBe(true);
			await expect(fs.stat(wt)).rejects.toThrow();
			expect(await branchExists(repo, 'wi/wi-r')).toBe(true);
			expect(await fs.readdir(path.join(repo, 'node_modules'))).toEqual([]); // the shared source is untouched
		});

		it('git itself refuses a dirty worktree without force (second line of defence)', async () => {
			const wt = await addWt(repo, 'wi-x');
			await fs.writeFile(path.join(wt, 'wip.txt'), 'x');
			const r = await removeWorktree(repo, wt, { symlinks: [], copies: [] });
			expect(r.ok).toBe(false);
			expect(await fs.readFile(path.join(wt, 'wip.txt'), 'utf8')).toBe('x');
		});
	});
});

describe('sanitizeWorktreeId', () => {
	/** git's own opinion of whether `name` is a valid ref component (the authority — not our own regex). */
	async function gitAcceptsAsRef(name: string): Promise<boolean> {
		return (await runGit(os.tmpdir(), ['check-ref-format', '--branch', name])).ok;
	}

	it('a plain id (no special characters) passes through unchanged', async () => {
		expect(sanitizeWorktreeId('w1')).toBe('w1');
		expect(sanitizeWorktreeId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
	});

	it('a verify/retry/review id (colons) becomes a ref git actually accepts', async () => {
		const id = 'abc123:verify:def456';
		const safe = sanitizeWorktreeId(id);
		expect(safe).not.toContain(':');
		expect(await gitAcceptsAsRef(safe)).toBe(true);
	});

	it.each([
		['bad..id', '..'], // git refuses a ".." run
		['bad~id', '~'],
		['bad^id', '^'],
		['bad?id', '?'],
		['bad*id', '*'],
		['bad[id', '['],
		['bad id', ' '],
		['bad\\id', '\\'],
		['.leading-dot', '.'],
		['trailing-dot.', '.'],
		['trailing-slash/', '/'],
		['ends.lock', '.lock'],
		['@', '@'],
	])('"%s" (contains %s, which git rejects) sanitizes into a ref git accepts', async (id) => {
		const safe = sanitizeWorktreeId(id);
		expect(await gitAcceptsAsRef(safe)).toBe(true);
	});

	it('is deterministic — the same id always sanitizes to the same ref (so branch and worktree path stay paired)', () => {
		const id = 'abc:verify:def';
		expect(sanitizeWorktreeId(id)).toBe(sanitizeWorktreeId(id));
	});

	it('never returns the empty string', () => {
		expect(sanitizeWorktreeId('')).not.toBe('');
		expect(sanitizeWorktreeId(':::')).not.toBe('');
	});
});
