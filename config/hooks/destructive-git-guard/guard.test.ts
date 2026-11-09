import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Tests for the destructive-git guard hook. Each test runs the real script with a
 * PreToolUse payload on stdin. Exit: 0 allowed, 2 blocked, 1 could not check.
 */
const HOOK = join(__dirname, 'guard.mjs');

let cwd: string;
beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'dgg-'));
	spawnSync('git', ['init', '-q', '-b', 'feat/x'], { cwd });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function run(command: string, tool = 'Bash', env: NodeJS.ProcessEnv = {}) {
	const r = spawnSync('node', [HOOK], {
		env: { ...process.env, CREWLY_GUARD_BLOCK_MAIN_PUSH: '', ...env },
		input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd }),
		encoding: 'utf-8',
	});
	return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('blocked forms', () => {
	const blocked = [
		'git push --force origin feat/x',
		'git push -f origin feat/x',
		'git push origin feat/x --force-with-lease',
		'git push --force-with-lease=feat/x origin feat/x',
		'git push origin +feat/x',
		'git reset --hard',
		'git reset --hard HEAD~1',
		'git clean -f',
		'git clean -fd',
		'git clean -xdf',
		'git clean --force',
		'git branch -D old',
		'git branch --delete --force old',
		'git checkout .',
		'git checkout -- .',
		'git restore .',
		'git -C /tmp/x reset --hard',
		'cd repo && git reset --hard',
		'sudo git push -f origin x',
		'FOO=1 git clean -fd',
		'bash -c "git reset --hard"',
		'echo hi; git branch -D old',
	];
	it.each(blocked)('blocks `%s`', (cmd) => {
		const r = run(cmd);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('destructive-git-guard: BLOCKED');
		expect(r.stderr).toContain('stash');
	});

	it.each(['git push origin main', 'git push origin HEAD:master'])('blocks `%s` when main pushes are opted in', (cmd) => {
		expect(run(cmd, 'Bash', { CREWLY_GUARD_BLOCK_MAIN_PUSH: '1' }).status).toBe(2);
	});

	it('blocks a bare push while main is checked out when main pushes are opted in', () => {
		spawnSync('git', ['checkout', '-q', '-b', 'main'], { cwd });
		expect(run('git push', 'Bash', { CREWLY_GUARD_BLOCK_MAIN_PUSH: '1' }).status).toBe(2);
	});

	it.each(['git push origin main', 'git push origin HEAD:master'])('allows `%s` by default (some teams ship by pushing main)', (cmd) => {
		expect(run(cmd).status).toBe(0);
	});
});

describe('allowed forms', () => {
	const allowed = [
		'git push origin feat/x',
		'git push -u origin feat/x',
		'git push',
		'git reset --soft HEAD~1',
		'git reset HEAD file.ts',
		'git clean -n',
		'git clean -nfd',
		'git branch -d merged',
		'git branch --list',
		'git checkout -b new-branch',
		'git checkout feat/y',
		'git checkout -- src/file.ts',
		'git restore --staged .',
		'git restore src/file.ts',
		'git stash -u',
		'git status && git diff',
		'ls -la',
	];
	it.each(allowed)('allows `%s`', (cmd) => {
		const r = run(cmd);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/\d+ command\(s\) checked/);
	});

	it('ignores non-Bash tools and says nothing was checked', () => {
		const r = run('git reset --hard', 'Read');
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('0 command(s) checked');
	});
});

describe('could not check', () => {
	it('exits 1 on unparsable input', () => {
		const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf-8' });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('0 command(s) checked');
	});
});

describe('gh pr merge (crewly#1369)', () => {
	const BASE_AT = '2026-10-17T10:00:00Z';
	const BEFORE = '2026-10-17T09:00:00Z';
	const AFTER = '2026-10-17T11:00:00Z';
	const green = (at: string) => [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: at }];

	/** A fake `gh` that answers from canned values; `fail` makes `pr view` fail. */
	function fakeGh(opts: { behind?: number; checks?: unknown[]; fail?: boolean }): string {
		const file = join(cwd, 'fake-gh.js');
		const pr = { number: 42, url: 'https://github.com/o/r/pull/42', baseRefName: 'main', headRefOid: 'abc', statusCheckRollup: opts.checks ?? green(AFTER) };
		writeFileSync(
			file,
			`#!/usr/bin/env node
const a = process.argv.slice(2);
if (${opts.fail ? 'true' : 'false'}) { process.stderr.write('auth'); process.exit(1); }
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(${JSON.stringify(JSON.stringify(pr))}); process.exit(0); }
if (a[0] === 'api' && a[1].includes('/compare/main...abc')) { process.stdout.write('${opts.behind ?? 0}'); process.exit(0); }
if (a[0] === 'api' && a[1].endsWith('/commits/main')) { process.stdout.write('${BASE_AT}'); process.exit(0); }
process.exit(3);
`,
		);
		chmodSync(file, 0o755);
		return file;
	}

	const merge = (gh: string, cmd = 'gh pr merge 42 --squash', env: NodeJS.ProcessEnv = {}) => run(cmd, 'Bash', { CREWLY_GUARD_GH: gh, ...env });

	it('allows an up-to-date PR with green CI', () => {
		expect(merge(fakeGh({ behind: 0 })).status).toBe(0);
	});

	it('allows a PR a little behind when CI ran after the base head', () => {
		expect(merge(fakeGh({ behind: 2, checks: green(AFTER) })).status).toBe(0);
	});

	it('blocks a PR too far behind base and says to update the branch', () => {
		const r = merge(fakeGh({ behind: 12 }), 'gh pr merge 42 --squash --delete-branch');
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('12 commits behind main');
		expect(r.stderr).toContain('gh pr update-branch');
	});

	it('honours CREWLY_GUARD_MERGE_MAX_BEHIND', () => {
		expect(merge(fakeGh({ behind: 2 }), undefined, { CREWLY_GUARD_MERGE_MAX_BEHIND: '1' }).status).toBe(2);
	});

	it('blocks when behind and the latest CI predates the base head', () => {
		const r = merge(fakeGh({ behind: 1, checks: green(BEFORE) }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('predates the head of main');
	});

	it('blocks when CI is failing or still running', () => {
		expect(merge(fakeGh({ checks: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: AFTER }] })).stderr).toContain('CI is not green');
		expect(merge(fakeGh({ checks: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS', conclusion: '' }] })).status).toBe(2);
		expect(merge(fakeGh({ checks: [{ __typename: 'StatusContext', context: 'ci/x', state: 'PENDING' }] })).status).toBe(2);
	});

	it('blocks when gh cannot be asked (fail closed)', () => {
		const r = merge(fakeGh({ fail: true }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('could not read the PR');
	});

	it('checks merges inside a chain and passes -R through', () => {
		expect(merge(fakeGh({ behind: 9 }), 'cd /tmp && gh pr merge -R o/r 42').status).toBe(2);
	});

	it('leaves other gh commands, --disable-auto and the off switch alone', () => {
		const gh = fakeGh({ behind: 50 });
		expect(merge(gh, 'gh pr view 42').status).toBe(0);
		expect(merge(gh, 'gh pr merge 42 --disable-auto').status).toBe(0);
		expect(merge(gh, undefined, { CREWLY_GUARD_MERGE_CHECK: '0' }).status).toBe(0);
	});
});

describe('local gate for repos whose CI cannot run (CREW-837)', () => {
	const BASE_AT = '2026-10-17T10:00:00Z';
	const AFTER = '2026-10-17T11:00:00Z';
	const SHA = 'abc';
	const BASE_SHA = 'base111';
	/** The check GitHub reports when billing stopped the job: FAILURE, never started. */
	const unstarted = { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: AFTER, detailsUrl: 'https://github.com/o/r/actions/runs/1/job/77' };
	let home: string;

	/** Writes the gates config (entry for o/r) and returns env pointing the guard at it. */
	function gateEnv(entry: unknown = { gate: ['true'], contentPaths: ['content/blog/**/*.md'] }): NodeJS.ProcessEnv {
		const cfg = join(cwd, 'local-gates.json');
		writeFileSync(cfg, JSON.stringify({ 'o/r': entry }));
		return { CREWLY_GUARD_LOCAL_GATES: cfg, CREWLY_HOME: home };
	}

	/** Records a local-gate run for PR 42 the way record-local-gate writes it. */
	function record(over: Record<string, unknown> = {}, name = `pr-42-${SHA}.json`): string {
		const dir = join(home, 'local-gates', 'o__r');
		mkdirSync(dir, { recursive: true });
		const file = join(dir, name);
		writeFileSync(file, JSON.stringify({ sha: SHA, baseRef: 'main', baseSha: BASE_SHA, command: 'true', exitCode: 0, finishedAt: AFTER, ...over }));
		return file;
	}

	/**
	 * A fake `gh` for a PR in o/r. `files` are [filename, previous_filename] pairs;
	 * `steps`/`note` describe the job behind the check's detailsUrl.
	 */
	function fakeGh(opts: { checks?: unknown[]; behind?: number; files?: string[][]; steps?: number; note?: string; baseSha?: string }): string {
		const file = join(cwd, 'fake-gh.js');
		const pr = { number: 42, url: 'https://github.com/o/r/pull/42', baseRefName: 'main', headRefOid: SHA, statusCheckRollup: opts.checks ?? [unstarted] };
		const files = (opts.files ?? [['content/blog/a.md', ''], ['content/blog/zh/a.md', '']]).map((f) => f.join('\t')).join('\n');
		writeFileSync(
			file,
			`#!/usr/bin/env node
const a = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (a[0] === 'pr' && a[1] === 'view') out(${JSON.stringify(JSON.stringify(pr))});
const p = a[0] === 'api' ? a.find((x) => x.startsWith('repos/')) || '' : '';
if (p.includes('/compare/main...${SHA}')) out('${opts.behind ?? 0}');
if (p.endsWith('/commits/main') && a.includes('.sha')) out('${opts.baseSha ?? BASE_SHA}');
if (p.endsWith('/commits/main')) out('${BASE_AT}');
if (p.endsWith('/pulls/42/files')) out(${JSON.stringify(files)});
if (p.endsWith('/actions/jobs/77')) out('${opts.steps ?? 0}');
if (p.endsWith('/check-runs/77/annotations')) out(${JSON.stringify(opts.note ?? 'The job was not started because recent account payments have failed or your spending limit needs to be increased.')});
process.exit(3);
`,
		);
		chmodSync(file, 0o755);
		return file;
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'dgg-home-'));
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const merge = (gh: string, env: NodeJS.ProcessEnv = gateEnv()) => run('gh pr merge 42 --squash', 'Bash', { CREWLY_GUARD_GH: gh, ...env });

	it('allows a content-only PR with a green local record, and names the record used', () => {
		const file = record();
		const r = merge(fakeGh({}));
		expect(r.status).toBe(0);
		expect(r.stdout).toContain('local gate accepted for PR #42');
		expect(r.stdout).toContain(file);
		expect(r.stdout).toContain('2 content file(s)');
	});

	it('allows when there is no CI run at all and the PR is behind but the record matches the base head', () => {
		record();
		expect(merge(fakeGh({ checks: [], behind: 2 })).status).toBe(0);
	});

	it('blocks a content-only PR with no record', () => {
		const r = merge(fakeGh({}));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('CI is not green');
		expect(r.stderr).toContain('local gate: no local-gate record at abc');
		expect(r.stderr).toContain('record-local-gate --repo o/r --pr 42');
	});

	it('blocks when the record is for another commit', () => {
		record({ sha: 'other' }, 'pr-42-zzz.json'); // a record for another head: not found at abc
		expect(merge(fakeGh({})).stderr).toContain('no local-gate record at abc');
		record({ sha: 'other' }); // right file name, wrong content
		expect(merge(fakeGh({})).stderr).toContain('for another commit');
	});

	it('blocks when the recorded gate failed', () => {
		record({ exitCode: 1 });
		const r = merge(fakeGh({}));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('failed (exit 1)');
	});

	it('blocks when one changed file is not content, and lists it', () => {
		record();
		const r = merge(fakeGh({ files: [['content/blog/a.md', ''], ['src/app.ts', '']] }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('non-content files: src/app.ts');
	});

	it('blocks a rename out of a non-content path into content', () => {
		record();
		const r = merge(fakeGh({ files: [['content/blog/a.md', 'src/app.ts']] }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('src/app.ts');
	});

	it('blocks when the repo has no local-gates entry', () => {
		record();
		const cfg = join(cwd, 'other.json');
		writeFileSync(cfg, JSON.stringify({ 'x/y': { gate: ['true'], contentPaths: ['**'] } }));
		const r = merge(fakeGh({}), { CREWLY_GUARD_LOCAL_GATES: cfg, CREWLY_HOME: home });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('no local-gates entry for o/r');
	});

	it('blocks a stale record when the base moved and the PR is behind', () => {
		record();
		const r = merge(fakeGh({ behind: 2, baseSha: 'base222' }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('stale');
		expect(r.stderr).toContain('base222');
	});

	it('blocks a check that really failed, even with a green record', () => {
		record();
		const r = merge(fakeGh({ steps: 4, note: 'Process completed with exit code 1.' }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('a check really failed (test)');
	});

	it('treats a failed check with steps but a "not started" note as a real failure', () => {
		record();
		expect(merge(fakeGh({ steps: 3 })).status).toBe(2);
	});

	it('fails closed when a failed check cannot be inspected', () => {
		record();
		const bare = { ...unstarted, detailsUrl: '' };
		expect(merge(fakeGh({ checks: [bare] })).status).toBe(2);
	});

	it('does not relax a PR that is too far behind', () => {
		record();
		expect(merge(fakeGh({ behind: 12 })).stderr).toContain('12 commits behind main');
	});

	it('leaves a code PR with red CI blocked exactly as before (no local record can help)', () => {
		record();
		const red = { ...unstarted, detailsUrl: '' };
		const r = merge(fakeGh({ checks: [red], files: [['src/app.ts', '']] }));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('CI is not green on PR #42 (test)');
	});

	it('leaves green CI allowed as before, without touching the local gate', () => {
		const r = merge(fakeGh({ checks: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: AFTER }], files: [['src/app.ts', '']] }));
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain('local gate');
	});

	describe('code PRs in a repo with codePrs (CREW-839)', () => {
		const code = [['src/app.ts', ''], ['content/blog/a.md', '']];
		const codeEnv = () => gateEnv({ gate: ['true'], contentPaths: ['content/blog/**/*.md'], codePrs: true });
		/** Writes a TL marker the way record-tl-verification does. */
		function marker(over: Record<string, unknown> = {}, name = `pr-42-${SHA}.tl.json`): void {
			const dir = join(home, 'local-gates', 'o__r');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, name), JSON.stringify({ sha: SHA, verifier: 'tl-sam', summary: 'read the diff', ...over }));
		}

		it('allows a code PR with a green record and a TL marker, and names both sessions', () => {
			record({ recordedBy: 'dev-max' });
			marker();
			const r = merge(fakeGh({ files: code }), codeEnv());
			expect(r.status).toBe(0);
			expect(r.stdout).toContain('code PR');
			expect(r.stdout).toContain('TL verified by tl-sam (gate run by dev-max): read the diff');
		});

		it('blocks a code PR with a record but no TL marker', () => {
			record();
			const r = merge(fakeGh({ files: code }), codeEnv());
			expect(r.status).toBe(2);
			expect(r.stderr).toContain('no TL verification marker at abc');
			expect(r.stderr).toContain('record-tl-verification --repo o/r --pr 42');
			expect(r.stderr).toContain('src/app.ts');
		});

		it('blocks a code PR whose marker is for another commit', () => {
			record();
			marker({ sha: 'other' }, 'pr-42-other.tl.json');
			expect(merge(fakeGh({ files: code }), codeEnv()).stderr).toContain('marker is for another commit, not abc');
			marker({ sha: 'other' }); // right file name, wrong content
			expect(merge(fakeGh({ files: code }), codeEnv()).stderr).toContain('marker is for another commit');
		});

		it('blocks a code PR with a marker but no passing record', () => {
			marker();
			expect(merge(fakeGh({ files: code }), codeEnv()).stderr).toContain('no local-gate record at abc');
			record({ exitCode: 1 });
			expect(merge(fakeGh({ files: code }), codeEnv()).stderr).toContain('failed (exit 1)');
		});

		it('blocks a marker written by the session that ran the gate', () => {
			record({ recordedBy: 'tl-sam' });
			marker();
			const r = merge(fakeGh({ files: code }), codeEnv());
			expect(r.status).toBe(2);
			expect(r.stderr).toContain('another team leader must verify');
		});

		it('blocks a marker that names no verifier', () => {
			record();
			marker({ verifier: '' });
			expect(merge(fakeGh({ files: code }), codeEnv()).stderr).toContain('names no verifier');
		});

		it('keeps blocking a code PR in a repo without codePrs, with a marker and record in place', () => {
			record();
			marker();
			const r = merge(fakeGh({ files: code }));
			expect(r.status).toBe(2);
			expect(r.stderr).toContain('non-content files: src/app.ts');
		});

		it('still blocks a code PR when a check really failed, even with record and marker', () => {
			record();
			marker();
			const r = merge(fakeGh({ files: code, steps: 4, note: 'Process completed with exit code 1.' }), codeEnv());
			expect(r.status).toBe(2);
			expect(r.stderr).toContain('a check really failed');
		});

		it('leaves the content-only path as it was: no marker needed, codePrs or not', () => {
			record();
			expect(merge(fakeGh({}), codeEnv()).status).toBe(0);
			expect(merge(fakeGh({})).status).toBe(0);
		});
	});
});
