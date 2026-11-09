#!/usr/bin/env node
// Crewly destructive-git guard — a PreToolUse hook for the Bash tool that stops
// an agent from running git commands that destroy its own unmerged work.
//
// Blocked: push --force / -f / --force-with-lease / +refspec (any branch),
// push to main or master only when CREWLY_GUARD_BLOCK_MAIN_PUSH=1 (named, or a bare
// push while main/master is checked out; off by default because some teams ship by
// pushing main, e.g. CE and Bitbucket projects),
// reset --hard, clean -f (any form that is not a dry run), branch -D (or -d -f),
// checkout . / checkout -- ., restore . (unless --staged only).
// Allowed: a normal `git push origin feat/x`, stash, branch -d, everything read-only.
//
// Usage (wired by the backend through `claude --settings <file>`): the hook reads
// PreToolUse JSON on stdin; no arguments.
// Exit: 0 allowed (stdout says how many commands were checked), 2 blocked (stderr is
// fed back to the agent), 1 could not check (never a silent pass).
//
// Also blocked (crewly#1369): `gh pr merge` of a PR that is not verified against its base —
// its head is more than CREWLY_GUARD_MERGE_MAX_BEHIND (default 5) commits behind the base
// branch, its CI is not green, or (when behind at all) its latest CI run predates the base
// branch's head. The agent must `gh pr update-branch` and wait for fresh green CI first.
// The check asks GitHub through `gh` (CREWLY_GUARD_GH overrides the binary); when it cannot
// ask, the merge is blocked. CREWLY_GUARD_MERGE_CHECK=0 turns it off.
//
// Local gate (private repos whose CI cannot run): a merge that CI would block (a check not green,
// or none to show the merge works) is accepted when ALL of: the repo has an entry in
// local-gates.json; every changed file (and every renamed-from path) matches that entry's
// contentPaths; `record-local-gate` recorded exitCode 0 for exactly the PR head SHA; the record
// was made against the current base head (or the PR is not behind); and no check really failed
// (a job that never started because GitHub billing/spending limits stopped it counts as absent).
// Anything else is blocked as before, and the message says what is missing. The record is a file
// the agent could write by hand: a speed bump, not a boundary. A repo with "codePrs": true also
// accepts a PR with non-content files, but only with a TL marker for the same head SHA written by
// `record-tl-verification` (a team leader other than the session that ran the gate). A PR more than
// CREWLY_GUARD_MERGE_MAX_BEHIND commits behind is still blocked.
//
// Coverage limits: an interpreter one-liner (python -c, node -e), a command built at
// runtime ($VAR, base64, a script the agent writes then runs) and `$(...)` inside
// double quotes are NOT seen. A speed bump, not a boundary (same as control-plane-guard).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PREFIX = 'destructive-git-guard:';
const PROTECTED_BRANCHES = new Set(['main', 'master']);
/** Pushing main/master is blocked only on opt-in: some teams ship by pushing main. */
const BLOCK_MAIN_PUSH = process.env.CREWLY_GUARD_BLOCK_MAIN_PUSH === '1';
const WRAPPERS = new Set(['sudo', 'command', 'nohup', 'time', 'exec', 'env', 'nice', 'builtin', 'stdbuf', 'timeout']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** Split a command line into simple commands (arrays of words). Quotes and backslashes are honoured. */
function parseCommands(src) {
	const cmds = [];
	let words = [];
	let cur = '';
	let has = false;
	const pushWord = () => {
		if (has) words.push(cur);
		cur = '';
		has = false;
	};
	const endCmd = () => {
		pushWord();
		if (words.length) cmds.push(words);
		words = [];
	};
	for (let i = 0; i < src.length; i += 1) {
		const c = src[i];
		if (c === "'") {
			const j = src.indexOf("'", i + 1);
			const end = j === -1 ? src.length : j;
			cur += src.slice(i + 1, end);
			has = true;
			i = end;
		} else if (c === '"') {
			let j = i + 1;
			while (j < src.length && src[j] !== '"') {
				if (src[j] === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1])) j += 1;
				cur += src[j];
				j += 1;
			}
			has = true;
			i = j;
		} else if (c === '\\') {
			if (i + 1 < src.length && src[i + 1] !== '\n') {
				cur += src[i + 1];
				has = true;
			}
			i += 1;
		} else if (c === '$' && src[i + 1] === '(') {
			endCmd();
			i += 1;
		} else if (';\n()`{}&|'.includes(c)) {
			endCmd();
		} else if (/\s/.test(c)) {
			pushWord();
		} else {
			cur += c;
			has = true;
		}
	}
	endCmd();
	return cmds;
}

/** Drop leading VAR=value words and wrappers (sudo, env, ...). */
function stripWrappers(words) {
	let i = 0;
	for (;;) {
		const w = words[i];
		if (w === undefined) break;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1;
		else if (WRAPPERS.has(w.split('/').pop())) {
			const wrapper = w.split('/').pop();
			i += 1;
			while (words[i] !== undefined && words[i].startsWith('-')) i += 1;
			if (wrapper === 'timeout') i += 1;
		} else break;
	}
	return words.slice(i);
}

/** Current branch of `cwd`, or '' when it cannot be read. */
function currentBranch(cwd, dir) {
	try {
		return execFileSync('git', ['-C', dir ?? cwd, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
	} catch {
		return '';
	}
}

const hasShort = (flags, letter) => flags.some((f) => /^-[A-Za-z]+$/.test(f) && f.includes(letter));

/** @returns {string|null} why `git <sub> <rest>` is destructive, or null. */
function judgeGit(sub, rest, cwd, dir) {
	const flags = rest.filter((a) => a.startsWith('-'));
	const pos = rest.filter((a) => !a.startsWith('-'));
	switch (sub) {
		case 'push': {
			if (hasShort(flags, 'f') || flags.some((f) => f === '--force' || f.startsWith('--force-with-lease') || f === '--force-if-includes' || f === '--mirror')) {
				return 'force-push rewrites remote history';
			}
			const refs = pos.slice(1); // pos[0] is the remote
			if (refs.some((r) => r.startsWith('+'))) return 'a +refspec is a force-push';
			const target = (r) => r.replace(/^\+/, '').split(':').pop().replace(/^refs\/heads\//, '');
			if (!BLOCK_MAIN_PUSH) return null;
			if (refs.some((r) => PROTECTED_BRANCHES.has(target(r)))) return 'pushing to main/master directly';
			if (refs.length === 0 && PROTECTED_BRANCHES.has(currentBranch(cwd, dir))) return 'pushing main/master directly';
			return null;
		}
		case 'reset':
			return flags.includes('--hard') ? 'reset --hard discards uncommitted and unpushed work' : null;
		case 'clean':
			if (flags.includes('--dry-run') || hasShort(flags, 'n')) return null;
			return hasShort(flags, 'f') || flags.includes('--force') ? 'clean -f deletes untracked files for good' : null;
		case 'branch':
			if (hasShort(flags, 'D')) return 'branch -D deletes a branch even when it is unmerged';
			if (flags.includes('--delete') && (flags.includes('--force') || hasShort(flags, 'f'))) return 'forced branch delete';
			if (hasShort(flags, 'd') && hasShort(flags, 'f')) return 'forced branch delete';
			return null;
		case 'checkout':
			return rest.includes('.') && !flags.some((f) => f === '-b' || f === '-B') ? 'checkout . discards every uncommitted change' : null;
		case 'restore':
			if (pos.includes('.') && !(flags.includes('--staged') && !flags.includes('--worktree') && !hasShort(flags, 'W'))) {
				return 'restore . discards every uncommitted change';
			}
			return null;
		default:
			return null;
	}
}

/** Max commits a PR head may be behind its base when an agent merges it. */
const MERGE_MAX_BEHIND = (() => {
	const n = Number(process.env.CREWLY_GUARD_MERGE_MAX_BEHIND);
	return Number.isFinite(n) && n >= 0 ? n : 5;
})();
const MERGE_CHECK_ON = process.env.CREWLY_GUARD_MERGE_CHECK !== '0';
const GH_BIN = process.env.CREWLY_GUARD_GH || 'gh';
const GH_TIMEOUT_MS = 20000;
/** `gh pr merge` flags that take a value. */
const GH_MERGE_VALUE_FLAGS = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit']);
/** Check results that count as green. */
const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** Run gh and return stdout (throws on failure). */
function gh(args, dir) {
	return execFileSync(GH_BIN, args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: GH_TIMEOUT_MS }).trim();
}

/** Name and verdict of one statusCheckRollup entry (CheckRun or StatusContext). */
function checkState(c) {
	const name = c.name || c.context || 'check';
	if (c.__typename === 'StatusContext' || (c.state && !c.status)) return { name, green: GREEN.has(String(c.state).toUpperCase()), at: c.startedAt || c.createdAt };
	const done = String(c.status || '').toUpperCase() === 'COMPLETED';
	return { name, green: done && GREEN.has(String(c.conclusion || '').toUpperCase()), at: c.completedAt || c.startedAt };
}


/** Repos with a local-gate path (config next to this file; CREWLY_GUARD_LOCAL_GATES overrides). */
const LOCAL_GATES_FILE = process.env.CREWLY_GUARD_LOCAL_GATES || join(dirname(fileURLToPath(import.meta.url)), 'local-gates.json');
/** Where `record-local-gate` writes its records. */
const LOCAL_GATES_DIR = join(process.env.CREWLY_HOME || join(homedir(), '.crewly'), 'local-gates');
/** GitHub's own wording for a job that never started because of billing or the spending limit. */
const NOT_STARTED_RE = /was not started because/i;
/** The files endpoint stops at 3000 files; a PR that large is not a content PR. */
const FILES_CAP = 3000;

/** Glob (`**` crosses directories, `*` does not) to an anchored RegExp. */
function globToRegExp(glob) {
	let re = '';
	for (let i = 0; i < glob.length; i += 1) {
		const c = glob[i];
		if (c === '*' && glob[i + 1] === '*') {
			if (glob[i + 2] === '/') {
				re += '(?:.*/)?';
				i += 2;
			} else {
				re += '.*';
				i += 1;
			}
		} else if (c === '*') re += '[^/]*';
		else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${re}$`);
}

/** The local-gates entry for `slug` (owner/name), or null (no file, bad file, no entry). */
function localGateEntry(slug) {
	try {
		const entry = JSON.parse(readFileSync(LOCAL_GATES_FILE, 'utf8'))?.[slug];
		if (!entry || !Array.isArray(entry.contentPaths) || entry.contentPaths.length === 0) return null;
		return entry;
	} catch {
		return null;
	}
}

/**
 * True when a CI check did not run at all: a finished job with no steps whose annotation says GitHub
 * never started it (billing / spending limit). Anything else non-green, including a check we cannot
 * inspect, is a real failure (fail closed). Two cheap `gh api` calls, only for non-green checks.
 */
function checkNeverRan(c, api, dir) {
	try {
		const m = /\/actions\/runs\/\d+\/job\/(\d+)/.exec(String(c.detailsUrl || ''));
		if (!m || c.__typename === 'StatusContext' || String(c.status || '').toUpperCase() !== 'COMPLETED') return false;
		if (Number(gh(['api', `${api}/actions/jobs/${m[1]}`, '--jq', '.steps | length'], dir)) !== 0) return false;
		return NOT_STARTED_RE.test(gh(['api', `${api}/check-runs/${m[1]}/annotations`, '--jq', '[.[].message] | join("\n")'], dir));
	} catch {
		return false;
	}
}

/**
 * May this merge go ahead on a recorded local green run instead of CI?
 * @returns {{ok: true, note: string} | {ok: false, why: string}}
 */
function judgeLocalGate(pr, slug, api, base, behind, realFailures, dir) {
	const entry = localGateEntry(slug);
	if (!entry) return { ok: false, why: `no local-gates entry for ${slug}` };
	if (realFailures.length > 0) return { ok: false, why: `a check really failed (${realFailures.slice(0, 5).join(', ')}); a local run does not override it` };
	const matchers = entry.contentPaths.map(globToRegExp);
	let files;
	try {
		files = gh(['api', '--paginate', `${api}/pulls/${pr.number}/files`, '--jq', '.[] | [.filename, (.previous_filename // "")] | @tsv'], dir)
			.split('\n')
			.filter(Boolean)
			.map((l) => l.split('\t'));
	} catch {
		return { ok: false, why: 'could not list the PR files to check it is content-only' };
	}
	if (files.length === 0 || files.length >= FILES_CAP) return { ok: false, why: `the PR file list is empty or too long to check (${files.length})` };
	const outside = [...new Set(files.flatMap(([f, prev]) => [f, prev]).filter(Boolean).filter((f) => !matchers.some((re) => re.test(f))))];
	// A code PR (a file outside contentPaths) needs the repo's opt-in `codePrs` plus a TL marker below.
	const codePr = outside.length > 0;
	if (codePr && entry.codePrs !== true) {
		return { ok: false, why: `not content-only, non-content files: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? `, +${outside.length - 5} more` : ''}` };
	}
	const file = join(LOCAL_GATES_DIR, slug.replace('/', '__'), `pr-${pr.number}-${pr.headRefOid}.json`);
	const fix = `run record-local-gate --repo ${slug} --pr ${pr.number}`;
	if (!existsSync(file)) return { ok: false, why: `no local-gate record at ${String(pr.headRefOid).slice(0, 10)} (${fix})` };
	let rec;
	try {
		rec = JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return { ok: false, why: `the local-gate record ${file} is unreadable (${fix})` };
	}
	if (rec?.sha !== pr.headRefOid) return { ok: false, why: `the local-gate record is for another commit (${fix})` };
	if (rec.exitCode !== 0) return { ok: false, why: `the local gate at ${String(pr.headRefOid).slice(0, 10)} failed (exit ${rec.exitCode})` };
	if (behind > 0) {
		let baseHead;
		try {
			baseHead = gh(['api', `${api}/commits/${encodeURIComponent(base)}`, '--jq', '.sha'], dir);
		} catch {
			return { ok: false, why: `could not read the head of ${base} to check the record is not stale` };
		}
		if (rec.baseSha !== baseHead) return { ok: false, why: `stale: the record was made against ${String(rec.baseSha).slice(0, 10)} but ${base} is now at ${baseHead.slice(0, 10)} (re-run record-local-gate)` };
	}
	let tl = '';
	if (codePr) {
		const dir2 = join(LOCAL_GATES_DIR, slug.replace('/', '__'));
		const markerFix = `a team leader runs record-tl-verification --repo ${slug} --pr ${pr.number} --summary "<what you checked>"`;
		const markerFile = join(dir2, `pr-${pr.number}-${pr.headRefOid}.tl.json`);
		if (!existsSync(markerFile)) {
			let other = [];
			try {
				other = readdirSync(dir2).filter((f) => f.startsWith(`pr-${pr.number}-`) && f.endsWith('.tl.json'));
			} catch {
				other = [];
			}
			return { ok: false, why: other.length > 0 ? `the TL verification marker is for another commit, not ${String(pr.headRefOid).slice(0, 10)} (${markerFix})` : `code PR (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''}): no TL verification marker at ${String(pr.headRefOid).slice(0, 10)} (${markerFix})` };
		}
		let marker;
		try {
			marker = JSON.parse(readFileSync(markerFile, 'utf8'));
		} catch {
			return { ok: false, why: `the TL verification marker ${markerFile} is unreadable (${markerFix})` };
		}
		if (marker?.sha !== pr.headRefOid) return { ok: false, why: `the TL verification marker is for another commit (${markerFix})` };
		if (typeof marker.verifier !== 'string' || marker.verifier === '') return { ok: false, why: 'the TL verification marker names no verifier' };
		if (marker.verifier === rec.recordedBy) return { ok: false, why: `the TL verification marker was written by the session that ran the gate (${marker.verifier}); another team leader must verify` };
		tl = `; TL verified by ${marker.verifier} (gate run by ${rec.recordedBy ?? '?'}): ${String(marker.summary ?? '').slice(0, 120)}`;
	}
	return { ok: true, note: `local gate accepted for PR #${pr.number} in place of CI: record ${file} (head ${String(pr.headRefOid).slice(0, 10)}, exit 0, finished ${rec.finishedAt ?? '?'}, ${files.length} ${codePr ? 'file(s), code PR' : 'content file(s)'})${tl}` };
}

/** @returns {string|null} why `gh pr merge <rest>` is not a verified merge, or null. */
function judgePrMerge(rest, dir) {
	if (!MERGE_CHECK_ON || rest.includes('--disable-auto')) return null;
	let repo = null;
	let sel = null;
	for (let i = 0; i < rest.length; i += 1) {
		const a = rest[i];
		if (a === '-R' || a === '--repo') repo = rest[i + 1] ?? null;
		if (a.startsWith('--repo=')) repo = a.slice('--repo='.length);
		if (GH_MERGE_VALUE_FLAGS.has(a)) i += 1;
		else if (!a.startsWith('-') && sel === null) sel = a;
	}
	const repoArgs = repo ? ['-R', repo] : [];
	let pr;
	try {
		pr = JSON.parse(gh(['pr', 'view', ...(sel ? [sel] : []), ...repoArgs, '--json', 'number,url,baseRefName,headRefOid,statusCheckRollup'], dir));
	} catch {
		return 'could not read the PR with gh to check it is up to date with its base and has fresh green CI (fix gh auth / network and retry)';
	}
	const m = /github\.com\/([^/]+)\/([^/]+)\/pull\//.exec(String(pr.url || ''));
	if (!m) return `could not tell which GitHub repo PR ${pr.number ?? sel ?? ''} is in`;
	const api = `repos/${m[1]}/${m[2]}`;
	const base = String(pr.baseRefName || 'main');
	let behind;
	let baseAt;
	try {
		behind = Number(gh(['api', `${api}/compare/${encodeURIComponent(base)}...${pr.headRefOid}`, '--jq', '.behind_by'], dir));
		baseAt = Date.parse(gh(['api', `${api}/commits/${encodeURIComponent(base)}`, '--jq', '.commit.committer.date'], dir));
	} catch {
		return `could not compare PR #${pr.number} with ${base} on GitHub (fix gh auth / network and retry)`;
	}
	if (!Number.isFinite(behind)) return `could not compare PR #${pr.number} with ${base} on GitHub`;
	const n = pr.number;
	if (behind > MERGE_MAX_BEHIND) return `PR #${n} is ${behind} commits behind ${base} (more than ${MERGE_MAX_BEHIND}); its CI did not run on what the merge would produce`;
	const rollup = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
	const checks = rollup.map((c) => ({ ...checkState(c), raw: c }));
	const notGreen = checks.filter((c) => !c.green);
	// A CI-state problem (not the behind-limit above): the local gate may stand in for CI.
	let ciReason = null;
	let realFailures = [];
	if (notGreen.length > 0) {
		ciReason = `CI is not green on PR #${n} (${notGreen.slice(0, 5).map((c) => c.name).join(', ')})`;
		realFailures = notGreen.filter((c) => !checkNeverRan(c.raw, api, dir)).map((c) => c.name);
	} else if (behind > 0) {
		if (checks.length === 0) ciReason = `PR #${n} is ${behind} commit(s) behind ${base} and has no CI run to show the merge result works`;
		else {
			const latest = Math.max(...checks.map((c) => Date.parse(c.at || '')).filter((t) => Number.isFinite(t)));
			if (!Number.isFinite(latest) || (Number.isFinite(baseAt) && latest < baseAt)) {
				ciReason = `PR #${n}'s latest CI run predates the head of ${base} (the PR is ${behind} commit(s) behind)`;
			}
		}
	}
	if (ciReason === null) return null;
	const local = judgeLocalGate({ number: n, headRefOid: pr.headRefOid }, `${m[1]}/${m[2]}`, api, base, behind, realFailures, dir);
	if (local.ok) {
		process.stdout.write(`${PREFIX} ${local.note}\n`);
		return null;
	}
	return `${ciReason}; local gate: ${local.why}`;
}

let checked = 0;

function analyze(command, cwd, depth = 0) {
	for (const raw of parseCommands(command)) {
		const words = stripWrappers(raw);
		if (!words.length) continue;
		checked += 1;
		const verb = words[0].split('/').pop();
		if (SHELLS.has(verb)) {
			const ci = words.findIndex((a, i) => i > 0 && /^-[a-z]*c$/.test(a));
			if (ci !== -1 && words[ci + 1] !== undefined && depth < 4) analyze(words[ci + 1], cwd, depth + 1);
			continue;
		}
		if (verb === 'gh') {
			if (words[1] === 'pr' && words[2] === 'merge') {
				const reason = judgePrMerge(words.slice(3), cwd);
				if (reason) denyMerge(`\`gh ${words.slice(1).join(' ')}\` — ${reason}`);
			}
			continue;
		}
		if (verb !== 'git') continue;
		let i = 1;
		let dir = null;
		while (i < words.length && words[i].startsWith('-')) {
			if (words[i] === '-C') {
				dir = words[i + 1] ?? dir;
				i += 2;
			} else if (words[i] === '-c' || words[i] === '--git-dir' || words[i] === '--work-tree' || words[i] === '--namespace') i += 2;
			else i += 1;
		}
		const reason = judgeGit(words[i] ?? '', words.slice(i + 1), cwd, dir);
		if (reason) deny(`\`git ${words.slice(i).join(' ')}\` — ${reason}`);
	}
}

function deny(what) {
	process.stderr.write(
		`${PREFIX} BLOCKED — ${what}.\n` +
			`${PREFIX} You do not have authority to run this. Safer: stash first (git stash -u), delete a merged branch with -d, ` +
			'push your feature branch normally (no force) and open a PR, or ask your team lead if it is really needed.\n',
	);
	process.exit(2);
}

function denyMerge(what) {
	process.stderr.write(
		`${PREFIX} BLOCKED — ${what}.\n` +
			`${PREFIX} A merge on stale or missing CI is not a verified merge. Run \`gh pr update-branch <PR>\`, wait for CI to pass on the updated branch ` +
			'(`gh pr checks <PR> --watch`), then merge. If the update conflicts, resolve it on the branch and push; do not merge around it.\n',
	);
	process.exit(2);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
	let input;
	try {
		input = JSON.parse(raw);
	} catch {
		process.stderr.write(`${PREFIX} unparsable hook input — 0 command(s) checked\n`);
		process.exit(1);
	}
	const command = input?.tool_input?.command;
	if (String(input?.tool_name ?? '') !== 'Bash' || typeof command !== 'string') {
		process.stdout.write(`${PREFIX} allowed — not a Bash call, 0 command(s) checked\n`);
		process.exit(0);
	}
	const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
	analyze(command, cwd);
	process.stdout.write(`${PREFIX} allowed — ${checked} command(s) checked\n`);
	process.exit(0);
});
