/**
 * System health utility functions.
 * Provides shared checks for memory pressure, CPU load, etc.
 * Used by Reconciler, HeartbeatMonitor, Scheduler to gate process spawning.
 *
 * @module services/core/system-health.util
 */
import * as os from 'os';

/**
 * Memory pressure threshold for gating agent spawns/restarts.
 * Set lower than MEMORY_CRITICAL (95%) to prevent reaching OOM.
 * At 90%, new agent spawns are blocked; at 95%, idle agents are force-stopped.
 */
export const MEMORY_PRESSURE_SPAWN_THRESHOLD = 90;

/** Cached total memory — never changes during process lifetime. */
const cachedTotalMem = os.totalmem();

/**
 * Check if the system is under memory pressure.
 * Returns true when memory usage exceeds the spawn threshold (90%).
 *
 * @returns true if system should NOT spawn new processes
 */
export function isUnderMemoryPressure(): boolean {
  if (cachedTotalMem === 0) return false;
  const free = os.freemem();
  const usedPercent = ((cachedTotalMem - free) / cachedTotalMem) * 100;
  return usedPercent >= MEMORY_PRESSURE_SPAWN_THRESHOLD;
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
