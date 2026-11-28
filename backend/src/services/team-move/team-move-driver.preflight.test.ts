/**
 * The driver's side of the preflight: the pushes Cloud sends before a move
 * exists, the source and target answers, "ask the team", the owner's choices
 * arriving with the move, and the machine-readable failure detail.
 */

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageService } from '../core/storage.service.js';
import { generateTargetKeyPair } from './team-move-crypto.js';
import type { IncomingMessage } from '../cloud/cloud-sync.types.js';
import type { TeamMoveCloudClient, PreflightRequest, PreflightResultBody } from './team-move-cloud.client.js';
import { TeamMoveDriver, failureReport, parsePreflightRelayData } from './team-move-driver.service.js';
import { TeamMoveBlockedError, TeamMoveExporter } from './team-move-exporter.js';
import { TeamMoveSecretScanError } from './team-move-secret-scan.js';
import { FIXTURE, buildSourceFixture, type Fixture } from './team-move.fixture.js';
import type { TeamMoveView } from './team-move.types.js';

const F = FIXTURE;
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PF_ID = 'preflight-000000001';
const FAKE_SLACK = ['xoxb', '123456789012', '123456789012', 'abcdefghijklmnop'].join('-');

const push = (data: unknown): IncomingMessage => ({ id: 'm', from: 'cloud', fromDeviceName: 'Cloud', type: 'team_move', payload: { data }, encrypted: false, sentAt: 'x' }) as unknown as IncomingMessage;

describe('TeamMoveDriver preflight', () => {
  let fx: Fixture;
  let storage: StorageService;
  let results: Array<{ id: string; body: PreflightResultBody }>;
  let requests: PreflightRequest[];
  let created: Array<Record<string, unknown>>;
  let sent: Array<{ session: string; text: string }>;
  let deliver: boolean;
  let moveView: Partial<TeamMoveView>;
  let driver: TeamMoveDriver;

  const request = (over: Partial<PreflightRequest> = {}): PreflightRequest => ({
    preflightId: PF_ID,
    teamId: F.teamId,
    teamName: 'Movers',
    targetName: 'iriss-air.lan',
    role: 'source',
    action: 'preflight',
    options: {},
    ...over,
  });

  /** Wait until the driver has posted `n` results. */
  const answered = async (n = 1): Promise<void> => {
    for (let i = 0; i < 200 && results.length < n; i++) await new Promise((r) => setTimeout(r, 50));
  };

  beforeEach(async () => {
    fx = await buildSourceFixture();
    storage = new StorageService(fx.home);
    results = [];
    requests = [request()];
    created = [];
    sent = [];
    deliver = true;
    moveView = {};
    const cloud = {
      isConnected: () => true,
      list: async () => [],
      listRecent: async () => [],
      listPreflights: async () => requests,
      getPreflight: async () => requests[0]!,
      postPreflightResult: async (id: string, body: PreflightResultBody) => void results.push({ id, body }),
      create: async (body: Record<string, unknown>) => (created.push(body), { moveId: 'move-created-0001' }),
      get: async () => moveView as TeamMoveView,
    };
    driver = new TeamMoveDriver({
      home: fx.home,
      cloud: cloud as unknown as TeamMoveCloudClient,
      source: new EventEmitter() as never,
      identity: async () => ({ instanceId: 'src', deviceName: 'Mac' }),
      exporter: new TeamMoveExporter({
      getTriggers: async () => [],
        home: fx.home,
        getTeams: () => storage.getTeams(),
        getProjects: () => storage.getProjects(),
        crewlyVersion: '9.9.9',
        source: { instanceId: 'src', deviceName: 'Mac' },
        knownSecrets: async () => [],
      }),
      importer: () => {
        throw new Error('not used');
      },
      archiver: {} as never,
      preflight: async () => ({ crewlyVersion: '9.9.9', freeDiskBytes: 5e10, tools: { ffmpeg: false, git: true }, runtimes: { 'claude-code': true } }),
      isTeamIdle: async () => true,
      sleep: async () => undefined,
      getTeams: () => storage.getTeams(),
      sendToAgent: async (session, text) => {
        sent.push({ session, text });
        return deliver;
      },
    });
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('parses only well-formed preflight pushes', () => {
    expect(parsePreflightRelayData({ data: { preflightId: PF_ID, role: 'source', action: 'preflight' } })).toEqual({ preflightId: PF_ID, role: 'source', action: 'preflight' });
    expect(parsePreflightRelayData({ preflightId: PF_ID, role: 'source', action: 'ask_team' })).toEqual({ preflightId: PF_ID, role: 'source', action: 'ask_team' });
    expect(parsePreflightRelayData({ data: { preflightId: '../x', role: 'source', action: 'preflight' } })).toBeNull();
    expect(parsePreflightRelayData({ data: { preflightId: PF_ID, role: 'owner', action: 'preflight' } })).toBeNull();
    expect(parsePreflightRelayData({ data: { preflightId: PF_ID, role: 'source', action: 'package' } })).toBeNull();
    expect(parsePreflightRelayData({ data: { moveId: PF_ID, role: 'source', action: 'preflight' } })).toBeNull();
    expect(parsePreflightRelayData(null)).toBeNull();
  });

  it('answers a source preflight with the repositories, the scan and the size', async () => {
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
    expect(await driver.handleRelay(push({ preflightId: PF_ID, role: 'source', action: 'preflight' }))).toBe(true);
    await answered();
    expect(results).toHaveLength(1);
    const report = results[0]!.body.report as { repos: Array<{ untracked: number; carry: unknown }>; scan: { findings: unknown[] }; sizeBytes: number };
    expect(results[0]!.id).toBe(PF_ID);
    expect(report.repos[0]).toMatchObject({ untracked: 1 });
    expect(report.scan.findings).toEqual([]);
    expect(report.sizeBytes).toBeGreaterThan(0);
  });

  it('computes carry feasibility when the owner picked "carry changes"', async () => {
    requests = [request({ options: { carryChanges: true } })];
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
    await driver.handleRelay(push({ preflightId: PF_ID, role: 'source', action: 'preflight' }));
    await answered();
    const report = results[0]!.body.report as { carryRequested: boolean; repos: Array<{ carry: { possible: boolean; files: number } }> };
    expect(report.carryRequested).toBe(true);
    expect(report.repos[0]!.carry).toMatchObject({ possible: true, files: 1 });
  });

  it('answers a target preflight with the machine\'s own report', async () => {
    requests = [request({ role: 'target' })];
    await driver.handleRelay(push({ preflightId: PF_ID, role: 'target', action: 'preflight' }));
    await answered();
    expect(results[0]!.body.report).toMatchObject({ crewlyVersion: '9.9.9', tools: { ffmpeg: false } });
  });

  it('answers a preflight that cannot run with the reason instead of leaving the checklist spinning', async () => {
    requests = [request({ teamId: 'no-such-team' })];
    await driver.handleRelay(push({ preflightId: PF_ID, role: 'source', action: 'preflight' }));
    await answered();
    expect(results[0]!.body).toEqual({ error: expect.stringMatching(/not found on this machine/) });
  });

  it('asks the team lead to commit and push, listing the dirty files, and tells Cloud whom', async () => {
    requests = [request({ action: 'ask_team' })];
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
    await fs.writeFile(path.join(fx.projectDir, 'README.md'), 'edited');
    await driver.handleRelay(push({ preflightId: PF_ID, role: 'source', action: 'ask_team' }));
    await answered();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.session).toBe(F.leadSession);
    expect(sent[0]!.text).toContain('move team "Movers" to iriss-air.lan');
    expect(sent[0]!.text).toContain('- modified: README.md');
    expect(sent[0]!.text).toContain('- untracked: wip.txt');
    expect(results[0]!.body).toEqual({ ask: { ok: true, agents: ['Lena'] } });
  });

  it('says so when the lead could not be reached, and when there is nothing to ask', async () => {
    requests = [request({ action: 'ask_team' })];
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
    deliver = false;
    await driver.handleRelay(push({ preflightId: PF_ID, role: 'source', action: 'ask_team' }));
    await answered();
    expect(results[0]!.body).toEqual({ ask: { ok: false, agents: ['Lena'], error: 'could not reach Lena' } });

    results = [];
    sent = [];
    await fs.rm(path.join(fx.projectDir, 'wip.txt'));
    await driver.handleRelay(push({ preflightId: PF_ID, role: 'source', action: 'ask_team' }));
    await answered();
    expect(sent).toEqual([]);
    expect(results[0]!.body).toEqual({ ask: { ok: true, agents: [] } });
  });

  it('answers the preflight requests it finds when it polls (the push may have been lost)', async () => {
    expect(await driver.poll()).toBe(1);
    await answered();
    expect(results).toHaveLength(1);
  });

  it('sends the owner\'s choices to Cloud when a move is started on this machine, and refuses what cannot be carried', async () => {
    await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
    await expect(driver.startMove({ teamId: F.teamId, targetInstanceId: 'dst' })).rejects.toBeInstanceOf(TeamMoveBlockedError);
    const started = await driver.startMove({ teamId: F.teamId, targetInstanceId: 'dst', carryChanges: true, skipFlagged: true });
    expect(started.moveId).toBe('move-created-0001');
    expect(created[0]).toMatchObject({ teamId: F.teamId, targetInstanceId: 'dst', options: { carryChanges: true, skipFlagged: true } });
    const intent = JSON.parse(await fs.readFile(path.join(fx.home, 'team-moves', 'move-created-0001', 'intent.json'), 'utf8')) as Record<string, boolean>;
    expect(intent).toMatchObject({ carryChanges: true, skipFlagged: true, allowDirty: false });

    // A repository without a remote travels as a git bundle: not blocked...
    git(fx.projectDir, 'remote', 'remove', 'origin');
    await expect(driver.startMove({ teamId: F.teamId, targetInstanceId: 'dst' })).resolves.toBeDefined();
    // ...unless it is over the bundle cap.
    process.env['CREWLY_TEAM_MOVE_BUNDLE_MAX_MB'] = '0.0001';
    try {
      await expect(driver.startMove({ teamId: F.teamId, targetInstanceId: 'dst', carryChanges: true })).rejects.toThrow(/Push this work before moving.*over the/);
    } finally {
      delete process.env['CREWLY_TEAM_MOVE_BUNDLE_MAX_MB'];
    }
  });

  describe('packaging for a move started in the portal', () => {
    const key = generateTargetKeyPair().publicKey;
    let statuses: Array<{ status: string; error?: string; report?: unknown }>;
    let idleChecks: number;
    let uploaded: Array<{ size: number; manifest: Record<string, unknown> }>;
    let packaged: Driver;
    type Driver = TeamMoveDriver;

    beforeEach(() => {
      statuses = [];
      idleChecks = 0;
      uploaded = [];
      const cloud = {
        isConnected: () => true,
        get: async () => ({ moveId: 'move-portal-00001', teamId: F.teamId, teamName: 'Movers', status: 'target_ready', targetPublicKey: key, options: moveView.options } as TeamMoveView),
        postStatus: async (_id: string, body: { status: string; error?: string; report?: unknown }) => void statuses.push(body),
        packageInit: async (_id: string, body: { size: number; manifest: Record<string, unknown> }) => (uploaded.push(body), { uploadId: 'u', received: [] }),
        putChunk: async () => undefined,
        packageComplete: async () => undefined,
      };
      packaged = new TeamMoveDriver({
        home: fx.home,
        cloud: cloud as unknown as TeamMoveCloudClient,
        source: new EventEmitter() as never,
        identity: async () => ({ instanceId: 'src', deviceName: 'Mac' }),
        exporter: new TeamMoveExporter({ getTriggers: async () => [], home: fx.home, getTeams: () => storage.getTeams(), getProjects: () => storage.getProjects(), crewlyVersion: '9.9.9', source: { instanceId: 'src', deviceName: 'Mac' }, knownSecrets: async () => [] }),
        importer: () => {
          throw new Error('not used');
        },
        archiver: {} as never,
        preflight: async () => ({ crewlyVersion: '9.9.9', freeDiskBytes: 5e10, tools: {}, runtimes: {} }),
        isTeamIdle: async () => (idleChecks++, true),
        sleep: async () => undefined,
      });
    });

    const run = (): Promise<unknown> => packaged.handleRelay(push({ moveId: 'move-portal-00001', role: 'source', action: 'package' }));
    const uploadedOne = async (): Promise<void> => {
      for (let i = 0; i < 300 && uploaded.length < 1 && statuses.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    };
    const settled = async (n: number): Promise<void> => {
      for (let i = 0; i < 200 && statuses.length < n; i++) await new Promise((r) => setTimeout(r, 50));
    };

    it('stops at once for work that exists only here, tells Cloud which repository and why, and never waits for the team', async () => {
      await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
      moveView = { options: {} };
      await run();
      await settled(1);
      expect(idleChecks).toBe(0);
      expect(statuses[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Push this work before moving the team: Movers App \(.*\): uncommitted changes/) });
      expect(statuses[0]!.report).toEqual({ failure: { code: 'unpushed_work', repos: [expect.stringContaining('Movers App')] } });
    });

    it('honors "carry changes" chosen in the portal: the work travels and nothing stops', async () => {
      await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
      moveView = { options: { carryChanges: true } };
      await run();
      await uploadedOne();
      expect(statuses).toEqual([]);
      expect(idleChecks).toBeGreaterThan(0);
      expect(uploaded[0]!.size).toBeGreaterThan(0);
    }, 20_000);

    it('honors "move anyway" chosen in the portal', async () => {
      await fs.writeFile(path.join(fx.projectDir, 'wip.txt'), 'x');
      moveView = { options: { allowDirty: true } };
      await run();
      await uploadedOne();
      expect(statuses).toEqual([]);
      expect(idleChecks).toBeGreaterThan(0);
    }, 20_000);
  });

  describe('failure detail', () => {
    it('gives the portal a code and the list to show', () => {
      expect(failureReport(new TeamMoveBlockedError(['edu-game (/p): uncommitted changes (commit and push them) on main']))).toEqual({
        failure: { code: 'unpushed_work', repos: ['edu-game (/p): uncommitted changes (commit and push them) on main'] },
      });
      expect(failureReport(new TeamMoveSecretScanError([{ path: 'projects/x/data/a.md', matches: 1 }]))).toEqual({ failure: { code: 'secrets_found', files: ['projects/x/data/a.md'] } });
      expect(failureReport(new Error('boom'))).toBeUndefined();
      expect(FAKE_SLACK).toBeTruthy();
    });
  });
});
