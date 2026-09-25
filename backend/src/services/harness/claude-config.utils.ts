/**
 * Claude Code config helpers for logins Crewly performs.
 *
 * Claude Code shows two interactive screens that an agent PTY cannot get
 * past, and a login done through Crewly (token or API key in the env) does
 * not dismiss either of them:
 * - the first-run theme picker ("Choose the text style"), shown until
 *   `hasCompletedOnboarding` is true in `~/.claude.json` — Crewly already
 *   refuses to start agents while it is up (CLAUDE_STARTUP_BLOCKERS);
 * - "Detected a custom API key … use it?", shown for an `ANTHROPIC_API_KEY`
 *   whose last 20 characters are not in `customApiKeyResponses.approved`.
 *
 * After a successful Crewly login these helpers record both answers, the way
 * Claude Code itself does when a person answers them. Other keys in the file
 * are preserved; an unreadable file is left untouched.
 *
 * @module services/harness/claude-config.utils
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';

/** Inputs, injectable for tests. */
export interface ClaudeConfigLocation {
	env?: NodeJS.ProcessEnv;
	homeDir?: string;
}

/**
 * Directory holding Claude's data (`$CLAUDE_CONFIG_DIR` or `~/.claude`).
 *
 * @param location - env / home overrides
 * @returns Absolute directory
 */
export function getClaudeDataDir(location: ClaudeConfigLocation = {}): string {
	const env = location.env ?? process.env;
	const configDir = env[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV];
	return configDir && configDir.length > 0 ? configDir : path.join(location.homeDir ?? os.homedir(), HARNESS_CONSTANTS.CLAUDE.DATA_DIR);
}

/**
 * Claude's global config file (`$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json`).
 *
 * @param location - env / home overrides
 * @returns Absolute path
 */
export function getClaudeConfigFile(location: ClaudeConfigLocation = {}): string {
	const env = location.env ?? process.env;
	const configDir = env[HARNESS_CONSTANTS.CLAUDE.CONFIG_DIR_ENV];
	const base = configDir && configDir.length > 0 ? configDir : location.homeDir ?? os.homedir();
	return path.join(base, HARNESS_CONSTANTS.CLAUDE.CONFIG_FILE);
}

/**
 * Claude's credentials file (Linux; macOS keeps credentials in the keychain).
 *
 * @param location - env / home overrides
 * @returns Absolute path
 */
export function getClaudeCredentialsFile(location: ClaudeConfigLocation = {}): string {
	return path.join(getClaudeDataDir(location), HARNESS_CONSTANTS.CLAUDE.CREDENTIALS_FILE);
}

/** Result of {@link prepareClaudeConfigForCrewlyLogin}. */
export interface PrepareClaudeConfigResult {
	/** The file was written */
	changed: boolean;
	/** Why nothing was written, when the file could not be read */
	skippedReason?: string;
}

/**
 * Mark Claude Code's first-run setup as done and, for an API key, pre-approve it.
 *
 * @param options - `apiKey` to approve (only its last 20 characters are written)
 * @param location - env / home overrides
 * @returns Whether the file changed; never throws
 *
 * @example
 * ```ts
 * prepareClaudeConfigForCrewlyLogin({ apiKey: 'sk-ant-api03-…' });
 * ```
 */
export function prepareClaudeConfigForCrewlyLogin(
	options: { apiKey?: string } = {},
	location: ClaudeConfigLocation = {},
): PrepareClaudeConfigResult {
	const file = getClaudeConfigFile(location);
	let config: Record<string, unknown> = {};
	let mode: number | undefined;
	try {
		if (fs.existsSync(file)) {
			const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return { changed: false, skippedReason: 'config is not a JSON object' };
			}
			config = parsed as Record<string, unknown>;
			mode = fs.statSync(file).mode & 0o777;
		}
	} catch {
		return { changed: false, skippedReason: 'config is not readable JSON' };
	}

	let changed = false;
	if (config.hasCompletedOnboarding !== true) {
		config.hasCompletedOnboarding = true;
		changed = true;
	}

	if (options.apiKey) {
		const suffix = options.apiKey.trim().slice(-HARNESS_CONSTANTS.CLAUDE.API_KEY_APPROVAL_SUFFIX_LENGTH);
		const responses =
			config.customApiKeyResponses !== null && typeof config.customApiKeyResponses === 'object'
				? (config.customApiKeyResponses as { approved?: unknown; rejected?: unknown })
				: {};
		const approved = Array.isArray(responses.approved) ? responses.approved.filter((v): v is string => typeof v === 'string') : [];
		const rejected = Array.isArray(responses.rejected) ? responses.rejected.filter((v): v is string => typeof v === 'string') : [];
		if (!approved.includes(suffix) || rejected.includes(suffix)) {
			config.customApiKeyResponses = {
				...responses,
				approved: approved.includes(suffix) ? approved : [...approved, suffix],
				rejected: rejected.filter((value) => value !== suffix),
			};
			changed = true;
		}
	}

	if (!changed) return { changed: false };
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: mode ?? HARNESS_CONSTANTS.CREDENTIALS_FILE_MODE });
		fs.renameSync(tmp, file);
		return { changed: true };
	} catch (error) {
		return { changed: false, skippedReason: error instanceof Error ? error.message : String(error) };
	}
}
