import type { Team } from '../../types/index.js';
import { buildAskTeamMessage, pickAskRecipient, repoNeedsPush, buildMemoryNotice } from './team-move-ask.js';
import type { RepoPreflight } from './team-move.types.js';

const repo = (over: Partial<RepoPreflight> = {}): RepoPreflight => ({
  projectId: 'p1',
  projectName: 'edu-game',
  path: '/Users/me/projects/edu-game',
  isRepo: true,
  branch: 'main',
  remote: 'github.com/acme/edu-game',
  noRemote: false,
  modified: 3,
  untracked: 2,
  unpushed: 1,
  topFiles: [
    { path: 'src/App.tsx', status: 'modified' },
    { path: 'notes.local.md', status: 'untracked' },
  ],
  filesTruncated: true,
  carry: null,
  ...over,
});

describe('team-move-ask', () => {
  it('only repositories with work that exists nowhere else need a push', () => {
    expect(repoNeedsPush(repo())).toBe(true);
    expect(repoNeedsPush(repo({ modified: 0, untracked: 0, unpushed: 0 }))).toBe(false);
    expect(repoNeedsPush(repo({ isRepo: false }))).toBe(false);
    expect(repoNeedsPush(repo({ modified: 0, untracked: 0, unpushed: 2 }))).toBe(true);
  });

  it('has nothing to say about a clean team', () => {
    expect(buildAskTeamMessage({ teamName: 'Edu', targetName: 'Air', repos: [repo({ modified: 0, untracked: 0, unpushed: 0 })], findings: [] })).toBeNull();
  });

  it('lists the dirty files and tells the agent exactly what to do', () => {
    const text = buildAskTeamMessage({ teamName: 'Edu', targetName: 'iriss-air.lan', repos: [repo()], findings: [] })!;
    expect(text).toContain('move team "Edu" to iriss-air.lan');
    expect(text).toContain('Repository "edu-game" (/Users/me/projects/edu-game), branch main: 3 modified, 2 untracked, 1 commit not pushed.');
    expect(text).toContain('- modified: src/App.tsx');
    expect(text).toContain('- untracked: notes.local.md');
    expect(text).toContain('more (run git status');
    expect(text).toMatch(/\.gitignore/);
    expect(text).toMatch(/Never commit secrets/);
    expect(text).toMatch(/Do not force-push/);
    expect(text).toMatch(/phone/);
  });

  it('adds the files the secret scan flagged and warns about repositories without a remote', () => {
    const text = buildAskTeamMessage({
      teamName: 'Edu',
      targetName: 'Air',
      repos: [repo({ noRemote: true })],
      findings: [{ file: 'edu-game/.env.copy', matches: 2, removable: true }],
    })!;
    expect(text).toContain('edu-game/.env.copy');
    expect(text).toContain('no remote');
    const onlyFindings = buildAskTeamMessage({ teamName: 'Edu', targetName: 'Air', repos: [], findings: [{ file: 'a/b.md', matches: 1, removable: false }] })!;
    expect(onlyFindings).toContain('a/b.md');
    expect(onlyFindings).not.toContain('Repository "');
  });

  it('asks the lead', () => {
    const team = {
      id: 't',
      name: 'Edu',
      projectIds: [],
      members: [
        { id: 'm1', name: 'Dev', sessionName: 'edu-dev', role: 'developer' },
        { id: 'm2', name: 'Lena', sessionName: 'edu-lena', role: 'team-leader' },
      ],
    } as unknown as Team;
    expect(pickAskRecipient(team)?.sessionName).toBe('edu-lena');
    expect(pickAskRecipient({ ...team, members: [] } as Team)).toBeNull();
  });
});

describe('buildMemoryNotice', () => {
  it('names the team and carries every memory sentence', () => {
    const text = buildMemoryNotice('Movers', ['P: MEMORY NOT MOVED. one', 'P: MEMORY MASKED. two']);
    expect(text).toContain('Team "Movers"');
    expect(text).toContain('- P: MEMORY NOT MOVED. one\n- P: MEMORY MASKED. two');
  });
});
