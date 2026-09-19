import * as path from 'path';
import { resolveWikiOwner } from './wiki-owner.resolver.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

const teams = [
  { id: 't1', name: 'Steam Fun Content Team', projectIds: ['p1'], members: [
    { id: 'a034e012-1', name: 'Max', sessionName: '', role: 'team-leader' },
    { id: 'dd6a9b2b-1', name: 'Ivy', sessionName: 'steam-fun-content-team-ivy-dd6a9b2b', role: 'executor' },
  ] },
  { id: 't2', name: 'No Leader', projectIds: ['p2'], members: [{ id: 'x', name: 'Solo', sessionName: 's', role: 'developer' }] },
] as never;
const storage = { getTeams: async () => teams, getProjects: async () => [{ id: 'p1', path: '/opt/steamfun-src' }, { id: 'p2', path: '/opt/other' }] };

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
});
