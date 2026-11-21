import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Project, Team, TeamMember } from '../../types/index.js';
import { WikiRecordAttachService } from './wiki-record-attach.service.js';
import {
  getWikiRecordAttachService,
  setWikiRecordAttachService,
  machineVaults,
  vaultsForAgent,
  type AgentScopeStorage,
} from './wiki-record-attach.wiring.js';

let home: string;
let projectDir: string;
const previousHome = process.env.CREWLY_HOME;

const vault = (root: string): void => {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'SCHEMA.md'), '# schema\n');
};

const storage = (member: { team: Partial<Team>; member: Partial<TeamMember> } | null, projects: Partial<Project>[] = []): AgentScopeStorage => ({
  findMemberBySessionName: async () => member as { team: Team; member: TeamMember } | null,
  getProjects: async () => projects as Project[],
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'crewly-attach-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'crewly-attach-proj-'));
  process.env.CREWLY_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CREWLY_HOME;
  else process.env.CREWLY_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  setWikiRecordAttachService(null);
});

describe('vaultsForAgent', () => {
  it('returns the project, team and global vaults that exist, with the role', async () => {
    vault(join(projectDir, '.crewly', 'wiki'));
    vault(join(home, 'teams', 't1', 'wiki'));
    vault(join(home, 'global-wiki'));
    const got = await vaultsForAgent(
      storage({ team: { id: 't1', projectIds: ['p1'] }, member: { role: 'sales' } }, [{ id: 'p1', path: projectDir }, { id: 'p2', path: '/other' }]),
      'grace',
    );
    expect(got.viewerRole).toBe('sales');
    expect(got.vaultPaths).toEqual([join(projectDir, '.crewly', 'wiki'), join(home, 'teams', 't1', 'wiki'), join(home, 'global-wiki')]);
  });

  it('leaves out vaults that were never created', async () => {
    vault(join(home, 'global-wiki'));
    const got = await vaultsForAgent(storage({ team: { id: 't1', projectIds: ['p1'] }, member: { role: 'sales' } }, [{ id: 'p1', path: projectDir }]), 'grace');
    expect(got.vaultPaths).toEqual([join(home, 'global-wiki')]);
  });

  it('an agent on no team reads the global vault only', async () => {
    vault(join(home, 'global-wiki'));
    const got = await vaultsForAgent(storage(null), 'some-loose-agent');
    expect(got).toEqual({ vaultPaths: [join(home, 'global-wiki')] });
  });

  it('the orchestrator reads every team vault on the machine and the global vault', async () => {
    vault(join(home, 'teams', 't2', 'wiki'));
    vault(join(home, 'teams', 't1', 'wiki'));
    mkdirSync(join(home, 'teams', 'no-vault'), { recursive: true });
    vault(join(home, 'global-wiki'));
    const got = await vaultsForAgent(storage(null), 'crewly-orc');
    expect(got).toEqual({
      vaultPaths: [join(home, 'teams', 't1', 'wiki'), join(home, 'teams', 't2', 'wiki'), join(home, 'global-wiki')],
      viewerRole: 'orchestrator',
    });
    expect(machineVaults(join(home, 'nowhere'))).toEqual([]);
  });

  it('survives a storage failure', async () => {
    const failing: AgentScopeStorage = {
      findMemberBySessionName: async () => {
        throw new Error('disk');
      },
      getProjects: async () => [],
    };
    expect(await vaultsForAgent(failing, 'x')).toEqual({ vaultPaths: [] });
  });
});

describe('getWikiRecordAttachService', () => {
  it('returns one instance until replaced', () => {
    const first = getWikiRecordAttachService();
    expect(getWikiRecordAttachService()).toBe(first);
    const mine = new WikiRecordAttachService();
    setWikiRecordAttachService(mine);
    expect(getWikiRecordAttachService()).toBe(mine);
  });
});
