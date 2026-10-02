/**
 * Repair orphan-superseded decisions.
 *
 * Bug: addDecision() at the decision cap marked the newest active decision
 * `superseded` with no `supersededBy`. Rule: status === 'superseded' AND no
 * supersededBy -> 'active'. Genuine supersessions (supersededBy set) are untouched.
 *
 * Dry-run by default; `--apply` writes (after backing up to
 * decisions.json.bak-<timestamp>). Targets: every project in ~/.crewly/projects.json
 * that has `.crewly/knowledge/decisions.json`, or explicit paths after the flags.
 *
 * Usage: npx tsx backend/src/scripts/repair-orphan-superseded-decisions.ts [--apply] [projectPath...]
 *
 * @module scripts/repair-orphan-superseded-decisions
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Per-vault result. */
export interface VaultRepairResult {
  file: string;
  examined: number;
  orphans: number;
  repaired: number;
  backup?: string;
  error?: string;
}

/** Relative location of the decisions file inside a project. */
export const DECISIONS_REL_PATH = path.join('.crewly', 'knowledge', 'decisions.json');

interface DecisionLike { status?: string; supersededBy?: string; [k: string]: unknown }

/**
 * Repair one decisions.json.
 *
 * @param file - Absolute path of decisions.json
 * @param apply - Write changes when true; otherwise report only
 * @returns Counts for the file; `error` is set when it could not be parsed
 */
export async function repairDecisionsFile(file: string, apply: boolean): Promise<VaultRepairResult> {
  const result: VaultRepairResult = { file, examined: 0, orphans: 0, repaired: 0 };
  let data: unknown;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    result.error = `unreadable/malformed: ${(err as Error).message}`;
    return result;
  }
  if (!Array.isArray(data)) {
    result.error = 'not a JSON array';
    return result;
  }
  const decisions = data as DecisionLike[];
  result.examined = decisions.length;
  const orphans = decisions.filter(d => d && d.status === 'superseded' && !d.supersededBy);
  result.orphans = orphans.length;
  if (orphans.length === 0 || !apply) return result;

  const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await fs.copyFile(file, backup);
  result.backup = backup;
  for (const d of orphans) d.status = 'active';
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(decisions, null, 2));
  await fs.rename(tmp, file);
  result.repaired = orphans.length;
  return result;
}

/**
 * Resolve decisions.json files for the given project paths (or all registered projects).
 *
 * @param projectPaths - Explicit project roots; when empty, read ~/.crewly/projects.json
 * @param projectsJson - Override path of projects.json (tests)
 * @returns Existing decisions.json absolute paths
 */
export async function resolveDecisionFiles(projectPaths: string[], projectsJson?: string): Promise<string[]> {
  let roots = projectPaths;
  if (roots.length === 0) {
    const pj = projectsJson ?? path.join(os.homedir(), '.crewly', 'projects.json');
    const raw = JSON.parse(await fs.readFile(pj, 'utf8'));
    const list: Array<{ path?: string }> = Array.isArray(raw) ? raw : Object.values(raw.projects ?? raw);
    roots = list.map(p => p?.path).filter((p): p is string => typeof p === 'string');
  }
  const files: string[] = [];
  for (const r of roots) {
    const f = path.join(r, DECISIONS_REL_PATH);
    try { await fs.access(f); files.push(f); } catch { /* no decisions file */ }
  }
  return files;
}

/**
 * Run the repair across projects.
 *
 * @returns results plus `ok=false` when zero files were examined (refuses to report success)
 */
export async function runRepair(opts: { apply: boolean; projectPaths?: string[]; projectsJson?: string }): Promise<{ ok: boolean; results: VaultRepairResult[] }> {
  const files = await resolveDecisionFiles(opts.projectPaths ?? [], opts.projectsJson);
  const results: VaultRepairResult[] = [];
  for (const f of files) results.push(await repairDecisionsFile(f, opts.apply));
  const parsed = results.filter(r => !r.error);
  return { ok: parsed.length > 0 && results.every(r => !r.error), results };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const { ok, results } = await runRepair({ apply, projectPaths: args.filter(a => !a.startsWith('--')) });
  console.log(apply ? 'MODE: apply' : 'MODE: dry-run (pass --apply to write)');
  for (const r of results) {
    console.log(`${r.file}: examined=${r.examined} orphans=${r.orphans} repaired=${r.repaired}${r.error ? ` ERROR=${r.error}` : ''}${r.backup ? ` backup=${r.backup}` : ''}`);
  }
  console.log(`${results.length} file(s) examined`);
  if (results.length === 0) console.log('NO FILES EXAMINED — refusing to report success');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && /repair-orphan-superseded-decisions\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
