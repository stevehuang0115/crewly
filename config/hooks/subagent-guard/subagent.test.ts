import { spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Tests for the subagent guard hook (#852, specs/2026-10-03-subagent-guard.md).
 *
 * Each test runs the real script with a Claude Code hook payload on stdin,
 * against a temp directory laid out the way Claude Code stores transcripts:
 *   <project>/<session>.jsonl                       (parent)
 *   <project>/<session>/subagents/agent-<id>.jsonl  (subagent)
 */

const HOOK = join(__dirname, 'subagent.sh');
const SESSION = '18e05f4d-4d45-558b-a8fd-46e00f293a72';

let root: string;
let parentTranscript: string;
let subagentsDir: string;
let crewlyHome: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'subagent-guard-'));
	parentTranscript = join(root, 'project', `${SESSION}.jsonl`);
	subagentsDir = join(root, 'project', SESSION, 'subagents');
	crewlyHome = join(root, 'crewly-home');
	mkdirSync(subagentsDir, { recursive: true });
	writeFileSync(parentTranscript, '');
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/**
 * Run the hook with a payload on stdin.
 *
 * @param payload - Hook JSON (object is serialised; a string is sent as-is)
 * @param env - Extra environment
 * @returns Exit status and stdout
 */
function runHook(payload: unknown, env: Record<string, string> = {}): { status: number | null; stdout: string } {
	const r = spawnSync('bash', [HOOK], {
		input: typeof payload === 'string' ? payload : JSON.stringify(payload),
		// No session by default: a test run inside an agent shell must never post to a live backend.
		env: { ...process.env, CREWLY_HOME: crewlyHome, CREWLY_SUBAGENT_GUARD: '', CREWLY_SESSION_NAME: '', ...env },
		encoding: 'utf-8',
	});
	return { status: r.status, stdout: r.stdout };
}

/**
 * Write a subagent transcript with the given number of tool calls.
 *
 * @param agentId - Subagent id
 * @param toolUses - Number of tool_use blocks to include
 */
function writeSubagentTranscript(agentId: string, toolUses: number): void {
	const lines: string[] = [
		JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the four bugs in the worktree.' } }),
	];
	for (let i = 0; i < toolUses; i++) {
		lines.push(JSON.stringify({
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'git status' } }] },
		}));
	}
	// A text mention of tool_use is not a tool call.
	lines.push(JSON.stringify({
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text: "I've dispatched a fork to do it (no tool_use needed). I'll wait for its report." }] },
	}));
	writeFileSync(join(subagentsDir, `agent-${agentId}.jsonl`), `${lines.join('\n')}\n`);
}

/** A SubagentStop payload for the given agent. */
function stopPayload(agentId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		session_id: SESSION,
		transcript_path: parentTranscript,
		cwd: root,
		hook_event_name: 'SubagentStop',
		agent_id: agentId,
		agent_type: 'fork',
		last_assistant_message: "I've dispatched a research fork. I'll wait for its report.",
		...extra,
	};
}

describe('subagent guard hook (#852)', () => {
	describe('SubagentStart', () => {
		it('injects the subagent rules as additionalContext', () => {
			const { status, stdout } = runHook({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'fork' });
			expect(status).toBe(0);
			const out = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
			expect(out.hookSpecificOutput.hookEventName).toBe('SubagentStart');
			expect(out.hookSpecificOutput.additionalContext).toContain('Do not run report-status, complete-task');
			expect(out.hookSpecificOutput.additionalContext).toContain('Do the assigned work yourself');
		});
	});

	describe('SubagentStop', () => {
		it('sends back a subagent that made no tool call (the silent no-op)', () => {
			writeSubagentTranscript('a0', 0);
			const { status, stdout } = runHook(stopPayload('a0'));
			expect(status).toBe(0);
			const out = JSON.parse(stdout) as { decision: string; reason: string };
			expect(out.decision).toBe('block');
			expect(out.reason).toContain('without having made a single tool call');
		});

		it('sends it back only once: the next stop goes through, so it cannot loop', () => {
			writeSubagentTranscript('a0', 0);
			expect(runHook(stopPayload('a0')).stdout).toContain('"block"');
			expect(runHook(stopPayload('a0'))).toEqual({ status: 0, stdout: '' });
		});

		it('allows a stop when Claude Code says a stop hook is already active', () => {
			writeSubagentTranscript('a0', 0);
			expect(runHook(stopPayload('a0', { stop_hook_active: true }))).toEqual({ status: 0, stdout: '' });
		});

		it('allows a subagent that did make tool calls', () => {
			writeSubagentTranscript('a3', 3);
			expect(runHook(stopPayload('a3'))).toEqual({ status: 0, stdout: '' });
			expect(existsSync(join(crewlyHome, 'runtime', 'subagent-guard', 'a3.nudged'))).toBe(false);
		});

		it('fails open when the subagent transcript cannot be found', () => {
			expect(runHook(stopPayload('missing'))).toEqual({ status: 0, stdout: '' });
		});

		it('ignores an agent id that is not a plain identifier (no path tricks)', () => {
			writeSubagentTranscript('a0', 0);
			expect(runHook(stopPayload('../../a0'))).toEqual({ status: 0, stdout: '' });
		});

		it('does nothing when the kill switch is 0', () => {
			writeSubagentTranscript('a0', 0);
			expect(runHook(stopPayload('a0'), { CREWLY_SUBAGENT_GUARD: '0' })).toEqual({ status: 0, stdout: '' });
			expect(runHook({ hook_event_name: 'SubagentStart' }, { CREWLY_SUBAGENT_GUARD: '0' })).toEqual({ status: 0, stdout: '' });
		});
	});

	describe('trace report (#984)', () => {
		/** A fake `curl` first on PATH that logs its arguments. */
		const fakeCurl = (): { env: Record<string, string>; log: string } => {
			const bin = join(root, 'bin');
			const log = join(root, 'curl.log');
			mkdirSync(bin, { recursive: true });
			writeFileSync(join(bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\n`);
			chmodSync(join(bin, 'curl'), 0o755);
			return { env: { PATH: `${bin}:${process.env.PATH ?? ''}`, CREWLY_SESSION_NAME: 'crewly-dev-1', CREWLY_API_URL: 'http://127.0.0.1:9' }, log };
		};

		it('does not wait for the backend: a slow post leaves the stop immediate', () => {
			writeSubagentTranscript('a0', 0);
			const { env } = fakeCurl();
			const bin = join(root, 'bin');
			writeFileSync(join(bin, 'curl'), '#!/bin/sh\nsleep 3\n');
			const started = Date.now();
			const { stdout } = runHook(stopPayload('a0'), env);
			expect(JSON.parse(stdout).decision).toBe('block');
			expect(Date.now() - started).toBeLessThan(2500);
		});

		it('tells the backend when it sends a subagent back, with the session and a fixed event only', () => {
			writeSubagentTranscript('a0', 0);
			const { env, log } = fakeCurl();
			const { stdout } = runHook(stopPayload('a0'), env);
			expect(JSON.parse(stdout).decision).toBe('block');
			// The post runs in the background; wait for the fake curl to have written.
			const until = Date.now() + 5000;
			while (!existsSync(log) && Date.now() < until) spawnSync('sleep', ['0.05']);
			const args = readFileSync(log, 'utf-8');
			expect(args).toContain('http://127.0.0.1:9/api/agent-hooks');
			expect(args).toContain('X-Agent-Session: crewly-dev-1');
			expect(args).toContain('{"event":"SubagentSendBack"}');
			expect(args).not.toContain('dispatched');
		});

		it('posts nothing when the stop is allowed or there is no session', () => {
			writeSubagentTranscript('a3', 3);
			const { env, log } = fakeCurl();
			runHook(stopPayload('a3'), env);
			writeSubagentTranscript('a0', 0);
			runHook(stopPayload('a0'), { ...env, CREWLY_SESSION_NAME: '' });
			spawnSync('sleep', ['0.3']);
			expect(existsSync(log)).toBe(false);
		});
	});

	it('ignores other events and input that is not JSON', () => {
		expect(runHook({ hook_event_name: 'Stop' })).toEqual({ status: 0, stdout: '' });
		expect(runHook('not json')).toEqual({ status: 0, stdout: '' });
	});
});
