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

/**
 * Check if the system is under memory pressure.
 * Returns true when memory usage exceeds the spawn threshold (90%).
 *
 * @returns true if system should NOT spawn new processes
 */
export function isUnderMemoryPressure(): boolean {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = ((total - free) / total) * 100;
  return usedPercent >= MEMORY_PRESSURE_SPAWN_THRESHOLD;
}

/**
 * Get current memory usage stats.
 * @returns Object with totalMB, freeMB, usedPercent
 */
export function getMemoryStats(): { totalMB: number; freeMB: number; usedPercent: number } {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    totalMB: Math.round(total / 1024 / 1024),
    freeMB: Math.round(free / 1024 / 1024),
    usedPercent: Math.round(((total - free) / total) * 100 * 10) / 10,
  };
}
