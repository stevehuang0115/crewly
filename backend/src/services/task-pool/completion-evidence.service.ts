/**
 * Completion evidence check (#873) — decides what a completion does.
 *
 * `POST /api/task-pool/complete/:id` calls {@link decideCompletion} before it
 * touches the WorkItem. The decision is one of:
 *
 * - `reject` (400): malformed evidence, an artifact path that does not exist
 *   (or a relative path with no project/worktree to resolve it against), a
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
  /** Existence check, injectable for tests. Defaults to `fs.stat`. */
  pathExists?: (absolutePath: string) => Promise<boolean>;
  /** Home directory for `~/` paths. Defaults to `os.homedir()`. */
  homeDir?: string;
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

/**
 * Default existence check.
 *
 * @param p - Absolute path
 * @returns True when something exists at `p`
 */
async function defaultPathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
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
  | { ok: true }
  | { ok: false; code: string; problem: string };

/**
 * Check one artifact: http(s) URLs pass without fetching; local paths must exist.
 *
 * @param artifact - The artifact entry
 * @param bases - Directories for relative paths
 * @param options - Existence check and home directory
 * @returns ok, or the problem with this artifact
 */
async function checkArtifact(
  artifact: ArtifactEvidence,
  bases: string[],
  options: Required<Pick<EvidenceCheckOptions, 'pathExists' | 'homeDir'>>,
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
    return (await options.pathExists(local))
      ? { ok: true }
      : { ok: false, code: C.CODES.ARTIFACT_NOT_FOUND, problem: `"${raw}" does not exist` };
  }
  if (bases.length === 0) {
    return {
      ok: false,
      code: C.CODES.ARTIFACT_UNRESOLVABLE,
      problem: `"${raw}" is relative and this WorkItem records no project or worktree path to resolve it against; send an absolute path`,
    };
  }
  for (const base of bases) {
    if (await options.pathExists(path.resolve(base, local))) return { ok: true };
  }
  return {
    ok: false,
    code: C.CODES.ARTIFACT_NOT_FOUND,
    problem: `"${raw}" does not exist (looked in ${bases.join(', ')})`,
  };
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
export function describeEvidenceForReviewer(output: Record<string, unknown> | undefined): string {
  const v = validateCompletionEvidence(output?.['evidence']);
  const evidence = v.ok ? v.evidence : [];
  if (evidence.length === 0) {
    return 'Evidence: NONE — marked done without artifacts or commands (accepted only in evidence warn mode). Check the work directly or send it back asking for evidence.';
  }
  const artifacts = evidence.filter((e) => e.type === 'artifact').length;
  const commands = evidence.filter((e) => e.type === 'command').length;
  return `Evidence: ${artifacts} artifact(s), ${commands} command(s) — read them first (verify-output shows them, or GET /api/task-pool/items/<id> → output.evidence).`;
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
  workItem: Pick<WorkItem, 'metadata'> | null,
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
        error: `complete requires evidence: "done" needs at least one artifact that exists or command with its exit code. ${C.SHAPE_HINT}`,
      };
    }
    return {
      action: 'complete',
      warning: `Completed WITHOUT evidence. This is accepted for now but will be rejected in the next release. ${C.SHAPE_HINT}`,
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
  const fsOptions = { pathExists: options.pathExists ?? defaultPathExists, homeDir: options.homeDir ?? os.homedir() };
  const problems: Array<{ code: string; text: string }> = [];
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    if (e.type !== 'artifact') continue;
    const check = await checkArtifact(e, bases, fsOptions);
    if (!check.ok) problems.push({ code: check.code, text: `evidence[${i}] artifact ${check.problem}` });
  }
  if (problems.length > 0) {
    return {
      action: 'reject',
      status: 400,
      code: problems[0].code,
      error: `${problems.map((p) => p.text).join('; ')}. Artifacts must exist on this machine (or be http(s) URLs).`,
    };
  }

  return { action: 'complete', evidence };
}
