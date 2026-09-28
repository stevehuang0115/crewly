/**
 * Tests for the secret environment variable guard.
 *
 * @module utils/secret-env.test
 */

import { assertNotSecretEnvKey, isSecretEnvKey } from './secret-env.js';

describe('isSecretEnvKey', () => {
	it.each([
		'GEMINI_API_KEY',
		'GOOGLE_GENERATIVE_AI_API_KEY',
		'ANTHROPIC_API_KEY',
		'OPENAI_API_KEY',
		'API_KEY',
		'GITHUB_TOKEN',
		'SLACK_BOT_TOKEN',
		'AWS_SECRET',
		'DB_PASSWORD',
		'anthropic_api_key',
	])('treats %s as a secret', (key) => {
		expect(isSecretEnvKey(key)).toBe(true);
	});

	it.each([
		'CREWLY_SESSION_NAME',
		'CREWLY_ROLE',
		'CREWLY_API_URL',
		'CREWLY_PROJECT_PATH',
		'CREWLY_INSTALL_DIR',
		'CLAUDE_CODE_ENABLE_TELEMETRY',
		'TOKENIZER_PATH',
		'KEYBOARD',
	])('does not treat %s as a secret', (key) => {
		expect(isSecretEnvKey(key)).toBe(false);
	});
});

describe('assertNotSecretEnvKey', () => {
	it('throws for a secret name, naming the variable', () => {
		expect(() => assertNotSecretEnvKey('OPENAI_API_KEY')).toThrow(/OPENAI_API_KEY/);
	});

	it('does not throw for a non-secret name', () => {
		expect(() => assertNotSecretEnvKey('CREWLY_ROLE')).not.toThrow();
	});
});
