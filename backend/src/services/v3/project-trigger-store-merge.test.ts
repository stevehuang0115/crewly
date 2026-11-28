/**
 * Merge of per-project trigger stores, with a real engine and real files.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Trigger } from '../../types/v2/trigger.types.js';
import { MERGE_REPORT_FILE, mergeProjectTriggerStores, type ProjectStoreMergeRun } from './project-trigger-store-merge.js';
import { TriggerEngine } from './trigger-engine.service.js';

describe('mergeProjectTriggerStores', () => {
  let root: string;
  let home: string;
  let project: string;
  let engine: TriggerEngine;
  let fired: string[];
  const envHome = process.env['CREWLY_HOME'];

  const row = (id: string, over: Partial<Trigger> = {}): Trigger => ({
    id,
    type: 'time',
    config: { type: 'time', fireAt: '2026-01-01T00:00:00.000Z' },
    action: { sendMessage: { target: 'crewly-orc', message: 'check' } },
    status: 'active',
    createdBy: 'orchestrator',
    createdAt: '2025-12-01T00:00:00.000Z',
    fireCount: 0,
    ...over,
  } as Trigger);

  const projectFile = (dir: string): string => path.join(dir, '.crewly', 'triggers', 'triggers.json');
  const write = async (dir: string, content: string): Promise<void> => {
    await fs.mkdir(path.dirname(projectFile(dir)), { recursive: true });
    await fs.writeFile(projectFile(dir), content);
  };

  /** An engine as an installed service runs it: store in the Crewly home. */
  const boot = async (): Promise<TriggerEngine> => {
    TriggerEngine.resetInstance();
    const instance = TriggerEngine.getInstance(path.join(root, 'node_modules', 'crewly'));
    instance.setActionHandler(async (t) => {
      fired.push(t.id);
      return { status: 'ok' };
    });
    await instance.start();
    return instance;
  };

  const merge = (projects = [{ path: project }], teamIds = new Set(['team-here'])): Promise<ProjectStoreMergeRun> =>
    mergeProjectTriggerStores({ engine, projects, teamIds, now: () => '2026-02-01T00:00:00.000Z' });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'trigger-merge-'));
    home = path.join(root, 'home');
    project = path.join(root, 'repo');
    process.env['CREWLY_HOME'] = home;
    fired = [];
    engine = await boot();
  });

  afterEach(async () => {
    TriggerEngine.resetInstance();
    if (envHome === undefined) delete process.env['CREWLY_HOME'];
    else process.env['CREWLY_HOME'] = envHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('merges live rows by id as paused, fires none, and reports every one', async () => {
    await engine.restoreTriggers([row('here-already-1', { status: 'paused' })]);
    await write(project, JSON.stringify([
      row('overdue-1', { name: 'standup' }),
      row('paused-1', { status: 'paused', teamId: 'team-here' }),
      row('here-already-1'),
      row('system-1', { createdBy: 'system', name: 'system:escalation' }),
      row('internal-1', { internal: true }),
      row('elsewhere-1', { teamId: 'team-gone' }),
      row('done-1', { status: 'exhausted' }),
      row('gone-1', { status: 'cancelled' }),
      { id: 'broken-1', status: 'active' },
    ]));

    const run = await merge();
    await new Promise((resolve) => setImmediate(resolve));

    expect(run.merged).toHaveLength(1);
    const report = run.merged[0]!;
    expect(report).toMatchObject({ rows: 9, finished: 2, merged: ['standup (overdue-)', 'paused-1'] });
    expect(report.skipped.map((s) => s.reason).sort()).toEqual([
      'a trigger with this id is already here',
      'internal: each machine registers its own',
      'internal: each machine registers its own',
      'its team is not on this machine',
    ]);
    expect(report.failed).toEqual([{ trigger: 'broken-1', reason: 'unknown trigger type' }]);
    expect(report.merged.length + report.skipped.length + report.failed.length + report.finished).toBe(report.rows);
    expect(engine.get('overdue-1')?.status).toBe('paused');
    expect(fired).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(home, 'triggers', 'triggers.json'), 'utf8')) as Trigger[];
    expect(stored.map((t) => t.id).sort()).toEqual(['here-already-1', 'overdue-1', 'paused-1']);
    const saved = JSON.parse(await fs.readFile(path.join(home, 'triggers', MERGE_REPORT_FILE), 'utf8')) as unknown[];
    expect(saved).toEqual([report]);
  });

  it('merges a file once: a trigger deleted afterwards stays deleted across a restart', async () => {
    // Two rows: the engine refuses to delete the last trigger of a store.
    await write(project, JSON.stringify([row('once-1'), row('kept-1')]));
    await merge();
    await engine.delete('once-1');
    engine = await boot();

    const again = await merge();

    expect(again).toMatchObject({ projectsExamined: 1, merged: [] });
    expect(engine.get('once-1')).toBeUndefined();
  });

  it('never merges the live store into itself, and takes a shared file once', async () => {
    await engine.restoreTriggers([row('live-1', { status: 'paused' })]);
    await write(project, JSON.stringify([row('shared-1')]));
    const link = path.join(root, 'repo-link');
    await fs.symlink(project, link);

    const run = await merge([{ path: path.join(root, 'node_modules', 'crewly') }, { path: project }, { path: link }, { path: path.join(root, 'no-such-project') }]);

    expect(run.projectsExamined).toBe(4);
    expect(run.merged.map((r) => r.merged)).toEqual([['shared-1']]);
  });

  it('retries an unreadable file next time', async () => {
    await write(project, '{ half');
    const first = await merge();
    expect(first.unreadable).toHaveLength(1);
    expect(first.merged).toEqual([]);

    await write(project, JSON.stringify([row('fixed-1')]));

    expect((await merge()).merged[0]?.merged).toEqual(['fixed-1']);
  });

  it('does not run while no team is registered', async () => {
    await write(project, JSON.stringify([row('wait-1', { teamId: 'team-here' })]));

    const run = await merge([{ path: project }], new Set());

    expect(run).toMatchObject({ notRun: 'no team is registered yet', projectsExamined: 0, merged: [] });
    expect((await merge()).merged[0]?.merged).toEqual(['wait-1']);
  });
});
