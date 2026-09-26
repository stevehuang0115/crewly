/**
 * Antigravity CLI (`agy`) user settings — force the Gemini API key provider.
 *
 * Google does not allow third-party tools to drive Antigravity with the
 * user's Google account (product OAuth), so Crewly runs agy only with a
 * Gemini API key. Per https://antigravity.google/docs/cli/install/ that
 * takes two things: `"modelProvider": "gemini"` in
 * `~/.gemini/antigravity-cli/settings.json` and `GEMINI_API_KEY` in the
 * environment ("Only setting a GEMINI_API_KEY environment variable on its
 * own has no effect"). With the provider set, agy skips the sign-in screen
 * and "never establishes an account session" — an account login already in
 * the OS keyring is not used.
 *
 * The same write also records folders in `trustedWorkspaces` (the list agy
 * itself appends to when the user answers its folder-trust screen), so an
 * agent started in a new project does not stop on that screen.
 *
 * The settings file is agy's own: every other key is preserved, and a file
 * that is not a JSON object is never rewritten (the caller refuses to launch
 * instead). There is no per-process override — see the "Limitations"
 * section of specs/antigravity-runtime.md for what this means for the
 * user's own `agy`.
 *
 * @module utils/antigravity-settings
 */

import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANTIGRAVITY_CONSTANTS } from '../constants.js';
import { withOperationLock } from './file-io.utils.js';

/** What {@link ensureAntigravityApiKeyProvider} did. */
export type AntigravityProviderResult =
	/** The file was created or updated */
	| 'written'
	/** Provider and trusted folders were already as required */
	| 'unchanged'
	/** The file exists but is not a JSON object; left untouched */
	| 'unparseable'
	/** Reading or writing failed; nothing changed */
	| 'error';

/** Minimal logger accepted by this module. */
export interface AntigravitySettingsLogger {
	warn(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
}

/** Options for {@link ensureAntigravityApiKeyProvider}. */
export interface EnsureAntigravityProviderOptions {
	/** Settings file; defaults to `~/.gemini/antigravity-cli/settings.json` */
	settingsPath?: string;
	/** Folders to add to `trustedWorkspaces` (absolute; relative ones are resolved) */
	trustedPaths?: readonly string[];
	logger?: AntigravitySettingsLogger;
}

/**
 * agy's config directory.
 *
 * @param homeDir - Home directory (injectable for tests)
 * @returns `~/.gemini/antigravity-cli`
 */
export function getAntigravityConfigDir(homeDir: string = os.homedir()): string {
	return path.join(homeDir, ...ANTIGRAVITY_CONSTANTS.CONFIG_DIR_SEGMENTS);
}

/**
 * agy's user settings file.
 *
 * @param homeDir - Home directory (injectable for tests)
 * @returns `~/.gemini/antigravity-cli/settings.json`
 */
export function getAntigravitySettingsPath(homeDir: string = os.homedir()): string {
	return path.join(getAntigravityConfigDir(homeDir), ANTIGRAVITY_CONSTANTS.SETTINGS_FILE);
}

/**
 * Parse agy settings text.
 *
 * @param raw - File content
 * @returns The settings object, `{}` for an empty file, or null when it is not a JSON object
 */
export function parseAntigravitySettings(raw: string): Record<string, unknown> | null {
	if (!raw.trim()) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * Whether settings already select the Gemini API key provider.
 *
 * @param settings - Parsed settings
 * @returns True when `modelProvider` is `gemini`
 */
export function hasGeminiProvider(settings: Record<string, unknown>): boolean {
	return settings[ANTIGRAVITY_CONSTANTS.MODEL_PROVIDER_KEY] === ANTIGRAVITY_CONSTANTS.MODEL_PROVIDER_GEMINI;
}

/**
 * Settings with the Gemini provider selected and the folders trusted.
 *
 * Pure: returns a new object and whether anything changed. Existing trusted
 * folders keep their order; new ones are appended once.
 *
 * @param settings - Current settings
 * @param trustedPaths - Folders to trust
 * @returns The merged settings and a change flag
 */
export function mergeAntigravitySettings(
	settings: Record<string, unknown>,
	trustedPaths: readonly string[] = [],
): { settings: Record<string, unknown>; changed: boolean } {
	const next: Record<string, unknown> = { ...settings };
	let changed = false;
	if (!hasGeminiProvider(next)) {
		next[ANTIGRAVITY_CONSTANTS.MODEL_PROVIDER_KEY] = ANTIGRAVITY_CONSTANTS.MODEL_PROVIDER_GEMINI;
		changed = true;
	}
	const existing = next[ANTIGRAVITY_CONSTANTS.TRUSTED_WORKSPACES_KEY];
	const trusted: string[] = Array.isArray(existing) ? existing.filter((entry): entry is string => typeof entry === 'string') : [];
	const wanted = trustedPaths.filter((p) => typeof p === 'string' && p.length > 0).map((p) => path.resolve(p));
	const additions = wanted.filter((p, index) => !trusted.includes(p) && wanted.indexOf(p) === index);
	if (additions.length > 0 || (existing !== undefined && !Array.isArray(existing))) {
		next[ANTIGRAVITY_CONSTANTS.TRUSTED_WORKSPACES_KEY] = [...trusted, ...additions];
		changed = true;
	}
	return { settings: next, changed };
}

/**
 * Write the file atomically with agy's own mode (0600).
 *
 * @param settingsPath - Target
 * @param settings - Content
 */
async function writeSettingsFile(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
	await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
	const tmp = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
	await fsPromises.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: ANTIGRAVITY_CONSTANTS.SETTINGS_FILE_MODE });
	await fsPromises.rename(tmp, settingsPath);
	await fsPromises.chmod(settingsPath, ANTIGRAVITY_CONSTANTS.SETTINGS_FILE_MODE);
}

/**
 * Make agy use the Gemini API key provider, and trust the given folders.
 *
 * Call before every agy launch Crewly makes, and when an Antigravity key is
 * saved. Serialized per file, so parallel agent launches do not lose each
 * other's trusted folders.
 *
 * @param options - Settings path, folders to trust, logger
 * @returns What was done
 *
 * @example
 * ```typescript
 * const result = await ensureAntigravityApiKeyProvider({ trustedPaths: [projectPath] });
 * if (result === 'unparseable') throw new Error('fix agy settings first');
 * ```
 */
export async function ensureAntigravityApiKeyProvider(options: EnsureAntigravityProviderOptions = {}): Promise<AntigravityProviderResult> {
	const settingsPath = options.settingsPath ?? getAntigravitySettingsPath();
	const logger = options.logger;
	return withOperationLock(settingsPath, async () => {
		let settings: Record<string, unknown> = {};
		try {
			const parsed = parseAntigravitySettings(await fsPromises.readFile(settingsPath, 'utf8'));
			if (parsed === null) {
				logger?.warn('Antigravity settings are not a JSON object; not changing them', { settingsPath });
				return 'unparseable';
			}
			settings = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger?.warn('Could not read Antigravity settings', { settingsPath, error: String(error) });
				return 'error';
			}
		}

		const merged = mergeAntigravitySettings(settings, options.trustedPaths ?? []);
		if (!merged.changed) return 'unchanged';
		try {
			await writeSettingsFile(settingsPath, merged.settings);
			logger?.info('Antigravity set to the Gemini API key provider', { settingsPath, trustedPaths: options.trustedPaths?.length ?? 0 });
			return 'written';
		} catch (error) {
			logger?.warn('Could not write Antigravity settings', { settingsPath, error: String(error) });
			return 'error';
		}
	});
}

/**
 * Read whether agy is set to the Gemini API key provider (status display).
 *
 * @param settingsPath - Settings file
 * @returns True / false, or null when the file is missing or unreadable
 */
export async function readAntigravityProviderIsGemini(settingsPath: string = getAntigravitySettingsPath()): Promise<boolean | null> {
	try {
		const parsed = parseAntigravitySettings(await fsPromises.readFile(settingsPath, 'utf8'));
		return parsed === null ? null : hasGeminiProvider(parsed);
	} catch {
		return null;
	}
}
