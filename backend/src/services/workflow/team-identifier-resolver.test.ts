/**
 * Tests for resolveTeamByIdOrSlug — issue #307.
 *
 * @module services/workflow/team-identifier-resolver.test
 */

import { resolveTeamByIdOrSlug, slugifyTeamName } from './team-identifier-resolver.js';
import type { Team } from '../../types/index.js';

const makeTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 'team-uuid-1',
  name: 'Stock Ops Team',
  members: [],
  projectIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('resolveTeamByIdOrSlug', () => {
  it('matches by canonical UUID (fast path)', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: 'Alpha Team' })];
    expect(resolveTeamByIdOrSlug(teams, 'aaa-111')?.name).toBe('Alpha Team');
  });

  // Issue #307 root case: targetTeamId was set to "stock-ops-team" (a
  // name-derived slug) instead of the UUID. Resolution previously fell
  // through, both callbacks returned `false`, and `lastRunAt` never
  // updated. The slug fallback fixes this.
  it('matches by team-name slug when UUID lookup misses', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: 'Stock Ops Team' })];
    const got = resolveTeamByIdOrSlug(teams, 'stock-ops-team');
    expect(got?.id).toBe('aaa-111');
  });

  it('slug match is case-insensitive on both sides', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: 'Sales SECRET Team' })];
    expect(resolveTeamByIdOrSlug(teams, 'sales-secret-team')?.id).toBe('aaa-111');
    expect(resolveTeamByIdOrSlug(teams, 'SALES-SECRET-TEAM')?.id).toBe('aaa-111');
  });

  it('collapses multiple whitespace chars into a single hyphen', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: 'A   B  C' })];
    expect(resolveTeamByIdOrSlug(teams, 'a-b-c')?.id).toBe('aaa-111');
  });

  it('UUID match wins even when a sibling team has a matching slug', () => {
    // If someone names a team "uuid-of-other-team", the explicit UUID
    // lookup should still resolve to the canonical row.
    const teams = [
      makeTeam({ id: 'aaa-111', name: 'aaa-111' }),
      makeTeam({ id: 'bbb-222', name: 'sibling' }),
    ];
    expect(resolveTeamByIdOrSlug(teams, 'aaa-111')?.id).toBe('aaa-111');
  });

  it('returns undefined when neither UUID nor slug matches', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: 'Real Team' })];
    expect(resolveTeamByIdOrSlug(teams, 'no-such-team')).toBeUndefined();
  });

  it('returns undefined on an empty teams list', () => {
    expect(resolveTeamByIdOrSlug([], 'anything')).toBeUndefined();
  });

  // Review-feedback regression gate: an empty identifier previously
  // matched any team with an empty `name` (both slugify to '').
  it('returns undefined for an empty identifier', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: '' })];
    expect(resolveTeamByIdOrSlug(teams, '')).toBeUndefined();
  });

  it('trims leading/trailing whitespace on both sides before slug comparison', () => {
    const teams = [makeTeam({ id: 'aaa-111', name: '  Padded Team  ' })];
    expect(resolveTeamByIdOrSlug(teams, '  padded-team  ')?.id).toBe('aaa-111');
  });

  it('first-match-wins on duplicate slugs (Array.find insertion order)', () => {
    // Two teams whose names collapse to the same slug. Resolution is
    // deterministic (first match) — operators should not rely on slug
    // uniqueness; this test documents the order.
    const teams = [
      makeTeam({ id: 'aaa-111', name: 'Ops' }),
      makeTeam({ id: 'bbb-222', name: 'Ops' }),
    ];
    expect(resolveTeamByIdOrSlug(teams, 'ops')?.id).toBe('aaa-111');
  });
});

describe('slugifyTeamName', () => {
  it('lowercases + collapses internal whitespace to single hyphen', () => {
    expect(slugifyTeamName('Stock Ops Team')).toBe('stock-ops-team');
    expect(slugifyTeamName('A   B  C')).toBe('a-b-c');
  });

  it('trims leading/trailing whitespace', () => {
    expect(slugifyTeamName('  Padded  ')).toBe('padded');
  });
});
