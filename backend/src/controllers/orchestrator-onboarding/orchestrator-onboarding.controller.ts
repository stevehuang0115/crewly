/**
 * Orchestrator-Onboarding REST Controller
 *
 * HTTP surface for the two onboarding-only skills orc invokes during
 * the v3 cold-start conversation flow:
 *
 *   - POST /api/orchestrator/onboarding/recommend-team
 *   - POST /api/orchestrator/onboarding/materialize-team
 *
 * Both endpoints are thin wrappers around the pure logic in
 * `services/orchestrator/onboarding/{recommend,materialize}-team.ts`.
 * The controller validates request shape, calls the logic, and shapes
 * the JSON response.
 *
 * @module controllers/orchestrator-onboarding/orchestrator-onboarding.controller
 */

import type { Request, Response, NextFunction } from 'express';
import * as path from 'node:path';

import {
  recommendTeam,
  type BusinessContext,
  type FeasibilityTier,
  type BusinessScale,
} from '../../services/orchestrator/onboarding/recommend-team.js';
import {
  materializeTeam,
  type MaterializeOptions,
} from '../../services/orchestrator/onboarding/materialize-team.js';
import type { TeamRecommendation } from '../../services/orchestrator/onboarding/recommend-team.js';
import { LoggerService } from '../../services/core/logger.service.js';
import { getCrewlyHomePath } from '../../services/core/crewly-home.utils.js';

const logger = LoggerService.getInstance().createComponentLogger(
  'OrchestratorOnboardingController',
);

const VALID_TIERS: ReadonlySet<FeasibilityTier> = new Set([
  'yes-today',
  'collaborative',
  'roadmap',
  'out-of-scope',
]);
const VALID_SCALES: ReadonlySet<BusinessScale> = new Set([
  'solo',
  'small-team',
  'company',
]);

/**
 * Default teams directory used when the request does not override it.
 * Mirrors the convention used by team config storage (`<crewlyHome>/teams`).
 *
 * Honours the `CREWLY_HOME` environment variable via
 * {@link getCrewlyHomePath} so test profiles (ESTestNode, KR3
 * walkthroughs, dry-run kits) actually land under the override path
 * instead of the developer's real `~/.crewly`.
 */
function defaultTeamsDir(): string {
  return path.join(getCrewlyHomePath(), 'teams');
}

/**
 * Default project flag path (Mon-EOD stub: a tiny JSON file under the
 * Crewly home dir). Wed–Fri this will move into the orchestrator state
 * persistence file proper.
 *
 * Honours the `CREWLY_HOME` environment variable via
 * {@link getCrewlyHomePath} for the same reason as
 * {@link defaultTeamsDir}.
 */
function defaultProjectFlagPath(): string {
  return path.join(getCrewlyHomePath(), 'onboarding-complete.json');
}

/**
 * POST /api/orchestrator/onboarding/recommend-team
 *
 * Body: { industry: string, scale: BusinessScale, tasks: NamedTask[] }
 *
 * Returns 200 with the {@link TeamRecommendation} on success, 400 on
 * malformed input. The function never falls back to a 500 — recommend
 * itself is total.
 */
export async function recommendTeamRoute(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ctx = parseBusinessContext(req.body);
    if (!ctx.ok) {
      res.status(400).json({ success: false, error: ctx.error });
      return;
    }
    const recommendation = recommendTeam(ctx.value);
    res.status(200).json({ success: true, recommendation });
  } catch (err) {
    logger.error('recommend-team route failed', { err });
    next(err);
  }
}

/**
 * POST /api/orchestrator/onboarding/materialize-team
 *
 * Body: { recommendation: TeamRecommendation, teamsDir?: string, projectFlagPath?: string }
 *
 * Writes the team config + flips `onboardingComplete`. v0 stub —
 * the real provisioning lands Wed–Fri.
 *
 * Returns 200 with the materialize result on success; 400 if the
 * recommendation body is malformed; 500 only on actual filesystem
 * errors (orc surfaces those honestly to the user).
 */
export async function materializeTeamRoute(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = parseRecommendation(req.body?.recommendation);
    if (!parsed.ok) {
      res.status(400).json({ success: false, error: parsed.error });
      return;
    }

    const opts: MaterializeOptions = {
      teamsDir:
        typeof req.body?.teamsDir === 'string' && req.body.teamsDir.length > 0
          ? req.body.teamsDir
          : defaultTeamsDir(),
      projectFlagPath:
        typeof req.body?.projectFlagPath === 'string' &&
        req.body.projectFlagPath.length > 0
          ? req.body.projectFlagPath
          : defaultProjectFlagPath(),
      log: (m: string) => logger.info(m),
    };

    const result = await materializeTeam(parsed.value, opts);
    res.status(200).json({ success: true, result });
  } catch (err) {
    logger.error('materialize-team route failed', { err });
    res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================================
// Parsers
// =============================================================================

type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseBusinessContext(
  body: unknown,
): ParseResult<BusinessContext> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'request body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.industry !== 'string') {
    return { ok: false, error: 'industry must be a string' };
  }
  if (typeof b.scale !== 'string' || !VALID_SCALES.has(b.scale as BusinessScale)) {
    return {
      ok: false,
      error: `scale must be one of: ${[...VALID_SCALES].join(', ')}`,
    };
  }
  if (!Array.isArray(b.tasks)) {
    return { ok: false, error: 'tasks must be an array' };
  }

  const tasks: { name: string; tier: FeasibilityTier }[] = [];
  for (let i = 0; i < b.tasks.length; i++) {
    const t = b.tasks[i] as Record<string, unknown> | undefined;
    if (!t || typeof t.name !== 'string') {
      return { ok: false, error: `tasks[${i}].name must be a string` };
    }
    if (typeof t.tier !== 'string' || !VALID_TIERS.has(t.tier as FeasibilityTier)) {
      return {
        ok: false,
        error: `tasks[${i}].tier must be one of: ${[...VALID_TIERS].join(', ')}`,
      };
    }
    tasks.push({ name: t.name, tier: t.tier as FeasibilityTier });
  }

  return {
    ok: true,
    value: {
      industry: b.industry,
      scale: b.scale as BusinessScale,
      tasks,
    },
  };
}

function parseRecommendation(body: unknown): ParseResult<TeamRecommendation> {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'recommendation must be an object' };
  }
  const r = body as Record<string, unknown>;
  if (typeof r.templateId !== 'string' || r.templateId.length === 0) {
    return { ok: false, error: 'recommendation.templateId must be a non-empty string' };
  }
  if (!Array.isArray(r.agents) || r.agents.length === 0) {
    return { ok: false, error: 'recommendation.agents must be a non-empty array' };
  }
  if (typeof r.reasoning !== 'string') {
    return { ok: false, error: 'recommendation.reasoning must be a string' };
  }
  if (typeof r.source !== 'string') {
    return { ok: false, error: 'recommendation.source must be a string' };
  }

  const agents: { role: string; responsibilities: string; skillIds: string[] }[] = [];
  for (let i = 0; i < r.agents.length; i++) {
    const a = r.agents[i] as Record<string, unknown> | undefined;
    if (!a || typeof a.role !== 'string') {
      return { ok: false, error: `recommendation.agents[${i}].role must be a string` };
    }
    if (typeof a.responsibilities !== 'string') {
      return {
        ok: false,
        error: `recommendation.agents[${i}].responsibilities must be a string`,
      };
    }
    if (!Array.isArray(a.skillIds)) {
      return {
        ok: false,
        error: `recommendation.agents[${i}].skillIds must be an array`,
      };
    }
    agents.push({
      role: a.role,
      responsibilities: a.responsibilities,
      skillIds: a.skillIds.map((s) => String(s)),
    });
  }

  return {
    ok: true,
    value: {
      templateId: r.templateId,
      agents,
      reasoning: r.reasoning,
      source: r.source,
    },
  };
}
