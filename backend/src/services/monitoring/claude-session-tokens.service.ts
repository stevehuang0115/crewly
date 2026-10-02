/**
 * Claude Session Token Reader
 *
 * Reads per-turn token usage from Claude Code's session JSONL files.
 * Claude Code stores conversations at:
 *   ~/.claude/projects/{path-slug}/{sessionId}.jsonl
 * or, for a session that runs on another of the owner's Claude Code accounts
 * (issue #942, `CLAUDE_CONFIG_DIR` set to the account's config dir):
 *   <account config dir>/projects/{path-slug}/{sessionId}.jsonl
 *
 * Each assistant message includes an API `usage` object with exact
 * token counts (input_tokens, output_tokens, cache tokens).
 *
 * Used as the primary token source for claude-code agents because
 * Claude Code's TUI status bar is not capturable from PTY scrollback.
 *
 * @module services/monitoring/claude-session-tokens
 */

import { promises as fs, realpathSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LoggerService } from '../core/logger.service.js';
/**
 * Cache-aware cost rates for Claude models (USD per token).
 * Cache reads are ~10% of input price; cache writes are ~125% of input price.
 */
const CLAUDE_COST_RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-6': { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  'claude-opus-4-20250514': { input: 0.000015, output: 0.000075, cacheRead: 0.0000015, cacheWrite: 0.00001875 },
  'claude-sonnet-4-6': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  'claude-sonnet-4-20250514': { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
  'claude-haiku-4-20250506': { input: 0.00000025, output: 0.00000125, cacheRead: 0.000000025, cacheWrite: 0.0000003125 },
  default: { input: 0.000003, output: 0.000015, cacheRead: 0.0000003, cacheWrite: 0.00000375 },
};

/**
 * Calculates cost with proper cache-aware pricing for Claude models.
 */
function calculateClaudeCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreateTokens: number,
  model: string,
): number {
  const rates = CLAUDE_COST_RATES[model] || CLAUDE_COST_RATES.default;
  return (
    inputTokens * rates.input +
    outputTokens * rates.output +
    cacheReadTokens * rates.cacheRead +
    cacheCreateTokens * rates.cacheWrite
  );
}

/** Aggregated token usage for a time window. */
export interface SessionTokenSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: number;
  model: string;
  turnCount: number;
}

/** Claude Code's per-user state directory, under the home directory. */
const CLAUDE_DIR_NAME = '.claude';
/** Subdirectory of {@link CLAUDE_DIR_NAME} holding one directory per project slug. */
const CLAUDE_PROJECTS_DIR_NAME = 'projects';
/** File extension of Claude Code conversation transcripts. */
const JSONL_EXTENSION = '.jsonl';

const logger = LoggerService.getInstance().createComponentLogger('ClaudeSessionTokens');

/**
 * Encodes an absolute path into the slug format used by Claude Code
 * for its projects directory. Replaces `/` with `-`.
 *
 * @param projectPath - Absolute path (e.g. /Users/alice/.crewly)
 * @returns Encoded slug (e.g. -Users-alice--crewly)
 */
export function encodeProjectSlug(projectPath: string): string {
  // Claude Code replaces both / and . with - in its project directory slug
  return projectPath.replace(/[/.]/g, '-');
}

/**
 * Builds the ordered, de-duplicated list of Claude Code project slugs that may
 * hold transcripts for a working directory.
 *
 * Claude Code names its project directory after the *resolved* cwd (it sees
 * `process.cwd()`, which the OS has already run through any symlinks). On
 * macOS `/tmp` and `/var` are symlinks into `/private`, so an agent launched
 * in `/tmp/proj` writes to `-private-tmp-proj`, not `-tmp-proj` (#938).
 *
 * The realpath slug comes first because that is where Claude Code writes. The
 * raw slug is kept as a fallback for a cwd that cannot be resolved (deleted,
 * permission denied) and for transcripts written before a directory was moved
 * behind a symlink. Resolution failures never throw.
 *
 * @param projectPath - The agent's working directory, as Crewly recorded it
 * @returns Slugs to try, most likely first; never empty
 *
 * @example
 * ```typescript
 * await resolveProjectSlugCandidates('/tmp/proj');
 * // macOS: ['-private-tmp-proj', '-tmp-proj']; Linux: ['-tmp-proj']
 * ```
 */
export async function resolveProjectSlugCandidates(projectPath: string): Promise<string[]> {
  const rawSlug = encodeProjectSlug(projectPath);
  let resolvedSlug: string | null = null;
  try {
    resolvedSlug = encodeProjectSlug(await fs.realpath(projectPath));
  } catch {
    // Nonexistent or unreadable cwd — the raw slug is the only guess left.
  }
  return resolvedSlug && resolvedSlug !== rawSlug ? [resolvedSlug, rawSlug] : [rawSlug];
}

/**
 * Synchronous {@link resolveProjectSlugCandidates}, for callers that cannot
 * await (launch-time resume checks).
 *
 * The raw slug is taken from the absolute (`path.resolve`d) cwd.
 *
 * @param projectPath - The agent's working directory
 * @returns Slugs to try, realpath slug first; never empty
 *
 * @example
 * ```typescript
 * resolveProjectSlugCandidatesSync('/tmp/proj');
 * // macOS: ['-private-tmp-proj', '-tmp-proj']
 * ```
 */
export function resolveProjectSlugCandidatesSync(projectPath: string): string[] {
  const absolute = path.resolve(projectPath);
  const rawSlug = encodeProjectSlug(absolute);
  let resolvedSlug: string | null = null;
  try {
    resolvedSlug = encodeProjectSlug(realpathSync(absolute));
  } catch {
    // Nonexistent or unreadable cwd — the raw slug is the only guess left.
  }
  return resolvedSlug && resolvedSlug !== rawSlug ? [resolvedSlug, rawSlug] : [rawSlug];
}

/**
 * The `projects/` directories Claude Code may have written a session's
 * transcripts to, most likely first.
 *
 * A session on another of the owner's Claude Code accounts (issue #942) runs
 * with `CLAUDE_CONFIG_DIR` set to that account's config dir, so its
 * transcripts land in `<config dir>/projects/`. The default login's
 * `~/.claude/projects/` is always included last: a session that switched
 * accounts during the day has transcripts in both.
 *
 * @param homeDir - Home directory that contains `.claude/`
 * @param configDirs - Claude config dirs of the session's accounts (current account first)
 * @returns Absolute `projects/` directory paths, de-duplicated
 *
 * @example
 * ```typescript
 * claudeProjectsRoots('/Users/a', ['/Users/a/.crewly/claude-accounts/work']);
 * // ['/Users/a/.crewly/claude-accounts/work/projects', '/Users/a/.claude/projects']
 * ```
 */
export function claudeProjectsRoots(homeDir: string, configDirs: readonly string[] = []): string[] {
  const roots = [
    ...configDirs.map((dir) => path.join(dir, CLAUDE_PROJECTS_DIR_NAME)),
    path.join(homeDir, CLAUDE_DIR_NAME, CLAUDE_PROJECTS_DIR_NAME),
  ];
  return [...new Set(roots)];
}

/**
 * Lists the Claude Code project directories that may hold transcripts for a
 * working directory: every root of {@link claudeProjectsRoots}, each with the
 * slugs of {@link resolveProjectSlugCandidates}. The directories are not
 * required to exist.
 *
 * @param projectPath - The agent's working directory
 * @param homeDir - Home directory that contains `.claude/` (defaults to the OS home)
 * @param configDirs - Config dirs of the owner's other Claude Code accounts the session runs on (searched first)
 * @returns Absolute candidate directory paths, most likely first
 */
export async function resolveProjectDirCandidates(
  projectPath: string,
  homeDir: string = os.homedir(),
  configDirs: readonly string[] = [],
): Promise<string[]> {
  const slugs = await resolveProjectSlugCandidates(projectPath);
  return claudeProjectsRoots(homeDir, configDirs).flatMap((root) => slugs.map((slug) => path.join(root, slug)));
}

/**
 * Locates a known conversation's transcript across all candidate project
 * directories, returning the first one that exists.
 *
 * @param projectPath - The agent's working directory
 * @param sessionId - Claude Code conversation UUID
 * @param homeDir - Home directory that contains `.claude/` (defaults to the OS home)
 * @param configDirs - Config dirs of the owner's other Claude Code accounts (searched first)
 * @returns Absolute path to the existing .jsonl file, or null if none exists
 */
export async function findSessionJsonlPath(
  projectPath: string,
  sessionId: string,
  homeDir: string = os.homedir(),
  configDirs: readonly string[] = [],
): Promise<string | null> {
  for (const dir of await resolveProjectDirCandidates(projectPath, homeDir, configDirs)) {
    const candidate = path.join(dir, `${sessionId}${JSONL_EXTENSION}`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Lists every transcript file across all candidate project directories.
 *
 * Merges rather than stopping at the first existing directory: if both the
 * resolved and the raw slug directories exist, the live conversation may be in
 * either, and picking a directory by existence alone could lock onto a stale
 * one. A file name seen in an earlier (more likely) directory shadows the same
 * name in a later one, so a conversation is never listed twice.
 *
 * @param projectPath - The agent's working directory
 * @param homeDir - Home directory that contains `.claude/` (defaults to the OS home)
 * @param configDirs - Config dirs of the owner's other Claude Code accounts (searched first)
 * @returns Absolute paths of all .jsonl files found, grouped by candidate directory order
 */
export async function listProjectTranscripts(
  projectPath: string,
  homeDir: string = os.homedir(),
  configDirs: readonly string[] = [],
): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of await resolveProjectDirCandidates(projectPath, homeDir, configDirs)) {
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(JSONL_EXTENSION) || seen.has(file)) continue;
      seen.add(file);
      result.push(path.join(dir, file));
    }
  }
  return result;
}

/**
 * Finds the most recently modified transcript across all candidate project
 * directories for a working directory.
 *
 * @param projectPath - The agent's working directory
 * @param homeDir - Home directory that contains `.claude/` (defaults to the OS home)
 * @param configDirs - Config dirs of the owner's other Claude Code accounts (searched too)
 * @returns Absolute path of the newest .jsonl file, or null if there is none
 */
export async function findLatestSessionFile(
  projectPath: string,
  homeDir: string = os.homedir(),
  configDirs: readonly string[] = [],
): Promise<string | null> {
  let latestFile: string | null = null;
  let latestMtime = -1;
  for (const file of await listProjectTranscripts(projectPath, homeDir, configDirs)) {
    try {
      const { mtimeMs } = await fs.stat(file);
      if (mtimeMs > latestMtime) {
        latestMtime = mtimeMs;
        latestFile = file;
      }
    } catch {
      continue;
    }
  }
  return latestFile;
}

/**
 * Returns the path to a Claude Code session JSONL file under the *raw* cwd
 * slug. Does not resolve symlinks — prefer {@link findSessionJsonlPath},
 * which also checks the realpath slug Claude Code actually writes to.
 *
 * @param projectPath - The agent's working directory
 * @param sessionId - Claude Code conversation UUID
 * @returns Absolute path to the .jsonl file
 */
export function getSessionJsonlPath(projectPath: string, sessionId: string): string {
  const slug = encodeProjectSlug(projectPath);
  return path.join(os.homedir(), CLAUDE_DIR_NAME, CLAUDE_PROJECTS_DIR_NAME, slug, `${sessionId}${JSONL_EXTENSION}`);
}

/**
 * Finds the most recently modified .jsonl session file in a Claude Code
 * project directory. Used as a fallback when the session ID is not known
 * (e.g. the orchestrator session, which may not have been persisted yet).
 * Checks both the realpath and the raw cwd slug directories.
 *
 * @param projectPath - The agent's working directory
 * @returns The session UUID, or null if no JSONL files found
 */
export async function findLatestSessionId(projectPath: string): Promise<string | null> {
  const latest = await findLatestSessionFile(projectPath);
  return latest ? path.basename(latest, JSONL_EXTENSION) : null;
}

/**
 * Reads token usage from a Claude Code session JSONL, summing all
 * assistant turns whose timestamp is at or after `since`.
 *
 * Reads the file from the end backwards for efficiency — recent
 * entries are at the tail.
 *
 * @param projectPath - The agent's working directory
 * @param sessionId - Claude Code conversation UUID (if null, auto-detects latest)
 * @param since - Only count turns at or after this time
 * @param until - Only count turns before this time (defaults to now)
 * @param configDirs - Config dirs of the owner's other Claude Code accounts the session runs on
 * @returns Aggregated token summary, or null if the file doesn't exist
 */
export async function getTokensSince(
  projectPath: string,
  sessionId: string | null,
  since: Date,
  until?: Date,
  configDirs: readonly string[] = [],
): Promise<SessionTokenSummary | null> {
  // Auto-detect session if not provided
  const filePath = sessionId
    ? await findSessionJsonlPath(projectPath, sessionId, os.homedir(), configDirs)
    : await findLatestSessionFile(projectPath, os.homedir(), configDirs);
  if (!filePath) {
    logger.debug('No Claude session JSONL found', { projectPath, sessionId });
    return null;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    logger.debug('Session JSONL not found', { filePath });
    return null;
  }

  const sinceMs = since.getTime();
  const untilMs = until ? until.getTime() : Infinity;
  const summary: SessionTokenSummary = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    cost: 0,
    model: '',
    turnCount: 0,
  };

  // Parse lines from the end — most recent entries are last
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Only assistant messages carry usage data
    if (entry.type !== 'assistant') continue;

    const ts = entry.timestamp;
    if (!ts) continue;

    // Timestamp can be ISO string or epoch ms
    const entryMs = typeof ts === 'number' ? ts : new Date(ts as string).getTime();
    if (isNaN(entryMs)) continue;

    // Stop scanning once we're before the window — entries are chronological
    if (entryMs < sinceMs) break;

    // Skip entries after the upper bound
    if (entryMs > untilMs) continue;

    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const usage = msg.usage as Record<string, number> | undefined;
    if (!usage) continue;

    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;
    const model = (msg.model as string) || '';

    summary.inputTokens += inputTokens + cacheRead + cacheCreate;
    summary.outputTokens += outputTokens;
    summary.cacheReadTokens += cacheRead;
    summary.cacheCreateTokens += cacheCreate;
    summary.cost += calculateClaudeCost(inputTokens, outputTokens, cacheRead, cacheCreate, model);
    summary.turnCount += 1;
    if (!summary.model && model) summary.model = model;
  }

  return summary;
}

/**
 * Scans all Claude Code session JSONL files for a project and feeds
 * aggregated per-session token data into TokenUsageService.
 *
 * This bridges the gap between Claude Code's file-based token tracking
 * and the in-memory TokenUsageService that powers the Usage dashboard.
 * Should be called once during server startup.
 *
 * Only processes sessions modified in the last `maxAgeDays` to avoid
 * scanning hundreds of old session files.
 *
 * @param projectPath - The project's working directory
 * @param maxAgeDays - Only process sessions modified within this many days (default: 7)
 * @returns Number of sessions loaded
 */
export async function syncSessionsToTokenUsageService(
  projectPath: string,
  maxAgeDays = 7,
): Promise<number> {
  const { TokenUsageService } = await import('./token-usage.service.js');
  const tokenSvc = TokenUsageService.getInstance();

  const jsonlFiles = await listProjectTranscripts(projectPath);
  if (jsonlFiles.length === 0) {
    logger.debug('No Claude transcripts found for project', { projectPath });
    return 0;
  }
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let loaded = 0;

  for (const filePath of jsonlFiles) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoffMs) continue;

      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');

      let sessionInput = 0;
      let sessionOutput = 0;
      let sessionCacheRead = 0;
      let sessionCacheCreate = 0;
      let model = '';
      let turnCount = 0;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.type !== 'assistant') continue;
          const msg = entry.message;
          if (!msg?.usage) continue;

          const u = msg.usage;
          sessionInput += u.input_tokens || 0;
          sessionOutput += u.output_tokens || 0;
          sessionCacheRead += u.cache_read_input_tokens || 0;
          sessionCacheCreate += u.cache_creation_input_tokens || 0;
          if (!model && msg.model) model = msg.model;
          turnCount++;
        } catch {
          continue;
        }
      }

      if (turnCount > 0) {
        const sessionId = path.basename(filePath, JSONL_EXTENSION);
        const resolvedModel = model || 'claude-sonnet-4-6';

        // Calculate cost with proper cache-aware pricing
        const cost = calculateClaudeCost(
          sessionInput, sessionOutput,
          sessionCacheRead, sessionCacheCreate,
          resolvedModel,
        );

        // Record only real input tokens (not cache) to avoid inflating counts.
        // Pass pre-calculated cost via a dedicated method if available,
        // otherwise record raw tokens and let the dashboard use our cost.
        tokenSvc.recordUsage(
          sessionId,
          sessionId,
          sessionInput,
          sessionOutput,
          resolvedModel,
        );

        // Override the auto-calculated cost with our cache-aware cost
        tokenSvc.overrideSessionCost(sessionId, cost);
        loaded++;
      }
    } catch {
      continue;
    }
  }

  logger.info('Synced Claude Code sessions to TokenUsageService', {
    projectPath,
    scannedFiles: jsonlFiles.length,
    loadedSessions: loaded,
    maxAgeDays,
  });

  return loaded;
}
