/**
 * Runtime PID Registry
 *
 * Tracks the OS process ids of spawned agent-runtime PTY sessions so orphaned
 * runtime processes can be reaped after a NON-graceful backend death (crash,
 * OOM-kill, external `kill -9`, or the shutdown force-exit `SIGKILL`-self firing
 * mid-cleanup). Normal teardown (`killSession`/`forceDestroyAll`) already reaps
 * children; the gap this closes is the cross-restart one — a fresh backend has
 * no record of the previous run's children, so they live on indefinitely
 * (issue #715: ~7 stray `gemini --yolo` on Irissair since Feb).
 *
 * Safety is the whole point. The startup reaper:
 *   1. only ever touches PIDs THIS backend recorded (never a broad `pkill`),
 *   2. re-reads each live PID's command line and kills it ONLY if it still
 *      matches the recorded spawn signature — so a PID reused by an unrelated
 *      process after a crash is left untouched.
 *
 * @module services/session/runtime-pid-registry.service
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/** One recorded runtime process. */
interface RuntimePidRecord {
  /** OS process id of the PTY child. */
  pid: number;
  /** Owning session name. */
  sessionName: string;
  /** Normalised spawn command line (executable + args), used to verify identity. */
  signature: string;
  /** ISO timestamp when recorded. */
  spawnedAt: string;
}

/** Registry file name under the Crewly home. */
export const RUNTIME_PID_FILE = 'runtime-pids.json';

/** Collapse whitespace + trim so signatures compare stably across `/proc` and `ps`. */
function normalizeCmdline(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Read the live command line for a pid, cross-platform, or null if the process
 * does not exist / is unreadable.
 *
 * - Linux: `/proc/<pid>/cmdline` (NUL-separated argv).
 * - Other (macOS/BSD): `ps -o command= -p <pid>`.
 *
 * @param pid - Process id to inspect.
 * @returns The normalised command line, or null.
 */
export function readProcessCmdline(pid: number): string | null {
  // Linux fast path — read argv directly from /proc.
  const procPath = `/proc/${pid}/cmdline`;
  if (existsSync(procPath)) {
    try {
      const raw = readFileSync(procPath);
      // argv is NUL-separated, trailing NUL.
      const cmd = raw.toString('utf8').replace(/\0/g, ' ');
      return normalizeCmdline(cmd) || null;
    } catch {
      return null;
    }
  }
  // Portable fallback (macOS): ask `ps`.
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cmd = normalizeCmdline(out);
    return cmd || null;
  } catch {
    // Non-zero exit = no such process.
    return null;
  }
}

/** Whether a pid is currently alive (signal 0 probe). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false; // never touch pid 0/1
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but not ours to signal → treat as alive (don't reap).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Persistent, identity-verified registry of spawned runtime PIDs.
 *
 * Records are written on session spawn and removed on clean teardown; whatever
 * remains at the next boot is a candidate orphan from a non-graceful death.
 */
export interface RuntimePidRegistryOptions {
  /** Override the registry file location (tests). */
  filePath?: string;
  /** Override how a pid's live command line is read (tests). */
  cmdlineReader?: (pid: number) => string | null;
}

export class RuntimePidRegistry {
  private static instance: RuntimePidRegistry | null = null;
  private readonly filePath: string;
  private readonly cmdlineReader: (pid: number) => string | null;
  private readonly logger: ComponentLogger;

  private constructor(options: RuntimePidRegistryOptions = {}) {
    this.filePath = options.filePath ?? path.join(getCrewlyHomePath(), RUNTIME_PID_FILE);
    this.cmdlineReader = options.cmdlineReader ?? readProcessCmdline;
    this.logger = LoggerService.getInstance().createComponentLogger('RuntimePidRegistry');
  }

  static getInstance(): RuntimePidRegistry {
    if (!this.instance) this.instance = new RuntimePidRegistry();
    return this.instance;
  }

  /** Reset for tests (optionally pointing at a temp file + stub cmdline reader). */
  static resetForTesting(options: RuntimePidRegistryOptions = {}): RuntimePidRegistry {
    this.instance = new RuntimePidRegistry(options);
    return this.instance;
  }

  private read(): RuntimePidRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as RuntimePidRecord[]) : [];
    } catch {
      // Corrupt file — treat as empty (and it gets rewritten on next mutation).
      return [];
    }
  }

  private write(records: RuntimePidRecord[]): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf8');
    } catch (err) {
      this.logger.warn('Failed to persist runtime PID registry (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Record a freshly spawned runtime process.
   *
   * @param pid - PTY child pid.
   * @param sessionName - Owning session.
   * @param command - Spawn executable.
   * @param args - Spawn args.
   */
  record(pid: number, sessionName: string, command: string, args: string[] = []): void {
    if (!Number.isInteger(pid) || pid <= 1) return;
    const signature = normalizeCmdline([command, ...args].join(' '));
    const records = this.read().filter((r) => r.sessionName !== sessionName && r.pid !== pid);
    records.push({ pid, sessionName, signature, spawnedAt: new Date().toISOString() });
    this.write(records);
  }

  /**
   * Drop the record for a session we have torn down ourselves (so it is not a
   * reap candidate next boot).
   *
   * @param sessionName - Session whose record to remove.
   */
  remove(sessionName: string): void {
    const records = this.read();
    const next = records.filter((r) => r.sessionName !== sessionName);
    if (next.length !== records.length) this.write(next);
  }

  /** Clear all records (graceful shutdown reaped everything itself). */
  clear(): void {
    this.write([]);
  }

  /**
   * Reap orphaned runtime processes left by a previous, non-graceful backend
   * exit. Call ONCE at boot, before sessions are restored. Kills a recorded pid
   * only if it is still alive AND its live command line still matches the
   * recorded signature (guards against PID reuse). Clears the registry after.
   *
   * @returns The number of orphan processes reaped.
   */
  reapOrphans(): number {
    const records = this.read();
    if (records.length === 0) return 0;

    let reaped = 0;
    for (const rec of records) {
      if (!isPidAlive(rec.pid)) continue;

      const liveCmdline = this.cmdlineReader(rec.pid);
      if (!liveCmdline || !liveCmdline.includes(rec.signature)) {
        // Either unreadable, or the PID was reused by an unrelated process —
        // do NOT kill. Log so a surprising mismatch is observable.
        this.logger.warn('Skipping recorded PID — not a matching runtime (reused or changed)', {
          pid: rec.pid,
          sessionName: rec.sessionName,
          expected: rec.signature,
          live: liveCmdline ?? '(gone)',
        });
        continue;
      }

      // Verified orphan — SIGKILL the process and its group.
      this.logger.error('Reaping orphaned runtime process from a previous backend run', {
        pid: rec.pid,
        sessionName: rec.sessionName,
        signature: rec.signature,
        spawnedAt: rec.spawnedAt,
      });
      try {
        process.kill(rec.pid, 'SIGKILL');
      } catch {
        /* already gone between the probe and now */
      }
      try {
        process.kill(-rec.pid, 'SIGKILL'); // process group
      } catch {
        /* no group / already gone */
      }
      reaped++;
    }

    // Whatever was recorded belongs to a prior run — this run records fresh.
    this.clear();
    if (reaped > 0) {
      this.logger.warn('Orphan runtime reaper finished', { reaped, scanned: records.length });
    }
    return reaped;
  }
}
