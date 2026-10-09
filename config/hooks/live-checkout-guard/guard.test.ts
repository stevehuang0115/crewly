import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Tests for the live-checkout guard hook. Each test runs the real script with a
 * Claude Code / Codex PreToolUse payload on stdin. Exit: 0 allowed, 2 blocked.
 */
const HOOK = join(__dirname, 'guard.mjs');

let live: string;
let scratch: string;
let home: string;

function run(tool: string, toolInput: Record<string, unknown>, cwd: string): { status: number | null; stderr: string } {
	const r = spawnSync('node', [HOOK, live], {
		input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd }),
		encoding: 'utf-8',
		env: { ...process.env, HOME: home },
	});
	return { status: r.status, stderr: r.stderr };
}
const bash = (command: string, cwd: string = scratch) => run('Bash', { command }, cwd);

beforeEach(() => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'lcg-')));
	live = join(base, 'live');
	scratch = join(base, 'scratch');
	home = join(base, 'home');
	mkdirSync(join(live, '.crewly', 'tickets'), { recursive: true });
	mkdirSync(join(live, 'backend', 'src'), { recursive: true });
	mkdirSync(scratch, { recursive: true });
	mkdirSync(home, { recursive: true });
	symlinkSync(live, join(scratch, 'link-to-live'));
});
afterEach(() => rmSync(join(live, '..'), { recursive: true, force: true }));

describe('git state changes in the live checkout', () => {
	const mutating = ['checkout main', 'switch fix/x', 'commit -m "x"', 'reset --hard HEAD~1', 'rebase main', 'merge x', 'pull', 'stash', 'stash pop',
		'cherry-pick abc', 'restore .', 'clean -fd', 'branch -D old', 'branch -m new', 'branch newbranch', 'tag v1', 'push origin main', 'worktree add ../w', 'add .'];

	it.each(mutating)('blocks `git %s` when the cwd is the live root', (sub) => {
		const r = bash(`git ${sub}`, live);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('This is the live Crewly install. Clone it into your own scratch dir');
		expect(r.stderr).toContain('ln -s');
	});

	it('blocks `cd <live> && git switch`', () => {
		expect(bash(`cd ${live} && git switch main`).status).toBe(2);
	});
	it('blocks `git -C <live> commit`', () => {
		expect(bash(`git -C ${live} commit -am x`).status).toBe(2);
	});
	it('blocks a relative -C path and a git call after a relative cd', () => {
		expect(bash(`git -C ../live checkout x`, scratch).status).toBe(2);
		expect(bash(`cd ../live; git reset --hard`, scratch).status).toBe(2);
	});
	it('blocks a symlinked path into the live root', () => {
		expect(bash(`git -C ${join(scratch, 'link-to-live')} switch main`).status).toBe(2);
	});
	it('blocks --git-dir / --work-tree and GIT_DIR pointing at live', () => {
		expect(bash(`git --git-dir=${live}/.git commit -m x`).status).toBe(2);
		expect(bash(`git --work-tree ${live} checkout .`).status).toBe(2);
		expect(bash(`GIT_DIR=${live}/.git git commit -m x`).status).toBe(2);
	});
	it('blocks through bash -c, sudo, and a pipeline', () => {
		expect(bash(`bash -c "cd ${live} && git switch main"`).status).toBe(2);
		expect(bash(`sudo git -C ${live} reset --hard`).status).toBe(2);
		expect(bash(`echo hi | git -C ${live} commit -F -`).status).toBe(2);
	});
	it('blocks a subdirectory of the live root', () => {
		expect(bash('git commit -m x', join(live, 'backend', 'src')).status).toBe(2);
	});
	it('blocks cloning into the live root but allows cloning out of it', () => {
		expect(bash('git clone https://example.com/r.git', live).status).toBe(2);
		expect(bash(`git clone ${live} ${scratch}/copy`, live).status).toBe(0);
	});
	it('does not read a commit message as a subcommand', () => {
		expect(bash(`git commit -m "switch main and rm dist" `, scratch).status).toBe(0);
	});
});

describe('allowed read-only git and unrelated work', () => {
	const reads = ['status', 'status --short', 'log --oneline -5', 'diff HEAD~1', 'show HEAD', 'fetch origin', 'ls-remote origin', 'branch --list', 'branch', 'branch -a',
		'branch --show-current', 'rev-parse HEAD', 'tag --list', 'tag', 'stash list', 'remote -v', 'config --get remote.origin.url', 'worktree list', 'blame README.md'];
	it.each(reads)('allows `git %s` in the live root', (sub) => {
		expect(bash(`git ${sub}`, live).status).toBe(0);
	});
	it('allows `cd <live> && git status && git log | head`', () => {
		expect(bash(`cd ${live} && git status && git log --oneline | head -3`).status).toBe(0);
	});
	it('allows git state changes in a scratch clone', () => {
		expect(bash('git switch -c feature && git commit -am x && git push origin feature', scratch).status).toBe(0);
		expect(bash(`cd ${scratch} && git reset --hard`, live).status).toBe(0);
	});
	it('allows reading live files and copying out of them', () => {
		expect(bash(`cat ${live}/package.json; cp -r ${live}/backend ${scratch}/b; ls ${live}`).status).toBe(0);
	});
	it('allows a symlink created in scratch pointing at live node_modules', () => {
		expect(bash(`ln -s ${live}/node_modules ${scratch}/node_modules`).status).toBe(0);
	});
});

describe('file writes into the live checkout', () => {
	it('blocks Edit / Write / MultiEdit / NotebookEdit under the live root', () => {
		for (const tool of ['Edit', 'Write', 'MultiEdit']) {
			const r = run(tool, { file_path: join(live, 'backend', 'src', 'x.ts') }, scratch);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain('live Crewly install');
		}
		expect(run('NotebookEdit', { notebook_path: join(live, 'n.ipynb') }, scratch).status).toBe(2);
	});
	it('resolves a relative file_path against the cwd (cwd = live root)', () => {
		expect(run('Edit', { file_path: 'backend/src/x.ts' }, live).status).toBe(2);
		expect(run('Write', { file_path: '../live/y.ts' }, scratch).status).toBe(2);
	});
	it('allows files under .crewly/ and files outside the live root', () => {
		expect(run('Write', { file_path: join(live, '.crewly', 'tickets', 'T-1.md') }, scratch).status).toBe(0);
		expect(run('Write', { file_path: '.crewly/findings/a.md' }, live).status).toBe(0);
		expect(run('Edit', { file_path: join(scratch, 'x.ts') }, scratch).status).toBe(0);
	});
	it('blocks shell writes into the live root', () => {
		expect(bash(`echo x > ${live}/a.txt`).status).toBe(2);
		expect(bash('echo x >> README.md', live).status).toBe(2);
		expect(bash(`rm -rf ${live}/dist`).status).toBe(2);
		expect(bash(`sed -i '' s/a/b/ ${live}/package.json`).status).toBe(2);
		expect(bash(`cp ${scratch}/f ${live}/f`).status).toBe(2);
		expect(bash(`touch ${live}/backend/new.ts`).status).toBe(2);
	});
	it('allows shell writes to .crewly/ and elsewhere', () => {
		expect(bash(`echo x > ${live}/.crewly/tickets/a.md`).status).toBe(0);
		expect(bash('echo x > /dev/null', live).status).toBe(0);
		expect(bash(`echo x > ${scratch}/a.txt 2>&1`).status).toBe(0);
	});
	it('blocks a Codex apply_patch that touches the live root, allows one that does not', () => {
		const patch = (f: string) => `*** Begin Patch\n*** Update File: ${f}\n@@\n-a\n+b\n*** End Patch`;
		expect(run('apply_patch', { command: patch(join(live, 'x.ts')) }, scratch).status).toBe(2);
		expect(run('apply_patch', { command: patch('backend/x.ts') }, live).status).toBe(2);
		expect(run('apply_patch', { command: patch('x.ts') }, scratch).status).toBe(0);
	});
});

describe('guard failures are loud', () => {
	it('exits 1 (non-blocking) on unparsable input and with no roots', () => {
		expect(spawnSync('node', [HOOK, live], { input: 'not json', encoding: 'utf-8' }).status).toBe(1);
		expect(spawnSync('node', [HOOK], { input: '{}', encoding: 'utf-8' }).status).toBe(1);
	});
});
