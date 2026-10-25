/**
 * Shell utility functions for the eval runner.
 */

import { exec } from 'node:child_process';

/**
 * Find the full path of a command, similar to Unix `which`.
 * Returns null if the command is not found.
 *
 * @param cmd - Command name to locate
 * @returns Absolute path to the command, or null if not found
 */
export function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    exec(`which ${cmd}`, (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout.trim() || null);
      }
    });
  });
}

/**
 * Run a shell command and return stdout, stderr, and exit code.
 *
 * @param command - Shell command to execute
 * @param cwd - Working directory
 * @param timeoutMs - Timeout in milliseconds (default: 120000)
 * @returns stdout, stderr, and exit code
 */
export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number = 120_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0,
      });
    });
  });
}
