/**
 * System health utility functions.
 * Provides shared checks for memory pressure, CPU load, etc.
 * Used by Reconciler, HeartbeatMonitor, Scheduler to gate process spawning.
 *
 * @module services/core/system-health.util
 */
import * as os from 'os';

/**
 * Memory pressure thresholds.
 *
 * Steve 2026-05-15 dogfood: macOS keeps the "memory used %" stat at
 * 95-99% on virtually every Mac because the OS aggressively uses RAM
 * for file cache (which is reclaimable on demand). Gating spawns purely
 * on usedPercent meant the user's machine permanently skipped every
 * wake action — agents could never come back online. Concrete signal
 * from the log: `consecutiveSkips` climbing past 450 with freeMB
 * fluctuating 80-800 (i.e. plenty of real headroom most of the time).
 *
 * The fix: keep the percent check as a soft signal, but only DECLARE
 * memory pressure when freeMB drops below an absolute headroom floor.
 * A fresh Claude Code process is ~150-200MB RSS; reserve 300MB so we
 * never spawn into an actual OOM situation while letting the cache-
 * inflated 95-99% percent reading pass.
 */
export const MEMORY_PRESSURE_SPAWN_THRESHOLD = 90;
export const MEMORY_PRESSURE_MIN_FREE_MB = 300;

/** Cached total memory — never changes during process lifetime. */
const cachedTotalMem = os.totalmem();

/**
 * Check if the system is under memory pressure.
 *
 * Returns true only when BOTH:
 *   - usedPercent >= MEMORY_PRESSURE_SPAWN_THRESHOLD (90%), AND
 *   - freeMB < MEMORY_PRESSURE_MIN_FREE_MB (300MB)
 *
 * macOS file-cache inflation makes the percent reading misleading on
 * its own. Requiring the absolute-free-MB floor catches the actual
 * OOM-risk case (low real headroom) without permanently blocking
 * spawns on machines that simply have a hot file cache.
 *
 * @returns true if system should NOT spawn new processes
 */
export function isUnderMemoryPressure(): boolean {
  if (cachedTotalMem === 0) return false;
  const free = os.freemem();
  const usedPercent = ((cachedTotalMem - free) / cachedTotalMem) * 100;
  const freeMB = free / 1024 / 1024;
  // Both conditions must hold — percent is a soft signal, free-MB is
  // the binding constraint.
  return (
    usedPercent >= MEMORY_PRESSURE_SPAWN_THRESHOLD &&
    freeMB < MEMORY_PRESSURE_MIN_FREE_MB
  );
}

/**
 * Get current memory usage stats.
 * @returns Object with totalMB, freeMB, usedPercent
 */
export function getMemoryStats(): { totalMB: number; freeMB: number; usedPercent: number } {
  if (cachedTotalMem === 0) return { totalMB: 0, freeMB: 0, usedPercent: 0 };
  const free = os.freemem();
  return {
    totalMB: Math.round(cachedTotalMem / 1024 / 1024),
    freeMB: Math.round(free / 1024 / 1024),
    usedPercent: Math.round(((cachedTotalMem - free) / cachedTotalMem) * 100 * 10) / 10,
  };
}
