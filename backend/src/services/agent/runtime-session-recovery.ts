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
 *   - Antigravity CLI resumes with `agy --conversation=<id>` (the command agy
 *     itself prints on exit). It creates a conversation only when the first
 *     prompt arrives, so {@link discoverAntigravityConversationId} learns the
 *     id after the registration kickoff from `conversations/<id>.db` and
 *     `cache/last_conversations.json` (workspace → latest id).
 *
 * @module services/agent/runtime-session-recovery
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ANTIGRAVITY_CONSTANTS, RUNTIME_TYPES, ORC_CONVERSATION_CONSTANTS, FRESH_TASK_CONVERSATION_CONSTANTS } from '../../constants.js';
import { getAntigravityConfigDir } from '../../utils/antigravity-settings.utils.js';
import { resolveProjectSlugCandidatesSync } from '../monitoring/claude-session-tokens.service.js';

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
  /** Informational: whether the persistence layer flagged this as a restored session. */
  isRestored: boolean;
  storedSessionId: string | null | undefined;
  autoResume: boolean;
  /**
   * Whether the stored conversation still exists on disk. `false` forces a
   * fresh start (resuming a deleted conversation would fail to boot);
   * omitted = trust the stored id.
   */
  conversationExists?: boolean;
  newId?: () => string;
}): RuntimeSessionPlan {
  const { runtimeType, isRestored, storedSessionId, autoResume } = args;
  const newId = args.newId ?? randomUUID;
  // A stored id is enough to resume: the "restored session" flag is only
  // set by one boot path and stayed false in the common one, which is why
  // auto-resume never actually fired before 2026-09-18.
  const canResume = autoResume && !!storedSessionId && args.conversationExists !== false;
  void isRestored;

  if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
    if (canResume) {
      return { flags: ['--resume', storedSessionId as string], resumeSessionId: storedSessionId as string, presetSessionId: null, note: 'resuming Claude Code conversation' };
    }
    const id = newId();
    const note = storedSessionId && !autoResume
      ? 'auto-resume disabled; fresh conversation with a preset id'
      : storedSessionId && args.conversationExists === false
        ? 'stored conversation no longer exists; fresh conversation with a preset id'
        : 'fresh Claude Code conversation with a preset id';
    return { flags: ['--session-id', id], resumeSessionId: null, presetSessionId: id, note };
  }
  if (runtimeType === RUNTIME_TYPES.CODEX_CLI) {
    if (canResume) {
      return { flags: [], resumeSessionId: storedSessionId as string, presetSessionId: null, note: 'resuming Codex conversation' };
    }
    return { flags: [], resumeSessionId: null, presetSessionId: null, note: 'fresh Codex conversation; id discovered from the rollout file after launch' };
  }
  if (runtimeType === RUNTIME_TYPES.ANTIGRAVITY_CLI) {
    if (canResume) {
      return {
        flags: [toAntigravityResumeFlag(storedSessionId as string)],
        resumeSessionId: storedSessionId as string,
        presetSessionId: null,
        note: 'resuming Antigravity conversation',
      };
    }
    return { flags: [], resumeSessionId: null, presetSessionId: null, note: 'fresh Antigravity conversation; id discovered after the first prompt' };
  }
  return { flags: [], resumeSessionId: null, presetSessionId: null, note: 'runtime has no resume support' };
}

/**
 * The agy flag that resumes a conversation: `--conversation=<id>`, exactly
 * as agy prints it on exit ("Resume with -c (or command below):").
 *
 * @param conversationId - Antigravity conversation id (a UUID)
 * @returns The flag, with anything but `[A-Za-z0-9-]` removed from the id
 */
export function toAntigravityResumeFlag(conversationId: string): string {
  const safeId = conversationId.replace(/[^A-Za-z0-9-]/g, '');
  return `${ANTIGRAVITY_CONSTANTS.RESUME_FLAG}=${safeId}`;
}

/** Options for {@link discoverAntigravityConversationId}. */
export interface AntigravityDiscoveryOptions {
  /** agy config dir (defaults to ~/.gemini/antigravity-cli) */
  configDir?: string;
  /** The agent's working directory (agy's workspace) */
  cwd: string;
  /** When the launch command was sent */
  notBeforeMs: number;
  /** Ids other sessions already own */
  claimed?: ReadonlySet<string>;
  /**
   * Text only this agent's first prompt contains (its init prompt file
   * name). When a conversation's logs mention it, that conversation wins
   * even if another agent in the same folder started one later.
   */
  marker?: string;
}

/** Largest log file read when looking for the marker. */
const MAX_ANTIGRAVITY_LOG_BYTES = 512 * 1024;

/**
 * Whether one of a conversation's log files mentions the marker.
 *
 * @param configDir - agy config dir
 * @param conversationId - Conversation id
 * @param marker - Text to find
 * @returns True when found
 */
function antigravityLogsMention(configDir: string, conversationId: string, marker: string): boolean {
  const logsDir = path.join(configDir, 'brain', conversationId, '.system_generated', 'logs');
  let files: string[];
  try {
    files = fs.readdirSync(logsDir);
  } catch {
    return false;
  }
  for (const file of files) {
    const full = path.join(logsDir, file);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      const fd = fs.openSync(full, 'r');
      try {
        const length = Math.min(stat.size, MAX_ANTIGRAVITY_LOG_BYTES);
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, 0);
        if (buf.toString('utf8').includes(marker)) return true;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // unreadable log — try the next
    }
  }
  return false;
}

/**
 * The forms a workspace path may take in agy's cache (as given, and with
 * symlinks resolved — macOS `/tmp` is `/private/tmp`).
 *
 * @param cwd - Working directory
 * @returns Candidate keys
 */
function workspaceKeys(cwd: string): string[] {
  const keys = new Set<string>([path.resolve(cwd)]);
  try {
    keys.add(fs.realpathSync(cwd));
  } catch {
    // folder gone — the resolved form is all we have
  }
  return [...keys];
}

/**
 * Find the Antigravity conversation a just-launched agent started.
 *
 * Candidates are `conversations/<id>.db` files created after the launch that
 * no other session has claimed. The one whose logs mention the agent's
 * marker wins; otherwise the id agy recorded as the latest for this
 * workspace in `cache/last_conversations.json` (what `agy -c` resumes) is
 * taken when it is a candidate.
 *
 * @param opts - Config dir, cwd, launch time, claimed ids, marker
 * @returns The conversation id, or null when nothing matches yet
 */
export function discoverAntigravityConversationId(opts: AntigravityDiscoveryOptions): string | null {
  const configDir = opts.configDir ?? getAntigravityConfigDir();
  const conversationsDir = path.join(configDir, ANTIGRAVITY_CONSTANTS.CONVERSATIONS_DIR);
  const ext = ANTIGRAVITY_CONSTANTS.CONVERSATION_FILE_EXT;
  let files: string[];
  try {
    files = fs.readdirSync(conversationsDir).filter((f) => f.endsWith(ext));
  } catch {
    return null;
  }
  const candidates: Array<{ id: string; bornMs: number }> = [];
  for (const file of files) {
    const id = file.slice(0, -ext.length);
    if (opts.claimed?.has(id)) continue;
    try {
      const stat = fs.statSync(path.join(conversationsDir, file));
      const bornMs = stat.birthtimeMs || stat.mtimeMs;
      // Allow a little clock skew between "we typed the command" and the file's birth.
      if (Math.max(bornMs, stat.mtimeMs) < opts.notBeforeMs - 5_000) continue;
      candidates.push({ id, bornMs });
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) return null;

  if (opts.marker) {
    const marked = candidates.filter((c) => antigravityLogsMention(configDir, c.id, opts.marker as string));
    if (marked.length > 0) return marked.sort((a, b) => a.bornMs - b.bornMs)[0].id;
  }

  try {
    const cache = JSON.parse(
      fs.readFileSync(path.join(configDir, ...ANTIGRAVITY_CONSTANTS.LAST_CONVERSATIONS_FILE_SEGMENTS), 'utf8'),
    ) as Record<string, unknown>;
    for (const key of workspaceKeys(opts.cwd)) {
      const id = cache[key];
      if (typeof id === 'string' && candidates.some((c) => c.id === id)) return id;
    }
  } catch {
    // no cache yet
  }
  return null;
}

/**
 * Poll {@link discoverAntigravityConversationId} until a match appears or time runs out.
 *
 * @param opts - Discovery options plus `timeoutMs` / `intervalMs` (defaults from ANTIGRAVITY_CONSTANTS)
 * @returns The conversation id, or null on timeout
 */
export async function waitForAntigravityConversationId(
  opts: AntigravityDiscoveryOptions & { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<string | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? ANTIGRAVITY_CONSTANTS.CONVERSATION_DISCOVERY_TIMEOUT_MS);
  const interval = opts.intervalMs ?? ANTIGRAVITY_CONSTANTS.CONVERSATION_DISCOVERY_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const found = discoverAntigravityConversationId(opts);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
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
  /** When the file was created (birth time; last write where the filesystem records no birth time) */
  bornAtMs: number;
}

/**
 * When a rollout file came into being.
 *
 * Birth time where the filesystem records one; otherwise (Node reports 0 on
 * some Linux filesystems) the last write time. Last write alone is not enough
 * where birth time exists: an older Codex conversation in the same cwd that
 * is still running keeps writing to its rollout after our launch, and must
 * not be mistaken for the one our agent just created.
 *
 * @param stat - The rollout file's stats
 * @returns Creation time in ms since epoch
 */
function rolloutBornAtMs(stat: fs.Stats): number {
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
}

/**
 * Find the Codex conversation that a just-launched agent created: the
 * earliest rollout file under `<codexHome>/sessions/YYYY/MM/DD/` created after
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
      const bornAtMs = rolloutBornAtMs(stat);
      if (bornAtMs < opts.notBeforeMs - 5_000) continue;
      const meta = readSessionMeta(filePath);
      if (!meta) continue;
      if (path.resolve(meta.cwd) !== path.resolve(opts.cwd)) continue;
      if (opts.claimed?.has(meta.sessionId)) continue;
      candidates.push({ sessionId: meta.sessionId, cwd: meta.cwd, filePath, mtimeMs: stat.mtimeMs, bornAtMs });
    }
  }
  // Agents are launched one at a time: the earliest-created unclaimed match is ours.
  candidates.sort((a, b) => a.bornAtMs - b.bornAtMs);
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

/** Longest first line we are willing to read (Codex embeds its base instructions in `session_meta`). */
const MAX_META_LINE_BYTES = 4 * 1024 * 1024;

/** Read a file's first line, chunk by chunk, without loading the rest of it. */
function readFirstLine(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    let total = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (n === 0) break;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, nl)));
        return Buffer.concat(chunks).toString('utf8');
      }
      chunks.push(Buffer.from(chunk.subarray(0, n)));
      position += n;
      total += n;
      if (total > MAX_META_LINE_BYTES) return null;
    }
    return chunks.length ? Buffer.concat(chunks).toString('utf8') : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Parse the `session_meta` line (the first line) of a rollout file. */
function readSessionMeta(filePath: string): { sessionId: string; cwd: string } | null {
  try {
    const firstLine = readFirstLine(filePath);
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: { session_id?: string; id?: string; cwd?: string } };
    if (parsed.type !== 'session_meta' || !parsed.payload) return null;
    const sessionId = parsed.payload.session_id ?? parsed.payload.id;
    const cwd = parsed.payload.cwd;
    if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

/**
 * Whether a stored conversation still exists on disk, so a resume will not
 * fail to boot. Claude Code keeps `~/.claude/projects/<cwd slug>/<id>.jsonl`;
 * Codex keeps `<codexHome>/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`;
 * Antigravity keeps `~/.gemini/antigravity-cli/conversations/<id>.db`.
 *
 * @param args - Runtime, id, the agent's cwd, optional home overrides
 * @returns True when found; true (benefit of the doubt) for unknown runtimes
 */
export function conversationExists(args: {
  runtimeType: string;
  sessionId: string;
  cwd: string;
  claudeHome?: string;
  codexHome?: string;
  antigravityConfigDir?: string;
}): boolean {
  const { runtimeType, sessionId, cwd } = args;
  if (runtimeType === RUNTIME_TYPES.ANTIGRAVITY_CLI) {
    // agy silently starts fresh for an unknown --conversation id, but a
    // deleted one should not be "resumed" (and reported as resumed) either.
    const dir = path.join(args.antigravityConfigDir ?? getAntigravityConfigDir(), ANTIGRAVITY_CONSTANTS.CONVERSATIONS_DIR);
    return fs.existsSync(path.join(dir, `${sessionId}${ANTIGRAVITY_CONSTANTS.CONVERSATION_FILE_EXT}`));
  }
  if (runtimeType === RUNTIME_TYPES.CLAUDE_CODE) {
    return findClaudeTranscript({ sessionId, cwd, claudeHomes: [args.claudeHome ?? defaultClaudeHome()] }) !== null;
  }
  if (runtimeType === RUNTIME_TYPES.CODEX_CLI) {
    const root = path.join(args.codexHome ?? defaultCodexHome(), 'sessions');
    const suffix = `-${sessionId}.jsonl`;
    const stack = [root];
    let visited = 0;
    while (stack.length > 0 && visited < 5000) {
      const dir = stack.pop() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        visited += 1;
        if (e.isDirectory()) stack.push(path.join(dir, e.name));
        else if (e.name.startsWith('rollout-') && e.name.endsWith(suffix)) return true;
      }
    }
    return false;
  }
  return true;
}

/**
 * The default login's Claude home (`~/.claude`).
 *
 * @returns Absolute path
 */
export function defaultClaudeHome(): string {
  return path.join(os.homedir(), '.claude');
}

/**
 * Where Claude Code keeps a conversation's transcript.
 *
 * Claude Code names the project directory after the *resolved* cwd, so an
 * agent whose cwd goes through a symlink (`/tmp` → `/private/tmp` on macOS)
 * has its transcript under the realpath slug. The existing file is returned
 * when there is one (realpath slug first, then the raw slug); otherwise the
 * path Claude Code would write to (the realpath slug).
 *
 * @param args - Conversation id, the agent's cwd, optional Claude home
 *   (an account's config dir for a session on another Claude Code account)
 * @returns Absolute path of `<home>/projects/<cwd slug>/<id>.jsonl`
 */
export function claudeTranscriptPath(args: { sessionId: string; cwd: string; claudeHome?: string }): string {
  const home = args.claudeHome ?? defaultClaudeHome();
  const found = findClaudeTranscript({ sessionId: args.sessionId, cwd: args.cwd, claudeHomes: [home] });
  if (found) return found;
  const [slug] = resolveProjectSlugCandidatesSync(args.cwd);
  return path.join(home, 'projects', slug, `${args.sessionId}.jsonl`);
}

/**
 * Find an existing conversation transcript across several Claude homes and
 * both cwd slugs (realpath first, then raw).
 *
 * A session that switched between the owner's Claude Code accounts can have
 * its stored conversation under either account's config dir, so callers pass
 * the current account's home first and the default `~/.claude` after it.
 *
 * @param args - Conversation id, the agent's cwd, Claude homes in search order
 * @returns Absolute path of the first existing transcript, or null
 *
 * @example
 * ```typescript
 * findClaudeTranscript({ sessionId, cwd: '/tmp/proj', claudeHomes: [accountDir, defaultClaudeHome()] });
 * ```
 */
export function findClaudeTranscript(args: { sessionId: string; cwd: string; claudeHomes: readonly string[] }): string | null {
  const slugs = resolveProjectSlugCandidatesSync(args.cwd);
  for (const home of new Set(args.claudeHomes)) {
    for (const slug of slugs) {
      const candidate = path.join(home, 'projects', slug, `${args.sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The context the conversation's last real turn carried: fresh input plus
 * cache reads plus cache writes. Only the end of the file is read.
 *
 * @param filePath - Transcript path
 * @returns Tokens, or null when unreadable or no turn is found
 */
export function lastTurnContextTokens(filePath: string): number | null {
  let text: string;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - ORC_CONVERSATION_CONSTANTS.TAIL_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { usage?: Record<string, number> } };
      const u = entry.type === 'assistant' ? entry.message?.usage : undefined;
      if (!u) continue;
      const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      // `<synthetic>` bookkeeping entries carry an all-zero usage block.
      if (total > 0) return total;
    } catch {
      // a partial first line from the tail cut, or a malformed one
    }
  }
  return null;
}

/**
 * The plain words at the end of a conversation — what was said to the agent
 * and what it answered, without tool calls or tool output — for the file a
 * fresh conversation starts from.
 *
 * @param filePath - Transcript path
 * @returns Markdown, newest last; empty when nothing readable was found
 */
export function buildHandoverSummary(filePath: string): string {
  let text: string;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - ORC_CONVERSATION_CONSTANTS.TAIL_BYTES);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
  const said: Array<{ who: string; when: string; text: string }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; timestamp?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta) continue;
    const content = entry.message?.content;
    const parts: string[] = [];
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content as Array<{ type?: string; text?: string }>) {
        if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      }
    }
    const joined = parts.join('\n').trim();
    // System reminders and command wrappers are not conversation.
    if (!joined || joined.startsWith('<')) continue;
    const clip = ORC_CONVERSATION_CONSTANTS.HANDOVER_MESSAGE_CHARS;
    said.push({
      who: entry.type === 'user' ? 'Delivered to you' : 'You',
      when: entry.timestamp ?? '',
      text: joined.length > clip ? `${joined.slice(0, clip)}…` : joined,
    });
  }
  const kept = said.slice(-ORC_CONVERSATION_CONSTANTS.HANDOVER_MESSAGES);
  const blocks: string[] = [];
  let total = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    const b = `### ${kept[i].who} — ${kept[i].when}\n${kept[i].text}`;
    if (total + b.length > ORC_CONVERSATION_CONSTANTS.HANDOVER_MAX_CHARS) break;
    blocks.unshift(b);
    total += b.length;
  }
  return blocks.join('\n\n');
}

/**
 * The threshold at which the orchestrator starts a fresh conversation.
 *
 * @param env - Environment (tests)
 * @returns Tokens
 */
export function orcFreshContextTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['CREWLY_ORC_FRESH_CONTEXT_TOKENS']);
  return Number.isFinite(raw) && raw > 0 ? raw : ORC_CONVERSATION_CONSTANTS.FRESH_CONTEXT_TOKENS;
}

/**
 * The threshold at which a team member (not the orchestrator) starts a fresh
 * conversation at launch instead of resuming its old one.
 *
 * @param env - Environment (tests)
 * @returns Tokens
 */
export function memberFreshContextTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['CREWLY_MEMBER_FRESH_CONTEXT_TOKENS']);
  return Number.isFinite(raw) && raw > 0 ? raw : FRESH_TASK_CONVERSATION_CONSTANTS.MEMBER_FRESH_CONTEXT_TOKENS;
}

/** A handover file already written for a session. */
export interface HandoverFileInfo {
  path: string;
  mtimeMs: number;
}

/**
 * The newest handover file written for a session (oldest-conversation
 * handovers, runtime switches and restart handovers all live in the same
 * directory under `<session>-…`).
 *
 * @param dir - Handover directory
 * @param sessionName - Session
 * @param exceptFile - A file to ignore (the one being written now)
 * @returns The newest one, or null
 */
export function latestHandoverFile(dir: string, sessionName: string, exceptFile?: string): HandoverFileInfo | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const prefix = `${sessionName}-`;
  let best: HandoverFileInfo | null = null;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.md')) continue;
    const rest = name.slice(prefix.length);
    if (!/^(runtime-|restart-|\d{4}-\d{2}-\d{2}T)/.test(rest)) continue;
    const full = path.join(dir, name);
    if (exceptFile && path.resolve(full) === path.resolve(exceptFile)) continue;
    try {
      const mtimeMs = fs.statSync(full).mtimeMs;
      if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
    } catch {
      // vanished — skip
    }
  }
  return best;
}

/**
 * Text of an earlier handover to carry into a new one, so a second hop
 * through a runtime whose conversation cannot be read does not lose what the
 * first handover held.
 *
 * @param prev - The earlier handover
 * @returns Block to embed (its path, and its body without the title line), or '' when unreadable
 */
export function chainedHandoverBlock(prev: HandoverFileInfo | null): string {
  if (!prev) return '';
  try {
    const raw = fs.readFileSync(prev.path, 'utf-8');
    const body = raw.replace(/^# [^\n]*\n+/, '').trim();
    const max = ORC_CONVERSATION_CONSTANTS.CHAINED_HANDOVER_MAX_CHARS;
    const clipped = body.length > max ? `${body.slice(0, max)}\n…(clipped; full file above)` : body;
    return [`_Your earlier handover is carried forward below (full file: ${prev.path})._`, '', clipped].join('\n');
  } catch {
    return `_Your earlier handover: ${prev.path}_`;
  }
}

/** A previous Claude Code conversation found for a session. */
export interface PreviousClaudeConversation {
  sessionId: string;
  transcript: string;
  mtimeMs: number;
}

/**
 * The most recent previous Claude Code transcript for a cwd across several
 * Claude homes (default and account), newer than `maxAgeMs`.
 *
 * With `rememberedSessionId` that conversation is looked up directly. Without
 * it every transcript in the cwd's project directory is a candidate (agents of
 * one project share a cwd), so a candidate must be unclaimed by another live
 * session and belong to `sessionName` ({@link transcriptBelongsTo}: its `agentSetting` entry or its first user message names it). The newest such transcript by mtime wins; size never matters.
 *
 * @param args - cwd, homes, session name, window, optional remembered id, ids owned by others
 * @returns The newest match, or null
 */
export function findPreviousClaudeConversation(args: {
  cwd: string;
  claudeHomes: readonly string[];
  sessionName: string;
  maxAgeMs?: number;
  now?: number;
  rememberedSessionId?: string | null;
  /** cwd the remembered conversation was last run in (it can differ from `cwd`) */
  rememberedCwd?: string | null;
  claimedByOthers?: ReadonlySet<string>;
}): PreviousClaudeConversation | null {
  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? ORC_CONVERSATION_CONSTANTS.RESTART_HANDOVER_MAX_AGE_MS;
  if (args.rememberedSessionId) {
    const file =
      findClaudeTranscript({ sessionId: args.rememberedSessionId, cwd: args.cwd, claudeHomes: args.claudeHomes }) ??
      (args.rememberedCwd && args.rememberedCwd !== args.cwd
        ? findClaudeTranscript({ sessionId: args.rememberedSessionId, cwd: args.rememberedCwd, claudeHomes: args.claudeHomes })
        : null);
    if (file) {
      try {
        const mtimeMs = fs.statSync(file).mtimeMs;
        if (now - mtimeMs <= maxAge) return { sessionId: args.rememberedSessionId, transcript: file, mtimeMs };
      } catch {
        // fall through to the cwd-wide search
      }
    }
  }
  let best: PreviousClaudeConversation | null = null;
  for (const home of new Set(args.claudeHomes)) {
    for (const slug of resolveProjectSlugCandidatesSync(args.cwd)) {
      const dir = path.join(home, 'projects', slug);
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (args.claimedByOthers?.has(sessionId)) continue;
        const full = path.join(dir, name);
        let mtimeMs: number;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        if (now - mtimeMs > maxAge || (best && mtimeMs <= best.mtimeMs)) continue;
        if (!transcriptBelongsTo(full, args.sessionName)) continue;
        best = { sessionId, transcript: full, mtimeMs };
      }
    }
  }
  return best;
}

/**
 * Whether a transcript belongs to the named session: Claude Code writes an
 * `agentSetting` entry naming the agent at the top of the conversations it
 * launches, and the session's own kickoff (the first user message) names it.
 * A name that only appears later (a person asking about the agent in their
 * own conversation, or a teammate's report) is not ownership.
 *
 * @param filePath - Transcript
 * @param sessionName - Session name
 * @returns True when the transcript was this session's own conversation
 */
function transcriptBelongsTo(filePath: string, sessionName: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(ORC_CONVERSATION_CONSTANTS.OWNERSHIP_HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const lines = buf.subarray(0, n).toString('utf8').split('\n');
      for (const line of lines) {
        if (line.includes('"agentSetting"')) {
          try {
            const entry = JSON.parse(line) as { agentSetting?: unknown };
            if (entry.agentSetting === sessionName) return true;
          } catch {
            // a cut line
          }
          continue;
        }
        if (line.includes('"type":"user"')) return line.includes(sessionName);
      }
      return false;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Remembered last conversation of a stopped session. */
export interface LastConversationEntry {
  sessionId: string;
  cwd: string;
  at: number;
}

/**
 * Remember a stopped session's conversation id (a stop drops the stored id
 * from session persistence; this is what lets the next start find it).
 *
 * @param file - JSON file
 * @param sessionName - Session
 * @param entry - Conversation id and cwd
 */
export function rememberLastConversation(file: string, sessionName: string, entry: LastConversationEntry): void {
  try {
    let all: Record<string, LastConversationEntry> = {};
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, LastConversationEntry>;
    } catch {
      all = {};
    }
    all[sessionName] = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    // best effort
  }
}

/**
 * Read a stopped session's remembered conversation.
 *
 * @param file - JSON file
 * @param sessionName - Session
 * @returns The entry, or null
 */
export function readLastConversation(file: string, sessionName: string): LastConversationEntry | null {
  try {
    const all = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, LastConversationEntry>;
    const e = all[sessionName];
    return e && typeof e.sessionId === 'string' ? e : null;
  } catch {
    return null;
  }
}

/**
 * The conversation a stopped session should resume on its next start.
 *
 * A stop (idle eviction by ResourceMode, a manual stop) unregisters the
 * session and so drops the stored conversation id; the id is kept in the
 * last-conversations file. A start with no stored id resumes that one, unless
 * it is older than the handover window or another live session owns it.
 *
 * @param args - last-conversations file, session, ids owned by other sessions, clock
 * @returns The remembered entry, or null
 */
export function rememberedConversationToResume(args: {
  file: string;
  sessionName: string;
  claimedByOthers?: ReadonlySet<string>;
  now?: number;
  maxAgeMs?: number;
}): LastConversationEntry | null {
  const entry = readLastConversation(args.file, args.sessionName);
  if (!entry) return null;
  if (args.claimedByOthers?.has(entry.sessionId)) return null;
  const now = args.now ?? Date.now();
  const maxAge = args.maxAgeMs ?? ORC_CONVERSATION_CONSTANTS.RESTART_HANDOVER_MAX_AGE_MS;
  if (typeof entry.at === 'number' && now - entry.at > maxAge) return null;
  return entry;
}

/**
 * For a fresh Claude Code conversation that nobody chose (a stop and start,
 * or a stored conversation that is gone), write a handover from the most
 * recent previous conversation of the session and return the kickoff note
 * that points at it. Nothing is written when there is no conversation newer
 * than a week, when it has nothing readable, or when a handover for the
 * session is already newer than it (the oversized-conversation, per-task and
 * runtime-switch paths write their own).
 *
 * @param args - Session, cwd, Claude homes, handover dir, remembered-conversation file, ids owned by other sessions
 * @returns The handover file, the kickoff note and the previous conversation id, or null
 */
export function writeRestartHandover(args: {
  sessionName: string;
  cwd: string;
  claudeHomes: readonly string[];
  handoverDir: string;
  lastConversationsFile?: string;
  claimedByOthers?: ReadonlySet<string>;
  now?: Date;
}): { file: string; note: string; previousSessionId: string } | null {
  const now = args.now ?? new Date();
  const remembered = args.lastConversationsFile ? readLastConversation(args.lastConversationsFile, args.sessionName) : null;
  const previous = findPreviousClaudeConversation({
    cwd: args.cwd,
    claudeHomes: args.claudeHomes,
    sessionName: args.sessionName,
    now: now.getTime(),
    rememberedSessionId: remembered?.sessionId ?? null,
    rememberedCwd: remembered?.cwd ?? null,
    claimedByOthers: args.claimedByOthers,
  });
  if (!previous) return null;
  const existing = latestHandoverFile(args.handoverDir, args.sessionName);
  if (existing && existing.mtimeMs >= previous.mtimeMs) return null;
  const body = buildHandoverSummary(previous.transcript);
  if (!body) return null;
  fs.mkdirSync(args.handoverDir, { recursive: true });
  const file = path.join(args.handoverDir, `${args.sessionName}-restart-${now.toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(
    file,
    [
      '# Handover: restart',
      '',
      `You were stopped and started again, so this is a fresh conversation. Your previous one (${previous.sessionId}, last active ${new Date(previous.mtimeMs).toISOString()}) is summarised below.`,
      'Everything Crewly tracks — tasks, teams, OKRs, wiki, chat history (search-chat) — is still there; this file keeps only the end of what was said before.',
      `The full transcript: ${previous.transcript}`,
      '',
      body,
      '',
    ].join('\n'),
    'utf-8',
  );
  const note =
    `This is a fresh conversation after a restart: after registering, read ${file} once — it holds the end of your previous conversation. ` +
    'Before saying you cannot find an earlier conversation or request, search chat history with search-chat.';
  return { file, note, previousSessionId: previous.sessionId };
}
