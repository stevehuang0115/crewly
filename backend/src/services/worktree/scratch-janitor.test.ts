/**
 * Tests for the scratch janitor — real git repos in a fake Claude scratch
 * root under os.tmpdir(). Nothing outside the fixture is touched.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultScratchRoots, listSessionDirs, sweepScratch, type ScratchSweepInput } from './scratch-janitor.js';
import { runCommand } from './worktree-janitor.git.js';
import { WORKTREE_JANITOR_CONSTANTS } from '../../constants.js';

const DAY = 24 * 60 * 60 * 1000;
const UUID_A = '11111111-2222-3333-4444-555555555555';
const UUID_B = '66666666-7777-8888-9999-aaaaaaaaaaaa';

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

describe('scratch janitor', () => {
	let base: string;
	let root: string;
	let origin: string;

	beforeEach(() => {
		base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-janitor-')));
		root = path.join(base, 'claude-501');
		fs.mkdirSync(root);
		origin = path.join(base, 'origin.git');
		git(base, 'init', '--quiet', '--bare', '-b', 'main', origin);
		const seed = path.join(base, 'seed');
		git(base, 'init', '--quiet', '-b', 'main', seed);
		fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n');
		fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
		git(seed, 'add', '.');
		git(seed, 'commit', '--quiet', '-m', 'init');
		git(seed, 'remote', 'add', 'origin', origin);
		git(seed, 'push', '--quiet', 'origin', 'main');
	});

	afterEach(() => {
		fs.rmSync(base, { recursive: true, force: true });
	});

	/** `<root>/<slug>/<uuid>/scratchpad/clone` cloned from origin. */
	function sessionWithClone(uuid = UUID_A, slug = '-Users-me-proj'): { session: string; clone: string } {
		const session = path.join(root, slug, uuid);
		const clone = path.join(session, 'scratchpad', 'clone');
		fs.mkdirSync(path.dirname(clone), { recursive: true });
		git(base, 'clone', '--quiet', origin, clone);
		return { session, clone };
	}

	function input(overrides: Partial<ScratchSweepInput> = {}): ScratchSweepInput {
		return {
			roots: [root],
			busy: [],
			now: Date.now() + 4 * DAY,
			minIdleMs: WORKTREE_JANITOR_CONSTANTS.SCRATCH_MIN_IDLE_MS,
			dryRun: false,
			git: (args) => runCommand('git', args, { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }),
			sizeOf: async () => 1024,
			...overrides,
		};
	}

	it('removes a session dir whose only clone is clean and pushed, older than 3 days', async () => {
		const { session } = sessionWithClone();
		fs.mkdirSync(path.join(session, 'scratchpad', 'clone', 'node_modules', 'x'), { recursive: true });
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ path: session, decision: 'remove', reason: 'stale', removed: true, freedBytes: 1024 });
		expect(summary).toMatchObject({ removed: 1, freedBytes: 1024 });
		expect(fs.existsSync(session)).toBe(false);
	});

	it('removes a stale session dir that holds no repo at all (test homes)', async () => {
		const session = path.join(root, '-slug', UUID_B);
		fs.mkdirSync(path.join(session, 'scratchpad', 'home', '.crewly'), { recursive: true });
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'remove', removed: true });
	});

	it('keeps a session dir with an unpushed local commit', async () => {
		const { session, clone } = sessionWithClone();
		fs.writeFileSync(path.join(clone, 'new.txt'), 'x\n');
		git(clone, 'add', '.');
		git(clone, 'commit', '--quiet', '-m', 'local only');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'unpushed' });
		expect(fs.existsSync(session)).toBe(true);
	});

	it('keeps a session dir with an unpushed commit on a detached HEAD', async () => {
		const { clone } = sessionWithClone();
		git(clone, 'checkout', '--quiet', '--detach');
		fs.writeFileSync(path.join(clone, 'new.txt'), 'x\n');
		git(clone, 'add', '.');
		git(clone, 'commit', '--quiet', '-m', 'detached work');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'unpushed' });
	});

	it('keeps a session dir with an untracked file (ignored files do not count)', async () => {
		const { session, clone } = sessionWithClone();
		fs.writeFileSync(path.join(clone, 'notes.md'), 'x\n');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'dirty' });
		expect(fs.existsSync(session)).toBe(true);
	});

	it('keeps a session dir with a stash', async () => {
		const { clone } = sessionWithClone();
		fs.appendFileSync(path.join(clone, 'README.md'), 'edit\n');
		git(clone, 'stash', '--quiet');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'stash' });
	});

	it('keeps a repo with no remote', async () => {
		const session = path.join(root, '-slug', UUID_A);
		const repo = path.join(session, 'scratchpad', 'local');
		fs.mkdirSync(repo, { recursive: true });
		git(repo, 'init', '--quiet', '-b', 'main');
		fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
		git(repo, 'add', '.');
		git(repo, 'commit', '--quiet', '-m', 'only here');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'no-remote' });
	});

	it('keeps a session dir touched within 3 days', async () => {
		const { session } = sessionWithClone();
		const summary = await sweepScratch(input({ now: Date.now() + 2 * DAY }));
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'recent' });
		expect(fs.existsSync(session)).toBe(true);
	});

	it('counts a recent commit in the repo as activity even when the dirs look old', async () => {
		const { session, clone } = sessionWithClone();
		const old = new Date(Date.now() - 10 * DAY);
		for (const p of [session, path.join(session, 'scratchpad'), clone]) fs.utimesSync(p, old, old);
		const summary = await sweepScratch(input({ now: Date.now() + DAY }));
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'recent' });
	});

	it('keeps a session dir some process has as its cwd', async () => {
		const { session, clone } = sessionWithClone();
		const summary = await sweepScratch(input({ busy: [{ cwd: path.join(clone), source: 'process' }] }));
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'process-inside' });
		expect(fs.existsSync(session)).toBe(true);
	});

	it('keeps everything when the cwd probe failed', async () => {
		sessionWithClone();
		const summary = await sweepScratch(input({ busy: null }));
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'cwd-probe-failed' });
	});

	it('leaves a session dir holding a linked worktree of an outside repo to the worktree rules', async () => {
		const main = path.join(base, 'main-repo');
		git(base, 'clone', '--quiet', origin, main);
		const session = path.join(root, '-slug', UUID_A);
		fs.mkdirSync(session, { recursive: true });
		git(main, 'worktree', 'add', '--quiet', '--detach', path.join(session, 'wt'), 'main');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'contains-worktree' });
		expect(fs.existsSync(path.join(session, 'wt'))).toBe(true);
	});

	it('keeps a clone whose linked worktree lives outside the session dir', async () => {
		const { clone } = sessionWithClone();
		git(clone, 'worktree', 'add', '--quiet', '--detach', path.join(base, 'outside-wt'), 'HEAD');
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ decision: 'keep', reason: 'has-external-worktrees' });
	});

	it('dry run removes nothing and reports wouldRemove', async () => {
		const { session } = sessionWithClone();
		const summary = await sweepScratch(input({ dryRun: true }));
		expect(summary).toMatchObject({ wouldRemove: 1, removed: 0 });
		expect(fs.existsSync(session)).toBe(true);
	});

	it('only treats <slug>/<uuid> dirs as sessions and never follows symlinks out of the root', async () => {
		fs.mkdirSync(path.join(root, 'visa-cm-wt'), { recursive: true });
		fs.mkdirSync(path.join(root, '-slug', 'not-a-uuid'), { recursive: true });
		const outside = path.join(base, 'outside');
		fs.mkdirSync(path.join(outside, UUID_A), { recursive: true });
		fs.writeFileSync(path.join(outside, UUID_A, 'precious.txt'), 'x');
		fs.symlinkSync(outside, path.join(root, '-linked-slug'));
		fs.mkdirSync(path.join(root, '-slug2'));
		fs.symlinkSync(path.join(outside, UUID_A), path.join(root, '-slug2', UUID_B));
		expect(await listSessionDirs(root)).toEqual([]);
		await sweepScratch(input());
		expect(fs.existsSync(path.join(outside, UUID_A, 'precious.txt'))).toBe(true);
		expect(fs.existsSync(path.join(root, 'visa-cm-wt'))).toBe(true);
	});

	it('does not follow a symlink inside a removed session dir', async () => {
		const { session } = sessionWithClone();
		const outside = path.join(base, 'shared');
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, 'keep.txt'), 'x');
		fs.symlinkSync(outside, path.join(session, 'link'));
		const old = new Date(Date.now() - 10 * DAY);
		fs.lutimesSync(path.join(session, 'link'), old, old);
		const summary = await sweepScratch(input());
		expect(summary.sessions[0]).toMatchObject({ removed: true });
		expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
	});

	it('defaultScratchRoots returns existing claude-<uid> roots de-duplicated by real path', () => {
		const tmp = path.join(base, 'tmpdir');
		fs.mkdirSync(path.join(tmp, 'claude-4242'), { recursive: true });
		const roots = defaultScratchRoots(4242, tmp);
		expect(roots).toContain(fs.realpathSync(path.join(tmp, 'claude-4242')));
		expect(new Set(roots).size).toBe(roots.length);
	});
});
