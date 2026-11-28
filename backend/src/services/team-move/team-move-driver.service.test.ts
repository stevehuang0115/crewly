/**
 * The whole protocol between two machines and an in-process fake Cloud:
 * request, prepare, package, upload, download, import, stop+archive, and the
 * owner's rollback.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageService } from '../core/storage.service.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { IncomingMessage } from '../cloud/cloud-sync.types.js';
import { TeamMoveArchiver } from './team-move-archive.js';
import type { TeamMoveCloudClient } from './team-move-cloud.client.js';
import {
  TeamMoveDriver,
  friendlyError,
  getTeamMoveDriver,
  isTeamMoveDriverActive,
  parseRelayData,
  setTeamMoveDriver,
  teamMoveCapabilities,
} from './team-move-driver.service.js';
import { TeamMoveExporter } from './team-move-exporter.js';
import { TeamMoveImporter } from './team-move-importer.js';
import { FIXTURE, buildSourceFixture, buildTargetPaths, type Fixture, emptyTriggerStore } from './team-move.fixture.js';
import type { TeamMovePreflight, TeamMoveReportStatus, TeamMoveRole, TeamMoveAction, TeamMoveView } from './team-move.types.js';

// Fake credentials are assembled at run time so secret scanners do not flag this file.
const FAKE_OPENAI = ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');

const F = FIXTURE;
const MOVE_ID = 'move-protocol-000001';

/** A Cloud that keeps one move and calls the machines back, like the relay push does. */
class FakeCloud {
  view: TeamMoveView | null = null;
  chunks = new Map<number, Buffer>();
  statuses: string[] = [];
  progress: Array<Record<string, unknown>> = [];
  failure: string | null = null;
  readonly drivers = new Map<string, TeamMoveDriver>();
  sha = '';
  size = 0;
  manifest: Record<string, unknown> = {};

  clientFor(instanceId: string): TeamMoveCloudClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the fake client closes over the Cloud
    const self = this;
    const roleOf = (): TeamMoveRole => (instanceId === 'src' ? 'source' : 'target');
    const client = {
      isConnected: () => true,
      create: async (body: { teamId: string; sourceInstanceId: string; targetInstanceId: string; remotes?: string[] }) => {
        self.view = {
          moveId: MOVE_ID,
          teamId: body.teamId,
          teamName: 'Movers',
          source: { instanceId: body.sourceInstanceId, name: 'Mac' },
          target: { instanceId: body.targetInstanceId, name: 'Air' },
          status: 'requested',
          ...(body.remotes ? { remotes: body.remotes } : {}),
          createdAt: 'x',
          updatedAt: 'x',
        };
        void self.push('target', 'prepare');
        return { moveId: MOVE_ID };
      },
      list: async () => (self.view ? [self.viewFor(instanceId)] : []),
      listRecent: async () => (self.view ? [self.viewFor(instanceId)] : []),
      get: async () => self.viewFor(instanceId),
      postTargetKey: async (_id: string, body: { publicKey: string; preflight: TeamMovePreflight }) => {
        self.view!.targetPublicKey = body.publicKey;
        self.view!.preflight = body.preflight;
        self.set('target_ready');
        await self.push('source', 'package');
      },
      packageInit: async (_id: string, body: { size: number; sha256: string; chunks: number; manifest: Record<string, unknown> }) => {
        self.size = body.size;
        self.sha = body.sha256;
        self.manifest = body.manifest;
        self.set('packaging');
        return { uploadId: 'u1', received: [...self.chunks.keys()] };
      },
      putChunk: async (_id: string, n: number, chunk: Buffer) => void self.chunks.set(n, Buffer.from(chunk)),
      packageComplete: async () => {
        self.set('uploaded');
        self.view!.package = { size: self.size, sha256: self.sha, chunks: self.chunks.size, chunkBytes: 8 * 1024 * 1024, manifest: self.manifest };
        await self.push('target', 'import');
      },
      downloadPackage: async (_id: string, dest: string) => {
        const all = Buffer.concat([...self.chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, all);
        return all.length;
      },
      postStatus: async (_id: string, body: { status: TeamMoveReportStatus; report?: unknown; error?: string; progress?: unknown }) => {
        if (body.progress) {
          self.progress.push(body.progress as Record<string, unknown>);
          return;
        }
        self.statuses.push(`${roleOf()}:${body.status}`);
        if (body.status === 'importing') self.set('importing');
        else if (body.status === 'imported') {
          self.set('switched');
          self.view!.report = body.report as Record<string, unknown>;
          await self.push('source', 'stop_archive');
        } else if (body.status === 'source_stopped') self.set('completed');
        else if (body.status === 'failed') {
          self.failure = body.error ?? '';
          self.set('failed');
        }
      },
      rollback: async () => {
        self.set('rolled_back');
        await self.push('source', 'rollback');
        await self.push('target', 'rollback');
      },
    };
    return client as unknown as TeamMoveCloudClient;
  }

  private set(status: TeamMoveView['status']): void {
    this.view!.status = status;
  }

  private viewFor(instanceId: string): TeamMoveView {
    const role: TeamMoveRole = instanceId === 'src' ? 'source' : 'target';
    return { ...this.view!, role, action: this.pending?.role === role ? this.pending.action : undefined };
  }

  pending: { role: TeamMoveRole; action: TeamMoveAction } | null = null;

  async push(role: TeamMoveRole, action: TeamMoveAction): Promise<void> {
    this.pending = { role, action };
    const driver = this.drivers.get(role === 'source' ? 'src' : 'dst')!;
    await driver.handleRelay({ id: 'm', from: 'cloud', fromDeviceName: 'Cloud', type: 'team_move', payload: { data: { moveId: MOVE_ID, role, action } }, encrypted: false, sentAt: 'x' } as IncomingMessage);
  }
}

describe('TeamMoveDriver protocol', () => {
  let fx: Fixture;
  let sourceStorage: StorageService;
  let targetStorage: StorageService;
  let targetHome: string;
  let cloud: FakeCloud;
  let source: TeamMoveDriver;
  let target: TeamMoveDriver;
  let started: string[];
  let stopped: string[];
  let testedRemotes: string[];
  let denyGit: boolean;
  let told: Array<{ machine: string; session: string; text: string }>;

  beforeEach(async () => {
    fx = await buildSourceFixture();
    const t = await buildTargetPaths(fx.root);
    targetHome = t.home;
    process.env['CREWLY_PROJECTS_ROOT'] = t.projectsRoot;
    sourceStorage = new StorageService(fx.home);
    targetStorage = new StorageService(targetHome);
    cloud = new FakeCloud();
    started = [];
    stopped = [];
    testedRemotes = [];
    denyGit = false;
    told = [];

    const poolFile = (home: string): string => path.join(home, 'task-pool', 'pool.json');
    const poolAdd = (home: string) => async (items: Array<{ id: string }>): Promise<number> => {
      await fs.mkdir(path.dirname(poolFile(home)), { recursive: true });
      const pool = await safeReadJson<{ workItems: Array<{ id: string }> }>(poolFile(home), { workItems: [] });
      let added = 0;
      for (const it of items) if (!pool.workItems.some((w) => w.id === it.id)) (pool.workItems.push(it), (added += 1));
      await atomicWriteJson(poolFile(home), pool);
      return added;
    };
    const preflight = async (_tools?: readonly string[], remotes: readonly string[] = []): Promise<TeamMovePreflight> => {
      testedRemotes.push(...remotes);
      return { crewlyVersion: '9.9.9', freeDiskBytes: 50 * 1024 ** 3, tools: {}, runtimes: {}, ...(remotes.length ? { gitAccess: remotes.map((remote) => ({ remote, ok: !denyGit })) } : {}) };
    };

    const makeDriver = (instanceId: string, home: string, storage: StorageService): TeamMoveDriver =>
      new TeamMoveDriver({
        home,
        cloud: cloud.clientFor(instanceId),
        source: new EventEmitter() as never,
        identity: async () => ({ instanceId, deviceName: instanceId }),
        exporter: new TeamMoveExporter({
      getTriggers: async () => [],
          home,
          getTeams: () => storage.getTeams(),
          getProjects: () => storage.getProjects(),
          crewlyVersion: '9.9.9',
          source: { instanceId, deviceName: instanceId },
          knownSecrets: async () => [],
        }),
        archiver: new TeamMoveArchiver({
      triggers: emptyTriggerStore(),
          home,
          storage,
          runtime: {
            stopTeam: async (id) => void stopped.push(`${instanceId}:${id}`),
            startTeam: async (id) => (started.push(`${instanceId}:${id}`), { ok: true }),
          },
          pool: {
            read: () => safeReadJson(poolFile(home), { workItems: [] }) as never,
            removeWorkItems: async (ids) => {
              const pool = await safeReadJson<{ workItems: Array<{ id: string }> }>(poolFile(home), { workItems: [] });
              pool.workItems = pool.workItems.filter((w) => !ids.includes(w.id));
              await atomicWriteJson(poolFile(home), pool);
              return ids.length;
            },
            addWorkItems: poolAdd(home) as never,
          },
          decisions: { list: async () => [], setStatus: async () => undefined },
          slack: { unlink: async () => null, adopt: async () => true },
        }),
        importer: () =>
          new TeamMoveImporter({
      triggers: emptyTriggerStore(),
            home,
            crewlyVersion: '9.9.9',
            storage,
            addWorkItems: poolAdd(home) as never,
            addDecisions: async () => 0,
            adoptSlackMapping: async () => true,
            startTeam: async (id) => (started.push(`${instanceId}:${id}`), { ok: true }),
            hasCommand: () => true,
            runtimeLogins: async () => ({ 'claude-code': true }),
          }),
        preflight,
        sendToAgent: async (session, text) => (told.push({ machine: instanceId, session, text }), true),
        getTeams: () => storage.getTeams(),
        isTeamIdle: async () => true,
        sleep: async () => undefined,
      });
    source = makeDriver('src', fx.home, sourceStorage);
    target = makeDriver('dst', targetHome, targetStorage);
    cloud.drivers.set('src', source);
    cloud.drivers.set('dst', target);
  });

  afterEach(async () => {
    delete process.env['CREWLY_PROJECTS_ROOT'];
    await fx.cleanup();
  });

  /** Let the nested pushes of the fake Cloud finish. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 60 && cloud.view?.status !== 'completed' && cloud.view?.status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 400)); // the callers of the nested pushes finish their own bookkeeping
  };

  it('moves a team from the source to the target and archives the source copy', async () => {
    const { moveId } = await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    expect(moveId).toBe(MOVE_ID);
    await settle();

    expect(cloud.failure).toBeNull();
    expect(cloud.view!.status).toBe('completed');
    expect(cloud.statuses).toEqual(['target:importing', 'target:imported', 'source:source_stopped']);
    // Cloud got only a small summary and ciphertext.
    expect(cloud.manifest['noSecrets']).toBe(true);
    expect(JSON.stringify(cloud.manifest)).not.toContain('Lena');
    expect(Buffer.concat([...cloud.chunks.values()]).includes(Buffer.from('Movers'))).toBe(false);
    // Target has the team, started once; source no longer has it.
    expect((await targetStorage.getTeams()).map((t) => t.id)).toEqual([F.teamId]);
    expect(started).toEqual([`dst:${F.teamId}`]);
    expect((await sourceStorage.getTeams()).map((t) => t.id)).toEqual([F.decoyTeamId]);
    expect(stopped).toEqual([`src:${F.teamId}`]);
    // The report Cloud got is the one the owner sees.
    const report = cloud.view!.report as { moved: Record<string, number>; started: { ok: boolean } };
    expect(report.moved['members']).toBe(2);
    expect(report.started.ok).toBe(true);
    // The private key never existed on the source and is removed from the target once the import is done.
    await expect(fs.stat(path.join(fx.home, 'team-moves', MOVE_ID, 'target-key.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(targetHome, 'team-moves', MOVE_ID, 'target-key.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(targetHome, 'team-moves', MOVE_ID, 'package.enc'))).rejects.toThrow();
    // The importing move told Cloud what it was doing, and the status order did not change.
    expect(cloud.progress.length).toBeGreaterThanOrEqual(1);
    expect(cloud.progress[0]).toMatchObject({ step: 'repos', repo: expect.any(String) });
  });

  it('tells the orchestrator and the lead when memory arrived masked, and nobody otherwise', async () => {
    const knowledge = path.join(fx.projectDir, '.crewly', 'knowledge');
    await fs.mkdir(knowledge, { recursive: true });
    await fs.writeFile(path.join(knowledge, 'gotchas.json'), JSON.stringify([{ id: 'g1', problem: `OPENAI_API_KEY=${FAKE_OPENAI}` }]));

    await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    await settle();

    expect(cloud.view!.status).toBe('completed');
    const notices = told.filter((t) => t.text.includes('project memory'));
    expect(notices.map((n) => n.machine)).toEqual(['dst', 'dst']);
    expect(notices[0]!.session).toBe('crewly-orc');
    const [team] = await targetStorage.getTeams();
    expect(team!.members.map((m) => m.sessionName)).toContain(notices[1]!.session);
    expect(notices[0]!.text).toContain('knowledge/gotchas.json');
    expect(notices[0]!.text).not.toContain(FAKE_OPENAI);
  });

  it('sends no memory notice for a move that carried all memory', async () => {
    await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    await settle();
    expect(cloud.view!.status).toBe('completed');
    expect(told.filter((t) => t.text.includes('project memory'))).toEqual([]);
  });

  it('has the target test the repository remotes and carries the ones it cannot read in the package', async () => {
    denyGit = true;
    await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    await settle();

    expect(cloud.failure).toBeNull();
    expect(cloud.view!.status).toBe('completed');
    // The source sent the remotes (no credentials) with the request; the target tested exactly those.
    expect(cloud.view!.remotes).toHaveLength(1);
    expect(testedRemotes).toEqual(cloud.view!.remotes);
    expect(cloud.view!.preflight!.gitAccess).toEqual([{ remote: cloud.view!.remotes![0], ok: false }]);
    const report = cloud.view!.report as { repos: { cloned: Array<{ viaBundle?: boolean; remoteUnreachable?: boolean }>; failed: unknown[] }; reconnect: Array<{ label: string }> };
    expect(report.repos.failed).toEqual([]);
    expect(report.repos.cloned[0]).toMatchObject({ viaBundle: true, remoteUnreachable: true });
    expect(report.reconnect.map((r) => r.label).filter((l) => /^Sign in to .* on this machine$/.test(l))).toHaveLength(1);
  });

  it('rolls back: the target stops and archives its copy, the source restores and starts', async () => {
    await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    await settle();
    started.length = 0;

    await source.rollbackMove(MOVE_ID);
    expect(cloud.statuses).toEqual(expect.arrayContaining(['source:source_restored', 'target:target_stopped']));
    expect((await sourceStorage.getTeams()).map((t) => t.id).sort()).toEqual([F.decoyTeamId, F.teamId].sort());
    expect((await targetStorage.getTeams()).map((t) => t.id)).toEqual([]);
    expect(started).toEqual([`src:${F.teamId}`]);
  });

  it('answers a rollback for a move this machine never archived with just an ack', async () => {
    cloud.view = { moveId: MOVE_ID, teamId: F.teamId, teamName: 'Movers', source: { instanceId: 'src', name: 'Mac' }, target: { instanceId: 'dst', name: 'Air' }, status: 'failed', createdAt: 'x', updatedAt: 'x' };
    await cloud.push('source', 'rollback');
    expect(cloud.statuses).toEqual(['source:source_restored']);
    expect((await sourceStorage.getTeams()).map((t) => t.id).sort()).toEqual([F.decoyTeamId, F.teamId].sort());
    expect(started).toEqual([]);
  });

  it('tells Cloud what to push when the source has unpushed work, and does not package', async () => {
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
    await expect(source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' })).rejects.toThrow(/Push this work before moving/);
    expect(cloud.view).toBeNull();
    const allowed = await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst', allowDirty: true });
    expect(allowed.moveId).toBe(MOVE_ID);
    await settle(); // the move proceeds in the background; let it finish before cleanup
    expect(cloud.view!.status).toBe('completed');
  });

  it('reports a secret-scan failure from the package step as the move failure', async () => {
    await fs.writeFile(path.join(fx.projectDir, '.crewly', 'findings', 'leak.md'), `OPENAI_API_KEY=${FAKE_OPENAI}\n`);
    await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    await settle();
    expect(cloud.view!.status).toBe('failed');
    expect(cloud.failure).toMatch(/secret scan found credentials/);
    expect(cloud.chunks.size).toBe(0);
    expect((await sourceStorage.getTeams()).map((t) => t.id)).toContain(F.teamId);
  });

  it('polls pending moves and ignores views with nothing to do', async () => {
    expect(await source.poll()).toBe(0);
    await source.startMove({ teamId: F.teamId, targetInstanceId: 'dst' });
    await settle();
    // Nothing pending for the source once completed (pending is the stop_archive that already ran).
    cloud.pending = null;
    expect(await source.poll()).toBe(0);
    expect((await source.listMoves())[0]).toMatchObject({ moveId: MOVE_ID, local: { phase: 'done' } });
    const detail = await source.getMove(MOVE_ID);
    expect(detail.journal.some((j) => j.step === 'export' && j.state === 'done')).toBe(true);
  });

  describe('relay parsing and capability', () => {
    it('accepts only well-formed pushes', () => {
      expect(parseRelayData({ data: { moveId: MOVE_ID, role: 'target', action: 'prepare' } })).toEqual({ moveId: MOVE_ID, role: 'target', action: 'prepare' });
      expect(parseRelayData({ moveId: MOVE_ID, role: 'source', action: 'rollback' })).toEqual({ moveId: MOVE_ID, role: 'source', action: 'rollback' });
      expect(parseRelayData({ data: { moveId: '../x', role: 'target', action: 'prepare' } })).toBeNull();
      expect(parseRelayData({ data: { moveId: MOVE_ID, role: 'owner', action: 'prepare' } })).toBeNull();
      expect(parseRelayData({ data: { moveId: MOVE_ID, role: 'source', action: 'explode' } })).toBeNull();
      expect(parseRelayData(null)).toBeNull();
    });

    it('ignores other message types', async () => {
      expect(await source.handleRelay({ type: 'talk_message', payload: {} } as unknown as IncomingMessage)).toBe(false);
      expect(await source.handleRelay({ type: 'team_move', payload: { data: { moveId: 'x' } } } as unknown as IncomingMessage)).toBe(false);
    });

    it('advertises teamMove:1 only while started', () => {
      expect(teamMoveCapabilities()).toEqual([]);
      source.start();
      expect(isTeamMoveDriverActive()).toBe(true);
      expect(teamMoveCapabilities()).toEqual(['teamMove:1']);
      source.start();
      source.stop();
      expect(teamMoveCapabilities()).toEqual([]);
    });

    it('keeps a process-wide instance', () => {
      setTeamMoveDriver(source);
      expect(getTeamMoveDriver()).toBe(source);
      setTeamMoveDriver(null);
      expect(getTeamMoveDriver()).toBeNull();
    });

    it('turns errors into owner-readable text', () => {
      expect(friendlyError(new Error('boom'))).toBe('boom');
      expect(friendlyError('plain')).toBe('plain');
    });
  });
});
