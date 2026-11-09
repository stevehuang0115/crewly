/**
 * Verified-work spot-check (#1315, phase 1) — once a day, pick a few WorkItems
 * that were verified in the last 24 hours and re-check that every file
 * artifact recorded as their evidence still exists.
 *
 * Read-only: it never changes a WorkItem and never re-runs a command (that is
 * a later phase). Evidence that is not a local file (URLs, commands, blocked
 * reports) is counted as skipped, not as a pass or a failure. Pure apart from
 * the injected file check and random source, so a day's sample is repeatable.
 *
 * @module services/v3/owner-receipt/verified-spot-check
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { OWNER_RECEIPT_CONSTANTS, WORKTREE_CONSTANTS } from '../../../constants.js';
import type { WorkItem } from '../../../types/v2/work-item.types.js';
import { artifactBaseDirs } from '../../task-pool/completion-evidence.service.js';

/** One recorded artifact that is no longer there. */
export interface SpotCheckDiscrepancy {
  /** WorkItem id (for the log and the API; the owner line does not show it) */
  workItemId: string;
  /** Team name, or the unknown-team label */
  team: string;
  /** The artifact path as recorded */
  artifactPath: string;
}

/** Result of one spot-check run. */
export interface SpotCheckResult {
  /** When the run was made (ISO) */
  at: string;
  /** Verified WorkItems in the window that had a local file artifact to look at */
  eligible: number;
  /** WorkItems picked */
  sampled: number;
  /** File artifacts looked at on the disk */
  artifactsChecked: number;
  /** Evidence entries not checked: URLs, commands, blocked reports, relative paths with no base */
  skipped: number;
  /** Of `skipped`: file artifacts inside a worktree the janitor already removed ("worktree cleaned") */
  worktreeCleaned: number;
  discrepancies: SpotCheckDiscrepancy[];
}

/** Inputs of {@link runSpotCheck}. */
export interface SpotCheckInput {
  workItems: readonly WorkItem[];
  now: Date;
  /** Team name of an agent session, or null */
  teamOf: (session: string) => string | null;
  /** Whether a file or directory exists at an absolute path */
  exists: (absolutePath: string) => Promise<boolean>;
  /** Random number in [0, 1); default is a generator seeded by the day */
  random?: () => number;
  /** Items to pick (default {@link OWNER_RECEIPT_CONSTANTS}.VERIFIED_SPOT_CHECK.SAMPLE_SIZE) */
  sampleSize?: number;
  /** Home directory for `~/` paths */
  homeDir?: string;
}

/** A recorded file artifact to look at. */
interface FileTarget {
  raw: string;
  /** Absolute path candidates, in order; empty = cannot be resolved */
  candidates: string[];
}

/**
 * Deterministic random source (mulberry32).
 *
 * @param seed - Any integer
 * @returns Generator of numbers in [0, 1)
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seed for a calendar day, so a second run on the same day picks the same items.
 *
 * @param now - The run time
 * @returns Integer seed
 */
export function daySeed(now: Date): number {
  const day = now.toISOString().slice(0, 10);
  let h = 2166136261;
  for (let i = 0; i < day.length; i++) h = Math.imul(h ^ day.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Split a WorkItem's recorded evidence into file artifacts to look at and a
 * count of entries that are not checked.
 *
 * @param wi - WorkItem
 * @param homeDir - Home directory for `~/`
 * @returns Targets and the skipped count
 */
export function fileTargetsOf(wi: WorkItem, homeDir: string): { targets: FileTarget[]; skipped: number } {
  const evidence = wi.output?.['evidence'];
  const targets: FileTarget[] = [];
  let skipped = 0;
  if (!Array.isArray(evidence)) return { targets, skipped };
  const bases = artifactBaseDirs(wi);
  for (const entry of evidence) {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const raw = e['type'] === 'artifact' && typeof e['path'] === 'string' ? e['path'].trim() : '';
    if (!raw) {
      skipped += 1; // a command or a blocked report
      continue;
    }
    const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(raw)?.[1]?.toLowerCase();
    let local = raw;
    if (scheme === 'file:') {
      try {
        local = fileURLToPath(raw);
      } catch {
        skipped += 1;
        continue;
      }
    } else if (scheme) {
      skipped += 1; // http(s) or another URL: not a file on this machine
      continue;
    } else if (raw === '~' || raw.startsWith('~/')) {
      local = path.join(homeDir, raw.slice(1));
    }
    targets.push({ raw, candidates: path.isAbsolute(local) ? [local] : bases.map((b) => path.resolve(b, local)) });
  }
  return { targets, skipped };
}

/**
 * The worktree root an absolute path lies in: the WorkItem's recorded
 * worktree, else the directory after a known worktree marker.
 *
 * @param abs - Absolute artifact path
 * @param wi - The WorkItem
 * @returns The worktree root, or null when the path is outside any worktree
 */
export function worktreeRootOf(abs: string, wi: WorkItem): string | null {
  for (const base of artifactBaseDirsOfWorktree(wi)) {
    if (abs === base || abs.startsWith(base + path.sep)) return base;
  }
  const norm = abs.split(path.sep).join('/');
  for (const marker of OWNER_RECEIPT_CONSTANTS.VERIFIED_SPOT_CHECK.WORKTREE_MARKERS) {
    const needle = `/${marker}/`;
    const at = norm.indexOf(needle);
    if (at < 0) continue;
    const rest = norm.slice(at + needle.length).split('/')[0];
    if (rest) return norm.slice(0, at + needle.length) + rest;
  }
  return null;
}

/**
 * Recorded worktree paths of a WorkItem (`metadata.worktree.path` / `workdir`).
 *
 * @param wi - The WorkItem
 * @returns Absolute paths
 */
function artifactBaseDirsOfWorktree(wi: WorkItem): string[] {
  const wt = (wi.metadata ?? {})[WORKTREE_CONSTANTS.METADATA_KEY];
  if (typeof wt !== 'object' || wt === null) return [];
  const rec = wt as Record<string, unknown>;
  return ['path', 'workdir'].map((k) => rec[k]).filter((v): v is string => typeof v === 'string' && path.isAbsolute(v));
}

/**
 * Run the spot-check.
 *
 * @param input - WorkItems, clock, team lookup, file check
 * @returns What was sampled and what is missing
 */
export async function runSpotCheck(input: SpotCheckInput): Promise<SpotCheckResult> {
  const C = OWNER_RECEIPT_CONSTANTS.VERIFIED_SPOT_CHECK;
  const to = input.now.getTime();
  const from = to - C.WINDOW_MS;
  const homeDir = input.homeDir ?? '';
  const eligible: Array<{ wi: WorkItem; targets: FileTarget[]; skipped: number }> = [];
  for (const wi of input.workItems) {
    if (wi.status !== 'verified' || !wi.completedAt) continue;
    const t = Date.parse(wi.completedAt);
    if (!Number.isFinite(t) || t < from || t > to) continue;
    const { targets, skipped } = fileTargetsOf(wi, homeDir);
    if (targets.length === 0) continue;
    eligible.push({ wi, targets, skipped });
  }
  // Stable order first, so the same seed picks the same items.
  eligible.sort((a, b) => a.wi.id.localeCompare(b.wi.id));
  const rand = input.random ?? seededRandom(daySeed(input.now));
  const picked = [...eligible];
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [picked[i], picked[j]] = [picked[j]!, picked[i]!];
  }
  const sample = picked.slice(0, Math.max(0, input.sampleSize ?? C.SAMPLE_SIZE));

  const result: SpotCheckResult = {
    at: input.now.toISOString(),
    eligible: eligible.length,
    sampled: sample.length,
    artifactsChecked: 0,
    skipped: 0,
    worktreeCleaned: 0,
    discrepancies: [],
  };
  for (const { wi, targets, skipped } of sample) {
    result.skipped += skipped;
    const team = (wi.target ? input.teamOf(wi.target) : null) ?? OWNER_RECEIPT_CONSTANTS.UNASSIGNED_TEAM;
    for (const target of targets) {
      if (target.candidates.length === 0) {
        result.skipped += 1; // relative path and no project or worktree to resolve it against
        continue;
      }
      result.artifactsChecked += 1;
      let found = false;
      for (const c of target.candidates) {
        try {
          if (await input.exists(c)) {
            found = true;
            break;
          }
        } catch {
          // an unreadable path counts as not found
        }
      }
      if (!found) {
        // The janitor removes worktrees after merge: a file inside a worktree
        // that is itself gone was cleaned, not lost.
        let cleaned = true;
        for (const c of target.candidates) {
          const root = worktreeRootOf(c, wi);
          let rootGone = false;
          if (root) {
            try {
              rootGone = !(await input.exists(root));
            } catch {
              rootGone = false;
            }
          }
          if (!rootGone) {
            cleaned = false; // outside any worktree, or its worktree still exists: really missing
            break;
          }
        }
        if (cleaned) {
          result.artifactsChecked -= 1;
          result.skipped += 1;
          result.worktreeCleaned += 1;
          continue;
        }
      }
      if (!found) result.discrepancies.push({ workItemId: wi.id, team, artifactPath: target.raw });
    }
  }
  return result;
}

/**
 * The owner line: always present, zero is said out loud. No WorkItem ids.
 *
 * @param r - The run
 * @returns Slack mrkdwn, one to five lines
 */
export function renderSpotCheck(r: SpotCheckResult): string {
  const d = r.discrepancies.length;
  const noun = d === 1 ? 'discrepancy' : 'discrepancies';
  const head = `*Spot-check of verified work:* ${r.sampled} sampled, ${d} ${noun}`;
  if (r.sampled === 0) return `${head} (nothing verified in the last day had a file to look at)`;
  if (d === 0) return head;
  const max = OWNER_RECEIPT_CONSTANTS.VERIFIED_SPOT_CHECK.MAX_LISTED;
  const lines = r.discrepancies.slice(0, max).map((x) => `• ${x.team}: \`${x.artifactPath}\` is gone`);
  if (d > max) lines.push(`• +${d - max} more`);
  return [head, ...lines].join('\n');
}
