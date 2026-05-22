/**
 * System health utility functions.
 * Provides shared checks for memory pressure, CPU load, etc.
 * Used by Reconciler, HeartbeatMonitor, Scheduler to gate process spawning.
 *
 * @module services/core/system-health.util
 */
import * as os from 'os';
import { execSync } from 'child_process';

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
 *
 * Steve 2026-05-22 dogfood follow-up: even with the 300MB floor, the
 * gate fires constantly on macOS because `os.freemem()` only counts
 * STRICTLY-FREE pages — it excludes inactive + speculative pages that
 * the kernel can reclaim on demand. On a typical Mac with 3GB+ of
 * reclaimable cache, os.freemem() routinely reports 50-200MB while
 * Activity Monitor / `vm_stat` show 3-4GB available. The reconciler
 * was effectively never letting wakes through.
 *
 * Real fix: on macOS use `vm_stat` to compute AVAILABLE memory
 * (free + inactive + speculative), which is what the kernel itself
 * uses for OOM decisions. Linux's `os.freemem()` is accurate and
 * keeps the old path.
 */
export const MEMORY_PRESSURE_SPAWN_THRESHOLD = 90;
export const MEMORY_PRESSURE_MIN_FREE_MB = 300;

/** Cached total memory — never changes during process lifetime. */
const cachedTotalMem = os.totalmem();

/**
 * macOS detection. Evaluated on every call rather than captured at
 * module load — tests need to flip platform after importing.
 * Runtime overhead is negligible (os.platform is a sync getter).
 */
function isDarwin(): boolean {
  return os.platform() === 'darwin';
}

/**
 * Throttled cache of the last `vm_stat` reading on macOS. Parsing
 * `vm_stat` involves spawning a child process — at the reconciler's
 * 10-second fast-loop cadence that's tolerable but not free. Hold the
 * last reading for 1s so back-to-back callers in the same tick don't
 * each fork.
 */
const VM_STAT_CACHE_TTL_MS = 1_000;
let vmStatCache: { freeMB: number; at: number } | null = null;

/**
 * Read macOS `vm_stat` and compute available memory in bytes.
 *
 * macOS reports pages in 5 main buckets:
 *   - free: strictly unused, OS can hand out immediately
 *   - speculative: prefetched file pages, reclaimable instantly
 *   - inactive: pages not recently used, reclaimable on demand
 *   - active: hot working set — NOT reclaimable cheaply
 *   - wired: kernel/pinned — never reclaimable
 *
 * "Available" = free + speculative + inactive. This matches what the
 * kernel uses when deciding OOM pressure, and what Activity Monitor
 * shows as "Cached Files + Free" headroom.
 *
 * Returns null on any parse failure so the caller can fall back to
 * `os.freemem()` (overly pessimistic but safe — we'd just over-gate,
 * not under-gate, in the worst case).
 */
function readMacFreeMemBytes(): number | null {
  try {
    const cached = vmStatCache;
    if (cached && Date.now() - cached.at < VM_STAT_CACHE_TTL_MS) {
      return cached.freeMB * 1024 * 1024;
    }
    // -c 1 reports a single sample; default is incremental. Trying to
    // be conservative about runtime — vm_stat with no args takes ~50ms,
    // -c 1 with no interval is essentially instant.
    const out = execSync('vm_stat', { timeout: 1_000, encoding: 'utf8' });
    // First line is the page size: "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
    const pageSizeMatch = out.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;

    const grab = (label: string): number => {
      const m = out.match(new RegExp(`Pages ${label}[^:]*:\\s+(\\d+)`));
      return m ? Number(m[1]) : 0;
    };
    const freePages = grab('free');
    const inactivePages = grab('inactive');
    const specPages = grab('speculative');

    const availableBytes = (freePages + inactivePages + specPages) * pageSize;
    vmStatCache = { freeMB: availableBytes / 1024 / 1024, at: Date.now() };
    return availableBytes;
  } catch {
    return null;
  }
}

/**
 * Get the platform-appropriate free-memory reading in bytes.
 *
 * Exposed for tests; production callers should use {@link getMemoryStats}
 * or {@link isUnderMemoryPressure} instead.
 *
 * @returns free memory in bytes; falls back to os.freemem() if the
 *   macOS vm_stat parse fails.
 */
export function getAvailableMemoryBytes(): number {
  if (isDarwin()) {
    const mac = readMacFreeMemBytes();
    if (mac !== null) return mac;
    // Fall through to os.freemem() — conservative but safe.
  }
  return os.freemem();
}

/**
 * Check if the system is under memory pressure.
 *
 * Returns true only when BOTH:
 *   - usedPercent >= MEMORY_PRESSURE_SPAWN_THRESHOLD (90%), AND
 *   - freeMB < MEMORY_PRESSURE_MIN_FREE_MB (300MB)
 *
 * On macOS, "free" includes reclaimable inactive+speculative pages
 * (parsed from `vm_stat`) — without this the reading is ~50MB on a
 * Mac that actually has gigabytes of headroom, and the gate would
 * fire constantly. See module-doc comment for the dogfood history.
 *
 * @returns true if system should NOT spawn new processes
 */
export function isUnderMemoryPressure(): boolean {
  if (cachedTotalMem === 0) return false;
  const free = getAvailableMemoryBytes();
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
  const free = getAvailableMemoryBytes();
  return {
    totalMB: Math.round(cachedTotalMem / 1024 / 1024),
    freeMB: Math.round(free / 1024 / 1024),
    usedPercent: Math.round(((cachedTotalMem - free) / cachedTotalMem) * 100 * 10) / 10,
  };
}

/** Reset the vm_stat cache — test affordance. */
export function _resetVmStatCacheForTesting(): void {
  vmStatCache = null;
}
