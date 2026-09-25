/**
 * Secret environment variable guard
 *
 * Environment variables whose names mark them as secrets (API keys, tokens,
 * passwords) must never be set by typing `export KEY="value"` into a
 * terminal: the shell echoes the line, so the value lands in scrollback, in
 * the persistent session log (~/.crewly/logs/sessions/) and in the
 * terminal-output API. Secrets go into a session through its spawn
 * environment instead (`createSession(..., { env })`).
 *
 * @module utils/secret-env
 */

/**
 * Name suffixes that mark an environment variable as secret. Matched
 * case-insensitively at the end of the name, after `_` or at the start
 * (so `API_KEY`, `OPENAI_API_KEY` and `GITHUB_TOKEN` match, `TOKENIZER` does not).
 */
const SECRET_ENV_NAME_RE = /(?:^|_)(?:API_KEY|KEY_SECRET|SECRET|SECRET_KEY|TOKEN|ACCESS_TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)$/i;

/**
 * Whether an environment variable name denotes a secret.
 *
 * @param key - Environment variable name
 * @returns True for names like OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN
 *
 * @example
 * ```ts
 * isSecretEnvKey('GEMINI_API_KEY'); // true
 * isSecretEnvKey('CREWLY_SESSION_NAME'); // false
 * ```
 */
export function isSecretEnvKey(key: string): boolean {
	return SECRET_ENV_NAME_RE.test(key);
}

/**
 * Throws when asked to type a secret into a terminal.
 *
 * The error names the variable only, never the value.
 *
 * @param key - Environment variable name about to be exported in a terminal
 * @throws Error when `key` is a secret name (see isSecretEnvKey)
 */
export function assertNotSecretEnvKey(key: string): void {
	if (isSecretEnvKey(key)) {
		throw new Error(
			`Refusing to type secret environment variable ${key} into a terminal ` +
				'(it would be echoed into scrollback and session logs). ' +
				'Pass it in the session spawn environment: createSession(name, cwd, { env }).'
		);
	}
}

/** A secret's variable name and value, for masking by value */
export interface SecretEnvValue {
	/** Variable name, used in the mask */
	name: string;
	/** The secret value to mask wherever it appears */
	value: string;
}

/** Values shorter than this are not masked: too likely to match ordinary text */
const MIN_MASKABLE_SECRET_LENGTH = 12;

/**
 * Collects the values of every secret-named variable in one or more env maps.
 *
 * Used to mask secrets by exact value, which catches secrets no pattern can
 * recognise (a Slack signing secret is plain hex). Longest values come first
 * so a value that contains another is masked whole.
 *
 * @param envs - Env maps to read (e.g. process.env and a session's spawn env)
 * @returns Distinct secret values with their names, longest first
 */
export function collectSecretEnvValues(
	...envs: ReadonlyArray<Record<string, string | undefined> | undefined>
): SecretEnvValue[] {
	const byValue = new Map<string, string>();
	for (const env of envs) {
		if (!env) continue;
		for (const [name, value] of Object.entries(env)) {
			if (value && value.length >= MIN_MASKABLE_SECRET_LENGTH && isSecretEnvKey(name) && !byValue.has(value)) {
				byValue.set(value, name);
			}
		}
	}
	return Array.from(byValue, ([value, name]) => ({ name, value })).sort((a, b) => b.value.length - a.value.length);
}

/**
 * Replaces every occurrence of the given secret values with `[REDACTED <NAME>]`.
 *
 * @param text - Text to mask
 * @param secrets - Values to mask (see collectSecretEnvValues)
 * @returns The text with every listed value masked
 */
export function redactSecretEnvValues(text: string, secrets: readonly SecretEnvValue[]): string {
	let out = text;
	for (const { name, value } of secrets) {
		if (out.includes(value)) out = out.split(value).join(`[REDACTED ${name}]`);
	}
	return out;
}
