/**
 * Base executor interface and shared utilities for agent runtimes.
 * All executors implement this interface to provide a uniform execution model.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EvalTask, RuntimeType } from '../types/eval.types.js';

/** Result returned by an executor after running a task */
export interface ExecutionResult {
  /** Whether the agent reported completion (vs timeout/crash) */
  completionType: 'agent_done' | 'timeout' | 'error';
  /** Wall-clock duration in seconds */
  durationSeconds: number;
  /** Total tool calls / commands observed */
  toolCallCount: number;
  /** Estimated cost in USD */
  estimatedCostUsd: number;
  /** Path to the full conversation / log file */
  logPath: string;
  /** Error message if completionType is 'error' */
  error?: string;
}

/** Options passed to executors */
export interface ExecutorOptions {
  /** Working directory for the task */
  workDir: string;
  /** Directory for storing logs */
  logDir: string;
  /** Time limit in minutes */
  timeLimitMinutes: number;
}

/**
 * Abstract base for all agent executors.
 * Provides shared utilities (process spawning, log management, timing).
 */
export abstract class BaseExecutor {
  abstract readonly runtime: RuntimeType;

  /**
   * Execute a task and return the result.
   * @param task - The eval task definition
   * @param options - Execution options (workDir, logDir, timeLimit)
   * @returns Execution result with timing, cost, and log path
   */
  abstract execute(task: EvalTask, options: ExecutorOptions): Promise<ExecutionResult>;

  /**
   * Spawn a child process with timeout handling.
   * Captures all stdout/stderr, enforces time limit, returns structured result.
   *
   * @param command - The command to run
   * @param args - Command arguments
   * @param cwd - Working directory
   * @param timeLimitMs - Timeout in milliseconds
   * @returns Process output, exit code, and whether it timed out
   */
  protected spawnWithTimeout(
    command: string,
    args: string[],
    cwd: string,
    timeLimitMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        // Force kill after 10s grace period
        setTimeout(() => proc.kill('SIGKILL'), 10_000);
      }, timeLimitMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1, timedOut: false });
      });
    });
  }

  /**
   * Save a log file and return the path.
   * @param logDir - Directory to save the log
   * @param taskId - Task identifier for naming
   * @param content - Log content to write
   * @returns Absolute path to the saved log file
   */
  protected async saveLog(logDir: string, taskId: string, content: string): Promise<string> {
    await mkdir(logDir, { recursive: true });
    const logPath = join(logDir, `${taskId}-${this.runtime}-${Date.now()}.log`);
    await writeFile(logPath, content, 'utf-8');
    return logPath;
  }
}
