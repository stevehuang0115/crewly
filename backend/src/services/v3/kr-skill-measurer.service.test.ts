/**
 * Tests for KRSkillMeasurerService — skill resolution, JSON extraction,
 * dedup and failure isolation.
 *
 * @module services/v3/kr-skill-measurer.service.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  KRSkillMeasurerService,
  readJsonPath,
  coerceMeasurement,
  type SkillRunner,
} from './kr-skill-measurer.service.js';
import type { KRTrackingService } from './kr-tracking.service.js';
import type { KeyResult } from '../../types/v2/key-result.types.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }),
    }),
  },
}));

function kr(overrides: Partial<KeyResult> = {}): KeyResult {
  return {
    id: 'kr-1',
    missionId: 'm-1',
    title: 'Tickets in review',
    metricType: 'number',
    baseline: 6,
    target: 2,
    current: 6,
    unit: 'tickets',
    status: 'not_started',
    measurementSource: 'skill_output',
    measurementConfig: { skill: 'ticket-count', args: { status: 'review' }, jsonPath: '.count' },
    linkedWorkItemIds: [],
    measurements: [],
    createdAt: 'x',
    updatedAt: 'x',
    ...overrides,
  } as KeyResult;
}

let root: string;
let runner: jest.MockedFunction<SkillRunner>;
let tracking: { listByMission: jest.Mock; recordMeasurement: jest.Mock };
let service: KRSkillMeasurerService;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-skill-'));
  fs.mkdirSync(path.join(root, 'ticket-count'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ticket-count', 'execute.sh'), '#!/bin/bash\necho "{}"\n');
  runner = jest.fn().mockResolvedValue('{"count": 4, "nested": {"n": "7"}}');
  tracking = {
    listByMission: jest.fn().mockResolvedValue([kr()]),
    recordMeasurement: jest.fn().mockResolvedValue({ id: 'meas' }),
  };
  service = new KRSkillMeasurerService({
    skillRoots: [root],
    runner,
    krTracking: tracking as unknown as KRTrackingService,
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('helpers', () => {
  it('readJsonPath walks dot paths with or without a leading dot', () => {
    const doc = { a: { b: { c: 3 } }, count: 4 };
    expect(readJsonPath(doc, '.a.b.c')).toBe(3);
    expect(readJsonPath(doc, 'count')).toBe(4);
    expect(readJsonPath(doc, '.a.x.y')).toBeUndefined();
    expect(readJsonPath(null, '.a')).toBeUndefined();
  });

  it('coerceMeasurement accepts numbers, booleans and numeric strings only', () => {
    expect(coerceMeasurement(4)).toBe(4);
    expect(coerceMeasurement(true)).toBe(1);
    expect(coerceMeasurement('7')).toBe(7);
    expect(coerceMeasurement('seven')).toBeUndefined();
    expect(coerceMeasurement(NaN)).toBeUndefined();
    expect(coerceMeasurement({})).toBeUndefined();
  });
});

describe('resolveSkill', () => {
  it('finds a bare name under a known root and refuses paths', () => {
    expect(service.resolveSkill('ticket-count')).toBe(path.join(root, 'ticket-count', 'execute.sh'));
    expect(service.resolveSkill('../ticket-count')).toBeNull();
    expect(service.resolveSkill('/etc/passwd')).toBeNull();
    expect(service.resolveSkill('Ticket Count')).toBeNull();
    expect(service.resolveSkill('missing')).toBeNull();
  });
});

describe('measureMission', () => {
  it('runs the skill with JSON args, reads jsonPath and records the value', async () => {
    const out = await service.measureMission('m-1');
    expect(out).toEqual([{ krId: 'kr-1', status: 'recorded', value: 4 }]);
    expect(runner).toHaveBeenCalledWith(
      path.join(root, 'ticket-count', 'execute.sh'),
      '{"status":"review"}',
      expect.any(Number),
    );
    expect(tracking.recordMeasurement).toHaveBeenCalledWith('m-1', 'kr-1', 4, 'skill_output', 'skill ticket-count');
  });

  it('tolerates a log line before the JSON and numeric strings at nested paths', async () => {
    runner.mockResolvedValue('fetching…\n{"nested":{"n":"7"}}');
    tracking.listByMission.mockResolvedValue([kr({ measurementConfig: { skill: 'ticket-count', jsonPath: '.nested.n' } })]);
    const out = await service.measureMission('m-1');
    expect(out[0]).toEqual({ krId: 'kr-1', status: 'recorded', value: 7 });
  });

  it('does not re-record an unchanged value once a measurement exists', async () => {
    tracking.listByMission.mockResolvedValue([kr({ current: 4, measurements: [{ id: 'x' } as never] })]);
    const out = await service.measureMission('m-1');
    expect(out[0]).toMatchObject({ status: 'unchanged', value: 4 });
    expect(tracking.recordMeasurement).not.toHaveBeenCalled();
  });

  it('skips KRs that are not skill_output and ones without a skill', async () => {
    tracking.listByMission.mockResolvedValue([
      kr({ id: 'manual', measurementSource: 'manual' }),
      kr({ id: 'noskill', measurementConfig: { jsonPath: '.x' } }),
    ]);
    const out = await service.measureMission('m-1');
    expect(out).toEqual([{ krId: 'noskill', status: 'skipped', reason: 'measurementConfig.skill missing' }]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('reports failures per KR without throwing: unknown skill, runner error, non-JSON, missing number', async () => {
    tracking.listByMission.mockResolvedValue([
      kr({ id: 'a', measurementConfig: { skill: 'nope' } }),
      kr({ id: 'b' }),
      kr({ id: 'c' }),
      kr({ id: 'd', measurementConfig: { skill: 'ticket-count', jsonPath: '.missing' } }),
    ]);
    runner
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('not json at all')
      .mockResolvedValueOnce('{"count":1}');
    const out = await service.measureMission('m-1');
    expect(out.map((o) => [o.krId, o.status])).toEqual([
      ['a', 'failed'],
      ['b', 'failed'],
      ['c', 'failed'],
      ['d', 'failed'],
    ]);
    expect(out[0].reason).toContain('skill not found');
    expect(out[1].reason).toBe('timeout');
    expect(out[2].reason).toContain('not JSON');
    expect(out[3].reason).toContain('.missing');
    expect(tracking.recordMeasurement).not.toHaveBeenCalled();
  });

  it('returns [] when the KR list cannot be read', async () => {
    tracking.listByMission.mockRejectedValue(new Error('disk'));
    expect(await service.measureMission('m-1')).toEqual([]);
  });
});
