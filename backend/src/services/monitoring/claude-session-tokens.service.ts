/**
 * Claude Session Token Reader
 *
 * Reads per-turn token usage from Claude Code's session JSONL files.
 * Claude Code stores conversations at:
 *   ~/.claude/projects/{path-slug}/{sessionId}.jsonl
 *
 * Each assistant message includes an API `usage` object with exact
 * token counts (input_tokens, output_tokens, cache tokens).
 *
 * Used as the primary token source for claude-code agents because
 * Claude Code's TUI status bar is not capturable from PTY scrollback.
 *
 * @module services/monitoring/claude-session-tokens
 */

import { promises as fs } from 'fs';
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
 * Returns the path to a Claude Code session JSONL file.
 *
 * @param projectPath - The agent's working directory
 * @param sessionId - Claude Code conversation UUID
 * @returns Absolute path to the .jsonl file
 */
export function getSessionJsonlPath(projectPath: string, sessionId: string): string {
  const slug = encodeProjectSlug(projectPath);
  return path.join(os.homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

/**
 * Finds the most recently modified .jsonl session file in a Claude Code
 * project directory. Used as a fallback when the session ID is not known
 * (e.g. the orchestrator session, which may not have been persisted yet).
 *
 * @param projectPath - The agent's working directory
 * @returns The session UUID, or null if no JSONL files found
 */
export async function findLatestSessionId(projectPath: string): Promise<string | null> {
  const slug = encodeProjectSlug(projectPath);
  const dir = path.join(os.homedir(), '.claude', 'projects', slug);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }

  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
  if (jsonlFiles.length === 0) return null;

  let latestFile = '';
  let latestMtime = 0;
  for (const file of jsonlFiles) {
    try {
      const stat = await fs.stat(path.join(dir, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    } catch {
      continue;
    }
  }

  return latestFile ? latestFile.replace('.jsonl', '') : null;
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
 * @returns Aggregated token summary, or null if the file doesn't exist
 */
export async function getTokensSince(
  projectPath: string,
  sessionId: string | null,
  since: Date,
  until?: Date,
): Promise<SessionTokenSummary | null> {
  // Auto-detect session if not provided
  const resolvedId = sessionId || await findLatestSessionId(projectPath);
  if (!resolvedId) {
    logger.debug('No Claude session ID found', { projectPath });
    return null;
  }
  const filePath = getSessionJsonlPath(projectPath, resolvedId);

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

  const slug = encodeProjectSlug(projectPath);
  const dir = path.join(os.homedir(), '.claude', 'projects', slug);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    logger.debug('No Claude projects directory found', { dir });
    return 0;
  }

  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let loaded = 0;

  for (const file of jsonlFiles) {
    const filePath = path.join(dir, file);
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
        const sessionId = file.replace('.jsonl', '');
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
