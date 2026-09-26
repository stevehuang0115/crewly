import { RuntimeStartupBlockedError, isRuntimeStartupBlockedError } from './runtime-startup-blocked.error.js';
import { CLAUDE_STARTUP_CONSTANTS } from '../../constants.js';

describe('RuntimeStartupBlockedError', () => {
	it('carries the blocked code, the reason and the user-facing message', () => {
		const err = new RuntimeStartupBlockedError('root_user', 'run as a normal user');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('RuntimeStartupBlockedError');
		expect(err.code).toBe(CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE);
		expect(err.reason).toBe('root_user');
		expect(err.message).toBe('run as a normal user');
	});

	it('is recognised by the guard, including a plain Error carrying the code', () => {
		expect(isRuntimeStartupBlockedError(new RuntimeStartupBlockedError('first_run_setup', 'x'))).toBe(true);
		const plain = Object.assign(new Error('x'), { code: CLAUDE_STARTUP_CONSTANTS.BLOCKED_ERROR_CODE });
		expect(isRuntimeStartupBlockedError(plain)).toBe(true);
		expect(isRuntimeStartupBlockedError(new Error('timeout'))).toBe(false);
		expect(isRuntimeStartupBlockedError('RUNTIME_STARTUP_BLOCKED')).toBe(false);
	});

	it('carries the Antigravity reasons (API key required, account login refused, settings unreadable)', () => {
		for (const reason of ['api_key_required', 'account_login_refused', 'settings_unreadable'] as const) {
			const err = new RuntimeStartupBlockedError(reason, 'msg');
			expect(err.reason).toBe(reason);
			expect(isRuntimeStartupBlockedError(err)).toBe(true);
		}
	});
});
