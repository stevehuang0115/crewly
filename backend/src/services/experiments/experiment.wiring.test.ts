/**
 * Tests for the experiment wiring (issue #986): ship detection from project
 * and harness tickets, ticket notes, the wiki vault choice and log write.
 */
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createExperimentDeps, experimentVault, ticketShippedAt, type ExperimentWiringStores } from './experiment.wiring.js';
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

describe('ticketShippedAt', () => {
  it('a project ticket ships when it is done', async () => {
    const s = stores({ getProjectTicket: jest.fn().mockResolvedValueOnce({ status: 'review', updatedAt: 'a' }).mockResolvedValueOnce({ status: 'done', updatedAt: 'b' }) });
    const link = { kind: 'project' as const, project: 'ce', id: 'T-1' };
    expect(await ticketShippedAt(s, link)).toBeNull();
    expect(await ticketShippedAt(s, link)).toBe('b');
    expect(s.getProjectTicket).toHaveBeenCalledWith('/projects/ce', 'T-1');
  });

  it('a harness ticket ships when done (by id or TKT number), at completedAt', async () => {
    const s = stores({ getRequest: jest.fn().mockResolvedValue({ status: 'done', updatedAt: 'u', completedAt: 'c' }) });
    expect(await ticketShippedAt(s, { kind: 'harness', id: 'req-1' })).toBe('c');
    const byNumber = stores({ listRequests: jest.fn().mockResolvedValue([{ status: 'done', updatedAt: 'u', ticketNumber: 40 }, { status: 'open', updatedAt: 'x', ticketNumber: 41 }]) });
    expect(await ticketShippedAt(byNumber, { kind: 'harness', id: 'TKT-40' })).toBe('u');
    expect(await ticketShippedAt(byNumber, { kind: 'harness', id: 'TKT-41' })).toBeNull();
    expect(await ticketShippedAt(byNumber, { kind: 'harness', id: 'nothing' })).toBeNull();
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
    expect(await deps.ticketShippedAt!({ kind: 'harness', id: 'x' })).toBeNull();
  });
});
