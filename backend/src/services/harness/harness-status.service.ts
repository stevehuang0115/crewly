/**
 * Harness status — is each harness installed, which version, is a newer one
 * published, and is it logged in?
 *
 * Detection reads files, env var names and the exit codes of probe commands;
 * it never prints or returns a secret. Login sources are labels such as
 * `crewly-subscription` or `macos-keychain`.
 *
 * - Claude Code: a credential Crewly stores, `CLAUDE_CODE_OAUTH_TOKEN` /
 *   `ANTHROPIC_API_KEY` in the env, `~/.claude/.credentials.json`, or the macOS
 *   keychain item "Claude Code-credentials" (existence only: `security
 *   find-generic-password -s …` without `-w`/`-g`, so no secret is printed).
 * - Codex: `codex login status`; falls back to `$CODEX_HOME/auth.json`.
 * - Antigravity CLI: a Gemini key Crewly stores, else `GEMINI_API_KEY` in the
 *   env. An account login in agy's keyring is deliberately NOT counted:
 *   Crewly never runs agy on it (Google policy), so without a key it is
 *   logged out as far as Crewly is concerned.
 * - Gemini CLI (detect only): Google-login credentials file or an API key env var.
 *
 * Latest versions come from `npm view` for npm-installed harnesses; a
 * script-installed harness (Antigravity) has no version feed Crewly reads,
 * so its latest version is null.
 *
 * @module services/harness/harness-status.service
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS, HARNESS_CONSTANTS } from '../../constants.js';
import { getClaudeConfigFile, getClaudeCredentialsFile } from './claude-config.utils.js';
import { HarnessCredentialsStore, getHarnessCredentialsStore } from './harness-credentials.store.js';
import { buildHarnessPath, buildNpmPath, resolveExecutable, runCommand } from './harness-exec.utils.js';
import { getHarnessDefinition, listHarnessDefinitions, toPublicLoginMethods, type HarnessDefinition } from './harness-registry.js';
import {
	SILENT_HARNESS_LOGGER,
	type HarnessId,
	type HarnessLogger,
	type HarnessStatus,
	type LoginState,
	type RunCommand,
	type SystemToolStatus,
} from './harness.types.js';

/** Exit code of `security find-generic-password` when the item does not exist. */
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;

/** Injectable dependencies. */
export interface HarnessStatusDeps {
	run?: RunCommand;
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
	platform?: NodeJS.Platform;
	fileExists?: (file: string) => boolean;
	/** PATH lookup; defaults to {@link resolveExecutable} on the harness PATH */
	resolveCommand?: (command: string) => string | null;
	credentials?: HarnessCredentialsStore;
	now?: () => number;
	logger?: HarnessLogger;
}

/** Installed binary facts. */
export interface InstalledInfo {
	installed: boolean;
	/** Absolute path of the binary */
	path: string | null;
	version: string | null;
}

/** Login facts. */
export interface LoginInfo {
	loginState: LoginState;
	loginSource: string | null;
}

/**
 * Pull a version number out of `--version` output.
 *
 * @param output - Command output, e.g. `2.1.282 (Claude Code)` or `codex-cli 0.156.1`
 * @returns The version, or null
 */
export function parseVersion(output: string): string | null {
	const match = HARNESS_CONSTANTS.VERSION_PATTERN.exec(output);
	return match ? match[0] : null;
}

/**
 * Compare two dotted versions numerically (pre-release suffixes ignored).
 *
 * @param a - Version
 * @param b - Version
 * @returns Positive when a > b, negative when a < b, 0 when equal
 *
 * @example
 * ```ts
 * compareVersions('2.1.282', '2.1.99'); // > 0
 * ```
 */
export function compareVersions(a: string, b: string): number {
	const parts = (value: string): number[] =>
		value
			.split(/[-+]/)[0]
			.split('.')
			.map((part) => Number.parseInt(part, 10) || 0);
	const left = parts(a);
	const right = parts(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/**
 * Classify `codex login status` output.
 *
 * @param output - stdout + stderr (may mention a masked key; never returned)
 * @returns `chatgpt`, `api_key` or `codex`
 */
export function parseCodexLoginSource(output: string): string {
	if (/chatgpt/i.test(output)) return 'chatgpt';
	if (/api\s*key/i.test(output)) return 'api_key';
	return 'codex';
}

/** Detects install, version and login state of each harness. */
export class HarnessStatusService {
	private readonly run: RunCommand;
	private readonly env: NodeJS.ProcessEnv;
	private readonly homeDir: string;
	private readonly platform: NodeJS.Platform;
	private readonly fileExists: (file: string) => boolean;
	private readonly resolveCommand: (command: string) => string | null;
	private readonly credentials: HarnessCredentialsStore;
	private readonly now: () => number;
	private readonly logger: HarnessLogger;
	private readonly latestCache = new Map<string, { value: string | null; expiresAt: number }>();

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: HarnessStatusDeps = {}) {
		this.run = deps.run ?? runCommand;
		this.env = deps.env ?? process.env;
		this.homeDir = deps.homeDir ?? os.homedir();
		this.platform = deps.platform ?? process.platform;
		this.fileExists = deps.fileExists ?? ((file) => fs.existsSync(file));
		this.resolveCommand = deps.resolveCommand ?? ((command) => resolveExecutable(command, buildHarnessPath(this.env.PATH, this.homeDir)));
		this.credentials = deps.credentials ?? getHarnessCredentialsStore();
		this.now = deps.now ?? Date.now;
		this.logger = deps.logger ?? SILENT_HARNESS_LOGGER;
	}

	/**
	 * Environment for probe commands (harness PATH).
	 *
	 * @returns Env copy
	 */
	private probeEnv(): NodeJS.ProcessEnv {
		return { ...this.env, PATH: buildHarnessPath(this.env.PATH, this.homeDir) };
	}

	/**
	 * Whether the binary is on PATH and which version it reports.
	 *
	 * @param def - Harness definition
	 * @returns Installed facts
	 */
	async getInstalledInfo(def: HarnessDefinition): Promise<InstalledInfo> {
		const binary = this.resolveCommand(def.command);
		if (!binary) return { installed: false, path: null, version: null };
		const result = await this.run(binary, def.versionArgs, { env: this.probeEnv(), timeoutMs: HARNESS_CONSTANTS.PROBE_TIMEOUT_MS });
		// Only a clean exit reports a version: a broken install's crash output
		// ("Node.js v22.14.0") must not pass for the harness's version.
		const version = result.code === 0 ? parseVersion(`${result.stdout}\n${result.stderr}`) : null;
		return { installed: true, path: binary, version };
	}

	/**
	 * Latest published version (`npm view <pkg> version`), cached.
	 *
	 * @param def - Harness definition
	 * @returns The version, or null when npm could not be asked or the harness is not an npm package
	 */
	async getLatestVersion(def: HarnessDefinition): Promise<string | null> {
		if (def.install.kind !== 'npm') return null;
		const npmPackage = def.install.npmPackage;
		const cached = this.latestCache.get(npmPackage);
		if (cached && cached.expiresAt > this.now()) return cached.value;
		const result = await this.run('npm', ['view', npmPackage, 'version'], {
			env: { ...this.env, PATH: buildNpmPath(this.env.PATH, this.homeDir) },
			timeoutMs: HARNESS_CONSTANTS.NPM_VIEW_TIMEOUT_MS,
		});
		const value = result.code === 0 ? parseVersion(result.stdout) : null;
		if (value === null) {
			this.logger.debug('npm view failed', { pkg: npmPackage, code: result.code, error: result.error });
		}
		this.latestCache.set(npmPackage, {
			value,
			expiresAt: this.now() + (value ? HARNESS_CONSTANTS.LATEST_VERSION_CACHE_TTL_MS : HARNESS_CONSTANTS.LATEST_VERSION_FAILURE_TTL_MS),
		});
		return value;
	}

	/** Forget cached latest versions. */
	clearLatestVersionCache(): void {
		this.latestCache.clear();
	}

	/**
	 * First env var (by name) that has a value.
	 *
	 * @param names - Candidates
	 * @returns The name, or null
	 */
	private firstSetEnv(names: readonly string[]): string | null {
		return names.find((name) => (this.env[name] ?? '').trim().length > 0) ?? null;
	}

	/**
	 * Claude Code login detection.
	 *
	 * @returns Login facts
	 */
	private async getClaudeLogin(): Promise<LoginInfo> {
		const stored = this.credentials.getClaudeCredentialKind();
		if (stored === 'oauth_token') return { loginState: 'logged_in', loginSource: 'crewly-subscription' };
		if (stored === 'api_key') return { loginState: 'logged_in', loginSource: 'crewly-api-key' };

		const envName = this.firstSetEnv([HARNESS_CONSTANTS.CLAUDE.OAUTH_TOKEN_ENV, HARNESS_CONSTANTS.CLAUDE.API_KEY_ENV]);
		if (envName) return { loginState: 'logged_in', loginSource: `env:${envName}` };

		const location = { env: this.env, homeDir: this.homeDir };
		if (this.fileExists(getClaudeCredentialsFile(location))) {
			return { loginState: 'logged_in', loginSource: 'claude-credentials-file' };
		}

		if (this.platform === 'darwin') {
			// Existence only: no -w / -g, so the secret is never printed.
			const result = await this.run('security', ['find-generic-password', '-s', HARNESS_CONSTANTS.CLAUDE.KEYCHAIN_SERVICE], {
				env: this.probeEnv(),
				timeoutMs: HARNESS_CONSTANTS.PROBE_TIMEOUT_MS,
			});
			if (result.code === 0) return { loginState: 'logged_in', loginSource: 'macos-keychain' };
			if (result.code !== KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE) {
				return { loginState: 'unknown', loginSource: null };
			}
		}
		// A config file naming an account is a weaker signal than a credential;
		// report it as unknown rather than claiming a working login.
		if (this.fileExists(getClaudeConfigFile(location)) && this.claudeConfigHasAccount(getClaudeConfigFile(location))) {
			return { loginState: 'unknown', loginSource: 'claude-config' };
		}
		return { loginState: 'logged_out', loginSource: null };
	}

	/**
	 * Whether `~/.claude.json` records an OAuth account or a primary API key.
	 *
	 * @param file - Config path
	 * @returns True when an account is recorded
	 */
	private claudeConfigHasAccount(file: string): boolean {
		try {
			const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
			return Boolean(parsed.oauthAccount) || Boolean(parsed.primaryApiKey);
		} catch {
			return false;
		}
	}

	/**
	 * Codex login detection.
	 *
	 * @param binary - Codex binary path, when installed
	 * @returns Login facts
	 */
	private async getCodexLogin(binary: string | null): Promise<LoginInfo> {
		const codexHome = this.env[HARNESS_CONSTANTS.CODEX.HOME_ENV] || path.join(this.homeDir, HARNESS_CONSTANTS.CODEX.HOME_DIR);
		const authFileExists = this.fileExists(path.join(codexHome, HARNESS_CONSTANTS.CODEX.AUTH_FILE));
		if (binary) {
			const result = await this.run(binary, ['login', 'status'], { env: this.probeEnv(), timeoutMs: HARNESS_CONSTANTS.PROBE_TIMEOUT_MS });
			if (result.code === 0) {
				return { loginState: 'logged_in', loginSource: parseCodexLoginSource(`${result.stdout}\n${result.stderr}`) };
			}
			if (result.code !== null) return { loginState: 'logged_out', loginSource: null };
			this.logger.debug('codex login status could not run', { error: result.error });
		}
		return authFileExists ? { loginState: 'logged_in', loginSource: 'codex-auth-file' } : { loginState: binary ? 'unknown' : 'logged_out', loginSource: null };
	}

	/**
	 * Antigravity CLI login detection: only a Gemini API key counts.
	 *
	 * @returns Login facts
	 */
	private getAntigravityLogin(): LoginInfo {
		if (this.credentials.getAntigravityGeminiApiKey()) {
			return { loginState: 'logged_in', loginSource: HARNESS_CONSTANTS.ANTIGRAVITY.STORED_KEY_SOURCE };
		}
		const envName = this.firstSetEnv([ANTIGRAVITY_CONSTANTS.API_KEY_ENV]);
		if (envName) return { loginState: 'logged_in', loginSource: `env:${envName}` };
		return { loginState: 'logged_out', loginSource: null };
	}

	/**
	 * Gemini CLI login detection (detect only).
	 *
	 * @returns Login facts
	 */
	private getGeminiLogin(): LoginInfo {
		if (this.fileExists(path.join(this.homeDir, HARNESS_CONSTANTS.GEMINI.OAUTH_CREDS_FILE))) {
			return { loginState: 'logged_in', loginSource: 'gemini-google-login' };
		}
		const envName = this.firstSetEnv(HARNESS_CONSTANTS.GEMINI.KEY_ENV);
		if (envName) return { loginState: 'logged_in', loginSource: `env:${envName}` };
		return { loginState: 'unknown', loginSource: null };
	}

	/**
	 * Login state of a harness.
	 *
	 * @param def - Harness definition
	 * @param binary - Binary path when installed (Codex asks the binary itself)
	 * @returns Login facts
	 */
	async getLoginInfo(def: HarnessDefinition, binary: string | null): Promise<LoginInfo> {
		try {
			switch (def.id) {
				case HARNESS_CONSTANTS.IDS.CLAUDE_CODE:
					return await this.getClaudeLogin();
				case HARNESS_CONSTANTS.IDS.CODEX_CLI:
					return await this.getCodexLogin(binary);
				case HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI:
					return this.getAntigravityLogin();
				default:
					return this.getGeminiLogin();
			}
		} catch (error) {
			this.logger.warn('Harness login detection failed', { harnessId: def.id, error: error instanceof Error ? error.message : String(error) });
			return { loginState: 'unknown', loginSource: null };
		}
	}

	/**
	 * Full status of one harness.
	 *
	 * @param id - Harness id
	 * @returns The status
	 * @throws Error for an unknown harness id
	 */
	async getStatus(id: HarnessId): Promise<HarnessStatus> {
		const def = getHarnessDefinition(id);
		if (!def) throw new Error(`Unknown harness: ${id}`);
		const [installedInfo, latestVersion] = await Promise.all([this.getInstalledInfo(def), this.getLatestVersion(def)]);
		const login = await this.getLoginInfo(def, installedInfo.path);
		const updateAvailable = Boolean(
			installedInfo.installed && installedInfo.version && latestVersion && compareVersions(latestVersion, installedInfo.version) > 0,
		);
		return {
			id: def.id,
			displayName: def.displayName,
			installed: installedInfo.installed,
			version: installedInfo.version,
			latestVersion,
			updateAvailable,
			loginState: login.loginState,
			loginSource: login.loginSource,
			loginMethods: toPublicLoginMethods(def),
			retired: def.retired,
		};
	}

	/**
	 * Status of every harness, in registry order.
	 *
	 * @returns Statuses
	 */
	async listStatuses(): Promise<HarnessStatus[]> {
		return Promise.all(listHarnessDefinitions().map((def) => this.getStatus(def.id)));
	}

	/**
	 * Required system tools (jq).
	 *
	 * @returns One entry per tool
	 */
	getSystemTools(): SystemToolStatus[] {
		const jq = HARNESS_CONSTANTS.SYSTEM_TOOLS.JQ;
		return [
			{
				id: jq.ID,
				installed: this.resolveCommand(jq.ID) !== null,
				installHint: this.platform === 'darwin' ? jq.INSTALL_HINT_MACOS : jq.INSTALL_HINT_LINUX,
			},
		];
	}
}
