/**
 * Nested sub-team synthesis (Autonomy roadmap P3).
 *
 * When a goal needs PARALLEL work-streams (e.g. "build a SaaS with a frontend,
 * a backend, and DevOps"), a single flat team is the wrong shape — you want a
 * top coordination team whose lead (TL) delegates to per-stream CHILD teams,
 * each with its own TL who decomposes + verifies its slice and reports up.
 * The data model already supports this (`Team.parentTeamId`,
 * `TeamMember.parentMemberId`/`hierarchyLevel`) but nothing DECIDED the shape
 * or instantiated it — complex goals had to be wired by hand.
 *
 * This module adds that decision + instantiation:
 *   1. {@link detectStreams} — heuristically find the parallel streams in a goal.
 *   2. {@link synthesizeHierarchyPlan} — turn them into a parent + child-team
 *      plan (or a single flat team when <2 streams), capped by a branching
 *      limit aligned with fission-guard's `maxBranchingFactor`.
 *   3. {@link materializeHierarchy} — instantiate the parent then each child via
 *      the P0 {@link materializeTeam} path, linking children to the parent.
 *
 * The stream detection is heuristic (v1) — same spirit as the hardcoded
 * `recommendTeam` mappings; a semantic/LLM planner is a later upgrade. The
 * STRUCTURE (parent + linked children, real provisioning) is the deliverable.
 *
 * @module services/orchestrator/onboarding/synthesize-hierarchy
 */

import {
  recommendTeam,
  type BusinessContext,
  type TeamRecommendation,
} from './recommend-team.js';
import {
  materializeTeam,
  type MaterializeOptions,
} from './materialize-team.js';

// =============================================================================
// Stream detection
// =============================================================================

/**
 * Default cap on child teams in a single hierarchy. Aligned with fission-guard's
 * `maxBranchingFactor` so the synthesized shape never exceeds the runtime's
 * fan-out guardrail.
 */
export const DEFAULT_MAX_SUBTEAMS = 5;

/**
 * Known parallel work-streams and the keywords that signal each. Order defines
 * the order streams appear in a plan. Keep specific phrases first.
 */
const STREAM_KEYWORDS: Record<string, readonly string[]> = {
  frontend: ['frontend', 'front-end', 'front end', 'ui', 'react', 'vue', 'web app', 'client app', 'mobile app'],
  backend: ['backend', 'back-end', 'back end', 'api', 'server', 'database', 'endpoint', 'microservice'],
  infra: ['devops', 'infra', 'infrastructure', 'deploy', 'deployment', 'ci/cd', 'kubernetes', 'docker', 'cloud', 'sre'],
  design: ['design', 'ux', 'ui/ux', 'figma', 'branding', 'wireframe'],
  data: ['data', 'analytics', 'machine learning', 'ml model', 'data pipeline', 'etl', 'dashboard'],
  qa: ['qa', 'quality assurance', 'test automation', 'e2e test', 'testing'],
  content: ['content', 'copywriting', 'editorial', 'seo content', 'blog'],
  growth: ['growth', 'marketing', 'social media', 'ad campaign', 'acquisition'],
  research: ['research', 'competitor analysis', 'market research', 'user research'],
};

/**
 * Build the lowercased searchable text for a context (industry + task names).
 *
 * @param ctx - The business context.
 * @returns A single lowercased haystack string.
 */
function buildHaystack(ctx: BusinessContext): string {
  const parts: string[] = [ctx.industry ?? ''];
  for (const t of ctx.tasks) parts.push(t.name);
  return parts.join(' ').toLowerCase();
}

/**
 * Detect the parallel work-streams named in a goal context.
 *
 * @param ctx - The business context (goal/industry + tasks).
 * @returns Stream keys (e.g. `['frontend','backend','infra']`) in canonical order.
 */
export function detectStreams(ctx: BusinessContext): string[] {
  const hay = buildHaystack(ctx);
  return Object.entries(STREAM_KEYWORDS)
    .filter(([, kws]) => kws.some((k) => matchesKeyword(hay, k)))
    .map(([stream]) => stream);
}

/**
 * Word-boundary keyword match. Substring matching would false-positive on short
 * keywords — e.g. `"build"` contains `"ui"`, `"database"` contains nothing but
 * `"api"` would match inside `"rapid"`. Anchoring on `\b` requires the keyword
 * to appear as a whole word (multi-word phrases like `"web app"` still work).
 *
 * @param hay - The lowercased haystack.
 * @param keyword - The keyword/phrase to look for.
 * @returns True when the keyword appears as a whole word/phrase.
 */
function matchesKeyword(hay: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(hay);
}

// =============================================================================
// Plan
// =============================================================================

/** One child team in a synthesized hierarchy. */
export interface HierarchyNode {
  /** The stream this child team owns (e.g. `frontend`). */
  readonly stream: string;
  /** The team recommendation for this child. */
  readonly recommendation: TeamRecommendation;
}

/** A synthesized team hierarchy: a parent coordination team + child teams. */
export interface HierarchyPlan {
  /** Top coordination team (its TL delegates to + accepts from the children). */
  readonly parent: TeamRecommendation;
  /** Per-stream child teams. Empty → a single flat team is sufficient. */
  readonly children: readonly HierarchyNode[];
  /** Human-readable rationale for the shape. */
  readonly rationale: string;
}

/** Options for {@link synthesizeHierarchyPlan}. */
export interface SynthesizeOptions {
  /** Max child teams (default {@link DEFAULT_MAX_SUBTEAMS}). */
  readonly maxSubteams?: number;
}

/**
 * Focus a context on a single stream so {@link recommendTeam} steers toward a
 * stream-appropriate template (the stream keyword is prepended to the industry
 * string, which `recommendTeam` scores against).
 *
 * @param ctx - The original context.
 * @param stream - The stream to focus on.
 * @returns A context biased toward the stream.
 */
function focusedContext(ctx: BusinessContext, stream: string): BusinessContext {
  return { ...ctx, industry: `${stream} — ${ctx.industry}` };
}

/**
 * Synthesize a (possibly nested) team plan for a goal.
 *
 * If fewer than 2 parallel streams are detected, returns a single flat team
 * (no children) — nesting would be overhead. Otherwise returns a parent
 * coordination team plus one child team per detected stream, capped at
 * `maxSubteams`.
 *
 * @param ctx - The goal/business context.
 * @param opts - Synthesis options (branching cap).
 * @returns The hierarchy plan.
 *
 * @example
 * ```ts
 * const plan = synthesizeHierarchyPlan({
 *   industry: 'build a SaaS with a React frontend, a Node API backend, and DevOps',
 *   scale: 'small-team',
 *   tasks: [],
 * });
 * // plan.children → frontend / backend / infra child teams under a parent
 * ```
 */
export function synthesizeHierarchyPlan(
  ctx: BusinessContext,
  opts: SynthesizeOptions = {},
): HierarchyPlan {
  const max = Math.max(1, opts.maxSubteams ?? DEFAULT_MAX_SUBTEAMS);
  const streams = detectStreams(ctx).slice(0, max);

  if (streams.length < 2) {
    return {
      parent: recommendTeam(ctx),
      children: [],
      rationale:
        streams.length === 1
          ? `Single work-stream ("${streams[0]}") — one team is sufficient; no sub-teams created.`
          : 'No distinct parallel streams detected — one team is sufficient.',
    };
  }

  const parent = recommendTeam(ctx);
  const children: HierarchyNode[] = streams.map((stream) => ({
    stream,
    recommendation: recommendTeam(focusedContext(ctx, stream)),
  }));

  return {
    parent,
    children,
    rationale: `Detected ${streams.length} parallel streams (${streams.join(', ')}); ` +
      `created a coordination team with one child team per stream.`,
  };
}

// =============================================================================
// Materialize
// =============================================================================

/** A child team that was instantiated as part of a hierarchy. */
export interface MaterializedChild {
  readonly stream: string;
  readonly teamId: string;
  readonly memberCount: number;
  readonly parentTeamId: string;
  readonly provisioned: boolean;
}

/** Result of {@link materializeHierarchy}. */
export interface MaterializedHierarchy {
  readonly parentTeamId: string;
  readonly parentMemberCount: number;
  readonly parentProvisioned: boolean;
  readonly children: readonly MaterializedChild[];
}

/**
 * Instantiate a {@link HierarchyPlan}: materialize the parent team, then each
 * child team linked to the parent via `parentTeamId`. Reuses the P0
 * {@link materializeTeam} path (real, persisted, template-backed teams).
 *
 * The same `opts` (teamsDir, projectFlagPath, ownerUserId, provisionTeam, …)
 * is used for every team; the per-child `parentTeamId` is injected by this
 * function. When the plan has no children, only the parent is created (this is
 * equivalent to a single {@link materializeTeam} call).
 *
 * @param plan - The hierarchy plan from {@link synthesizeHierarchyPlan}.
 * @param opts - Materialize options shared across all teams.
 * @returns The created parent + children team ids with parent links.
 * @throws If the PARENT materialize fails (a child failure is surfaced via its
 *         `provisioned` flag, not thrown — partial hierarchies are usable).
 */
export async function materializeHierarchy(
  plan: HierarchyPlan,
  opts: MaterializeOptions,
): Promise<MaterializedHierarchy> {
  // 1. Parent first — children link to it.
  const parent = await materializeTeam(plan.parent, opts);

  // 2. Each child, linked to the parent.
  const children: MaterializedChild[] = [];
  for (const node of plan.children) {
    const child = await materializeTeam(node.recommendation, {
      ...opts,
      parentTeamId: parent.teamId,
    });
    children.push({
      stream: node.stream,
      teamId: child.teamId,
      memberCount: child.memberCount,
      parentTeamId: parent.teamId,
      provisioned: child.provisioned,
    });
  }

  return {
    parentTeamId: parent.teamId,
    parentMemberCount: parent.memberCount,
    parentProvisioned: parent.provisioned,
    children,
  };
}
