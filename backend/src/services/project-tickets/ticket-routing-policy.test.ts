import { isEngineeringRole, isEngineeringTicket, selfClaimRefusal } from './ticket-routing-policy.js';

describe('ticket-routing-policy', () => {
  it('marks harness-gap and engineering labels', () => {
    expect(isEngineeringTicket(['from-retro', 'Harness-Gap'])).toBe(true);
    expect(isEngineeringTicket(['engineering'])).toBe(true);
    expect(isEngineeringTicket(['content'])).toBe(false);
    expect(isEngineeringTicket([])).toBe(false);
  });

  it('recognises engineering roles only', () => {
    for (const r of ['developer', 'frontend-developer', 'backend-tester', 'architect', 'qa', 'devops', 'fullstack-dev']) expect(isEngineeringRole(r)).toBe(true);
    for (const r of ['content-strategist', 'team-leader', 'sales', 'designer', 'product-manager', '', undefined]) expect(isEngineeringRole(r)).toBe(false);
  });

  it('refuses a member of another team when the ticket has a team', () => {
    expect(selfClaimRefusal({ id: 'CREW-1', team: 'eng', labels: [] }, { teamId: 'mkt', role: 'developer' })).toMatch(/belongs to team eng/);
    expect(selfClaimRefusal({ id: 'CREW-1', team: 'eng', labels: [] }, { teamId: 'eng', role: 'sales' })).toBeNull();
  });

  it('refuses a non-engineering role on a team:null engineering ticket', () => {
    const t = { id: 'CREW-2', team: null, labels: ['harness-gap'] };
    expect(selfClaimRefusal(t, { teamId: 'mkt', role: 'content-strategist' })).toMatch(/engineering work with no team/);
    expect(selfClaimRefusal(t, { teamId: 'eng', role: 'developer' })).toBeNull();
  });

  it('leaves team:null non-engineering tickets open to anyone', () => {
    expect(selfClaimRefusal({ id: 'CREW-3', team: null, labels: ['copy'] }, { teamId: 'mkt', role: 'content-strategist' })).toBeNull();
  });
});
