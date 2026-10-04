/**
 * Credential guard for the crewly-agent runtime's own tools.
 *
 * Spec: specs/2026-10-04-agent-credential-isolation.md (layer 2). The PTY
 * runtimes get the guard as a pre-tool hook; this runtime's tools are
 * Crewly's own code, so they run the same hook script
 * (`config/hooks/credential-guard/guard.sh`, Claude Code input format)
 * before reading a file or running a command. One matcher for every runtime.
 *
 * The backend passes the script and its paths file in the environment
 * (CREWLY_CREDENTIAL_GUARD_SCRIPT / CREWLY_CREDENTIAL_GUARD_PATHS). Without
 * them, or when the script cannot run, the call is allowed (the guard is a
 * speed bump; the sealed credential files are the main protection).
 *
 * @module runtime/credential-guard
 */

import { spawnSync, type SpawnSyncReturns } from 'child_process';

/** Runs the hook script; injectable for tests. */
export type GuardRunner = (script: string, args: string[], input: string, env: NodeJS.ProcessEnv) => SpawnSyncReturns<string>;

const defaultRunner: GuardRunner = (script, args, input, env) =>
  spawnSync('bash', [script, ...args], { input, env, encoding: 'utf8', timeout: 5_000 });

/**
 * The refusal for a tool call that touches Crewly's credentials, or null
 * when it may run.
 *
 * @param toolName - Claude Code tool name the script understands (Bash, Read, Grep, Glob)
 * @param toolInput - The tool's arguments (command / file_path / path / pattern)
 * @param cwd - Working directory of the call
 * @param env - Environment (defaults to process.env)
 * @param run - Script runner
 * @returns Refusal message, or null
 */
export function checkCredentialAccess(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  run: GuardRunner = defaultRunner,
): string | null {
  const script = env.CREWLY_CREDENTIAL_GUARD_SCRIPT;
  const paths = env.CREWLY_CREDENTIAL_GUARD_PATHS;
  if (!script || !paths) return null;
  let res: SpawnSyncReturns<string>;
  try {
    res = run(script, ['claude', paths], JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd }), env);
  } catch {
    return null;
  }
  if (res.status !== 2) return null;
  const reason = (res.stderr ?? '').trim();
  return reason || "Blocked: this touches Crewly's own credentials. Crewly credentials are not available to agents.";
}
