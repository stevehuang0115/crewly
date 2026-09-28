/**
 * Tests for member-default-model.utils — Sonnet for reviewed Claude Code
 * members, runtime default (Opus) for leads, explicit modelId always wins.
 */

import { describe, it, expect } from '@jest/globals';
import {
  defaultModelForMember,
  effectiveMemberModelId,
  memberHasReviewer,
  reviewedMemberDefaultModel,
} from './member-default-model.utils.js';
import type { Team, TeamMember } from '../types/index.js';

const member = (overrides: Partial<TeamMember>): TeamMember =>
  ({
    id: overrides.id ?? 'm',
    name: 'Member',
    sessionName: `s-${overrides.id ?? 'm'}`,
    role: 'developer',
    runtimeType: 'claude-code',
    canDelegate: false,
    ...overrides,
  } as TeamMember);

const lead = member({ id: 'tl', role: 'team-leader', canDelegate: true, hierarchyLevel: 1 });
const worker = member({ id: 'w1', parentMemberId: 'tl', hierarchyLevel: 2 });
const team = (members: TeamMember[]): Team => ({ id: 't', name: 'Team', members } as Team);
const env = {} as NodeJS.ProcessEnv;

describe('reviewedMemberDefaultModel', () => {
  it('defaults to sonnet', () => {
    expect(reviewedMemberDefaultModel(env)).toBe('sonnet');
  });
  it('takes the env override', () => {
    expect(reviewedMemberDefaultModel({ CREWLY_MEMBER_DEFAULT_MODEL: 'haiku' } as NodeJS.ProcessEnv)).toBe('haiku');
  });
  it("is disabled by '' or 'off'", () => {
    expect(reviewedMemberDefaultModel({ CREWLY_MEMBER_DEFAULT_MODEL: '' } as NodeJS.ProcessEnv)).toBeNull();
    expect(reviewedMemberDefaultModel({ CREWLY_MEMBER_DEFAULT_MODEL: 'OFF' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('memberHasReviewer', () => {
  it('a member with a parent is reviewed', () => {
    expect(memberHasReviewer(team([lead, worker]), worker)).toBe(true);
  });
  it('a member without a parent is reviewed by the team lead', () => {
    const w = member({ id: 'w2' });
    expect(memberHasReviewer(team([lead, w]), w)).toBe(true);
  });
  it('the team lead is not reviewed', () => {
    expect(memberHasReviewer(team([lead, worker]), lead)).toBe(false);
  });
  it('a tech-lead role is never reviewed', () => {
    const tech = member({ id: 'tech', role: 'tech-lead' as TeamMember['role'], parentMemberId: 'tl' });
    expect(memberHasReviewer(team([lead, tech]), tech)).toBe(false);
  });
  it('a single-member team has no reviewer', () => {
    const solo = member({ id: 'solo' });
    expect(memberHasReviewer(team([solo]), solo)).toBe(false);
  });
});

describe('defaultModelForMember / effectiveMemberModelId', () => {
  it('member with a team lead → sonnet', () => {
    expect(defaultModelForMember(team([lead, worker]), worker, env)).toBe('sonnet');
    expect(effectiveMemberModelId(team([lead, worker]), worker, env)).toBe('sonnet');
  });
  it('team lead → no flag (Claude Code default)', () => {
    expect(defaultModelForMember(team([lead, worker]), lead, env)).toBeNull();
    expect(effectiveMemberModelId(team([lead, worker]), lead, env)).toBeUndefined();
  });
  it('explicit modelId wins', () => {
    const w = { ...worker, modelId: 'opus' };
    expect(defaultModelForMember(team([lead, w]), w, env)).toBeNull();
    expect(effectiveMemberModelId(team([lead, w]), w, env)).toBe('opus');
  });
  it('env override replaces sonnet, and off disables it', () => {
    expect(effectiveMemberModelId(team([lead, worker]), worker, { CREWLY_MEMBER_DEFAULT_MODEL: 'haiku' } as NodeJS.ProcessEnv)).toBe('haiku');
    expect(effectiveMemberModelId(team([lead, worker]), worker, { CREWLY_MEMBER_DEFAULT_MODEL: 'off' } as NodeJS.ProcessEnv)).toBeUndefined();
  });
  it('orchestrator → none', () => {
    const orc = member({ id: 'orc', role: 'orchestrator', sessionName: 'crewly-orc', parentMemberId: 'tl' });
    expect(defaultModelForMember(team([lead, orc]), orc, env)).toBeNull();
  });
  it('non-Claude-Code runtime → none', () => {
    const codex = { ...worker, runtimeType: 'codex-cli' as const };
    expect(defaultModelForMember(team([lead, codex]), codex, env)).toBeNull();
  });
});
