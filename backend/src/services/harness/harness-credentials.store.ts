/**
 * Harness credentials store — the harness logins Crewly itself holds.
 *
 * Claude Code's `setup-token` prints a long-lived OAuth token instead of
 * saving it, and an Anthropic API key has to reach agents somehow; both live
 * here, in `<crewlyHome>/harness-credentials.json` with mode 0600. Codex
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
		/** Long-lived token from `claude setup-token` (exported as CLAUDE_CODE_OAUTH_TOKEN) */
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
	 * Store Claude's long-lived OAuth token. Replaces a stored API key, so
	 * agents use exactly the login the owner chose last.
	 *
	 * @param token - Token printed by `claude setup-token`
	 * @throws Error when the token is empty
	 */
	setClaudeOauthToken(token: string): void {
		if (!isNonEmptyString(token)) throw new Error('Claude OAuth token is empty');
		const current = this.read();
		this.write({ ...current, claude: { oauthToken: token.trim(), updatedAt: new Date().toISOString() } });
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
	 * Adds `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` when Crewly holds
	 * a Claude credential. Nothing is added for Codex: it reads its own
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
		if (isNonEmptyString(claude?.oauthToken)) {
			env[HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV] = claude.oauthToken;
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
