/**
 * Materialize-Team Logic (Onboarding v3)
 *
 * Turns a confirmed {@link TeamRecommendation} into a REAL, persisted team
 * that the rest of the system can run hands-off:
 *
 *   1. Provision a live, template-backed team via the proven
 *      `TemplateService.createTeamFromTemplate` + `StorageService.saveTeam`
 *      path — the same path `onboarding-provision.service.ts` uses. The
 *      created members carry real system prompts, skill sets, hierarchy
 *      (`hierarchyLevel` / `parentMemberId`) and `canDelegate` flags from the
 *      template, so the orchestrator can immediately delegate into the team
 *      and the agents auto-activate on first claim.
 *   2. Flip the project `onboardingComplete` flag.
 *
 * Fallback: if the recommendation's `templateId` is not a registered template
 * (or provisioning throws — e.g. a tier-gated template on OSS), we write the
 * legacy minimal `config.json` stub so the orc never dead-ends. That stub has
 * inactive members with empty prompts and is clearly marked `provisioned:false`
 * so callers can warn the user that a generic team was created.
 *
 * History: this was a "Mon EOD v0 stub" that only wrote a dead config and
 * flipped a flag (members `agentStatus:'inactive'`, empty `systemPrompt`),
 * which meant every new-team goal required a human to actually stand up
 * agents. P0 of the autonomy roadmap wires it to real provisioning.
 *
 * The function stays injection-friendly: callers pass `teamsDir`,
 * `projectFlagPath`, a UUID generator, a clock, and (for tests) a
 * `provisionTeam` implementation — so unit tests run against tmp dirs with
 * deterministic IDs and a fake provisioner, never touching the real
 * `~/.crewly` tree or the singletons.
 *
 * @module services/orchestrator/onboarding/materialize-team
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { TeamRecommendation } from './recommend-team.js';

// =============================================================================
// Types
// =============================================================================

/** A live team produced by {@link MaterializeOptions.provisionTeam}. */
export interface ProvisionedTeam {
  /** Persisted team id (from StorageService). */
  readonly teamId: string;
  /** Number of members created from the template. */
  readonly memberCount: number;
}

/**
 * Side-effects the materialize step needs. Injected so tests can run
 * against a tmp dir + a fake provisioner without touching the real
 * `~/.crewly` tree or the TemplateService/StorageService singletons.
 */
export interface MaterializeOptions {
  /** Root teams directory for the FALLBACK stub write (e.g. `~/.crewly/teams`). */
  readonly teamsDir: string;
  /** File path for the project onboarding-complete flag. */
  readonly projectFlagPath: string;
  /** UUID generator (fallback stub only) — defaults to {@link crypto.randomUUID}. */
  readonly uuid?: () => string;
  /** Clock — defaults to `() => new Date()` when omitted. */
  readonly now?: () => Date;
  /** Optional logger sink — receives the materialize log lines. */
  readonly log?: (message: string) => void;
  /** Owner principal to attribute the created team to (multi-tenant). */
  readonly ownerUserId?: string;
  /**
   * Parent team id, set when this team is a CHILD in a nested hierarchy (P3).
   * Links the created team to its parent so the parent TL coordinates it.
   * Undefined for a standalone or top-level team.
   */
  readonly parentTeamId?: string;
  /**
   * Team provisioner. Defaults to {@link defaultProvisionTeam}, which creates
   * a live, persisted, template-backed team. Returns `null` when the
   * recommendation's `templateId` is not a registered template, signalling the
   * caller to fall back to a minimal stub. Tests inject a fake.
   */
  readonly provisionTeam?: (
    recommendation: TeamRecommendation,
    teamName: string,
    ownerUserId: string | undefined,
    parentTeamId: string | undefined,
  ) => Promise<ProvisionedTeam | null>;
}

/**
 * Outcome of a successful materialize call.
 */
export interface MaterializeResult {
  /** Team ID — the persisted team id (live path) or the generated id (fallback). */
  readonly teamId: string;
  /**
   * Absolute path to the team's fallback `config.json`. Empty string on the
   * live path (the team is persisted via StorageService, not a flat file).
   */
  readonly teamConfigPath: string;
  /** Always `true` for a successful call — mirrors "flips `onboardingComplete = true`". */
  readonly onboardingComplete: true;
  /** Echo of the recommendation that was materialized (for the orc to summarise back). */
  readonly recommendation: TeamRecommendation;
  /** Where the project flag was persisted. */
  readonly projectFlagPath: string;
  /** Number of members on the created team. */
  readonly memberCount: number;
  /**
   * `true` when a live, template-backed team was provisioned (real agents,
   * prompts, hierarchy). `false` when provisioning was unavailable and a
   * minimal stub config was written instead — the orc should tell the user a
   * generic team was created and offer to refine it.
   */
  readonly provisioned: boolean;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Materialize a {@link TeamRecommendation} into a REAL team + project
 * onboarding-complete flag.
 *
 * @param recommendation - Output of {@link recommendTeam} that the user confirmed.
 * @param opts - Side-effect injection (teamsDir, projectFlagPath, provisionTeam, …).
 * @returns The team ID + member count + provisioned flag + flag-path on success.
 * @throws If BOTH provisioning fails AND the fallback config write fails
 *         (filesystem error). Caller surfaces a brief honest error rather than
 *         retrying silently.
 *
 * @example
 * ```ts
 * import { getCrewlyHomePath } from '../../core/crewly-home.utils.js';
 *
 * const crewlyHome = getCrewlyHomePath();
 * const result = await materializeTeam(rec, {
 *   teamsDir: path.join(crewlyHome, 'teams'),
 *   projectFlagPath: path.join(crewlyHome, 'onboarding-complete.json'),
 * });
 * // result.provisioned === true → live team `result.teamId` with `result.memberCount` agents
 * ```
 *
 * Do NOT inline `path.join(os.homedir(), '.crewly/teams')` — that ignores
 * CREWLY_HOME and breaks ESTestNode + dry-run-kit isolation.
 */
export async function materializeTeam(
  recommendation: TeamRecommendation,
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const now = opts.now ?? defaultNow;
  const log = opts.log ?? noopLog;
  // Bind the live provisioner to the SAME root the caller injected (issue
  // #729). `teamsDir` is `<crewlyHome>/teams`, so its parent is the home the
  // storage layer must use. Without this the live path went through
  // `StorageService.getInstance()` with no argument — resolving the ambient
  // CREWLY_HOME and ignoring the injected root entirely. A verification run
  // that carefully pointed `teamsDir` at a scratch dir still persisted live
  // teams into the developer's real `~/.crewly/teams`, which is how three stub
  // teams leaked there. In production `dirname(teamsDir)` IS the real home, so
  // the cached singleton is returned unchanged.
  const provisionTeam =
    opts.provisionTeam
    ?? ((rec, name, owner, parent) =>
      defaultProvisionTeam(rec, name, owner, parent, path.dirname(opts.teamsDir)));
  const createdAt = now().toISOString();
  const teamName = humanizeTemplateName(recommendation.templateId);

  log(
    `[materialize-team] materializing template "${recommendation.templateId}" (${recommendation.agents.length} recommended agents)`,
  );

  // 1. Provision a live, persisted, template-backed team when possible.
  let teamId: string;
  let memberCount: number;
  let teamConfigPath = '';
  let provisioned: boolean;

  let live: ProvisionedTeam | null = null;
  try {
    live = await provisionTeam(recommendation, teamName, opts.ownerUserId, opts.parentTeamId);
  } catch (err) {
    // Tier-gated template, missing registry, or storage error — don't dead-end
    // the orc; drop to the minimal fallback with a warning.
    log(
      `[materialize-team] WARN live provisioning failed for template "${recommendation.templateId}" ` +
        `(${err instanceof Error ? err.message : String(err)}) — falling back to a minimal team`,
    );
  }

  if (live) {
    teamId = live.teamId;
    memberCount = live.memberCount;
    provisioned = true;
    log(
      `[materialize-team] provisioned LIVE team id=${teamId} (${memberCount} members) from template "${recommendation.templateId}"`,
    );
  } else {
    // Fallback: template not registered / provisioning unavailable. Write a
    // minimal stub config so the orc still has a team to talk about.
    const uuid = opts.uuid ?? defaultUuid;
    teamId = uuid();
    const teamDir = path.join(opts.teamsDir, teamId);
    teamConfigPath = path.join(teamDir, 'config.json');
    const config = buildTeamConfig(recommendation, teamId, createdAt);
    memberCount = recommendation.agents.length;
    provisioned = false;
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(teamConfigPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    log(
      `[materialize-team] wrote MINIMAL fallback config id=${teamId} ` +
        `(template "${recommendation.templateId}" not provisionable)`,
    );
  }

  // 2. Flip the project onboarding-complete flag.
  const flag = { onboardingComplete: true, completedAt: createdAt, teamId };
  await fs.mkdir(path.dirname(opts.projectFlagPath), { recursive: true });
  await fs.writeFile(opts.projectFlagPath, JSON.stringify(flag, null, 2) + '\n', 'utf8');

  log(`[materialize-team] flipped onboardingComplete = true at ${opts.projectFlagPath}`);

  return {
    teamId,
    teamConfigPath,
    onboardingComplete: true,
    recommendation,
    projectFlagPath: opts.projectFlagPath,
    memberCount,
    provisioned,
  };
}

// =============================================================================
// Internals
// =============================================================================

/**
 * Default team provisioner: create a live, persisted team from the
 * recommendation's template via the same path `onboarding-provision.service.ts`
 * uses. Lazy-imports the singletons so this module stays dependency-light and
 * unit-testable (callers inject a fake `provisionTeam` instead).
 *
 * @param recommendation - The confirmed recommendation (carries `templateId`).
 * @param teamName - Human-readable team name to assign.
 * @param ownerUserId - Owner principal, or undefined for OSS single-user mode.
 * @param parentTeamId - Parent team id for a nested child team, else undefined.
 * @param storageHome - Crewly home the team must be persisted under. Passed
 *   explicitly (never re-resolved from the environment) so an injected root is
 *   honoured by the live path too — see issue #729.
 * @returns The persisted team id + member count, or `null` when the template
 *          is not registered (caller falls back to a minimal stub).
 * @throws Propagates a tier-gating error from `createTeamFromTemplate` (the
 *         caller catches it and falls back).
 */
async function defaultProvisionTeam(
  recommendation: TeamRecommendation,
  teamName: string,
  ownerUserId: string | undefined,
  parentTeamId: string | undefined,
  storageHome: string,
): Promise<ProvisionedTeam | null> {
  const { TemplateService } = await import('../../template/template.service.js');
  const { StorageService } = await import('../../core/storage.service.js');

  const result = TemplateService.getInstance().createTeamFromTemplate(
    recommendation.templateId,
    teamName,
  );
  if (!result) return null;

  // Attribute to the authenticated principal (multi-tenant). Undefined in OSS
  // single-user mode leaves the team unscoped (legacy behaviour).
  if (ownerUserId !== undefined) {
    result.team.ownerUserId = ownerUserId;
  }

  // Link to the parent team when this is a child in a nested hierarchy (P3).
  if (parentTeamId !== undefined) {
    result.team.parentTeamId = parentTeamId;
  }

  // Explicit home — see the binding comment in materializeTeam. A bare
  // getInstance() here would silently re-resolve the ambient CREWLY_HOME.
  await StorageService.getInstance(storageHome).saveTeam(result.team);

  return { teamId: result.team.id, memberCount: result.memberCount };
}

/**
 * Build the minimal FALLBACK team config. Members are derived 1:1 from the
 * recommendation's agents list, inactive with empty prompts. Only used when
 * live provisioning is unavailable.
 *
 * @param rec - The recommendation to materialize.
 * @param teamId - The generated team id.
 * @param createdAt - ISO creation timestamp.
 * @returns A plain config object ready to JSON-serialize.
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
 * (`"dtc-viral-content-team"` → `"Dtc Viral Content Team"`).
 *
 * @param templateId - The kebab-case template id.
 * @returns A title-cased, space-separated name.
 */
function humanizeTemplateName(templateId: string): string {
  return templateId
    .split('-')
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/**
 * Convert a kebab-case role → human display name.
 *
 * @param role - The kebab-case role id.
 * @returns A title-cased, space-separated name.
 */
function humanizeRoleName(role: string): string {
  return role
    .split('-')
    .map((p) => (p.length ? p[0].toUpperCase() + p.slice(1) : p))
    .join(' ');
}

/**
 * Default UUID generator (fallback stub only).
 *
 * @returns A random UUID string.
 */
function defaultUuid(): string {
  const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
  return randomUUID();
}

/**
 * Default clock — wall-clock time.
 *
 * @returns The current Date.
 */
function defaultNow(): Date {
  return new Date();
}

/**
 * Default log sink — drops the message on the floor.
 *
 * @param _message - Ignored.
 */
function noopLog(_message: string): void {
  /* intentional no-op */
}
