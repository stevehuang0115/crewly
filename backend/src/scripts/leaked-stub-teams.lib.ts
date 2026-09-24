/**
 * Detection + quarantine of the stub teams leaked by issue #729.
 *
 * On 2026-06-12 a verification run of the autonomous-harness P0 (live team
 * provisioning) wrote three identical stub teams into a developer's REAL
 * `~/.crewly/teams`. The root causes are fixed (the provisioner honours the
 * injected root, and the Jest setup isolates `CREWLY_HOME`); this library
 * exists so any copies that are still lying around can be removed SAFELY.
 *
 * Safety rules, all deliberate:
 *  - A team is a match only when EVERY marker from the incident holds —
 *    template id, the title-cased name, exactly the Vee/Ace/Coco roster, every
 *    member inactive with an empty session name, no projects/owner/parent, and
 *    a creation time inside the incident window. Any single marker is shared
 *    by real teams: on the machine that reported the issue a real team
 *    ("Closie") also has members with empty session names, and a user can
 *    legitimately create a team from the `dtc-viral-content-team` template.
 *  - The directory name must equal the config's `id`, so a mis-filed or
 *    hand-edited team is never touched.
 *  - Nothing is deleted. Matches are MOVED into a backup directory, an
 *    existing backup entry is never overwritten, and the default mode is a
 *    dry run.
 *
 * The CLI (`scripts/cleanup-leaked-stub-teams.ts`) is a thin shell over
 * {@link quarantineLeakedStubTeams}.
 *
 * @module scripts/leaked-stub-teams.lib
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * The exact fingerprint of the teams leaked on 2026-06-12 (issue #729),
 * taken from the three backed-up copies.
 */
export const LEAKED_STUB_TEAM_FINGERPRINT = {
  /** Template the harness materialized. */
  templateId: 'dtc-viral-content-team',
  /** `humanizeTemplateName(templateId)` — the harness's title-cased name. */
  name: 'Dtc Viral Content Team',
  /** Exact member roster, sorted. */
  memberNames: ['Ace', 'Coco', 'Vee'],
  /** Every member was persisted inactive and never launched. */
  memberAgentStatus: 'inactive',
  /** Inclusive lower bound of the incident window (ISO-8601). */
  createdFrom: '2026-06-12T00:00:00.000Z',
  /** Exclusive upper bound of the incident window (ISO-8601). */
  createdBefore: '2026-06-12T01:00:00.000Z',
} as const;

/** Name of the per-team config file inside `<teamsDir>/<teamId>/`. */
export const TEAM_CONFIG_FILENAME = 'config.json';

/** Outcome for one team directory. */
export interface StubTeamClassification {
  /** Directory name under `teamsDir`. */
  dirName: string;
  /** True only when every fingerprint marker holds. */
  isLeakedStub: boolean;
  /** True when the config names the incident template (match or near-miss). */
  sameTemplate: boolean;
  /** Why it is NOT a match (empty for matches). Useful for near-misses. */
  reasons: string[];
}

/** Result of a quarantine pass. */
export interface QuarantineReport {
  /** True when nothing was moved (dry run). */
  dryRun: boolean;
  /** Team dirs that matched the fingerprint. */
  matched: string[];
  /** Team dirs actually moved into `backupDir` (apply mode only). */
  moved: string[];
  /** Matches that could not be moved, with the reason. */
  failed: Array<{ dirName: string; error: string }>;
  /**
   * Teams built from the incident template that were KEPT because at least
   * one marker failed — reported so a human can see what was spared and why.
   */
  nearMisses: StubTeamClassification[];
}

/**
 * Decide whether a parsed team config is one of the #729 leaked stubs.
 *
 * Pure: no I/O. Every marker must hold; the reasons list names each one that
 * does not.
 *
 * @param dirName - The team's directory name under `teamsDir`.
 * @param config - The parsed `config.json` (untrusted shape).
 * @returns The classification, with the failing markers when not a match.
 *
 * @example
 * ```typescript
 * const c = classifyStubTeam(id, JSON.parse(raw));
 * if (c.isLeakedStub) { ... }
 * ```
 */
export function classifyStubTeam(dirName: string, config: unknown): StubTeamClassification {
  const reasons: string[] = [];
  const fp = LEAKED_STUB_TEAM_FINGERPRINT;

  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { dirName, isLeakedStub: false, sameTemplate: false, reasons: ['config is not an object'] };
  }
  const team = config as Record<string, unknown>;

  if (team.id !== dirName) reasons.push('config id does not match its directory name');
  if (team.templateId !== fp.templateId) reasons.push(`templateId is not ${fp.templateId}`);
  if (team.name !== fp.name) reasons.push(`name is not "${fp.name}"`);

  const projectIds = team.projectIds;
  if (projectIds !== undefined && !(Array.isArray(projectIds) && projectIds.length === 0)) {
    reasons.push('team is assigned to projects');
  }
  if (team.ownerUserId !== undefined) reasons.push('team has an owner');
  if (team.parentTeamId !== undefined) reasons.push('team has a parent team');

  const createdAt = typeof team.createdAt === 'string' ? Date.parse(team.createdAt) : Number.NaN;
  if (
    Number.isNaN(createdAt)
    || createdAt < Date.parse(fp.createdFrom)
    || createdAt >= Date.parse(fp.createdBefore)
  ) {
    reasons.push('createdAt is outside the incident window');
  }

  const members = Array.isArray(team.members) ? (team.members as unknown[]) : null;
  if (!members) {
    reasons.push('members is not a list');
  } else {
    const names = members
      .map((m) => (typeof m === 'object' && m !== null ? (m as Record<string, unknown>).name : undefined))
      .map((n) => (typeof n === 'string' ? n : ''))
      .sort();
    if (JSON.stringify(names) !== JSON.stringify(fp.memberNames)) {
      reasons.push(`members are not exactly ${fp.memberNames.join('/')}`);
    }
    const allUnlaunched = members.every((m) => {
      if (typeof m !== 'object' || m === null) return false;
      const member = m as Record<string, unknown>;
      return member.sessionName === '' && member.agentStatus === fp.memberAgentStatus;
    });
    if (!allUnlaunched) reasons.push('a member has a session or is not inactive');
  }

  return {
    dirName,
    isLeakedStub: reasons.length === 0,
    sameTemplate: team.templateId === fp.templateId,
    reasons,
  };
}

/**
 * Scan a teams directory and classify every team in it. Read-only.
 *
 * Directories without a readable/parseable `config.json` are classified as
 * non-matches (never as stubs).
 *
 * @param teamsDir - Absolute path of a Crewly `teams/` directory.
 * @returns One classification per team directory, in directory order.
 * @throws When `teamsDir` itself cannot be read.
 */
export async function scanTeamsForLeakedStubs(teamsDir: string): Promise<StubTeamClassification[]> {
  const entries = await fs.readdir(teamsDir, { withFileTypes: true });
  const results: StubTeamClassification[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const configPath = path.join(teamsDir, entry.name, TEAM_CONFIG_FILENAME);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (err) {
      results.push({
        dirName: entry.name,
        isLeakedStub: false,
        sameTemplate: false,
        reasons: [`unreadable ${TEAM_CONFIG_FILENAME}: ${(err as Error).message}`],
      });
      continue;
    }
    results.push(classifyStubTeam(entry.name, parsed));
  }

  return results;
}

/**
 * Find the #729 leaked stub teams and, when `apply` is set, move them into
 * `backupDir`. Never deletes anything.
 *
 * @param opts.teamsDir - The Crewly `teams/` directory to scan.
 * @param opts.backupDir - Where matches are moved (created on demand).
 * @param opts.apply - `false` (default) reports only; `true` moves matches.
 * @returns What matched, what moved, what failed, and the near-misses kept.
 * @throws When `teamsDir` cannot be read.
 *
 * @example
 * ```typescript
 * const report = await quarantineLeakedStubTeams({ teamsDir, backupDir });
 * // report.matched lists what an --apply run would move
 * ```
 */
export async function quarantineLeakedStubTeams(opts: {
  teamsDir: string;
  backupDir: string;
  apply?: boolean;
}): Promise<QuarantineReport> {
  const apply = opts.apply === true;
  const classified = await scanTeamsForLeakedStubs(opts.teamsDir);

  const matched = classified.filter((c) => c.isLeakedStub).map((c) => c.dirName);
  const nearMisses = classified.filter((c) => !c.isLeakedStub && c.sameTemplate);
  const report: QuarantineReport = { dryRun: !apply, matched, moved: [], failed: [], nearMisses };

  if (!apply || matched.length === 0) return report;

  await fs.mkdir(opts.backupDir, { recursive: true });
  for (const dirName of matched) {
    const destination = path.join(opts.backupDir, dirName);
    try {
      // Never overwrite a previous backup of the same team.
      const exists = await fs
        .stat(destination)
        .then(() => true)
        .catch(() => false);
      if (exists) throw new Error(`backup already exists at ${destination}`);
      await fs.rename(path.join(opts.teamsDir, dirName), destination);
      report.moved.push(dirName);
    } catch (err) {
      report.failed.push({ dirName, error: (err as Error).message });
    }
  }

  return report;
}
