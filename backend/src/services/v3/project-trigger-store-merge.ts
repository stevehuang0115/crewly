/**
 * One-time merge of per-project trigger stores into the live one.
 *
 * The engine reads one store. A backend run from a source checkout keeps it in
 * `<repo>/.crewly/triggers`; an installed one in the Crewly home. Files left in
 * a project (by a checkout run, or by an older team move that copied them) are
 * read by nothing, so their schedules stop without a word (CREW-1332).
 *
 * Merged triggers arrive **paused**: this machine cannot tell whether a row
 * still runs elsewhere or was already recreated here, and an active copy would
 * fire a second time. Each source file is merged once.
 *
 * @module services/v3/project-trigger-store-merge
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Trigger } from '../../types/v2/trigger.types.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import { resolveProjectDataDir } from '../core/crewly-home.utils.js';
import type { TriggerEngine } from './trigger-engine.service.js';

/** File beside the live store that records which sources were merged, and how. */
export const MERGE_REPORT_FILE = 'merged-project-stores.json';

/** What happened to one source file. */
export interface ProjectStoreMergeReport {
  source: string;
  at: string;
  /** Rows in the file */
  rows: number;
  /** Exhausted or cancelled rows, left where they are */
  finished: number;
  /** Added to the live store, paused */
  merged: string[];
  skipped: Array<{ trigger: string; reason: string }>;
  failed: Array<{ trigger: string; reason: string }>;
}

/** The result of one run. */
export interface ProjectStoreMergeRun {
  /** Project folders looked at */
  projectsExamined: number;
  /** Sources merged by this run */
  merged: ProjectStoreMergeReport[];
  /** Files that exist but could not be read; tried again next time */
  unreadable: Array<{ source: string; error: string }>;
  /** Why nothing was looked at, when the run did not start */
  notRun?: string;
}

/** Collaborators of the merge. */
export interface ProjectStoreMergeDeps {
  engine: Pick<TriggerEngine, 'getStorePath' | 'restoreTriggers'>;
  projects: ReadonlyArray<{ path: string }>;
  /** Ids of the teams on this machine */
  teamIds: ReadonlySet<string>;
  now?: () => string;
}

/** A trigger as the report names it: its name and the start of its id. */
function label(row: unknown): string {
  const t = (typeof row === 'object' && row !== null ? row : {}) as { id?: unknown; name?: unknown };
  const id = typeof t.id === 'string' && t.id ? t.id.slice(0, 8) : 'no id';
  return typeof t.name === 'string' && t.name ? `${t.name} (${id})` : id;
}

/** Why a live row is not brought over, or null to merge it. */
function skipReason(row: Partial<Trigger>, teamIds: ReadonlySet<string>): string | null {
  if (row.createdBy === 'system' || row.internal === true) return 'internal: each machine registers its own';
  if (row.teamId !== undefined && !teamIds.has(row.teamId)) return 'its team is not on this machine';
  return null;
}

/** The path of a file with links resolved, or null when it does not exist. */
async function existing(file: string): Promise<string | null> {
  return fs.realpath(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    return file;
  });
}

/**
 * Merge every not-yet-merged per-project trigger store into the live store.
 *
 * @param deps - Engine, projects and teams of this machine
 * @returns What was examined, merged and left for next time
 * @throws When the live store or the report cannot be written
 */
export async function mergeProjectTriggerStores(deps: ProjectStoreMergeDeps): Promise<ProjectStoreMergeRun> {
  const run: ProjectStoreMergeRun = { projectsExamined: 0, merged: [], unreadable: [] };
  // With no team to match, every team trigger would be set aside for good.
  if (deps.teamIds.size === 0) return { ...run, notRun: 'no team is registered yet' };

  const liveFile = deps.engine.getStorePath();
  const live = (await existing(liveFile)) ?? liveFile;
  const reportFile = path.join(path.dirname(liveFile), MERGE_REPORT_FILE);
  const done = await safeReadJson<ProjectStoreMergeReport[]>(reportFile, []);
  const seen = new Set<string>([live, ...done.map((r) => r.source)]);

  for (const project of deps.projects) {
    run.projectsExamined += 1;
    const source = await existing(path.join(resolveProjectDataDir(project.path), 'triggers', path.basename(liveFile)));
    if (!source || seen.has(source)) continue;
    seen.add(source);

    let rows: unknown[];
    try {
      const parsed = JSON.parse(await fs.readFile(source, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not a list of triggers');
      rows = parsed;
    } catch (error) {
      run.unreadable.push({ source, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    const report: ProjectStoreMergeReport = {
      source,
      at: deps.now?.() ?? new Date().toISOString(),
      rows: rows.length,
      finished: 0,
      merged: [],
      skipped: [],
      failed: [],
    };
    const incoming: unknown[] = [];
    for (const raw of rows) {
      const row = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Trigger>;
      if (row.status === 'cancelled' || row.status === 'exhausted') {
        report.finished += 1;
        continue;
      }
      const reason = skipReason(row, deps.teamIds);
      if (reason) report.skipped.push({ trigger: label(row), reason });
      else incoming.push(row.status === 'active' ? { ...row, status: 'paused' } : raw);
    }
    const result = await deps.engine.restoreTriggers(incoming);
    report.merged = result.imported.map(label);
    report.skipped.push(...result.skipped.map((s) => ({ trigger: label(s.row), reason: s.reason })));
    report.failed = result.failed.map((f) => ({ trigger: label(f.row), reason: f.reason }));

    done.push(report);
    run.merged.push(report);
    await atomicWriteJson(reportFile, done);
  }
  return run;
}
