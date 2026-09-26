/**
 * Is an AI runtime (Claude Code, Codex, Antigravity CLI, Gemini CLI) installed AND logged in?
 *
 * `crewly doctor` used to say "All checks passed" on machines where no agent
 * could ever start (#779). An agent needs a runtime binary on PATH and a
 * saved login; without the login it stops at a sign-in screen.
 *
 * Detection only reads files and environment variable NAMES; it never prints
 * or returns a secret value.
 *
 * - Claude Code: first-run setup finished (`hasCompletedOnboarding`, the #782
 *   check) plus a credential: an OAuth account in its config, an API key in
 *   its config, a credentials file, an `apiKeyHelper`, or an auth env var.
 * - Codex: `$CODEX_HOME/auth.json` (default `~/.codex`) holds tokens or an
 *   API key (written by `codex login`).
 * - Antigravity CLI: a Gemini API key Crewly can hand it (saved in
 *   `<crewlyHome>/harness-credentials.json`, a Crewly settings Gemini key, or
 *   GEMINI_API_KEY). Crewly never runs agy on an account login (Google does
 *   not allow third-party tools to use Antigravity OAuth), so an account
 *   login alone does not count.
 * - Gemini CLI (retired for new users; kept for existing / enterprise ones):
 *   an auth method saved in `~/.gemini/settings.json` with its credential
 *   present, or a Gemini API key Crewly can hand it — Crewly then
 *   pre-selects "Use Gemini API Key" at launch (#781).
 *
 * @module cli/utils/runtime-auth
 */

import * as fs from 'fs';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS } from '../../../backend/src/constants.js';
import {
	GEMINI_API_KEY_AUTH_TYPE,
	LEGACY_AUTH_TYPE_KEY,
} from '../../../backend/src/utils/gemini-auth-settings.js';

/** Result for one runtime. */
export interface RuntimeAuthStatus {
	/** Stable id: `claude`, `codex`, `gemini` */
	id: RuntimeId;
	/** Display name */
	displayName: string;
	/** Binary on PATH */
	installed: boolean;
	/** Installed and a usable login was found */
	loggedIn: boolean;
	/** What was found (never a secret) */
	detail: string;
	/** Command that fixes it (install and/or log in) */
	fix: string;
	/** Not recommended to new users (Gemini CLI) */
	retired?: boolean;
}

/** Runtimes doctor checks. */
export type RuntimeId = 'claude' | 'codex' | 'antigravity' | 'gemini';

/** Inputs, injectable for tests. */
export interface RuntimeAuthDeps {
	/** PATH lookup */
	which: (bin: string) => boolean;
	/** Home directory */
	homeDir: string;
	/** Environment */
	env: NodeJS.ProcessEnv;
}

/** Static facts about each runtime. */
export const RUNTIME_AUTH_INFO = {
	claude: {
		displayName: 'Claude Code',
		bin: 'claude',
		install: 'npm install -g @anthropic-ai/claude-code',
		login: 'run `claude` once in a terminal: choose a theme and log in (or /login)',
		/** Env vars that authenticate Claude Code without a saved login */
		authEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'],
		configDirEnv: 'CLAUDE_CONFIG_DIR',
		configFile: '.claude.json',
		onboardedKey: 'hasCompletedOnboarding',
		/** Config keys that record a login */
		loginKeys: ['oauthAccount', 'primaryApiKey'],
		/** Claude's data directory under $HOME (unless CLAUDE_CONFIG_DIR is set) */
		dataDir: '.claude',
		/** Credentials file (Linux; macOS keeps it in the Keychain) */
		credentialsFile: '.credentials.json',
		settingsFile: 'settings.json',
	},
	codex: {
		displayName: 'Codex CLI',
		bin: 'codex',
		install: 'npm install -g @openai/codex',
		login: 'codex login   (API key: printenv OPENAI_API_KEY | codex login --with-api-key)',
		homeEnv: 'CODEX_HOME',
		homeDir: '.codex',
		authFile: 'auth.json',
	},
	antigravity: {
		displayName: 'Antigravity CLI',
		bin: ANTIGRAVITY_CONSTANTS.BINARY,
		install: `curl -fsSL ${ANTIGRAVITY_CONSTANTS.INSTALL_SCRIPT_URL} | bash`,
		login: `crewly login antigravity   (paste a Gemini API key from ${ANTIGRAVITY_CONSTANTS.API_KEY_CONSOLE_URL})`,
		/** The only env var agy reads a key from */
		keyEnv: [ANTIGRAVITY_CONSTANTS.API_KEY_ENV],
		/** Crewly's harness credentials file under the Crewly home */
		credentialsFile: 'harness-credentials.json',
		/** Runtime id under apiKeys.runtimeOverrides */
		crewlyRuntimeId: 'antigravity-cli',
	},
	gemini: {
		displayName: 'Gemini CLI',
		bin: 'gemini',
		install: 'npm install -g @google/gemini-cli',
		login: 'run `gemini` once and choose "Login with Google", or set GEMINI_API_KEY (or add a Gemini key in Crewly Settings)',
		/** Env vars Crewly reads a Gemini key from (API_KEY_ENV_VARS.gemini) */
		keyEnv: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
		settingsFile: path.join('.gemini', 'settings.json'),
		oauthCredsFile: path.join('.gemini', 'oauth_creds.json'),
		/** Gemini's Google-login auth types */
		googleLoginTypes: ['oauth-personal', 'login-with-google'],
		/** Crewly settings file holding API keys */
		crewlySettingsFile: path.join('.crewly', 'settings.json'),
		/** Runtime id under apiKeys.runtimeOverrides */
		crewlyRuntimeId: 'gemini-cli',
	},
} as const;

/**
 * Read and parse a JSON object file.
 *
 * @param file - Path
 * @returns The object, or null when missing / unreadable / not an object
 */
function readJsonObject(file: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/**
 * Whether a value is present (non-empty string or non-null object).
 *
 * @param value - Candidate
 * @returns True when set
 */
function isSet(value: unknown): boolean {
	if (typeof value === 'string') return value.trim().length > 0;
	return value !== null && typeof value === 'object';
}

/**
 * First env var name (from `names`) that has a value.
 *
 * @param env - Environment
 * @param names - Candidate names
 * @returns The name, or null
 */
function firstSetEnv(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
	return names.find((name) => isSet(env[name])) ?? null;
}

/**
 * Fix command: install (when missing) and log in.
 *
 * @param info - Runtime facts
 * @param installed - Binary present
 * @returns Command text
 */
function fixFor(info: { install: string; login: string }, installed: boolean): string {
	return installed ? info.login : `${info.install}, then ${info.login}`;
}

/**
 * Claude Code login state.
 *
 * @param deps - Inputs
 * @returns Status
 */
export function checkClaudeAuth(deps: RuntimeAuthDeps): RuntimeAuthStatus {
	const info = RUNTIME_AUTH_INFO.claude;
	const installed = deps.which(info.bin);
	const base = { id: 'claude' as const, displayName: info.displayName, installed, fix: fixFor(info, installed) };
	if (!installed) return { ...base, loggedIn: false, detail: 'not installed' };

	// CLAUDE_CONFIG_DIR relocates everything: .claude.json, .credentials.json,
	// settings.json. Without it: ~/.claude.json and ~/.claude/<file>.
	const customDir = deps.env[info.configDirEnv];
	const configDir = customDir || deps.homeDir;
	const dataDir = customDir || path.join(deps.homeDir, info.dataDir);
	const config = readJsonObject(path.join(configDir, info.configFile));
	if (!config || config[info.onboardedKey] !== true) {
		return { ...base, loggedIn: false, detail: 'installed but never set up — agents stop at its theme and login screens' };
	}

	const envName = firstSetEnv(deps.env, info.authEnv);
	const configKey = info.loginKeys.find((key) => isSet(config[key]));
	const credentials = fs.existsSync(path.join(dataDir, info.credentialsFile));
	const settings = readJsonObject(path.join(dataDir, info.settingsFile));
	const helper = settings ? isSet(settings.apiKeyHelper) : false;

	const source = configKey === 'oauthAccount' ? 'account login'
		: configKey ? 'API key login'
			: credentials ? 'credentials file'
				: helper ? 'apiKeyHelper'
					: envName ? `$${envName}`
						: null;
	if (!source) {
		return { ...base, loggedIn: false, detail: 'set up, but no login found (logged out?)', fix: 'run `claude` and log in with /login' };
	}
	return { ...base, loggedIn: true, detail: `set up and logged in (${source})` };
}

/**
 * Codex CLI login state.
 *
 * @param deps - Inputs
 * @returns Status
 */
export function checkCodexAuth(deps: RuntimeAuthDeps): RuntimeAuthStatus {
	const info = RUNTIME_AUTH_INFO.codex;
	const installed = deps.which(info.bin);
	const base = { id: 'codex' as const, displayName: info.displayName, installed, fix: fixFor(info, installed) };
	if (!installed) return { ...base, loggedIn: false, detail: 'not installed' };

	const codexHome = deps.env[info.homeEnv] || path.join(deps.homeDir, info.homeDir);
	const authFile = path.join(codexHome, info.authFile);
	const auth = readJsonObject(authFile);
	if (auth && isSet(auth.tokens)) return { ...base, loggedIn: true, detail: 'logged in (ChatGPT account)' };
	if (auth && isSet(auth.OPENAI_API_KEY)) return { ...base, loggedIn: true, detail: 'logged in (API key)' };
	return { ...base, loggedIn: false, detail: `installed but not logged in (no login in ${authFile})` };
}

/**
 * Whether Crewly has a Gemini API key it hands to Gemini sessions (settings
 * global key or a gemini-cli runtime override, else the env).
 *
 * @param deps - Inputs
 * @returns Where the key comes from, or null
 */
export function findCrewlyGeminiKey(deps: RuntimeAuthDeps): string | null {
	const info = RUNTIME_AUTH_INFO.gemini;
	const settings = readJsonObject(path.join(deps.homeDir, info.crewlySettingsFile));
	const apiKeys = settings && typeof settings.apiKeys === 'object' && settings.apiKeys !== null
		? (settings.apiKeys as Record<string, unknown>)
		: null;
	if (apiKeys) {
		const overrides = (apiKeys.runtimeOverrides ?? {}) as Record<string, Record<string, { source?: string; key?: string }> | undefined>;
		const override = overrides[info.crewlyRuntimeId]?.gemini;
		if (override && override.source === 'custom' && isSet(override.key)) return 'Crewly settings (Gemini runtime key)';
		const global = (apiKeys.global ?? {}) as Record<string, unknown>;
		if (isSet(global.gemini)) return 'Crewly settings';
	}
	const envName = firstSetEnv(deps.env, info.keyEnv);
	return envName ? `$${envName}` : null;
}

/**
 * Where Crewly would get the Gemini key an Antigravity session runs with:
 * the key saved for Antigravity (Settings → Harness / `crewly login
 * antigravity`), a Crewly settings Gemini key (antigravity-cli override or
 * global), or GEMINI_API_KEY.
 *
 * @param deps - Inputs
 * @returns Where the key comes from (never the key), or null
 */
export function findAntigravityKey(deps: RuntimeAuthDeps): string | null {
	const info = RUNTIME_AUTH_INFO.antigravity;
	const crewlyHome = deps.env.CREWLY_HOME || path.join(deps.homeDir, '.crewly');
	const credentials = readJsonObject(path.join(crewlyHome, info.credentialsFile));
	const stored = credentials?.antigravity as Record<string, unknown> | undefined;
	if (stored && isSet(stored.geminiApiKey)) return 'saved in Crewly';
	const settings = readJsonObject(path.join(crewlyHome, 'settings.json'));
	const apiKeys = settings && typeof settings.apiKeys === 'object' && settings.apiKeys !== null
		? (settings.apiKeys as Record<string, unknown>)
		: null;
	if (apiKeys) {
		const overrides = (apiKeys.runtimeOverrides ?? {}) as Record<string, Record<string, { source?: string; key?: string }> | undefined>;
		const override = overrides[info.crewlyRuntimeId]?.gemini;
		if (override && override.source === 'custom' && isSet(override.key)) return 'Crewly settings (Antigravity runtime key)';
		const global = (apiKeys.global ?? {}) as Record<string, unknown>;
		if (isSet(global.gemini)) return 'Crewly settings';
	}
	const envName = firstSetEnv(deps.env, info.keyEnv);
	return envName ? `$${envName}` : null;
}

/**
 * Antigravity CLI state: installed, and a Gemini API key Crewly can use.
 *
 * @param deps - Inputs
 * @returns Status
 */
export function checkAntigravityAuth(deps: RuntimeAuthDeps): RuntimeAuthStatus {
	const info = RUNTIME_AUTH_INFO.antigravity;
	const installed = deps.which(info.bin);
	const base = { id: 'antigravity' as const, displayName: info.displayName, installed, fix: fixFor(info, installed) };
	if (!installed) return { ...base, loggedIn: false, detail: 'not installed' };
	const key = findAntigravityKey(deps);
	if (key) return { ...base, loggedIn: true, detail: `Gemini API key (${key})` };
	return {
		...base,
		loggedIn: false,
		detail: 'installed but no Gemini API key — Crewly runs Antigravity only with an API key, never a Google account login',
	};
}

/**
 * Gemini CLI login state.
 *
 * @param deps - Inputs
 * @returns Status
 */
export function checkGeminiAuth(deps: RuntimeAuthDeps): RuntimeAuthStatus {
	const info = RUNTIME_AUTH_INFO.gemini;
	const installed = deps.which(info.bin);
	const base = { id: 'gemini' as const, displayName: info.displayName, installed, fix: fixFor(info, installed), retired: true };
	if (!installed) return { ...base, loggedIn: false, detail: 'not installed' };

	const settings = readJsonObject(path.join(deps.homeDir, info.settingsFile));
	const security = (settings?.security ?? {}) as Record<string, unknown>;
	const auth = (security.auth ?? {}) as Record<string, unknown>;
	const selected = [auth.selectedType, settings?.[LEGACY_AUTH_TYPE_KEY]].find((v): v is string => typeof v === 'string' && v.length > 0) ?? null;
	const key = findCrewlyGeminiKey(deps);

	if (selected && (info.googleLoginTypes as readonly string[]).includes(selected)) {
		return fs.existsSync(path.join(deps.homeDir, info.oauthCredsFile))
			? { ...base, loggedIn: true, detail: 'logged in (Google account)' }
			: { ...base, loggedIn: false, detail: 'set to "Login with Google", but no saved Google login', fix: 'run `gemini` once and sign in with Google' };
	}
	if (selected === GEMINI_API_KEY_AUTH_TYPE || !selected) {
		if (key) {
			return {
				...base,
				loggedIn: true,
				detail: selected ? `API key (${key})` : `API key (${key}); Crewly selects "Use Gemini API Key" at launch`,
			};
		}
		return {
			...base,
			loggedIn: false,
			detail: selected ? 'set to use an API key, but no Gemini API key is configured' : 'no login and no Gemini API key',
		};
	}
	// Vertex AI, Cloud Shell, compute credentials: configured outside Gemini's files.
	return { ...base, loggedIn: true, detail: `auth method "${selected}" configured` };
}

/**
 * Check every runtime.
 *
 * @param deps - Inputs
 * @returns Claude, Codex, Antigravity, Gemini — in that order
 */
export function checkRuntimeAuth(deps: RuntimeAuthDeps): RuntimeAuthStatus[] {
	return [checkClaudeAuth(deps), checkCodexAuth(deps), checkAntigravityAuth(deps), checkGeminiAuth(deps)];
}
