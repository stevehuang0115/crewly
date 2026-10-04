/**
 * Tests for the unassigned-work router.
 */

import { initialDecider, leadAbove, nextDecider } from './untargeted-router.js';
import type { Team } from '../../types/index.js';

const ORC = 'crewly-orc';
const teams = [
  {
    id: 'product',
    name: 'Product',
    members: [
      { id: 'sam', name: 'Sam', sessionName: '', agentId: 'product-sam', canDelegate: true, hierarchyLevel: 1 },
      { id: 'leo', name: 'Leo', sessionName: 'product-leo', agentId: 'product-leo', parentMemberId: 'sam' },
      { id: 'max', name: 'Max', sessionName: '', agentId: 'product-max' },
    ],
  },
  { id: 'solo', name: 'Solo', members: [{ id: 'ann', name: 'Ann', sessionName: '', agentId: 'solo-ann', canDelegate: true, hierarchyLevel: 1 }] },
] as unknown as Team[];

describe('leadAbove', () => {
  it('parent first, else the team lead, never itself', () => {
    expect(leadAbove('product-leo', teams)).toBe('product-sam');
    expect(leadAbove('product-max', teams)).toBe('product-sam');
    expect(leadAbove('product-sam', teams)).toBeNull();
    expect(leadAbove('nobody', teams)).toBeNull();
  });
});

describe('initialDecider', () => {
  it('ticket owner beats everything', () => {
    expect(initialDecider({ teams, orchestrator: ORC, ticketAssignee: 'product-max', teamId: 'solo' })).toBe('product-max');
  });
  it('then the item team\'s lead', () => {
    expect(initialDecider({ teams, orchestrator: ORC, teamId: 'product', creatorSession: 'solo-ann' })).toBe('product-sam');
  });
  it('then the creator\'s lead; a lead decides for its own team', () => {
    expect(initialDecider({ teams, orchestrator: ORC, creatorSession: 'product-leo' })).toBe('product-sam');
    expect(initialDecider({ teams, orchestrator: ORC, creatorSession: 'product-sam' })).toBe('product-sam');
  });
  it('else the orchestrator', () => {
    expect(initialDecider({ teams, orchestrator: ORC })).toBe(ORC);
    expect(initialDecider({ teams, orchestrator: ORC, creatorSession: ORC })).toBe(ORC);
    expect(initialDecider({ teams, orchestrator: ORC, creatorSession: 'stranger' })).toBe(ORC);
  });
});

describe('nextDecider', () => {
  it('member → lead → orchestrator → nobody', () => {
    expect(nextDecider('product-leo', teams, ORC)).toBe('product-sam');
    expect(nextDecider('product-sam', teams, ORC)).toBe(ORC);
    expect(nextDecider('solo-ann', teams, ORC)).toBe(ORC);
    expect(nextDecider(ORC, teams, ORC)).toBeNull();
  });
});

describe('team pause (specs/2026-10-04-team-pause.md)', () => {
  const PAUSE = { pausedAt: '2026-10-04T00:00:00.000Z', by: 'owner' as const };
  const pausedProduct = teams.map((t) => (t.id === 'product' ? { ...t, paused: PAUSE } : t)) as Team[];

  it('skips a paused ticket assignee', () => {
    expect(initialDecider({ teams: pausedProduct, orchestrator: ORC, ticketAssignee: 'product-max' })).toBe(ORC);
  });
  it('skips the lead of a paused item team (falls to the creator\'s lead)', () => {
    expect(initialDecider({ teams: pausedProduct, orchestrator: ORC, teamId: 'product', creatorSession: 'solo-ann' })).toBe('solo-ann');
    expect(initialDecider({ teams: pausedProduct, orchestrator: ORC, teamId: 'product' })).toBe(ORC);
  });
  it('skips a paused creator and its lead', () => {
    expect(initialDecider({ teams: pausedProduct, orchestrator: ORC, creatorSession: 'product-leo' })).toBe(ORC);
  });
  it('an expired pause no longer counts', () => {
    const expired = teams.map((t) => (t.id === 'product' ? { ...t, paused: { ...PAUSE, until: '2020-01-01T00:00:00.000Z' } } : t)) as Team[];
    expect(initialDecider({ teams: expired, orchestrator: ORC, ticketAssignee: 'product-max' })).toBe('product-max');
  });
  it('nextDecider skips a paused lead → orchestrator', () => {
    expect(nextDecider('product-leo', pausedProduct, ORC)).toBe(ORC);
  });
});
