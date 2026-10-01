/**
 * Tests for the delegation → project ticket routing rule.
 */
import { decideDelegationTicketRoute, delegationTicketTitle, type DelegationRouteItem } from './delegation-ticket-route.js';

const item = (patch: Partial<DelegationRouteItem> = {}): DelegationRouteItem => ({
  type: 'delegate',
  owner: 'team_lead',
  target: 'ce-vera',
  metadata: { priority: 'high' },
  ...patch,
});
const withProject = { targetProjectIds: ['ce-core'] };

describe('decideDelegationTicketRoute', () => {
  it('routes a delegation from an agent to a teammate on a project', () => {
    expect(decideDelegationTicketRoute({ workItem: item(), callerSession: 'ce-owen', ...withProject })).toEqual({ action: 'route' });
  });

  it('routes an owner delegation (no caller) only with an explicit ticket', () => {
    expect(decideDelegationTicketRoute({ workItem: item(), ...withProject }).action).toBe('skip');
    expect(decideDelegationTicketRoute({ workItem: item(), explicitTicketId: 'CE-3', ...withProject })).toEqual({ action: 'route' });
  });

  it.each<[string, Partial<DelegationRouteItem>, string | undefined, readonly string[]]>([
    ['self-reminder', { target: 'ce-owen' }, 'ce-owen', ['ce-core']],
    ['review item (verifyOf)', { metadata: { verifyOf: 'wi-1' } }, 'ce-owen', ['ce-core']],
    ['review type', { type: 'review' }, 'ce-owen', ['ce-core']],
    ['project_task type', { type: 'project_task' }, 'ce-owen', ['ce-core']],
    ['system owner', { owner: 'system' }, 'ce-owen', ['ce-core']],
    ['trigger / cron', { triggerId: 'trg-1' }, 'ce-owen', ['ce-core']],
    ['scheduled', { scheduledAt: '2026-10-01T00:00:00Z' }, 'ce-owen', ['ce-core']],
    ['unassigned', { target: undefined }, 'ce-owen', ['ce-core']],
    ['no project', {}, 'ce-owen', []],
    ['already linked', { metadata: { projectTicket: { projectPath: '/p', id: 'CE-1' } } }, 'ce-owen', ['ce-core']],
  ])('skips a %s', (_name, patch, caller, projects) => {
    const d = decideDelegationTicketRoute({ workItem: item(patch), callerSession: caller, targetProjectIds: projects });
    expect(d.action).toBe('skip');
  });

  it('refuses an explicit ticket on an item that cannot carry one', () => {
    const self = decideDelegationTicketRoute({ workItem: item({ target: 'ce-owen' }), callerSession: 'ce-owen', explicitTicketId: 'CE-2', ...withProject });
    expect(self).toMatchObject({ action: 'refuse' });
    expect((self as { reason: string }).reason).toContain('--ticket CE-2 refused');
    expect(decideDelegationTicketRoute({ workItem: item(), callerSession: 'ce-owen', explicitTicketId: 'CE-2', targetProjectIds: [] }).action).toBe('refuse');
  });
});

describe('delegationTicketTitle', () => {
  it('takes the first non-empty line without heading marks', () => {
    expect(delegationTicketTitle('\n## List pages C\nGoal: …')).toBe('List pages C');
  });

  it('caps long titles and never returns empty', () => {
    expect(delegationTicketTitle('x'.repeat(300))).toHaveLength(120);
    expect(delegationTicketTitle('   ')).toBe('Delegated task');
  });
});
