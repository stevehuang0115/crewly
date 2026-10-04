/**
 * Credential guard — layer 2 of specs/2026-10-04-agent-credential-isolation.md.
 *
 * One hook script (`config/hooks/credential-guard/guard.sh`) refuses an
 * agent's tool call that touches Crewly's credentials. This module writes
 * what the script reads and wires it into every runtime that has a pre-tool
 * hook:
 *
 * | Runtime | How | Per process? |
 * |---|---|---|
 * | Claude Code | PreToolUse group + `Read(...)` deny rules in the control-plane `--settings` file | yes |
 * | Codex | `-c hooks.PreToolUse=[...]` + `--dangerously-bypass-hook-trust` (probed) | yes |
 * | Gemini CLI | `GEMINI_CLI_SYSTEM_SETTINGS_PATH=<file>` with a BeforeTool hook | yes |
 * | Antigravity (agy) | an entry in agy's global `~/.gemini/config/hooks.json` | no — the script ignores calls without CREWLY_SESSION_NAME, so the owner's own agy is unaffected |
 * | crewly-agent | its own tools run the script before reading or executing | yes |
 * | OpenCode | none (gap, documented) | — |
 *
 * @module services/agent/credential-guard.service
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { CREDENTIAL_GUARD_CONSTANTS } from '../../constants.js';
import { getGuardedCredentialPaths, type GuardedPath } from '../core/credential-files.js';

const C = CREDENTIAL_GUARD_CONSTANTS;

/** Formats the hook script speaks. */
export type CredentialGuardFormat = 'claude' | 'codex' | 'gemini' | 'antigravity';

/** What {@link prepareCredentialGuard} wrote. */
export interface CredentialGuardFiles {
	/** The paths file. */
	pathsFile: string;
	/** The hook script (install root). */
	script: string;
	/** One no-argument wrapper per format (`<dir>/hook-<format>.sh`). */
	wrappers: Record<CredentialGuardFormat, string>;
	/** Paths agents may not read. */
	guarded: GuardedPath[];
}

/**
 * Whether the guard is on for sessions launched by this backend.
 *
 * @param env - Backend environment
 * @returns false only when `CREWLY_CREDENTIAL_GUARD=0`
 */
export function isCredentialGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[C.KILL_SWITCH_ENV] !== C.KILL_SWITCH_OFF_VALUE;
}

/**
 * The paths-file body: the Crewly home, then for each guarded path its
 * absolute form, its form from the home's parent (`.crewly/cloud`) and its
 * form relative to the home (`cloud`, matched only inside the home).
 *
 * @param crewlyHome - CREWLY_HOME
 * @param guarded - Guarded paths
 * @returns File body
 */
export function buildCredentialGuardPathsBody(crewlyHome: string, guarded: GuardedPath[]): string {
	const home = path.resolve(crewlyHome);
	const lines = [`home\t-\t${home}`];
	for (const g of guarded) {
		lines.push(`abs\t${g.id}\t${g.path}`);
		const rel = path.relative(home, g.path);
		if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
			lines.push(`tail\t${g.id}\t${path.join(path.basename(home), rel)}`);
			lines.push(`rel\t${g.id}\t${rel}`);
		} else {
			// Outside CREWLY_HOME (the `file` secret store): match from its parent too.
			lines.push(`tail\t${g.id}\t${path.join(path.basename(path.dirname(g.path)), path.basename(g.path))}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

/**
 * Quote for a POSIX shell.
 *
 * @param value - Raw
 * @returns Single-quoted
 */
function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Write a file atomically.
 *
 * @param file - Target
 * @param body - Contents
 * @param mode - Mode
 */
function atomicWrite(file: string, body: string, mode: number): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
	fs.writeFileSync(tmp, body, { mode });
	fs.chmodSync(tmp, mode);
	fs.renameSync(tmp, file);
}

/**
 * Write the paths file and one wrapper per format under
 * `<crewlyHome>/runtime/credential-guard/`. The wrappers take no arguments,
 * so a runtime that runs a hook command without a shell still works, and an
 * install path with spaces needs no quoting in TOML or JSON.
 *
 * @param crewlyHome - CREWLY_HOME
 * @param installRoot - Crewly install root (holds `config/hooks`)
 * @param guarded - Paths to guard (defaults to the credential inventory)
 * @returns What was written
 */
export function prepareCredentialGuard(crewlyHome: string, installRoot: string, guarded: GuardedPath[] = getGuardedCredentialPaths()): CredentialGuardFiles {
	const dir = path.join(crewlyHome, C.RUNTIME_DIR);
	const pathsFile = path.join(dir, C.PATHS_FILE);
	const script = path.join(installRoot, C.HOOK_SCRIPT);
	atomicWrite(pathsFile, buildCredentialGuardPathsBody(crewlyHome, guarded), 0o644);
	const formats: CredentialGuardFormat[] = ['claude', 'codex', 'gemini', 'antigravity'];
	const wrappers = {} as Record<CredentialGuardFormat, string>;
	for (const format of formats) {
		const wrapper = path.join(dir, `hook-${format}.sh`);
		atomicWrite(
			wrapper,
			[
				'#!/usr/bin/env bash',
				`# Crewly credential guard (${format}) — generated by the backend; see ${C.HOOK_SCRIPT}.`,
				`exec bash ${shq(script)} ${format} "\${${C.PATHS_ENV}:-${pathsFile.replace(/["`$\\]/g, '')}}"`,
				'',
			].join('\n'),
			0o755,
		);
		wrappers[format] = wrapper;
	}
	return { pathsFile, script, wrappers, guarded };
}

/**
 * Env vars an agent process gets so its hooks (and crewly-agent's own tools)
 * find the guard.
 *
 * @param files - Prepared guard
 * @returns Env map
 */
export function credentialGuardAgentEnv(files: Pick<CredentialGuardFiles, 'pathsFile' | 'script'>): Record<string, string> {
	return { [C.PATHS_ENV]: files.pathsFile, [C.SCRIPT_ENV]: files.script };
}

/**
 * {@link credentialGuardAgentEnv} from the fixed locations, without writing
 * anything (the launch path writes the files). Empty when the guard is off.
 *
 * @param crewlyHome - CREWLY_HOME
 * @param installRoot - Install root
 * @param env - Backend environment (kill switch)
 * @returns Env map
 */
export function credentialGuardEnvFor(crewlyHome: string, installRoot: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	if (!isCredentialGuardEnabled(env)) return {};
	return credentialGuardAgentEnv({
		pathsFile: path.join(crewlyHome, C.RUNTIME_DIR, C.PATHS_FILE),
		script: path.join(installRoot, C.HOOK_SCRIPT),
	});
}

/** Claude Code `Read(...)` deny rules for the guarded paths (built-in Read/Grep/Glob). */
export function claudeCredentialReadDenyRules(guarded: GuardedPath[]): string[] {
	const rules: string[] = [];
	for (const g of guarded) {
		rules.push(`Read(/${g.path})`);
		if (g.isDirectory) rules.push(`Read(/${g.path}/**)`);
	}
	return rules;
}

/**
 * Codex launch arguments that attach the guard as a session PreToolUse hook.
 *
 * @param wrapper - The codex wrapper script
 * @returns Arguments to insert after the `codex` command word, or null when
 *   the wrapper path cannot be embedded safely
 */
export function codexCredentialGuardArgs(wrapper: string): string | null {
	if (/["'\\\n]/.test(wrapper)) return null;
	const hooks = `hooks.PreToolUse=[{matcher="${C.CODEX_MATCHER}",hooks=[{type="command",command="${wrapper}"}]}]`;
	return `${C.CODEX_HOOK_TRUST_FLAG} -c ${shq(hooks)}`;
}

/** `codex` (or `/path/codex`) as a command word, optionally `codex resume`. */
const CODEX_WORD_RE = /(?<=^|[\s;&|(])(?:[^\s;&|()=]*\/)?codex(?:\s+resume)?(?=\s|$)/;

/**
 * Insert the Codex guard arguments after the codex command word.
 *
 * @param command - Launch command
 * @param args - From {@link codexCredentialGuardArgs}
 * @returns The command, unchanged when it already has the trust flag
 */
export function withCodexCredentialGuard(command: string, args: string): string {
	if (command.includes(C.CODEX_HOOK_TRUST_FLAG)) return command;
	return command.replace(CODEX_WORD_RE, (m) => `${m} ${args}`);
}

/**
 * Write Crewly's Gemini CLI system settings file (BeforeTool hook), merged
 * over the machine's own system settings file so that one is not shadowed.
 *
 * @param dir - Runtime dir
 * @param wrapper - The gemini wrapper script
 * @param platform - Platform (for the default system settings path)
 * @returns The settings file path
 */
export function writeGeminiCredentialGuardSettings(dir: string, wrapper: string, platform: NodeJS.Platform = process.platform): string {
	let base: Record<string, unknown> = {};
	const systemFile = C.GEMINI_DEFAULT_SYSTEM_SETTINGS[platform];
	if (systemFile) {
		try {
			const parsed = JSON.parse(fs.readFileSync(systemFile, 'utf8')) as unknown;
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
		} catch {
			/* none, or unreadable: nothing to keep */
		}
	}
	const hooks = (base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks) ? { ...(base.hooks as Record<string, unknown>) } : {}) as Record<string, unknown>;
	const before = Array.isArray(hooks.BeforeTool) ? [...(hooks.BeforeTool as unknown[])] : [];
	before.unshift({
		matcher: C.GEMINI_MATCHER,
		hooks: [{ name: 'crewly-credential-guard', type: 'command', command: wrapper, timeout: C.GEMINI_HOOK_TIMEOUT_MS }],
	});
	hooks.BeforeTool = before;
	const file = path.join(dir, C.GEMINI_SETTINGS_FILE);
	atomicWrite(file, `${JSON.stringify({ ...base, hooks }, null, 2)}\n`, 0o644);
	return file;
}

/** What happened to agy's hooks file. */
export type AntigravityHookResult = 'written' | 'unchanged' | 'removed' | 'skipped-not-object';

/**
 * Add (or, with `wrapper` null, remove) Crewly's entry in agy's global hooks
 * file, keeping every other entry. A file that is not a JSON object is left
 * alone (`skipped-not-object`): agy sessions then run unguarded.
 *
 * @param wrapper - The antigravity wrapper, or null to remove the entry
 * @param homeDir - Home directory (agy resolves the file from $HOME)
 * @returns What was done
 */
export function syncAntigravityCredentialHook(wrapper: string | null, homeDir: string = process.env.HOME || os.homedir()): AntigravityHookResult {
	const file = path.join(homeDir, ...C.ANTIGRAVITY_HOOKS_FILE_SEGMENTS);
	let current: Record<string, unknown> = {};
	if (fs.existsSync(file)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'skipped-not-object';
			current = parsed as Record<string, unknown>;
		} catch {
			return 'skipped-not-object';
		}
	}
	if (wrapper === null) {
		if (!(C.ANTIGRAVITY_HOOK_NAME in current)) return 'unchanged';
		const { [C.ANTIGRAVITY_HOOK_NAME]: _removed, ...rest } = current;
		atomicWrite(file, `${JSON.stringify(rest, null, 2)}\n`, 0o644);
		return 'removed';
	}
	const entry = {
		PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: wrapper, timeout: C.ANTIGRAVITY_HOOK_TIMEOUT_S }] }],
	};
	if (JSON.stringify(current[C.ANTIGRAVITY_HOOK_NAME]) === JSON.stringify(entry)) return 'unchanged';
	atomicWrite(file, `${JSON.stringify({ ...current, [C.ANTIGRAVITY_HOOK_NAME]: entry }, null, 2)}\n`, 0o644);
	return 'written';
}
