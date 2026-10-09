#!/usr/bin/env node
// Crewly live-checkout guard — a pre-tool hook that stops an agent changing the
// LIVE Crewly checkout (the one the running Crewly was built and is served from).
//
// Incident (2026-10-08/09): an agent edited files in, then `git switch`ed and
// committed in, the live checkout. On the next restart Crewly refused to start
// ("STALE BUILD: ... HEAD is ...") and was down until an admin switched back.
//
// Usage (wired by the backend; PreToolUse JSON on stdin):
//   node guard.mjs <live-root> [<live-root> ...]
//
// Judged:
//   - Bash (also Codex "Bash"): git state-changing subcommands whose target is a
//     live root (`cd <live> && git ...`, `git -C <live> ...`, `--git-dir`,
//     `--work-tree`, or the call's cwd being the live root); writes to the live
//     root by redirection, rm/mv/cp/touch/tee/mkdir/chmod/truncate/dd/sed -i/perl -i.
//   - Edit / Write / MultiEdit / NotebookEdit: file_path / notebook_path under a live root.
//   - Codex apply_patch: "*** Update/Add/Delete File:" paths in the patch text.
// Always allowed: read-only git (status, log, diff, show, fetch, ls-remote,
// branch --list, ...), reads, and anything under a `.crewly/` directory (agent
// data: tickets, findings, drafts).
//
// Exit: 0 allowed, 2 blocked (stderr is fed back to the agent), 1 could not check
// (non-blocking, never a silent pass).
//
// Coverage limits: an interpreter one-liner (python -c, node -e), a path built at
// runtime ($VAR other than HOME, globs, base64), a script the agent writes and
// runs, and `$(...)` inside double quotes are NOT seen. A speed bump, not a boundary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREFIX = 'live-checkout-guard:';

/** Git subcommands that never change HEAD, the index, the working tree or refs-for-checkout. */
const READ_ONLY_GIT = new Set([
	'status', 'log', 'diff', 'show', 'fetch', 'ls-remote', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list',
	'describe', 'blame', 'grep', 'cat-file', 'shortlog', 'show-ref', 'show-branch', 'name-rev', 'merge-base',
	'for-each-ref', 'diff-tree', 'diff-files', 'diff-index', 'var', 'whatchanged', 'count-objects',
	'check-ignore', 'help', 'version', 'verify-commit', 'verify-tag', 'range-diff', 'cherry', 'show-index',
]);

const BRANCH_MUTATING = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '-u', '--set-upstream-to', '--unset-upstream', '--edit-description', '-f', '--force']);
const LIST_FLAGS = new Set(['-l', '--list', '-a', '--all', '-r', '--remotes', '--show-current', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']);
const WRAPPERS = new Set(['sudo', 'command', 'nohup', 'time', 'exec', 'env', 'nice', 'builtin', 'xargs', 'stdbuf', 'timeout']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

// ---- helpers ---------------------------------------------------------------

/** realpath of the deepest existing ancestor + the not-yet-existing tail. */
function realish(p) {
	const abs = path.resolve(p);
	let cur = abs;
	const tail = [];
	for (let i = 0; i < 64; i += 1) {
		try {
			const real = fs.realpathSync(cur);
			return path.join(real, ...tail.reverse());
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return abs;
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
	return abs;
}

/** Expand ~, $HOME, ${HOME}; return null when another variable/substitution remains. */
function expand(word) {
	const home = process.env.HOME || os.homedir();
	let w = word;
	if (home) {
		w = w.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home);
		if (w === '~') w = home;
		else if (w.startsWith('~/')) w = home + w.slice(1);
	}
	return /[$`]/.test(w) ? null : w;
}

const roots = process.argv.slice(2).filter(Boolean).map(realish);

/** The live root containing p, or null. Paths under a `.crewly` directory are not live. */
function liveRootOf(p, { allowDataDirs = true } = {}) {
	const r = realish(p);
	for (const root of roots) {
		if (r === root || r.startsWith(root + path.sep)) {
			if (allowDataDirs && r.slice(root.length).split(path.sep).includes('.crewly')) return null;
			return root;
		}
	}
	return null;
}

function resolveWord(word, cwd) {
	const w = expand(word);
	if (w === null || w === '') return null;
	return path.resolve(cwd, w);
}

const DENY_TAIL =
	'This is the live Crewly install. Clone it into your own scratch dir (git clone <repo-url> <scratch>/crewly && ln -s <live>/node_modules <scratch>/crewly/node_modules) and work there. ' +
	'Read-only git (status, log, diff, show, fetch, ls-remote, branch --list) and files under .crewly/ stay allowed here.';

function deny(what, root) {
	process.stderr.write(
		`${PREFIX} BLOCKED — ${what} (live checkout: ${root}).\n` +
			`${PREFIX} ${DENY_TAIL.replace(/<live>/g, root)}\n` +
			'Changing the live branch, HEAD or files makes Crewly refuse to start on its next restart.\n',
	);
	process.exit(2);
}

// ---- shell tokenising ------------------------------------------------------

/**
 * Split a command line into simple commands: { words, redirs }.
 * Separators: ; & | && || newline ( ) { } $( ` . Quotes and backslashes are honoured.
 */
function parseCommands(src) {
	const cmds = [];
	let words = [];
	let redirs = [];
	let cur = '';
	let has = false;
	let pendingRedir = null;
	const pushWord = () => {
		if (!has) return;
		if (pendingRedir) {
			if (!cur.startsWith('&')) redirs.push(cur);
			pendingRedir = null;
		} else {
			words.push(cur);
		}
		cur = '';
		has = false;
	};
	const endCmd = () => {
		pushWord();
		pendingRedir = null;
		if (words.length || redirs.length) cmds.push({ words, redirs });
		words = [];
		redirs = [];
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
			let s = '';
			while (j < src.length && src[j] !== '"') {
				if (src[j] === '\\' && j + 1 < src.length && '"\\$`'.includes(src[j + 1])) {
					s += src[j + 1];
					j += 2;
				} else {
					s += src[j];
					j += 1;
				}
			}
			cur += s;
			has = true;
			i = j;
		} else if (c === '\\') {
			if (i + 1 < src.length) {
				if (src[i + 1] !== '\n') {
					cur += src[i + 1];
					has = true;
				}
				i += 1;
			}
		} else if (c === ';' || c === '\n' || c === '(' || c === ')' || c === '`' || c === '{' && !has && /\s/.test(src[i + 1] || ' ') || c === '}' && !has) {
			endCmd();
		} else if (c === '$' && src[i + 1] === '(') {
			endCmd();
			i += 1;
		} else if (c === '&' || c === '|') {
			// &> and >& and >| belong to redirections
			if (c === '&' && src[i + 1] === '>') {
				pushWord();
				pendingRedir = '>';
				i += src[i + 2] === '>' ? 2 : 1;
			} else {
				endCmd();
				if (src[i + 1] === c) i += 1;
			}
		} else if (c === '>') {
			// fd prefix like 2> was already read into cur as digits
			if (has && /^\d+$/.test(cur)) {
				cur = '';
				has = false;
			} else {
				pushWord();
			}
			i += src[i + 1] === '>' || src[i + 1] === '|' ? 1 : 0;
			pendingRedir = '>';
		} else if (c === '<') {
			if (has && /^\d+$/.test(cur)) {
				cur = '';
				has = false;
			} else {
				pushWord();
			}
			if (src[i + 1] === '<') i += 1; // heredoc marker: next word is the delimiter, not a path
			pendingRedir = '<';
		} else if (/\s/.test(c)) {
			if (pendingRedir === '<' && has) {
				cur = '';
				has = false;
				pendingRedir = null;
			} else {
				pushWord();
			}
		} else {
			cur += c;
			has = true;
		}
	}
	endCmd();
	return cmds;
}

// ---- analysis --------------------------------------------------------------

function stripWrappers(words) {
	let i = 0;
	const env = {};
	for (;;) {
		const w = words[i];
		if (w === undefined) break;
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(w);
		if (m) {
			env[m[1]] = m[2];
			i += 1;
		} else if (WRAPPERS.has(path.basename(w))) {
			const wrapper = path.basename(w);
			i += 1;
			while (words[i] !== undefined && words[i].startsWith('-')) {
				const opt = words[i];
				i += 1;
				if (wrapper === 'nice' && opt === '-n') i += 1;
			}
			if (wrapper === 'timeout') i += 1; // duration
		} else break;
	}
	return { env, words: words.slice(i) };
}

function gitSubcommand(args, state) {
	let i = 0;
	let dir = state.cwd;
	let target = null; // explicit --git-dir / --work-tree
	while (i < args.length && args[i].startsWith('-')) {
		const a = args[i];
		if (a === '-C') {
			const p = resolveWord(args[i + 1] ?? '', dir);
			if (p) dir = p;
			i += 2;
		} else if (a === '-c' || a === '--namespace' || a === '--exec-path') i += 2;
		else if (a === '--git-dir' || a === '--work-tree') {
			target = resolveWord(args[i + 1] ?? '', dir) ?? target;
			i += 2;
		} else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
			target = resolveWord(a.slice(a.indexOf('=') + 1), dir) ?? target;
			i += 1;
		} else i += 1;
	}
	return { sub: args[i] ?? '', rest: args.slice(i + 1), dir, target };
}

function hasAny(args, set) {
	return args.some((a) => set.has(a) || [...set].some((s) => s.startsWith('--') && a.startsWith(s + '=')));
}

/** Whether `git <sub> <rest>` is read-only. */
function gitIsReadOnly(sub, rest) {
	if (READ_ONLY_GIT.has(sub)) return true;
	const flags = rest.filter((a) => a.startsWith('-'));
	const positional = rest.filter((a) => !a.startsWith('-'));
	switch (sub) {
		case 'branch':
			if (hasAny(rest, BRANCH_MUTATING)) return false;
			return hasAny(rest, LIST_FLAGS) || positional.length === 0;
		case 'tag':
			if (flags.some((f) => ['-d', '-a', '-s', '-f', '-m', '-u', '--delete', '--force', '--annotate', '--sign'].includes(f))) return false;
			return flags.some((f) => ['-l', '--list', '-n', '--contains', '--points-at', '--merged', '--no-merged', '-v', '--verify'].includes(f)) || positional.length === 0;
		case 'remote':
			return positional.length === 0 || ['show', 'get-url'].includes(positional[0]);
		case 'config':
			return flags.some((f) => ['--get', '--get-all', '--get-regexp', '-l', '--list', '--show-origin'].includes(f));
		case 'stash':
			return ['list', 'show'].includes(positional[0] ?? '');
		case 'worktree':
			return positional[0] === 'list';
		case 'submodule':
			return positional.length === 0 || ['status', 'summary'].includes(positional[0]);
		case 'reflog':
			return !positional.some((p) => ['expire', 'delete'].includes(p));
		case 'archive':
			return true;
		default:
			return false;
	}
}

const CLONE_VALUE_OPTS = new Set(['-b', '--branch', '--depth', '-o', '--origin', '--reference', '--template', '-c', '--config', '-j', '--jobs', '--filter', '--separate-git-dir', '--shallow-since', '--shallow-exclude', '-u', '--upload-pack']);

function cloneDestination(rest, cwd) {
	const pos = [];
	for (let i = 0; i < rest.length; i += 1) {
		if (CLONE_VALUE_OPTS.has(rest[i])) i += 1;
		else if (!rest[i].startsWith('-')) pos.push(rest[i]);
	}
	const dest = pos[1] ?? path.basename(pos[0] ?? '').replace(/\.git$/, '');
	return dest ? resolveWord(dest, cwd) : null;
}

function analyzeSimple(cmd, state, depth) {
	const { env, words } = stripWrappers(cmd.words);

	// redirection targets
	for (const r of cmd.redirs) {
		const p = resolveWord(r, state.cwd);
		const root = p && liveRootOf(p);
		if (root) deny(`redirection writes into the live checkout (${r})`, root);
	}
	if (words.length === 0) return;
	const verb = path.basename(words[0]);
	const args = words.slice(1);

	if (SHELLS.has(verb)) {
		const ci = args.findIndex((a) => /^-[a-z]*c$/.test(a));
		if (ci !== -1 && args[ci + 1] !== undefined && depth < 4) analyze(args[ci + 1], state, depth + 1);
		return;
	}
	if (verb === 'cd' || verb === 'pushd') {
		const t = args.find((a) => !a.startsWith('-')) ?? '~';
		const p = resolveWord(t, state.cwd);
		if (p) state.cwd = p;
		return;
	}

	if (verb === 'git') {
		const g = gitSubcommand(args, state);
		const envTarget = env.GIT_DIR || env.GIT_WORK_TREE;
		const explicit = g.target ?? (envTarget ? resolveWord(envTarget, state.cwd) : null);
		if (g.sub === 'clone' || g.sub === 'init') {
			const dest = g.sub === 'clone' ? cloneDestination(g.rest, g.dir) : resolveWord(g.rest.find((a) => !a.startsWith('-')) ?? '.', g.dir);
			const root = dest && liveRootOf(dest);
			if (root) deny(`git ${g.sub} would create a repository inside the live checkout`, root);
			return;
		}
		const root = liveRootOf(g.dir) || (explicit ? liveRootOf(explicit) : null);
		if (!root) return;
		if (gitIsReadOnly(g.sub, g.rest)) return;
		deny(`\`git ${g.sub || '(no subcommand)'}\` would change the live Crewly checkout`, root);
		return;
	}

	// file-mutating verbs
	const fileArgs = args.filter((a) => !a.startsWith('-'));
	const check = (list, what) => {
		for (const a of list) {
			const p = resolveWord(a, state.cwd);
			const root = p && liveRootOf(p);
			if (root) deny(`\`${verb}\` ${what} (${a})`, root);
		}
	};
	switch (verb) {
		case 'rm': case 'rmdir': case 'unlink': case 'chmod': case 'chown': case 'chgrp': case 'truncate':
		case 'touch': case 'tee': case 'mv': case 'shred': case 'mkdir':
			check(fileArgs, 'would modify the live checkout');
			break;
		case 'sed': case 'gsed': case 'perl':
			if (args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) check(fileArgs, 'edits a file in place in the live checkout');
			break;
		case 'cp': case 'ln': case 'install': case 'rsync': case 'scp': {
			const ti = args.findIndex((a) => a === '-t' || a === '--target-directory');
			const dest = ti !== -1 ? [args[ti + 1]] : fileArgs.slice(-1);
			check(dest.filter(Boolean), 'would write into the live checkout');
			break;
		}
		case 'dd':
			check(args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)), 'writes into the live checkout');
			break;
		default:
	}
}

function analyze(command, state, depth = 0) {
	for (const cmd of parseCommands(command)) analyzeSimple(cmd, state, depth);
}

/** Paths a Codex apply_patch text touches. */
function patchPaths(text) {
	const out = [];
	for (const m of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm)) out.push(m[1]);
	for (const m of text.matchAll(/^\*\*\* Move to:\s*(.+?)\s*$/gm)) out.push(m[1]);
	return out;
}

// ---- main ------------------------------------------------------------------

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
	if (roots.length === 0) {
		process.stderr.write(`${PREFIX} NO LIVE ROOT GIVEN — nothing checked; refusing to report this call as safe\n`);
		process.exit(1);
	}
	let input;
	try {
		input = JSON.parse(raw);
	} catch {
		process.stderr.write(`${PREFIX} unparsable hook input — nothing checked\n`);
		process.exit(1);
	}
	const tool = String(input.tool_name ?? '');
	const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
	const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

	const fileTargets = [];
	for (const k of ['file_path', 'notebook_path', 'path', 'filePath']) if (typeof ti[k] === 'string') fileTargets.push(ti[k]);
	const cmdText = typeof ti.command === 'string' ? ti.command : typeof ti.cmd === 'string' ? ti.cmd : '';
	const isPatch = tool === 'apply_patch' || cmdText.includes('*** Begin Patch') || (typeof ti.input === 'string' && ti.input.includes('*** Begin Patch'));

	if (isPatch) {
		const text = cmdText || String(ti.input ?? '');
		for (const f of patchPaths(text)) {
			const p = resolveWord(f, cwd);
			const root = p && liveRootOf(p);
			if (root) deny(`apply_patch edits a file in the live checkout (${f})`, root);
		}
	}
	if (/^(Edit|Write|MultiEdit|NotebookEdit|str_replace_editor)$/.test(tool) || (!cmdText && fileTargets.length && /edit|write|patch/i.test(tool))) {
		for (const f of fileTargets) {
			const p = resolveWord(f, cwd);
			const root = p && liveRootOf(p);
			if (root) deny(`${tool} would edit a file in the live checkout (${f})`, root);
		}
	}
	if (cmdText && !isPatch) analyze(cmdText, { cwd });

	process.stdout.write(`${PREFIX} allowed — ${roots.length} live root(s) checked\n`);
	process.exit(0);
});
