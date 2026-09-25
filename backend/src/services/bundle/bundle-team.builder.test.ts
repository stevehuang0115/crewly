/**
 * Tests for building bundle teams: filled prompts, deterministic ids, ASCII
 * session names, one runtime, hierarchy wiring, clear placeholder errors.
 */

import type { BundleTemplate } from '../../types/solution-bundle.types.js';
import { bundleTeams } from './bundle-manifest.js';
import { BundlePlaceholderError } from './bundle-placeholders.js';
import {
  buildBundleTeam,
  bundleTeamId,
  memberForRole,
  memberNameFor,
  memberSession,
  teamPlaceholderValues,
  toSlug,
} from './bundle-team.builder.js';

const NOW = new Date('2026-09-25T08:00:00.000Z');

/** A two-team bundle. */
function template(): BundleTemplate {
  return {
    id: 'demo-bundle',
    name: 'Demo',
    description: '给 {{business_name}} 做内容',
    hierarchical: true,
    mission: '服务 {{business_name}}',
    roles: [
      {
        role: 'team-leader',
        label: 'Lead',
        defaultName: 'Ava',
        count: 1,
        hierarchyLevel: 1,
        canDelegate: true,
        defaultSkills: ['delegate-task'],
        jobTitle: '负责人',
        jobDescription: '向 {{owner_title}} 汇报',
        promptAdditions: '你是 {{lead_name}}，{{team_name}} 的负责人。品牌：{{business_name}}',
      },
      {
        role: 'content-strategist',
        label: 'Writer',
        defaultName: 'Writer',
        count: 2,
        hierarchyLevel: 2,
        canDelegate: false,
        reportsTo: 'team-leader',
        defaultSkills: [],
      },
    ],
    bundle: {
      schemaVersion: 1,
      label: 'x',
      tagline: 'x',
      ownerSummary: 'x',
      runtime: { recommended: 'crewly-agent' },
      server: { tier: 'entry' },
      teamName: '{{business_name}} 营销团队',
      teams: [
        {
          key: 'ops',
          name: '{{business_name}} 运营',
          roles: [{ role: 'team-leader', label: 'Ops lead', defaultName: 'Oli', count: 1, hierarchyLevel: 1, canDelegate: true, defaultSkills: [] }],
        },
      ],
    },
  };
}

const ANSWERS = { business_name: '小周咖啡', owner_title: '老板' };

describe('bundle team builder', () => {
  it('builds the main team with filled prompts, a deterministic id and the runtime', () => {
    const t = template();
    const team = buildBundleTeam({ template: t, team: bundleTeams(t)[0], answers: ANSWERS, runtime: 'crewly-agent', now: NOW });
    expect(team.id).toBe('demo-bundle');
    expect(team.name).toBe('小周咖啡 营销团队');
    expect(team.templateId).toBe('demo-bundle');
    expect(team.mission).toBe('服务 小周咖啡');
    expect(team.members.map((m) => m.name)).toEqual(['Ava', 'Writer1', 'Writer2']);
    expect(team.members.every((m) => m.runtimeType === 'crewly-agent')).toBe(true);
    const lead = team.members[0];
    expect(lead.systemPrompt).toBe('你是 Ava，小周咖啡 营销团队 的负责人。品牌：小周咖啡');
    expect(lead.jobTitle).toBe('负责人');
    expect(lead.jobDescription).toBe('向 老板 汇报');
    expect(lead.skillOverrides).toEqual(['delegate-task']);
    expect(team.members[1].skillOverrides).toBeUndefined();
    expect(team.members[1].jobTitle).toBe('Writer');
  });

  it('uses ASCII session names from the team id and member name, equal to agentId', () => {
    const t = template();
    const team = buildBundleTeam({ template: t, team: bundleTeams(t)[0], answers: ANSWERS, runtime: 'claude-code', now: NOW });
    for (const m of team.members) {
      expect(m.sessionName).toMatch(/^demo-bundle-[a-z0-9-]+-[0-9a-f]{8}$/);
      expect(m.agentId).toBe(m.sessionName);
      expect(memberSession(m)).toBe(m.sessionName);
    }
  });

  it('wires the hierarchy and the leader', () => {
    const t = template();
    const team = buildBundleTeam({ template: t, team: bundleTeams(t)[0], answers: ANSWERS, runtime: 'claude-code', now: NOW });
    const [lead, w1, w2] = team.members;
    expect(team.leaderId).toBe(lead.id);
    expect(team.leaderIds).toEqual([lead.id]);
    expect(w1.parentMemberId).toBe(lead.id);
    expect(w2.parentMemberId).toBe(lead.id);
    expect(lead.subordinateIds).toEqual([w1.id, w2.id]);
    expect(memberForRole(team, 'content-strategist')?.name).toBe('Writer1');
    expect(memberForRole(team, 'nobody')).toBeUndefined();
  });

  it('builds extra teams under <templateId>--<key>', () => {
    const t = template();
    const ops = buildBundleTeam({ template: t, team: bundleTeams(t)[1], answers: ANSWERS, runtime: 'claude-code', now: NOW });
    expect(ops.id).toBe('demo-bundle--ops');
    expect(ops.name).toBe('小周咖啡 运营');
    expect(ops.mission).toBeUndefined();
    expect(ops.members[0].sessionName.startsWith('demo-bundle-ops-oli-')).toBe(true);
  });

  it('throws a clear error when an answer is missing', () => {
    const t = template();
    expect(() => buildBundleTeam({ template: t, team: bundleTeams(t)[0], answers: {}, runtime: 'claude-code', now: NOW })).toThrow(BundlePlaceholderError);
  });

  it('helpers', () => {
    expect(toSlug('Hello World!')).toBe('hello-world');
    expect(toSlug('小周')).toBe('');
    expect(bundleTeamId('t', 'main')).toBe('t');
    expect(bundleTeamId('t', 'ops')).toBe('t--ops');
    expect(memberNameFor('Dev', 1, 0)).toBe('Dev');
    expect(memberNameFor('Dev', 3, 2)).toBe('Dev3');
    expect(teamPlaceholderValues({ a: '1' }, 'T', 'L')).toEqual({ a: '1', team_name: 'T', lead_name: 'L' });
  });
});
