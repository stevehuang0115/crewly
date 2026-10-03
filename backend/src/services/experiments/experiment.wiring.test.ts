/**
 * Tests for the experiment wiring (issue #986): ship detection from project
 * and harness tickets, ticket notes, the wiki vault choice and log write.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createExperimentDeps, doneTransitionAt, experimentVault, ticketShipState, type ExperimentWiringStores } from './experiment.wiring.js';
import { WikiIngestService } from '../wiki/wiki-ingest.service.js';
import type { Experiment } from '../../types/experiment.types.js';

/**
 * Fake stores.
 *
 * @param over - Overrides
 * @returns Stores
 */
function stores(over: Partial<ExperimentWiringStores> = {}): ExperimentWiringStores {
  return {
    resolveProjectPath: jest.fn(async (ref: string) => `/projects/${ref}`),
    getProjectTicket: jest.fn().mockResolvedValue(null),
    appendProjectTicketLog: jest.fn().mockResolvedValue(undefined),
    getRequest: jest.fn().mockResolvedValue(null),
    listRequests: jest.fn().mockResolvedValue([]),
    ...over,
  };
}

const EXP: Experiment = {
  id: 'EXP-1', traceId: 'exp:EXP-1', title: 'T', hypothesis: 'H', direction: 'increase', metric: { source: 'gsc', measure: 'clicks', config: '/c' },
  windowDays: 14, createdBy: 'ella', confidence: 0.6, status: 'done', createdAt: '', updatedAt: '', timeline: [],
};

describe('doneTransitionAt', () => {
  it('reads the last done transition from the ticket log, never a later note', () => {
    expect(doneTransitionAt([
      '2026-10-01T10:00:00.000Z · owner · created (ready)',
      '2026-10-02T09:00:00.000Z · ella · ready → in_progress',
      '2026-10-03T08:30:00.000Z · ella · in_progress → done — shipped',
      '2026-10-04T12:00:00.000Z · experiments · Experiment EXP-1: note',
    ])).toBe('2026-10-03T08:30:00.000Z');
    expect(doneTransitionAt(['2026-10-03T08:30:00.000Z · a · review → done', '2026-10-05T00:00:00.000Z · a · done → ready', '2026-10-06T00:00:00.000Z · a · review → done'])).toBe('2026-10-06T00:00:00.000Z');
    expect(doneTransitionAt(['2026-10-01T00:00:00.000Z · owner · created (done)'])).toBe('2026-10-01T00:00:00.000Z');
  });

  it('is null when the log has no done transition', () => {
    expect(doneTransitionAt(undefined)).toBeNull();
    expect(doneTransitionAt([])).toBeNull();
    expect(doneTransitionAt(['2026-10-01T00:00:00.000Z · a · done → ready', 'hand-written line about done'])).toBeNull();
    expect(doneTransitionAt(['not-a-date · a · review → done'])).toBeNull();
  });
});

describe('ticketShipState', () => {
  it('a project ticket ships when it is done, dated by its done transition (not updatedAt)', async () => {
    const s = stores({
      getProjectTicket: jest.fn()
        .mockResolvedValueOnce({ status: 'review', updatedAt: 'a', log: [] })
        .mockResolvedValueOnce({ status: 'done', updatedAt: '2026-10-09T00:00:00.000Z', log: ['2026-10-05T10:00:00.000Z · ella · review → done', '2026-10-09T00:00:00.000Z · experiments · note'] })
        .mockResolvedValueOnce({ status: 'done', updatedAt: '2026-10-09T00:00:00.000Z', log: ['hand edited'] }),
    });
    const link = { kind: 'project' as const, project: 'ce', id: 'T-1' };
    expect(await ticketShipState(s, link)).toEqual({ done: false });
    expect(await ticketShipState(s, link)).toEqual({ done: true, at: '2026-10-05T10:00:00.000Z' });
    expect(await ticketShipState(s, link)).toEqual({ done: true, at: null });
    expect(s.getProjectTicket).toHaveBeenCalledWith('/projects/ce', 'T-1');
  });

  it('a harness ticket ships when done (by id or TKT number), at completedAt only', async () => {
    const s = stores({ getRequest: jest.fn().mockResolvedValue({ status: 'done', updatedAt: 'u', completedAt: 'c' }) });
    expect(await ticketShipState(s, { kind: 'harness', id: 'req-1' })).toEqual({ done: true, at: 'c' });
    const byNumber = stores({ listRequests: jest.fn().mockResolvedValue([{ status: 'done', updatedAt: 'u', ticketNumber: 40 }, { status: 'open', updatedAt: 'x', ticketNumber: 41 }]) });
    expect(await ticketShipState(byNumber, { kind: 'harness', id: 'TKT-40' })).toEqual({ done: true, at: null });
    expect(await ticketShipState(byNumber, { kind: 'harness', id: 'TKT-41' })).toEqual({ done: false });
    expect(await ticketShipState(byNumber, { kind: 'harness', id: 'nothing' })).toEqual({ done: false });
  });
});

describe('experimentVault / deps', () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'expw-'));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('prefers the project wiki, then the global wiki, else none', async () => {
    const project = path.join(home, 'ce');
    const s = stores({ resolveProjectPath: jest.fn().mockResolvedValue(project) });
    const onProject = { ...EXP, ticket: { kind: 'project' as const, project: 'ce', id: 'T-1' } };
    expect(await experimentVault(s, onProject, home)).toBeNull();
    await fs.mkdir(path.join(home, 'global-wiki'), { recursive: true });
    await fs.writeFile(path.join(home, 'global-wiki', 'SCHEMA.md'), 'x');
    expect(await experimentVault(s, onProject, home)).toBe(path.join(home, 'global-wiki'));
    await fs.mkdir(path.join(project, '.crewly', 'wiki'), { recursive: true });
    await fs.writeFile(path.join(project, '.crewly', 'wiki', 'SCHEMA.md'), 'x');
    expect(await experimentVault(s, onProject, home)).toBe(path.join(project, '.crewly', 'wiki'));
    const gone = stores({ resolveProjectPath: jest.fn().mockRejectedValue(new Error('404')) });
    expect(await experimentVault(gone, onProject, home)).toBe(path.join(home, 'global-wiki'));
  });

  it('writes the result to the experiment log page and notes on project tickets only', async () => {
    const s = stores();
    const deps = createExperimentDeps(s, async () => true, { home, packageRoot: '/pkg' });
    expect(deps.storeFile).toBe(path.join(home, 'experiments.json'));
    expect(await deps.writeLog!(EXP, 'entry')).toBe(false);

    await fs.mkdir(path.join(home, 'global-wiki'), { recursive: true });
    await fs.writeFile(path.join(home, 'global-wiki', 'SCHEMA.md'), 'x');
    const ingest = jest.spyOn(WikiIngestService.prototype, 'ingest').mockResolvedValue({ ok: true } as never);
    expect(await deps.writeLog!(EXP, 'entry')).toBe(true);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      vaultPath: path.join(home, 'global-wiki'), sourceType: 'experiment', sourceRef: 'exp:EXP-1', sourceBody: 'entry', callerSession: 'ella', targetRelativePath: 'llm-curated/experiments/log.md',
    }));

    await deps.noteOnTicket!({ kind: 'harness', id: 'TKT-1' }, 'n');
    expect(s.appendProjectTicketLog).not.toHaveBeenCalled();
    await deps.noteOnTicket!({ kind: 'project', project: 'ce', id: 'T-1' }, 'n');
    expect(s.appendProjectTicketLog).toHaveBeenCalledWith('/projects/ce', 'T-1', 'n');

    expect(await deps.fileExists!(path.join(home, 'global-wiki', 'SCHEMA.md'))).toBe(true);
    expect(await deps.fileExists!(path.join(home, 'nope'))).toBe(false);
    expect(await deps.ticketShipState!({ kind: 'harness', id: 'x' })).toEqual({ done: false });
  });
});
