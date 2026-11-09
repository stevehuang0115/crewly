/**
 * Harness credentials store — the harness logins Crewly itself holds.
 *
 * An Anthropic API key has to reach agents somehow, so it lives here, in
 * `<crewlyHome>/harness-credentials.json` with mode 0600. Crewly no longer
 * saves Claude.ai sign-in tokens: Claude Code stores its own login (config
 * dir or keychain) and Anthropic's rules say developers may not collect or
 * store those. Older versions did save a `claude setup-token` token here
 * (`claude.oauthToken`, `claudeAccounts.<name>.oauthToken`); that data is
 * only read to keep an account working until the owner signs it in again,
 * then deleted (services/harness/claude-token-migration.service.ts). Codex
 * writes its own credentials (`$CODEX_HOME/auth.json`), so nothing is stored
 * for it unless a future flow needs the key. Antigravity CLI reads its Gemini
 * API key only from the environment, so Crewly keeps that key here too.
 *
 * {@link harnessEnvForAgents} turns the stored credentials into the env vars
 * injected into agent PTYs (and adds the user npm prefix to PATH).
 *
 * Secrets are never logged, never returned by the REST API and never put in
 * an error message.
 *
 * @module services/harness/harness-credentials.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS, HARNESS_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import { buildHarnessPath } from './harness-exec.utils.js';

/** Stored credentials. Every field is optional. */
export interface HarnessCredentials {
	claude?: {
		/** LEGACY, read-only: token an older Crewly saved from `claude setup-token`; removed by the migration */
		oauthToken?: string;
		/** Anthropic API key (exported as ANTHROPIC_API_KEY) */
		anthropicApiKey?: string;
		updatedAt?: string;
	};
	codex?: {
		/** OpenAI API key — only kept if a flow needs it (Codex stores its own login) */
		openaiApiKey?: string;
		updatedAt?: string;
	};
	antigravity?: {
		/** Gemini API key Antigravity CLI runs with (exported as GEMINI_API_KEY to antigravity-cli agents only) */
		geminiApiKey?: string;
		updatedAt?: string;
	};
	/**
	 * The owner's other Claude Code accounts (issue #942), keyed by account
	 * name. Each token goes only to sessions running on that account.
	 */
	claudeAccounts?: Record<string, { oauthToken?: string; updatedAt?: string }>;
}

/** Which stored Claude credential is active. */
export type StoredClaudeCredential = 'oauth_token' | 'api_key' | null;

/**
 * Whether a value is a non-empty string.
 *
 * @param value - Candidate
 * @returns True for a string with non-whitespace content
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Reads and writes `harness-credentials.json`.
 *
 * Reads the file on every call (no cache), so the CLI and a running backend
 * always see each other's writes.
 */
export class HarnessCredentialsStore {
	/**
	 * @param filePath - Credentials file; defaults to `<crewlyHome>/harness-credentials.json`
	 *   (resolved per call so `CREWLY_HOME` changes in tests are honoured)
	 */
	constructor(private readonly filePath?: string) {}

	/**
	 * Absolute path of the credentials file.
	 *
	 * @returns The path
	 */
	getFilePath(): string {
		return this.filePath ?? path.join(getCrewlyHomePath(), HARNESS_CONSTANTS.CREDENTIALS_FILE);
	}

	/**
	 * Read the stored credentials.
	 *
	 * @returns The credentials; an empty object when the file is missing or unreadable
	 */
	read(): HarnessCredentials {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.getFilePath(), 'utf-8'));
			return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as HarnessCredentials) : {};
		} catch {
			return {};
		}
	}

	/**
	 * Write credentials atomically with mode 0600.
	 *
	 * The temp file is created with 0600 before any secret is written to it,
	 * then renamed over the target, and the target is chmod-ed again in case
	 * it pre-existed with a wider mode.
	 *
	 * @param credentials - Full credentials object
	 */
	write(credentials: HarnessCredentials): void {
		const file = this.getFilePath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		const fd = fs.openSync(tmp, 'w', HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE);
		try {
			fs.writeSync(fd, `${JSON.stringify(credentials, null, 2)}\n`);
		} finally {
			fs.closeSync(fd);
		}
		fs.chmodSync(tmp, HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE);
		fs.renameSync(tmp, file);
		fs.chmodSync(file, HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE);
	}

	/**
	 * Store an Anthropic API key. Replaces a stored OAuth token.
	 *
	 * @param key - Anthropic API key
	 * @throws Error when the key is empty
	 */
	setAnthropicApiKey(key: string): void {
		if (!isNonEmptyString(key)) throw new Error('Anthropic API key is empty');
		const current = this.read();
		this.write({ ...current, claude: { anthropicApiKey: key.trim(), updatedAt: new Date().toISOString() } });
	}

	/**
	 * Store an OpenAI API key (only when a flow needs Crewly to hold it).
	 *
	 * @param key - OpenAI API key
	 * @throws Error when the key is empty
	 */
	setOpenaiApiKey(key: string): void {
		if (!isNonEmptyString(key)) throw new Error('OpenAI API key is empty');
		const current = this.read();
		this.write({ ...current, codex: { openaiApiKey: key.trim(), updatedAt: new Date().toISOString() } });
	}

	/**
	 * Store the Gemini API key Antigravity CLI runs with.
	 *
	 * @param key - Gemini API key
	 * @throws Error when the key is empty
	 */
	setAntigravityGeminiApiKey(key: string): void {
		if (!isNonEmptyString(key)) throw new Error('Gemini API key is empty');
		const current = this.read();
		this.write({ ...current, antigravity: { geminiApiKey: key.trim(), updatedAt: new Date().toISOString() } });
	}

	/**
	 * The stored Antigravity Gemini API key.
	 *
	 * @returns The key, or null when none is stored
	 */
	getAntigravityGeminiApiKey(): string | null {
		const key = this.read().antigravity?.geminiApiKey;
		return isNonEmptyString(key) ? key : null;
	}

	/**
	 * Forget the stored Antigravity key.
	 */
	clearAntigravity(): void {
		const current = this.read();
		if (!current.antigravity) return;
		const next: HarnessCredentials = { ...current };
		delete next.antigravity;
		this.write(next);
	}

	/**
	 * Forget the stored Claude credential.
	 */
	clearClaude(): void {
		const current = this.read();
		if (!current.claude) return;
		const next: HarnessCredentials = { ...current };
		delete next.claude;
		this.write(next);
	}

	/**
	 * LEGACY: the token an older Crewly saved for one of the owner's other
	 * Claude Code accounts (never written any more).
	 *
	 * @param account - Account name
	 * @returns The token, or null when none is stored
	 */
	getClaudeAccountToken(account: string): string | null {
		const token = this.read().claudeAccounts?.[account]?.oauthToken;
		return isNonEmptyString(token) ? token : null;
	}

	/**
	 * Account names with a stored token.
	 *
	 * @returns Names
	 */
	listClaudeAccountsWithToken(): string[] {
		const accounts = this.read().claudeAccounts ?? {};
		return Object.keys(accounts).filter((name) => isNonEmptyString(accounts[name]?.oauthToken));
	}

	/**
	 * Forget the token of one of the owner's other Claude Code accounts. The
	 * `claudeAccounts` key goes away with its last entry.
	 *
	 * @param account - Account name
	 */
	clearClaudeAccount(account: string): void {
		const current = this.read();
		if (!current.claudeAccounts?.[account]) return;
		const accounts = { ...current.claudeAccounts };
		delete accounts[account];
		const next: HarnessCredentials = { ...current };
		if (Object.keys(accounts).length > 0) next.claudeAccounts = accounts;
		else delete next.claudeAccounts;
		this.write(next);
	}

	/**
	 * LEGACY: the default login's token an older Crewly saved.
	 *
	 * @returns The token, or null
	 */
	getLegacyClaudeOauthToken(): string | null {
		const token = this.read().claude?.oauthToken;
		return isNonEmptyString(token) ? token : null;
	}

	/**
	 * Delete the default login's legacy token. The `claude` key is removed
	 * when nothing but bookkeeping is left (a stored API key stays).
	 */
	clearLegacyClaudeOauthToken(): void {
		const current = this.read();
		if (!current.claude || !('oauthToken' in current.claude)) return;
		const { oauthToken: _removed, ...rest } = current.claude;
		const next: HarnessCredentials = { ...current };
		if (isNonEmptyString(rest.anthropicApiKey)) next.claude = rest;
		else delete next.claude;
		this.write(next);
	}

	/**
	 * Remove what an older Crewly left for Claude sign-in tokens once no token
	 * is stored: empty `claudeAccounts` entries or object, an empty
	 * `claude.oauthToken`, and a `claude` object holding nothing but
	 * bookkeeping. A stored API key and every other key stay untouched. Does
	 * nothing (and does not rewrite the file) when there is nothing to remove.
	 */
	pruneLegacyClaudeKeys(): void {
		const current = this.read();
		const next: HarnessCredentials = { ...current };
		let changed = false;
		if (next.claudeAccounts) {
			const kept = Object.fromEntries(Object.entries(next.claudeAccounts).filter(([, v]) => isNonEmptyString(v?.oauthToken)));
			if (Object.keys(kept).length !== Object.keys(next.claudeAccounts).length || Object.keys(kept).length === 0) {
				changed = true;
				if (Object.keys(kept).length > 0) next.claudeAccounts = kept;
				else delete next.claudeAccounts;
			}
		}
		if (next.claude && !isNonEmptyString(next.claude.oauthToken)) {
			const { oauthToken: _unused, updatedAt: _stamp, ...rest } = next.claude;
			if (Object.keys(rest).length === 0) {
				delete next.claude;
				changed = true;
			} else if ('oauthToken' in next.claude) {
				next.claude = { ...rest, ...(next.claude.updatedAt ? { updatedAt: next.claude.updatedAt } : {}) };
				changed = true;
			}
		}
		if (changed) this.write(next);
	}

	/**
	 * Env that keeps an account working with the token an older Crewly saved
	 * for it. LEGACY, transition only: empty once the account's native login
	 * is verified and the token deleted. This is the only place the token is
	 * handed to a Claude Code process.
	 *
	 * @param account - Named account; null = the default login
	 * @returns `{ CLAUDE_CODE_OAUTH_TOKEN }`, or `{}` when no token is stored
	 */
	legacyClaudeTokenEnv(account: string | null): Record<string, string> {
		const token = account ? this.getClaudeAccountToken(account) : this.getLegacyClaudeOauthToken();
		return token ? { [HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV]: token } : {};
	}

	/**
	 * Which Claude credential Crewly holds (never the value).
	 *
	 * @returns `oauth_token`, `api_key` or null
	 */
	getClaudeCredentialKind(): StoredClaudeCredential {
		const claude = this.read().claude;
		if (isNonEmptyString(claude?.oauthToken)) return 'oauth_token';
		if (isNonEmptyString(claude?.anthropicApiKey)) return 'api_key';
		return null;
	}

	/**
	 * Env vars to inject into agent sessions.
	 *
	 * Always sets PATH (user npm prefix bin first, see harness-exec.utils).
	 * Adds `ANTHROPIC_API_KEY` when Crewly holds one (and, during the token
	 * migration only, the legacy token of the default login). Nothing is added for Codex: it reads its own
	 * `auth.json`.
	 *
	 * For an `antigravity-cli` session it also adds the stored Gemini key as
	 * `GEMINI_API_KEY` (Antigravity reads the key only from the environment)
	 * and `AGY_CLI_DISABLE_AUTO_UPDATE`. The key is scoped to that runtime on
	 * purpose: in a Gemini CLI session an unexpected GEMINI_API_KEY brings up
	 * Gemini's "Existing API key detected" dialog for Google-login users.
	 *
	 * @param baseEnv - Environment whose PATH is extended (defaults to process.env)
	 * @param runtimeType - Runtime the session will run, when known
	 * @returns Env map to merge into the agent's spawn env
	 */
	harnessEnvForAgents(baseEnv: NodeJS.ProcessEnv = process.env, runtimeType?: string): Record<string, string> {
		const env: Record<string, string> = { PATH: buildHarnessPath(baseEnv.PATH) };
		const stored = this.read();
		const claude = stored.claude;
		const legacy = this.legacyClaudeTokenEnv(null);
		if (Object.keys(legacy).length > 0) {
			Object.assign(env, legacy);
		} else if (isNonEmptyString(claude?.anthropicApiKey)) {
			env[HARNESS_CONSTANTS.CLAUDE.API_KEY_ENV] = claude.anthropicApiKey;
		}
		if (runtimeType === RUNTIME_TYPES.ANTIGRAVITY_CLI) {
			env[ANTIGRAVITY_CONSTANTS.DISABLE_AUTO_UPDATE_ENV] = ANTIGRAVITY_CONSTANTS.DISABLE_AUTO_UPDATE_VALUE;
			const key = stored.antigravity?.geminiApiKey;
			if (isNonEmptyString(key)) env[ANTIGRAVITY_CONSTANTS.API_KEY_ENV] = key;
		}
		return env;
	}
}

/** Process-wide default store (path resolved per call from CREWLY_HOME). */
const defaultStore = new HarnessCredentialsStore();

/**
 * The default credentials store.
 *
 * @returns Store backed by `<crewlyHome>/harness-credentials.json`
 */
export function getHarnessCredentialsStore(): HarnessCredentialsStore {
	return defaultStore;
}

/**
 * Env vars to inject into agent sessions, from the default store.
 *
 * Never throws: a broken credentials file yields just the PATH.
 *
 * @param baseEnv - Environment whose PATH is extended (defaults to process.env)
 * @param runtimeType - Runtime the session will run (adds runtime-scoped vars such as Antigravity's key)
 * @returns Env map (PATH plus any credential env var)
 *
 * @example
 * ```ts
 * const env = { ...identityEnv, ...harnessEnvForAgents(process.env, 'antigravity-cli') };
 * ```
 */
export function harnessEnvForAgents(baseEnv: NodeJS.ProcessEnv = process.env, runtimeType?: string): Record<string, string> {
	try {
		return defaultStore.harnessEnvForAgents(baseEnv, runtimeType);
	} catch {
		return { PATH: buildHarnessPath(baseEnv.PATH) };
	}
}
