/**
 * A team's schedules in a move, with a real trigger engine on each side: they
 * travel with the team, fire on the target, leave the source only when it
 * archives, and come back on rollback (CREW-1332).
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageService } from '../core/storage.service.js';
import { TeamTriggerReconciler } from '../v3/team-trigger-reconciler.service.js';
import { TriggerEngine } from '../v3/trigger-engine.service.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';
import type { CreateTriggerInput, Trigger } from '../../types/v2/trigger.types.js';
import type { EventBusService } from '../event-bus/event-bus.service.js';
import type { Team, TeamTriggerSpec } from '../../types/index.js';
import { TeamMoveArchiver } from './team-move-archive.js';
import { generateTargetKeyPair } from './team-move-crypto.js';
import { TeamMoveExporter, buildEncryptedPackage } from './team-move-exporter.js';
import { TeamMoveImporter, type ImportDeps as ImporterDeps } from './team-move-importer.js';
import { FIXTURE, buildSourceFixture, buildTargetPaths, type Fixture } from './team-move.fixture.js';
import { engineTriggerStore } from './team-move-triggers.js';

const F = FIXTURE;
const MOVE_ID = 'move-triggers-0001';

/** One fire as the action handler saw it. */
interface Fire {
  id: string;
  /** Whether the team existed on that machine when the trigger fired */
  teamPresent: boolean;
}

/** One machine: its store, its running engine and what fired there. */
interface Machine {
  home: string;
  storage: StorageService;
  engine: TriggerEngine;
  bus: EventEmitter;
  fires: Fire[];
  store: ReturnType<typeof engineTriggerStore>;
}

const SPEC: TeamTriggerSpec = {
  name: 'weekly-review',
  config: { type: 'time', cronExpression: '0 9 * * 1' },
  action: { createWorkItem: { title: 'Weekly review', target: F.leadSession } },
};

/**
 * Start a machine whose engine runs like an installed service: from the package
 * directory, so its store is `<home>/triggers`.
 */
async function startMachine(root: string, name: string, home: string): Promise<Machine> {
  const before = process.env['CREWLY_HOME'];
  process.env['CREWLY_HOME'] = home;
  const holder = TriggerEngine as unknown as { instance: TriggerEngine | null };
  holder.instance = null;
  const engine = TriggerEngine.getInstance(path.join(root, name, 'node_modules', 'crewly'));
  holder.instance = null;
  if (before === undefined) delete process.env['CREWLY_HOME'];
  else process.env['CREWLY_HOME'] = before;

  const storage = new StorageService(home);
  const bus = new EventEmitter();
  const fires: Fire[] = [];
  engine.setEventBus(bus as unknown as EventBusService);
  engine.setActionHandler(async (trigger) => {
    const teams = await storage.getTeams();
    fires.push({ id: trigger.id, teamPresent: teams.some((t) => t.id === F.teamId) });
    return { status: 'ok' };
  });
  await engine.start();
  const reconciler = new TeamTriggerReconciler(engine);
  storage.onStorageEvent((event) => reconciler.handleStorageEvent(event));
  return { home, storage, engine, bus, fires, store: engineTriggerStore(() => engine) };
}

/** Wait until a condition holds (fires are asynchronous). */
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

describe('a team move carries the team\'s triggers', () => {
  let fx: Fixture;
  let source: Machine;
  let target: Machine;
  let ids: Record<'cron' | 'signal' | 'due' | 'later' | 'paused' | 'cancelled' | 'spec' | 'other' | 'noTeam', string>;

  const storedIds = async (m: Machine): Promise<string[]> =>
    (await safeReadJson<Trigger[]>(path.join(m.home, 'triggers', 'triggers.json'), [])).map((t) => t.id).sort();

  beforeEach(async () => {
    fx = await buildSourceFixture();
    const paths = await buildTargetPaths(fx.root);
    process.env['CREWLY_PROJECTS_ROOT'] = paths.projectsRoot;

    const configFile = path.join(fx.home, 'teams', F.teamId, 'config.json');
    const config = await safeReadJson<Team | null>(configFile, null);
    await atomicWriteJson(configFile, { ...config!, triggers: [SPEC] });

    source = await startMachine(fx.root, 'source-machine', fx.home);
    target = await startMachine(fx.root, 'target-machine', paths.home);

    const add = async (name: string, input: Partial<CreateTriggerInput>): Promise<Trigger> =>
      source.engine.create({
        type: 'time',
        config: { type: 'time', fireAt: new Date(Date.now() + 3_600_000).toISOString() },
        action: { createWorkItem: { title: name, target: F.devSession } },
        createdBy: 'agent',
        createdBySession: F.devSession,
        teamId: F.teamId,
        name,
        ...input,
      } as CreateTriggerInput);

    const cron = await add('hourly-check', { config: { type: 'time', cronExpression: '0 * * * *' } });
    const signal = await add('on-idle', {
      type: 'signal',
      config: { type: 'signal', eventType: 'agent:idle' },
      action: { sendMessage: { target: F.leadSession, message: 'a member went idle' } },
    });
    const due = await add('came-due-in-transit', {});
    const later = await add('in-an-hour', {});
    const paused = await add('paused-one', { config: { type: 'time', cronExpression: '30 8 * * *' } });
    const cancelled = await add('old-cancelled', { config: { type: 'time', cronExpression: '15 7 * * *' } });
    const spec = await add(SPEC.name, { config: SPEC.config, action: SPEC.action, createdBy: 'user', createdBySession: undefined, managedBy: 'team-spec' });
    const other = await add('other-team', { teamId: 'team-decoy', config: { type: 'time', cronExpression: '0 6 * * *' } });
    const noTeam = await add('machine-wide', { teamId: undefined, config: { type: 'time', cronExpression: '0 5 * * *' } });
    await source.engine.pause(paused.id);
    await source.engine.cancel(cancelled.id);

    // The cron has an overdue slot; the one-shot's time passes while the team travels.
    const live = source.engine.__testing__();
    live.triggers.get(cron.id)!.lastFiredAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    (live.triggers.get(due.id)!.config as { fireAt: string }).fireAt = new Date(Date.now() - 1000).toISOString();
    await live.persistTriggers();

    ids = {
      cron: cron.id, signal: signal.id, due: due.id, later: later.id, paused: paused.id,
      cancelled: cancelled.id, spec: spec.id, other: other.id, noTeam: noTeam.id,
    };
  });

  afterEach(async () => {
    source.engine.stop();
    target.engine.stop();
    delete process.env['CREWLY_PROJECTS_ROOT'];
    await fx.cleanup();
  });

  const exportPackage = async (): Promise<{ file: string; privateKey: string; record: string; manifestPaths: string[] }> => {
    const exporter = new TeamMoveExporter({
      home: fx.home,
      getTeams: () => source.storage.getTeams(),
      getProjects: () => source.storage.getProjects(),
      getTriggers: () => source.store.list(),
      crewlyVersion: '9.9.9',
      source: { instanceId: 'src', deviceName: 'Mac' },
      knownSecrets: async () => [],
    });
    const result = await exporter.export({ teamId: F.teamId, moveId: MOVE_ID, stagingDir: path.join(fx.root, 'staging-out') });
    const key = generateTargetKeyPair();
    const file = path.join(fx.root, 'package.enc');
    await buildEncryptedPackage(result.staging.root, file, key.publicKey, MOVE_ID);
    const recordText = await fs.readFile(path.join(result.staging.root, 'records', 'triggers.json'), 'utf8');
    return { file, privateKey: key.privateKey, record: recordText, manifestPaths: result.manifest.files.map((f) => f.path) };
  };

  const importPackage = (pkg: { file: string; privateKey: string }, extra: Partial<ImporterDeps> = {}) =>
    new TeamMoveImporter({
      ...extra,
      home: target.home,
      crewlyVersion: '9.9.9',
      storage: target.storage,
      triggers: target.store,
      addWorkItems: async (items) => items.length,
      addDecisions: async (decisions) => decisions.length,
      adoptSlackMapping: async () => true,
      hasCommand: () => true,
      runtimeLogins: async () => ({}),
    }).run({ moveId: MOVE_ID, packageFile: pkg.file, privateKey: pkg.privateKey });

  const archiver = (): TeamMoveArchiver =>
    new TeamMoveArchiver({
      home: fx.home,
      storage: source.storage,
      triggers: source.store,
      runtime: { stopTeam: async () => undefined, startTeam: async () => ({ ok: true }) },
      pool: { read: async () => ({ workItems: [] }), removeWorkItems: async () => 0, addWorkItems: async () => 0 },
      decisions: { list: async () => [], setStatus: async () => undefined },
      slack: { unlink: async () => null, adopt: async () => true },
    });

  const liveIds = (): string[] => [ids.cron, ids.signal, ids.due, ids.later, ids.paused, ids.spec].sort();
  const teamIds = (): string[] => [...liveIds(), ids.cancelled].sort();

  it('packages the live triggers of this team and no trigger store file', async () => {
    const pkg = await exportPackage();
    const record = JSON.parse(pkg.record) as { triggers: Trigger[] };

    expect(record.triggers.map((t) => t.id).sort()).toEqual(liveIds());
    expect(pkg.manifestPaths).toContain('records/triggers.json');
    expect(pkg.manifestPaths.filter((p) => /\/data\/triggers\//.test(p))).toEqual([]);
    // Packaging takes nothing from the source.
    expect(await storedIds(source)).toEqual([...teamIds(), ids.other, ids.noTeam].sort());
  });

  it('imports them into the target store, names each, and they fire there; the source loses them on archive', async () => {
    const pkg = await exportPackage();
    const report = await importPackage(pkg);

    expect(await storedIds(target)).toEqual(liveIds());
    expect(report.triggers?.imported).toHaveLength(6);
    expect(report.triggers?.skipped).toEqual([]);
    expect(report.triggers?.failed).toEqual([]);
    expect(report.moved['triggersImported']).toBe(6);
    for (const name of ['hourly-check', 'on-idle', 'came-due-in-transit', 'in-an-hour', 'paused-one', SPEC.name]) {
      expect(report.warnings.join('\n')).toContain(name);
    }
    // The declared schedule is the moved row, not a second one made on arrival.
    expect(target.engine.list().filter((t) => t.name === SPEC.name).map((t) => t.id)).toEqual([ids.spec]);
    expect(target.engine.get(ids.paused)?.status).toBe('paused');

    // The one-shot that came due on the way fires once the team is there.
    await until(() => target.fires.some((f) => f.id === ids.due));
    expect(target.fires.find((f) => f.id === ids.due)?.teamPresent).toBe(true);
    // Time (cron) and signal triggers fire on the target.
    await target.engine.evaluateTimeTriggers();
    target.bus.emit('event_published', { eventId: 'e1', eventType: 'agent:idle', sessionName: F.devSession });
    await until(() => target.fires.some((f) => f.id === ids.cron) && target.fires.some((f) => f.id === ids.signal));

    // The target has confirmed the import: now the source stops and archives.
    await archiver().archive(MOVE_ID, F.teamId);

    expect(await storedIds(source)).toEqual([ids.other, ids.noTeam].sort());
    const before = source.fires.length;
    source.bus.emit('event_published', { eventId: 'e2', eventType: 'agent:idle', sessionName: F.devSession });
    await source.engine.evaluateTimeTriggers();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(source.fires.slice(before).filter((f) => teamIds().includes(f.id))).toEqual([]);
  });

  it('restores every one of the team\'s triggers on the source on rollback', async () => {
    const a = archiver();
    await a.archive(MOVE_ID, F.teamId);
    expect(await storedIds(source)).toEqual([ids.other, ids.noTeam].sort());

    const outcome = await a.restore(MOVE_ID, { start: false });

    expect(outcome).toEqual({ restored: true, started: false });
    expect(await storedIds(source)).toEqual([...teamIds(), ids.other, ids.noTeam].sort());
    expect(source.engine.get(ids.paused)?.status).toBe('paused');
    expect(source.engine.get(ids.cancelled)?.status).toBe('cancelled');
    expect(source.engine.list().filter((t) => t.name === SPEC.name).map((t) => t.id)).toEqual([ids.spec]);
    await until(() => source.fires.some((f) => f.id === ids.due));
    expect(source.fires.find((f) => f.id === ids.due)?.teamPresent).toBe(true);
    source.bus.emit('event_published', { eventId: 'e3', eventType: 'agent:idle', sessionName: F.devSession });
    await until(() => source.fires.some((f) => f.id === ids.signal));
  });

  it('points a moved trigger at the id the target already uses for a shared room', async () => {
    const sourceRoom = '3e4b40f2-0000-4000-8000-000000000001';
    const targetRoom = 'cdf6c8bb-0000-4000-8000-000000000002';
    const slackFile = path.join(fx.home, 'slack-team-channels.json');
    const slack = await safeReadJson<{ mappings: Array<Record<string, unknown>> }>(slackFile, { mappings: [] });
    slack.mappings.push({ teamId: 'adhoc:C0SHARED', slackChannelId: 'C0SHARED', slackChannelName: 'shared-room', chatChannelId: sourceRoom, createdAt: '2026-10-05T10:00:00.000Z', autoCreated: false, members: [F.leadSession] });
    await atomicWriteJson(slackFile, slack);
    const post = await source.engine.create({
      type: 'time',
      config: { type: 'time', cronExpression: '0 8 * * *' },
      action: { sendMessage: { target: F.leadSession, message: `post the summary to ${sourceRoom}` } },
      createdBy: 'agent',
      createdBySession: F.devSession,
      teamId: F.teamId,
      name: 'daily-post',
    });

    await importPackage(await exportPackage(), { adoptAdhocMapping: async () => ({ chatChannelId: targetRoom, added: false }) });

    expect(target.engine.get(post.id)?.action).toEqual({ sendMessage: { target: F.leadSession, message: `post the summary to ${targetRoom}` } });
  });

  it('skips ids the target already has and says which', async () => {
    const pkg = await exportPackage();
    await target.engine.restoreTriggers([source.engine.get(ids.signal)!]);

    const report = await importPackage(pkg);

    expect(report.triggers?.imported).toHaveLength(5);
    expect(report.triggers?.skipped).toEqual([{ trigger: `on-idle (${ids.signal.slice(0, 8)})`, reason: 'a trigger with this id is already here' }]);
    expect(await storedIds(target)).toEqual(liveIds());
  });
});
