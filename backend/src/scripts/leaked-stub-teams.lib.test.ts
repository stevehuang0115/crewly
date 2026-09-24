/**
 * Tests for the #729 leaked-stub-team detector / quarantine.
 *
 * The fixture reproduces the three leaked configs from the incident backup and
 * surrounds them with real-looking teams that each share SOME markers, because
 * the failure this library must never have is quarantining a real team.
 *
 * @module scripts/leaked-stub-teams.lib.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  classifyStubTeam,
  LEAKED_STUB_TEAM_FINGERPRINT,
  quarantineLeakedStubTeams,
  scanTeamsForLeakedStubs,
} from './leaked-stub-teams.lib.js';

/** A leaked stub, shaped exactly like the incident backups. */
function stubConfig(id: string, createdAt: string): Record<string, unknown> {
  const member = (name: string, role: string): Record<string, unknown> => ({
    id: `${id}-${name}`,
    name,
    sessionName: '',
    role,
    agentStatus: 'inactive',
    workingStatus: 'idle',
    runtimeType: 'claude-code',
  });
  return {
    id,
    name: LEAKED_STUB_TEAM_FINGERPRINT.name,
    description: 'High-conversion content team for solopreneurs and Shopify brands.',
    members: [member('Vee', 'content-lead'), member('Ace', 'writer'), member('Coco', 'creator')],
    projectIds: [],
    hierarchical: true,
    templateId: LEAKED_STUB_TEAM_FINGERPRINT.templateId,
    createdAt,
    updatedAt: createdAt,
  };
}

const STUB_IDS = [
  '2b4ced27-6189-4218-8238-50b08bd0f1eb',
  '7911259d-1412-4ac1-ac17-30602d9d6a21',
  '1646d404-0ce4-4047-b22b-da15648801e7',
];

let root: string;
let teamsDir: string;
let backupDir: string;

async function writeTeam(dirName: string, config: unknown): Promise<void> {
  await fs.mkdir(path.join(teamsDir, dirName), { recursive: true });
  await fs.writeFile(
    path.join(teamsDir, dirName, 'config.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
  );
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'leaked-stub-teams-'));
  teamsDir = path.join(root, 'teams');
  backupDir = path.join(root, 'backup');
  await fs.mkdir(teamsDir, { recursive: true });

  await writeTeam(STUB_IDS[0], stubConfig(STUB_IDS[0], '2026-06-12T00:19:16.485Z'));
  await writeTeam(STUB_IDS[1], stubConfig(STUB_IDS[1], '2026-06-12T00:19:30.334Z'));
  await writeTeam(STUB_IDS[2], stubConfig(STUB_IDS[2], '2026-06-12T00:19:45.171Z'));

  // A real team whose members also have empty session names ("Closie" on the
  // reporting machine) — that marker alone must not match.
  await writeTeam('closie', {
    id: 'closie',
    name: 'Closie',
    members: [
      { name: 'Cleo', sessionName: '', agentStatus: 'inactive' },
      { name: 'Dax', sessionName: '', agentStatus: 'inactive' },
    ],
    projectIds: [],
    createdAt: '2026-05-16T23:21:29.559Z',
  });

  // A user who deliberately built a team from the same template later.
  const userDtc = stubConfig('user-dtc', '2026-07-01T10:00:00.000Z');
  await writeTeam('user-dtc', userDtc);

  // Same fingerprint, but someone put it to work on a project.
  const adopted = stubConfig('adopted-stub', '2026-06-12T00:19:50.000Z');
  adopted.projectIds = ['proj-1'];
  await writeTeam('adopted-stub', adopted);

  // Same fingerprint, but one agent was launched.
  const launched = stubConfig('launched-stub', '2026-06-12T00:19:55.000Z');
  (launched.members as Array<Record<string, unknown>>)[0].sessionName = 'dtc-vee-1234';
  (launched.members as Array<Record<string, unknown>>)[0].agentStatus = 'active';
  await writeTeam('launched-stub', launched);

  // Mis-filed: config id differs from the directory name.
  await writeTeam('misfiled', stubConfig('some-other-id', '2026-06-12T00:19:58.000Z'));

  await writeTeam('broken', '{ not json');
  await writeTeam('orchestrator', { id: 'orchestrator', members: [] });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('classifyStubTeam', () => {
  it('matches a config identical to the incident backups', () => {
    const c = classifyStubTeam(STUB_IDS[0], stubConfig(STUB_IDS[0], '2026-06-12T00:19:16.485Z'));
    expect(c).toEqual({ dirName: STUB_IDS[0], isLeakedStub: true, sameTemplate: true, reasons: [] });
  });

  it('rejects non-object configs', () => {
    expect(classifyStubTeam('x', null).isLeakedStub).toBe(false);
    expect(classifyStubTeam('x', []).isLeakedStub).toBe(false);
    expect(classifyStubTeam('x', 'team').isLeakedStub).toBe(false);
  });

  it('rejects a stub with an extra member', () => {
    const config = stubConfig('x', '2026-06-12T00:19:16.485Z');
    (config.members as unknown[]).push({ name: 'Zed', sessionName: '', agentStatus: 'inactive' });
    const c = classifyStubTeam('x', config);
    expect(c.isLeakedStub).toBe(false);
    expect(c.reasons).toContain('members are not exactly Ace/Coco/Vee');
  });

  it('rejects an owned or nested team', () => {
    const owned = { ...stubConfig('x', '2026-06-12T00:19:16.485Z'), ownerUserId: 'u1' };
    const nested = { ...stubConfig('x', '2026-06-12T00:19:16.485Z'), parentTeamId: 'p1' };
    expect(classifyStubTeam('x', owned).reasons).toContain('team has an owner');
    expect(classifyStubTeam('x', nested).reasons).toContain('team has a parent team');
  });

  it('rejects an unparseable createdAt', () => {
    const c = classifyStubTeam('x', stubConfig('x', 'not-a-date'));
    expect(c.reasons).toContain('createdAt is outside the incident window');
  });
});

describe('scanTeamsForLeakedStubs', () => {
  it('flags exactly the three incident stubs', async () => {
    const results = await scanTeamsForLeakedStubs(teamsDir);
    const matched = results.filter((r) => r.isLeakedStub).map((r) => r.dirName).sort();
    expect(matched).toEqual([...STUB_IDS].sort());
  });

  it('explains why each look-alike was spared', async () => {
    const byDir = new Map((await scanTeamsForLeakedStubs(teamsDir)).map((r) => [r.dirName, r]));
    expect(byDir.get('closie')?.reasons).toContain('templateId is not dtc-viral-content-team');
    expect(byDir.get('user-dtc')?.reasons).toEqual(['createdAt is outside the incident window']);
    expect(byDir.get('adopted-stub')?.reasons).toEqual(['team is assigned to projects']);
    expect(byDir.get('launched-stub')?.reasons).toEqual(['a member has a session or is not inactive']);
    expect(byDir.get('misfiled')?.reasons).toEqual(['config id does not match its directory name']);
    expect(byDir.get('broken')?.reasons[0]).toMatch(/^unreadable config\.json/);
  });
});

describe('quarantineLeakedStubTeams', () => {
  it('is a dry run by default and moves nothing', async () => {
    const report = await quarantineLeakedStubTeams({ teamsDir, backupDir });

    expect(report.dryRun).toBe(true);
    expect(report.matched.sort()).toEqual([...STUB_IDS].sort());
    expect(report.moved).toEqual([]);
    for (const id of STUB_IDS) {
      await expect(fs.stat(path.join(teamsDir, id))).resolves.toBeDefined();
    }
    await expect(fs.stat(backupDir)).rejects.toThrow();
  });

  it('reports near-misses built from the incident template', async () => {
    const report = await quarantineLeakedStubTeams({ teamsDir, backupDir });
    const spared = report.nearMisses.map((n) => n.dirName).sort();
    expect(spared).toEqual(['adopted-stub', 'launched-stub', 'misfiled', 'user-dtc']);
  });

  it('with apply, MOVES only the stubs into the backup and keeps every other team', async () => {
    const report = await quarantineLeakedStubTeams({ teamsDir, backupDir, apply: true });

    expect(report.dryRun).toBe(false);
    expect(report.moved.sort()).toEqual([...STUB_IDS].sort());
    expect(report.failed).toEqual([]);

    const backedUp = (await fs.readdir(backupDir)).sort();
    expect(backedUp).toEqual([...STUB_IDS].sort());
    const moved = JSON.parse(await fs.readFile(path.join(backupDir, STUB_IDS[0], 'config.json'), 'utf8'));
    expect(moved.id).toBe(STUB_IDS[0]);

    const remaining = (await fs.readdir(teamsDir)).sort();
    expect(remaining).toEqual(
      ['adopted-stub', 'broken', 'closie', 'launched-stub', 'misfiled', 'orchestrator', 'user-dtc'].sort(),
    );
  });

  it('never overwrites an existing backup entry', async () => {
    await fs.mkdir(path.join(backupDir, STUB_IDS[0]), { recursive: true });

    const report = await quarantineLeakedStubTeams({ teamsDir, backupDir, apply: true });

    expect(report.failed).toEqual([
      { dirName: STUB_IDS[0], error: expect.stringContaining('backup already exists') },
    ]);
    await expect(fs.stat(path.join(teamsDir, STUB_IDS[0], 'config.json'))).resolves.toBeDefined();
    expect(report.moved.sort()).toEqual([STUB_IDS[1], STUB_IDS[2]].sort());
  });

  it('with apply and no matches, creates no backup directory', async () => {
    for (const id of STUB_IDS) await fs.rm(path.join(teamsDir, id), { recursive: true });

    const report = await quarantineLeakedStubTeams({ teamsDir, backupDir, apply: true });

    expect(report.matched).toEqual([]);
    await expect(fs.stat(backupDir)).rejects.toThrow();
  });
});
