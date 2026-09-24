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
