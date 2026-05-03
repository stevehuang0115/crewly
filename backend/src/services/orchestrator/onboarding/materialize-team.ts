/**
 * Materialize-Team Logic (Onboarding v3, v0)
 *
 * v0 stub: writes a minimal team `config.json` under `<teamsDir>/<id>/`
 * and flips a project `onboardingComplete` flag. Real provisioning
 * (template-engine wiring, agent-soul generation, system-prompt
 * personalisation) lands Wed–Fri — Sam's brief explicitly says a
 * "logs + flips flag" stub is acceptable for the Mon 5/4 EOD demo.
 *
 * The function is async + injection-friendly: callers pass a
 * `teamsDir`, a `projectFlagPath`, a UUID generator, and a clock — so
 * tests exercise the real write path with tmp dirs and deterministic
 * IDs.
 *
 * Wired downstream: when this module is upgraded post-Mon, swap the
 * inline write for a delegation to
 * `backend/src/services/onboarding/onboarding-provision.service.ts`
 * (it already provisions teams via TemplateService — see that file's
 * `provisionFromOnboarding`).
 *
 * @module services/orchestrator/onboarding/materialize-team
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { TeamRecommendation } from './recommend-team.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Side-effects the materialize step needs. Injected so tests can run
 * against a tmp dir without touching the real `~/.crewly` tree.
 */
export interface MaterializeOptions {
  /** Root teams directory (e.g. `~/.crewly/teams`). */
  readonly teamsDir: string;
  /** File path for the project onboarding-complete flag. */
  readonly projectFlagPath: string;
  /** UUID generator — defaults to {@link crypto.randomUUID} when omitted. */
  readonly uuid?: () => string;
  /** Clock — defaults to `() => new Date()` when omitted. */
  readonly now?: () => Date;
  /**
   * Optional logger sink. When provided, the function writes the
   * Mon-EOD-stub log lines through it (so tests can assert).
   */
  readonly log?: (message: string) => void;
}

/**
 * Outcome of a successful materialize call.
 */
export interface MaterializeResult {
  /** Newly-generated team ID (UUID). */
  readonly teamId: string;
  /** Absolute path to the team's `config.json`. */
  readonly teamConfigPath: string;
  /**
   * Always `true` for a successful call — mirrors the brief's spec:
   * "flips `onboardingComplete = true`".
   */
  readonly onboardingComplete: true;
  /** Echo of the recommendation that was materialized (for orc to summarise back to the user). */
  readonly recommendation: TeamRecommendation;
  /**
   * Where the project flag was persisted. The flag is a tiny JSON file
   * (`{ onboardingComplete: true, completedAt }`).
   */
  readonly projectFlagPath: string;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Materialize a {@link TeamRecommendation} into a team config file +
 * project onboarding-complete flag.
 *
 * v0 (Mon 5/4 EOD) writes a minimal config:
 * ```json
 * {
 *   "id":   "<uuid>",
 *   "name": "<recommendation.templateId> Team",
 *   "createdAt": "...",
 *   "createdBy": "onboarding-v3",
 *   "templateId": "...",
 *   "members": [ ... ]
 * }
 * ```
 * No agent-soul personalisation, no project linkage, no goals.md
 * generation — those land Wed–Fri when this calls into
 * `onboarding-provision.service.ts`.
 *
 * @param recommendation - Output of {@link recommendTeam} that the user confirmed.
 * @param opts - Side-effect injection (teamsDir, projectFlagPath, etc.).
 * @returns The team ID + config path + flag-path on success.
 * @throws If the team config write fails (filesystem error). Caller is
 *         expected to surface a brief, honest error to the user
 *         ("I couldn't create the team — error: …") rather than retry
 *         silently.
 *
 * @example
 * ```ts
 * const result = await materializeTeam(rec, {
 *   teamsDir: path.join(os.homedir(), '.crewly/teams'),
 *   projectFlagPath: path.join(os.homedir(), '.crewly/onboarding-complete.json'),
 * });
 * console.log(result.teamId, '→', result.teamConfigPath);
 * ```
 */
export async function materializeTeam(
  recommendation: TeamRecommendation,
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const uuid = opts.uuid ?? defaultUuid;
  const now = opts.now ?? defaultNow;
  const log = opts.log ?? noopLog;

  const teamId = uuid();
  const teamDir = path.join(opts.teamsDir, teamId);
  const teamConfigPath = path.join(teamDir, 'config.json');
  const createdAt = now().toISOString();

  log(
    `[materialize-team] would materialize team for template "${recommendation.templateId}" with ${recommendation.agents.length} agents (id=${teamId})`,
  );

  // 1. Write the team config.
  const config = buildTeamConfig(recommendation, teamId, createdAt);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.writeFile(teamConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

  // 2. Flip the project onboarding-complete flag.
  const flag = { onboardingComplete: true, completedAt: createdAt };
  await fs.mkdir(path.dirname(opts.projectFlagPath), { recursive: true });
  await fs.writeFile(
    opts.projectFlagPath,
    JSON.stringify(flag, null, 2) + '\n',
    'utf8',
  );

  log(`[materialize-team] flipped onboardingComplete = true at ${opts.projectFlagPath}`);

  return {
    teamId,
    teamConfigPath,
    onboardingComplete: true,
    recommendation,
    projectFlagPath: opts.projectFlagPath,
  };
}

// =============================================================================
// Internals
// =============================================================================

/**
 * Build the minimal v0 team config. Members are derived 1:1 from the
 * recommendation's agents list.
 */
function buildTeamConfig(
  rec: TeamRecommendation,
  teamId: string,
  createdAt: string,
): Record<string, unknown> {
  return {
    id: teamId,
    name: humanizeTemplateName(rec.templateId),
    description: rec.reasoning,
    templateId: rec.templateId,
    createdAt,
    createdBy: 'onboarding-v3',
    onboardingSource: rec.source,
    members: rec.agents.map((a, idx) => ({
      id: `${teamId}-${idx}`,
      name: humanizeRoleName(a.role),
      role: a.role,
      responsibilities: a.responsibilities,
      skillIds: [...a.skillIds],
      systemPrompt: '',
      agentStatus: 'inactive',
      workingStatus: 'idle',
    })),
  };
}

/**
 * Convert a kebab-case template id → human team name
 * (`"dtc-viral-content-team"` → `"Dtc Viral Content Team"`). The full
 * personalisation pass happens post-Mon when we wire into
 * `onboarding-provision.service.ts` — that service already builds
 * proper names.
 */
function humanizeTemplateName(templateId: string): string {
  return templateId
    .split('-')
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/**
 * Convert a kebab-case role → human display name.
 */
function humanizeRoleName(role: string): string {
  return role
    .split('-')
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/**
 * Default UUID generator. Uses Node's `crypto.randomUUID` so we don't
 * pull in a dep, and so the output is deterministic-shaped.
 */
function defaultUuid(): string {
  // Lazy require to keep the import surface minimal and avoid loading
  // `node:crypto` at module load.
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}

/** Default clock — wall-clock time. */
function defaultNow(): Date {
  return new Date();
}

/** Default log sink — drops the message on the floor. */
function noopLog(_message: string): void {
  /* intentional no-op */
}
