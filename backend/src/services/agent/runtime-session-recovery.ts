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
import { ANTIGRAVITY_CONSTANTS, RUNTIME_TYPES, ORC_CONVERSATION_CONSTANTS } from '../../constants.js';
import { getAntigravityConfigDir } from '../../utils/antigravity-settings.utils.js';

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
    const home = args.claudeHome ?? path.join(os.homedir(), '.claude');
    const slug = path.resolve(cwd).replace(/[\/.]/g, '-');
    return fs.existsSync(path.join(home, 'projects', slug, `${sessionId}.jsonl`));
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
 * Where Claude Code keeps a conversation's transcript.
 *
 * @param args - Conversation id, the agent's cwd, optional Claude home
 * @returns Absolute path of `<home>/projects/<cwd slug>/<id>.jsonl`
 */
export function claudeTranscriptPath(args: { sessionId: string; cwd: string; claudeHome?: string }): string {
  const home = args.claudeHome ?? path.join(os.homedir(), '.claude');
  const slug = path.resolve(args.cwd).replace(/[\/.]/g, '-');
  return path.join(home, 'projects', slug, `${args.sessionId}.jsonl`);
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
