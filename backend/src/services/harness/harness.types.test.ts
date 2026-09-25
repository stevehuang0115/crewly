/**
 * Tests for the harness type guards.
 */

import { RUNTIME_TYPES } from '../../constants.js';
import {
	HARNESS_IDS,
	LOGIN_METHOD_IDS,
	SILENT_HARNESS_LOGGER,
	isHarnessId,
	isLoginMethodId,
	isTerminalLoginState,
} from './harness.types.js';

describe('harness types', () => {
	it('harness ids equal the matching runtime types', () => {
		expect(HARNESS_IDS).toEqual([RUNTIME_TYPES.CLAUDE_CODE, RUNTIME_TYPES.CODEX_CLI, RUNTIME_TYPES.GEMINI_CLI]);
	});

	it('isHarnessId accepts only known ids', () => {
		expect(isHarnessId('claude-code')).toBe(true);
		expect(isHarnessId('codex-cli')).toBe(true);
		expect(isHarnessId('gemini-cli')).toBe(true);
		expect(isHarnessId('opencode-cli')).toBe(false);
		expect(isHarnessId('claude')).toBe(false);
		expect(isHarnessId(42)).toBe(false);
	});

	it('isLoginMethodId accepts only known methods', () => {
		expect(LOGIN_METHOD_IDS).toEqual(['subscription', 'api_key', 'device']);
		expect(isLoginMethodId('device')).toBe(true);
		expect(isLoginMethodId('password')).toBe(false);
		expect(isLoginMethodId(undefined)).toBe(false);
	});

	it('isTerminalLoginState marks finished states', () => {
		expect(isTerminalLoginState('succeeded')).toBe(true);
		expect(isTerminalLoginState('failed')).toBe(true);
		expect(isTerminalLoginState('timed_out')).toBe(true);
		expect(isTerminalLoginState('cancelled')).toBe(true);
		expect(isTerminalLoginState('starting')).toBe(false);
		expect(isTerminalLoginState('awaiting_user')).toBe(false);
		expect(isTerminalLoginState('verifying')).toBe(false);
	});

	it('the silent logger swallows everything', () => {
		expect(() => {
			SILENT_HARNESS_LOGGER.info('x');
			SILENT_HARNESS_LOGGER.warn('x');
			SILENT_HARNESS_LOGGER.error('x');
			SILENT_HARNESS_LOGGER.debug('x');
		}).not.toThrow();
	});
});
