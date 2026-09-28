/**
 * Tests for WorktreeJanitorService — against real temporary git repos (an
 * origin bare repo + a clone with worktrees). Nothing outside os.tmpdir() is
 * touched: repo paths, busy-cwd probe and gh are all injected.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorktreeJanitorService, type WorktreeJanitorOptions, type JanitorRunSummary } from './worktree-janitor.service.js';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';

const THREE_HOURS = 3 * 60 * 60 * 1000;

/** Isolated git env: no user/system config (signing, hooks), fixed identity. */
const GIT_ENV: NodeJS.ProcessEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_TERMINAL_PROMPT: '0',
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

interface Fixture {
	root: string;
	origin: string;
	repo: string;
}

function makeFixture(): Fixture {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-janitor-')));
	const origin = path.join(root, 'origin.git');
	const repo = path.join(root, 'repo');
	git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
	git(root, 'init', '--quiet', '-b', 'main', repo);
	fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
	fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\ndist/\n');
	git(repo, 'add', '.');
	git(repo, 'commit', '--quiet', '-m', 'init');
	git(repo, 'remote', 'add', 'origin', origin);
	git(repo, 'push', '--quiet', '-u', 'origin', 'main');
	return { root, origin, repo };
}

/** Add a worktree with one commit of its own. */
function addWorktree(fx: Fixture, wtPath: string, branch: string, opts: { commit?: boolean } = {}): string {
	fs.mkdirSync(path.dirname(wtPath), { recursive: true });
	git(fx.repo, 'worktree', 'add', '--quiet', '-b', branch, wtPath, 'main');
	if (opts.commit !== false) {
		fs.writeFileSync(path.join(wtPath, `${branch.replace(/\//g, '-')}.txt`), `${branch}\n`);
		git(wtPath, 'add', '.');
		git(wtPath, 'commit', '--quiet', '-m', `work on ${branch}`);
	}
	return wtPath;
}

function agentPath(fx: Fixture, name: string): string {
	return path.join(fx.repo, WORKTREE_JANITOR_CONSTANTS.AGENT_WORKTREE_DIR, name);
}

/** Land the worktree's HEAD on origin/main (fast-forward, i.e. a merge commit-preserving merge). */
function landOnOrigin(wtPath: string): void {
	git(wtPath, 'push', '--quiet', 'origin', 'HEAD:main');
}

function branchExists(repo: string, branch: string): boolean {
	try {
		git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`);
		return true;
	} catch {
		return false;
	}
}

function janitor(fx: Fixture, overrides: WorktreeJanitorOptions = {}): WorktreeJanitorService {
	return new WorktreeJanitorService({
		listRepoPaths: async () => [fx.repo],
		listBusyCwds: async () => [],
		ghBin: null,
		now: () => Date.now() + THREE_HOURS,
		tmpRoots: [],
		env: {},
		logger: { info: jest.fn(), warn: jest.fn() },
		...overrides,
	});
}

function verdictFor(summary: JanitorRunSummary, wtPath: string) {
	const real = fs.existsSync(wtPath) ? fs.realpathSync(wtPath) : wtPath;
	return summary.worktrees.find((w) => w.path === wtPath || w.path === real);
}

describe('WorktreeJanitorService', () => {
	let fx: Fixture;

	beforeEach(() => {
		fx = makeFixture();
	});

	afterEach(() => {
		fs.rmSync(fx.root, { recursive: true, force: true });
	});

	it('removes a clean, idle agent worktree whose HEAD is an ancestor of origin/main, and deletes its branch', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'merged'), 'feat/merged');
		landOnOrigin(wt);
		const summary = await janitor(fx).run();
		const v = verdictFor(summary, wt);
		expect(v).toMatchObject({ decision: 'remove', reason: 'merged', removed: true, branchDeleted: true });
		expect(fs.existsSync(wt)).toBe(false);
		expect(branchExists(fx.repo, 'feat/merged')).toBe(false);
		expect(summary.removed).toBe(1);
		expect(git(fx.repo, 'worktree', 'list')).not.toContain('merged');
	});

	it('picks up merges it only sees after git fetch (origin moved behind its back)', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'late'), 'feat/late');
		// Push via a second clone so the repo's origin/main ref is stale until fetch.
		const other = path.join(fx.root, 'other');
		git(fx.root, 'clone', '--quiet', fx.origin, other);
		git(other, 'fetch', '--quiet', fx.repo, 'feat/late');
		git(other, 'push', '--quiet', 'origin', 'FETCH_HEAD:main');
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ reason: 'merged', removed: true });
	});

	it('keeps a worktree with a modified tracked file (dirty)', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'dirty'), 'feat/dirty');
		landOnOrigin(wt);
		fs.appendFileSync(path.join(wt, 'README.md'), 'edit\n');
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'dirty', removed: false });
		expect(fs.existsSync(wt)).toBe(true);
		expect(branchExists(fx.repo, 'feat/dirty')).toBe(true);
	});

	it('keeps a worktree with an untracked (not ignored) file', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'untracked'), 'feat/untracked');
		landOnOrigin(wt);
		fs.mkdirSync(path.join(wt, 'notes'));
		fs.writeFileSync(path.join(wt, 'notes', 'todo.md'), 'x\n');
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'dirty' });
		expect(fs.existsSync(path.join(wt, 'notes', 'todo.md'))).toBe(true);
	});

	it('removes a merged worktree whose only leftovers are ignored build output', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'ignored'), 'feat/ignored');
		landOnOrigin(wt);
		fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
		fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'index.js'), '');
		fs.mkdirSync(path.join(wt, 'dist'));
		fs.writeFileSync(path.join(wt, 'dist', 'out.js'), '');
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ reason: 'merged', removed: true });
		expect(fs.existsSync(wt)).toBe(false);
	});

	it('keeps a worktree whose symlinked node_modules is not ignored (a symlink does not match `node_modules/`)', async () => {
		const shared = path.join(fx.root, 'shared-node-modules');
		fs.mkdirSync(shared);
		const wt = addWorktree(fx, agentPath(fx, 'symlink-unignored'), 'feat/symlink-unignored');
		landOnOrigin(wt);
		fs.symlinkSync(shared, path.join(wt, 'node_modules'));
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'dirty' });
	});

	it('does not follow an ignored symlinked node_modules when removing', async () => {
		// Same as the owner's clone and #814: `node_modules` (no trailing slash) in info/exclude.
		fs.appendFileSync(path.join(fx.repo, '.git', 'info', 'exclude'), '\n/node_modules\n');
		const shared = path.join(fx.root, 'shared-node-modules');
		fs.mkdirSync(shared);
		fs.writeFileSync(path.join(shared, 'keep.js'), '');
		const wt = addWorktree(fx, agentPath(fx, 'symlink'), 'feat/symlink');
		landOnOrigin(wt);
		fs.symlinkSync(shared, path.join(wt, 'node_modules'));
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ removed: true });
		expect(fs.existsSync(path.join(shared, 'keep.js'))).toBe(true);
	});

	it('keeps a worktree touched less than 2 hours ago (recent)', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'recent'), 'feat/recent');
		landOnOrigin(wt);
		const summary = await janitor(fx, { now: () => Date.now() }).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'recent' });
		expect(fs.existsSync(wt)).toBe(true);
	});

	it('keeps a locked worktree', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'locked'), 'feat/locked');
		landOnOrigin(wt);
		git(fx.repo, 'worktree', 'lock', '--reason', 'claude agent running', wt);
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'locked', detail: 'claude agent running' });
		expect(fs.existsSync(wt)).toBe(true);
	});

	it('never touches the main worktree', async () => {
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, fx.repo)).toMatchObject({ decision: 'keep', reason: 'main-worktree' });
		expect(fs.existsSync(path.join(fx.repo, 'README.md'))).toBe(true);
	});

	it('keeps a worktree an agent session is working inside', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'busy'), 'feat/busy');
		landOnOrigin(wt);
		fs.mkdirSync(path.join(wt, 'src'));
		const summary = await janitor(fx, {
			listBusyCwds: async () => [{ cwd: path.join(wt, 'src'), source: 'agent-session' }],
		}).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'agent-session-inside' });
		expect(fs.existsSync(wt)).toBe(true);
	});

	it('keeps a worktree some other process has as its cwd', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'proc'), 'feat/proc');
		landOnOrigin(wt);
		const summary = await janitor(fx, { listBusyCwds: async () => [{ cwd: wt, source: 'process' }] }).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'process-inside' });
	});

	it('does not treat a sibling with a common prefix as "inside"', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'ab'), 'feat/ab');
		landOnOrigin(wt);
		const summary = await janitor(fx, {
			listBusyCwds: async () => [{ cwd: agentPath(fx, 'a'), source: 'agent-session' }],
		}).run();
		expect(verdictFor(summary, wt)).toMatchObject({ removed: true });
	});

	it('keeps everything when the cwd probe fails', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'probe'), 'feat/probe');
		landOnOrigin(wt);
		const summary = await janitor(fx, { listBusyCwds: async () => null }).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'cwd-probe-failed' });
	});

	it('keeps a worktree whose work is not merged', async () => {
		const wt = addWorktree(fx, agentPath(fx, 'open'), 'feat/open');
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
		expect(branchExists(fx.repo, 'feat/open')).toBe(true);
	});

	describe('gh MERGED path (squash merges)', () => {
		function fakeGh(prs: unknown, authOk = true): string {
			const bin = path.join(fx.root, 'fake-gh');
			const json = path.join(fx.root, 'prs.json');
			fs.writeFileSync(json, JSON.stringify(prs));
			fs.writeFileSync(
				bin,
				[
					'#!/bin/sh',
					`if [ "$1" = "auth" ]; then exit ${authOk ? 0 : 1}; fi`,
					'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
					`  echo "$@" >> "${path.join(fx.root, 'gh-calls.log')}"`,
					`  cat "${json}"; exit 0`,
					'fi',
					'exit 2',
				].join('\n'),
				{ mode: 0o755 },
			);
			return bin;
		}

		function squashOnOrigin(fxx: Fixture, wt: string): void {
			// Land the same content as a different commit (squash) on origin/main.
			const other = path.join(fxx.root, 'squash');
			git(fxx.root, 'clone', '--quiet', fxx.origin, other);
			for (const f of fs.readdirSync(wt)) {
				if (f.endsWith('.txt')) fs.copyFileSync(path.join(wt, f), path.join(other, f));
			}
			git(other, 'add', '.');
			git(other, 'commit', '--quiet', '-m', 'squashed PR');
			git(other, 'push', '--quiet', 'origin', 'main');
		}

		it('removes the worktree and deletes the branch when gh reports a MERGED PR at the same HEAD', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'squashed'), 'feat/squashed');
			squashOnOrigin(fx, wt);
			const head = git(wt, 'rev-parse', 'HEAD');
			const gh = fakeGh([{ number: 42, headRefOid: head, state: 'MERGED' }]);
			const summary = await janitor(fx, { ghBin: gh }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'pr-merged', detail: 'PR #42 merged', removed: true, branchDeleted: true });
			expect(fs.existsSync(wt)).toBe(false);
			expect(branchExists(fx.repo, 'feat/squashed')).toBe(false);
			expect(fs.readFileSync(path.join(fx.root, 'gh-calls.log'), 'utf-8')).toContain('--head feat/squashed --state merged');
		});

		it('keeps the worktree when commits were added after the PR was merged', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'more'), 'feat/more');
			const mergedHead = git(wt, 'rev-parse', 'HEAD');
			squashOnOrigin(fx, wt);
			fs.writeFileSync(path.join(wt, 'followup.md'), 'x\n');
			git(wt, 'add', '.');
			git(wt, 'commit', '--quiet', '-m', 'follow-up');
			const gh = fakeGh([{ number: 7, headRefOid: mergedHead, state: 'MERGED' }]);
			const summary = await janitor(fx, { ghBin: gh }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
			expect(branchExists(fx.repo, 'feat/more')).toBe(true);
		});

		it('ignores gh when it is not authenticated', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'noauth'), 'feat/noauth');
			const head = git(wt, 'rev-parse', 'HEAD');
			const gh = fakeGh([{ number: 1, headRefOid: head, state: 'MERGED' }], false);
			const summary = await janitor(fx, { ghBin: gh }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
		});

		it('ignores a missing gh binary', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'nogh'), 'feat/nogh');
			const summary = await janitor(fx, { ghBin: path.join(fx.root, 'does-not-exist') }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
		});
	});

	describe('which worktrees are agent worktrees', () => {
		it('keeps a merged worktree outside .claude/worktrees on a human branch', async () => {
			const wt = addWorktree(fx, path.join(fx.root, 'repo-wt-805'), 'fix/805');
			landOnOrigin(wt);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-agent-worktree' });
			expect(fs.existsSync(wt)).toBe(true);
		});

		it('removes a merged worktree elsewhere when its branch has an agent-only prefix', async () => {
			const wt = addWorktree(fx, path.join(fx.root, 'elsewhere'), 'worktree-agent-abc123');
			landOnOrigin(wt);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'merged', removed: true });
		});

		it('treats <tmp>/crewly-worktrees/ as an agent location', async () => {
			const tmpRoot = path.join(fx.root, 'fake-tmp');
			const wt = addWorktree(fx, path.join(tmpRoot, WORKTREE_JANITOR_CONSTANTS.TMP_WORKTREE_DIR, 'sam-task'), 'feat/sam-task');
			landOnOrigin(wt);
			const summary = await janitor(fx, { tmpRoots: [tmpRoot] }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'merged', removed: true });
		});

		it('leaves .crewly/worktrees to the per-WorkItem worktree feature', async () => {
			const wt = addWorktree(fx, path.join(fx.repo, WORKTREE_JANITOR_CONSTANTS.MANAGED_WORKTREE_DIR, 'wi-1'), 'wi/wi-1');
			landOnOrigin(wt);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'managed-by-workitem-worktrees' });
		});

		it('removes a merged detached-HEAD agent worktree (no branch to delete)', async () => {
			const wt = agentPath(fx, 'detached');
			fs.mkdirSync(path.dirname(wt), { recursive: true });
			git(fx.repo, 'worktree', 'add', '--quiet', '--detach', wt, 'main');
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ branch: null, reason: 'merged', removed: true, branchDeleted: false });
		});
	});

	describe('kill switch and scheduling', () => {
		afterEach(() => {
			jest.useRealTimers();
		});

		it('CREWLY_WORKTREE_JANITOR=0 stops run() and start()', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'killed'), 'feat/killed');
			landOnOrigin(wt);
			const j = janitor(fx, { env: { CREWLY_WORKTREE_JANITOR: '0' } });
			expect(j.isDisabled()).toBe(true);
			expect(j.start()).toBe(false);
			const summary = await j.run();
			expect(summary).toMatchObject({ disabled: true, removed: 0 });
			expect(fs.existsSync(wt)).toBe(true);
		});

		it('schedules the first pass after FIRST_RUN_DELAY_MS, then every INTERVAL_MS', () => {
			jest.useFakeTimers();
			const j = janitor(fx);
			const runSpy = jest.spyOn(j, 'run').mockResolvedValue({} as JanitorRunSummary);
			expect(j.start()).toBe(true);
			expect(j.start()).toBe(false);
			jest.advanceTimersByTime(WORKTREE_JANITOR_CONSTANTS.FIRST_RUN_DELAY_MS - 1);
			expect(runSpy).not.toHaveBeenCalled();
			jest.advanceTimersByTime(1);
			expect(runSpy).toHaveBeenCalledTimes(1);
			jest.advanceTimersByTime(WORKTREE_JANITOR_CONSTANTS.INTERVAL_MS);
			expect(runSpy).toHaveBeenCalledTimes(2);
			j.stop();
			jest.advanceTimersByTime(WORKTREE_JANITOR_CONSTANTS.INTERVAL_MS * 3);
			expect(runSpy).toHaveBeenCalledTimes(2);
		});
	});

	describe('dry run and summary', () => {
		it('plan() removes nothing and reports wouldRemove', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'planned'), 'feat/planned');
			landOnOrigin(wt);
			const j = janitor(fx);
			const plan = await j.plan();
			expect(plan).toMatchObject({ dryRun: true, removed: 0, wouldRemove: 1 });
			expect(verdictFor(plan, wt)).toMatchObject({ decision: 'remove', removed: false });
			expect(fs.existsSync(wt)).toBe(true);
			expect(j.getLastSummary()).toBeNull();
		});

		it('logs one summary line with kept reasons and never throws on a broken repo list', async () => {
			addWorktree(fx, agentPath(fx, 'x1'), 'feat/x1');
			const logger = { info: jest.fn(), warn: jest.fn() };
			const j = janitor(fx, {
				logger,
				listRepoPaths: async () => [fx.repo, fx.repo, path.join(fx.root, 'not-a-repo'), '/definitely/missing'],
			});
			const summary = await j.run();
			expect(summary.repos).toHaveLength(1);
			expect(logger.info).toHaveBeenCalledTimes(1);
			expect(logger.info.mock.calls[0][0]).toMatch(/^Worktree janitor: removed 0, kept 2 \(.*not-merged: 1.*\)/);
			expect(j.getLastSummary()).toBe(summary);

			const failing = janitor(fx, { listRepoPaths: async () => { throw new Error('boom'); } });
			await expect(failing.run()).resolves.toMatchObject({ removed: 0, repos: [] });
		});

		it('shares one in-flight pass between concurrent run() calls', async () => {
			const j = janitor(fx);
			const [a, b] = await Promise.all([j.run(), j.run()]);
			expect(a).toBe(b);
		});
	});
});
