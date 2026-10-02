/**
 * The owner's other Claude Code accounts on this machine (issue #942).
 *
 * When the owner's Claude Code account runs out of usage, agents can move to
 * another account of the SAME owner before falling back to other runtimes.
 * Each account has its own config dir and its own login — Crewly never
 * switches accounts inside one login (in-place switching is unreliable
 * upstream, anthropics/claude-code#94195):
 *
 * - config dir: `<CREWLY_HOME>/claude-accounts/<name>/`, passed to Claude as
 *   `CLAUDE_CONFIG_DIR` (its own history, settings and `.claude.json`);
 * - login: the long-lived `claude setup-token` token, stored in
 *   `harness-credentials.json` (`claudeAccounts.<name>`) and passed as
 *   `CLAUDE_CODE_OAUTH_TOKEN` to sessions on that account only. A login
 *   done by hand (`CLAUDE_CONFIG_DIR=… claude /login`) also counts when it
 *   left a credentials file there.
 *
 * In a fallback chain an account is the entry `claude-code@<name>`; plain
 * `claude-code` is the machine's default login.
 *
 * Add only Claude Code accounts that the owner owns.
 *
 * @module services/harness/claude-accounts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { prepareClaudeConfigForCrewlyLogin } from './claude-config.utils.js';
import { getHarnessCredentialsStore, type HarnessCredentialsStore } from './harness-credentials.store.js';

const ACC = HARNESS_CONSTANTS.CLAUDE.ACCOUNTS;

/** A runtime target: a runtime, optionally on one of the owner's accounts. */
export interface RuntimeTarget {
	/** Runtime id (`claude-code`, `crewly-agent`, …) */
	runtime: string;
	/** Account name, for `claude-code@<name>` */
	account?: string;
}

/** One account as the API shows it. */
export interface ClaudeAccountInfo {
	name: string;
	/** Fallback chain entry (`claude-code@<name>`) */
	target: string;
	/** A login is stored (token) or present in its config dir */
	signedIn: boolean;
	/** Its config dir */
	configDir: string;
}

/** Where accounts live (injectable for tests). */
export interface ClaudeAccountsLocation {
	crewlyHome?: string;
	credentials?: Pick<HarnessCredentialsStore, 'getClaudeAccountToken' | 'listClaudeAccountsWithToken'>;
}

/** An invalid account name. */
export class ClaudeAccountNameError extends Error {}

/**
 * Normalise an account name as written by a person.
 *
 * @param raw - e.g. "Work", " b "
 * @returns The name, lower-cased and trimmed
 */
export function normaliseClaudeAccountName(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * Whether a (normalised) name can be an account name.
 *
 * @param name - Candidate
 * @returns True for 1–32 of `a-z0-9_-`, starting with a letter or digit, not a reserved word
 *
 * @example
 * ```ts
 * isValidClaudeAccountName('work'); // true
 * isValidClaudeAccountName('code'); // false (reserved)
 * ```
 */
export function isValidClaudeAccountName(name: string): boolean {
	return ACC.NAME_PATTERN.test(name) && !ACC.RESERVED_NAMES.includes(name);
}

/**
 * Validate and normalise an account name.
 *
 * @param raw - Name as given
 * @returns The normalised name
 * @throws ClaudeAccountNameError when it is not a valid name
 */
export function requireClaudeAccountName(raw: unknown): string {
	const name = typeof raw === 'string' ? normaliseClaudeAccountName(raw) : '';
	if (!isValidClaudeAccountName(name)) {
		throw new ClaudeAccountNameError(
			`Account names are 1–32 lower-case letters, digits, "-" or "_" (not ${ACC.RESERVED_NAMES.map((r) => `"${r}"`).join(', ')})`,
		);
	}
	return name;
}

/**
 * Split a runtime target.
 *
 * @param target - `claude-code`, `claude-code@work`, `crewly-agent`
 * @returns Runtime and account
 *
 * @example
 * ```ts
 * parseRuntimeTarget('claude-code@work'); // { runtime: 'claude-code', account: 'work' }
 * ```
 */
export function parseRuntimeTarget(target: string): RuntimeTarget {
	const at = target.indexOf(ACC.TARGET_SEPARATOR);
	if (at <= 0) return { runtime: target };
	return { runtime: target.slice(0, at), account: target.slice(at + 1) };
}

/**
 * The runtime of a target, without its account.
 *
 * @param target - Runtime target
 * @returns Runtime id
 */
export function baseRuntimeOf(target: string): string {
	return parseRuntimeTarget(target).runtime;
}

/**
 * The account of a target.
 *
 * @param target - Runtime target
 * @returns Account name, or null for a runtime's default login
 */
export function accountOf(target: string): string | null {
	return parseRuntimeTarget(target).account ?? null;
}

/**
 * Build a target.
 *
 * @param runtime - Runtime id
 * @param account - Account name (only Claude Code has accounts)
 * @returns `runtime` or `runtime@account`
 */
export function runtimeTarget(runtime: string, account?: string | null): string {
	return account ? `${runtime}${ACC.TARGET_SEPARATOR}${account}` : runtime;
}

/**
 * Whether a chain entry is one of the owner's Claude Code accounts.
 *
 * @param target - Chain entry
 * @returns True for `claude-code@<valid name>`
 */
export function isClaudeAccountTarget(target: string): boolean {
	const { runtime, account } = parseRuntimeTarget(target);
	return runtime === RUNTIME_TYPES.CLAUDE_CODE && account !== undefined && isValidClaudeAccountName(account);
}

/**
 * Directory holding every account's config dir.
 *
 * @param crewlyHome - CREWLY_HOME
 * @returns Absolute path
 */
export function claudeAccountsRoot(crewlyHome: string = getCrewlyHomePath()): string {
	return path.join(crewlyHome, ACC.DIR);
}

/**
 * An account's config dir (its `CLAUDE_CONFIG_DIR`).
 *
 * @param account - Account name (valid)
 * @param crewlyHome - CREWLY_HOME
 * @returns Absolute path
 */
export function claudeAccountConfigDir(account: string, crewlyHome: string = getCrewlyHomePath()): string {
	return path.join(claudeAccountsRoot(crewlyHome), account);
}

/**
 * Accounts known on this machine: a config dir exists or a token is stored.
 *
 * @param location - CREWLY_HOME / credentials overrides
 * @returns Sorted account names
 */
export function listClaudeAccounts(location: ClaudeAccountsLocation = {}): string[] {
	const names = new Set<string>();
	try {
		for (const entry of fs.readdirSync(claudeAccountsRoot(location.crewlyHome), { withFileTypes: true })) {
			if (entry.isDirectory() && isValidClaudeAccountName(entry.name)) names.add(entry.name);
		}
	} catch {
		// no accounts yet
	}
	try {
		for (const name of (location.credentials ?? getHarnessCredentialsStore()).listClaudeAccountsWithToken()) {
			if (isValidClaudeAccountName(name)) names.add(name);
		}
	} catch {
		// unreadable credentials: directories only
	}
	return [...names].sort();
}

/**
 * Whether an account has a login: a stored token, or a credentials file in
 * its config dir (a login done by hand).
 *
 * @param account - Account name
 * @param location - CREWLY_HOME / credentials overrides
 * @returns True when signed in
 */
export function isClaudeAccountSignedIn(account: string, location: ClaudeAccountsLocation = {}): boolean {
	try {
		if ((location.credentials ?? getHarnessCredentialsStore()).getClaudeAccountToken(account)) return true;
	} catch {
		// fall through to the file check
	}
	return fs.existsSync(path.join(claudeAccountConfigDir(account, location.crewlyHome), HARNESS_CONSTANTS.CLAUDE.CREDENTIALS_FILE));
}

/**
 * Every known account with its login state.
 *
 * @param location - CREWLY_HOME / credentials overrides
 * @returns Accounts
 */
export function describeClaudeAccounts(location: ClaudeAccountsLocation = {}): ClaudeAccountInfo[] {
	return listClaudeAccounts(location).map((name) => ({
		name,
		target: runtimeTarget(RUNTIME_TYPES.CLAUDE_CODE, name),
		signedIn: isClaudeAccountSignedIn(name, location),
		configDir: claudeAccountConfigDir(name, location.crewlyHome),
	}));
}

/**
 * Env that runs Claude Code on an account: its config dir and its token.
 * The default login's credentials are blanked so they cannot win over the
 * account's (an empty value counts as unset for Claude Code).
 *
 * @param account - Account name
 * @param location - CREWLY_HOME / credentials overrides
 * @returns Env vars to merge over the session's env
 *
 * @example
 * ```ts
 * claudeAccountEnv('work'); // { CLAUDE_CONFIG_DIR: '~/.crewly/claude-accounts/work', CLAUDE_CODE_OAUTH_TOKEN: '…', ANTHROPIC_API_KEY: '' }
 * ```
 */
export function claudeAccountEnv(account: string, location: ClaudeAccountsLocation = {}): Record<string, string> {
	let token: string | null = null;
	try {
		token = (location.credentials ?? getHarnessCredentialsStore()).getClaudeAccountToken(account);
	} catch {
		token = null;
	}
	return {
		[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV]: claudeAccountConfigDir(account, location.crewlyHome),
		[HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV]: token ?? '',
		[HARNESS_CONSTANTS.CLAUDE.API_KEY_ENV]: '',
	};
}

/**
 * Create an account's config dir (idempotent). A new dir starts with the
 * owner's own choices from the default login: Claude's `settings.json` and
 * the first-run answers in `.claude.json` (onboarding done, permission mode
 * accepted, theme), so an agent on the account does not stop at a first-run
 * screen the owner already answered. No credential is copied.
 *
 * @param account - Account name (valid)
 * @param options - CREWLY_HOME and the default login's location (tests)
 * @returns The config dir
 */
export function ensureClaudeAccountDir(
	account: string,
	options: { crewlyHome?: string; defaultEnv?: NodeJS.ProcessEnv; homeDir?: string } = {},
): string {
	const dir = claudeAccountConfigDir(account, options.crewlyHome);
	if (fs.existsSync(dir)) return dir;
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const env = options.defaultEnv ?? process.env;
	const home = options.homeDir ?? os.homedir();
	const defaultConfigDir = env[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV];
	const defaultDataDir = defaultConfigDir ? defaultConfigDir : path.join(home, HARNESS_CONSTANTS.CLAUDE.DATA_DIR);
	const defaultConfigFile = path.join(defaultConfigDir ? defaultConfigDir : home, HARNESS_CONSTANTS.CLAUDE.CONFIG_FILE);
	try {
		const settings = path.join(defaultDataDir, ACC.SETTINGS_FILE);
		if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(dir, ACC.SETTINGS_FILE));
	} catch {
		// the account starts with Claude's defaults
	}
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(defaultConfigFile, 'utf-8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			const source = parsed as Record<string, unknown>;
			const copied: Record<string, unknown> = {};
			for (const key of ACC.COPIED_CONFIG_KEYS) if (key in source) copied[key] = source[key];
			if (Object.keys(copied).length > 0) {
				fs.writeFileSync(path.join(dir, HARNESS_CONSTANTS.CLAUDE.CONFIG_FILE), `${JSON.stringify(copied, null, 2)}\n`, {
					mode: HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE,
				});
			}
		}
	} catch {
		// no default config to copy from
	}
	return dir;
}

/**
 * After an account's login: create its dir if needed and record Claude's
 * first-run "onboarding done" answer there (as for the default login).
 *
 * @param account - Account name (valid)
 * @param crewlyHome - CREWLY_HOME
 */
export function prepareClaudeAccountAfterLogin(account: string, crewlyHome?: string): void {
	const dir = ensureClaudeAccountDir(account, { crewlyHome });
	prepareClaudeConfigForCrewlyLogin({}, { env: { [HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV]: dir } });
}

/**
 * Remove an account: its stored token and its config dir.
 *
 * @param account - Account name (valid)
 * @param location - CREWLY_HOME / credentials store
 */
export function removeClaudeAccount(account: string, location: { crewlyHome?: string; credentials?: Pick<HarnessCredentialsStore, 'clearClaudeAccount'> } = {}): void {
	(location.credentials ?? getHarnessCredentialsStore()).clearClaudeAccount(account);
	fs.rmSync(claudeAccountConfigDir(account, location.crewlyHome), { recursive: true, force: true });
}
