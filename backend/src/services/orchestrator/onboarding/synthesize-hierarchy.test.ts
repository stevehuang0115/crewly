/**
 * Tests for nested sub-team synthesis (P3).
 *
 * - detectStreams: heuristic parallel-stream detection from a goal.
 * - synthesizeHierarchyPlan: parent + child plan (or single flat team).
 * - materializeHierarchy: instantiates the parent then children, linking each
 *   child to the parent via parentTeamId (using an injected fake provisioner).
 *
 * @module services/orchestrator/onboarding/synthesize-hierarchy.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  detectStreams,
  synthesizeHierarchyPlan,
  materializeHierarchy,
  DEFAULT_MAX_SUBTEAMS,
} from './synthesize-hierarchy.js';
import type { BusinessContext } from './recommend-team.js';
import type { MaterializeOptions, ProvisionedTeam, MaterializeResult } from './materialize-team.js';

function ctx(industry: string, tasks: string[] = []): BusinessContext {
  return {
    industry,
    scale: 'small-team',
    tasks: tasks.map((name) => ({ name, tier: 'yes-today' as const })),
  };
}

// ---------------------------------------------------------------------------
// detectStreams
// ---------------------------------------------------------------------------

describe('detectStreams', () => {
  it('detects multiple parallel software streams', () => {
    const streams = detectStreams(
      ctx('build a SaaS with a React frontend, a Node API backend, and DevOps deployment'),
    );
    expect(streams).toEqual(expect.arrayContaining(['frontend', 'backend', 'infra']));
  });

  it('returns a single stream for a focused goal', () => {
    expect(detectStreams(ctx('build a marketing growth campaign on social media'))).toEqual(['growth']);
  });

  it('returns no streams for a goal with no recognised stream keywords', () => {
    expect(detectStreams(ctx('do the thing'))).toEqual([]);
  });

  it('reads task names too, not just the industry string', () => {
    const streams = detectStreams(ctx('a project', ['frontend work', 'backend work']));
    expect(streams).toEqual(expect.arrayContaining(['frontend', 'backend']));
  });
});

// ---------------------------------------------------------------------------
// synthesizeHierarchyPlan
// ---------------------------------------------------------------------------

describe('synthesizeHierarchyPlan', () => {
  it('produces a parent + one child per stream when ≥2 streams', () => {
    const plan = synthesizeHierarchyPlan(
      ctx('build a SaaS: React frontend, Node API backend, DevOps'),
    );
    expect(plan.children.length).toBeGreaterThanOrEqual(2);
    expect(plan.children.map((c) => c.stream)).toEqual(expect.arrayContaining(['frontend', 'backend', 'infra']));
    expect(plan.parent).toBeDefined();
    for (const child of plan.children) {
      expect(child.recommendation.templateId).toBeTruthy();
    }
    expect(plan.rationale).toContain('parallel streams');
  });

  it('returns a single flat team (no children) for <2 streams', () => {
    const plan = synthesizeHierarchyPlan(ctx('grow our social media following'));
    expect(plan.children).toEqual([]);
    expect(plan.parent).toBeDefined();
    expect(plan.rationale).toMatch(/one team is sufficient/i);
  });

  it('caps the number of child teams at maxSubteams', () => {
    // A goal that hits many streams.
    const plan = synthesizeHierarchyPlan(
      ctx('frontend backend devops design data qa content growth research everything'),
      { maxSubteams: 3 },
    );
    expect(plan.children.length).toBeLessThanOrEqual(3);
  });

  it('defaults the branching cap to DEFAULT_MAX_SUBTEAMS', () => {
    const plan = synthesizeHierarchyPlan(
      ctx('frontend backend devops design data qa content growth research'),
    );
    expect(plan.children.length).toBeLessThanOrEqual(DEFAULT_MAX_SUBTEAMS);
  });
});

// ---------------------------------------------------------------------------
// materializeHierarchy
// ---------------------------------------------------------------------------

describe('materializeHierarchy', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'synth-hier-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Options whose fake provisioner hands out sequential team ids + records parent links. */
  function makeOpts(): { opts: MaterializeOptions; provisionCalls: Array<{ name: string; parentTeamId?: string }> } {
    const provisionCalls: Array<{ name: string; parentTeamId?: string }> = [];
    let seq = 0;
    const opts: MaterializeOptions = {
      teamsDir: path.join(root, 'teams'),
      projectFlagPath: path.join(root, 'flag.json'),
      provisionTeam: async (_rec, teamName, _owner, parentTeamId): Promise<ProvisionedTeam> => {
        provisionCalls.push({ name: teamName, parentTeamId });
        seq += 1;
        return { teamId: `team-${seq}`, memberCount: 3 };
      },
    };
    return { opts, provisionCalls };
  }

  it('materializes the parent first, then each child linked to the parent', async () => {
    const plan = synthesizeHierarchyPlan(
      ctx('build a SaaS: React frontend, Node API backend, DevOps'),
    );
    const { opts, provisionCalls } = makeOpts();

    const result = await materializeHierarchy(plan, opts);

    // Parent created first (no parentTeamId), then children (all linked to it).
    expect(result.parentTeamId).toBe('team-1');
    expect(provisionCalls[0].parentTeamId).toBeUndefined();
    expect(result.children.length).toBe(plan.children.length);
    for (const child of result.children) {
      expect(child.parentTeamId).toBe('team-1');
      expect(child.provisioned).toBe(true);
      expect(child.memberCount).toBe(3);
    }
    // Every provision call after the first carried the parent id.
    for (const call of provisionCalls.slice(1)) {
      expect(call.parentTeamId).toBe('team-1');
    }
  });

  it('creates only the parent when the plan has no children', async () => {
    const plan = synthesizeHierarchyPlan(ctx('grow our social media following'));
    const { opts, provisionCalls } = makeOpts();

    const result = await materializeHierarchy(plan, opts);

    expect(result.children).toEqual([]);
    expect(result.parentTeamId).toBe('team-1');
    expect(provisionCalls).toHaveLength(1);
  });

  it('surfaces a child fallback via provisioned:false without throwing', async () => {
    const plan = synthesizeHierarchyPlan(
      ctx('build a SaaS: React frontend, Node API backend, DevOps'),
    );
    // Provisioner returns null for children → minimal fallback path.
    let seq = 0;
    const opts: MaterializeOptions = {
      teamsDir: path.join(root, 'teams'),
      projectFlagPath: path.join(root, 'flag.json'),
      provisionTeam: async (_rec, _name, _owner, parentTeamId) => {
        seq += 1;
        // Parent provisions live; children decline → fallback.
        return parentTeamId === undefined ? ({ teamId: `team-${seq}`, memberCount: 3 } as ProvisionedTeam) : null;
      },
    };

    const result: Awaited<ReturnType<typeof materializeHierarchy>> = await materializeHierarchy(plan, opts);
    expect(result.parentProvisioned).toBe(true);
    expect(result.children.every((c) => c.provisioned === false)).toBe(true);
    // Children still got real (fallback) ids and parent links.
    for (const c of result.children) expect(c.parentTeamId).toBe(result.parentTeamId);
  });

  // Keep the MaterializeResult import meaningful for type-checkers.
  it('returns a typed parent member count', async () => {
    const plan = synthesizeHierarchyPlan(ctx('grow our social media following'));
    const { opts } = makeOpts();
    const result = await materializeHierarchy(plan, opts);
    const count: MaterializeResult['memberCount'] = result.parentMemberCount;
    expect(typeof count).toBe('number');
  });
});
