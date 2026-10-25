/**
 * Correction ladder tests (#810): first occurrence → no WorkItem; second →
 * exactly one for the team lead; third while open → no duplicate; decide
 * closes it; a prose decision that did not hold is raised again.
 *
 * @module services/memory/correction-ladder.service.test
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  CorrectionLadderService,
  normalizeCorrectionClass,
  isCorrectionRung,
  correctionLadderPath,
  occurrencesSinceDecision,
  buildCorrectionWorkItem,
  type CorrectionClassRecord,
} from './correction-ladder.service.js';
import type { WorkItem } from '../../types/v2/work-item.types.js';
import { CORRECTION_LADDER_CONSTANTS, ORCHESTRATOR_SESSION_NAME } from '../../constants.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    }),
  },
}));

describe('correction ladder helpers', () => {
  it('normalizes classes to slugs', () => {
    expect(normalizeCorrectionClass(' Git Add -A!! ')).toBe('git-add-a');
    expect(normalizeCorrectionClass('skip__tests--before PR')).toBe('skip-tests-before-pr');
    expect(normalizeCorrectionClass('x'.repeat(80))).toHaveLength(CORRECTION_LADDER_CONSTANTS.CLASS_MAX_CHARS);
    expect(normalizeCorrectionClass('!!!')).toBeNull();
    expect(normalizeCorrectionClass('a')).toBeNull();
    expect(normalizeCorrectionClass(42)).toBeNull();
  });

  it('knows the rungs', () => {
    for (const r of ['structural', 'check', 'hook', 'prose']) expect(isCorrectionRung(r)).toBe(true);
    expect(isCorrectionRung('vibes')).toBe(false);
    expect(isCorrectionRung(undefined)).toBe(false);
  });

  it('puts the store under the project data dir', () => {
    expect(correctionLadderPath('/repo')).toBe(path.join('/repo', '.crewly', CORRECTION_LADDER_CONSTANTS.STORE_FILE));
  });

  it('counts occurrences after the decision only', () => {
    const base: CorrectionClassRecord = {
      class: 'c',
      count: 3,
      firstAt: '2026-10-01T00:00:00.000Z',
      lastAt: '2026-10-03T00:00:00.000Z',
      occurrences: [
        { at: '2026-10-01T00:00:00.000Z', agentId: 'a', source: 'learning', text: 'x' },
        { at: '2026-10-02T00:00:00.000Z', agentId: 'a', source: 'learning', text: 'x' },
        { at: '2026-10-03T00:00:00.000Z', agentId: 'a', source: 'learning', text: 'x' },
      ],
      workItemId: null,
      workItemAt: null,
      decision: null,
      previousDecisions: [],
    };
    expect(occurrencesSinceDecision(base)).toBe(3);
    expect(occurrencesSinceDecision({ ...base, decision: { rung: 'prose', reason: 'r', decidedBy: 'tl', decidedAt: '2026-10-02T12:00:00.000Z' } })).toBe(1);
  });

  it('builds a lead WorkItem with the four rungs and the decide command', () => {
    const record: CorrectionClassRecord = {
      class: 'git-add-all',
      count: 2,
      firstAt: '2026-10-01T00:00:00.000Z',
      lastAt: '2026-10-02T00:00:00.000Z',
      occurrences: [
        { at: '2026-10-01T00:00:00.000Z', agentId: 'dev-1', source: 'learning', text: '[[git]] never git add -A', relatedTask: 'CREW-1' },
        { at: '2026-10-02T00:00:00.000Z', agentId: 'dev-2', source: 'failure', text: 'staged .env again' },
      ],
      workItemId: null,
      workItemAt: null,
      decision: null,
      previousDecisions: [],
    };
    const wi = buildCorrectionWorkItem(record, '/repo', 'tl-session', false);
    expect(wi.type).toBe('delegate');
    expect(wi.owner).toBe('team_lead');
    expect(wi.target).toBe('tl-session');
    expect(wi.title).toBe('Correction ladder: "git-add-all" came back (2×)');
    for (const rung of ['**structural**', '**check**', '**hook**', '**prose**']) expect(wi.briefMarkdown).toContain(rung);
    expect(wi.briefMarkdown).toContain('decide-correction/execute.sh --project "/repo" --class git-add-all');
    expect(wi.briefMarkdown).toContain('dev-1 · learning · CREW-1: [[git]] never git add -A');
    expect(wi.metadata).toMatchObject({ kind: 'correction-ladder', correctionClass: 'git-add-all', count: 2, again: false });

    const orc = buildCorrectionWorkItem(record, '/repo', ORCHESTRATOR_SESSION_NAME, false);
    expect(orc.owner).toBe('orchestrator');
  });
});

describe('CorrectionLadderService', () => {
  let dir: string;
  let added: WorkItem[];
  let now: number;
  const pool = { addToPool: jest.fn<(wi: WorkItem) => Promise<void>>(async (wi) => void added.push(wi)) };
  const awake = jest.fn<(s: string) => Promise<boolean>>(async () => true);
  const resolveTarget = jest.fn<(p: string) => Promise<string | null>>(async () => 'tl-session');

  const make = (): CorrectionLadderService => new CorrectionLadderService({ pool, resolveTarget, isTargetAwake: awake, now: () => now });
  const rec = (service: CorrectionLadderService, cls = 'git-add-all', text = 'never git add -A') =>
    service.record({ projectPath: dir, correctionClass: cls, agentId: 'dev-1', text, source: 'learning' });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-ladder-'));
    added = [];
    now = Date.parse('2026-10-25T10:00:00.000Z');
    pool.addToPool.mockClear();
    awake.mockClear();
    resolveTarget.mockClear();
    CorrectionLadderService.setInstance(null);
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('first occurrence records, second raises one WorkItem, third while open does not duplicate', async () => {
    const service = make();
    const first = await rec(service);
    expect(first.raised).toBe(false);
    expect(first.skipped).toBe('below_threshold');
    expect(first.record.count).toBe(1);
    expect(added).toHaveLength(0);

    now += 60_000;
    const second = await rec(service, ' Git Add ALL!! ', 'staged .env again');
    expect(second.raised).toBe(true);
    expect(second.target).toBe('tl-session');
    expect(second.record.class).toBe('git-add-all');
    expect(added).toHaveLength(1);
    expect(added[0]!.title).toContain('"git-add-all" came back (2×)');
    expect(second.record.workItemId).toBe(added[0]!.id);

    now += 60_000;
    const third = await rec(service);
    expect(third.raised).toBe(false);
    expect(third.skipped).toBe('already_raised');
    expect(third.record.count).toBe(3);
    expect(added).toHaveLength(1);

    const stored = JSON.parse(await fs.readFile(correctionLadderPath(dir), 'utf8'));
    expect(stored.classes['git-add-all'].count).toBe(3);
    expect(stored.classes['git-add-all'].occurrences).toHaveLength(3);
  });

  it('classes are independent and listed most-recorded first', async () => {
    const service = make();
    await rec(service, 'a-class');
    await rec(service, 'b-class');
    await rec(service, 'b-class');
    const list = await service.list(dir);
    expect(list.map((r) => [r.class, r.count])).toEqual([
      ['b-class', 2],
      ['a-class', 1],
    ]);
    expect(added).toHaveLength(1);
  });

  it('decide needs a known class, a rung and a reason, then closes the ladder', async () => {
    const service = make();
    await rec(service);
    await rec(service);
    await expect(service.decide({ projectPath: dir, correctionClass: 'nope', rung: 'check', reason: 'r', decidedBy: 'tl' })).rejects.toThrow('No correction class "nope"');
    await expect(service.decide({ projectPath: dir, correctionClass: 'git-add-all', rung: 'vibes', reason: 'r', decidedBy: 'tl' })).rejects.toThrow('Unknown rung');
    await expect(service.decide({ projectPath: dir, correctionClass: 'git-add-all', rung: 'check', reason: '  ', decidedBy: 'tl' })).rejects.toThrow('needs a reason');

    const decided = await service.decide({ projectPath: dir, correctionClass: 'git-add-all', rung: 'check', reason: 'test greps scripts', link: 'PR #1', decidedBy: 'tl' });
    expect(decided.decision).toMatchObject({ rung: 'check', reason: 'test greps scripts', link: 'PR #1', decidedBy: 'tl' });
    expect(decided.workItemId).toBeNull();

    // A decided class (not prose) never raises again, however often it is recorded.
    const later = await rec(service);
    expect(later.raised).toBe(false);
    expect(later.skipped).toBe('decided');
    await rec(service);
    expect(added).toHaveLength(1);
  });

  it('a prose decision that did not hold is raised again with the earlier reason', async () => {
    const service = make();
    await rec(service);
    await rec(service);
    await service.decide({ projectPath: dir, correctionClass: 'git-add-all', rung: 'prose', reason: 'rare, not worth a hook', decidedBy: 'tl' });

    now += 60_000;
    const one = await rec(service);
    expect(one.raised).toBe(false);
    expect(one.skipped).toBe('below_threshold');

    now += 60_000;
    const two = await rec(service);
    expect(two.raised).toBe(true);
    expect(added).toHaveLength(2);
    expect(added[1]!.title).toContain('prose did not hold');
    expect(added[1]!.briefMarkdown).toContain('"rare, not worth a hook"');
    expect(two.record.decision).toBeNull();
    expect(two.record.previousDecisions).toHaveLength(1);
  });

  it('does not wake a dormant lead, falls back to the orchestrator without a lead, and records without a pool', async () => {
    const service = make();
    await rec(service);
    awake.mockResolvedValueOnce(false);
    const dormant = await rec(service);
    expect(dormant.raised).toBe(false);
    expect(dormant.skipped).toBe('target_dormant');
    expect(added).toHaveLength(0);
    // The next occurrence tries again.
    const third = await rec(service);
    expect(third.raised).toBe(true);

    resolveTarget.mockResolvedValueOnce(null);
    await rec(service, 'other');
    const orc = await rec(service, 'other');
    expect(orc.target).toBe(ORCHESTRATOR_SESSION_NAME);
    expect(added[1]!.owner).toBe('orchestrator');

    const unwired = new CorrectionLadderService({ now: () => now });
    await unwired.record({ projectPath: dir, correctionClass: 'solo', agentId: 'a', text: 't', source: 'manual' });
    const r = await unwired.record({ projectPath: dir, correctionClass: 'solo', agentId: 'a', text: 't', source: 'manual' });
    expect(r.skipped).toBe('no_pool');
  });

  it('raises again when an undecided WorkItem is older than the reopen window', async () => {
    const service = make();
    await rec(service);
    await rec(service);
    expect(added).toHaveLength(1);
    now += CORRECTION_LADDER_CONSTANTS.REOPEN_AFTER_MS + 1;
    const again = await rec(service);
    expect(again.raised).toBe(true);
    expect(added).toHaveLength(2);
  });

  it('refuses an empty class or text', async () => {
    const service = make();
    await expect(rec(service, '???')).rejects.toThrow('no letters or digits');
    await expect(rec(service, 'ok-class', '   ')).rejects.toThrow('needs the text');
  });

  it('getInstance returns an unwired singleton until setInstance', () => {
    const a = CorrectionLadderService.getInstance();
    expect(CorrectionLadderService.getInstance()).toBe(a);
    const wired = make();
    CorrectionLadderService.setInstance(wired);
    expect(CorrectionLadderService.getInstance()).toBe(wired);
  });
});
