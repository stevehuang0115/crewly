/**
 * Completion evidence check (#873) — decides what a completion does.
 *
 * `POST /api/task-pool/complete/:id` calls {@link decideCompletion} before it
 * touches the WorkItem. The decision is one of:
 *
 * - `reject` (400): malformed evidence, an artifact path that does not exist
 *   (or a relative path with no project/worktree to resolve it against), an
 *   empty file, a file last modified before the WorkItem was created (#1313), a
 *   command that exited non-zero, or — in `enforce` mode — no evidence.
 * - `block`: a `blocked` entry. The worker could not finish, so the item is
 *   recorded as blocked (same path as `POST /task-pool/block/:id`), not done.
 * - `complete`: valid evidence; or, in `warn` mode, no evidence with a
 *   `warning` for the response.
 *
 * See specs/2026-10-03-completion-evidence.md.
 *
 * @module services/task-pool/completion-evidence.service
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { COMPLETION_EVIDENCE_CONSTANTS, WORKTREE_CONSTANTS } from '../../constants.js';
import {
  validateCompletionEvidence,
  type ArtifactEvidence,
  type BlockedEvidence,
  type CompletionEvidence,
  type ReviewCheck,
} from '../../types/v2/completion-evidence.types.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';

const C = COMPLETION_EVIDENCE_CONSTANTS;

/** Rollout mode for completions that carry no evidence. */
export type EvidenceEnforcementMode = 'warn' | 'enforce';

/** What a completion does, as decided from its evidence. */
export type EvidenceDecision =
  | { action: 'reject'; status: 400; code: string; error: string }
  | { action: 'block'; reason: string; evidence: CompletionEvidence }
  | { action: 'complete'; evidence?: CompletionEvidence; warning?: string };

/** Options for {@link decideCompletion}. */
export interface EvidenceCheckOptions {
  /** Rollout mode; see {@link resolveEvidenceEnforcementMode}. */
  mode: EvidenceEnforcementMode;
  /**
   * The completion needs no evidence (a review item's verdict — the verdict
   * is the deliverable). Malformed evidence is still rejected.
   */
  exemptFromMissing?: boolean;
  /** File check, injectable for tests. Defaults to `fs.stat`; null when nothing is there. */
  statPath?: (absolutePath: string) => Promise<ArtifactStat | null>;
  /** Home directory for `~/` paths. Defaults to `os.homedir()`. */
  homeDir?: string;
}

/**
 * Whether a WorkItem of this type must carry evidence to complete (#1312).
 * Deliverables (delegate, project_task, review) and items with no type do;
 * harness bookkeeping types (triage, replans, retros, notifications) do not.
 *
 * @param type - The WorkItem's type, if known
 * @returns True when a completion without evidence is refused in enforce mode
 *
 * @example
 * ```typescript
 * evidenceRequiredFor('delegate'); // true
 * evidenceRequiredFor('goal_replan'); // false
 * ```
 */
export function evidenceRequiredFor(type: string | undefined | null): boolean {
  return !type || C.REQUIRED_FOR_TYPES.includes(type);
}

/**
 * The rollout mode in effect: `CREWLY_EVIDENCE_MODE` when it is `warn` or
 * `enforce`, else {@link COMPLETION_EVIDENCE_CONSTANTS.EVIDENCE_ENFORCEMENT_MODE}.
 * Read per request so the mode can be flipped without a restart in tests.
 *
 * @param env - Environment to read (defaults to `process.env`)
 * @returns `warn` or `enforce`
 */
export function resolveEvidenceEnforcementMode(env: NodeJS.ProcessEnv = process.env): EvidenceEnforcementMode {
  const raw = (env[C.ENV_MODE] ?? '').trim().toLowerCase();
  if (raw === 'warn' || raw === 'enforce') return raw;
  return C.EVIDENCE_ENFORCEMENT_MODE;
}

/** What the server learns about a local artifact. */
export interface ArtifactStat {
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * Default file check.
 *
 * @param p - Absolute path
 * @returns Its stat, or null when nothing exists at `p`
 */
async function defaultStatPath(p: string): Promise<ArtifactStat | null> {
  try {
    const st = await fs.stat(p);
    return { isDirectory: st.isDirectory(), sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Directories a relative artifact path is resolved against, in order: the
 * WorkItem's worktree workdir, the worktree root, then `metadata.projectPath`.
 *
 * @param workItem - The WorkItem being completed (null when unknown)
 * @returns Absolute base directories (may be empty)
 */
export function artifactBaseDirs(workItem: Pick<WorkItem, 'metadata'> | null): string[] {
  const meta = workItem?.metadata ?? {};
  const bases: string[] = [];
  const wt = meta[WORKTREE_CONSTANTS.METADATA_KEY];
  if (typeof wt === 'object' && wt !== null) {
    const rec = wt as Record<string, unknown>;
    for (const key of ['workdir', 'path']) {
      const v = rec[key];
      if (typeof v === 'string' && path.isAbsolute(v)) bases.push(v);
    }
  }
  const projectPath = meta['projectPath'];
  if (typeof projectPath === 'string' && path.isAbsolute(projectPath)) bases.push(projectPath);
  return [...new Set(bases)];
}

/** Outcome of checking one artifact. */
type ArtifactCheck =
  | { ok: true; stat?: ArtifactStat }
  | { ok: false; code: string; problem: string };

/**
 * Check one artifact: http(s) URLs pass without fetching; local paths must
 * exist, and a file must be non-empty and modified no earlier than
 * `notBeforeMs` (#1313). Directories only need to exist.
 *
 * @param artifact - The artifact entry
 * @param bases - Directories for relative paths
 * @param options - File check, home directory, and the oldest acceptable mtime (null: no age check)
 * @returns ok (with the stat of a local artifact), or the problem with this artifact
 */
async function checkArtifact(
  artifact: ArtifactEvidence,
  bases: string[],
  options: Required<Pick<EvidenceCheckOptions, 'statPath' | 'homeDir'>> & { notBeforeMs: number | null },
): Promise<ArtifactCheck> {
  const raw = artifact.path;
  const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (scheme && C.URL_SCHEMES.includes(scheme)) return { ok: true };

  let local: string;
  if (scheme === 'file:') {
    try {
      local = fileURLToPath(raw);
    } catch {
      return { ok: false, code: C.CODES.MALFORMED, problem: `"${raw}" is not a valid file:// URL` };
    }
  } else if (scheme) {
    return {
      ok: false,
      code: C.CODES.MALFORMED,
      problem: `"${raw}": only http(s) URLs and local paths are accepted as artifacts`,
    };
  } else if (raw === '~' || raw.startsWith('~/')) {
    local = path.join(options.homeDir, raw.slice(1));
  } else {
    local = raw;
  }

  if (path.isAbsolute(local)) {
    const st = await options.statPath(local);
    return st ? judgeFile(raw, st, options.notBeforeMs) : { ok: false, code: C.CODES.ARTIFACT_NOT_FOUND, problem: `"${raw}" does not exist` };
  }
  if (bases.length === 0) {
    return {
      ok: false,
      code: C.CODES.ARTIFACT_UNRESOLVABLE,
      problem: `"${raw}" is relative and this WorkItem records no project or worktree path to resolve it against; send an absolute path`,
    };
  }
  for (const base of bases) {
    const st = await options.statPath(path.resolve(base, local));
    if (st) return judgeFile(raw, st, options.notBeforeMs);
  }
  return {
    ok: false,
    code: C.CODES.ARTIFACT_NOT_FOUND,
    problem: `"${raw}" does not exist (looked in ${bases.join(', ')})`,
  };
}

/** A named artifact that no longer checks out (crewly#1315). */
export interface ArtifactDiscrepancy {
  /** The path as the worker sent it */
  artifact: string;
  /** What is wrong with it now */
  problem: string;
}

/**
 * Re-check a verified WorkItem's artifacts some time after completion
 * (crewly#1315): each local artifact must still exist and be non-empty.
 * No age check — the file was accepted then; only its presence is in
 * question now. URLs pass as at completion. Read-only.
 *
 * @param workItem - The WorkItem (its `output.evidence` is read)
 * @param options - File check and home directory, injectable for tests
 * @returns One entry per artifact that is gone or empty; empty when all hold
 */
export async function recheckArtifacts(
  workItem: Pick<WorkItem, 'output' | 'metadata'>,
  options: Pick<EvidenceCheckOptions, 'statPath' | 'homeDir'> = {},
): Promise<ArtifactDiscrepancy[]> {
  const v = validateCompletionEvidence(workItem.output?.['evidence']);
  if (!v.ok) return [];
  const bases = artifactBaseDirs(workItem);
  const opts = { statPath: options.statPath ?? defaultStatPath, homeDir: options.homeDir ?? os.homedir(), notBeforeMs: null };
  const out: ArtifactDiscrepancy[] = [];
  for (const e of v.evidence) {
    if (e.type !== 'artifact') continue;
    const check = await checkArtifact(e, bases, opts);
    if (!check.ok) out.push({ artifact: e.path, problem: check.problem });
  }
  return out;
}

/**
 * An existing local artifact: a file must have content and be newer than the
 * WorkItem (a placeholder or an earlier task's output is not evidence).
 *
 * @param raw - The path as sent
 * @param st - Its stat
 * @param notBeforeMs - Oldest acceptable mtime, or null for no age check
 * @returns The check
 */
function judgeFile(raw: string, st: ArtifactStat, notBeforeMs: number | null): ArtifactCheck {
  if (st.isDirectory) return { ok: true, stat: st };
  if (st.sizeBytes <= 0) return { ok: false, code: C.CODES.ARTIFACT_EMPTY, problem: `"${raw}" is empty (0 bytes)` };
  if (notBeforeMs !== null && st.mtimeMs < notBeforeMs) {
    return {
      ok: false,
      code: C.CODES.ARTIFACT_STALE,
      problem: `"${raw}" was last changed ${new Date(st.mtimeMs).toISOString()}, before this WorkItem existed, so it is not this task's output; attach what this task produced, or a command that shows the work`,
    };
  }
  return { ok: true, stat: st };
}

/**
 * The oldest mtime a file artifact may have: the WorkItem's creation minus
 * {@link COMPLETION_EVIDENCE_CONSTANTS.STALE_GRACE_MS}.
 *
 * @param workItem - The WorkItem (null or no createdAt: no age check)
 * @returns Epoch ms, or null
 */
export function artifactNotBefore(workItem: Pick<WorkItem, 'createdAt'> | null): number | null {
  const created = workItem?.createdAt ? Date.parse(workItem.createdAt) : NaN;
  return Number.isFinite(created) ? created - C.STALE_GRACE_MS : null;
}

/**
 * The blocked reason recorded on the WorkItem for `blocked` entries.
 *
 * @param blocked - The blocked entries (at least one)
 * @returns `Blocked at "<step>": <reason>` lines joined with "; "
 */
export function blockedReason(blocked: BlockedEvidence[]): string {
  return blocked.map((b) => `Blocked at "${b.step}": ${b.reason}`).join('; ');
}

/**
 * One line for a reviewer about the evidence a completed WorkItem carries.
 *
 * Used in the `Verify:` review item's description so the reviewer reads the
 * evidence first, and is told when the item was done without any (accepted
 * only in warn mode).
 *
 * @param output - The completed WorkItem's `output` (evidence at `output.evidence`)
 * @returns A sentence starting with "Evidence:"
 */
/**
 * The worker's decision record (#875), read by the reviewer beside the
 * evidence: the key decisions made, the options considered and not taken
 * (with the reason), and the assumptions relied on. Each is an optional list
 * of short strings on the completion result (a lone string counts as one
 * entry). Returns '' when the worker recorded none, so a brief without one
 * stays as it was.
 */
export function describeDecisionsForReviewer(output: Record<string, unknown> | undefined): string {
  const blocks: string[] = [];
  for (const field of C.DECISION_FIELDS) {
    const entries = decisionEntries(output?.[field]);
    if (entries.length === 0) continue;
    const shown = entries.slice(0, C.REVIEW_LISTED_DECISIONS).map((e) => `  - ${e.slice(0, C.DECISION_ENTRY_MAX_CHARS)}`);
    if (entries.length > shown.length) shown.push(`  … and ${entries.length - shown.length} more`);
    blocks.push(`${C.DECISION_LABELS[field]}:\n${shown.join('\n')}`);
  }
  if (blocks.length === 0) return '';
  return `Worker's record — check these hold, not only that the work exists:\n${blocks.join('\n')}`;
}

/** One decision field as a list of non-empty strings; anything else is nothing. */
function decisionEntries(raw: unknown): string[] {
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  return list.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).map((e) => e.trim());
}

export function describeEvidenceForReviewer(output: Record<string, unknown> | undefined): string {
  const v = validateCompletionEvidence(output?.['evidence']);
  const evidence = v.ok ? v.evidence : [];
  if (evidence.length === 0) {
    return 'Evidence: NONE — marked done without artifacts or commands (accepted only in evidence warn mode). Check the work directly (a check with "entry": null) or send it back asking for evidence.';
  }
  const artifacts = evidence.filter((e) => e.type === 'artifact').length;
  const commands = evidence.filter((e) => e.type === 'command').length;
  // Numbered so the reviewer's checks can name each entry (#1314).
  const lines = evidence.map((e, i) => `  [${i}] ${e.type === 'artifact' ? `artifact ${e.path}` : e.type === 'command' ? `command \`${e.command}\` → exit ${e.exitCode}` : `blocked at ${e.step}`}`.slice(0, 300));
  const shown = lines.slice(0, C.REVIEW_LISTED_ENTRIES);
  if (lines.length > shown.length) shown.push(`  … and ${lines.length - shown.length} more (verify-output lists them all)`);
  return `Evidence: ${artifacts} artifact(s), ${commands} command(s) — open or re-run them and record each check:\n${shown.join('\n')}`;
}

/**
 * Decide what a completion does from its evidence block.
 *
 * Order: missing → malformed → `blocked` (wins over everything else: the
 * worker says it did not finish) → failing commands → artifacts.
 *
 * @param rawEvidence - `body.result.evidence` as received (any value)
 * @param workItem - The WorkItem being completed, for resolving relative paths
 * @param options - Mode, exemption and injectable filesystem
 * @returns The decision; never throws
 *
 * @example
 * ```typescript
 * const d = await decideCompletion(result.evidence, wi, { mode: resolveEvidenceEnforcementMode() });
 * if (d.action === 'reject') return res.status(d.status).json({ error: d.error, code: d.code });
 * ```
 */
export async function decideCompletion(
  rawEvidence: unknown,
  workItem: (Pick<WorkItem, 'metadata'> & Partial<Pick<WorkItem, 'createdAt'>>) | null,
  options: EvidenceCheckOptions,
): Promise<EvidenceDecision> {
  const missing = rawEvidence === undefined || rawEvidence === null || (Array.isArray(rawEvidence) && rawEvidence.length === 0);
  if (missing) {
    if (options.exemptFromMissing) return { action: 'complete' };
    if (options.mode === 'enforce') {
      return {
        action: 'reject',
        status: 400,
        code: C.CODES.MISSING,
        error: `complete requires evidence: "done" needs at least one artifact that exists or command with its exit code. Nothing was completed. ${C.SHAPE_HINT}`,
      };
    }
    return {
      action: 'complete',
      warning: `Completed WITHOUT evidence. Accepted only because ${C.ENV_MODE}=warn; by default this is rejected. ${C.SHAPE_HINT}`,
    };
  }

  const validation = validateCompletionEvidence(rawEvidence);
  if (!validation.ok) {
    return { action: 'reject', status: 400, code: C.CODES.MALFORMED, error: `${validation.error}. ${C.SHAPE_HINT}` };
  }
  const evidence = validation.evidence;

  const blocked = evidence.filter((e): e is BlockedEvidence => e.type === 'blocked');
  if (blocked.length > 0) return { action: 'block', reason: blockedReason(blocked), evidence };

  const failing = evidence.flatMap((e, i) => (e.type === 'command' && e.exitCode !== 0 ? [`evidence[${i}] "${e.command}" exited ${e.exitCode}`] : []));
  if (failing.length > 0) {
    return {
      action: 'reject',
      status: 400,
      code: C.CODES.COMMAND_FAILED,
      error: `${failing.join('; ')}: a failing command is not evidence of done. Fix it and run it again, or report blocked/failed ({"type":"blocked","step":"<step>","reason":"<why>"}).`,
    };
  }

  const bases = artifactBaseDirs(workItem);
  const fsOptions = {
    statPath: options.statPath ?? defaultStatPath,
    homeDir: options.homeDir ?? os.homedir(),
    notBeforeMs: artifactNotBefore(workItem as Pick<WorkItem, 'createdAt'> | null),
  };
  const problems: Array<{ code: string; text: string }> = [];
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    if (e.type !== 'artifact') continue;
    const check = await checkArtifact(e, bases, fsOptions);
    if (!check.ok) problems.push({ code: check.code, text: `evidence[${i}] artifact ${check.problem}` });
    // Recorded so the reviewer sees what was checked (#1313).
    else if (check.stat && !check.stat.isDirectory) evidence[i] = { ...e, sizeBytes: check.stat.sizeBytes, mtime: new Date(check.stat.mtimeMs).toISOString() };
  }
  if (problems.length > 0) {
    return {
      action: 'reject',
      status: 400,
      code: problems[0].code,
      error: `${problems.map((p) => p.text).join('; ')}. Artifacts must exist on this machine (or be http(s) URLs), and files must be non-empty and made for this task.`,
    };
  }

  return { action: 'complete', evidence };
}

/** Result of {@link decideReviewAccept}. */
export type ReviewAcceptDecision =
  | { action: 'accept'; checks: ReviewCheck[] }
  | { action: 'accept_unchecked'; warning: string }
  | { action: 'reject'; status: 400; code: string; error: string };

/**
 * Why one raw check entry is not a {@link ReviewCheck}, or null when it is.
 *
 * @param raw - One entry of `result.checks`
 * @param evidenceCount - Number of entries in the worker's evidence
 * @returns A problem description, or null
 */
function checkProblem(raw: unknown, evidenceCount: number): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'must be an object';
  const c = raw as Record<string, unknown>;
  const entry = c['entry'];
  if (entry !== null && entry !== undefined) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) return '"entry" must be an evidence index or null';
    if (entry < 0 || entry >= evidenceCount) return `"entry" ${entry} is not in the worker's evidence (it has ${evidenceCount} entr${evidenceCount === 1 ? 'y' : 'ies'})`;
  }
  if (typeof c['did'] !== 'string' || !c['did'].trim()) return '"did" must say what you did';
  if (c['did'].length > C.MAX_FIELD_CHARS) return `"did" is longer than ${C.MAX_FIELD_CHARS} characters`;
  if (!C.CHECK_OUTCOMES.includes(c['outcome'] as string)) return '"outcome" must be "pass" or "fail"';
  return null;
}

/**
 * Decide whether a reviewer's accept of a worker's delivery may go through
 * (#1314): it must record, per worker evidence entry it looked at, what it
 * did. A rubber-stamp accept was indistinguishable from a real check.
 *
 * Rules (rejections are not affected; only accepts are checked):
 * - `checks` is a non-empty array of `{entry, did, outcome}`;
 * - when the worker sent evidence, at least one check names an entry of it;
 *   without evidence, a check with `entry: null` (a direct look) is enough;
 * - a check with `outcome: "fail"` cannot be accepted — send it back.
 *
 * In `warn` mode a missing record is accepted and flagged `unchecked`;
 * malformed or failed checks are refused in both modes.
 *
 * @param rawChecks - `body.result.checks` as received (any value)
 * @param workerEvidence - The worker's `output.evidence` (any value)
 * @param mode - Rollout mode ({@link resolveEvidenceEnforcementMode})
 * @returns The decision; never throws
 *
 * @example
 * ```typescript
 * const d = decideReviewAccept(result.checks, source.output?.evidence, resolveEvidenceEnforcementMode());
 * if (d.action === 'reject') return res.status(d.status).json({ error: d.error, code: d.code });
 * ```
 */
export function decideReviewAccept(rawChecks: unknown, workerEvidence: unknown, mode: EvidenceEnforcementMode): ReviewAcceptDecision {
  const ev = validateCompletionEvidence(workerEvidence);
  const evidenceCount = ev.ok ? ev.evidence.length : 0;
  const missing = rawChecks === undefined || rawChecks === null || (Array.isArray(rawChecks) && rawChecks.length === 0);
  if (missing) {
    const what = evidenceCount > 0 ? `the worker sent ${evidenceCount} evidence entr${evidenceCount === 1 ? 'y' : 'ies'}` : 'the worker sent no evidence';
    if (mode === 'warn') {
      return { action: 'accept_unchecked', warning: `Accepted WITHOUT a check record (${what}); flagged unchecked. ${C.CHECKS_HINT}` };
    }
    return {
      action: 'reject',
      status: 400,
      code: C.CODES.REVIEW_UNCHECKED,
      error: `accepting a review requires a record of what you checked; ${what}. Nothing was accepted. ${C.CHECKS_HINT}`,
    };
  }
  if (!Array.isArray(rawChecks)) {
    return { action: 'reject', status: 400, code: C.CODES.REVIEW_CHECKS_MALFORMED, error: `checks must be an array. ${C.CHECKS_HINT}` };
  }
  if (rawChecks.length > C.MAX_ENTRIES) {
    return { action: 'reject', status: 400, code: C.CODES.REVIEW_CHECKS_MALFORMED, error: `checks has ${rawChecks.length} entries; at most ${C.MAX_ENTRIES} are accepted` };
  }
  const checks: ReviewCheck[] = [];
  for (let i = 0; i < rawChecks.length; i++) {
    const problem = checkProblem(rawChecks[i], evidenceCount);
    if (problem) return { action: 'reject', status: 400, code: C.CODES.REVIEW_CHECKS_MALFORMED, error: `checks[${i}]: ${problem}. ${C.CHECKS_HINT}` };
    const c = rawChecks[i] as Record<string, unknown>;
    checks.push({ entry: typeof c['entry'] === 'number' ? c['entry'] : null, did: (c['did'] as string).trim(), outcome: c['outcome'] as ReviewCheck['outcome'] });
  }
  if (evidenceCount > 0 && !checks.some((c) => c.entry !== null)) {
    return {
      action: 'reject',
      status: 400,
      code: C.CODES.REVIEW_UNCHECKED,
      error: `the worker sent ${evidenceCount} evidence entr${evidenceCount === 1 ? 'y' : 'ies'} but no check names one: open or re-run at least one and record it. ${C.CHECKS_HINT}`,
    };
  }
  const failed = checks.flatMap((c, i) => (c.outcome === 'fail' ? [`checks[${i}] (${c.did})`] : []));
  if (failed.length > 0) {
    return {
      action: 'reject',
      status: 400,
      code: C.CODES.REVIEW_CHECK_FAILED,
      error: `${failed.join('; ')} failed: a failed check cannot be accepted. Send it back with {"verdict":"rejected","feedback":"<what is wrong>"}.`,
    };
  }
  return { action: 'accept', checks };
}
