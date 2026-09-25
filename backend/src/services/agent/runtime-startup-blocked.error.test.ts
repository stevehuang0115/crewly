import { RuntimeStartupBlockedError, isRuntimeStartupBlockedError, isRuntimeCliMissing, detectRuntimeCliMissing } from './runtime-startup-blocked.error.js';
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
});

describe('isRuntimeCliMissing', () => {
	it.each([
		['bash', 'bash: claude: command not found'],
		['zsh', 'zsh: command not found: claude'],
		['dash/sh', '/bin/sh: 1: claude: not found'],
	])('recognises the %s wording', (_shell, line) => {
		expect(isRuntimeCliMissing(`node@box:~$ claude --agent x\n${line}\nnode@box:~$ `, 'claude')).toBe(true);
	});

	it('does not fire on the command line itself, on another binary, or on a longer name', () => {
		expect(isRuntimeCliMissing('node@box:~$ claude --agent x\n', 'claude')).toBe(false);
		expect(isRuntimeCliMissing('bash: codex: command not found', 'claude')).toBe(false);
		expect(isRuntimeCliMissing('bash: claude-extra: command not found', 'claude')).toBe(false);
	});
});

describe('detectRuntimeCliMissing', () => {
	it('builds a runtime_not_installed error naming the runtime and the command', () => {
		const err = detectRuntimeCliMissing('bash: gemini: command not found', 'gemini-cli');
		expect(err).toBeInstanceOf(RuntimeStartupBlockedError);
		expect(err?.reason).toBe('runtime_not_installed');
		expect(err?.message).toContain('Gemini CLI (`gemini`) is not installed');
	});

	it('returns null for a runtime without a CLI binary (in-process Crewly Agent)', () => {
		expect(detectRuntimeCliMissing('bash: crewly-agent: command not found', 'crewly-agent')).toBeNull();
	});
});
