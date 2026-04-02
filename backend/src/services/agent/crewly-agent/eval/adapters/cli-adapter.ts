/**
 * CLI Adapter for the Evaluation Framework
 *
 * Generic adapter that spawns CLI-based agent runtimes (Claude Code,
 * Codex CLI, Gemini CLI) as child processes. Each runtime receives
 * the same CONTEXT.md, skill scripts, and fixtures — no Crewly SDK
 * required.
 *
 * Tool call tracking is done via the `.crewly/.tool-log.jsonl` file
 * written by the eval skill shims, plus filesystem diffing to infer
 * file read/write operations.
 *
 * @module eval/adapters/cli-adapter
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  AdapterConfig,
  EvalTask,
  RuntimeAdapter,
  RuntimeId,
  RuntimeResult,
} from '../eval-types.js';
import { parseToolLog, mergeToolCallRecords } from '../tool-log-parser.js';
import type { ToolCallRecord } from '../../types.js';

// ---------------------------------------------------------------------------
// CLI-specific config
// ---------------------------------------------------------------------------

/**
 * Extended adapter configuration for CLI-based runtimes.
 */
export interface CLIAdapterConfig extends AdapterConfig {
  /** Command to launch the CLI (e.g. "claude", "codex", "gemini") */
  cliCommand: string;
  /** CLI-specific flags (e.g. ["--dangerously-skip-permissions"]) */
  cliFlags: string[];
  /** Whether to use non-interactive/print mode */
  printMode: boolean;
}

/**
 * Default CLI configurations for each supported runtime.
 */
export const CLI_DEFAULTS: Readonly<Record<string, Omit<CLIAdapterConfig, keyof AdapterConfig>>> = {
  'claude-code': {
    cliCommand: 'claude',
    cliFlags: ['--print', '--dangerously-skip-permissions'],
    printMode: true,
  },
  'codex-cli': {
    cliCommand: 'codex',
    // `codex exec` is the non-interactive subcommand
    // --full-auto = auto-approve all tool calls with sandboxed execution
    // --skip-git-repo-check = eval workspaces aren't git repos
    cliFlags: ['exec', '--full-auto', '--skip-git-repo-check'],
    printMode: true,
  },
  'gemini-cli': {
    cliCommand: 'gemini',
    // -y = auto-approve all tool calls (YOLO mode)
    // prompt is passed via -p flag (non-interactive/headless mode)
    cliFlags: ['-y'],
    printMode: true,
  },
} as const;

// ---------------------------------------------------------------------------
// File snapshot (for inferring file operations)
// ---------------------------------------------------------------------------

/**
 * Snapshot of files in a directory, used to detect changes.
 */
interface FileSnapshot {
  /** Map of relative path → content hash (mtime + size) */
  files: Map<string, string>;
}

/**
 * Take a snapshot of all files in a directory (non-recursive into node_modules).
 *
 * @param dir - directory to snapshot
 * @returns file snapshot
 */
function takeSnapshot(dir: string): FileSnapshot {
  const files = new Map<string, string>();
  walkDir(dir, dir, files);
  return { files };
}

/**
 * Recursively walk a directory and record file metadata.
 *
 * @param baseDir  - root directory for relative paths
 * @param dir      - current directory being walked
 * @param files    - map to populate
 */
function walkDir(baseDir: string, dir: string, files: Map<string, string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(baseDir, fullPath, files);
    } else if (entry.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        const rel = path.relative(baseDir, fullPath);
        files.set(rel, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        // Skip inaccessible files
      }
    }
  }
}

/**
 * Diff two file snapshots to produce inferred tool call records.
 *
 * New files → write_file tool calls.
 * Modified files → edit_file tool calls.
 * Deleted files → delete_file tool calls (rare but possible).
 *
 * @param before  - snapshot taken before the CLI ran
 * @param after   - snapshot taken after the CLI ran
 * @param workDir - absolute path for reconstructing file paths
 * @returns inferred tool call records
 */
function diffSnapshots(
  before: FileSnapshot,
  after: FileSnapshot,
  workDir: string,
): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];

  // New or modified files
  for (const [relPath, hash] of after.files) {
    const beforeHash = before.files.get(relPath);
    if (!beforeHash) {
      records.push({
        toolName: 'write_file',
        args: { path: path.join(workDir, relPath) },
        result: { inferred: true },
      });
    } else if (beforeHash !== hash) {
      records.push({
        toolName: 'edit_file',
        args: { path: path.join(workDir, relPath) },
        result: { inferred: true },
      });
    }
  }

  // Deleted files
  for (const relPath of before.files.keys()) {
    if (!after.files.has(relPath)) {
      records.push({
        toolName: 'delete_file',
        args: { path: path.join(workDir, relPath) },
        result: { inferred: true },
      });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------
// CLI process execution
// ---------------------------------------------------------------------------

/**
 * Result of executing a CLI process.
 */
interface CLIProcessResult {
  /** Combined stdout */
  stdout: string;
  /** Combined stderr */
  stderr: string;
  /** Exit code (null if killed) */
  exitCode: number | null;
  /** Whether the process was killed due to timeout */
  timedOut: boolean;
  /** Wall-clock duration in milliseconds */
  durationMs: number;
}

/**
 * Spawn a CLI process and capture its output.
 *
 * @param command   - CLI command to run
 * @param args      - command arguments
 * @param cwd       - working directory
 * @param timeoutMs - timeout in milliseconds
 * @returns process result with stdout, stderr, exit code, and timing
 */
function runCLIProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CLIProcessResult> {
  return new Promise((resolve) => {
    const startMs = Date.now();
    let timedOut = false;

    const proc = execFile(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - startMs;

      if (error && 'killed' in error && error.killed) {
        timedOut = true;
      }

      // Detect timeout via duration even when the process exits cleanly
      // after receiving SIGTERM (e.g. Codex CLI exits 0 on signal).
      if (!timedOut && durationMs >= timeoutMs * 0.95) {
        timedOut = true;
      }

      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error ? (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? null : 1 : 0,
        timedOut,
        durationMs,
      });
    });

    // Close stdin immediately so CLIs that read from stdin (e.g. Codex CLI)
    // receive EOF and proceed with the prompt argument instead of hanging.
    proc.stdin?.end();

    // Safety: ensure process doesn't outlive timeout
    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeoutMs + 1000);

    proc.on('exit', () => clearTimeout(killTimer));
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * RuntimeAdapter implementation for CLI-based agent runtimes.
 *
 * Supports Claude Code (`claude --print`), Codex CLI (`codex --quiet`),
 * and Gemini CLI (`gemini --sandbox=none`).
 *
 * Tool call tracking combines:
 * 1. Skill log (`.crewly/.tool-log.jsonl`) — written by bash skill shims
 * 2. Filesystem diff — infers read/write/edit operations from file changes
 *
 * @example
 * ```typescript
 * const adapter = new CLIAdapter();
 * await adapter.initialize({
 *   runtimeId: 'claude-code',
 *   model: 'claude-sonnet-4',
 *   workDir: '/tmp/eval',
 * });
 * const result = await adapter.runTask(task, '/tmp/eval/task-dir');
 * await adapter.shutdown();
 * ```
 */
export class CLIAdapter implements RuntimeAdapter {
  private config: CLIAdapterConfig | null = null;
  private runtimeId: RuntimeId | null = null;

  /**
   * Initialize the adapter with CLI-specific configuration.
   *
   * Merges the base AdapterConfig with CLI defaults for the specified runtime.
   * Verifies the CLI command is accessible.
   *
   * @param config - adapter configuration
   */
  async initialize(config: AdapterConfig): Promise<void> {
    const defaults = CLI_DEFAULTS[config.runtimeId];
    if (!defaults) {
      throw new Error(
        `No CLI defaults for runtime "${config.runtimeId}". ` +
        `Supported: ${Object.keys(CLI_DEFAULTS).join(', ')}`,
      );
    }

    this.runtimeId = config.runtimeId;
    this.config = {
      ...config,
      ...defaults,
      // Allow options override
      cliCommand: (config.options?.cliCommand as string) ?? defaults.cliCommand,
      cliFlags: (config.options?.cliFlags as string[]) ?? defaults.cliFlags,
      printMode: (config.options?.printMode as boolean) ?? defaults.printMode,
    };

    // Verify CLI is accessible
    await this.verifyCLI();
  }

  /**
   * Execute a single eval task by spawning the CLI process.
   *
   * Steps:
   * 1. Snapshot the work directory (before)
   * 2. Build CLI command with task prompt
   * 3. Spawn process, capture output, enforce timeout
   * 4. Snapshot the work directory (after)
   * 5. Parse skill log + diff files → tool call records
   * 6. Return RuntimeResult
   *
   * @param task    - task definition
   * @param workDir - absolute path to the task's work directory
   * @returns runtime result
   */
  async runTask(task: EvalTask, workDir: string): Promise<RuntimeResult> {
    if (!this.config) {
      throw new Error('Adapter not initialized. Call initialize() first.');
    }

    // 1. Pre-snapshot
    const beforeSnapshot = takeSnapshot(workDir);

    // 2. Build command args
    const args = this.buildArgs(task.prompt);

    // 3. Run CLI process
    const procResult = await runCLIProcess(
      this.config.cliCommand,
      args,
      workDir,
      task.timeoutMs,
    );

    // 4. Post-snapshot
    const afterSnapshot = takeSnapshot(workDir);

    // 5. Build tool call records
    const skillRecords = parseToolLog(workDir);
    const fsRecords = diffSnapshots(beforeSnapshot, afterSnapshot, workDir);
    const allToolCalls = mergeToolCallRecords(fsRecords, skillRecords);

    // 6. Build result
    return {
      success: procResult.exitCode === 0 && !procResult.timedOut,
      output: procResult.stdout + (procResult.stderr ? `\n[stderr]\n${procResult.stderr}` : ''),
      durationMs: procResult.durationMs,
      steps: this.estimateSteps(procResult.stdout),
      usage: this.extractUsage(procResult.stdout, procResult.stderr),
      toolCalls: allToolCalls,
      humanNudges: 0,
      timedOut: procResult.timedOut,
      loopDetected: this.detectLoop(procResult.stdout),
      error: procResult.timedOut
        ? 'Process timed out'
        : procResult.exitCode !== 0
          ? `Process exited with code ${procResult.exitCode}`
          : undefined,
    };
  }

  /**
   * Shut down the adapter. No persistent resources to clean up for CLI adapters.
   */
  async shutdown(): Promise<void> {
    this.config = null;
    this.runtimeId = null;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Verify the CLI command is accessible by running --version or --help.
   *
   * @throws Error if the CLI is not found
   */
  private async verifyCLI(): Promise<void> {
    if (!this.config) return;

    const result = await runCLIProcess(
      this.config.cliCommand,
      ['--version'],
      process.cwd(),
      10_000,
    );

    if (result.exitCode !== 0 && !result.stdout && !result.stderr) {
      throw new Error(
        `CLI "${this.config.cliCommand}" not found or not accessible. ` +
        `Ensure it is installed and in PATH.`,
      );
    }
  }

  /**
   * Build CLI arguments for a task prompt.
   *
   * Each CLI has a different way to pass the prompt:
   * - Claude Code: `claude --print "prompt"` (positional arg)
   * - Codex CLI: `codex exec --approval-mode full-auto "prompt"` (positional after exec)
   * - Gemini CLI: `gemini -y -p "prompt"` (-p flag for non-interactive)
   *
   * @param prompt - task prompt text
   * @returns array of CLI arguments
   */
  private buildArgs(prompt: string): string[] {
    if (!this.config) return [];

    const args = [...this.config.cliFlags];

    switch (this.runtimeId) {
      case 'gemini-cli':
        // Gemini uses -p flag for non-interactive (headless) mode
        args.push('-p', prompt);
        break;
      case 'claude-code':
      case 'codex-cli':
      default:
        // Claude Code and Codex accept prompt as positional argument
        args.push(prompt);
        break;
    }

    return args;
  }

  /**
   * Estimate the number of reasoning steps from CLI output.
   *
   * Heuristic: count distinct tool use markers or action blocks.
   *
   * @param stdout - CLI stdout
   * @returns estimated step count
   */
  private estimateSteps(stdout: string): number {
    // Common patterns in CLI output that indicate a step
    const patterns = [
      /\[tool:/gi,           // Claude Code tool markers
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/g, // Spinner characters
      /Running:/gi,          // Codex action markers
      /```/g,                // Code blocks (rough proxy)
    ];

    let maxMatches = 0;
    for (const pattern of patterns) {
      const matches = stdout.match(pattern);
      if (matches && matches.length > maxMatches) {
        maxMatches = matches.length;
      }
    }

    // Fallback: estimate from output length (1 step per ~500 chars)
    return Math.max(1, maxMatches || Math.ceil(stdout.length / 500));
  }

  /**
   * Extract token usage from CLI output.
   *
   * CLIs don't always report usage. Return zeros when not available.
   *
   * @param stdout - CLI stdout
   * @param stderr - CLI stderr
   * @returns token usage estimates
   */
  private extractUsage(stdout: string, stderr: string): { input: number; output: number } {
    // Try to parse Claude Code's usage line: "Total tokens: X input, Y output"
    const combined = stdout + stderr;
    const usageMatch = combined.match(/(\d[\d,]+)\s*input.*?(\d[\d,]+)\s*output/i);
    if (usageMatch) {
      return {
        input: parseInt(usageMatch[1].replace(/,/g, ''), 10),
        output: parseInt(usageMatch[2].replace(/,/g, ''), 10),
      };
    }

    // Estimate from output length if no explicit usage
    // Rough: 1 token ≈ 4 chars
    return {
      input: Math.ceil(stdout.length / 4),
      output: Math.ceil(stdout.length / 4),
    };
  }

  /**
   * Detect whether the CLI output indicates a loop.
   *
   * @param stdout - CLI stdout
   * @returns true if loop-like patterns detected
   */
  private detectLoop(stdout: string): boolean {
    // Look for repeated identical blocks (sign of a loop)
    const lines = stdout.split('\n');
    if (lines.length < 20) return false;

    // Check if the last 10 lines are identical to 10 lines before that
    const lastBlock = lines.slice(-10).join('\n');
    const prevBlock = lines.slice(-20, -10).join('\n');
    return lastBlock === prevBlock && lastBlock.length > 50;
  }
}
