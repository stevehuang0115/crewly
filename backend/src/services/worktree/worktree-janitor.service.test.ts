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
import { ORCHESTRATOR_SESSION_NAME, WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';
import { TraceStore, setTraceStoreForTesting } from '../trace/trace-store.js';

const HOUR = 60 * 60 * 1000;
const THREE_HOURS = 3 * HOUR;
const GB = 1024 ** 3;

/** statfs stub reporting `freeGb` GB free. */
function statfsWith(freeGb: () => number) {
	return async () => ({ bavail: Math.round(freeGb() * GB) / 4096, bsize: 4096 });
}

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
		listScheduledCwds: async () => [],
		ghBin: null,
		now: () => Date.now() + THREE_HOURS,
		tmpRoots: [],
		scratchRoots: [],
		statfs: statfsWith(() => 100),
		statePath: null,
		tierStatePath: null,
		// crewly#1354 deletes are armed in tests unless a test checks the arming itself.
		armed: true,
		claudeHomes: [],
		tmpRoot: null,
		logsDir: null,
		sizeOf: async () => GB,
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

	it('reports the run traces folder and prunes the oldest traces past its cap (plan only reports)', async () => {
		const traceDir = path.join(fx.root, 'traces');
		// Written by a store with the default cap (its own daily sweep runs now)…
		const writer = new TraceStore({ dir: traceDir, indexFlushDelayMs: 5 });
		writer.createRoot({ traceId: 'tr-20261003-0000aaaa', kind: 'request', summary: 'TKT-001', createdAt: new Date().toISOString(), actor: { kind: 'owner' }, refs: {} });
		await writer.flush();
		await writer.sweep();
		writer.dispose();
		// …then seen by the janitor through a store whose cap it is over.
		const store = new TraceStore({ dir: traceDir, maxTotalBytes: 1, indexFlushDelayMs: 5 });
		setTraceStoreForTesting(store);
		try {
			const planned = await janitor(fx).plan();
			expect(planned.traces).toMatchObject({ files: 1, prunedTraces: 1, capBytes: 1 });
			expect(planned.traces!.bytes).toBeGreaterThan(0);
			expect(store.has('tr-20261003-0000aaaa')).toBe(true);
			const ran = await janitor(fx).run();
			expect(ran.traces).toMatchObject({ prunedTraces: 1 });
			expect(store.has('tr-20261003-0000aaaa')).toBe(false);
		} finally {
			await store.flush();
			setTraceStoreForTesting(null);
		}
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

	it('treats an un-ignored symlinked node_modules as regenerable and never follows it when removing', async () => {
		const shared = path.join(fx.root, 'shared-node-modules');
		fs.mkdirSync(shared);
		fs.writeFileSync(path.join(shared, 'keep.js'), '');
		const wt = addWorktree(fx, agentPath(fx, 'symlink-unignored'), 'feat/symlink-unignored');
		landOnOrigin(wt);
		fs.symlinkSync(shared, path.join(wt, 'node_modules'));
		const summary = await janitor(fx).run();
		expect(verdictFor(summary, wt)).toMatchObject({ removed: true });
		expect(fs.existsSync(path.join(shared, 'keep.js'))).toBe(true);
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

	describe('scheduled-command cwds', () => {
		it('keeps a clean, merged worktree that is the cwd of a scheduled command, and reports how many cwds it read', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'sched'), 'feat/sched');
			landOnOrigin(wt);
			const summary = await janitor(fx, { listScheduledCwds: async () => [wt] }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'scheduled-command', detail: wt });
			expect(summary.scheduledCwdsRead).toBe(1);
			expect(fs.existsSync(wt)).toBe(true);
		});

		it('keeps a worktree that contains the scheduled cwd', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'schedsub'), 'feat/schedsub');
			landOnOrigin(wt);
			const summary = await janitor(fx, { listScheduledCwds: async () => [path.join(wt, 'scripts')] }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'scheduled-command' });
		});

		it('still removes an unrelated clean merged worktree (nothing is protected when none match)', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'unrelated'), 'feat/unrelated');
			landOnOrigin(wt);
			const summary = await janitor(fx, { listScheduledCwds: async () => [agentPath(fx, 'other')] }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ removed: true });
			expect(summary.scheduledCwdsRead).toBe(1);
		});

		it('removes the same worktree when no scheduled command points at it (read zero, protected nothing)', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'zero'), 'feat/zero');
			landOnOrigin(wt);
			const summary = await janitor(fx, { listScheduledCwds: async () => [] }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ removed: true });
			expect(summary.scheduledCwdsRead).toBe(0);
		});

		it('keeps every clean worktree when the scheduled config cannot be read', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'schedprobe'), 'feat/schedprobe');
			landOnOrigin(wt);
			const summary = await janitor(fx, { listScheduledCwds: async () => null }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'scheduled-probe-failed' });
			expect(summary.scheduledCwdsRead).toBeNull();
		});
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

	describe('squash merges on a non-GitHub host (Bitbucket-style)', () => {
		/** Land a branch as ONE squash commit on origin/main, authored elsewhere. */
		function squashOnOrigin(fxx: Fixture, wt: string, extra?: (other: string) => void): void {
			const other = path.join(fxx.root, `squash-${path.basename(wt)}`);
			git(fxx.root, 'clone', '--quiet', fxx.origin, other);
			const mb = git(wt, 'merge-base', 'HEAD', 'origin/main');
			const diff = execFileSync('git', ['diff', '--binary', mb, 'HEAD'], { cwd: wt, env: GIT_ENV, maxBuffer: 1 << 26 });
			execFileSync('git', ['apply', '-'], { cwd: other, env: GIT_ENV, input: diff });
			git(other, 'add', '.');
			git(other, 'commit', '--quiet', '-m', 'squashed PR');
			extra?.(other);
			git(other, 'push', '--quiet', 'origin', 'main');
		}

		function useBitbucketRemote(fxx: Fixture): void {
			// The janitor only reads the URL; fetches use an insteadOf rewrite to the local bare repo.
			git(fxx.repo, 'config', `url.${fxx.origin}.insteadOf`, 'git@bitbucket.org:team/repo.git');
			git(fxx.repo, 'remote', 'set-url', 'origin', 'git@bitbucket.org:team/repo.git');
		}

		it('removes a squash-merged worktree: content is contained in origin/main', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'sq1'), 'feat/sq1');
			fs.writeFileSync(path.join(wt, 'second.txt'), '2\n');
			git(wt, 'add', '.');
			git(wt, 'commit', '--quiet', '-m', 'second commit');
			squashOnOrigin(fx, wt);
			useBitbucketRemote(fx);
			const gh = path.join(fx.root, 'gh-must-not-run');
			fs.writeFileSync(gh, `#!/bin/sh\necho called >> "${path.join(fx.root, 'gh-ran')}"\nexit 0\n`, { mode: 0o755 });
			const summary = await janitor(fx, { ghBin: gh }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'content-landed', removed: true, branchDeleted: true });
			expect(fs.existsSync(wt)).toBe(false);
			expect(fs.existsSync(path.join(fx.root, 'gh-ran'))).toBe(false);
		});

		it('removes it via squash patch-equivalence when main has since changed the same file', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'sq2'), 'feat/sq2');
			fs.appendFileSync(path.join(wt, 'README.md'), 'branch line\n');
			git(wt, 'commit', '--quiet', '-am', 'edit readme');
			squashOnOrigin(fx, wt, (other) => {
				fs.appendFileSync(path.join(other, 'README.md'), 'later change on main\n');
				git(other, 'commit', '--quiet', '-am', 'follow-up on main');
			});
			useBitbucketRemote(fx);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'content-landed', detail: expect.stringContaining('squash-equivalent'), removed: true });
		});

		it('keeps a worktree with unmerged commits that exist on no remote', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'sq3'), 'feat/sq3');
			useBitbucketRemote(fx);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
			expect(branchExists(fx.repo, 'feat/sq3')).toBe(true);
		});

		it('keeps it when a commit was added after the squash merge', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'sq4'), 'feat/sq4');
			squashOnOrigin(fx, wt);
			fs.writeFileSync(path.join(wt, 'followup.md'), 'x\n');
			git(wt, 'add', '.');
			git(wt, 'commit', '--quiet', '-m', 'after merge');
			useBitbucketRemote(fx);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
		});
	});

	describe('regenerable output is not dirty', () => {
		it('removes a landed worktree whose nested package has un-ignored node_modules, .next and logs', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'nested'), 'feat/nested');
			landOnOrigin(wt);
			for (const d of ['web/node_modules/pkg', 'web/.next/cache', 'web/dist', 'logs']) {
				fs.mkdirSync(path.join(wt, d), { recursive: true });
				fs.writeFileSync(path.join(wt, d, 'f.js'), 'x');
			}
			fs.writeFileSync(path.join(wt, 'debug.log'), 'x');
			// make `web/` itself tracked so its children show up as separate untracked dirs
			fs.writeFileSync(path.join(wt, 'web', 'package.json'), '{}');
			git(wt, 'add', 'web/package.json');
			git(wt, 'commit', '--quiet', '-m', 'web pkg');
			landOnOrigin(wt);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'merged', removed: true });
			expect(fs.existsSync(wt)).toBe(false);
		});

		it('still keeps a worktree with an untracked source file next to node_modules', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'src-next-to-nm'), 'feat/src-next-to-nm');
			landOnOrigin(wt);
			fs.mkdirSync(path.join(wt, 'node_modules'));
			fs.writeFileSync(path.join(wt, 'node_modules', 'x.js'), '');
			fs.writeFileSync(path.join(wt, 'new-source.ts'), 'export {}\n');
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'dirty' });
			expect(fs.existsSync(path.join(wt, 'new-source.ts'))).toBe(true);
		});
	});

	describe('low disk: reclaiming kept worktrees', () => {
		function lowDiskJanitor(extra: WorktreeJanitorOptions = {}): WorktreeJanitorService {
			return janitor(fx, { statfs: statfsWith(() => 3), now: () => Date.now() + 3 * 24 * HOUR, ...extra });
		}

		it('deletes node_modules and .next of an idle unmerged worktree but keeps the worktree and its files', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'kept'), 'feat/kept');
			fs.mkdirSync(path.join(wt, 'node_modules', 'p'), { recursive: true });
			fs.mkdirSync(path.join(wt, 'web', '.next'), { recursive: true });
			fs.writeFileSync(path.join(wt, 'web', '.next', 'a'), 'x');
			fs.writeFileSync(path.join(wt, 'wip.ts'), 'x');
			const summary = await lowDiskJanitor().run();
			const v = verdictFor(summary, wt)!;
			expect(v).toMatchObject({ decision: 'keep', reason: 'dirty' });
			expect(v.reclaimed?.dirs.length).toBe(2);
			expect(summary.reclaimedBytes).toBe(2 * GB);
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
			expect(fs.existsSync(path.join(wt, 'web', '.next'))).toBe(false);
			expect(fs.existsSync(path.join(wt, 'wip.ts'))).toBe(true);
		});

		it('leaves a worktree idle for less than a day alone', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'fresh'), 'feat/fresh');
			fs.mkdirSync(path.join(wt, 'node_modules'));
			fs.writeFileSync(path.join(wt, 'wip.ts'), 'x');
			const summary = await lowDiskJanitor({ now: () => Date.now() + 5 * HOUR }).run();
			expect(verdictFor(summary, wt)?.reclaimed).toBeUndefined();
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(true);
		});

		it('does nothing when disk is fine (before the 3-day strip tier), and a dry run only lists', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'ok'), 'feat/ok');
			fs.mkdirSync(path.join(wt, 'node_modules'));
			fs.writeFileSync(path.join(wt, 'wip.ts'), 'x');
			const ok = await janitor(fx, { now: () => Date.now() + 2 * 24 * HOUR }).run();
			expect(verdictFor(ok, wt)?.reclaimed).toBeUndefined();
			const plan = await lowDiskJanitor().plan();
			expect(verdictFor(plan, wt)?.reclaimed?.dirs.length).toBe(1);
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(true);
		});
	});

	describe('requestTidy (work completion)', () => {
		it('runs one debounced pass with a short idle threshold and removes a landed worktree', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'done'), 'feat/done');
			landOnOrigin(wt);
			// 20 minutes idle: below the 2 h periodic threshold, above the 10 min completion one.
			const j = janitor(fx, { now: () => Date.now() + 20 * 60 * 1000, tidyDelayMs: 10 });
			j.requestTidy();
			j.requestTidy();
			await new Promise((r) => setTimeout(r, 1500));
			expect(fs.existsSync(wt)).toBe(false);
			expect(j.getLastSummary()?.removed).toBe(1);
		});

		it('does nothing when the janitor is disabled', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'off'), 'feat/off');
			landOnOrigin(wt);
			const j = janitor(fx, { env: { CREWLY_WORKTREE_JANITOR: '0' }, tidyDelayMs: 10 });
			j.requestTidy();
			await new Promise((r) => setTimeout(r, 200));
			expect(fs.existsSync(wt)).toBe(true);
		});
	});

	describe('worktrees outside the agent locations', () => {
		it('removes a landed, clean worktree at an arbitrary path once idle 24h', async () => {
			const wt = addWorktree(fx, path.join(fx.root, 'repo-wt-805'), 'fix/805');
			landOnOrigin(wt);
			const summary = await janitor(fx, { now: () => Date.now() + 25 * HOUR }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ reason: 'merged', removed: true, branchDeleted: true });
			expect(fs.existsSync(wt)).toBe(false);
		});

		it('keeps it while idle for less than 24h (2h is only for agent locations)', async () => {
			const wt = addWorktree(fx, path.join(fx.root, 'repo-wt-806'), 'fix/806');
			landOnOrigin(wt);
			const summary = await janitor(fx).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'recent' });
			expect(verdictFor(summary, wt)?.detail).toContain('other location');
			expect(fs.existsSync(wt)).toBe(true);
		});

		it('keeps a dirty or unlanded worktree at an arbitrary path however old (until the 14-day archive tier, crewly#1354)', async () => {
			const dirty = addWorktree(fx, path.join(fx.root, 'wt-dirty'), 'fix/dirty');
			landOnOrigin(dirty);
			fs.writeFileSync(path.join(dirty, 'scratch.txt'), 'x\n');
			const open = addWorktree(fx, path.join(fx.root, 'wt-open'), 'fix/open');
			const summary = await janitor(fx, { now: () => Date.now() + 10 * 24 * HOUR }).run();
			expect(verdictFor(summary, dirty)).toMatchObject({ decision: 'keep', reason: 'dirty' });
			expect(verdictFor(summary, open)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
			// Nothing regenerable inside, so the strip tier has nothing to do either.
			expect(verdictFor(summary, dirty)?.tier).toBeUndefined();
			expect(fs.existsSync(dirty) && fs.existsSync(open)).toBe(true);
			// Not armed: even at 30 days the archive is only reported.
			const unarmed = await janitor(fx, { now: () => Date.now() + 30 * 24 * HOUR, armed: false }).run();
			expect(verdictFor(unarmed, open)).toMatchObject({ decision: 'keep', reason: 'not-merged' });
			expect(verdictFor(unarmed, open)?.tier).toMatchObject({ tier: 'archive', action: 'would' });
			expect(fs.existsSync(dirty) && fs.existsSync(open)).toBe(true);
		});

		it('uses the 2h threshold for a worktree-agent-* branch anywhere', async () => {
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

		it('halves the 24h threshold when disk is low (12h idle is enough)', async () => {
			const wt = addWorktree(fx, path.join(fx.root, 'wt-low'), 'fix/low');
			landOnOrigin(wt);
			const now = () => Date.now() + 13 * HOUR;
			const normal = await janitor(fx, { now }).plan();
			expect(verdictFor(normal, wt)).toMatchObject({ decision: 'keep', reason: 'recent' });
			const low = await janitor(fx, { now, statfs: statfsWith(() => 10) }).run();
			expect(low.lowDisk).toBe(true);
			expect(verdictFor(low, wt)).toMatchObject({ reason: 'merged', removed: true });
		});

		it('never goes below 2h for agent locations in low-disk mode', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'floor'), 'feat/floor');
			landOnOrigin(wt);
			const summary = await janitor(fx, { now: () => Date.now() + 1.5 * HOUR, statfs: statfsWith(() => 1) }).run();
			expect(verdictFor(summary, wt)).toMatchObject({ decision: 'keep', reason: 'recent' });
		});

		it('discovers a repo that is not registered through its worktree in a temp root', async () => {
			const tmpRoot = path.join(fx.root, 'claude-tmp');
			const wt = addWorktree(fx, path.join(tmpRoot, 'visa-cm-wt'), 'feat/visa');
			landOnOrigin(wt);
			const summary = await janitor(fx, {
				listRepoPaths: async () => [],
				scratchRoots: [tmpRoot],
				now: () => Date.now() + 25 * HOUR,
			}).run();
			expect(summary.repos.map((r) => fs.realpathSync(r))).toEqual([fs.realpathSync(fx.repo)]);
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

		it('checks free disk every LOW_DISK_CHECK_INTERVAL_MS once started', () => {
			jest.useFakeTimers();
			const j = janitor(fx);
			const checkSpy = jest.spyOn(j, 'checkDisk').mockResolvedValue({ freeBytesBefore: null, freeBytesAfter: null, ranPass: false, notified: null });
			jest.spyOn(j, 'run').mockResolvedValue({} as JanitorRunSummary);
			j.start();
			jest.advanceTimersByTime(WORKTREE_JANITOR_CONSTANTS.LOW_DISK_CHECK_INTERVAL_MS);
			expect(checkSpy).toHaveBeenCalledTimes(1);
			j.stop();
			jest.advanceTimersByTime(WORKTREE_JANITOR_CONSTANTS.LOW_DISK_CHECK_INTERVAL_MS * 3);
			expect(checkSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('low-disk guard', () => {
		function guarded(freeGb: () => number, clock: { t: number }, notify: jest.Mock, extra: WorktreeJanitorOptions = {}) {
			return janitor(fx, { statfs: statfsWith(freeGb), now: () => clock.t, notifyOwner: notify, ...extra });
		}

		it('does nothing while free space is above 15 GB', async () => {
			const notify = jest.fn().mockResolvedValue(true);
			const clock = { t: Date.now() };
			const j = guarded(() => 40, clock, notify);
			const runSpy = jest.spyOn(j, 'run');
			const r = await j.checkDisk();
			expect(r).toMatchObject({ ranPass: false, notified: null, freeBytesBefore: 40 * GB });
			expect(runSpy).not.toHaveBeenCalled();
			expect(notify).not.toHaveBeenCalled();
		});

		it('below 15 GB runs a pass at once, then tells the owner at most once per 24h with the biggest kept items', async () => {
			const notify = jest.fn().mockResolvedValue(true);
			const clock = { t: Date.now() + THREE_HOURS };
			const kept = addWorktree(fx, agentPath(fx, 'unmerged'), 'feat/unmerged');
			const j = guarded(() => 10, clock, notify, { sizeOf: async (p) => (p === kept || fs.realpathSync(p) === fs.realpathSync(kept) ? 3 * GB : GB) });
			const first = await j.checkDisk();
			expect(first).toMatchObject({ ranPass: true, notified: 'normal' });
			expect(j.getLastSummary()?.lowDisk).toBe(true);
			const notice = notify.mock.calls[0][0];
			expect(notice.urgent).toBe(false);
			expect(notice.message).toContain('10.0 GB free');
			expect(notice.message).toMatch(/unmerged \(3\.0 GB\) — has work that is not merged yet/);
			expect(notice.message).not.toMatch(/ticket/i);

			clock.t += 20 * 60 * 1000; // within the pass gap: no new pass, no new notice
			expect(await j.checkDisk()).toMatchObject({ ranPass: false, notified: null });
			clock.t += 12 * HOUR;
			expect(await j.checkDisk()).toMatchObject({ ranPass: true, notified: null });
			clock.t += 12 * HOUR;
			expect(await j.checkDisk()).toMatchObject({ notified: 'normal' });
			expect(notify).toHaveBeenCalledTimes(2);
		});

		it('below 5 GB sends an urgent notice, repeated at most every 6h', async () => {
			const notify = jest.fn().mockResolvedValue(true);
			const clock = { t: Date.now() };
			const j = guarded(() => 3, clock, notify);
			expect(await j.checkDisk()).toMatchObject({ notified: 'urgent' });
			expect(notify.mock.calls[0][0]).toMatchObject({ urgent: true, title: expect.stringMatching(/URGENT/) });
			clock.t += 5 * HOUR;
			expect(await j.checkDisk()).toMatchObject({ notified: null });
			clock.t += 1 * HOUR;
			expect(await j.checkDisk()).toMatchObject({ notified: 'urgent' });
		});

		it('does not notify when the pass freed enough space', async () => {
			const notify = jest.fn().mockResolvedValue(true);
			let free = 10;
			const j = guarded(() => free, { t: Date.now() }, notify);
			jest.spyOn(j, 'run').mockImplementation(async () => {
				free = 30;
				return {} as JanitorRunSummary;
			});
			expect(await j.checkDisk()).toMatchObject({ ranPass: true, freeBytesAfter: 30 * GB, notified: null });
			expect(notify).not.toHaveBeenCalled();
		});

		it('retries the notice on the next check when delivery failed', async () => {
			const notify = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
			const clock = { t: Date.now() };
			const j = guarded(() => 10, clock, notify);
			expect(await j.checkDisk()).toMatchObject({ notified: null });
			clock.t += 10 * 60 * 1000;
			expect(await j.checkDisk()).toMatchObject({ notified: 'normal' });
		});

		it('remembers the last notice in the state file across instances', async () => {
			const statePath = path.join(fx.root, 'state.json');
			const notify = jest.fn().mockResolvedValue(true);
			const clock = { t: Date.now() };
			await guarded(() => 10, clock, notify, { statePath }).checkDisk();
			clock.t += HOUR;
			expect(await guarded(() => 10, clock, notify, { statePath }).checkDisk()).toMatchObject({ notified: null });
			expect(notify).toHaveBeenCalledTimes(1);
		});

		it('is stopped by the kill switch', async () => {
			const notify = jest.fn().mockResolvedValue(true);
			const j = guarded(() => 1, { t: Date.now() }, notify, { env: { CREWLY_WORKTREE_JANITOR: '0' } });
			expect(await j.checkDisk()).toMatchObject({ ranPass: false, notified: null });
			expect(notify).not.toHaveBeenCalled();
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
			// One line for the worktrees, one for the scratch sweep (plus the one-time arming line, crewly#1354).
			const lines = logger.info.mock.calls.map((c) => String(c[0])).filter((l) => !l.startsWith('Disk janitor: first pass'));
			expect(lines).toHaveLength(2);
			expect(lines[0]).toMatch(/^Worktree janitor: removed 0, kept 2 \(.*not-merged: 1.*\)/);
			expect(lines[1]).toMatch(/^Scratch janitor: removed 0 session dir\(s\), freed 0 KB, kept 0/);
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

	describe('runaway files (crewly#1078)', () => {
		it('scans the scratch roots and alerts the owner through the low-disk notifier', async () => {
			const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runaway-svc-'));
			try {
				const f = path.join(scratch, 'all.md');
				fs.closeSync(fs.openSync(f, 'w'));
				fs.truncateSync(f, WORKTREE_JANITOR_CONSTANTS.RUNAWAY_FILE_BYTES + 1);
				const notifyOwner = jest.fn().mockResolvedValue(true);
				const j = janitor(fx, { scratchRoots: [scratch], notifyOwner });
				const out = await j.checkRunawayFiles();
				expect(out).toHaveLength(1);
				expect(notifyOwner).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(f) }));
			} finally {
				fs.rmSync(scratch, { recursive: true, force: true });
			}
		});

		it('does nothing when the kill switch is on', async () => {
			const j = janitor(fx, { env: { CREWLY_WORKTREE_JANITOR: '0' } });
			expect(await j.checkRunawayFiles()).toEqual([]);
		});
	});

	describe('unmerged worktree notice', () => {
		const DAY = 24 * HOUR;
		function make(notify: jest.Mock, overrides: WorktreeJanitorOptions = {}): WorktreeJanitorService {
			const j = janitor(fx, { now: () => Date.now() + 2 * DAY, unmergedNoticePath: null, ...overrides });
			j.setAgentNotifier(notify);
			return j;
		}

		it('tells the team lead once about an old unmerged worktree (path, branch, commits, pushed, size)', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'old'), 'feat/old');
			const notify = jest.fn().mockResolvedValue(true);
			const j = make(notify, { resolveLeadSessions: async () => ['tl-session'] });
			await j.run();
			expect(notify).toHaveBeenCalledTimes(1);
			const [session, message] = notify.mock.calls[0];
			expect(session).toBe('tl-session');
			expect(message).toContain(fs.realpathSync(wt));
			expect(message).toContain('feat/old');
			expect(message).toContain('1 commit not on origin/main');
			expect(message).toContain('NOT pushed');
			expect(message).toContain('1.0 GB');
			expect(message).toContain('merge it to main');
		});

		it('says the work is on hold (close it) when a held ticket names the branch (crewly#1369)', async () => {
			addWorktree(fx, agentPath(fx, 'wt-crew257'), 'feat/gmail-approve');
			const notify = jest.fn().mockResolvedValue(true);
			const findHold = jest.fn().mockResolvedValue({
				ticketId: 'CREW-257',
				title: 'Gmail approve-then-send',
				hold: { reason: 'HOLD: PR #1138: do not merge, do not ask Steve to merge', source: 'log' },
				matchedOn: ['worktree wt-crew257'],
			});
			const j = make(notify, { resolveLeadSessions: async () => ['tl-session'], findHold });
			await j.run();
			expect(findHold).toHaveBeenCalledWith('feat/gmail-approve', expect.stringContaining('wt-crew257'));
			const [, message] = notify.mock.calls[0];
			expect(message).toContain('ON HOLD on ticket CREW-257');
			expect(message).toContain('do not merge, do not ask Steve to merge');
			expect(message).toContain('close the PR and remove the worktree');
			expect(message).not.toContain('merge it to main');
		});

		it('says pushed when the branch is on origin', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'pushed'), 'feat/pushed');
			git(wt, 'push', '--quiet', 'origin', 'feat/pushed');
			const notify = jest.fn().mockResolvedValue(true);
			await make(notify, { resolveLeadSessions: async () => ['tl'] }).run();
			expect(notify.mock.calls[0][1]).toMatch(/, pushed,/);
		});

		it('stays quiet for a worktree whose newest commit is recent', async () => {
			addWorktree(fx, agentPath(fx, 'fresh'), 'feat/fresh');
			const notify = jest.fn().mockResolvedValue(true);
			await make(notify, { now: () => Date.now() + THREE_HOURS, resolveLeadSessions: async () => ['tl'] }).run();
			expect(notify).not.toHaveBeenCalled();
		});

		it('does not repeat within the window, and repeats after it', async () => {
			addWorktree(fx, agentPath(fx, 'again'), 'feat/again');
			const notify = jest.fn().mockResolvedValue(true);
			let offset = 2 * DAY;
			const j = make(notify, { now: () => Date.now() + offset, resolveLeadSessions: async () => ['tl'] });
			await j.run();
			await j.run();
			expect(notify).toHaveBeenCalledTimes(1);
			offset += WORKTREE_JANITOR_CONSTANTS.UNMERGED_NOTICE_INTERVAL_MS + HOUR;
			await j.run();
			expect(notify).toHaveBeenCalledTimes(2);
		});

		it('retries next pass when delivery failed', async () => {
			addWorktree(fx, agentPath(fx, 'retry'), 'feat/retry');
			const notify = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
			const j = make(notify, { resolveLeadSessions: async () => ['tl'] });
			await j.run();
			await j.run();
			expect(notify).toHaveBeenCalledTimes(2);
		});

		it('falls back to the orchestrator when no team owns the worktree', async () => {
			addWorktree(fx, agentPath(fx, 'orphan'), 'feat/orphan');
			const notify = jest.fn().mockResolvedValue(true);
			await make(notify, { resolveLeadSessions: async () => [] }).run();
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toBe(ORCHESTRATOR_SESSION_NAME);
		});

		it('says detached HEAD for a branchless worktree', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'det'), 'feat/det');
			git(wt, 'checkout', '--quiet', '--detach');
			const notify = jest.fn().mockResolvedValue(true);
			await make(notify, { resolveLeadSessions: async () => ['tl'] }).run();
			expect(notify.mock.calls[0][1]).toContain('detached HEAD');
		});

		it('does nothing for a landed worktree or in a dry run', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'landed'), 'feat/landed');
			landOnOrigin(wt);
			addWorktree(fx, agentPath(fx, 'plan'), 'feat/plan');
			const notify = jest.fn().mockResolvedValue(true);
			await make(notify, { resolveLeadSessions: async () => ['tl'] }).plan();
			expect(notify).not.toHaveBeenCalled();
		});
	});
	describe('age tiers and retention (crewly#1354)', () => {
		const DAY = 24 * HOUR;
		const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		function tiered(overrides: WorktreeJanitorOptions = {}): WorktreeJanitorService {
			return janitor(fx, { now: () => Date.now() + 4 * DAY, unmergedNoticePath: null, armed: true, ...overrides });
		}
		const stripNotices = (notify: jest.Mock) => notify.mock.calls.filter((c) => String(c[1]).includes('re-installable output'));

		it('strips node_modules and build output of a dirty worktree untouched for 3 days, tells the lead once, never a tracked dir', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'stale'), 'feat/stale');
			fs.mkdirSync(path.join(wt, 'dist'));
			fs.writeFileSync(path.join(wt, 'dist', 'keep.js'), 'k');
			git(wt, 'add', '-f', 'dist');
			git(wt, 'commit', '--quiet', '-m', 'tracked dist');
			fs.mkdirSync(path.join(wt, 'node_modules', 'p'), { recursive: true });
			fs.mkdirSync(path.join(wt, 'web', '.next'), { recursive: true });
			fs.writeFileSync(path.join(wt, 'wip.ts'), 'x');
			const notify = jest.fn().mockResolvedValue(true);
			const j = tiered({ resolveLeadSessions: async () => ['lead'] });
			j.setAgentNotifier(notify);
			const summary = await j.run();
			const v = verdictFor(summary, wt)!;
			expect(v).toMatchObject({ decision: 'keep', reason: 'dirty' });
			expect(v.tier).toMatchObject({ tier: 'strip', action: 'done', freedBytes: 2 * GB });
			expect(v.tier!.dirs!.map((d) => path.relative(v.path, d)).sort()).toEqual(['node_modules', 'web/.next']);
			expect(v.reclaimed?.dirs).toHaveLength(2);
			expect(summary.reclaimedBytes).toBe(2 * GB);
			expect(summary.freed.stripped).toBe(2 * GB);
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
			expect(fs.existsSync(path.join(wt, 'web', '.next'))).toBe(false);
			expect(fs.existsSync(path.join(wt, 'dist', 'keep.js'))).toBe(true);
			expect(fs.existsSync(path.join(wt, 'wip.ts'))).toBe(true);
			expect(stripNotices(notify)).toHaveLength(1);
			expect(stripNotices(notify)[0][0]).toBe('lead');
			expect(stripNotices(notify)[0][1]).toContain('4 days');
			// A later pass strips a re-created node_modules again but does not repeat the notice.
			fs.mkdirSync(path.join(wt, 'node_modules'));
			await j.run();
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
			expect(stripNotices(notify)).toHaveLength(1);
		});

		it('does nothing before 3 days; when not armed it only reports what it would strip', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'young'), 'feat/young');
			fs.mkdirSync(path.join(wt, 'node_modules'));
			fs.writeFileSync(path.join(wt, 'wip.ts'), 'x');
			const young = await tiered({ now: () => Date.now() + 2 * DAY }).run();
			expect(verdictFor(young, wt)?.tier).toBeUndefined();
			const unarmed = await tiered({ armed: false }).run();
			const v = verdictFor(unarmed, wt)!;
			expect(v.tier).toMatchObject({ tier: 'strip', action: 'would', freedBytes: GB });
			expect(v.reclaimed).toBeUndefined();
			expect(unarmed.reclaimedBytes).toBe(0);
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(true);
		});

		it('a finished WorkItem (task-end hook) drops the strip tier to one day', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'finished'), 'feat/finished');
			fs.mkdirSync(path.join(wt, 'node_modules'));
			fs.writeFileSync(path.join(wt, 'wip.ts'), 'x');
			const j = tiered({ now: () => Date.now() + 30 * HOUR, findWorkItemWorktree: async (id) => (id === 'wi-1' ? wt : null) });
			expect(verdictFor(await j.run(), wt)?.tier).toBeUndefined();
			j.requestTidy('wi-1');
			j.stop();
			await new Promise((r) => setTimeout(r, 50));
			const v = verdictFor(await j.run(), wt)!;
			expect(v.tier).toMatchObject({ tier: 'strip', action: 'done' });
			expect(fs.existsSync(path.join(wt, 'node_modules'))).toBe(false);
			expect(fs.existsSync(path.join(wt, 'wip.ts'))).toBe(true);
		});

		it('archives a worktree untouched for 14 days as a patch, keeps its branch, removes it and tells the lead', async () => {
			const wt = addWorktree(fx, agentPath(fx, 'ancient'), 'feat/ancient');
			fs.writeFileSync(path.join(wt, 'README.md'), 'hello\nmore\n');
			fs.writeFileSync(path.join(wt, 'notes.md'), 'n');
			fs.mkdirSync(path.join(wt, 'node_modules', 'p'), { recursive: true });
			const notify = jest.fn().mockResolvedValue(true);
			const archiveRoot = path.join(fx.root, 'archive');
			const j = tiered({ now: () => Date.now() + 15 * DAY, archiveRoot, resolveLeadSessions: async () => ['lead'], sizeOf: async () => 3 * GB });
			j.setAgentNotifier(notify);
			const summary = await j.run();
			const v = verdictFor(summary, wt)!;
			expect(v).toMatchObject({ decision: 'remove', reason: 'archived', removed: true });
			expect(v.tier).toMatchObject({ tier: 'archive', action: 'done', freedBytes: 3 * GB });
			expect(summary).toMatchObject({ archived: 1, removed: 1, archivedBytes: 3 * GB });
			expect(summary.freed.archived).toBe(3 * GB);
			expect(fs.existsSync(wt)).toBe(false);
			expect(branchExists(fx.repo, 'feat/ancient')).toBe(true);
			expect(git(fx.repo, 'worktree', 'list', '--porcelain')).not.toContain('ancient');
			const patch = v.tier!.patch!;
			expect(path.dirname(patch)).toBe(path.join(archiveRoot, 'repo'));
			const text = fs.readFileSync(patch, 'utf-8');
			expect(text).toContain('+more');
			expect(text).toContain('notes.md');
			expect(text).not.toContain('node_modules');
			expect(text).toContain('1 commit(s) of this worktree are not on it; the branch was kept');
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0][0]).toBe('lead');
			expect(notify.mock.calls[0][1]).toContain(patch);
			expect(notify.mock.calls[0][1]).toContain('still on branch feat/ancient');
		});

		it('an unarmed pass only reports the archive; the first real pass arms the deletes for the next day', async () => {
			const statePath = path.join(fx.root, 'state.json');
			const wt = addWorktree(fx, agentPath(fx, 'ancient2'), 'feat/ancient2');
			fs.writeFileSync(path.join(wt, 'notes.md'), 'n');
			const clock = { t: Date.now() + 15 * DAY };
			const j = tiered({ now: () => clock.t, statePath, armed: undefined });
			const first = await j.run();
			expect(first.retentionArmed).toBe(false);
			expect(verdictFor(first, wt)?.tier).toMatchObject({ tier: 'archive', action: 'would' });
			expect(fs.existsSync(wt)).toBe(true);
			expect(JSON.parse(fs.readFileSync(statePath, 'utf-8')).retentionArmedAt).toBe(clock.t);
			clock.t += 25 * HOUR;
			const second = await j.run();
			expect(second.retentionArmed).toBe(true);
			expect(verdictFor(second, wt)).toMatchObject({ reason: 'archived', removed: true });
			expect(fs.existsSync(wt)).toBe(false);
		});

		it('runs the transcript, tmp and log sweeps inside the pass (armed deletes; unarmed only plans)', async () => {
			const tmpRoot = path.join(fx.root, 'tmp');
			const logsDir = path.join(fx.root, 'logs');
			const home = path.join(fx.root, '.claude');
			const past = new Date(Date.now() - 20 * DAY);
			const oldDir = path.join(tmpRoot, 'old-preview');
			fs.mkdirSync(oldDir, { recursive: true });
			fs.writeFileSync(path.join(oldDir, 'index.html'), 'x');
			fs.utimesSync(path.join(oldDir, 'index.html'), past, past);
			fs.utimesSync(oldDir, past, past);
			fs.mkdirSync(path.join(logsDir, 'archive'), { recursive: true });
			fs.writeFileSync(path.join(logsDir, 'archive', 'a.gz'), 'a');
			fs.mkdirSync(path.join(logsDir, 'sessions'));
			fs.writeFileSync(path.join(logsDir, 'sessions', 'live.log'), 'l');
			const slug = path.join(home, 'projects', '-x');
			fs.mkdirSync(slug, { recursive: true });
			const transcript = path.join(slug, `${UUID}.jsonl`);
			fs.writeFileSync(transcript, '{"type":"agent-setting","agentSetting":"crewly-orc","sessionId":"x"}\n');
			fs.utimesSync(transcript, past, past);
			const make = (armed: boolean) =>
				tiered({
					now: () => Date.now(),
					armed,
					tmpRoot,
					logsDir,
					claudeHomes: [home],
					forceSweeps: true,
					transcriptSources: async () => ({ knownSessionNames: new Set(['crewly-orc']), recordedIds: new Set(), keepIds: new Set() }),
					liveSessionNames: async () => ['live'],
				});
			const plan = await make(false).run();
			expect(plan.tmp).toMatchObject({ removed: 0, wouldRemove: 1 });
			expect(plan.transcripts).toMatchObject({ pruned: 0, wouldPrune: 1 });
			expect(fs.existsSync(oldDir)).toBe(true);
			expect(fs.existsSync(transcript)).toBe(true);
			const real = await make(true).run();
			expect(real.tmp).toMatchObject({ removed: 1 });
			expect(real.transcripts).toMatchObject({ pruned: 1 });
			expect(real.logs?.archive.totalBytes).toBe(1);
			expect(real.logs?.sessions.deleted).toEqual([]);
			expect(real.freed.transcripts).toBeGreaterThan(0);
			expect(real.freed.tmp).toBeGreaterThan(0);
			expect(fs.existsSync(oldDir)).toBe(false);
			expect(fs.existsSync(transcript)).toBe(false);
			expect(fs.existsSync(path.join(logsDir, 'sessions', 'live.log'))).toBe(true);
		});

		it('reports the disk size and treats less than 8 % free as low (crewly#1354)', async () => {
			const statfs = async () => ({ bavail: (50 * GB) / 4096, bsize: 4096, blocks: (926 * GB) / 4096 });
			const j = tiered({ statfs });
			const status = await j.diskStatus();
			expect(status).toMatchObject({ freeBytes: 50 * GB, totalBytes: 926 * GB, level: 'low' });
			expect(status.lowBytes).toBe(Math.round(926 * GB * 0.08));
			const summary = await j.plan();
			expect(summary.lowDisk).toBe(true);
			expect(summary.totalBytes).toBe(926 * GB);
		});
	});
});
