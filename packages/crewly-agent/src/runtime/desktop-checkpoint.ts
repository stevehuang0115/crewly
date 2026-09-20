/**
 * Checkpoints — how a desktop subgoal is judged done.
 *
 * Phase 4 of docs/research/computer-use-capability-assessment.md. The failure
 * this exists for is the third one in §5.1: the agent says "I saved it" while
 * the save dialog is still open. Its own account of what happened is exactly
 * the thing that cannot be trusted, so a subgoal is complete when something
 * outside the agent says so — a file on disk, an element on screen, a command
 * that exits zero.
 *
 * Checkpoints are deliberately narrow. Each one is a small, decidable
 * question with a yes or no answer and a reason when it is no, because a
 * model that is told "the file has 0 bytes" can act, where one told "task
 * failed" can only guess.
 *
 * @module runtime/desktop-checkpoint
 */

import { spawn } from 'child_process';
import { promises as fs } from 'fs';

/** How long a shell checkpoint may take before it counts as failed. */
const SHELL_TIMEOUT_MS = 15_000;

/**
 * A decidable statement about the world after a subgoal.
 *
 * `shell` is the escape hatch, but the named kinds are preferred: they give a
 * usable reason on failure, where a shell command can only give an exit code.
 */
export type Checkpoint =
  /** A file exists and, unless `allowEmpty`, has content. */
  | { kind: 'file-exists'; path: string; allowEmpty?: boolean }
  /** A file exists and contains this text. */
  | { kind: 'file-contains'; path: string; text: string }
  /** A file exists and matches this pattern. */
  | { kind: 'file-matches'; path: string; pattern: string }
  /** A file is gone (a rename's other half, a cleanup). */
  | { kind: 'file-absent'; path: string }
  /** This application is in front. */
  | { kind: 'app-frontmost'; app: string }
  /** An element with this name (and optionally role) is on screen. */
  | { kind: 'element-present'; name: string; role?: string; app?: string }
  /** No element with this name is on screen — a dialog that should be gone. */
  | { kind: 'element-absent'; name: string; app?: string }
  /** This text is readable on screen. */
  | { kind: 'text-on-screen'; text: string }
  /** This command exits zero. */
  | { kind: 'shell'; command: string; description?: string };

/** The answer, with enough detail to act on. */
export interface CheckpointResult {
  passed: boolean;
  /** Why not, phrased for the model to act on. Absent when it passed. */
  reason?: string;
  /** What was actually observed, when that helps more than prose. */
  observed?: string;
}

/** Injectable IO, so the evaluator is testable without a desktop. */
export interface CheckpointDeps {
  readFile?: (path: string) => Promise<string>;
  statFile?: (path: string) => Promise<{ size: number }>;
  runShell?: (command: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Elements currently on screen, from a desktop snapshot. */
  snapshot?: (app?: string) => Promise<Array<{ role: string; name?: string }>>;
  /** Text currently on screen, from OCR. */
  screenText?: () => Promise<string[]>;
  /** The frontmost application's name. */
  frontmostApp?: () => Promise<string>;
}

/**
 * Run a shell command, capturing its outcome rather than throwing.
 *
 * @param command - The command
 * @returns Exit code and output
 */
async function defaultShell(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, stdout, stderr: `timed out after ${SHELL_TIMEOUT_MS}ms` });
    }, SHELL_TIMEOUT_MS);
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}

/**
 * Describe a checkpoint in words, for a plan the owner might read.
 *
 * @param checkpoint - The checkpoint
 * @returns One line
 *
 * @example
 * describeCheckpoint({ kind: 'file-contains', path: '/tmp/a.txt', text: 'ok' })
 * // → '/tmp/a.txt contains "ok"'
 */
export function describeCheckpoint(checkpoint: Checkpoint): string {
  switch (checkpoint.kind) {
    case 'file-exists': return `${checkpoint.path} exists${checkpoint.allowEmpty ? '' : ' and is not empty'}`;
    case 'file-contains': return `${checkpoint.path} contains "${checkpoint.text}"`;
    case 'file-matches': return `${checkpoint.path} matches /${checkpoint.pattern}/`;
    case 'file-absent': return `${checkpoint.path} is gone`;
    case 'app-frontmost': return `${checkpoint.app} is in front`;
    case 'element-present': return `"${checkpoint.name}" is on screen`;
    case 'element-absent': return `"${checkpoint.name}" is no longer on screen`;
    case 'text-on-screen': return `"${checkpoint.text}" is readable on screen`;
    case 'shell': return checkpoint.description ?? `\`${checkpoint.command}\` succeeds`;
  }
}

/**
 * Decide whether a checkpoint holds.
 *
 * Never throws: an unreadable file or a crashed command is a failed
 * checkpoint with a reason, not an exception for the caller to interpret.
 *
 * @param checkpoint - What to check
 * @param deps - Injected IO
 * @returns Whether it holds, and why not when it does not
 *
 * @example
 * await evaluateCheckpoint({ kind: 'file-contains', path: '/tmp/a', text: 'hi' })
 * // → { passed: false, reason: '/tmp/a exists but does not contain "hi"', observed: '…' }
 */
export async function evaluateCheckpoint(
  checkpoint: Checkpoint,
  deps: CheckpointDeps = {},
): Promise<CheckpointResult> {
  const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const statFile = deps.statFile ?? (async (p: string) => ({ size: (await fs.stat(p)).size }));
  const runShell = deps.runShell ?? defaultShell;

  try {
    switch (checkpoint.kind) {
      case 'file-exists': {
        const stat = await statFile(checkpoint.path).catch(() => null);
        if (!stat) return { passed: false, reason: `${checkpoint.path} does not exist.` };
        if (!checkpoint.allowEmpty && stat.size === 0) {
          // An empty file is the signature of a save that opened a dialog and
          // never completed — worth calling out rather than passing.
          return { passed: false, reason: `${checkpoint.path} exists but is empty — the write did not complete.` };
        }
        return { passed: true };
      }

      case 'file-absent': {
        const stat = await statFile(checkpoint.path).catch(() => null);
        return stat
          ? { passed: false, reason: `${checkpoint.path} is still there.` }
          : { passed: true };
      }

      case 'file-contains':
      case 'file-matches': {
        const content = await readFile(checkpoint.path).catch(() => null);
        if (content === null) return { passed: false, reason: `${checkpoint.path} does not exist or cannot be read.` };
        const hit = checkpoint.kind === 'file-contains'
          ? content.includes(checkpoint.text)
          : new RegExp(checkpoint.pattern).test(content);
        if (hit) return { passed: true };
        const wanted = checkpoint.kind === 'file-contains' ? `"${checkpoint.text}"` : `/${checkpoint.pattern}/`;
        return {
          passed: false,
          reason: `${checkpoint.path} exists but does not match ${wanted}.`,
          observed: content.slice(0, 200),
        };
      }

      case 'app-frontmost': {
        if (!deps.frontmostApp) return { passed: false, reason: 'Cannot see which application is in front.' };
        const front = await deps.frontmostApp();
        return front.toLowerCase() === checkpoint.app.toLowerCase()
          ? { passed: true }
          : { passed: false, reason: `${checkpoint.app} is not in front.`, observed: front };
      }

      case 'element-present':
      case 'element-absent': {
        if (!deps.snapshot) return { passed: false, reason: 'Cannot read the elements on screen.' };
        const elements = await deps.snapshot(checkpoint.app);
        const wanted = checkpoint.name.toLowerCase();
        const found = elements.find((e) => {
          if (!e.name || !e.name.toLowerCase().includes(wanted)) return false;
          return checkpoint.kind === 'element-present' && checkpoint.role ? e.role === checkpoint.role : true;
        });
        if (checkpoint.kind === 'element-present') {
          return found
            ? { passed: true }
            : { passed: false, reason: `Nothing called "${checkpoint.name}" is on screen.` };
        }
        return found
          ? { passed: false, reason: `"${checkpoint.name}" is still on screen.`, observed: found.role }
          : { passed: true };
      }

      case 'text-on-screen': {
        if (!deps.screenText) return { passed: false, reason: 'Cannot read the text on screen.' };
        const lines = await deps.screenText();
        const wanted = checkpoint.text.toLowerCase();
        return lines.some((l) => l.toLowerCase().includes(wanted))
          ? { passed: true }
          : { passed: false, reason: `"${checkpoint.text}" is not readable on screen.` };
      }

      case 'shell': {
        const { code, stdout, stderr } = await runShell(checkpoint.command);
        if (code === 0) return { passed: true };
        return {
          passed: false,
          reason: `${describeCheckpoint(checkpoint)} — exited ${code}.`,
          observed: (stderr || stdout).slice(0, 200),
        };
      }
    }
  } catch (err) {
    // A checkpoint that throws is a checkpoint that did not pass. Turning it
    // into an exception would let a broken check read as a broken task.
    return {
      passed: false,
      reason: `Could not check: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
