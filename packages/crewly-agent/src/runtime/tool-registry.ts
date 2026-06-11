/**
 * Crewly Agent Tool Registry
 *
 * Defines all AI SDK tools available to the Crewly Agent runtime.
 * Each tool maps to a Crewly REST API endpoint, replacing the bash
 * skill scripts used by PTY-based runtimes.
 *
 * @module services/agent/crewly-agent/tool-registry
 */

import { promises as fsPromises } from 'fs';
import * as childProcess from 'child_process';
import { homedir } from 'os';
import * as path from 'path';
import { z } from 'zod';
import type { CrewlyApiClient } from './api-client.js';
import type { ToolDefinition, ToolCallbacks, ToolSensitivity, AuditEntry, ApprovalCheckResult, AuditLogFilters } from './types.js';
import { KEY_EXTRACTION_BLOCKED_COMMANDS, PromptGuardService } from './prompt-guard.service.js';
import { EnvIsolationService } from './env-isolation.service.js';
import { OutputFilterService } from './output-filter.service.js';
import { createWebSearchTool } from './web-search.tool.js';

/** TTL for delegation idle event subscriptions (minutes) */
const DELEGATION_SUBSCRIPTION_TTL_MINUTES = 120;

/** Maximum characters for git diff output */
const GIT_DIFF_MAX_CHARS = 5000;

/** Maximum characters for read_file output to prevent context overflow */
const READ_FILE_MAX_CHARS = 50_000;

/** Maximum lines to return from read_file when no limit is specified */
const READ_FILE_MAX_LINES = 2000;

/**
 * Commands that could kill/signal the parent Crewly server process or
 * cause irreversible system damage.  Checked against the raw command
 * string (case-insensitive, word-boundary match via regex).
 */
const BLOCKED_COMMAND_PATTERNS: RegExp[] = [
  /\bkill\b/i,
  /\bkillall\b/i,
  /\bpkill\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\brm\s+-[^\s]*r[^\s]*\s+\/(?!\S)/i,     // rm -rf / (root wipe)
  /\bmkfs\b/i,
  /\bdd\s+.*of=\/dev\//i,                    // dd of=/dev/...
  /\blaunchctl\b/i,
  /\bsystemctl\b/i,
  // Key extraction protection (from prompt-guard.service.ts)
  ...KEY_EXTRACTION_BLOCKED_COMMANDS,
];

/**
 * Bash commands that require explicit approval before execution.
 * These are dangerous but not catastrophic — they modify remote state,
 * delete files, or interact with container/network infrastructure.
 *
 * Matched against the raw command string (case-insensitive, word-boundary).
 */
export const APPROVAL_REQUIRED_BASH_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bgit\s+push\b/i, label: 'git push (modifies remote repository)' },
  { pattern: /\bgit\s+push\s+.*--force\b/i, label: 'git push --force (destructive remote rewrite)' },
  { pattern: /\brm\s+/i, label: 'rm (file deletion)' },
  { pattern: /\bdocker\s+(rm|rmi|stop|kill|exec|run|build|push|pull)\b/i, label: 'docker operation (container/image management)' },
  { pattern: /\bcurl\b/i, label: 'curl (network request)' },
  { pattern: /\bwget\b/i, label: 'wget (network download)' },
  { pattern: /\bnpm\s+publish\b/i, label: 'npm publish (package registry push)' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, label: 'git reset --hard (destructive history rewrite)' },
];

/**
 * Validate a shell command against the blocklist.
 *
 * @param command - Raw shell command string
 * @returns Error message if blocked, or null if allowed
 */
export function validateBashCommand(command: string): string | null {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Command blocked by security policy: matches forbidden pattern ${pattern}`;
    }
  }
  return null;
}

/**
 * Check if a bash command matches any approval-required pattern.
 *
 * @param command - Raw shell command string
 * @returns Matching label if approval is required, or null if safe to proceed
 */
export function checkBashApprovalRequired(command: string): string | null {
  for (const { pattern, label } of APPROVAL_REQUIRED_BASH_PATTERNS) {
    if (pattern.test(command)) {
      return label;
    }
  }
  return null;
}

/**
 * Execute a shell command asynchronously in an isolated process group so that
 * signals (SIGTERM, SIGINT) from the child cannot propagate to the Crewly server.
 *
 * Uses spawn (async) to avoid blocking the Node.js event loop. The child
 * process runs in a detached process group so its signals don't reach the parent.
 *
 * @param cmd - Shell command to run
 * @param workDir - Working directory
 * @param timeoutMs - Timeout in milliseconds
 * @returns Object with stdout, stderr, exitCode
 */
function execIsolatedAsync(cmd: string, workDir: string, timeoutMs: number): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    const maxBuffer = 1024 * 1024;
    let finished = false;

    // Apply environment isolation — strip sensitive vars from child process
    const envIsolation = new EnvIsolationService();
    const safeEnv = envIsolation.createSafeEnv(process.env as Record<string, string>);
    safeEnv.FORCE_COLOR = '0';

    const child = childProcess.spawn('/bin/sh', ['-c', cmd], {
      cwd: workDir,
      env: safeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        // Kill the entire process group
        try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* ignore */ }
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8')
            + `\n[crewly] Process killed by signal: SIGTERM (timeout: ${timeoutMs}ms)`,
          exitCode: 128,
        });
      }
    }, timeoutMs);

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutLen < maxBuffer) {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrLen < maxBuffer) {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    child.on('close', (code, signal) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        const exitCode = code ?? (signal ? 128 : 1);
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        const signalInfo = signal
          ? `\n[crewly] Process killed by signal: ${signal} (timeout: ${timeoutMs}ms)`
          : '';
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: stderr + signalInfo,
          exitCode,
        });
      }
    });

    child.on('error', (err) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({
          stdout: '',
          stderr: err.message,
          exitCode: 1,
        });
      }
    });

    // Unref so the child doesn't keep the process alive
    child.unref();
  });
}

/**
 * Execute a git command asynchronously without blocking the event loop.
 *
 * @param cmd - Git command to run
 * @param cwd - Working directory
 * @returns stdout string trimmed
 * @throws Error if the command fails
 */
async function execGitAsync(cmd: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    childProcess.exec(cmd, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout as string);
    });
  });
}

/**
 * Expand ~ and $HOME in a file path to the user's home directory.
 * If the path is relative and a baseDir is provided, resolve against it.
 *
 * @param filePath - Path that may contain ~ or $HOME, or be relative
 * @param baseDir  - Optional base directory to resolve relative paths against
 * @returns Resolved absolute path
 */
function expandPath(filePath: string, baseDir?: string): string {
  const home = homedir();
  if (filePath === '~' || filePath.startsWith('~/')) {
    return home + filePath.slice(1);
  }
  if (filePath.startsWith('$HOME/') || filePath === '$HOME') {
    return home + filePath.slice(5);
  }
  // Resolve relative paths against baseDir (e.g. projectPath)
  if (baseDir && !path.isAbsolute(filePath)) {
    return path.resolve(baseDir, filePath);
  }
  return filePath;
}

/** File extensions recognized as images for multimodal read_file support */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** MIME type mapping for image extensions */
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

// ── Glob / Grep Native Helpers ──────────────────────────────────────────────

/** Maximum number of files returned by glob to prevent runaway results */
const GLOB_MAX_RESULTS = 1000;

/** Maximum number of matching lines returned by grep */
const GREP_MAX_MATCHES = 500;

/** Default directories/patterns to ignore during glob/grep traversal */
const DEFAULT_IGNORE_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '.next', '__pycache__',
  '.cache', 'coverage', '.nyc_output', '.turbo', '.parcel-cache',
];

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supports:
 * - `*` matches any characters except `/`
 * - `**` matches any characters including `/` (recursive)
 * - `?` matches a single character except `/`
 * - `{a,b}` matches either a or b
 * - Character classes `[abc]`
 *
 * @param pattern - Glob pattern string (e.g., "src/**\/*.ts")
 * @returns Compiled RegExp
 */
export function globToRegExp(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** — match everything including path separators
      if (pattern[i + 2] === '/') {
        regexStr += '(?:.*/)?';
        i += 3;
      } else {
        regexStr += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      regexStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '{') {
      const closeBrace = pattern.indexOf('}', i);
      if (closeBrace === -1) {
        regexStr += '\\{';
        i++;
      } else {
        const alternatives = pattern.slice(i + 1, closeBrace).split(',');
        regexStr += '(?:' + alternatives.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
        i = closeBrace + 1;
      }
    } else if (ch === '[') {
      const closeBracket = pattern.indexOf(']', i);
      if (closeBracket === -1) {
        regexStr += '\\[';
        i++;
      } else {
        regexStr += pattern.slice(i, closeBracket + 1);
        i = closeBracket + 1;
      }
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  return new RegExp('^' + regexStr + '$');
}

/**
 * Recursively walk a directory tree, yielding file paths that match
 * the given glob pattern while respecting ignore patterns.
 *
 * Uses a stack-based iterative approach to avoid stack overflow on deep trees.
 * Respects DEFAULT_IGNORE_PATTERNS and user-supplied ignore patterns.
 *
 * @param rootDir - Root directory to start traversal
 * @param patternRegex - Compiled glob regex to test relative paths against
 * @param ignoreSet - Set of directory base names to skip
 * @param maxResults - Maximum number of results to return
 * @returns Array of matching absolute file paths
 */
export async function walkAndMatch(
  rootDir: string,
  patternRegex: RegExp,
  ignoreSet: Set<string>,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];
  const stack: string[] = [rootDir];

  while (stack.length > 0 && results.length < maxResults) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fsPromises.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied or not a directory — skip
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (ignoreSet.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (patternRegex.test(relativePath)) {
          results.push(fullPath);
        }
      }
    }
  }

  return results;
}

/**
 * Search file contents for lines matching a regular expression.
 *
 * Reads the file once, splits into lines, and tests each against the pattern.
 * Returns matching lines with line numbers and optional context lines.
 *
 * @param filePath - Absolute path to the file to search
 * @param regex - Compiled RegExp to test each line
 * @param contextLines - Number of lines before and after each match to include
 * @returns Array of match objects with line number, content, and context
 */
export async function searchFileContents(
  filePath: string,
  regex: RegExp,
  contextLines: number,
): Promise<Array<{ line: number; content: string; context?: string[] }>> {
  const content = await fsPromises.readFile(filePath, 'utf8');
  const lines = content.split('\n');
  const matches: Array<{ line: number; content: string; context?: string[] }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      const match: { line: number; content: string; context?: string[] } = {
        line: i + 1,
        content: lines[i],
      };
      if (contextLines > 0) {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length, i + contextLines + 1);
        match.context = lines.slice(start, end).map((l, idx) => `${start + idx + 1}\t${l}`);
      }
      matches.push(match);
    }
  }

  return matches;
}

/**
 * Determine if a file is likely binary by reading its first 8KB and
 * checking for null bytes.
 *
 * @param filePath - Absolute path to the file
 * @returns True if the file appears to be binary
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
  const fd = await fsPromises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } finally {
    await fd.close();
  }
}

/**
 * Strip [NOTIFY]...[/NOTIFY] markers from text.
 *
 * The crewly-agent model sometimes wraps tool arguments in NOTIFY markers
 * intended for the terminal gateway routing layer. When this leaks into
 * reply_slack or other outward-facing tools, the raw markers appear in
 * the Slack message. This function extracts the body content (after the
 * --- separator if present) or the full block content.
 *
 * @param text - Text that may contain NOTIFY markers
 * @returns Clean text with markers stripped and body content extracted
 */
export function stripNotifyMarkers(text: string): string {
  // Replace each [NOTIFY]...[/NOTIFY] block with its body content
  const cleaned = text.replace(/\[NOTIFY\]([\s\S]*?)\[\/NOTIFY\]/gi, (_match, inner: string) => {
    const trimmed = inner.trim();
    // If there's a --- separator, extract only the body after it
    const separatorIdx = trimmed.indexOf('---');
    if (separatorIdx !== -1) {
      return trimmed.slice(separatorIdx + 3).trim();
    }
    // No separator — return the full inner content
    return trimmed;
  });
  return cleaned.trim();
}

/**
 * Convert GitHub-flavored Markdown to Slack mrkdwn format (#181).
 *
 * Transformations applied (in order):
 * 1. Escape &, <, > to HTML entities (Slack requirement)
 * 2. Convert fenced code blocks (```lang\n...\n```) to Slack code blocks
 * 3. Convert **bold** to *bold* (Slack uses single asterisks)
 * 4. Convert [text](url) links to <url|text> (Slack link format)
 *
 * @param text - Markdown-formatted text
 * @returns Text formatted for Slack mrkdwn
 */
export function convertMarkdownToSlackMrkdwn(text: string): string {
  // 1. Escape special Slack characters (must happen first, before adding <> for links)
  let result = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Convert fenced code blocks: ```lang\n...\n``` → ```\n...\n```
  // Slack doesn't support language hints in code blocks, so strip them
  result = result.replace(/```\w*\n/g, '```\n');

  // 3. Convert **bold** to *bold* (Slack bold is single asterisk)
  // Must not touch single * (already italic in both formats)
  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');

  // 4. Convert [text](url) links to <url|text>
  // The url may contain escaped &gt; from step 1, but real URLs won't have those
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  return result;
}

/**
 * Sensitivity classification for each tool.
 * Used by the audit trail to classify tool invocations.
 */
export const TOOL_SENSITIVITY: Record<string, ToolSensitivity> = {
  // Safe: read-only, informational
  get_agent_status: 'safe',
  get_team_status: 'safe',
  get_agent_logs: 'safe',
  heartbeat: 'safe',
  get_tasks: 'safe',
  get_project_overview: 'safe',
  read_file: 'safe',
  glob: 'safe',
  grep: 'safe',
  recall_memory: 'safe',
  subscribe_event: 'safe',
  get_audit_log: 'safe',
  get_scheduled_checks: 'safe',
  compact_memory: 'safe',
  get_context_budget: 'safe',
  // Sensitive: modify state, communicate externally
  delegate_task: 'sensitive',
  send_message: 'sensitive',
  reply_slack: 'sensitive',
  schedule_check: 'sensitive',
  cancel_schedule: 'sensitive',
  register_self: 'sensitive',
  report_status: 'sensitive',
  remember: 'sensitive',
  complete_task: 'sensitive',
  broadcast: 'sensitive',
  // Destructive: irreversible or high-impact operations
  start_agent: 'destructive',
  stop_agent: 'destructive',
  handle_agent_failure: 'destructive',
  edit_file: 'destructive',
  write_file: 'destructive',
  // Git tools (#176)
  git_status: 'safe',
  git_diff: 'safe',
  git_commit: 'sensitive',
  // Shell execution (#176)
  bash_exec: 'destructive',
  // Task handoff (F12)
  handoff_task: 'sensitive',
  // Cloud-backed web search
  web_search: 'safe',
};

/**
 * Wrap a tool's execute function with audit logging.
 *
 * Records tool name, sensitivity, args, result status, and duration.
 * Sanitizes arguments to avoid logging secrets.
 *
 * @param toolName - Name of the tool being wrapped
 * @param executeFn - Original execute function
 * @param callbacks - Callbacks object with onAuditLog handler
 * @returns Wrapped execute function
 */
/**
 * Wrap a tool's execute function with security policy enforcement and audit logging.
 *
 * Checks blocked tools and approval requirements before execution.
 * Records tool name, sensitivity, args, result status, and duration.
 * Sanitizes arguments to avoid logging secrets.
 *
 * @param toolName - Name of the tool being wrapped
 * @param executeFn - Original execute function
 * @param callbacks - Callbacks object with onAuditLog and onCheckApproval handlers
 * @returns Wrapped execute function
 */
function wrapWithAudit(
  toolName: string,
  executeFn: (args: Record<string, unknown>) => Promise<unknown>,
  callbacks?: ToolCallbacks,
): (args: Record<string, unknown>) => Promise<unknown> {
  if (!callbacks?.onAuditLog && !callbacks?.onCheckApproval) return executeFn;

  return async (args: Record<string, unknown>): Promise<unknown> => {
    const start = Date.now();
    const sensitivity = TOOL_SENSITIVITY[toolName] || 'safe';

    // Sanitize args: redact potential secrets
    const sanitizedArgs = sanitizeArgs(args);

    // Check security policy before execution
    if (callbacks?.onCheckApproval) {
      const approvalResult: ApprovalCheckResult = callbacks.onCheckApproval(toolName, sensitivity);
      if (!approvalResult.allowed) {
        const entry: AuditEntry = {
          timestamp: new Date().toISOString(),
          toolName,
          sensitivity,
          args: sanitizedArgs,
          success: false,
          error: approvalResult.reason || 'Blocked by security policy',
          durationMs: Date.now() - start,
        };
        if (callbacks?.onAuditLog) callbacks.onAuditLog(entry);
        // Enqueue for approval if not hard-blocked
        let approvalId: string | undefined;
        if (!approvalResult.blocked && callbacks?.onEnqueueApproval) {
          const enqueued = callbacks.onEnqueueApproval(toolName, sensitivity, sanitizedArgs);
          approvalId = enqueued.approvalId;
        }

        return {
          success: false,
          blocked: approvalResult.blocked ?? false,
          requiresApproval: !approvalResult.blocked,
          approvalId,
          error: approvalResult.reason || 'Tool execution denied by security policy',
        };
      }
    }

    // No audit logger — just execute
    if (!callbacks?.onAuditLog) return executeFn(args);

    try {
      const result = await executeFn(args);
      const success = result != null && typeof result === 'object'
        ? (result as Record<string, unknown>).success !== false
        : true;

      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        toolName,
        sensitivity,
        args: sanitizedArgs,
        success,
        durationMs: Date.now() - start,
      };
      if (!success && typeof result === 'object' && result !== null) {
        entry.error = String((result as Record<string, unknown>).error || 'unknown');
      }
      callbacks.onAuditLog!(entry);
      return result;
    } catch (error) {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        toolName,
        sensitivity,
        args: sanitizedArgs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      };
      callbacks.onAuditLog!(entry);
      throw error;
    }
  };
}

/**
 * Sanitize tool arguments for audit logging.
 * Redacts values for keys that may contain secrets.
 *
 * @param args - Raw tool arguments
 * @returns Sanitized copy safe for logging
 */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['password', 'secret', 'token', 'apiKey', 'api_key', 'authorization'];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      result[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > 2000) {
      result[key] = value.substring(0, 2000) + '...[truncated]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Create the complete set of AI SDK tools for the Crewly Agent.
 *
 * Each tool's execute function calls the Crewly REST API directly
 * via the provided API client, bypassing the bash script layer.
 * Tools are wrapped with audit logging when callbacks are provided.
 *
 * @param client - API client instance for making REST calls
 * @param sessionName - Agent session name for identity context
 * @param projectPath - Optional project path for auto-injection
 * @param callbacks - Optional callbacks for compaction and audit logging
 * @returns Object of named tools ready to pass to generateText
 */
export function createTools(client: CrewlyApiClient, sessionName: string, projectPath?: string, callbacks?: ToolCallbacks, conversationId?: string, slackContext?: { channelId: string; threadTs?: string }, mcpTools?: Record<string, ToolDefinition>): Record<string, ToolDefinition> {
  // Slack rate-limiting state: throttle messages within a 3-second window
  let lastSlackSendMs = 0;
  const SLACK_THROTTLE_MS = 3000;

  // Slack dedup: ring buffer of recent messages to prevent duplicate sends
  const recentSlackMessages: string[] = [];
  const SLACK_DEDUP_WINDOW = 10;

  const rawTools: Record<string, ToolDefinition> = {
    // ===== Core Orchestration Tools =====

    delegate_task: {
      description: 'Delegate a task to a worker agent. Sends the task message and creates a task tracking file. Enforces TL hierarchy — if target has a parent TL, routes through TL instead.',
      inputSchema: z.object({
        to: z.string().describe('Target agent session name'),
        task: z.string().describe('Task description and instructions'),
        priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'),
        context: z.string().optional().describe('Additional context for the task'),
        projectPath: z.string().optional().describe('Project path for task tracking'),
      }),
      execute: async ({ to, task, priority, context, projectPath }) => {
        // #164: TL hierarchy validation — enforce that the caller has delegation authority
        const teamsResult = await client.get('/teams').catch(() => null);
        if (teamsResult?.success && Array.isArray(teamsResult.data)) {
          type MemberInfo = { id: string; sessionName: string; parentMemberId?: string; canDelegate?: boolean; subordinateIds?: string[]; agentStatus?: string; workingStatus?: string };
          type TeamInfo = { members?: MemberInfo[] };
          for (const team of teamsResult.data as TeamInfo[]) {
            const targetMember = team.members?.find(m => m.sessionName === (to as string));
            const callerMember = team.members?.find(m => m.sessionName === sessionName);

            if (targetMember?.parentMemberId) {
              const tlMember = team.members?.find(m => m.id === targetMember.parentMemberId);
              // If the caller is NOT the TL, redirect through TL
              if (tlMember && tlMember.sessionName !== sessionName) {
                return {
                  success: false,
                  error: `Hierarchy violation: ${to} reports to TL ${tlMember.sessionName} (${tlMember.id}). You must delegate through the TL, not directly. Use send_message to ask ${tlMember.sessionName} to delegate this task to ${to}.`,
                  redirectTo: tlMember.sessionName,
                  hint: 'Use send_message to the TL with the task details, and ask them to delegate to the worker.',
                };
              }
            }

            // Verify caller has canDelegate permission when delegating to a subordinate
            if (callerMember && targetMember && callerMember.canDelegate === false) {
              return {
                success: false,
                error: `You (${sessionName}) do not have delegation permission (canDelegate: false). Ask your TL to delegate this task.`,
              };
            }

            // Task stacking prevention — check if target already has in-progress tasks
            if (targetMember && targetMember.workingStatus === 'in_progress') {
              return {
                success: false,
                error: `Agent ${to} is already working on a task (workingStatus: in_progress). Wait for current task to complete before delegating a new one.`,
                agentStatus: targetMember.agentStatus,
                workingStatus: targetMember.workingStatus,
              };
            }
          }
        }

        const taskMessage = buildTaskMessage(to as string, task as string, priority as string, context as string | undefined, projectPath as string | undefined);

        // Deliver the task message
        const deliverResult = await client.post(`/terminal/${to}/deliver`, {
          message: taskMessage,
          waitForReady: true,
          waitTimeout: 15000,
        });

        if (!deliverResult.success) {
          // Fallback: force delivery
          const forceResult = await client.post(`/terminal/${to}/deliver`, {
            message: taskMessage,
            force: true,
          });
          if (!forceResult.success) {
            return { success: false, error: `Failed to deliver task to ${to}: ${forceResult.error}` };
          }
        }

        // Create task tracking entry as a V3 WorkItem.
        // Migrated from v1 `/task-management/create` per spec
        // 2026-05-06-task-management-v1-deprecation.md.
        let taskId: string | undefined;
        if (projectPath) {
          const priorityNum =
            priority === 'critical' ? 1 :
            priority === 'high'     ? 2 :
            priority === 'low'      ? 4 :
            3;
          const wiId = `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          const createResult = await client.post('/task-pool/add', {
            workItem: {
              id: wiId,
              title: typeof task === 'string' ? task.slice(0, 200) : 'Delegated task',
              type: 'delegate',
              owner: typeof to === 'string' ? to : 'system',
              priority: priorityNum,
              status: 'queued',
              target: to,
              briefMarkdown: typeof task === 'string' ? task : undefined,
              metadata: { projectPath, milestone: 'delegated' },
            },
          });
          if (createResult.success && createResult.data) {
            const data = createResult.data as Record<string, unknown>;
            taskId = (data.id as string | undefined) ?? wiId;
          }
        }

        // Subscribe to idle event for monitoring (with dedup check)
        const existingSubs = await client.get(`/events/subscriptions?subscriberSession=${encodeURIComponent(sessionName)}`).catch(() => null);
        const alreadySubscribed = existingSubs?.success && Array.isArray(existingSubs.data) &&
          (existingSubs.data as Array<{ eventType: string; filter?: Record<string, string> }>).some(
            sub => sub.eventType === 'agent:idle' && sub.filter?.sessionName === (to as string),
          );
        if (!alreadySubscribed) {
          await client.post('/events/subscribe', {
            eventType: 'agent:idle',
            filter: { sessionName: to },
            subscriberSession: sessionName,
            oneShot: true,
            ttlMinutes: DELEGATION_SUBSCRIPTION_TTL_MINUTES,
          });
        }

        return { success: true, delegatedTo: to, taskId, conversationId: conversationId || undefined };
      },
    },

    send_message: {
      description: 'Send a message to an agent terminal session.',
      inputSchema: z.object({
        sessionName: z.string().describe('Target agent session name'),
        message: z.string().describe('Message content'),
        force: z.boolean().default(false).describe('Force send without waiting for ready state'),
      }),
      execute: async ({ sessionName: target, message, force }) => {
        const body = force
          ? { message, force: true }
          : { message, waitForReady: true, waitTimeout: 120000 };
        const result = await client.post(`/terminal/${target}/deliver`, body);
        return result.success
          ? { success: true, delivered: true }
          : { success: false, error: result.error };
      },
    },

    get_agent_status: {
      description: 'Get the current status of a specific agent by session name.',
      inputSchema: z.object({
        sessionName: z.string().describe('Agent session name to check'),
      }),
      execute: async ({ sessionName: target }) => {
        // Record manual check so redundant scheduled checks are suppressed (fire-and-forget)
        Promise.resolve(client.post('/schedule/manual-check', { agentSession: target })).catch(() => {});

        const result = await client.get('/teams');
        if (!result.success) return { error: result.error };

        const teams = result.data as Record<string, unknown>[];
        const teamArray = Array.isArray(teams) ? teams : [teams];
        for (const team of teamArray) {
          const members = (team as Record<string, unknown>).members as Array<Record<string, unknown>> | undefined;
          if (!members) continue;
          const agent = members.find(m => m.sessionName === target || m.name === target);
          if (agent) return agent;
        }
        return { error: 'Agent not found', sessionName: target };
      },
    },

    get_team_status: {
      description: 'Get status of all teams and their agents.',
      inputSchema: z.object({}),
      execute: async () => {
        const result = await client.get('/teams');
        return result.success ? result.data : { error: result.error };
      },
    },

    get_agent_logs: {
      description: 'Get recent terminal output from an agent session.',
      inputSchema: z.object({
        sessionName: z.string().describe('Agent session name'),
        lines: z.number().default(50).describe('Number of lines to retrieve'),
      }),
      execute: async ({ sessionName: target, lines }) => {
        // Record manual check so redundant scheduled checks are suppressed (fire-and-forget)
        Promise.resolve(client.post('/schedule/manual-check', { agentSession: target })).catch(() => {});

        const result = await client.get(`/terminal/${target}/output?lines=${lines}`);
        return result.success ? result.data : { error: result.error };
      },
    },

    reply_slack: {
      description: 'Send a text reply or upload an image to a Slack channel or thread. If channelId is omitted, uses the current Slack thread context. For images, provide imagePath (absolute path on disk) — the image is uploaded via Slack file upload API. Messages sent within 3 seconds are batched to avoid spam.',
      inputSchema: z.object({
        channelId: z.string().optional().describe('Slack channel ID (auto-filled from current thread context if omitted)'),
        text: z.string().describe('Message text (used as comment when uploading an image)'),
        threadTs: z.string().optional().describe('Thread timestamp for replies (auto-filled from current thread context if omitted)'),
        imagePath: z.string().optional().describe('Absolute path to an image file to upload (png, jpg, gif, webp). When provided, uploads the image instead of sending a text message.'),
      }),
      execute: async ({ channelId, text, threadTs, imagePath }) => {
        let cleanText = stripNotifyMarkers(text as string);
        // #181: Convert markdown to Slack mrkdwn format
        cleanText = convertMarkdownToSlackMrkdwn(cleanText);

        // Auto-prefix with agent display name so Slack messages are attributable
        // Session format: "crewly-{team}-{name}-{uuid}" → extract {name}
        // Fallback: "crewly-orc" → "orc"
        if (sessionName && !cleanText.startsWith('[')) {
          const parts = sessionName.split('-');
          // For "crewly-product-sam-217bfbbf": parts[2] = "sam"
          // For "crewly-orc": parts[1] = "orc"
          const namePart = parts.length >= 3 ? parts[2] : parts[parts.length - 1];
          const capitalized = namePart.charAt(0).toUpperCase() + namePart.slice(1);
          cleanText = `[${capitalized}] ${cleanText}`;
        }
        const resolvedChannelId = (channelId as string | undefined) || slackContext?.channelId;
        const resolvedThreadTs = (threadTs as string | undefined) || slackContext?.threadTs;
        if (!resolvedChannelId) {
          return { success: false, error: 'No channelId provided and no Slack thread context available. Use reply_slack with an explicit channelId.' };
        }

        // ── Image upload path ──
        if (imagePath) {
          const uploadBody: Record<string, string> = {
            channelId: resolvedChannelId,
            filePath: imagePath as string,
            initialComment: cleanText,
          };
          if (resolvedThreadTs) uploadBody.threadTs = resolvedThreadTs;
          const result = await client.post('/slack/upload-image', uploadBody);
          if (result.success) {
            lastSlackSendMs = Date.now();
          }
          return result.success
            ? { success: true, sent: true, uploaded: true, filePath: imagePath }
            : { success: false, error: result.error };
        }

        // ── Text message path ──
        // Dedup: skip if this exact message was recently sent
        if (recentSlackMessages.includes(cleanText)) {
          return { success: true, sent: false, deduplicated: true, reason: 'Message already sent recently' };
        }

        // Issue 3: Rate-limit Slack messages — throttle within a 3s window
        const now = Date.now();
        if (now - lastSlackSendMs < SLACK_THROTTLE_MS) {
          return { success: true, sent: false, throttled: true, retryAfterMs: SLACK_THROTTLE_MS - (now - lastSlackSendMs) };
        }

        const body: Record<string, string> = { channelId: resolvedChannelId, text: cleanText };
        if (resolvedThreadTs) body.threadTs = resolvedThreadTs;
        if (conversationId) body.conversationId = conversationId;
        if (sessionName) body.senderSessionName = sessionName;
        const result = await client.post('/slack/send', body);
        if (result.success) {
          lastSlackSendMs = Date.now();
          // Track for dedup
          recentSlackMessages.push(cleanText);
          if (recentSlackMessages.length > SLACK_DEDUP_WINDOW) {
            recentSlackMessages.shift();
          }
        }
        return result.success
          ? { success: true, sent: true }
          : { success: false, error: result.error };
      },
    },

    // ===== Scheduling Tools =====

    schedule_check: {
      description: 'Schedule a future check-in reminder. Include taskId to auto-cancel when the linked task completes. Deduplicates: skips if a similar check already exists for the same target.',
      inputSchema: z.object({
        minutes: z.number().describe('Minutes from now'),
        message: z.string().describe('Reminder message'),
        target: z.string().optional().describe('Target session (defaults to self)'),
        recurring: z.boolean().default(false),
        maxOccurrences: z.number().optional(),
        taskId: z.string().optional().describe('Link to a task ID — recurring check auto-cancels when this task completes'),
      }),
      execute: async ({ minutes, message, target, recurring, maxOccurrences, taskId }) => {
        const targetSession = target || sessionName;

        // Issue 2: Dedup check — list existing scheduled checks for this target
        const existingResult = await client.get(`/schedule?session=${encodeURIComponent(targetSession as string)}`).catch(() => null);
        if (existingResult?.success && Array.isArray(existingResult.data)) {
          type CheckInfo = { targetSession: string; message: string; taskId?: string };
          const msgPrefix = (message as string).slice(0, 50); // Match on message prefix
          const isDuplicate = (existingResult.data as CheckInfo[]).some(check =>
            check.targetSession === targetSession &&
            (check.message?.startsWith(msgPrefix) || (taskId && check.taskId === taskId))
          );
          if (isDuplicate) {
            return { success: true, status: 'already_scheduled', targetSession, message };
          }
        }

        const body: Record<string, unknown> = {
          targetSession,
          minutes,
          message,
        };
        if (recurring) {
          body.isRecurring = true;
          body.intervalMinutes = minutes;
        }
        if (maxOccurrences) body.maxOccurrences = maxOccurrences;
        if (taskId) body.taskId = taskId;
        const result = await client.post('/schedule', body);
        return result.success ? result.data : { error: result.error };
      },
    },

    cancel_schedule: {
      description: 'Cancel a scheduled check-in by ID.',
      inputSchema: z.object({
        checkId: z.string().describe('Schedule ID to cancel'),
      }),
      execute: async ({ checkId }) => {
        const result = await client.delete(`/schedule/${checkId}`);
        return result.success ? { success: true } : { error: result.error };
      },
    },

    get_scheduled_checks: {
      description: 'List all active scheduled checks. Use to identify stale or completed checks that should be cancelled.',
      inputSchema: z.object({
        session: z.string().optional().describe('Filter by target session name'),
      }),
      execute: async ({ session }) => {
        const endpoint = session
          ? `/schedule?session=${encodeURIComponent(session as string)}`
          : '/schedule';
        const result = await client.get(endpoint);
        return result.success ? result.data : { error: result.error };
      },
    },

    // ===== Agent Lifecycle Tools =====

    start_agent: {
      description: 'Start a specific agent within a team. Safely skips if the agent is already active.',
      inputSchema: z.object({
        teamId: z.string().describe('Team UUID'),
        memberId: z.string().describe('Member UUID'),
      }),
      execute: async ({ teamId, memberId }) => {
        // Pre-check: if the agent is already active, return immediately to avoid
        // timeout and session interruption from redundant start calls
        const teamResult = await client.get(`/teams/${teamId}`).catch(() => null);
        if (teamResult?.success && teamResult.data) {
          const team = teamResult.data as { members?: Array<{ id: string; agentStatus?: string; sessionName?: string; name?: string }> };
          const member = team.members?.find(m => m.id === memberId);
          if (member && member.agentStatus === 'active' && member.sessionName) {
            return {
              success: true,
              memberName: member.name,
              memberId: member.id,
              sessionName: member.sessionName,
              status: 'already_active',
            };
          }
        }

        const result = await client.post(`/teams/${teamId}/members/${memberId}/start`, {});
        return result.success ? result.data : { error: result.error };
      },
    },

    stop_agent: {
      description: 'Stop a specific agent within a team.',
      inputSchema: z.object({
        teamId: z.string().describe('Team UUID'),
        memberId: z.string().describe('Member UUID'),
      }),
      execute: async ({ teamId, memberId }) => {
        const result = await client.post(`/teams/${teamId}/members/${memberId}/stop`, {});
        return result.success ? result.data : { error: result.error };
      },
    },

    // ===== Event Tools =====

    subscribe_event: {
      description: 'Subscribe to agent lifecycle events (e.g., agent:idle, agent:busy). Deduplicates: skips if an identical subscription already exists.',
      inputSchema: z.object({
        eventType: z.string().describe('Event type (e.g., "agent:idle")'),
        filter: z.record(z.string()).optional().describe('Event filter criteria'),
        oneShot: z.boolean().default(true),
      }),
      execute: async ({ eventType, filter, oneShot }) => {
        // Issue 2: Dedup check — list existing subscriptions and skip if duplicate
        const existingResult = await client.get(`/events/subscriptions?subscriberSession=${encodeURIComponent(sessionName)}`).catch(() => null);
        if (existingResult?.success && Array.isArray(existingResult.data)) {
          type SubInfo = { eventType: string; filter?: Record<string, string>; subscriberSession: string };
          const filterStr = JSON.stringify(filter || {});
          const isDuplicate = (existingResult.data as SubInfo[]).some(sub =>
            sub.eventType === eventType &&
            sub.subscriberSession === sessionName &&
            JSON.stringify(sub.filter || {}) === filterStr
          );
          if (isDuplicate) {
            return { success: true, status: 'already_subscribed', eventType, filter };
          }
        }

        const result = await client.post('/events/subscribe', {
          eventType,
          filter: filter || {},
          subscriberSession: sessionName,
          oneShot,
        });
        return result.success ? result.data : { error: result.error };
      },
    },

    // ===== Memory Tools =====

    recall_memory: {
      description: 'Retrieve relevant knowledge from agent/project memory.',
      inputSchema: z.object({
        context: z.string().describe('What to search for'),
        scope: z.enum(['agent', 'project', 'both']).default('both'),
        projectPath: z.string().optional().describe('Project path (auto-injected if omitted)'),
      }),
      execute: async ({ context, scope, projectPath: pp }) => {
        const body: Record<string, unknown> = {
          agentId: sessionName,
          context,
          scope,
        };
        // Auto-inject projectPath when scope requires it
        const resolvedProjectPath = (pp as string | undefined) || projectPath;
        if (resolvedProjectPath && (scope === 'project' || scope === 'both')) {
          body.projectPath = resolvedProjectPath;
        }
        const result = await client.post('/memory/recall', body);
        return result.success ? result.data : { error: result.error };
      },
    },

    remember: {
      description: 'Store knowledge for future reference.',
      inputSchema: z.object({
        content: z.string().describe('Knowledge to store'),
        category: z.enum(['pattern', 'decision', 'gotcha', 'fact', 'preference']),
        scope: z.enum(['agent', 'project']).default('project'),
        projectPath: z.string().optional().describe('Project path (auto-injected if omitted)'),
      }),
      execute: async ({ content, category, scope, projectPath: pp }) => {
        const body: Record<string, unknown> = {
          agentId: sessionName,
          content,
          category,
          scope,
        };
        const resolvedProjectPath = (pp as string | undefined) || projectPath;
        if (resolvedProjectPath) {
          body.projectPath = resolvedProjectPath;
        }
        const result = await client.post('/memory/remember', body);
        return result.success ? result.data : { error: result.error };
      },
    },

    // ===== System Tools =====

    heartbeat: {
      description: 'System health check. Returns teams, projects, and message queue status.',
      inputSchema: z.object({}),
      execute: async () => {
        const [teams, projects, queue] = await Promise.all([
          client.get('/teams'),
          client.get('/projects'),
          client.get('/messaging/queue/status'),
        ]);
        return {
          status: 'ok',
          timestamp: new Date().toISOString(),
          teams: teams.success ? teams.data : 'unavailable',
          projects: projects.success ? projects.data : 'unavailable',
          queue: queue.success ? queue.data : 'unavailable',
        };
      },
    },

    get_tasks: {
      description: 'Get all tracked tasks for a project.',
      inputSchema: z.object({
        projectPath: z.string().describe('Project path'),
        status: z.string().optional().describe('Filter by status (e.g., "in_progress", "done")'),
      }),
      execute: async ({ projectPath: _projectPath, status }) => {
        // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
        // The V3 task-pool is a single global file; `projectPath` is no
        // longer a filter. Status filter still applies.
        let endpoint = '/task-pool/items';
        if (status) endpoint += `?status=${encodeURIComponent(status as string)}`;
        const result = await client.get(endpoint);
        return result.success ? result.data : { error: result.error };
      },
    },

    complete_task: {
      description: 'Mark a WorkItem as complete. Also cancels any scheduled checks targeting the completing agent session.',
      inputSchema: z.object({
        workItemId: z.string().describe('WorkItem id to complete'),
        sessionName: z.string().describe('Agent session that completed it'),
        summary: z.string().describe('Completion summary'),
      }),
      execute: async ({ workItemId, sessionName: agent, summary }) => {
        // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md.
        // Replaces v1 `/task-management/complete`. Note: the legacy
        // `absoluteTaskPath` parameter is removed; callers must now pass
        // `workItemId` (returned from `start_agent_with_task` /
        // `delegate_task`).
        //
        // Hygiene #4: emit canonical body shape `{agentId, result:{summary}}`
        // required by task-pool.controller.ts `completeItem`. Prior shape
        // `{summary}` 400'd because the controller looks at `result.summary`
        // and requires non-empty `agentId`. Cf. fix-paired changes in:
        //   - config/skills/agent/core/{report-status,complete-task}/execute.sh
        //   - config/skills/orchestrator/complete-task/execute.sh
        //   - tool-registry.ts §report_status auto-complete path (below)
        const result = await client.post(`/task-pool/complete/${workItemId}`, {
          agentId: agent,
          result: { summary },
        });

        // Auto-cancel scheduled checks targeting the completing agent
        // to prevent stale recurring checks from firing after task completion
        let cancelledChecks = 0;
        try {
          const checksResult = await client.get(`/schedule?session=${encodeURIComponent(agent as string)}`);
          if (checksResult.success && Array.isArray(checksResult.data)) {
            for (const check of checksResult.data as Array<{ id: string; isRecurring?: boolean }>) {
              if (check.isRecurring) {
                await client.delete(`/schedule/${check.id}`);
                cancelledChecks++;
              }
            }
          }
        } catch {
          // Non-fatal: task completion succeeded even if check cleanup fails
        }

        if (result.success) {
          return { ...result.data as Record<string, unknown>, cancelledChecks };
        }
        return { error: result.error };
      },
    },

    broadcast: {
      description: 'Broadcast a message to all active agent sessions.',
      inputSchema: z.object({
        message: z.string().describe('Message to broadcast'),
      }),
      execute: async ({ message }) => {
        const sessionsResult = await client.get('/terminal/sessions');
        if (!sessionsResult.success) return { error: sessionsResult.error };

        const sessions = sessionsResult.data as Record<string, unknown>[] | { data: Record<string, unknown>[] };
        const sessionList = Array.isArray(sessions) ? sessions : (sessions as Record<string, unknown>).data as Record<string, unknown>[] || [];

        let sent = 0;
        let failed = 0;
        for (const session of sessionList) {
          const name = (session as Record<string, string>).name;
          if (!name || name === sessionName) continue;
          const result = await client.post(`/terminal/${name}/deliver`, { message });
          if (result.success) sent++;
          else failed++;
        }
        return { sent, failed };
      },
    },

    handle_agent_failure: {
      description: 'Handle agent failure: restart the agent session.',
      inputSchema: z.object({
        teamId: z.string(),
        memberId: z.string(),
        sessionName: z.string().describe('Agent session name'),
        action: z.enum(['restart', 'retry', 'escalate']),
        reason: z.string().optional(),
      }),
      execute: async ({ teamId, memberId, sessionName: agent, action, reason }) => {
        if (action === 'restart') {
          await client.post(`/teams/${teamId}/members/${memberId}/stop`, {});
          const result = await client.post(`/teams/${teamId}/members/${memberId}/start`, {});
          return { action: 'restarted', sessionName: agent, success: result.success };
        }
        if (action === 'escalate') {
          return { action: 'escalated', sessionName: agent, reason: reason || 'unknown' };
        }
        return { action, sessionName: agent, note: 'Action acknowledged' };
      },
    },

    // ===== File Editing Tools =====

    edit_file: {
      description: 'Surgical file edit: replace an exact substring in a file with new content. Uses precise string matching (not regex) to find the old text and replace it. The old_string must appear exactly once in the file for the edit to succeed. This is safer than full file rewrites — only the targeted section changes.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the file to edit'),
        old_string: z.string().describe('Exact string to find and replace (must be unique in the file)'),
        new_string: z.string().describe('Replacement string'),
        replace_all: z.boolean().default(false).describe('Replace all occurrences instead of requiring uniqueness'),
      }),
      execute: async ({ file_path, old_string, new_string, replace_all }) => {
        const fp = expandPath(file_path as string, projectPath), os = old_string as string, ns = new_string as string;
        try {
          // Read the file
          const content = await fsPromises.readFile(fp, 'utf8');

          // Count occurrences
          const occurrences = content.split(os).length - 1;

          if (occurrences === 0) {
            return {
              success: false,
              error: `old_string not found in ${fp}. Make sure the string matches exactly (including whitespace and indentation).`,
            };
          }

          // When replace_all is true, replace all occurrences
          if (replace_all && occurrences > 1) {
            const newContent = content.replaceAll(os, ns);
            await fsPromises.writeFile(fp, newContent, 'utf8');
            return {
              success: true,
              file: fp,
              replacements: occurrences,
            };
          }

          // Default behavior: require unique match for safety
          if (occurrences > 1) {
            return {
              success: false,
              error: `old_string found ${occurrences} times in ${fp}. Provide a larger unique string with more surrounding context, or set replace_all=true.`,
              occurrences,
            };
          }

          // Perform the replacement (single occurrence)
          const newContent = content.replace(os, ns);

          // Write back
          await fsPromises.writeFile(fp, newContent, 'utf8');

          return {
            success: true,
            file: fp,
            replacements: 1,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('ENOENT')) {
            return { success: false, error: `File not found: ${fp}` };
          }
          if (msg.includes('EACCES')) {
            return { success: false, error: `Permission denied: ${fp}` };
          }
          return { success: false, error: msg };
        }
      },
    },

    read_file: {
      description: 'Read the contents of a file. Returns text content with line numbers, or base64-encoded image data for image files (png/jpg/gif/webp/svg). Image files are returned as multimodal content parts for AI SDK.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the file to read'),
        offset: z.number().optional().describe('Line number to start reading from (1-based, text files only)'),
        limit: z.number().optional().describe('Maximum number of lines to read (text files only)'),
      }),
      execute: async ({ file_path, offset, limit }) => {
        const fp = expandPath(file_path as string, projectPath);
        try {
          // Check if this is an image file
          const ext = fp.split('.').pop()?.toLowerCase() || '';
          if (IMAGE_EXTENSIONS.has(ext)) {
            const buffer = await fsPromises.readFile(fp);
            const base64 = buffer.toString('base64');
            const mimeType = IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
            return {
              success: true,
              type: 'image',
              mimeType,
              data: base64,
              file: fp,
              sizeBytes: buffer.length,
            };
          }

          const content = await fsPromises.readFile(fp, 'utf8');
          const lines = content.split('\n');

          if (offset || limit) {
            const start = ((offset as number) || 1) - 1;
            const end = limit ? start + (limit as number) : lines.length;
            const sliced = lines.slice(start, end);
            return {
              success: true,
              content: sliced.map((line, i) => `${start + i + 1}\t${line}`).join('\n'),
              totalLines: lines.length,
            };
          }

          // Auto-limit large files to prevent context overflow
          const effectiveLines = lines.length > READ_FILE_MAX_LINES
            ? lines.slice(0, READ_FILE_MAX_LINES)
            : lines;
          let output = effectiveLines.map((line, i) => `${i + 1}\t${line}`).join('\n');
          const wasTruncated = lines.length > READ_FILE_MAX_LINES;
          if (output.length > READ_FILE_MAX_CHARS) {
            output = output.slice(0, READ_FILE_MAX_CHARS) + '\n...[truncated — use offset/limit to read specific sections]';
          }
          return {
            success: true,
            content: output,
            totalLines: lines.length,
            ...(wasTruncated && { truncated: true, shownLines: READ_FILE_MAX_LINES }),
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.includes('ENOENT')) {
            return { success: false, error: `File not found: ${fp}` };
          }
          return { success: false, error: msg };
        }
      },
    },

    write_file: {
      description: 'Write content to a file, creating it if it does not exist. Overwrites existing content. Use edit_file for surgical modifications to existing files.',
      inputSchema: z.object({
        file_path: z.string().describe('Absolute path to the file to write'),
        content: z.string().describe('Full file content to write'),
      }),
      execute: async ({ file_path, content }) => {
        const fp = expandPath(file_path as string, projectPath), ct = content as string;
        try {
          // Ensure parent directory exists
          const dir = fp.substring(0, fp.lastIndexOf('/'));
          if (dir) {
            await fsPromises.mkdir(dir, { recursive: true });
          }
          await fsPromises.writeFile(fp, ct, 'utf8');
          return { success: true, file: fp, bytes: Buffer.byteLength(ct, 'utf8') };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    // ===== Native File Search Tools (O7.KR1 — Claude Code parity) =====

    glob: {
      description: 'Fast file pattern matching. Recursively find files matching a glob pattern (e.g., "**/*.ts", "src/**/*.test.tsx"). Returns matching file paths sorted alphabetically. Use this instead of bash find.',
      inputSchema: z.object({
        pattern: z.string().describe('Glob pattern to match files (e.g., "**/*.ts", "src/components/**/*.tsx")'),
        path: z.string().optional().describe('Root directory to search in. Defaults to projectPath or cwd.'),
        ignore: z.array(z.string()).optional().describe('Additional directory names to ignore (node_modules, .git, dist are always ignored)'),
      }),
      execute: async ({ pattern, path: searchPath, ignore }) => {
        try {
          const rootDir = expandPath((searchPath as string | undefined) || projectPath || process.cwd());
          const stat = await fsPromises.stat(rootDir);
          if (!stat.isDirectory()) {
            return { success: false, error: `Not a directory: ${rootDir}` };
          }

          const patternStr = pattern as string;
          const patternRegex = globToRegExp(patternStr);

          const ignoreNames = new Set(DEFAULT_IGNORE_PATTERNS);
          if (Array.isArray(ignore)) {
            for (const ig of ignore) {
              ignoreNames.add(ig as string);
            }
          }

          const results = await walkAndMatch(rootDir, patternRegex, ignoreNames, GLOB_MAX_RESULTS);
          results.sort();

          return {
            success: true,
            pattern: patternStr,
            root: rootDir,
            matchCount: results.length,
            files: results,
            truncated: results.length >= GLOB_MAX_RESULTS,
          };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    grep: {
      description: 'Search file contents for a regex pattern. Returns matching lines with line numbers and optional context. Searches recursively through files matching an optional file glob filter. Use this instead of bash grep/rg.',
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression pattern to search for in file contents'),
        path: z.string().optional().describe('File or directory to search in. Defaults to projectPath or cwd.'),
        file_pattern: z.string().optional().describe('Glob pattern to filter which files to search (e.g., "*.ts", "**/*.tsx")'),
        context_lines: z.number().optional().describe('Number of lines before and after each match to include (default: 0)'),
        case_insensitive: z.boolean().optional().describe('Case insensitive search (default: false)'),
        max_matches: z.number().optional().describe('Maximum total matches to return (default: 500)'),
        ignore: z.array(z.string()).optional().describe('Additional directory names to ignore'),
      }),
      execute: async ({ pattern: searchPattern, path: searchPath, file_pattern, context_lines, case_insensitive, max_matches, ignore }) => {
        try {
          const patternStr = searchPattern as string;
          const flags = (case_insensitive as boolean) ? 'gi' : 'g';
          let regex: RegExp;
          try {
            regex = new RegExp(patternStr, flags);
          } catch (e) {
            return { success: false, error: `Invalid regex: ${patternStr} — ${e instanceof Error ? e.message : String(e)}` };
          }

          // Also create a non-global version for line testing
          const testRegex = new RegExp(patternStr, (case_insensitive as boolean) ? 'i' : '');
          const ctxLines = (context_lines as number | undefined) || 0;
          const maxTotal = (max_matches as number | undefined) || GREP_MAX_MATCHES;

          const rootDir = expandPath((searchPath as string | undefined) || projectPath || process.cwd());
          let filesToSearch: string[];

          // Check if rootDir is a file or directory
          const stat = await fsPromises.stat(rootDir);
          if (stat.isFile()) {
            filesToSearch = [rootDir];
          } else {
            // Determine file pattern for filtering
            const filePatternStr = (file_pattern as string | undefined) || '**/*';
            const fileRegex = globToRegExp(filePatternStr);

            const ignoreNames = new Set(DEFAULT_IGNORE_PATTERNS);
            if (Array.isArray(ignore)) {
              for (const ig of ignore) {
                ignoreNames.add(ig as string);
              }
            }

            filesToSearch = await walkAndMatch(rootDir, fileRegex, ignoreNames, GLOB_MAX_RESULTS);
          }

          const allMatches: Array<{
            file: string;
            line: number;
            content: string;
            context?: string[];
          }> = [];
          let totalMatches = 0;

          for (const filePath of filesToSearch) {
            if (totalMatches >= maxTotal) break;

            // Skip binary files
            try {
              if (await isBinaryFile(filePath)) continue;
            } catch {
              continue;
            }

            try {
              const fileMatches = await searchFileContents(filePath, testRegex, ctxLines);
              for (const m of fileMatches) {
                if (totalMatches >= maxTotal) break;
                allMatches.push({
                  file: filePath,
                  line: m.line,
                  content: m.content,
                  ...(m.context ? { context: m.context } : {}),
                });
                totalMatches++;
              }
            } catch {
              // Permission denied, encoding error, etc. — skip file
              continue;
            }
          }

          return {
            success: true,
            pattern: patternStr,
            root: rootDir,
            matchCount: allMatches.length,
            filesSearched: filesToSearch.length,
            matches: allMatches,
            truncated: totalMatches >= maxTotal,
          };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    // ===== Agent Lifecycle Self-Registration Tools =====

    register_self: {
      description: 'Register this agent as active with the Crewly backend. Call this immediately on startup.',
      inputSchema: z.object({
        role: z.string().describe('Agent role (e.g., "developer", "orchestrator")'),
      }),
      execute: async ({ role }) => {
        const result = await client.post('/teams/members/register', {
          role,
          sessionName,
        });
        return result.success ? result.data : { error: result.error };
      },
    },

    get_project_overview: {
      description: 'Get an overview of all configured projects.',
      inputSchema: z.object({}),
      execute: async () => {
        const result = await client.get('/projects');
        return result.success ? result.data : { error: result.error };
      },
    },

    report_status: {
      description: 'Report task status to the orchestrator. sessionName and role are auto-injected from the current session context.',
      inputSchema: z.object({
        status: z.enum(['in_progress', 'done', 'blocked', 'error']).describe('Current status'),
        summary: z.string().describe('Brief status summary'),
      }),
      execute: async ({ status, summary }) => {
        // Build status message matching the bash report-status format
        const statusUpper = (status as string).toUpperCase();
        const message = `[${statusUpper}] Agent ${sessionName}: ${summary}`;

        // Send to orchestrator via chat API (matches bash skill behavior)
        const chatBody: Record<string, string> = {
          content: message,
          senderName: sessionName,
          senderType: 'agent',
        };
        if (conversationId) {
          chatBody.conversationId = conversationId;
        }
        const result = await client.post('/chat/agent-response', chatBody);

        // Auto-complete the agent's currently-running WorkItem when done.
        // V3-only as of spec 2026-05-06-task-management-v1-deprecation.md:
        // resolve the running claim from the pool, then call
        // `/task-pool/complete/:id`. Replaces v1 `/task-management/complete-by-session`.
        if (status === 'done') {
          try {
            const poolResp = await client.get(
              `/task-pool/items?status=running&target=${encodeURIComponent(sessionName)}`,
            );
            const items = (poolResp.data as Record<string, unknown> | undefined);
            const list = (
              (items?.workItems as Array<{ id: string }> | undefined) ??
              (items?.data as Array<{ id: string }> | undefined) ??
              (Array.isArray(items) ? items as Array<{ id: string }> : [])
            );
            const wiId = list[0]?.id;
            if (wiId) {
              // Hygiene #4: canonical body shape `{agentId, result:{summary}}`.
              // `agentId` here is `sessionName` because that's the runtime
              // identity of the completing agent (the session whose
              // status=done message triggered this auto-complete path).
              await client
                .post(`/task-pool/complete/${wiId}`, {
                  agentId: sessionName,
                  result: { summary },
                })
                .catch(() => {});
            }
          } catch {
            // Non-fatal: status report still succeeded.
          }
        }

        // Auto-persist key findings as project knowledge when done (#127)
        if (status === 'done' && summary && projectPath) {
          await client.post('/memory/remember', {
            agentId: sessionName,
            content: `Task completed by ${sessionName}: ${summary}`,
            category: 'pattern',
            scope: 'project',
            projectPath,
          }).catch(() => {});
        }

        return result.success ? result.data : { error: result.error };
      },
    },

    // ===== Context Compaction Tool =====

    compact_memory: {
      description: 'Proactively compact conversation context to preserve critical state while freeing token budget. Use when context is growing large or before starting a new phase of work. Generates an AI-powered structured summary of older messages preserving: active tasks, decisions, findings, blockers, and current context.',
      inputSchema: z.object({}),
      sensitivity: 'safe',
      execute: async () => {
        if (!callbacks?.onCompactMemory) {
          return { success: false, error: 'Compaction not available — no runner callback configured' };
        }
        const result = await callbacks.onCompactMemory();
        return {
          success: result.compacted,
          ...result,
        };
      },
    },

    get_context_budget: {
      description: 'Check current context window token budget usage. Returns total tokens used, context window size, usage percentage, and warning level (normal/warning/critical). Use proactively to decide when to compact or wrap up work.',
      inputSchema: z.object({}),
      sensitivity: 'safe',
      execute: async () => {
        if (!callbacks?.onGetContextBudget) {
          return { success: false, error: 'Context budget tracking not available — no runner callback configured' };
        }
        const budget = callbacks.onGetContextBudget();
        return { success: true, ...budget };
      },
    },

    // ===== Security Audit Tool =====

    get_audit_log: {
      description: 'Retrieve the security audit trail of recent tool invocations. Shows tool name, sensitivity classification, success/failure, duration, and sanitized arguments. Use for security review, debugging, or compliance.',
      inputSchema: z.object({
        limit: z.number().default(50).describe('Maximum entries to return (most recent first)'),
        sensitivity: z.enum(['safe', 'sensitive', 'destructive']).optional().describe('Filter by sensitivity level'),
        toolName: z.string().optional().describe('Filter by specific tool name'),
      }),
      sensitivity: 'safe',
      execute: async ({ limit, sensitivity: filterSensitivity, toolName: filterTool }) => {
        if (!callbacks?.onGetAuditLog) {
          return {
            success: false,
            error: 'Audit log not available — no runner callback configured',
          };
        }

        const filters: AuditLogFilters = {
          limit: (limit as number) || 50,
          sensitivity: filterSensitivity as ToolSensitivity | undefined,
          toolName: filterTool as string | undefined,
        };
        const entries = callbacks.onGetAuditLog(filters);

        return {
          success: true,
          totalEntries: entries.length,
          filters: {
            limit: filters.limit,
            sensitivity: filters.sensitivity || 'all',
            toolName: filters.toolName || 'all',
          },
          entries,
        };
      },
    },

    // ===================================================================
    // Shell Execution (#176)
    // ===================================================================

    bash_exec: {
      description: 'Execute a shell command and return stdout/stderr. Commands run with a timeout (default 60s, max 300s). Use for build, test, lint, system operations, and skill scripts. Some commands (kill, reboot, rm -rf /, etc.) are blocked by security policy.',
      inputSchema: z.object({
        command: z.string().describe('Shell command to execute'),
        cwd: z.string().optional().describe('Working directory (defaults to project path)'),
        timeout: z.number().optional().describe('Timeout in milliseconds (default: 60000, max: 300000)'),
      }),
      sensitivity: 'destructive' as ToolSensitivity,
      execute: async ({ command, cwd, timeout }) => {
        const cmd = command as string;

        // Check command against blocklist before execution
        const blockReason = validateBashCommand(cmd);
        if (blockReason) {
          return {
            success: false,
            exitCode: 126,
            stdout: '',
            stderr: blockReason,
            error: blockReason,
          };
        }

        // Check if command requires explicit approval (git push, rm, docker, network, etc.)
        // Only enforce if the security policy's requireApproval includes 'destructive'.
        const approvalLabel = checkBashApprovalRequired(cmd);
        if (approvalLabel && callbacks?.onEnqueueApproval && callbacks?.onCheckApproval) {
          const policyCheck = callbacks.onCheckApproval('bash_exec', 'destructive');
          if (!policyCheck.allowed && !policyCheck.blocked) {
            const sanitizedArgs = sanitizeArgs({ command: cmd, cwd, timeout });
            const enqueued = callbacks.onEnqueueApproval('bash_exec', 'destructive', sanitizedArgs);
            return {
              success: false,
              requiresApproval: true,
              approvalId: enqueued.approvalId,
              reason: `Command requires approval: ${approvalLabel}`,
              error: `Approval required for: ${approvalLabel}. Approval ID: ${enqueued.approvalId}`,
            };
          }
        }

        const workDir = expandPath((cwd as string | undefined) || projectPath || process.cwd());
        const timeoutMs = Math.min((timeout as number | undefined) || 60000, 300000);

        // Validate working directory exists — spawn gives cryptic "ENOENT" if cwd is missing
        try { await fsPromises.stat(workDir); } catch {
          return {
            success: false,
            exitCode: 1,
            stdout: '',
            stderr: `Working directory does not exist: ${workDir}`,
            error: `Working directory does not exist: ${workDir}`,
          };
        }

        // Run in isolated process group to prevent signal propagation (async, non-blocking)
        const result = await execIsolatedAsync(cmd, workDir, timeoutMs);

        if (result.exitCode === 0) {
          const truncated = result.stdout.length > 10000;
          return {
            success: true,
            exitCode: 0,
            stdout: truncated ? result.stdout.slice(-10000) + '\n...(truncated)' : result.stdout,
            truncated,
          };
        }

        return {
          success: false,
          exitCode: result.exitCode,
          stdout: (result.stdout || '').slice(-5000),
          stderr: (result.stderr || '').slice(-5000),
          error: result.stderr ? result.stderr.slice(0, 500) : `Process exited with code ${result.exitCode}`,
        };
      },
    },

    // ===================================================================
    // Git Tools (#176)
    // ===================================================================

    git_status: {
      description: 'Get the git status of a project directory. Returns current branch, staged files, unstaged changes, and untracked files.',
      inputSchema: z.object({
        projectPath: z.string().describe('Absolute path to the git repository'),
      }),
      execute: async ({ projectPath }) => {
        const cwd = expandPath(projectPath as string);
        try {
          const branch = (await execGitAsync('git rev-parse --abbrev-ref HEAD', cwd)).trim();
          const statusOutput = await execGitAsync('git status --porcelain', cwd);

          const staged: string[] = [];
          const unstaged: string[] = [];
          const untracked: string[] = [];

          for (const line of statusOutput.split('\n')) {
            if (!line.trim()) continue;
            const x = line[0]; // index status
            const y = line[1]; // working tree status
            const file = line.slice(3);
            if (x === '?' && y === '?') {
              untracked.push(file);
            } else {
              if (x !== ' ' && x !== '?') staged.push(file);
              if (y !== ' ' && y !== '?') unstaged.push(file);
            }
          }

          return { success: true, branch, staged, unstaged, untracked };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    git_diff: {
      description: 'Get the git diff output for a project directory. Shows unstaged changes by default, or staged changes when staged=true. Output truncated to 5000 characters.',
      inputSchema: z.object({
        projectPath: z.string().describe('Absolute path to the git repository'),
        staged: z.boolean().default(false).describe('Show staged (cached) changes instead of unstaged'),
      }),
      execute: async ({ projectPath, staged }) => {
        const cwd = expandPath(projectPath as string);
        try {
          const cmd = staged ? 'git diff --cached' : 'git diff';
          const diff = await execGitAsync(cmd, cwd);

          const truncated = diff.length > GIT_DIFF_MAX_CHARS;
          const output = truncated ? diff.slice(0, GIT_DIFF_MAX_CHARS) + '\n... (truncated)' : diff;

          return { success: true, diff: output, truncated, totalLength: diff.length };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    git_commit: {
      description: 'Stage files and create a git commit. If files are provided, stages only those files. Otherwise stages all changes (git add -A). Returns the new commit hash.',
      inputSchema: z.object({
        projectPath: z.string().describe('Absolute path to the git repository'),
        message: z.string().describe('Commit message'),
        files: z.array(z.string()).optional().describe('Specific files to stage (omit for git add -A)'),
      }),
      sensitivity: 'sensitive' as ToolSensitivity,
      execute: async ({ projectPath, message, files }) => {
        const cwd = expandPath(projectPath as string);
        try {
          // Stage files
          if (files && (files as string[]).length > 0) {
            for (const file of files as string[]) {
              await execGitAsync(`git add -- ${JSON.stringify(file)}`, cwd);
            }
          } else {
            await execGitAsync('git add -A', cwd);
          }

          // Commit
          await execGitAsync(`git commit -m ${JSON.stringify(message as string)}`, cwd);

          // Get the commit hash
          const hash = (await execGitAsync('git rev-parse HEAD', cwd)).trim();

          return { success: true, commitHash: hash, message: message as string };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    },

    // ===================================================================
    // Task Handoff (F12)
    // ===================================================================

    handoff_task: {
      description: 'Hand off an in-progress task to another agent with full context (progress, findings, blockers). Unlike delegate_task which assigns NEW work, handoff transfers ONGOING work so the receiving agent can continue where you left off.',
      inputSchema: z.object({
        to: z.string().describe('Target agent session name to hand off to'),
        reason: z.string().describe('Why you are handing off (blocked, expertise needed, etc.)'),
        progress: z.string().optional().describe('Current progress summary (what is done so far)'),
        findings: z.string().optional().describe('Key findings and decisions made'),
        blockers: z.string().optional().describe('Current blockers or notes for the receiving agent'),
        workItemId: z.string().optional().describe('WorkItem id being handed off (resolved from running claim if omitted)'),
      }),
      sensitivity: 'sensitive' as ToolSensitivity,
      execute: async ({ to, reason, progress, findings, blockers, workItemId }) => {
        const target = to as string;
        const handoffReason = reason as string;

        // Build handoff context message
        let message = `[TASK HANDOFF] from ${sessionName}\n\n## Reason\n${handoffReason}\n`;
        if (progress) message += `\n## Progress\n${progress}\n`;
        if (findings) message += `\n## Key Findings\n${findings}\n`;
        if (blockers) message += `\n## Blockers / Notes\n${blockers}\n`;

        if (projectPath) {
          message += `\n---\nWhen done, report back using: bash config/skills/agent/core/report-status/execute.sh '{"sessionName":"${target}","status":"done","summary":"<brief summary>","projectPath":"${projectPath}"}'`;
        }

        // Deliver to target agent
        const deliverResult = await client.post(`/terminal/${target}/deliver`, {
          message,
          waitForReady: true,
          waitTimeout: 15000,
        }).catch(async () => {
          // Retry with force
          return client.post(`/terminal/${target}/deliver`, { message, force: true });
        });

        // Record handoff via V3 task-pool (spec
        // 2026-05-06-task-management-v1-deprecation.md). Replaces
        // v1 `/task-management/handoff`. Resolves the source WI from
        // the running claim if `workItemId` was not supplied.
        let resolvedWiId = workItemId as string | undefined;
        if (!resolvedWiId) {
          try {
            const poolResp = await client.get(
              `/task-pool/items?status=running&target=${encodeURIComponent(sessionName)}`,
            );
            const data = poolResp.data as Record<string, unknown> | undefined;
            const list = (
              (data?.workItems as Array<{ id: string }> | undefined) ??
              (data?.data as Array<{ id: string }> | undefined) ??
              []
            );
            resolvedWiId = list[0]?.id;
          } catch {
            // fall through — handoff tracking will be marked unavailable
          }
        }
        const handoffRecord = resolvedWiId
          ? await client.post(`/task-pool/items/${resolvedWiId}/handoff`, {
              newTarget: target,
              fromAgent: sessionName,
              reason: handoffReason,
            }).catch(() => ({ success: false, error: 'handoff API unavailable' }))
          : { success: false, error: 'no active WorkItem to hand off' };

        return {
          success: deliverResult?.success ?? false,
          handoff: {
            from: sessionName,
            to: target,
            reason: handoffReason,
            timestamp: new Date().toISOString(),
          },
          delivery: deliverResult?.success ? 'delivered' : (deliverResult?.error || 'failed'),
          tracking: handoffRecord?.success ? 'tracked' : 'not tracked',
        };
      },
    },

    // ===== Cloud-Backed Web Search =====

    web_search: createWebSearchTool(),
  };

  // Apply sensitivity classifications and audit wrapping
  const tools: Record<string, ToolDefinition> = {};
  for (const [name, tool] of Object.entries(rawTools)) {
    tools[name] = {
      ...tool,
      sensitivity: tool.sensitivity || TOOL_SENSITIVITY[name] || 'safe',
      execute: wrapWithAudit(name, tool.execute, callbacks),
    };
  }

  // Merge MCP-sourced tools with audit wrapping
  if (mcpTools) {
    for (const [name, tool] of Object.entries(mcpTools)) {
      tools[name] = {
        ...tool,
        execute: wrapWithAudit(name, tool.execute, callbacks),
      };
    }
  }

  return tools;
}

/**
 * Build a structured task message matching the delegate-task skill format.
 *
 * @param to - Target agent session
 * @param task - Task instructions
 * @param priority - Task priority
 * @param context - Optional additional context
 * @param projectPath - Optional project path
 * @returns Formatted task message string
 */
function buildTaskMessage(
  to: string,
  task: string,
  priority: string,
  context?: string,
  projectPath?: string,
): string {
  let message = `New task from orchestrator (priority: ${priority}):\n\n${task}`;
  if (context) message += `\n\nContext: ${context}`;
  if (projectPath) {
    message += `\n\nWhen done, report back using: bash config/skills/agent/core/report-status/execute.sh '{"sessionName":"${to}","status":"done","summary":"<brief summary>","projectPath":"${projectPath}"}'`;
  }
  return message;
}

/**
 * Get the list of tool names available in the registry.
 *
 * @returns Array of tool name strings
 */
export function getToolNames(): string[] {
  return [
    'delegate_task', 'send_message', 'get_agent_status', 'get_team_status',
    'get_agent_logs', 'reply_slack', 'schedule_check', 'cancel_schedule',
    'get_scheduled_checks', 'start_agent', 'stop_agent', 'subscribe_event',
    'recall_memory', 'remember', 'heartbeat', 'get_tasks', 'complete_task',
    'broadcast', 'handle_agent_failure', 'edit_file', 'read_file', 'write_file',
    'glob', 'grep',
    'register_self', 'get_project_overview', 'report_status',
    'compact_memory', 'get_audit_log',
    'git_status', 'git_diff', 'git_commit',
    'web_search',
  ];
}
