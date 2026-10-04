/**
 * Keep each Codex agent's shell commands in that agent's own process.
 *
 * Codex 0.157+ runs the TUI against one shared background app server
 * (`codex app-server --listen unix:// --managed-daemon`), started by whichever
 * Codex session on the machine starts first — usually the orchestrator. Tool
 * and shell commands run inside that daemon, so they inherit ITS environment:
 * every Codex agent's skills sent `X-Agent-Session: crewly-orc` and acted as
 * the orchestrator (steamfun-ops, 2026-09-30: Avery's reply-channel 404'd
 * because the orc was not in the room, and her answer was lost).
 *
 * `codex --no-daemon` runs the app server inside the TUI process instead, so
 * commands inherit the PTY's spawn env (CREWLY_SESSION_NAME, CREWLY_ROLE, the
 * API keys …). Login is untouched: every session still reads the same
 * `$CODEX_HOME/auth.json`.
 *
 * @module services/agent/codex-daemon.utils
 */

import * as path from 'path';
import { HARNESS_CONSTANTS } from '../../constants.js';
import { buildHarnessPath, getUserNpmBinDir, resolveExecutable, runCommand } from '../harness/harness-exec.utils.js';
import type { RunCommand } from '../harness/harness.types.js';

const CODEX = HARNESS_CONSTANTS.CODEX;

/** The codex binary as a command word, plus `resume` when present. */
const CODEX_COMMAND_RE = /(?<=^|[\s;&|(])(?:[^\s;&|()=]*\/)?codex(?:\s+resume)?(?=\s|$)/;

/**
 * Add `--no-daemon` to a Codex launch command (`codex …` or `codex resume …`).
 * A command that does not run codex, or already picks its app server
 * (`--no-daemon`, `--remote`), is returned unchanged.
 *
 * @param command - One launch command line
 * @returns The command with the flag right after `codex` / `codex resume`
 *
 * @example
 * withCodexNoDaemon('codex -a never -s danger-full-access')
 * // => 'codex --no-daemon -a never -s danger-full-access'
 */
export function withCodexNoDaemon(command: string): string {
	const tokens = command.split(/\s+/);
	const picksServer = tokens.some((tok) =>
		CODEX.APP_SERVER_SELECT_FLAGS.some((flag) => tok === flag || tok.startsWith(`${flag}=`)),
	);
	if (picksServer) return command;
	// `codex` / `/path/to/codex` as a command word (not `CODEX_HOME=~/.codex`),
	// optionally followed by the `resume` subcommand.
	return command.replace(CODEX_COMMAND_RE, (m) => `${m} ${CODEX.NO_DAEMON_FLAG}`);
}

/** Injectable pieces of the capability check (tests). */
export interface CodexNoDaemonProbeDeps {
	run?: RunCommand;
	/** Finds the codex binary the agent shell would run */
	resolveCodex?: () => string | null;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
}

/**
 * The PATH an agent shell ends up with: the backend's node first (the
 * runtime re-export in the PTY), the user npm prefix, then the harness PATH.
 * The `codex` npm shim is `#!/usr/bin/env node`, so the node on PATH matters.
 *
 * @param env - Base environment
 * @returns PATH string
 */
function agentShellPath(env: NodeJS.ProcessEnv): string {
	const dirs = [path.dirname(process.execPath), getUserNpmBinDir(), buildHarnessPath(env.PATH)];
	return dirs.filter((d, i, a) => d && a.indexOf(d) === i).join(path.delimiter);
}

let cached: { supported: boolean; checkedAt: number } | null = null;

/**
 * Whether the installed Codex has `--no-daemon`. Passing the flag to a Codex
 * that lacks it would stop the agent from starting (clap rejects unknown
 * arguments), so the flag is only added once `codex --help` lists it. A yes is
 * kept for the life of the process; a no is re-checked after
 * NO_DAEMON_PROBE_RETRY_MS in case Codex was upgraded meanwhile.
 *
 * Never throws: a missing or broken codex counts as "no".
 *
 * @param deps - Injectable dependencies
 * @returns True when `codex --help` mentions `--no-daemon`
 */
export async function codexSupportsNoDaemon(deps: CodexNoDaemonProbeDeps = {}): Promise<boolean> {
	const now = deps.now ?? Date.now;
	if (cached && (cached.supported || now() - cached.checkedAt < CODEX.NO_DAEMON_PROBE_RETRY_MS)) {
		return cached.supported;
	}
	const env = deps.env ?? process.env;
	const shellPath = agentShellPath(env);
	const resolveCodex = deps.resolveCodex ?? (() => resolveExecutable('codex', shellPath));
	let supported = false;
	try {
		const binary = resolveCodex();
		if (binary) {
			const result = await (deps.run ?? runCommand)(binary, ['--help'], {
				env: { ...env, PATH: shellPath },
				timeoutMs: CODEX.HELP_PROBE_TIMEOUT_MS,
			});
			supported = result.code === 0 && `${result.stdout}\n${result.stderr}`.includes(CODEX.NO_DAEMON_FLAG);
		}
	} catch {
		supported = false;
	}
	cached = { supported, checkedAt: now() };
	return supported;
}

/** Forget the cached capability check (tests). */
export function resetCodexNoDaemonProbe(): void {
	cached = null;
}

/** Per-flag probe results (same retry rule as the --no-daemon probe). */
const flagProbeCache = new Map<string, { supported: boolean; checkedAt: number }>();

/**
 * Whether the codex binary the agent shell would run lists `flag` in its
 * `--help`. A positive answer is cached for the process; a negative one is
 * re-checked after NO_DAEMON_PROBE_RETRY_MS (an upgrade may add the flag).
 *
 * Used for `--dangerously-bypass-hook-trust`, which the credential guard
 * needs (specs/2026-10-04-agent-credential-isolation.md): a Codex too old to
 * know it would refuse to start if it were passed.
 *
 * @param flag - Flag to look for
 * @param deps - Same injectables as {@link codexSupportsNoDaemon}
 * @returns True when listed
 */
export async function codexSupportsFlag(flag: string, deps: CodexNoDaemonProbeDeps = {}): Promise<boolean> {
	const now = deps.now ?? Date.now;
	const hit = flagProbeCache.get(flag);
	if (hit && (hit.supported || now() - hit.checkedAt < CODEX.NO_DAEMON_PROBE_RETRY_MS)) return hit.supported;
	const env = deps.env ?? process.env;
	const shellPath = agentShellPath(env);
	const resolveCodex = deps.resolveCodex ?? (() => resolveExecutable('codex', shellPath));
	let supported = false;
	try {
		const binary = resolveCodex();
		if (binary) {
			const result = await (deps.run ?? runCommand)(binary, ['--help'], {
				env: { ...env, PATH: shellPath },
				timeoutMs: CODEX.HELP_PROBE_TIMEOUT_MS,
			});
			supported = result.code === 0 && `${result.stdout}\n${result.stderr}`.includes(flag);
		}
	} catch {
		supported = false;
	}
	flagProbeCache.set(flag, { supported, checkedAt: now() });
	return supported;
}

/** Forget every {@link codexSupportsFlag} result (tests). */
export function resetCodexFlagProbes(): void {
	flagProbeCache.clear();
}
