/**
 * Tests for resolveHuddleLeader — the chat dispatcher's "message @'s nobody
 * → the team lead" pick uses the shared team-lead rule.
 */
import type { Team } from '../../types/index.js';
import { resolveHuddleLeader } from './huddle-leader.js';

const m = (id: string, name: string, role: string, sessionName = '') => ({ id: `${id}-00000000`, name, role, sessionName, agentId: `ce-${name.toLowerCase()}-${id}` });

describe('resolveHuddleLeader', () => {
  const ce = { id: 't-ce', name: 'CE', members: [m('n', 'Nova', 'content-strategist'), m('o', 'Owen', 'tech-lead'), m('v', 'Vera', 'developer', 'ce-vera-v')] } as unknown as Team;
  const huddle = new Set(['ce-nova-n', 'ce-owen-o', 'ce-vera-v']);

  it('picks a tech-lead even when stopped (the CE / Owen case)', () => {
    expect(resolveHuddleLeader([ce], huddle)).toBe('ce-owen-o');
  });

  it('prefers the explicit lead', () => {
    expect(resolveHuddleLeader([{ ...ce, leaderIds: ['v-00000000'] } as Team], huddle)).toBe('ce-vera-v');
  });

  it('falls back to the first member in the huddle, and to null for no match', () => {
    const flat = { ...ce, members: [m('n', 'Nova', 'content-strategist'), m('v', 'Vera', 'developer', 'ce-vera-v')] } as unknown as Team;
    expect(resolveHuddleLeader([flat], huddle)).toBe('ce-nova-n');
    expect(resolveHuddleLeader([ce], new Set(['someone-else']))).toBeNull();
    expect(resolveHuddleLeader([ce], new Set())).toBeNull();
  });
});
