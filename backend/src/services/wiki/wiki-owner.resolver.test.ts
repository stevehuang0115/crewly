import * as path from 'path';
import { resolveWikiOwner } from './wiki-owner.resolver.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

const teams = [
  { id: 't1', name: 'Steam Fun Content Team', projectIds: ['p1'], members: [
    { id: 'a034e012-1', name: 'Max', sessionName: '', role: 'team-leader' },
    { id: 'dd6a9b2b-1', name: 'Ivy', sessionName: 'steam-fun-content-team-ivy-dd6a9b2b', role: 'executor' },
  ] },
  { id: 't2', name: 'No Leader', projectIds: ['p2'], members: [{ id: 'x', name: 'Solo', sessionName: 's', role: 'developer' }] },
  { id: 't3', name: 'CE', projectIds: ['p3'], leaderIds: ['vera-1234'], members: [
    { id: 'owen-1234', name: 'Owen', sessionName: 'ce-owen', role: 'tech-lead' },
    { id: 'vera-1234', name: 'Vera', sessionName: 'ce-vera', role: 'developer' },
  ] },
] as never;
const storage = {
  getTeams: async () => teams,
  getProjects: async () => [{ id: 'p1', path: '/opt/steamfun-src' }, { id: 'p2', path: '/opt/other' }, { id: 'p3', path: '/opt/ce' }],
};

describe('resolveWikiOwner', () => {
  it('team vault → that team\'s leader (session derived when idle)', async () => {
    expect(await resolveWikiOwner(storage, path.join(getCrewlyHomePath(), 'teams', 't1', 'wiki'))).toBe('steam-fun-content-team-max-a034e012');
  });
  it('project vault / project root → leader of a team on that project; null when none', async () => {
    expect(await resolveWikiOwner(storage, '/opt/steamfun-src/.crewly/wiki')).toBe('steam-fun-content-team-max-a034e012');
    expect(await resolveWikiOwner(storage, '/opt/steamfun-src')).toBe('steam-fun-content-team-max-a034e012');
    expect(await resolveWikiOwner(storage, '/opt/other/.crewly/wiki')).toBeNull();
    expect(await resolveWikiOwner(storage, path.join(getCrewlyHomePath(), 'global-wiki'))).toBeNull();
  });
  it('uses the shared team-lead rule: an explicit lead wins over a lead role', async () => {
    expect(await resolveWikiOwner(storage, '/opt/ce/.crewly/wiki')).toBe('ce-vera');
  });
});
