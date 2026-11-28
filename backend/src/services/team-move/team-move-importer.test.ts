import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StorageService } from '../core/storage.service.js';
import { resolveProjectSlugCandidatesSync } from '../monitoring/claude-session-tokens.service.js';
import type { Team } from '../../types/index.js';
import { generateTargetKeyPair } from './team-move-crypto.js';
import { buildEncryptedPackage } from './team-move-exporter.js';
import { StagingArea } from './team-move-fs.js';
import { TeamMoveImportError, TeamMoveImporter, isTargetOwnedProjectFile, leftOutMemory, projectsRoot, type ImportDeps } from './team-move-importer.js';
import type { ImportProgress, PackageProject, TeamMoveManifest } from './team-move.types.js';

let counter = 0;

describe('projectsRoot', () => {
  it('honours the env override and defaults under the home folder', () => {
    expect(projectsRoot({ CREWLY_PROJECTS_ROOT: '/data/p' }, '/home/u')).toBe('/data/p');
    expect(projectsRoot({}, '/home/u')).toBe(path.join('/home/u', 'crewly-projects'));
  });
});

describe('isTargetOwnedProjectFile', () => {
  it('claims the ticket folder and the request counter, nothing else', () => {
    expect(isTargetOwnedProjectFile('tickets/CREW-1.md')).toBe(true);
    expect(isTargetOwnedProjectFile('tickets/.counter.json')).toBe(true);
    expect(isTargetOwnedProjectFile('requests/.ticket-counter')).toBe(true);
    expect(isTargetOwnedProjectFile('requests/REQ-1.json')).toBe(false);
    expect(isTargetOwnedProjectFile('goals/g.md')).toBe(false);
    expect(isTargetOwnedProjectFile('tickets-archive/x.md')).toBe(false);
  });
});

describe('TeamMoveImporter', () => {
  let root: string;
  let home: string;
  let storage: StorageService;
  let restoreCalls: Array<{ dest: string }>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'move-importer-'));
    home = path.join(root, 'home');
    await fs.mkdir(home, { recursive: true });
    process.env['CREWLY_PROJECTS_ROOT'] = path.join(root, 'projects');
    storage = new StorageService(home);
    restoreCalls = [];
  });
  afterEach(async () => {
    delete process.env['CREWLY_PROJECTS_ROOT'];
    await fs.rm(root, { recursive: true, force: true });
  });

  const deps = (over: Partial<ImportDeps> = {}): ImportDeps => ({
    home,
    crewlyVersion: '9',
    storage,
    addWorkItems: async () => 0,
    addDecisions: async () => 0,
    adoptSlackMapping: async () => false,
    restoreRepo: async (dest) => (restoreCalls.push({ dest }), { ok: true, branch: 'main', headSha: 'abc', warnings: [] }),
    ...over,
  });

  /** Build an encrypted package from a hand-made staging dir. */
  async function pack(
    mutate: (m: TeamMoveManifest, s: StagingArea) => Promise<void> | void = () => undefined,
    options: { config?: Record<string, unknown> } = {},
  ) {
    const moveId = `move-importer-${String(++counter).padStart(5, '0')}`;
    const staging = new StagingArea(path.join(root, `stage-${Math.random().toString(36).slice(2)}`));
    await staging.init();
    await staging.writeJson('team/config.json', options.config ?? { id: 'team-1', name: 'T', members: [{ id: 'm1', name: 'A', sessionName: 's-a', role: 'developer', runtimeType: 'claude-code' }], projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' });
    await staging.writeText('projects/p1/data/tickets/T-1.md', 'ticket at /src/p');
    const manifest: TeamMoveManifest = {
      kind: 'crewly-team-move',
      schemaVersion: 1,
      moveId,
      createdAt: 'x',
      crewlyVersion: '9',
      source: { instanceId: 'i', deviceName: 'd', homePath: '/src/home', platform: 'darwin' },
      team: { id: 'team-1', name: 'T', members: [{ id: 'm1', name: 'A', role: 'developer', sessionName: 's-a', runtimeType: 'claude-code' }], projectIds: ['p1'] },
      counts: { members: 1 },
      projects: [{ id: 'p1', name: 'P One', sourcePath: '/src/p', dataDir: '.crewly', files: 1, bytes: 1, skipped: [], sharedWithTeams: [] }],
      repos: [{ projectId: 'p1', projectName: 'P One', path: '/src/p', remoteUrl: 'git@x:y/z.git', branch: 'main', headSha: 'abc', dirty: false, unpushed: 0 }],
      requiredTools: [],
      requiredRuntimes: [],
      files: [],
      totalBytes: 1,
      noSecrets: true,
      secretScan: { filesScanned: 0, knownValuesChecked: 0, findings: 0, excludedFiles: 0 },
      notMoved: ['things'],
    };
    manifest.files = staging.files();
    await mutate(manifest, staging);
    await staging.writeJson('manifest.json', manifest);
    const key = generateTargetKeyPair();
    const file = path.join(root, `pkg-${Math.random().toString(36).slice(2)}.enc`);
    await buildEncryptedPackage(staging.root, file, key.publicKey, moveId);
    return { file, key, moveId };
  }

  const run = async (p: { file: string; key: { privateKey: string }; moveId: string }, d: ImportDeps = deps()) =>
    new TeamMoveImporter(d).run({ moveId: p.moveId, packageFile: p.file, privateKey: p.key.privateKey });

  it('imports a minimal package and relocates the project under the projects root', async () => {
    const report = await run(await pack());
    const [project] = await storage.getProjects();
    expect(project!.path).toBe(path.join(root, 'projects', 'p-one'));
    expect(await fs.readFile(path.join(project!.path, '.crewly', 'tickets', 'T-1.md'), 'utf8')).toBe(`ticket at ${project!.path}`);
    expect(restoreCalls).toEqual([{ dest: project!.path }]);
    expect(report.paths).toEqual([{ projectId: 'p1', name: 'P One', from: '/src/p', to: project!.path }]);
    expect(report.started).toEqual({ requested: false, ok: false });
    expect(report.notMoved).toEqual(['things']);
  });

  it('refuses a package without a manifest, with the wrong schema, kind, move or secret scan', async () => {
    await expect(run(await pack(async (_m, s) => s.remove('team/config.json')))).rejects.toThrow(/missing or altered/);
    await expect(run(await pack((m) => void (m.schemaVersion = 99)))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(run(await pack((m) => void ((m as { kind: string }).kind = 'other')))).rejects.toThrow(/not a team move package/);
    await expect(run(await pack((m) => void ((m as { noSecrets: boolean }).noSecrets = false)))).rejects.toThrow(/not secret-scanned/);
    await expect(run(await pack((m) => void (m.moveId = 'move-other-0000001')))).rejects.toThrow(/another move/);
  });

  it('refuses altered, extra and unsafe files', async () => {
    await expect(run(await pack((m) => void (m.files[0]!.sha256 = '0'.repeat(64))))).rejects.toThrow(/missing or altered/);
    await expect(run(await pack(async (_m, s) => void (await s.writeText('extra.txt', 'x'))))).rejects.toThrow(/unexpected file/);
    await expect(run(await pack((m) => void (m.files[0]!.path = '../escape')))).rejects.toThrow(/unsafe path/);
  });

  it('refuses a session name that another team here already uses', async () => {
    await storage.saveTeam({ id: 'other', name: 'Other', members: [{ id: 'z', name: 'Z', sessionName: 's-a' }], projectIds: [], createdAt: 'x', updatedAt: 'x' } as unknown as Team);
    await expect(run(await pack())).rejects.toThrow(/already exists in team "Other"/);
  });

  it('replaces a team archived by an earlier move', async () => {
    await storage.saveTeam({ id: 'team-1', name: 'Old', moveArchive: { moveId: 'm' }, members: [], projectIds: [], createdAt: 'x', updatedAt: 'x' } as unknown as Team);
    await run(await pack());
    const teams = await storage.getTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0]!.name).toBe('T');
  });

  it('puts a project whose folder is taken beside it with a suffix, and keeps an existing project as it is', async () => {
    await fs.mkdir(path.join(root, 'projects', 'p-one'), { recursive: true });
    await fs.writeFile(path.join(root, 'projects', 'p-one', 'foreign.txt'), 'x');
    await run(await pack());
    expect((await storage.getProjects())[0]!.path).toBe(path.join(root, 'projects', 'p-one-p1'));

    // A second machine state: the project exists here under the same id.
    const home2 = path.join(root, 'home2');
    await fs.mkdir(home2, { recursive: true });
    const storage2 = new StorageService(home2);
    const mine = path.join(root, 'mine');
    await storage2.saveProject({ id: 'p1', name: 'P One', path: mine, teams: {}, status: 'stopped', createdAt: 'x', updatedAt: 'x' } as never);
    restoreCalls = [];
    const p = await pack();
    const ok = await new TeamMoveImporter(deps({ home: home2, storage: storage2 })).run({ moveId: p.moveId, packageFile: p.file, privateKey: p.key.privateKey });
    expect(restoreCalls).toEqual([]);
    expect(ok.warnings.join(' ')).toMatch(/already exists on this machine/);
    // The project is already here: the source's ticket folder is not copied.
    await expect(fs.readFile(path.join(mine, '.crewly', 'tickets', 'T-1.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('a project this machine already holds keeps its ticket backlog', () => {
    /** A target that already has project p1 with its own backlog; returns the report and the project folder. */
    async function moveOntoExisting(mutate?: (s: StagingArea) => Promise<void>) {
      const home2 = path.join(root, 'home2');
      await fs.mkdir(home2, { recursive: true });
      const storage2 = new StorageService(home2);
      const mine = path.join(root, 'mine');
      await storage2.saveProject({ id: 'p1', name: 'P One', path: mine, teams: {}, status: 'stopped', createdAt: 'x', updatedAt: 'x' } as never);
      const tickets = path.join(mine, '.crewly', 'tickets');
      await fs.mkdir(tickets, { recursive: true });
      await fs.writeFile(path.join(tickets, 'T-1.md'), '---\nid: T-1\nstatus: backlog\nlabels: [hold]\nassignee: nobody\n---\nheld on the mini\n');
      await fs.writeFile(path.join(tickets, '.counter.json'), '{"next":58}');
      const p = await pack(async (m, s) => {
        await s.writeText('projects/p1/data/tickets/T-2.md', '---\nid: T-2\nstatus: ready\n---\nonly on the source\n');
        await s.writeText('projects/p1/data/tickets/.counter.json', '{"next":3}');
        await s.writeText('projects/p1/data/requests/.ticket-counter', '9');
        await s.writeText('projects/p1/data/goals/g.md', 'goal from the source');
        await mutate?.(s);
        m.files = s.files();
      });
      const report = await new TeamMoveImporter(deps({ home: home2, storage: storage2 })).run({ moveId: p.moveId, packageFile: p.file, privateKey: p.key.privateKey });
      return { report, mine, tickets };
    }

    it('leaves existing tickets, the counter and the hold exactly as they were, with no backup files', async () => {
      const { tickets, mine } = await moveOntoExisting();
      expect(await fs.readFile(path.join(tickets, 'T-1.md'), 'utf8')).toBe('---\nid: T-1\nstatus: backlog\nlabels: [hold]\nassignee: nobody\n---\nheld on the mini\n');
      expect(await fs.readFile(path.join(tickets, '.counter.json'), 'utf8')).toBe('{"next":58}');
      expect(await fs.readdir(tickets)).not.toEqual(expect.arrayContaining([expect.stringContaining('pre-move')]));
      // The source's other tickets are not added either: the target owns the folder.
      await expect(fs.readFile(path.join(tickets, 'T-2.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      // The request counter is the target's too.
      await expect(fs.readFile(path.join(mine, '.crewly', 'requests', '.ticket-counter'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('still copies the rest of the project data and says how many tickets were not copied', async () => {
      const { report, mine } = await moveOntoExisting();
      expect(await fs.readFile(path.join(mine, '.crewly', 'goals', 'g.md'), 'utf8')).toBe('goal from the source');
      expect(report.warnings.join(' ')).toMatch(/2 ticket\(s\) from the source were not copied/);
    });
  });

  it('gives a project new to this machine its tickets and counters', async () => {
    const p = await pack(async (m, s) => {
      await s.writeText('projects/p1/data/tickets/.counter.json', '{"next":3}');
      m.files = s.files();
    });
    await run(p);
    const [project] = await storage.getProjects();
    expect(await fs.readFile(path.join(project!.path, '.crewly', 'tickets', 'T-1.md'), 'utf8')).toBe(`ticket at ${project!.path}`);
    expect(await fs.readFile(path.join(project!.path, '.crewly', 'tickets', '.counter.json'), 'utf8')).toBe('{"next":3}');
  });

  it('names every memory file the package left behind, in the report and first among the warnings', async () => {
    const report = await run(await pack((m) => void (m.projects[0]!.skipped = [
      { path: 'wiki/page.md', bytes: 10, reason: 'size_cap' },
      { path: 'findings/notes.md', bytes: 10, reason: 'size_cap' },
      { path: 'knowledge/gotchas.json', bytes: 4096, reason: 'secret_scan' },
    ])));
    expect(report.warnings[0]).toBe(
      'P One: MEMORY NOT MOVED. This machine does not have: knowledge/gotchas.json (secret scan, 4 KB), wiki/page.md (size cap, 1 KB). ' +
        'Keep /src/p/.crewly on the source until you have copied them over (for "secret scan", remove the credential first).',
    );
    expect(report.warnings.join(' ')).toContain('3 project file(s) were left out');
    expect(report.memory).toEqual({
      notMoved: [
        { project: 'P One', path: 'knowledge/gotchas.json', reason: 'secret_scan', bytes: 4096 },
        { project: 'P One', path: 'wiki/page.md', reason: 'size_cap', bytes: 10 },
      ],
      masked: [],
      warnings: [report.warnings[0]],
    });
  });

  it('names every memory store however many there are, and only caps other memory files', () => {
    const project = (paths: string[]) => ({ name: 'P', sourcePath: '/s', dataDir: '.crewly', skipped: paths.map((p) => ({ path: p, bytes: 1, reason: 'size_cap' as const })) }) as unknown as PackageProject;
    expect(leftOutMemory(project(['findings/a.md', 'specs/b.md']))).toBeNull();
    const stores = Array.from({ length: 14 }, (_, i) => `knowledge/${String(i).padStart(2, '0')}.json`);
    const left = leftOutMemory(project([...Array.from({ length: 12 }, (_, i) => `wiki/${i}.md`), ...stores]))!;
    for (const store of stores) expect(left.warning).toContain(store);
    expect(left.files).toHaveLength(stores.length + 10);
    expect(left.warning).toContain('and 2 more');
  });

  it('says nothing about memory when it all arrived', async () => {
    expect((await run(await pack())).memory).toBeUndefined();
  });

  describe('a memory store that arrived masked', () => {
    const MASKED = '[{"id":"a","problem":"[REDACTED]"}]';
    const maskedPack = () =>
      pack(async (m, s) => {
        await s.writeText('projects/p1/data/knowledge/gotchas.json', MASKED);
        m.files = s.files();
        m.projects[0]!.redacted = [{ path: 'knowledge/gotchas.json', redactions: 2 }];
      });

    it('is put in place and named when this machine had none', async () => {
      const report = await run(await maskedPack());
      const [project] = await storage.getProjects();
      expect(await fs.readFile(path.join(project!.path, '.crewly', 'knowledge', 'gotchas.json'), 'utf8')).toBe(MASKED);
      expect(report.memory!.masked).toEqual([{ project: 'P One', path: 'knowledge/gotchas.json', redactions: 2 }]);
      expect(report.warnings[0]).toContain('MEMORY MASKED');
      expect(report.warnings[0]).toContain('knowledge/gotchas.json (2)');
    });

    it('never replaces the store this machine already has', async () => {
      const first = await run(await pack());
      const [project] = await storage.getProjects();
      const store = path.join(project!.path, '.crewly', 'knowledge', 'gotchas.json');
      await fs.mkdir(path.dirname(store), { recursive: true });
      await fs.writeFile(store, '[{"id":"mine"}]');
      expect(first.memory).toBeUndefined();
      // The team left again, then comes back with a masked copy.
      const [team] = await storage.getTeams();
      await storage.saveTeam({ ...team!, moveArchive: { moveId: 'm' } } as unknown as Team);

      const report = await run(await maskedPack());

      expect(await fs.readFile(store, 'utf8')).toBe('[{"id":"mine"}]');
      const savedAs = report.memory!.masked[0]!.savedAs!;
      expect(savedAs.startsWith(`${store}.moved-masked-`)).toBe(true);
      expect(await fs.readFile(savedAs, 'utf8')).toBe(MASKED);
      expect(report.warnings[0]).toContain('This machine kept its own version');
    });
  });

  it('reports repositories it could not clone and non-git folders separately', async () => {
    const p = await pack((m) => {
      m.repos.push({ projectId: 'p2', projectName: 'Docs', path: '/src/docs', remoteUrl: null, branch: null, headSha: null, dirty: false, unpushed: 0, note: 'not a git repository — files are not moved, only Crewly data' });
      m.projects.push({ id: 'p2', name: 'Docs', sourcePath: '/src/docs', dataDir: '.crewly', files: 0, bytes: 0, skipped: [], sharedWithTeams: ['Other'] });
      m.team.projectIds.push('p2');
    });
    const report = await run(p, deps({ restoreRepo: async () => ({ ok: false, branch: null, headSha: null, warnings: [], error: 'Permission denied (publickey)' }) }));
    expect(report.repos.failed).toEqual([{ name: 'P One', reason: 'Permission denied (publickey)', remote: 'git@x:y/z.git', needsLogin: false }]);
    expect(report.reconnect.find((r) => r.kind === 'git')!.detail).toMatch(/publickey/);
    expect(report.warnings.join(' ')).toMatch(/Docs: not a git repository/);
    expect(report.warnings.join(' ')).toMatch(/also used by Other/);
  });

  it('does not start a paused team and reports a failed start', async () => {
    const paused = await pack(() => undefined, { config: { id: 'team-1', name: 'T', paused: { by: 'owner', pausedAt: 'x' }, members: [{ id: 'm1', name: 'A', sessionName: 's-a' }], projectIds: ['p1'], createdAt: 'x', updatedAt: 'x' } });
    const started = jest.fn().mockResolvedValue({ ok: true });
    const report = await run(paused, deps({ startTeam: started }));
    expect(started).not.toHaveBeenCalled();
    expect(report.started.error).toMatch(/paused/);

    await fs.rm(path.join(home, 'teams'), { recursive: true, force: true });
    const failing = await run(await pack(), deps({ startTeam: async () => ({ ok: false, error: 'no tmux' }), sleep: async () => undefined, startRetryDelaysMs: [] }));
    expect(failing.started).toEqual({ requested: true, ok: false, error: 'no tmux' });
    expect(failing.warnings[0]).toMatch(/The team did not start on this machine: no tmux/);
  });

  it('retries a failed start with backoff and reports the attempts when it finally works', async () => {
    const waits: number[] = [];
    const startTeam = jest.fn().mockResolvedValueOnce({ ok: false, error: 'Failed to initialize agent' }).mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ ok: true });
    const report = await run(await pack(), deps({ startTeam, sleep: async (ms) => void waits.push(ms), startRetryDelaysMs: [10, 20, 40] }));
    expect(startTeam).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([10, 20]);
    expect(report.started).toEqual({ requested: true, ok: true, attempts: 3 });
    expect(report.warnings.join(' ')).not.toMatch(/did not start/);
  });

  it('counts a start that timed out as started when the members came up anyway (no second start)', async () => {
    const startTeam = jest.fn().mockResolvedValue({ ok: false, error: 'The operation was aborted due to timeout' });
    const isTeamRunning = jest.fn().mockResolvedValue(true);
    const report = await run(await pack(), deps({ startTeam, isTeamRunning, sleep: async () => undefined, startRetryDelaysMs: [1, 1] }));
    expect(startTeam).toHaveBeenCalledTimes(1);
    expect(report.started).toEqual({ requested: true, ok: true });
  });

  it('checks before a retry whether the earlier start went on in the background', async () => {
    const startTeam = jest.fn().mockResolvedValue({ ok: false, error: 'The operation was aborted due to timeout' });
    const isTeamRunning = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const report = await run(await pack(), deps({ startTeam, isTeamRunning, sleep: async () => undefined, startRetryDelaysMs: [1, 1] }));
    expect(startTeam).toHaveBeenCalledTimes(1);
    expect(report.started).toMatchObject({ requested: true, ok: true });
  });

  it('gives up after the last delay and says how often it tried', async () => {
    const startTeam = jest.fn().mockResolvedValue({ ok: false, error: 'No team member could start' });
    const report = await run(await pack(), deps({ startTeam, sleep: async () => undefined, startRetryDelaysMs: [1, 1] }));
    expect(startTeam).toHaveBeenCalledTimes(3);
    expect(report.started).toMatchObject({ requested: true, ok: false, attempts: 3, error: 'No team member could start' });
    expect(report.warnings[0]).toMatch(/tried 3 times/);
  });

  it('names the stand-in runtime and the machine in the reconnect checklist', async () => {
    const report = await run(
      await pack((m) => {
        m.requiredRuntimes = ['antigravity-cli', 'claude-code'];
      }),
      deps({
        startTeam: async () => ({ ok: true }),
        getStandIns: async () => [{ member: 'Ruth', configured: 'Antigravity', runningOn: 'Claude Code' }],
        machineName: () => 'iriss-air',
        runtimeLogins: async () => ({ 'antigravity-cli': false, 'claude-code': true }),
      }),
    );
    expect(report.started.fallbacks).toEqual([{ member: 'Ruth', configured: 'Antigravity', runningOn: 'Claude Code' }]);
    const item = report.reconnect.find((r) => r.kind === 'runtime')!;
    expect(item.label).toBe('Antigravity login on iriss-air');
    expect(item.detail).toContain('Ruth runs on Claude Code until Antigravity is logged in on iriss-air; it switches back automatically.');
    expect(report.reconnect.filter((r) => r.kind === 'runtime')).toHaveLength(1);
  });

  describe('a team without a project', () => {
    const projectless = { id: 'team-1', name: 'SteamFun', members: [{ id: 'm1', name: 'A', sessionName: 's-a', role: 'developer', runtimeType: 'claude-code' }], projectIds: [] as string[], createdAt: 'x', updatedAt: 'x' };
    const noProjects = (m: TeamMoveManifest): void => {
      m.team.name = 'SteamFun';
      m.projects = [];
      m.repos = [];
      m.team.projectIds = [];
    };

    it('gets a home project under the projects root so the start route has a project to run in', async () => {
      const seen: Array<{ projectIds: string[]; known: string[] }> = [];
      const startTeam = jest.fn(async (teamId: string) => {
        const team = (await storage.getTeams()).find((t) => t.id === teamId)!;
        // What the real start route needs: projectIds[0] is a project that exists.
        seen.push({ projectIds: team.projectIds, known: (await storage.getProjects()).map((p) => p.id) });
        return { ok: team.projectIds.length > 0 && (await storage.getProjects()).some((p) => p.id === team.projectIds[0]) };
      });
      const report = await run(await pack(noProjects, { config: projectless }), deps({ startTeam }));
      const projects = await storage.getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]!.path).toBe(path.join(root, 'projects', 'steamfun'));
      expect((await fs.stat(projects[0]!.path)).isDirectory()).toBe(true);
      expect(seen[0]!.projectIds).toEqual([projects[0]!.id]);
      expect(report.started).toEqual({ requested: true, ok: true });
      expect(report.warnings.join(' ')).toMatch(/no project folder on the source; it runs from .*steamfun/);
    });

    it('is idempotent: a second import of the same team id reuses the home project', async () => {
      await run(await pack(noProjects, { config: projectless }), deps({ startTeam: async () => ({ ok: true }) }));
      await fs.rm(path.join(home, 'teams'), { recursive: true, force: true });
      await run(await pack(noProjects, { config: projectless }), deps({ startTeam: async () => ({ ok: true }) }));
      expect(await storage.getProjects()).toHaveLength(1);
    });

    // crewly#1344: the SteamFun team arrived on the Air with projectIds: []
    // and no project — its agents ran with no project CLAUDE.md, memory or wiki.
    it('keeps a project id that did not come along: a flagged placeholder folder, a note, and one DM to the owner', async () => {
      const dms: string[] = [];
      const dangling = await pack(
        (m) => {
          m.team.name = 'SteamFun';
          m.projects = [];
          m.repos = [];
        },
        { config: { ...projectless, projectIds: ['gone-1'] } },
      );
      const report = await run(dangling, deps({ startTeam: async () => ({ ok: true }), notifyOwner: async (text) => void dms.push(text), machineName: () => 'the Air' }));
      const [team] = await storage.getTeams();
      const [project] = await storage.getProjects();
      expect(team!.projectIds).toEqual(['gone-1']);
      expect(project!.id).toBe('gone-1');
      expect(project!.path).toBe(path.join(root, 'projects', 'steamfun-project-NEEDS-PATH'));
      expect((await fs.stat(project!.path)).isDirectory()).toBe(true);
      expect(report.warnings.join(' ')).toMatch(/placeholder .*steamfun-project-NEEDS-PATH — set the real path/);
      expect(dms).toHaveLength(1);
      expect(dms[0]).toContain('SteamFun moved to the Air');
      expect(dms[0]).toContain('steamfun-project-NEEDS-PATH');
    });

    it('names the source path when the manifest knows the project, and sends no DM when nothing is missing', async () => {
      const dms: string[] = [];
      const dangling = await pack(
        (m) => {
          m.repos = [];
          m.projects = [{ id: 'gone-2', name: 'Site', sourcePath: '/Users/src/site', dataDir: '.crewly', files: 0, bytes: 0, skipped: [], sharedWithTeams: [] }];
          m.team.projectIds = ['gone-2'];
        },
        { config: { ...projectless, projectIds: ['gone-2'] } },
      );
      // The manifest project is registered normally (relocated under the projects root): nothing is missing.
      const report = await run(dangling, deps({ startTeam: async () => ({ ok: true }), notifyOwner: async (text) => void dms.push(text) }));
      expect((await storage.getTeams())[0]!.projectIds).toEqual(['gone-2']);
      expect(report.warnings.join(' ')).not.toContain('NEEDS-PATH');
      expect(dms).toEqual([]);
    });

    it("keeps the team's own projects when it has them", async () => {
      await run(await pack(), deps({ startTeam: async () => ({ ok: true }) }));
      expect((await storage.getTeams())[0]!.projectIds).toEqual(['p1']);
      expect(await storage.getProjects()).toHaveLength(1);
    });
  });

  describe('agent conversations (crewly#1344)', () => {
    it('puts a carried transcript under this machine\'s Claude home for the member\'s new cwd and remembers it for the launch', async () => {
      const claudeHome = path.join(root, 'claude');
      const p = await pack(async (m, s) => {
        await s.writeText('transcripts/s-a/conv-a.jsonl', `${JSON.stringify({ type: 'user', cwd: '/src/p', message: { content: 'open /src/p/README.md' } })}\n`);
        m.conversations = [{ sessionName: 's-a', sessionId: 'conv-a', cwd: '/src/p', bytes: 10, file: 'transcripts/s-a/conv-a.jsonl', files: 1 }, { sessionName: 's-b', sessionId: 'conv-b', cwd: '/src/p', bytes: 0, skipped: 'not_found' }];
        m.files = s.files();
      });
      const report = await run(p, deps({ claudeHome }));
      const [project] = await storage.getProjects();
      const [slug] = resolveProjectSlugCandidatesSync(project!.path);
      const text = await fs.readFile(path.join(claudeHome, 'projects', slug, 'conv-a.jsonl'), 'utf8');
      expect(text).toContain(`open ${project!.path}/README.md`);
      expect(JSON.parse(await fs.readFile(path.join(home, 'last-conversations.json'), 'utf8'))['s-a']).toMatchObject({ sessionId: 'conv-a', cwd: project!.path });
      expect(report.moved['conversationsResumed']).toBe(1);
    });

    it('an older package without conversations imports as before', async () => {
      const report = await run(await pack());
      expect(report.moved['conversationsResumed']).toBe(0);
    });
  });

  describe('repositories the target cannot clone', () => {
    it('fails that repository with a sign-in item and still starts the team (no hang)', async () => {
      const startTeam = jest.fn().mockResolvedValue({ ok: true });
      const p = await pack((m) => void (m.repos[0]!.remoteUrl = 'https://github.com/stevehuang0115/edu-game.git'));
      const report = await run(
        p,
        deps({
          startTeam,
          machineName: () => 'iriss-air.lan',
          restoreRepo: async () => ({ ok: false, branch: null, headSha: null, warnings: [], error: "this machine has no git credentials for the remote (sign in to it first): fatal: could not read Username for 'https://github.com': terminal prompts disabled" }),
        }),
      );
      expect(report.repos.failed).toEqual([expect.objectContaining({ name: 'P One', needsLogin: true, remote: 'https://github.com/stevehuang0115/edu-game.git' })]);
      expect(report.reconnect.find((r) => r.label === 'Sign in to GitHub on iriss-air.lan')).toMatchObject({ kind: 'git', detail: expect.stringMatching(/P One.*gh auth login.*phone/) });
      expect(startTeam).toHaveBeenCalled();
      expect(report.started.ok).toBe(true);
    });

    it('tests access first and fails the repository in seconds without cloning', async () => {
      const checkRemote = jest.fn().mockResolvedValue({ ok: false, error: 'no git credentials' });
      const report = await run(await pack(), deps({ checkRemote, startTeam: async () => ({ ok: true }) }));
      expect(checkRemote).toHaveBeenCalledWith('git@x:y/z.git');
      expect(restoreCalls).toEqual([]);
      expect(report.repos.failed[0]).toMatchObject({ name: 'P One', needsLogin: true });
      expect(report.repos.failed[0]!.reason).toMatch(/cannot read x\/y\/z: no git credentials/);
      expect(report.started.ok).toBe(true);
    });

    it('treats a throwing access test as "cannot read"', async () => {
      const report = await run(await pack(), deps({ checkRemote: async () => Promise.reject(new Error('spawn failed')) }));
      expect(report.repos.failed[0]!.reason).toMatch(/spawn failed/);
    });
  });

  describe('progress', () => {
    it('reports the clone about every interval with what git has done, and once at the start', async () => {
      const events: ImportProgress[] = [];
      const restore: ImportDeps['restoreRepo'] = async (_dest, _repo, options) => {
        options?.onProgress?.({ phase: 'Receiving objects', percent: 40, objectsDone: 40, objectsTotal: 100, bytes: 5 * 1024 * 1024, rate: '2.00 MiB/s' });
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { ok: true, branch: 'main', headSha: 'abc', warnings: [] };
      };
      const p = await pack();
      await new TeamMoveImporter(deps({ restoreRepo: restore, progressIntervalMs: 40 })).run({ moveId: p.moveId, packageFile: p.file, privateKey: p.key.privateKey }, undefined, { onProgress: (e) => events.push(e) });
      expect(events[0]).toMatchObject({ step: 'repos', repo: 'P One', phase: null });
      const later = events.slice(1);
      expect(later.length).toBeGreaterThanOrEqual(2);
      expect(later[later.length - 1]).toMatchObject({ phase: 'Receiving objects', percent: 40, objectsDone: 40, objectsTotal: 100, bytes: 5 * 1024 * 1024 });
    });

    it('passes the repository size so the time limit scales with it', async () => {
      const sizes: Array<number | null | undefined> = [];
      const p = await pack((m) => void (m.repos[0]!.sizeBytes = 1_600_000_000));
      await run(p, deps({ restoreRepo: async (_d, _repo, options) => (sizes.push(options?.sizeBytes), { ok: true, branch: 'main', headSha: 'abc', warnings: [] }) }));
      expect(sizes).toEqual([1_600_000_000]);
    });
  });

  it('fails when there is not enough disk', async () => {
    await expect(run(await pack(), deps({ freeDisk: async () => 10 }))).rejects.toBeInstanceOf(TeamMoveImportError);
  });
});
