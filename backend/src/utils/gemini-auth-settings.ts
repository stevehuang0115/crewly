/**
 * Pre-select Gemini CLI's authentication method.
 *
 * Interactive Gemini CLI reads its auth method only from settings
 * (`security.auth.selectedType`). With none saved it opens the
 * "How would you like to authenticate for this project?" dialog on every
 * launch, even when GEMINI_API_KEY is set ("Existing API key detected ...
 * Select 'Gemini API Key' option to use it"). Non-interactive runs fall back
 * to the environment, which is why `gemini` looks fine when run by hand
 * without a terminal but a Crewly-launched session stalls on the dialog and
 * never reaches its ready prompt.
 *
 * Verified against Gemini CLI 0.61.0 in a clean HOME: no saved method +
 * GEMINI_API_KEY -> auth dialog at 2s; `selectedType: "gemini-api-key"` ->
 * ready prompt at 2s.
 *
 * @module utils/gemini-auth-settings
 */

import { promises as fsPromises } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Gemini CLI's value for "Use Gemini API Key". */
export const GEMINI_API_KEY_AUTH_TYPE = 'gemini-api-key';

/** What {@link ensureGeminiApiKeyAuthSelected} did. */
export type GeminiAuthSeedResult =
	/** No method was saved; "Use Gemini API Key" is now selected. */
	| 'seeded'
	/** A method was already saved (the user's choice); left untouched. */
	| 'kept'
	/** The settings file exists but is not plain JSON; left untouched. */
	| 'unparseable'
	/** Reading or writing failed; nothing changed. */
	| 'error';

/** Minimal logger accepted by this module. */
export interface GeminiAuthSettingsLogger {
	warn(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Path of Gemini CLI's user settings file.
 *
 * @returns `~/.gemini/settings.json`
 */
export function getDefaultGeminiUserSettingsPath(): string {
	return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Select "Use Gemini API Key" in Gemini's user settings when no auth method
 * has been chosen yet.
 *
 * Call only when a Gemini API key is actually available to the session.
 * Never overrides an existing choice (e.g. Login with Google), never rewrites
 * a file it cannot parse, and preserves every other setting.
 *
 * @param logger - Optional logger
 * @param settingsPath - Override for tests; defaults to ~/.gemini/settings.json
 * @returns What was done
 *
 * @example
 * ```typescript
 * if (apiKey) await ensureGeminiApiKeyAuthSelected(logger);
 * ```
 */
export async function ensureGeminiApiKeyAuthSelected(
	logger?: GeminiAuthSettingsLogger,
	settingsPath: string = getDefaultGeminiUserSettingsPath(),
): Promise<GeminiAuthSeedResult> {
	let settings: Record<string, unknown> = {};
	try {
		const raw = await fsPromises.readFile(settingsPath, 'utf8');
		if (raw.trim()) {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					logger?.warn('Gemini settings are not a JSON object; not pre-selecting auth', { settingsPath });
					return 'unparseable';
				}
				settings = parsed as Record<string, unknown>;
			} catch {
				// Gemini accepts comments in settings.json; rewriting would drop them.
				logger?.warn('Gemini settings could not be parsed as JSON; not pre-selecting auth', { settingsPath });
				return 'unparseable';
			}
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			logger?.warn('Could not read Gemini settings; not pre-selecting auth', { settingsPath, error: String(error) });
			return 'error';
		}
	}

	const security = (settings.security ?? {}) as Record<string, unknown>;
	const auth = (security.auth ?? {}) as Record<string, unknown>;
	if (typeof auth.selectedType === 'string' && auth.selectedType.length > 0) {
		return 'kept';
	}

	const updated = {
		...settings,
		security: { ...security, auth: { ...auth, selectedType: GEMINI_API_KEY_AUTH_TYPE } },
	};
	try {
		await fsPromises.mkdir(path.dirname(settingsPath), { recursive: true });
		await fsPromises.writeFile(settingsPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
		logger?.info('Pre-selected "Use Gemini API Key" in Gemini settings so the auth dialog does not block startup', {
			settingsPath,
		});
		return 'seeded';
	} catch (error) {
		logger?.warn('Could not write Gemini settings; the auth dialog may appear', { settingsPath, error: String(error) });
		return 'error';
	}
}
