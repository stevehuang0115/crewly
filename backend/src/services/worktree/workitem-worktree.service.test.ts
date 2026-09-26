import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import {
	WorkItemWorktreeService,
	type WorktreePool,
	type WorktreeRecord,
	type WorktreeStorage,
} from './workitem-worktree.service.js';
import { runGit, branchExists } from './worktree-git.js';
import { WORKTREE_CONSTANTS } from '../../constants.js';
import type { Project, Team } from '../../types/index.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

async function git(cwd: string, ...args: string[]): Promise<string> {
	const r = await runGit(cwd, args);
	if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
	return r.stdout.trim();
}

async function configure(dir: string): Promise<void> {
	await git(dir, 'config', 'user.email', 't@example.com');
	await git(dir, 'config', 'user.name', 'T');
	await git(dir, 'config', 'commit.gpgsign', 'false');
}

/** In-memory pool with the three operations the service uses. */
function makePool(): WorktreePool & { items: Map<string, WorkItem>; add(wi: Partial<WorkItem> & { id: string }): WorkItem } {
	const items = new Map<string, WorkItem>();
	return {
		items,
		add(wi) {
			const full = { type: 'delegate', owner: 'team_lead', title: wi.id, status: 'queued', createdAt: new Date().toISOString(), retryCount: 0, maxRetries: 1, inputTokens: 0, outputTokens: 0, cost: 0, metadata: {}, ...wi } as WorkItem;
			items.set(wi.id, full);
			return full;
		},
		findWorkItem: jest.fn(async (id: string) => items.get(id) ?? null),
		patchMetadata: jest.fn(async (id: string, key: string, value: unknown) => {
			const wi = items.get(id);
			if (!wi) return null;
			wi.metadata = { ...(wi.metadata ?? {}), [key]: value };
			return wi;
		}),
		appendNote: jest.fn(async (id: string, _author: string, note: string) => {
			const wi = items.get(id);
			if (!wi) return null;
			const notes = ((wi.metadata?.['notes'] as string[]) ?? []).concat(note);
			wi.metadata = { ...(wi.metadata ?? {}), notes };
			return wi;
		}),
	};
}


// Real git on a loaded machine: checkouts can take seconds each.
jest.setTimeout(120_000);

describe('WorkItemWorktreeService', () => {
	let tmp: string;
	let origin: string;
	let repo: string;
	let pool: ReturnType<typeof makePool>;
	let projects: Project[];
	let teams: Team[];
	let notify: jest.Mock;
	let service: WorkItemWorktreeService;

	const storage: WorktreeStorage = { getProjects: async () => projects, getTeams: async () => teams };
	const notes = (id: string): string[] => (pool.items.get(id)?.metadata?.['notes'] as string[]) ?? [];
	const rec = (id: string): WorktreeRecord => pool.items.get(id)?.metadata?.[WORKTREE_CONSTANTS.METADATA_KEY] as WorktreeRecord;
	const wtPath = (id: string): string => path.join(repo, WORKTREE_CONSTANTS.DIR, id);

	beforeEach(async () => {
		tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'wi-wt-')));
		// A bare origin, cloned into the project checkout (so origin/main exists).
		const seed = path.join(tmp, 'seed');
		await fs.mkdir(seed);
		await git(seed, 'init', '-q', '-b', 'main');
		await configure(seed);
		await fs.writeFile(path.join(seed, 'README.md'), 'hello\n');
		await fs.mkdir(path.join(seed, 'app'));
		await fs.writeFile(path.join(seed, 'app', 'index.ts'), 'export const x = 1;\n');
		await git(seed, 'add', '-A');
		await git(seed, 'commit', '-q', '-m', 'init');
		origin = path.join(tmp, 'origin.git');
		await git(tmp, 'clone', '-q', '--bare', seed, origin);
		await git(tmp, 'clone', '-q', origin, path.join(tmp, 'repo'));
		repo = await fs.realpath(path.join(tmp, 'repo'));
		await configure(repo);
		await fs.mkdir(path.join(repo, 'node_modules', 'dep'), { recursive: true });
		await fs.writeFile(path.join(repo, 'node_modules', 'dep', 'index.js'), 'dep');
		await fs.writeFile(path.join(repo, '.env'), 'TOKEN=local\n');
		await fs.writeFile(path.join(repo, '.worktreeinclude'), '.env\n');
		await git(repo, 'add', '.worktreeinclude');
		await git(repo, 'commit', '-q', '-m', 'include');
		await git(repo, 'push', '-q', 'origin', 'main');

		projects = [{ id: 'p1', name: 'P', path: repo, teams: {}, status: 'active', worktrees: 'on', createdAt: '', updatedAt: '' }];
		teams = [{ id: 't1', name: 'T', members: [{ sessionName: 'dev-1' }, { sessionName: 'dev-2' }] as Team['members'], projectIds: ['p1'], createdAt: '', updatedAt: '' }];
		pool = makePool();
		notify = jest.fn().mockResolvedValue(undefined);
		service = new WorkItemWorktreeService({ pool, storage, notify, env: {} });
	});

	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	describe('resolveTarget (opt-in per project, opt-out per team, kill switch)', () => {
		it('an opted-in project, via the target member\'s team', async () => {
			const r = await service.resolveTarget(pool.add({ id: 'w1', target: 'dev-1' }));
			expect(r).toMatchObject({ ok: true, repo });
		});

		it('v1 default: a project without worktrees:"on" gets none', async () => {
			delete projects[0].worktrees;
			expect(await service.resolveTarget(pool.add({ id: 'w1', target: 'dev-1' }))).toEqual({ ok: false, reason: 'project_not_opted_in' });
		});

		it('the team opt-out wins over the project', async () => {
			teams[0].worktrees = 'off';
			expect(await service.resolveTarget(pool.add({ id: 'w1', target: 'dev-1' }))).toEqual({ ok: false, reason: 'team_opted_out' });
		});

		it('CREWLY_WORKTREES=off wins over everything', async () => {
			const off = new WorkItemWorktreeService({ pool, storage, env: { CREWLY_WORKTREES: 'OFF' } });
			expect(await off.resolveTarget(pool.add({ id: 'w1', target: 'dev-1' }))).toEqual({ ok: false, reason: 'kill_switch' });
		});

		it('metadata.projectPath must name a registered project; otherwise the team project is used', async () => {
			const r = await service.resolveTarget(pool.add({ id: 'w1', target: 'nobody', metadata: { projectPath: repo } }));
			expect(r.ok).toBe(true);
			expect(await service.resolveTarget(pool.add({ id: 'w2', target: 'nobody', metadata: { projectPath: tmp } }))).toEqual({ ok: false, reason: 'no_project' });
		});

		it('a non-git project gets none', async () => {
			projects[0].path = path.join(tmp, 'plain');
			await fs.mkdir(projects[0].path);
			expect(await service.resolveTarget(pool.add({ id: 'w1', target: 'dev-1' }))).toEqual({ ok: false, reason: 'not_a_git_repo' });
		});
	});

	describe('ensureWorktree', () => {
		it('creates wi/<id> from origin/main, symlinks node_modules, copies .worktreeinclude files, records it, tells the agent', async () => {
			const record = await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			expect(record).toMatchObject({ state: 'ready', branch: 'wi/w1', baseRef: 'origin/main', symlinks: ['node_modules'], copies: ['.env'], path: wtPath('w1'), workdir: wtPath('w1') });
			expect(await git(wtPath('w1'), 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wi/w1');
			expect((await fs.lstat(path.join(wtPath('w1'), 'node_modules'))).isSymbolicLink()).toBe(true);
			expect(await fs.readFile(path.join(wtPath('w1'), '.env'), 'utf8')).toBe('TOKEN=local\n');
			expect(rec('w1').state).toBe('ready');
			expect(await service.readManifest(repo, 'w1')).toMatchObject({ state: 'ready' });
			expect(notify).toHaveBeenCalledWith('dev-1', expect.stringContaining(wtPath('w1')));
			// The main checkout never sees the worktrees (even though this repo's .gitignore does not cover .crewly/).
			expect(await git(repo, 'status', '--porcelain')).toBe('');
		});

		it('is idempotent', async () => {
			const wi = pool.add({ id: 'w1', target: 'dev-1' });
			const a = await service.ensureWorktree(wi);
			const b = await service.ensureWorktree(wi);
			expect(b?.createdAt).toBe(a?.createdAt);
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('points the agent at the project subdirectory inside the worktree', async () => {
			projects[0].path = path.join(repo, 'app');
			const record = await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			expect(record?.path).toBe(wtPath('w1'));
			expect(record?.workdir).toBe(path.join(wtPath('w1'), 'app'));
		});

		it('returns null (and creates nothing) for a WorkItem that gets no worktree', async () => {
			delete projects[0].worktrees;
			expect(await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }))).toBeNull();
			await expect(fs.stat(path.join(repo, WORKTREE_CONSTANTS.DIR))).rejects.toThrow();
		});

		it('SERIALISES creation per repo: 5 WorkItems queued at once never run 2 checkouts in parallel', async () => {
			const wis = ['a', 'b', 'c', 'd', 'e'].map((id) => pool.add({ id, target: 'dev-1' }));
			const records = await Promise.all(wis.map((wi) => service.ensureWorktree(wi)));
			expect(records.map((r) => r?.state)).toEqual(['ready', 'ready', 'ready', 'ready', 'ready']);
			expect(service.maxConcurrent.get(repo)).toBe(1);
		});

		it('records a failure on the WorkItem instead of throwing', async () => {
			// A branch name git refuses (the id contains "..").
			const record = await service.ensureWorktree(pool.add({ id: 'bad..id', target: 'dev-1' }));
			expect(record?.state).toBe('failed');
			expect(notes('bad..id').join(' ')).toContain('worktree not created');
		});
	});

	it('INTEGRATION: two WorkItems on the same repo work in separate worktrees without interfering', async () => {
		const [r1, r2] = await Promise.all([
			service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' })),
			service.ensureWorktree(pool.add({ id: 'w2', target: 'dev-2' })),
		]);
		// Both edit the SAME file differently and commit.
		await fs.writeFile(path.join(r1!.workdir, 'README.md'), 'from w1\n');
		await fs.writeFile(path.join(r2!.workdir, 'README.md'), 'from w2\n');
		await fs.writeFile(path.join(r1!.workdir, 'only-w1.txt'), '1');
		for (const [r, msg] of [[r1!, 'w1'], [r2!, 'w2']] as const) {
			await git(r.path, 'add', '-A');
			await git(r.path, 'commit', '-q', '-m', msg);
		}
		expect(await git(repo, 'show', 'wi/w1:README.md')).toBe('from w1');
		expect(await git(repo, 'show', 'wi/w2:README.md')).toBe('from w2');
		expect((await runGit(repo, ['cat-file', '-e', 'wi/w2:only-w1.txt'])).ok).toBe(false);
		// Neither commit swept the shared symlink or the .env copy in.
		expect(await git(repo, 'show', '--name-only', '--format=', 'wi/w1')).toBe('README.md\nonly-w1.txt');
		// The shared checkout is untouched.
		expect(await fs.readFile(path.join(repo, 'README.md'), 'utf8')).toBe('hello\n');
		expect(await git(repo, 'status', '--porcelain')).toBe('');
	});

	describe('cleanup', () => {
		it('cancelled + clean → removed; branch kept; the shared node_modules is untouched', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			const out = await service.cleanup('w1', 'cancelled');
			expect(out?.action).toBe('removed');
			expect(out?.dirty?.summary).toMatch(/path\(s\) examined, 2 excluded as our symlinks\/copies, 0 dirty$/);
			await expect(fs.stat(wtPath('w1'))).rejects.toThrow();
			expect(await branchExists(repo, 'wi/w1')).toBe(true);
			expect(await fs.readFile(path.join(repo, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('dep');
			expect(rec('w1').state).toBe('removed');
		});

		it('cancelled + dirty → KEPT with the reason on the WorkItem; nothing deleted', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await fs.writeFile(path.join(wtPath('w1'), 'wip.txt'), 'unsaved work');
			const out = await service.cleanup('w1', 'cancelled');
			expect(out).toMatchObject({ action: 'kept' });
			expect(out?.why).toContain('1 dirty — wip.txt');
			expect(await fs.readFile(path.join(wtPath('w1'), 'wip.txt'), 'utf8')).toBe('unsaved work');
			expect(rec('w1')).toMatchObject({ state: 'kept' });
		});

		it('done + clean + an UNPUSHED commit → kept (not landed)', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await fs.writeFile(path.join(wtPath('w1'), 'a.txt'), 'a');
			await git(wtPath('w1'), 'add', 'a.txt');
			await git(wtPath('w1'), 'commit', '-q', '-m', 'a');
			const out = await service.cleanup('w1', 'done');
			expect(out).toMatchObject({ action: 'kept', landed: { state: 'not_landed' } });
		});

		it('done + clean + pushed → removed', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await fs.writeFile(path.join(wtPath('w1'), 'a.txt'), 'a');
			await git(wtPath('w1'), 'add', 'a.txt');
			await git(wtPath('w1'), 'commit', '-q', '-m', 'a');
			await git(wtPath('w1'), 'push', '-q', 'origin', 'HEAD:refs/heads/feat/a');
			expect((await service.cleanup('w1', 'done'))?.action).toBe('removed');
		});

		it('verified + commit + origin unreachable → kept (unknown is never safe)', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await fs.writeFile(path.join(wtPath('w1'), 'a.txt'), 'a');
			await git(wtPath('w1'), 'add', 'a.txt');
			await git(wtPath('w1'), 'commit', '-q', '-m', 'a');
			await git(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'gone.git'));
			expect(await service.cleanup('w1', 'verified')).toMatchObject({ action: 'kept', landed: { state: 'unknown' } });
		});

		it('a requeued WorkItem gets its worktree back on the kept branch', async () => {
			const wi = pool.add({ id: 'w1', target: 'dev-1' });
			await service.ensureWorktree(wi);
			await fs.writeFile(path.join(wtPath('w1'), 'a.txt'), 'a');
			await git(wtPath('w1'), 'add', 'a.txt');
			await git(wtPath('w1'), 'commit', '-q', '-m', 'a');
			expect((await service.cleanup('w1', 'cancelled'))?.action).toBe('removed');
			const again = await service.ensureWorktree(wi);
			expect(again?.state).toBe('ready');
			expect(await fs.readFile(path.join(wtPath('w1'), 'a.txt'), 'utf8')).toBe('a');
		});

		it('a WorkItem without a worktree is a no-op', async () => {
			pool.add({ id: 'w1', target: 'dev-1' });
			expect(await service.cleanup('w1', 'cancelled')).toBeNull();
		});
	});

	describe('detectWorkedOutside (report only)', () => {
		it('0 commits on the branch + shared-checkout edits since creation → warning note', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await fs.writeFile(path.join(repo, 'README.md'), 'edited in the shared checkout\n');
			const r = await service.detectWorkedOutside('w1');
			expect(r).toMatchObject({ suspected: true, commitsOnBranch: 0, sharedChanges: ['README.md'] });
			expect(notes('w1').join(' ')).toContain('worked outside its worktree');
		});

		it('commits on the branch → not suspected, no note', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await fs.writeFile(path.join(wtPath('w1'), 'a.txt'), 'a');
			await git(wtPath('w1'), 'add', 'a.txt');
			await git(wtPath('w1'), 'commit', '-q', '-m', 'a');
			await fs.writeFile(path.join(repo, 'README.md'), 'someone else\n');
			expect(await service.detectWorkedOutside('w1')).toMatchObject({ suspected: false, commitsOnBranch: 1 });
			expect(notes('w1')).toEqual([]);
		});

		it('shared-checkout changes OLDER than the worktree are not attributed to it', async () => {
			await fs.writeFile(path.join(repo, 'README.md'), 'old local edit\n');
			const past = new Date(Date.now() - 60 * 60 * 1000);
			await fs.utimes(path.join(repo, 'README.md'), past, past);
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			expect(await service.detectWorkedOutside('w1')).toMatchObject({ suspected: false, sharedChanges: [] });
		});
	});

	describe('sweep (orphans)', () => {
		it('a pre-created worktree whose WorkItem was never claimed is removed once the WorkItem is terminal, and counted', async () => {
			const wi = pool.add({ id: 'w1', target: 'dev-1' });
			await service.ensureWorktree(wi);
			expect((await service.sweep()).repos[0]).toMatchObject({ listed: 1, examined: 1, active: 1, removed: 0 });
			wi.status = 'cancelled';
			const report = await service.sweep();
			expect(report.reposExamined).toBe(1);
			expect(report.repos[0]).toMatchObject({ listed: 1, examined: 1, removed: 1, active: 0 });
			await expect(fs.stat(wtPath('w1'))).rejects.toThrow();
		});

		it('a WorkItem that no longer exists: removed only when clean AND landed', async () => {
			await service.ensureWorktree(pool.add({ id: 'w1', target: 'dev-1' }));
			await service.ensureWorktree(pool.add({ id: 'w2', target: 'dev-1' }));
			await fs.writeFile(path.join(wtPath('w2'), 'a.txt'), 'a');
			await git(wtPath('w2'), 'add', 'a.txt');
			await git(wtPath('w2'), 'commit', '-q', '-m', 'a');
			pool.items.clear();
			expect((await service.sweep()).repos[0]).toMatchObject({ examined: 2, removed: 1, keptNotLanded: 1 });
			await expect(fs.stat(wtPath('w1'))).rejects.toThrow();
			expect(await fs.readFile(path.join(wtPath('w2'), 'a.txt'), 'utf8')).toBe('a');
		});

		it('a dirty leftover is kept and reported ONCE', async () => {
			const wi = pool.add({ id: 'w1', target: 'dev-1' });
			await service.ensureWorktree(wi);
			await fs.writeFile(path.join(wtPath('w1'), 'wip.txt'), 'x');
			wi.status = 'cancelled';
			expect((await service.sweep()).repos[0]).toMatchObject({ keptDirty: 1, removed: 0 });
			await service.sweep();
			expect(notes('w1').filter((n) => n.includes('leftover worktree kept'))).toHaveLength(1);
		});

		it('REFUSES to act when the directory lists entries but none parse as registered worktrees', async () => {
			await fs.mkdir(path.join(repo, WORKTREE_CONSTANTS.DIR, 'stray-1'), { recursive: true });
			await fs.writeFile(path.join(repo, WORKTREE_CONSTANTS.DIR, 'stray-1', 'keep.txt'), 'x');
			const r = (await service.sweep()).repos[0];
			expect(r).toMatchObject({ listed: 1, examined: 0, removed: 0 });
			expect(r.refused).toContain('refusing to act on an empty examination');
			expect(await fs.readFile(path.join(repo, WORKTREE_CONSTANTS.DIR, 'stray-1', 'keep.txt'), 'utf8')).toBe('x');
		});

		it('a registered worktree without a manifest is kept (unknown ownership)', async () => {
			await fs.mkdir(path.join(repo, WORKTREE_CONSTANTS.DIR), { recursive: true });
			await git(repo, 'worktree', 'add', '-q', wtPath('by-hand'), '-b', 'by-hand');
			expect((await service.sweep()).repos[0]).toMatchObject({ examined: 1, keptUnknown: 1, removed: 0 });
			expect((await fs.stat(wtPath('by-hand'))).isDirectory()).toBe(true);
		});

		it('repos without a worktree directory are not examined', async () => {
			expect(await service.sweep()).toEqual({ reposExamined: 0, repos: [] });
		});
	});
});
