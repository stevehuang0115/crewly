/**
 * Completion evidence — what a worker sends to mark a WorkItem done (#873).
 *
 * A completion used to need only a free-text `summary`, so a worker whose
 * tool call had failed could still mark its item done. The evidence block
 * makes the claim checkable: each entry is an artifact that exists, a command
 * with its exit code, or a `blocked` report naming the step that failed.
 *
 * This module holds the types and the pure shape validator. The checks that
 * touch the filesystem (does the artifact exist?) and the decision about
 * what the completion does live in
 * `services/task-pool/completion-evidence.service.ts`.
 *
 * @module types/v2/completion-evidence.types
 */

import { COMPLETION_EVIDENCE_CONSTANTS } from '../../constants.js';

/** A file or URL the work produced. A local path must exist on the server. */
export interface ArtifactEvidence {
  type: 'artifact';
  /** Absolute path, path relative to the WorkItem's worktree/project, or an http(s) URL. */
  path: string;
}

/** A command the worker ran, with its exit code and the end of its output. */
export interface CommandEvidence {
  type: 'command';
  /** The command line as run. */
  command: string;
  /** Its exit code. A non-zero code is not evidence of done. */
  exitCode: number;
  /** The last lines of its output. */
  outputTail?: string;
}

/** The worker could not finish: which step failed and why. */
export interface BlockedEvidence {
  type: 'blocked';
  /** The step that failed (e.g. "npm test", "deploy to staging"). */
  step: string;
  /** Why it failed / what is needed to continue. */
  reason: string;
}

/** One evidence entry. */
export type CompletionEvidenceEntry = ArtifactEvidence | CommandEvidence | BlockedEvidence;

/** The evidence block sent with a completion (`body.result.evidence`). */
export type CompletionEvidence = CompletionEvidenceEntry[];

/** Result of {@link validateCompletionEvidence}. */
export type EvidenceValidation =
  | { ok: true; evidence: CompletionEvidence }
  | { ok: false; error: string };

/**
 * Whether a value is a non-empty string within the field length limit.
 *
 * @param value - Candidate
 * @returns True for a usable string field
 */
function isFieldString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= COMPLETION_EVIDENCE_CONSTANTS.MAX_FIELD_CHARS;
}

/**
 * Describe why one entry is malformed, or null when it is a valid entry.
 *
 * @param entry - One element of the evidence array
 * @returns A reason naming the bad field, or null
 */
function entryProblem(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return 'must be an object with a "type"';
  }
  const e = entry as Record<string, unknown>;
  const max = COMPLETION_EVIDENCE_CONSTANTS.MAX_FIELD_CHARS;
  switch (e['type']) {
    case 'artifact':
      return isFieldString(e['path']) ? null : `artifact needs a non-empty "path" string (at most ${max} chars)`;
    case 'command': {
      if (!isFieldString(e['command'])) return `command needs a non-empty "command" string (at most ${max} chars)`;
      const code = e['exitCode'];
      if (typeof code !== 'number' || !Number.isInteger(code)) return 'command needs an integer "exitCode"';
      const tail = e['outputTail'];
      if (tail !== undefined && (typeof tail !== 'string' || tail.length > max)) {
        return `command "outputTail" must be a string (at most ${max} chars)`;
      }
      return null;
    }
    case 'blocked':
      if (!isFieldString(e['step'])) return `blocked needs a non-empty "step" string (at most ${max} chars)`;
      if (!isFieldString(e['reason'])) return `blocked needs a non-empty "reason" string (at most ${max} chars)`;
      return null;
    default:
      return `unknown type ${JSON.stringify(e['type'] ?? null)} (expected "artifact", "command" or "blocked")`;
  }
}

/**
 * Validate the shape of an evidence block.
 *
 * Checks shape only: it does not look at the filesystem or decide what the
 * completion does. `undefined` and `null` are not valid evidence here — the
 * caller decides whether missing evidence is allowed (rollout mode).
 *
 * @param value - The `body.result.evidence` value as received
 * @returns `{ok: true, evidence}` (entries copied with only known fields), or
 *   `{ok: false, error}` naming the first bad entry by index
 *
 * @example
 * ```typescript
 * const v = validateCompletionEvidence([{ type: 'command', command: 'npm test', exitCode: 0 }]);
 * if (!v.ok) res.status(400).json({ error: v.error });
 * ```
 */
export function validateCompletionEvidence(value: unknown): EvidenceValidation {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'evidence must be an array of evidence entries' };
  }
  if (value.length > COMPLETION_EVIDENCE_CONSTANTS.MAX_ENTRIES) {
    return { ok: false, error: `evidence has ${value.length} entries; at most ${COMPLETION_EVIDENCE_CONSTANTS.MAX_ENTRIES} are accepted` };
  }
  const out: CompletionEvidence = [];
  for (let i = 0; i < value.length; i++) {
    const problem = entryProblem(value[i]);
    if (problem) return { ok: false, error: `evidence[${i}]: ${problem}` };
    const e = value[i] as Record<string, unknown>;
    if (e['type'] === 'artifact') {
      out.push({ type: 'artifact', path: (e['path'] as string).trim() });
    } else if (e['type'] === 'command') {
      out.push({
        type: 'command',
        command: e['command'] as string,
        exitCode: e['exitCode'] as number,
        ...(typeof e['outputTail'] === 'string' ? { outputTail: e['outputTail'] } : {}),
      });
    } else {
      out.push({ type: 'blocked', step: (e['step'] as string).trim(), reason: (e['reason'] as string).trim() });
    }
  }
  return { ok: true, evidence: out };
}

/**
 * Type guard: whether a value is a well-formed evidence block.
 *
 * @param value - Candidate
 * @returns True when {@link validateCompletionEvidence} accepts it
 */
export function isCompletionEvidence(value: unknown): value is CompletionEvidence {
  return validateCompletionEvidence(value).ok;
}
