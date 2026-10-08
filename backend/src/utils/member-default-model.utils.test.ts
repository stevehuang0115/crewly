/**
 * Tests for member-default-model.utils — Sonnet for reviewed Claude Code
 * members, runtime default (Opus) for leads, explicit modelId always wins.
 */

import { describe, it, expect } from '@jest/globals';
import {
  defaultModelForMember,
  effectiveMemberModelId,
  fallbackRuntimeModelId,
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

describe('fallbackRuntimeModelId', () => {
  const codexWorker = { ...worker, runtimeType: 'codex-cli' as const };
  it('reviewed codex member on the claude fallback → sonnet', () => {
    expect(fallbackRuntimeModelId(team([lead, codexWorker]), codexWorker, 'claude-code', env)).toBe('sonnet');
  });
  it('lead on the fallback → no model flag (runtime default)', () => {
    const codexLead = { ...lead, runtimeType: 'codex-cli' as const };
    expect(fallbackRuntimeModelId(team([codexLead, worker]), codexLead, 'claude-code', env)).toBeUndefined();
  });
  it('a codex modelId is not passed to claude', () => {
    const w = { ...codexWorker, modelId: 'gpt-5.6-sol' };
    expect(fallbackRuntimeModelId(team([lead, w]), w, 'claude-code', env)).toBe('sonnet');
    const l = { ...lead, runtimeType: 'codex-cli' as const, modelId: 'gpt-5.6-sol' };
    expect(fallbackRuntimeModelId(team([l, worker]), l, 'claude-code', env)).toBeUndefined();
  });
  it('a claude modelId is kept; a normal claude member is unchanged', () => {
    const w = { ...codexWorker, modelId: 'opus' };
    expect(fallbackRuntimeModelId(team([lead, w]), w, 'claude-code', env)).toBe('opus');
    expect(fallbackRuntimeModelId(team([lead, worker]), worker, 'claude-code', env)).toBe(effectiveMemberModelId(team([lead, worker]), worker, env));
  });
  it('non-claude fallback runtimes get no model', () => {
    expect(fallbackRuntimeModelId(team([lead, codexWorker]), codexWorker, 'gemini-cli', env)).toBeUndefined();
  });
});

describe('model tiers (crewly#1173)', () => {
  it('a tier resolves to its model on the member runtime', () => {
    const w = member({ id: 'w1', parentMemberId: 'tl', tier: 'weak' });
    expect(effectiveMemberModelId(team([lead, w]), w, env)).toBe('haiku');
    const strongLead = member({ id: 'tl', role: 'team-leader', canDelegate: true, tier: 'mid' });
    expect(effectiveMemberModelId(team([strongLead, w]), strongLead, env)).toBe('sonnet');
  });

  it('an explicit modelId wins over the tier', () => {
    const w = member({ id: 'w1', parentMemberId: 'tl', tier: 'weak', modelId: 'opus' });
    expect(effectiveMemberModelId(team([lead, w]), w, env)).toBe('opus');
  });

  it('a team override wins over the global map', () => {
    const w = member({ id: 'w1', parentMemberId: 'tl', tier: 'weak' });
    const t = { ...team([lead, w]), tierModels: { 'claude-code': { weak: 'claude-haiku-5-5' } } } as Team;
    expect(effectiveMemberModelId(t, w, env)).toBe('claude-haiku-5-5');
  });

  it('a tier the runtime cannot map falls back to the reviewed default / runtime default', () => {
    const agent = member({ id: 'w1', parentMemberId: 'tl', tier: 'strong', runtimeType: 'crewly-agent' });
    expect(effectiveMemberModelId(team([lead, agent]), agent, env)).toBeUndefined();
    const codexWeak = member({ id: 'w2', parentMemberId: 'tl', tier: 'weak', runtimeType: 'codex-cli' });
    expect(effectiveMemberModelId(team([lead, codexWeak]), codexWeak, env)).toBe('gpt-5.4');
  });

  it('a lead without a tier still keeps the runtime default', () => {
    expect(effectiveMemberModelId(team([lead, worker]), lead, env)).toBeUndefined();
  });

  it('the orchestrator never takes a tier', () => {
    const orc = member({ id: 'orc', role: 'orchestrator', sessionName: 'crewly-orc', tier: 'weak' });
    expect(effectiveMemberModelId(team([orc]), orc, env)).toBeUndefined();
  });

  it('on a fallback runtime the tier resolves for that runtime', () => {
    const codexMember = member({ id: 'w1', parentMemberId: 'tl', tier: 'weak', runtimeType: 'codex-cli', modelId: 'gpt-5.6-sol' });
    // Codex ran out → Claude Code: the gpt id is dropped, the tier gives haiku.
    expect(fallbackRuntimeModelId(team([lead, codexMember]), codexMember, 'claude-code', env)).toBe('haiku');
    // Claude ran out → Codex: weak has no Codex model, so mid's model.
    const claudeMember = member({ id: 'w2', parentMemberId: 'tl', tier: 'weak' });
    expect(fallbackRuntimeModelId(team([lead, claudeMember]), claudeMember, 'codex-cli', env)).toBe('gpt-5.4');
    // A Claude-usable explicit model still wins on the Claude fallback.
    const pinned = member({ id: 'w3', parentMemberId: 'tl', tier: 'weak', modelId: 'opus', runtimeType: 'codex-cli' });
    expect(fallbackRuntimeModelId(team([lead, pinned]), pinned, 'claude-code', env)).toBe('opus');
    // No tier, non-Claude fallback: the runtime's own default, as before.
    expect(fallbackRuntimeModelId(team([lead, worker]), worker, 'codex-cli', env)).toBeUndefined();
  });
});
