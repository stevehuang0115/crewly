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
  experimentClosedAt,
  experimentsClosedOn,
  goalChangedAt,
  goalFromGoalsLog,
  goalFromMissions,
  goalsCompletedOn,
  localDayOf,
  openExperimentsOf,
  readProjectGoal,
  readRetroMilestones,
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

describe('retro milestones (#985): cards closed and OKRs completed on the reviewed day', () => {
  const project = { id: 'p-ce', name: 'CE', path: '/work/ce' };
  // Local-time stamps (no zone) so the day is the same in every zone the tests run in.
  const exp = (id: string, extra: Partial<Experiment>): Experiment =>
    ({
      id,
      title: `Exp ${id}`,
      hypothesis: `H ${id}`,
      status: 'done',
      createdAt: '2026-10-20T12:00:00',
      updatedAt: '2026-10-25T12:00:00',
      metric: { source: 'ga4', measure: 'sessions', config: '/c.json', page: '/feed' },
      timeline: [],
      autopilot: { projectId: 'p-ce' } as Experiment['autopilot'],
      ...extra,
    }) as Experiment;

  it('localDayOf maps a timestamp to its local day and junk to no day', () => {
    expect(localDayOf('2026-10-25T12:00:00')).toBe('2026-10-25');
    expect(localDayOf('nope')).toBe('');
  });

  it('a card closed on the day: its last measured / cancelled event, else updatedAt', () => {
    const measured = exp('EXP-1', {
      timeline: [
        { at: '2026-10-11T12:00:00', event: 'shipped' },
        { at: '2026-10-25T09:00:00', event: 'measured', detail: 'worked' },
        { at: '2026-10-25T09:00:01', event: 'reported' },
      ],
    });
    expect(experimentClosedAt(measured)).toBe('2026-10-25T09:00:00');
    expect(experimentClosedAt(exp('EXP-2', { updatedAt: '2026-10-24T12:00:00' }))).toBe('2026-10-24T12:00:00');
    expect(experimentClosedAt(exp('EXP-3', { updatedAt: '', timeline: undefined as unknown as Experiment['timeline'] }))).toBeNull();
  });

  it('lists the project\'s cards measured or cancelled that day with verdict, outcome and process, oldest first', () => {
    const procNumbers = {
      range: { start: '2026-10-11', end: '2026-10-24' },
      ticketsStarted: 8,
      ticketsDone: 7,
      ticketsShipped: 6,
      ownerTouches: 3,
      ownerTouchesPerTicket: 0.5,
      stalls: 2,
      stallMs: 3_600_000,
      interventions: 1,
      tokens: 1_000_000,
      costUsd: 48,
      costPerShippedTicket: 8,
      pausedMs: 0,
    };
    const list = experimentsClosedOn(
      [
        exp('EXP-1', {
          timeline: [{ at: '2026-10-25T15:00:00', event: 'measured' }],
          verdict: 'worked',
          verdictReason: 'sessions 120 → 180',
          baseline: { start: '2026-10-01', end: '2026-10-10', total: 120, volume: 120, days: [], fetchedAt: 'x' },
          result: { start: '2026-10-11', end: '2026-10-24', total: 180, volume: 180, days: [], fetchedAt: 'x' },
          autopilot: { projectId: 'p-ce', processResult: procNumbers } as unknown as Experiment['autopilot'],
        }),
        exp('EXP-2', { status: 'cancelled', timeline: [{ at: '2026-10-25T08:00:00', event: 'cancelled', detail: 'by owner' }] }),
        exp('EXP-3', { status: 'running' }), // still open
        exp('EXP-4', { updatedAt: '2026-10-24T12:00:00' }), // closed the day before
        exp('EXP-5', { autopilot: undefined, ticket: { kind: 'project', project: 'other', id: 'X-1' } }), // another project
        exp('EXP-6', { autopilot: undefined, ticket: { kind: 'project', project: '/work/ce', id: 'CE-9' } }), // ticket link names the project
      ],
      project,
      '2026-10-25',
    );
    expect(list.map((m) => m.id)).toEqual(['EXP-2', 'EXP-6', 'EXP-1']);
    expect(list[2]).toEqual({
      kind: 'experiment_closed',
      id: 'EXP-1',
      title: 'Exp EXP-1',
      status: 'done',
      closedAt: '2026-10-25T15:00:00',
      hypothesis: 'H EXP-1',
      verdict: 'worked',
      verdictReason: 'sessions 120 → 180',
      outcome: { metric: 'ga4:sessions /feed', baseline: 120, result: 180 },
      process: { result: procNumbers },
    });
    expect(list[0]).toMatchObject({ id: 'EXP-2', status: 'cancelled' });
    expect(list[0].outcome).toBeUndefined();
    expect(list[0].process).toBeUndefined();
  });

  it('lists the project\'s OKRs completed that day (completed status, last written that day)', () => {
    const list = goalsCompletedOn(
      [
        mission('m1', { status: 'completed', updatedAt: '2026-10-25T16:00:00', objective: ' Feed growth ', successCriteria: ['+50% sessions', '', ' 3 posts a week '] }),
        mission('m1', { status: 'completed', updatedAt: '2026-10-25T16:00:00' }), // duplicate id (shared store copy)
        mission('m2', { status: 'completed', updatedAt: '2026-10-24T16:00:00' }), // the day before
        mission('m3', { status: 'active', updatedAt: '2026-10-25T16:00:00' }),
        mission('m4', { status: 'completed', updatedAt: '2026-10-25T10:00:00', projectId: 'p-other' }),
        mission('m5', { status: 'completed', updatedAt: '2026-10-25T09:00:00', successCriteria: [] }),
      ],
      'p-ce',
      '2026-10-25',
    );
    expect(list).toEqual([
      { kind: 'goal_completed', id: 'm5', title: 'Objective m5', status: 'completed', closedAt: '2026-10-25T09:00:00' },
      { kind: 'goal_completed', id: 'm1', title: 'Feed growth', status: 'completed', closedAt: '2026-10-25T16:00:00', criteria: ['+50% sessions', '3 posts a week'] },
    ]);
  });

  it('readRetroMilestones: cards first, then the goals from the missions store, capped; never throws', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-retro-ms-'));
    const prev = process.env.CREWLY_MISSIONS_DIR;
    process.env.CREWLY_MISSIONS_DIR = path.join(root, 'missions');
    try {
      await fs.mkdir(path.join(root, 'missions'), { recursive: true });
      await fs.writeFile(path.join(root, 'missions', 'm1.json'), JSON.stringify(mission('m1', { status: 'completed', updatedAt: '2026-10-25T16:00:00' })));
      await fs.writeFile(path.join(root, 'missions', 'bad.json'), '{not json');
      const cards = [exp('EXP-1', {}), exp('EXP-2', { timeline: [{ at: '2026-10-25T13:00:00', event: 'measured' }] })];
      const all = await readRetroMilestones({ ...project, path: root }, '2026-10-25', cards);
      expect(all.map((m) => m.id)).toEqual(['EXP-1', 'EXP-2', 'm1']);
      expect(await readRetroMilestones({ ...project, path: root }, '2026-10-25', cards, 2)).toHaveLength(2);
      expect(await readRetroMilestones({ ...project, path: root }, '2026-10-26', cards)).toEqual([]);
      // No missions folder at all: the cards alone.
      process.env.CREWLY_MISSIONS_DIR = path.join(root, 'missing');
      expect((await readRetroMilestones({ ...project, path: path.join(root, 'nowhere') }, '2026-10-25', cards)).map((m) => m.id)).toEqual(['EXP-1', 'EXP-2']);
    } finally {
      if (prev === undefined) delete process.env.CREWLY_MISSIONS_DIR;
      else process.env.CREWLY_MISSIONS_DIR = prev;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
