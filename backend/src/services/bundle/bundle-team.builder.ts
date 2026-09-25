/**
 * Builds the Crewly teams of a solution bundle.
 *
 * Mirrors `TemplateService.createTeamFromTemplate` (members per role,
 * hierarchy wiring) with what bundles need on top: placeholder filling,
 * deterministic team ids (so every re-run and the CLI find the same team),
 * ASCII session names like the onboarding starters, and one runtime for
 * every member.
 *
 * @module services/bundle/bundle-team.builder
 */

import { randomUUID } from 'crypto';
import { BUNDLE_CONSTANTS } from '../../constants.js';
import type { Team, TeamMember, TeamMemberRole } from '../../types/index.js';
import type { BundleTemplate } from '../../types/solution-bundle.types.js';
import type { NormalizedBundleTeam } from './bundle-manifest.js';
import { fillPlaceholders, type BundleAnswers } from './bundle-placeholders.js';

/**
 * Lower-case ASCII slug.
 *
 * @param value - Any text
 * @returns Slug (may be empty for non-ASCII text)
 */
export function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The deterministic id of a bundle team: the template id for the main
 * team, `<templateId>--<key>` for extra teams.
 *
 * @param templateId - Template id
 * @param teamKey - Team key
 * @returns Team id
 */
export function bundleTeamId(templateId: string, teamKey: string): string {
  return teamKey === BUNDLE_CONSTANTS.MAIN_TEAM_KEY
    ? templateId
    : `${templateId}${BUNDLE_CONSTANTS.TEAM_ID_SEPARATOR}${teamKey}`;
}

/**
 * The member name of the n-th member of a role.
 *
 * @param defaultName - Role default name
 * @param count - Members in the role
 * @param index - 0-based index
 * @returns Name (`Writer`, or `Writer1`, `Writer2` …)
 */
export function memberNameFor(defaultName: string, count: number, index: number): string {
  return count > 1 ? `${defaultName}${index + 1}` : defaultName;
}

/**
 * Values for a team's placeholders: the answers plus the built-ins.
 *
 * @param answers - Owner answers
 * @param teamName - Filled team name
 * @param leadName - The lead member's name
 * @returns Placeholder values
 */
export function teamPlaceholderValues(answers: BundleAnswers, teamName: string, leadName: string): BundleAnswers {
  return { ...answers, team_name: teamName, lead_name: leadName };
}

/** Input of {@link buildBundleTeam}. */
export interface BuildBundleTeamInput {
  template: BundleTemplate;
  team: NormalizedBundleTeam;
  answers: BundleAnswers;
  runtime: string;
  now: Date;
}

/**
 * Build one bundle team (not saved).
 *
 * @param input - Template, normalized team, answers, runtime, clock
 * @returns The team, ready for `StorageService.saveTeam`
 * @throws BundlePlaceholderError when a text keeps an unfilled placeholder
 */
export function buildBundleTeam(input: BuildBundleTeamInput): Team {
  const { template, team, answers, runtime, now } = input;
  const iso = now.toISOString();
  const teamId = bundleTeamId(template.id, team.key);
  const teamSlug = toSlug(teamId) || 'team';
  const leadRole = team.roles.find((r) => r.role === team.leadRole);
  const leadName = leadRole ? memberNameFor(leadRole.defaultName, leadRole.count, 0) : '';
  const nameValues = { ...answers, lead_name: leadName, team_name: '' };
  const teamName = fillPlaceholders(team.name, nameValues, `team ${team.key} name`);
  const values = teamPlaceholderValues(answers, teamName, leadName);

  const members: TeamMember[] = [];
  const idsByRole = new Map<string, string[]>();
  for (const role of team.roles) {
    const ids: string[] = [];
    for (let i = 0; i < role.count; i++) {
      const id = randomUUID();
      const name = memberNameFor(role.defaultName, role.count, i);
      const sessionName = `${teamSlug}-${toSlug(name) || 'member'}-${id.slice(0, 8)}`;
      const where = `${team.key}/${role.role}`;
      members.push({
        id,
        name,
        sessionName,
        agentId: sessionName,
        role: role.role as TeamMemberRole,
        systemPrompt: fillPlaceholders(role.promptAdditions ?? '', values, `${where} promptAdditions`),
        agentStatus: 'inactive',
        workingStatus: 'idle',
        runtimeType: runtime as TeamMember['runtimeType'],
        hierarchyLevel: role.hierarchyLevel,
        canDelegate: role.canDelegate,
        skillOverrides: role.defaultSkills.length > 0 ? [...role.defaultSkills] : undefined,
        excludedRoleSkills: role.excludedSkills,
        createdAt: iso,
        updatedAt: iso,
        jobTitle: role.jobTitle ?? role.label,
        jobDescription: role.jobDescription ? fillPlaceholders(role.jobDescription, values, `${where} jobDescription`) : undefined,
        ownershipScope: role.ownershipScope,
        responsibilityType: role.responsibilityType,
        autonomyLevel: role.autonomyLevel,
        expertId: role.expertId,
        domainSOP: role.domainSOP,
        riskPolicy: role.riskPolicy,
      });
      ids.push(id);
    }
    idsByRole.set(role.role, ids);
  }

  // Hierarchy: every member of a role reports to the first member of its parent role.
  for (const role of team.roles) {
    if (!role.reportsTo) continue;
    const parentId = idsByRole.get(role.reportsTo)?.[0];
    if (!parentId) continue;
    const childIds = idsByRole.get(role.role) ?? [];
    for (const childId of childIds) {
      const child = members.find((m) => m.id === childId);
      if (child) child.parentMemberId = parentId;
    }
    const parent = members.find((m) => m.id === parentId);
    if (parent) parent.subordinateIds = [...(parent.subordinateIds ?? []), ...childIds];
  }

  const leaderId = idsByRole.get(team.leadRole)?.[0];
  const description = team.description ? fillPlaceholders(team.description, values, `team ${team.key} description`) : undefined;
  const mission = team.key === BUNDLE_CONSTANTS.MAIN_TEAM_KEY && template.mission
    ? fillPlaceholders(template.mission, values, 'mission')
    : undefined;

  return {
    id: teamId,
    name: teamName,
    ...(description ? { description } : {}),
    members,
    projectIds: [],
    hierarchical: template.hierarchical ?? true,
    ...(leaderId ? { leaderId, leaderIds: [leaderId] } : {}),
    templateId: template.id,
    ...(mission ? { mission } : {}),
    createdAt: iso,
    updatedAt: iso,
  };
}

/**
 * Find the member a ref names in a built team.
 *
 * @param team - Saved team
 * @param role - Role id (the first member of the role is returned)
 * @returns The member, or undefined
 */
export function memberForRole(team: Team, role: string): TeamMember | undefined {
  return team.members.find((m) => m.role === role);
}

/**
 * The session name a member runs under (its permanent agent id).
 *
 * @param member - Member
 * @returns Session name
 */
export function memberSession(member: TeamMember): string {
  return member.agentId || member.sessionName;
}
