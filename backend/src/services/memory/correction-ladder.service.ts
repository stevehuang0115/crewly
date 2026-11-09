/**
 * Correction ladder (#810, specs/2026-10-25-correction-ladder.md).
 *
 * When an agent is corrected, the correction lands in memory, an SOP or a
 * prompt: prose that is read every turn and still lets the same mistake
 * back in. This service keeps a per-project tally of corrections by
 * **class** (a short slug the recorder chooses, e.g. `git-add-all`) and,
 * the second time a class is recorded, hands the project's team lead one
 * WorkItem: "can this be made impossible or checked in code?" with the
 * ladder as options —
 *
 *   (a) structural / API change — the mistake can no longer be expressed
 *   (b) lint / test / CI check — it is caught before merge
 *   (c) state-triggered hook — it is caught when it happens
 *   (d) keep as prose, with a stated reason
 *
 * The WorkItem is deduplicated: one open item per class. The lead records
 * the rung with `decide`; until then a third occurrence does not raise a
 * second item. A decision of (d) is not final: when the prose did not
 * stick (two more occurrences after it), the class is raised again. No LLM;
 * a plain JSON store under the project's `.crewly/`.
 *
 * @module services/memory/correction-ladder.service
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { LoggerService, type ComponentLogger } from '../core/logger.service.js';
import { CORRECTION_LADDER_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';
import { createWorkItem, type WorkItem } from '../../types/v2/work-item.types.js';

// =============================================================================
// Types
// =============================================================================

/** Where a correction came from. */
export type CorrectionSource = 'learning' | 'failure' | 'manual';

/** The rungs of the ladder, from "cannot happen" to "we tell them again". */
export type CorrectionRung = (typeof CORRECTION_LADDER_CONSTANTS.RUNGS)[number];

/** One time a class was recorded. */
export interface CorrectionOccurrence {
  /** ISO timestamp */
  at: string;
  /** Who recorded it (session name or agent id) */
  agentId: string;
  /** Learning, TL failure handling, or a direct call */
  source: CorrectionSource;
  /** The correction text as recorded (trimmed to `OCCURRENCE_TEXT_MAX_CHARS`) */
  text: string;
  /** Ticket / WorkItem the correction came from */
  relatedTask?: string;
}

/** The lead's answer for a class. */
export interface CorrectionDecision {
  rung: CorrectionRung;
  /** Why this rung — required for every rung, and the whole point of (d) */
  reason: string;
  /** PR, file, rule or hook that implements it */
  link?: string;
  decidedBy: string;
  decidedAt: string;
}

/** Everything known about one correction class in one project. */
export interface CorrectionClassRecord {
  class: string;
  /** Times recorded, all time */
  count: number;
  firstAt: string;
  lastAt: string;
  /** Newest last; capped at `MAX_OCCURRENCES_KEPT` */
  occurrences: CorrectionOccurrence[];
  /** The open ladder WorkItem, if one was raised and not yet decided */
  workItemId: string | null;
  workItemAt: string | null;
  /** The current decision; `null` while undecided or after a re-raise */
  decision: CorrectionDecision | null;
  /** Earlier decisions that did not hold (a (d) that was raised again) */
  previousDecisions: CorrectionDecision[];
}

/** The per-project store. */
export interface CorrectionLadderStore {
  version: 1;
  classes: Record<string, CorrectionClassRecord>;
}

/** Input of {@link CorrectionLadderService.record}. */
export interface RecordCorrectionInput {
  projectPath: string;
  /** Free text; normalised with {@link normalizeCorrectionClass} */
  correctionClass: string;
  agentId: string;
  text: string;
  source: CorrectionSource;
  relatedTask?: string;
}

/** Why a second occurrence did not raise a WorkItem. */
export type CorrectionRaiseSkip = 'below_threshold' | 'already_raised' | 'decided' | 'no_pool' | 'target_dormant';

/** Result of {@link CorrectionLadderService.record}. */
export interface RecordCorrectionResult {
  record: CorrectionClassRecord;
  /** Whether this call raised the lead's WorkItem */
  raised: boolean;
  workItemId?: string;
  target?: string;
  skipped?: CorrectionRaiseSkip;
}

/** Input of {@link CorrectionLadderService.decide}. */
export interface DecideCorrectionInput {
  projectPath: string;
  correctionClass: string;
  rung: string;
  reason: string;
  link?: string;
  decidedBy: string;
}

/** The pool slice this service needs. */
export interface CorrectionLadderPool {
  addToPool(workItem: WorkItem): Promise<void>;
}

/** Wiring. */
export interface CorrectionLadderOptions {
  pool?: CorrectionLadderPool;
  /** The team-lead session for a project root; `null` falls back to the orchestrator */
  resolveTarget?: (projectPath: string) => Promise<string | null>;
  /** Whether a session is awake; a dormant lead is not woken for a chore */
  isTargetAwake?: (sessionName: string) => Promise<boolean>;
  /** Target when no lead resolves (default: the orchestrator) */
  fallbackTarget?: string;
  /** Clock (tests) */
  now?: () => number;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Normalise a class to a slug: lower case, `a-z0-9-`, no leading/trailing
 * or doubled dashes, at most `CLASS_MAX_CHARS`. Returns `null` when nothing
 * usable is left.
 *
 * @param raw - What the recorder typed
 * @returns The slug, or null
 */
export function normalizeCorrectionClass(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, CORRECTION_LADDER_CONSTANTS.CLASS_MAX_CHARS)
    .replace(/-+$/g, '');
  return slug.length >= CORRECTION_LADDER_CONSTANTS.CLASS_MIN_CHARS ? slug : null;
}

/**
 * Whether a string names a rung of the ladder.
 *
 * @param rung - Candidate
 * @returns True for one of `RUNGS`
 */
export function isCorrectionRung(rung: unknown): rung is CorrectionRung {
  return typeof rung === 'string' && (CORRECTION_LADDER_CONSTANTS.RUNGS as readonly string[]).includes(rung);
}

/**
 * Where a project's ladder store lives.
 *
 * @param projectPath - Project root
 * @returns `<project data dir>/correction-ladder.json`
 */
export function correctionLadderPath(projectPath: string): string {
  return path.join(resolveProjectDataDir(projectPath), CORRECTION_LADDER_CONSTANTS.STORE_FILE);
}

/**
 * Occurrences recorded after the current decision (or all, when undecided).
 *
 * @param record - Class record
 * @returns Count
 */
export function occurrencesSinceDecision(record: CorrectionClassRecord): number {
  if (!record.decision) return record.count;
  const since = record.decision.decidedAt;
  return record.occurrences.filter((o) => o.at > since).length;
}

/**
 * The lead's WorkItem for a class: the tally, the recorded texts, the four
 * rungs, and how to record the choice.
 *
 * @param record - Class record (after the occurrence that raised it)
 * @param projectPath - Project root
 * @param target - Lead (or orchestrator) session
 * @param again - Whether an earlier (d) did not hold
 * @returns The WorkItem to add to the pool
 */
export function buildCorrectionWorkItem(record: CorrectionClassRecord, projectPath: string, target: string, again: boolean): WorkItem {
  const c = record.class;
  const recent = record.occurrences.slice(-CORRECTION_LADDER_CONSTANTS.OCCURRENCES_IN_BRIEF);
  const lines: string[] = [
    `# Correction ladder — \`${c}\`${again ? ' (again)' : ''}`,
    '',
    `Project: \`${projectPath}\``,
    `Recorded ${record.count} time${record.count === 1 ? '' : 's'}; first ${record.firstAt.slice(0, 10)}, last ${record.lastAt.slice(0, 10)}.`,
    '',
  ];
  if (again && record.previousDecisions.length) {
    const prev = record.previousDecisions[record.previousDecisions.length - 1]!;
    lines.push(`An earlier decision kept this as prose (${prev.decidedAt.slice(0, 10)}: "${prev.reason}") and the mistake came back ${occurrencesSinceDecision({ ...record, decision: prev })} more times. Prose did not hold; pick a higher rung or say why prose is still right.`, '');
  }
  lines.push('## What was recorded', '');
  for (const o of recent) lines.push(`- ${o.at.slice(0, 10)} · ${o.agentId} · ${o.source}${o.relatedTask ? ` · ${o.relatedTask}` : ''}: ${o.text}`);
  lines.push(
    '',
    '## The question',
    '',
    'The same class of mistake has come back. Prose (memory, SOP, prompt) is read every turn and still let it through. Decide which rung makes it stop, highest feasible first:',
    '',
    '- **structural** — change the API, type or file layout so the mistake can no longer be expressed.',
    '- **check** — a lint rule, test or CI step that fails before merge.',
    '- **hook** — a state-triggered hook or skill guard that catches it the moment it happens.',
    '- **prose** — keep it as memory/SOP text, with the reason why nothing above is worth it.',
    '',
    'Do the work for the rung you pick (or open the PR / ticket for it), then record the choice:',
    '',
    '```bash',
    `bash {{SKILLS_PATH}}/team-leader/decide-correction/execute.sh --project "${projectPath}" --class ${c} --rung <structural|check|hook|prose> --reason "<why this rung>" [--link <PR, file or rule>]`,
    '```',
    '',
    'This WorkItem counts as done only when the choice is recorded. The owner is not involved; never post this in the owner\'s thread.',
  );
  return createWorkItem({
    type: 'delegate',
    owner: target === ORCHESTRATOR_SESSION_NAME ? 'orchestrator' : 'team_lead',
    target,
    title: `Correction ladder: "${c}" came back (${record.count}×)${again ? ' — prose did not hold' : ''}`,
    description: `The correction class "${c}" was recorded ${record.count} times in ${projectPath}. Decide whether it can be made impossible (structural), caught by a check, caught by a hook, or must stay prose — and record the choice with decide-correction.`,
    briefMarkdown: lines.join('\n'),
    maxRetries: 1,
    metadata: {
      kind: CORRECTION_LADDER_CONSTANTS.WORKITEM_KIND,
      correctionClass: c,
      projectPath,
      count: record.count,
      again,
      autoCreated: true,
    },
  });
}

// =============================================================================
// Service
// =============================================================================

/**
 * Per-project tally of correction classes with one ladder WorkItem per
 * class for the team lead.
 */
export class CorrectionLadderService {
  private static instance: CorrectionLadderService | null = null;
  private readonly logger: ComponentLogger;
  private readonly pool?: CorrectionLadderPool;
  private readonly resolveTarget?: (projectPath: string) => Promise<string | null>;
  private readonly isTargetAwake?: (sessionName: string) => Promise<boolean>;
  private readonly fallbackTarget: string;
  private readonly now: () => number;
  /** Serialises writes per store file */
  private readonly locks = new Map<string, Promise<unknown>>();

  /**
   * @param options - Wiring (pool, lead resolver, wake check)
   */
  constructor(options: CorrectionLadderOptions = {}) {
    this.logger = LoggerService.getInstance().createComponentLogger('CorrectionLadder');
    this.pool = options.pool;
    this.resolveTarget = options.resolveTarget;
    this.isTargetAwake = options.isTargetAwake;
    this.fallbackTarget = options.fallbackTarget ?? ORCHESTRATOR_SESSION_NAME;
    this.now = options.now ?? (() => Date.now());
  }

  /** The wired instance (an unwired one records and never raises). */
  static getInstance(): CorrectionLadderService {
    if (!this.instance) this.instance = new CorrectionLadderService();
    return this.instance;
  }

  /** Install the wired instance (boot) or reset (tests). */
  static setInstance(instance: CorrectionLadderService | null): void {
    this.instance = instance;
  }

  /**
   * Record one correction of a class and, on the second occurrence (or the
   * second after a (d) that did not hold), raise the lead's WorkItem.
   *
   * @param input - Class, who, what, where
   * @returns The class record and whether a WorkItem was raised
   * @throws Error when the class normalises to nothing or the text is empty
   */
  async record(input: RecordCorrectionInput): Promise<RecordCorrectionResult> {
    const cls = normalizeCorrectionClass(input.correctionClass);
    if (!cls) throw new Error(`Correction class "${String(input.correctionClass)}" has no letters or digits to make a slug from`);
    const text = (input.text ?? '').trim();
    if (!text) throw new Error('A correction needs the text that was recorded');

    return this.withLock(input.projectPath, async () => {
      const store = await this.read(input.projectPath);
      const at = new Date(this.now()).toISOString();
      const existing = store.classes[cls];
      const occurrence: CorrectionOccurrence = {
        at,
        agentId: input.agentId,
        source: input.source,
        text: text.slice(0, CORRECTION_LADDER_CONSTANTS.OCCURRENCE_TEXT_MAX_CHARS),
        ...(input.relatedTask ? { relatedTask: input.relatedTask } : {}),
      };
      const record: CorrectionClassRecord = existing
        ? {
            ...existing,
            count: existing.count + 1,
            lastAt: at,
            occurrences: [...existing.occurrences, occurrence].slice(-CORRECTION_LADDER_CONSTANTS.MAX_OCCURRENCES_KEPT),
          }
        : { class: cls, count: 1, firstAt: at, lastAt: at, occurrences: [occurrence], workItemId: null, workItemAt: null, decision: null, previousDecisions: [] };
      store.classes[cls] = record;

      const raise = await this.maybeRaise(record, input.projectPath);
      await this.write(input.projectPath, store);
      if (raise.raised) {
        this.logger.info('Correction class raised to the team lead', { projectPath: input.projectPath, class: cls, count: record.count, target: raise.target, workItemId: raise.workItemId });
      }
      return { record, ...raise };
    });
  }

  /**
   * Record the lead's choice for a class and close the ladder for it.
   *
   * @param input - Class, rung, reason, who
   * @returns The updated record
   * @throws Error for an unknown class, an unknown rung or an empty reason
   */
  async decide(input: DecideCorrectionInput): Promise<CorrectionClassRecord> {
    const cls = normalizeCorrectionClass(input.correctionClass);
    if (!cls) throw new Error(`Correction class "${String(input.correctionClass)}" is not a slug`);
    const rung = input.rung;
    if (!isCorrectionRung(rung)) throw new Error(`Unknown rung "${String(rung)}" — one of ${CORRECTION_LADDER_CONSTANTS.RUNGS.join(', ')}`);
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new Error('A decision needs a reason, for every rung');

    return this.withLock(input.projectPath, async () => {
      const store = await this.read(input.projectPath);
      const record = store.classes[cls];
      if (!record) throw new Error(`No correction class "${cls}" recorded in ${input.projectPath}`);
      const decision: CorrectionDecision = {
        rung,
        reason,
        ...(input.link?.trim() ? { link: input.link.trim() } : {}),
        decidedBy: input.decidedBy,
        decidedAt: new Date(this.now()).toISOString(),
      };
      const updated: CorrectionClassRecord = { ...record, decision, workItemId: null, workItemAt: null };
      store.classes[cls] = updated;
      await this.write(input.projectPath, store);
      this.logger.info('Correction class decided', { projectPath: input.projectPath, class: cls, rung: decision.rung, decidedBy: input.decidedBy });
      return updated;
    });
  }

  /**
   * Every class of a project, most recorded first.
   *
   * @param projectPath - Project root
   * @returns Records
   */
  async list(projectPath: string): Promise<CorrectionClassRecord[]> {
    const store = await this.read(projectPath);
    return Object.values(store.classes).sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
  }

  // ---------------------------------------------------------------------------

  /**
   * Raise the lead's WorkItem when the class has earned it: `THRESHOLD`
   * occurrences with no decision and no open item, or `THRESHOLD`
   * occurrences after a (d) decision. An open item older than
   * `REOPEN_AFTER_MS` with no decision counts as abandoned and is replaced.
   */
  private async maybeRaise(record: CorrectionClassRecord, projectPath: string): Promise<Omit<RecordCorrectionResult, 'record'>> {
    const since = occurrencesSinceDecision(record);
    const again = record.decision?.rung === 'prose';
    if (record.decision && !again) return { raised: false, skipped: 'decided' };
    if (since < CORRECTION_LADDER_CONSTANTS.THRESHOLD) return { raised: false, skipped: 'below_threshold' };
    if (record.workItemId) {
      const age = record.workItemAt ? this.now() - Date.parse(record.workItemAt) : 0;
      if (age < CORRECTION_LADDER_CONSTANTS.REOPEN_AFTER_MS) return { raised: false, skipped: 'already_raised', workItemId: record.workItemId };
      this.logger.warn('Correction ladder WorkItem never decided; raising again', { projectPath, class: record.class, workItemId: record.workItemId });
    }
    if (!this.pool) return { raised: false, skipped: 'no_pool' };

    const target = (await this.targetFor(projectPath)) ?? this.fallbackTarget;
    if (!(await this.targetAwake(target))) return { raised: false, skipped: 'target_dormant', target };

    if (again && record.decision) {
      record.previousDecisions = [...record.previousDecisions, record.decision];
      record.decision = null;
    }
    const wi = buildCorrectionWorkItem(record, projectPath, target, again);
    await this.pool.addToPool(wi);
    record.workItemId = wi.id;
    record.workItemAt = new Date(this.now()).toISOString();
    return { raised: true, workItemId: wi.id, target };
  }

  /** The lead for a project; errors count as "no lead". */
  private async targetFor(projectPath: string): Promise<string | null> {
    if (!this.resolveTarget) return null;
    try {
      return await this.resolveTarget(projectPath);
    } catch {
      return null;
    }
  }

  /** Errors count as dormant: a chore is never worth risking a wake. */
  private async targetAwake(target: string): Promise<boolean> {
    if (!this.isTargetAwake) return true;
    try {
      return await this.isTargetAwake(target);
    } catch {
      return false;
    }
  }

  private async read(projectPath: string): Promise<CorrectionLadderStore> {
    const data = await safeReadJson<Partial<CorrectionLadderStore> | null>(correctionLadderPath(projectPath), null);
    const classes = data && typeof data.classes === 'object' && data.classes ? data.classes : {};
    return { version: 1, classes: { ...classes } };
  }

  private async write(projectPath: string, store: CorrectionLadderStore): Promise<void> {
    const file = correctionLadderPath(projectPath);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteJson(file, store);
  }

  /** Run `fn` after every earlier operation on the same project's store. */
  private withLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectPath);
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }
}
