/**
 * Runtime session recovery — make "resume the agent's conversation after a
 * backend restart" deterministic instead of best-effort.
 *
 * Background (2026-09-18): PTY sessions die with the backend. Claude Code
 * and Codex can both resume a conversation by id, but Crewly only knew the
 * id when the agent volunteered it at registration (it rarely did), and
 * agents spawned from inside another Claude Code session inherited that
 * session's markers and stopped saving transcripts altogether — so there
 * was nothing to resume even when the id was known.
 *
 * Three pieces:
 *   - {@link planRuntimeSessionFlags}: Claude Code is launched with a
 *     Crewly-generated `--session-id`, persisted before launch; on restore
 *     the same id goes to `--resume`. Codex has no preset flag, so on
 *     restore its command becomes `codex resume … <id>`.
 *   - {@link discoverCodexSessionId}: Codex writes its rollout file within
 *     seconds of launch; the file name and first line carry the session id
 *     and cwd, which is how Crewly learns the id for a fresh Codex agent.
 *   - {@link stripNestedClaudeSessionEnv}: the env markers a parent Claude
 *     Code session leaves behind, which must never reach an agent.
 *
 * @module services/agent/runtime-session-recovery
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { RUNTIME_TYPES } from '../../constants.js';

/**
 * Env vars set by a running Claude Code session for its children. An agent
 * that inherits them believes it is a nested/child session and disables
 * transcript saving ("Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION"), which makes `--resume` impossible. Only
 * session markers are listed; user configuration such as
 * CLAUDE_CODE_ENABLE_TELEMETRY or CLAUDE_CODE_USE_BEDROCK is left alone.
 */
export const NESTED_CLAUDE_SESSION_ENV_KEYS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
];

/**
 * Remove the nested-session markers from an environment.
 *
 * @param env - Environment to copy from
 * @returns A copy without the markers
 */
export function stripNestedClaudeSessionEnv<T extends Record<string, string | undefined>>(env: T): T {
  const out = { ...env };
  for (const key of NESTED_CLAUDE_SESSION_ENV_KEYS) delete out[key];
  return out;
}

/** What the launcher must do about the runtime's conversation id. */
export interface RuntimeSessionPlan {
  /** CLI flags to inject (Claude Code: `--session-id` or `--resume`). */
  flags: string[];
  /** Id to resume (Codex: rewrite the command to `codex resume … <id>`). */
  resumeSessionId: string | null;
  /** Freshly generated id that must be persisted before launch (Claude Code). */
  presetSessionId: string | null;
  /** One-line reason for the log. */
  note: string;
}

/**
 * Decide how to launch a runtime so that its conversation can be found again.
 *
 * @param args - Runtime type, whether this is a restored session, the stored
 *   id (if any), the auto-resume setting, and an id generator (tests)
 * @returns The plan
 */
export function planRuntimeSessionFlags(args: {
  runtimeType: string;
  isRestored: boolean;
  storedSessionId: string | null | undefined;
  autoResume: boolean;
  newId?: () => string;
}): RuntimeSessionPlan {
  const { runtimeType, isRestored, storedSessionId, autoResume } = args;
  const newId = args.newId ?? randomUUID;
  const canResume = autoResume && isRestored && !!storedSessionId;

  if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
    if (canResume) {
      return { flags: ['--resume', storedSessionId as string], resumeSessionId: storedSessionId as string, presetSessionId: null, note: 'resuming Claude Code conversation' };
    }
    const id = newId();
    return { flags: ['--session-id', id], resumeSessionId: null, presetSessionId: id, note: isRestored && !autoResume ? 'auto-resume disabled; fresh conversation with a preset id' : 'fresh Claude Code conversation with a preset id' };
  }
  if (runtimeType === RUNTIME_TYPES.CODEX_CLI) {
    if (canResume) {
      return { flags: [], resumeSessionId: storedSessionId as string, presetSessionId: null, note: 'resuming Codex conversation' };
    }
    return { flags: [], resumeSessionId: null, presetSessionId: null, note: 'fresh Codex conversation; id discovered from the rollout file after launch' };
  }
  return { flags: [], resumeSessionId: null, presetSessionId: null, note: 'runtime has no resume support' };
}

/**
 * Rewrite a Codex launch command so it resumes a conversation. `codex resume`
 * accepts the same approval/sandbox flags as `codex`, and the id goes last.
 *
 * @param command - The configured command, e.g. `codex -a never -s danger-full-access`
 * @param sessionId - Codex session id
 * @returns The resume command, or the input unchanged when it does not invoke codex
 */
export function toCodexResumeCommand(command: string, sessionId: string): string {
  if (!/\bcodex\b/.test(command) || /\bcodex\s+resume\b/.test(command)) return command;
  const safeId = sessionId.replace(/[^A-Za-z0-9-]/g, '');
  return `${command.replace(/\bcodex\b/, 'codex resume')} ${safeId}`;
}

/** Default Codex home (`CODEX_HOME` or `~/.codex`). */
export function defaultCodexHome(): string {
  return process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex');
}

/** A rollout file's identity, as Crewly needs it. */
export interface CodexRolloutInfo {
  sessionId: string;
  cwd: string;
  filePath: string;
  mtimeMs: number;
}

/**
 * Find the Codex conversation that a just-launched agent created: the newest
 * rollout file under `<codexHome>/sessions/YYYY/MM/DD/` written after
 * `notBeforeMs`, whose `session_meta.cwd` is the agent's cwd, and whose id
 * nobody else has claimed. Only today's and yesterday's directories are read
 * (UTC and local dates), so the scan stays cheap.
 *
 * @param opts - Codex home, the agent's cwd, launch time, ids already claimed
 * @returns The rollout info, or null when nothing matches yet
 */
export function discoverCodexSessionId(opts: {
  codexHome?: string;
  cwd: string;
  notBeforeMs: number;
  claimed?: ReadonlySet<string>;
}): CodexRolloutInfo | null {
  const home = opts.codexHome ?? defaultCodexHome();
  const dirs = recentSessionDirs(home, opts.notBeforeMs);
  const candidates: CodexRolloutInfo[] = [];
  for (const dir of dirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(dir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      // Allow a little clock skew between "we typed the command" and the file's birth.
      if (Math.max(stat.mtimeMs, stat.birthtimeMs || 0) < opts.notBeforeMs - 5_000) continue;
      const meta = readSessionMeta(filePath);
      if (!meta) continue;
      if (path.resolve(meta.cwd) !== path.resolve(opts.cwd)) continue;
      if (opts.claimed?.has(meta.sessionId)) continue;
      candidates.push({ sessionId: meta.sessionId, cwd: meta.cwd, filePath, mtimeMs: stat.mtimeMs });
    }
  }
  // Agents are launched one at a time: the earliest unclaimed match is ours.
  candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return candidates[0] ?? null;
}

/**
 * Poll {@link discoverCodexSessionId} until a match appears or time runs out.
 *
 * @param opts - Discovery options plus `timeoutMs` (default 30 s) and `intervalMs` (default 1 s)
 * @returns The rollout info, or null on timeout
 */
export async function waitForCodexSessionId(
  opts: Parameters<typeof discoverCodexSessionId>[0] & { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<CodexRolloutInfo | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
  const interval = opts.intervalMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const found = discoverCodexSessionId(opts);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/** `<home>/sessions/YYYY/MM/DD` for the launch day and the day before, in UTC and local time. */
function recentSessionDirs(home: string, notBeforeMs: number): string[] {
  const out = new Set<string>();
  for (const offsetDays of [0, 1]) {
    const t = new Date(notBeforeMs - offsetDays * 86_400_000);
    const utc = `${t.getUTCFullYear()}/${pad(t.getUTCMonth() + 1)}/${pad(t.getUTCDate())}`;
    const local = `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;
    out.add(path.join(home, 'sessions', utc));
    out.add(path.join(home, 'sessions', local));
  }
  return [...out];
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Parse the `session_meta` line (the first line) of a rollout file. */
function readSessionMeta(filePath: string): { sessionId: string; cwd: string } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.toString('utf8', 0, n).split('\n')[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: { session_id?: string; id?: string; cwd?: string } };
    if (parsed.type !== 'session_meta' || !parsed.payload) return null;
    const sessionId = parsed.payload.session_id ?? parsed.payload.id;
    const cwd = parsed.payload.cwd;
    if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null;
    return { sessionId, cwd };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
