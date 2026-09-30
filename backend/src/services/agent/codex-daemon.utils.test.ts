import { codexSupportsNoDaemon, resetCodexNoDaemonProbe, withCodexNoDaemon } from './codex-daemon.utils.js';
import { HARNESS_CONSTANTS } from '../../constants.js';
import type { CommandResult } from '../harness/harness.types.js';

const HELP_WITH_FLAG = 'Usage: codex [OPTIONS]\n      --no-daemon\n          Run without the shared background server';
const HELP_WITHOUT_FLAG = 'Usage: codex [OPTIONS]\n  -m, --model <MODEL>';

function ok(stdout: string): CommandResult {
	return { code: 0, stdout, stderr: '' };
}

describe('withCodexNoDaemon', () => {
	it('adds --no-daemon right after codex', () => {
		expect(withCodexNoDaemon('codex -a never -s danger-full-access')).toBe('codex --no-daemon -a never -s danger-full-access');
	});

	it('adds it after `codex resume`, before the flags and the id', () => {
		expect(withCodexNoDaemon('codex resume -m gpt-5.6-sol -a never 01a0b5a6')).toBe('codex resume --no-daemon -m gpt-5.6-sol -a never 01a0b5a6');
	});

	it('handles a bare `codex` and an absolute binary path', () => {
		expect(withCodexNoDaemon('codex')).toBe('codex --no-daemon');
		expect(withCodexNoDaemon('/usr/local/bin/codex -a never')).toBe('/usr/local/bin/codex --no-daemon -a never');
	});

	it('does not mistake CODEX_HOME=…/.codex for the binary', () => {
		expect(withCodexNoDaemon('CODEX_HOME=/root/.codex codex -a never')).toBe('CODEX_HOME=/root/.codex codex --no-daemon -a never');
	});

	it('leaves a command that already picks its app server alone', () => {
		expect(withCodexNoDaemon('codex --no-daemon -a never')).toBe('codex --no-daemon -a never');
		expect(withCodexNoDaemon('codex --remote unix:// -a never')).toBe('codex --remote unix:// -a never');
		expect(withCodexNoDaemon('codex --remote=ws://127.0.0.1:9 -a never')).toBe('codex --remote=ws://127.0.0.1:9 -a never');
	});

	it('leaves commands that do not run codex alone', () => {
		expect(withCodexNoDaemon('my-wrapper --fast')).toBe('my-wrapper --fast');
		expect(withCodexNoDaemon('codex-wrapper -a never')).toBe('codex-wrapper -a never');
	});
});

describe('codexSupportsNoDaemon', () => {
	beforeEach(() => resetCodexNoDaemonProbe());

	it('is true when `codex --help` lists --no-daemon', async () => {
		const run = jest.fn().mockResolvedValue(ok(HELP_WITH_FLAG));
		await expect(codexSupportsNoDaemon({ run, resolveCodex: () => '/bin/codex' })).resolves.toBe(true);
		expect(run).toHaveBeenCalledWith('/bin/codex', ['--help'], expect.objectContaining({ timeoutMs: HARNESS_CONSTANTS.CODEX.HELP_PROBE_TIMEOUT_MS }));
	});

	it('is false for an older Codex without the flag, a failing codex, or no codex at all', async () => {
		await expect(codexSupportsNoDaemon({ run: jest.fn().mockResolvedValue(ok(HELP_WITHOUT_FLAG)), resolveCodex: () => '/bin/codex' })).resolves.toBe(false);
		resetCodexNoDaemonProbe();
		await expect(codexSupportsNoDaemon({ run: jest.fn().mockResolvedValue({ code: 1, stdout: HELP_WITH_FLAG, stderr: '' }), resolveCodex: () => '/bin/codex' })).resolves.toBe(false);
		resetCodexNoDaemonProbe();
		const run = jest.fn();
		await expect(codexSupportsNoDaemon({ run, resolveCodex: () => null })).resolves.toBe(false);
		expect(run).not.toHaveBeenCalled();
		resetCodexNoDaemonProbe();
		await expect(codexSupportsNoDaemon({ run: jest.fn().mockRejectedValue(new Error('boom')), resolveCodex: () => '/bin/codex' })).resolves.toBe(false);
	});

	it('keeps a yes for good', async () => {
		const run = jest.fn().mockResolvedValue(ok(HELP_WITH_FLAG));
		let t = 0;
		const deps = { run, resolveCodex: () => '/bin/codex', now: () => t };
		await codexSupportsNoDaemon(deps);
		t += HARNESS_CONSTANTS.CODEX.NO_DAEMON_PROBE_RETRY_MS * 10;
		await expect(codexSupportsNoDaemon(deps)).resolves.toBe(true);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('re-checks a no after the retry interval (Codex may have been upgraded)', async () => {
		const run = jest.fn().mockResolvedValueOnce(ok(HELP_WITHOUT_FLAG)).mockResolvedValueOnce(ok(HELP_WITH_FLAG));
		let t = 0;
		const deps = { run, resolveCodex: () => '/bin/codex', now: () => t };
		await expect(codexSupportsNoDaemon(deps)).resolves.toBe(false);
		t += 1000;
		await expect(codexSupportsNoDaemon(deps)).resolves.toBe(false);
		expect(run).toHaveBeenCalledTimes(1);
		t += HARNESS_CONSTANTS.CODEX.NO_DAEMON_PROBE_RETRY_MS;
		await expect(codexSupportsNoDaemon(deps)).resolves.toBe(true);
		expect(run).toHaveBeenCalledTimes(2);
	});
});
