/**
 * API-key login for harnesses.
 *
 * - Claude Code: the Anthropic key is checked against the Anthropic API (a
 *   401/403 rejects it; a network problem does not block saving a
 *   well-formed key), stored in the harness credentials store and exported
 *   to agents as `ANTHROPIC_API_KEY`. Claude's config is updated so the key
 *   is pre-approved (claude-config.utils).
 * - Codex: `codex login --with-api-key` with the key on **stdin** (never in
 *   argv); Codex saves it in its own `auth.json`.
 * - Antigravity CLI: the Gemini key is checked with a models-list call to
 *   the Gemini API (key in the `x-goog-api-key` header, never in the URL),
 *   stored in the harness credentials store (exported to antigravity-cli
 *   agents as `GEMINI_API_KEY`), and agy's settings are switched to the
 *   Gemini API key provider. This is the only Antigravity login Crewly
 *   offers: Google does not allow third-party tools to use Antigravity
 *   account (OAuth) login.
 *
 * The key is never logged, echoed back or put in an error message.
 *
 * @module services/harness/harness-api-key.service
 */

import { ANTIGRAVITY_CONSTANTS, HARNESS_CONSTANTS } from '../../constants.js';
import { ensureAntigravityApiKeyProvider, type AntigravityProviderResult } from '../../utils/antigravity-settings.utils.js';
import { prepareClaudeConfigForCrewlyLogin } from './claude-config.utils.js';
import { HarnessCredentialsStore, getHarnessCredentialsStore } from './harness-credentials.store.js';
import { buildHarnessPath, resolveExecutable, runCommand } from './harness-exec.utils.js';
import { getHarnessDefinition, getLoginMethod } from './harness-registry.js';
import { SILENT_HARNESS_LOGGER, type HarnessLogger, type RunCommand } from './harness.types.js';
import { redactSecrets } from './login-rules.js';

/** Error codes the REST layer maps to HTTP statuses. */
export type HarnessApiKeyErrorCode = 'unknown_harness' | 'unsupported' | 'invalid_key' | 'not_installed' | 'login_failed';

/** API-key login error. The message never contains the key. */
export class HarnessApiKeyError extends Error {
	/**
	 * @param code - Machine-readable code
	 * @param message - Human-readable message
	 */
	constructor(
		public readonly code: HarnessApiKeyErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'HarnessApiKeyError';
	}
}

/** Result of checking a key against the provider. */
export type KeyCheckResult = 'valid' | 'invalid' | 'unverified';

/** Minimal fetch signature (injectable for tests). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Injectable dependencies. */
export interface HarnessApiKeyDeps {
	run?: RunCommand;
	fetchFn?: FetchLike;
	env?: NodeJS.ProcessEnv;
	credentials?: HarnessCredentialsStore;
	resolveCommand?: (command: string) => string | null;
	prepareClaudeConfig?: (apiKey: string) => void;
	/** Switches agy to the Gemini API key provider (defaults to the real ~/.gemini/antigravity-cli/settings.json) */
	prepareAntigravitySettings?: () => Promise<AntigravityProviderResult>;
	logger?: HarnessLogger;
}

/**
 * Basic shape check shared by every provider.
 *
 * @param key - Candidate key (already trimmed)
 * @returns True when the length is plausible and it has no whitespace
 */
export function isPlausibleApiKey(key: string): boolean {
	return key.length >= HARNESS_CONSTANTS.API_KEY_MIN_LENGTH && key.length <= HARNESS_CONSTANTS.API_KEY_MAX_LENGTH && !/\s/.test(key);
}

/** Validates and stores harness API keys. */
export class HarnessApiKeyService {
	private readonly run: RunCommand;
	private readonly fetchFn: FetchLike;
	private readonly env: NodeJS.ProcessEnv;
	private readonly credentials: HarnessCredentialsStore;
	private readonly resolveCommand: (command: string) => string | null;
	private readonly prepareClaudeConfig: (apiKey: string) => void;
	private readonly prepareAntigravitySettings: () => Promise<AntigravityProviderResult>;
	private readonly logger: HarnessLogger;

	/**
	 * @param deps - Injectable dependencies (all optional)
	 */
	constructor(deps: HarnessApiKeyDeps = {}) {
		this.run = deps.run ?? runCommand;
		this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
		this.env = deps.env ?? process.env;
		this.credentials = deps.credentials ?? getHarnessCredentialsStore();
		this.resolveCommand = deps.resolveCommand ?? ((command) => resolveExecutable(command, buildHarnessPath(this.env.PATH)));
		this.prepareClaudeConfig = deps.prepareClaudeConfig ?? ((apiKey) => void prepareClaudeConfigForCrewlyLogin({ apiKey }));
		this.logger = deps.logger ?? SILENT_HARNESS_LOGGER;
		this.prepareAntigravitySettings = deps.prepareAntigravitySettings ?? (() => ensureAntigravityApiKeyProvider({ logger: this.logger }));
	}

	/**
	 * Validate and store an API key for a harness.
	 *
	 * @param harnessId - Harness id
	 * @param rawKey - The key as pasted
	 * @throws HarnessApiKeyError unknown_harness | unsupported | invalid_key | not_installed | login_failed
	 */
	async submit(harnessId: string, rawKey: unknown): Promise<void> {
		const def = getHarnessDefinition(harnessId);
		if (!def) throw new HarnessApiKeyError('unknown_harness', `Unknown harness: ${harnessId}`);
		if (!getLoginMethod(def.id, 'api_key')) {
			throw new HarnessApiKeyError('unsupported', `${def.displayName} does not take an API key in Crewly`);
		}
		const key = typeof rawKey === 'string' ? rawKey.trim() : '';
		if (!isPlausibleApiKey(key)) {
			throw new HarnessApiKeyError('invalid_key', 'That does not look like an API key');
		}
		switch (def.id) {
			case HARNESS_CONSTANTS.IDS.CLAUDE_CODE:
				await this.submitAnthropicKey(key);
				return;
			case HARNESS_CONSTANTS.IDS.ANTIGRAVITY_CLI:
				await this.submitAntigravityKey(key);
				return;
			default:
				await this.submitCodexKey(key);
		}
	}

	/**
	 * Check a Gemini API key with a models-list call.
	 *
	 * @param key - The key (sent in the `x-goog-api-key` header)
	 * @returns valid | invalid (400/401/403) | unverified (network error, other status)
	 */
	async checkGeminiKey(key: string): Promise<KeyCheckResult> {
		const api = ANTIGRAVITY_CONSTANTS.GEMINI_API;
		try {
			const response = await this.fetchFn(api.MODELS_URL, {
				method: 'GET',
				headers: { [api.KEY_HEADER]: key },
				signal: AbortSignal.timeout(api.CHECK_TIMEOUT_MS),
			});
			if (response.status >= 200 && response.status < 300) return 'valid';
			if (api.REJECTED_STATUSES.includes(response.status)) return 'invalid';
			return 'unverified';
		} catch {
			return 'unverified';
		}
	}

	/**
	 * Validate and store the Gemini key Antigravity CLI runs with, then
	 * switch agy to the Gemini API key provider.
	 *
	 * @param key - The key
	 * @throws HarnessApiKeyError invalid_key | login_failed (agy settings file unreadable)
	 */
	private async submitAntigravityKey(key: string): Promise<void> {
		const check = await this.checkGeminiKey(key);
		if (check === 'invalid') throw new HarnessApiKeyError('invalid_key', 'The Gemini API rejected this key');
		this.credentials.setAntigravityGeminiApiKey(key);
		this.logger.info('Antigravity Gemini API key stored', { verified: check === 'valid' });
		const provider = await this.prepareAntigravitySettings();
		if (provider === 'unparseable') {
			throw new HarnessApiKeyError('login_failed', ANTIGRAVITY_CONSTANTS.MESSAGES.SETTINGS_UNREADABLE);
		}
		if (provider === 'error') {
			this.logger.warn('Could not switch Antigravity to the Gemini API key provider now; it is retried at every agent launch');
		}
	}

	/**
	 * Check an Anthropic key against the API.
	 *
	 * @param key - The key
	 * @returns valid | invalid | unverified (network error, unexpected status)
	 */
	async checkAnthropicKey(key: string): Promise<KeyCheckResult> {
		try {
			const response = await this.fetchFn(HARNESS_CONSTANTS.CLAUDE.API_KEY_CHECK_URL, {
				method: 'GET',
				headers: { 'x-api-key': key, 'anthropic-version': HARNESS_CONSTANTS.CLAUDE.API_VERSION },
				signal: AbortSignal.timeout(HARNESS_CONSTANTS.CLAUDE.API_KEY_CHECK_TIMEOUT_MS),
			});
			if (response.status >= 200 && response.status < 300) return 'valid';
			if (response.status === 401 || response.status === 403) return 'invalid';
			return 'unverified';
		} catch {
			return 'unverified';
		}
	}

	/**
	 * Validate and store an Anthropic key.
	 *
	 * @param key - The key
	 * @throws HarnessApiKeyError invalid_key
	 */
	private async submitAnthropicKey(key: string): Promise<void> {
		if (!key.startsWith(HARNESS_CONSTANTS.CLAUDE.API_KEY_PREFIX)) {
			throw new HarnessApiKeyError('invalid_key', `Anthropic API keys start with ${HARNESS_CONSTANTS.CLAUDE.API_KEY_PREFIX}`);
		}
		const check = await this.checkAnthropicKey(key);
		if (check === 'invalid') throw new HarnessApiKeyError('invalid_key', 'Anthropic rejected this API key');
		this.credentials.setAnthropicApiKey(key);
		try {
			this.prepareClaudeConfig(key);
		} catch (error) {
			this.logger.warn('Could not update Claude config after API key login', { error: error instanceof Error ? error.message : String(error) });
		}
		this.logger.info('Anthropic API key stored', { verified: check === 'valid' });
	}

	/**
	 * Log Codex in with an OpenAI key (key on stdin).
	 *
	 * @param key - The key
	 * @throws HarnessApiKeyError not_installed | login_failed
	 */
	private async submitCodexKey(key: string): Promise<void> {
		const binary = this.resolveCommand('codex');
		if (!binary) throw new HarnessApiKeyError('not_installed', 'Codex is not installed');
		const result = await this.run(binary, ['login', '--with-api-key'], {
			env: { ...this.env, PATH: buildHarnessPath(this.env.PATH) },
			stdin: `${key}\n`,
			timeoutMs: HARNESS_CONSTANTS.LOGIN.VERIFY_TIMEOUT_MS,
		});
		if (result.code !== 0) {
			const detail = redactSecrets(`${result.stdout}\n${result.stderr}\n${result.error ?? ''}`, [key]).trim();
			throw new HarnessApiKeyError('login_failed', detail ? `Codex did not accept the key: ${detail}` : 'Codex did not accept the key');
		}
		this.logger.info('Codex logged in with an API key');
	}
}
