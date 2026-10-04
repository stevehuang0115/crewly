/**
 * Tests for the goal replan's goal and experiment readers
 * (specs/2026-10-04-autopilot-goal-replan.md).
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Mission } from '../../types/v2/mission.types.js';
import type { Experiment } from '../../types/experiment.types.js';
import { GoalTrackingService } from '../memory/goal-tracking.service.js';
import {
  activeProjectMissions,
  combineGoal,
  goalChangedAt,
  goalFromGoalsLog,
  goalFromMissions,
  openExperimentsOf,
  readProjectGoal,
} from './ticket-autopilot-goal.js';

function mission(id: string, extra: Partial<Mission> = {}): Mission {
  return {
    id,
    objective: `Objective ${id}`,
    ownerTeamId: 't-ce',
    successCriteria: [],
    currentStrategy: '',
    activeProjectTaskIds: [],
    cadence: '',
    policy: {} as Mission['policy'],
    status: 'active',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    learnings: [],
    projectId: 'p-ce',
    ...extra,
  };
}

describe('goalFromGoalsLog', () => {
  it('is null for no file, a blank file or just the header', () => {
    expect(goalFromGoalsLog(null)).toBeNull();
    expect(goalFromGoalsLog('')).toBeNull();
    expect(goalFromGoalsLog('# Project Goals\n\n')).toBeNull();
    expect(goalFromGoalsLog('# Project Goals\n\n### [2026-10-01T00:00:00Z] Set by user\n\n')).toBeNull();
  });

  it('quotes the newest entries first, capped', () => {
    const raw = [
      '# Project Goals',
      '',
      '### [2026-09-01T10:00:00.000Z] Set by user',
      'Old goal',
      '',
      '### [2026-10-03T10:00:00.000Z] Set by owner',
      'By 11/16-11/29: 1,000 /feed visitors a week, 25% returning within a week.',
      '',
    ].join('\n');
    expect(goalFromGoalsLog(raw)).toBe('(2026-10-03, set by owner) By 11/16-11/29: 1,000 /feed visitors a week, 25% returning within a week.\n\n(2026-09-01, set by user) Old goal');
    expect(goalFromGoalsLog(raw, 1)).toBe('(2026-10-03, set by owner) By 11/16-11/29: 1,000 /feed visitors a week, 25% returning within a week.');
    expect(goalFromGoalsLog(raw, 3, 20)).toHaveLength(20);
  });

  it('only entries of the last 30 days are active (the log is append-only); undated ones use the file time', () => {
    const now = Date.parse('2026-10-03T12:00:00.000Z');
    const raw = ['# Project Goals', '', '### [2026-08-01T10:00:00.000Z] Set by owner', 'Met long ago', '', '### [2026-09-20T10:00:00.000Z] Set by owner', 'Feed growth', ''].join('\n');
    expect(goalFromGoalsLog(raw, 3, 2000, { now })).toBe('(2026-09-20, set by owner) Feed growth');
    expect(goalFromGoalsLog(raw, 3, 2000, { now: Date.parse('2026-11-01T00:00:00.000Z') })).toBeNull();
    const undated = '# Project Goals\n\n### Q4\nShip the feed\n';
    expect(goalFromGoalsLog(undated, 3, 2000, { now, fileMtimeMs: now - 40 * 86_400_000 })).toBeNull();
    expect(goalFromGoalsLog(undated, 3, 2000, { now, fileMtimeMs: now - 86_400_000 })).toBe('(Q4) Ship the feed');
    expect(goalFromGoalsLog('Grow the feed\n', 3, 2000, { now, fileMtimeMs: now - 40 * 86_400_000 })).toBeNull();
    expect(goalFromGoalsLog('Grow the feed\n', 3, 2000, { now, fileMtimeMs: null })).toBe('Grow the feed');
  });

  it('takes a hand-written file without entry headers as one goal', () => {
    expect(goalFromGoalsLog('# Goals\n\nGrow the feed to 1,000 weekly visitors.\n')).toBe('Grow the feed to 1,000 weekly visitors.');
  });
});

describe('active project OKRs', () => {
  it('keeps active, approved (or legacy) missions of the project only', () => {
    const list = activeProjectMissions(
      [
        mission('a', { priority: 'low' }),
        mission('b', { priority: 'critical', successCriteria: ['1,000 weekly visitors', '25% returning'] }),
        mission('c', { status: 'completed' }),
        mission('d', { projectId: 'other' }),
        mission('e', { approval: { state: 'pending_approval' } }),
        mission('f', { priority: 'medium', approval: { state: 'approved' } }),
        mission('a'),
      ],
      'p-ce',
    );
    expect(list.map((m) => m.id)).toEqual(['b', 'f', 'a']);
    expect(goalFromMissions(list.slice(0, 1))).toBe('OKR: Objective b\n- 1,000 weekly visitors\n- 25% returning');
    expect(goalFromMissions([])).toBeNull();
  });

  it('combines the goals log and the OKRs, or none', () => {
    expect(combineGoal(null, null)).toBeNull();
    expect(combineGoal('G', null)).toEqual({ text: 'G', sources: ['goals_log'] });
    expect(combineGoal('G', 'OKR: X')).toEqual({ text: 'G\n\nOKR: X', sources: ['goals_log', 'okr'] });
  });
});

describe('readProjectGoal', () => {
  let root: string;
  const prevMissions = process.env.CREWLY_MISSIONS_DIR;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-goal-'));
    process.env.CREWLY_MISSIONS_DIR = path.join(root, 'missions');
    GoalTrackingService.clearInstance();
  });

  afterEach(async () => {
    if (prevMissions === undefined) delete process.env.CREWLY_MISSIONS_DIR;
    else process.env.CREWLY_MISSIONS_DIR = prevMissions;
    GoalTrackingService.clearInstance();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is null for a project without goals or OKRs', async () => {
    const projectPath = path.join(root, 'ce');
    await fs.mkdir(projectPath, { recursive: true });
    expect(await readProjectGoal({ id: 'p-ce', name: 'CE', path: projectPath })).toBeNull();
  });

  it('reads the goals log and the active project OKRs', async () => {
    const projectPath = path.join(root, 'ce');
    await fs.mkdir(projectPath, { recursive: true });
    await GoalTrackingService.getInstance().setGoal(projectPath, '1,000 /feed visitors a week', 'owner');
    await fs.mkdir(path.join(root, 'missions'), { recursive: true });
    await fs.writeFile(path.join(root, 'missions', 'm1.json'), JSON.stringify(mission('m1', { objective: 'Feed growth' })));
    await fs.writeFile(path.join(root, 'missions', 'bad.json'), '{not json');
    const goal = await readProjectGoal({ id: 'p-ce', name: 'CE', path: projectPath });
    expect(goal?.sources).toEqual(['goals_log', 'okr']);
    expect(goal?.text).toContain('1,000 /feed visitors a week');
    expect(goal?.text).toContain('OKR: Feed growth');
    // 40 days later the log entry is history; the active OKR keeps its own status.
    const later = await readProjectGoal({ id: 'p-ce', name: 'CE', path: projectPath }, new Date(Date.now() + 40 * 86_400_000));
    expect(later?.sources).toEqual(['okr']);
  });

  it('goalChangedAt reads file times only: the goals log and the missions folders', async () => {
    const projectPath = path.join(root, 'ce');
    await fs.mkdir(projectPath, { recursive: true });
    expect(await goalChangedAt({ path: projectPath })).toBeNull();
    await GoalTrackingService.getInstance().setGoal(projectPath, 'G', 'owner');
    const first = await goalChangedAt({ path: projectPath });
    expect(first).toEqual(expect.any(Number));
    await fs.mkdir(path.join(root, 'missions'), { recursive: true });
    const past = new Date(Date.now() - 3_600_000);
    await fs.utimes(path.join(projectPath, '.crewly', 'goals', 'goals.md'), past, past);
    await fs.writeFile(path.join(root, 'missions', 'm2.json'), JSON.stringify(mission('m2')));
    expect((await goalChangedAt({ path: projectPath }))!).toBeGreaterThan(past.getTime());
  });
});

describe('openExperimentsOf', () => {
  const exp = (id: string, extra: Partial<Experiment>): Experiment =>
    ({ id, title: `Exp ${id}`, hypothesis: `H ${id}`, status: 'running', createdAt: `2026-10-0${id.slice(-1)}T00:00:00Z`, ...extra }) as Experiment;

  it('lists planned / running cards scoped to the project (autopilot scope or ticket link), newest first', () => {
    const project = { id: 'p-ce', name: 'CE', path: '/work/ce' };
    const list = openExperimentsOf(
      [
        exp('EXP-1', { autopilot: { projectId: 'p-ce' } as Experiment['autopilot'] }),
        exp('EXP-2', { status: 'done', autopilot: { projectId: 'p-ce' } as Experiment['autopilot'] }),
        exp('EXP-3', { status: 'planned', ticket: { kind: 'project', project: 'ce', id: 'CE-1' } }),
        exp('EXP-4', { ticket: { kind: 'project', project: 'other', id: 'X-1' } }),
        exp('EXP-5', { ticket: { kind: 'project', project: '/work/ce', id: 'CE-2' }, dueAt: '2026-11-30T00:00:00Z' }),
      ],
      project,
    );
    expect(list.map((e) => e.id)).toEqual(['EXP-5', 'EXP-3', 'EXP-1']);
    expect(list[0]).toEqual({ id: 'EXP-5', title: 'Exp EXP-5', hypothesis: 'H EXP-5', status: 'running', dueAt: '2026-11-30T00:00:00Z' });
  });
});
