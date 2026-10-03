/**
 * Tests for the usage ledger backfill.
 * specs/2026-10-03-usage-ledger-durability.md §Backfill
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runUsageBackfill, UsageBackfillError, type AttributedTranscript } from './usage-backfill.service.js';
import { TokenUsageService } from '../monitoring/token-usage.service.js';

/** One assistant transcript line with the usage block Claude Code writes. */
function line(id: string, timestamp: string, input = 100, output = 50, cacheRead = 0, cacheWrite = 0): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    message: { id, model: 'claude-opus-5', usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite } },
  });
}

/** UTC day (the tests do not depend on the machine's time zone). */
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

describe('runUsageBackfill', () => {
  let dir: string;
  let ledger: TokenUsageService;
  let transcripts: AttributedTranscript[];
  const deps = () => ({ ledger, transcripts: async () => transcripts, dayOf: utcDay });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-backfill-'));
    ledger = new TokenUsageService(path.join(dir, 'crewly'));
    await ledger.loadFromDisk();
    transcripts = [];
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function transcript(name: string, lines: string[]): Promise<{ file: string; size: number }> {
    const file = path.join(dir, `${name}.jsonl`);
    const text = lines.map((l) => `${l}\n`).join('');
    await fs.writeFile(file, text);
    return { file, size: Buffer.byteLength(text) };
  }

  it('is a dry run by default: reports what it would add and changes nothing', async () => {
    const t = await transcript('a', [line('m1', '2026-09-20T10:00:00.000Z'), line('m2', '2026-09-21T10:00:00.000Z')]);
    transcripts = [{ sessionName: 'dev-1', filePath: t.file, offset: t.size }];

    const report = await runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-10-02' });

    expect(report).toMatchObject({ dryRun: true, added: 2, alreadyPresent: 0, sessions: { 'dev-1': 2 }, transcriptsRead: 1 });
    expect(report.days).toEqual({ '2026-09-20': { transcripts: 1, ledgerFiles: 0 }, '2026-09-21': { transcripts: 1, ledgerFiles: 0 } });
    expect(ledger.getSessionCount()).toBe(0);
    await expect(fs.access(path.join(dir, 'crewly', 'token-usage.json'))).rejects.toThrow();
  });

  it('adds the missing turns, exactly like the live sync would have recorded them, and flushes', async () => {
    const t = await transcript('a', [line('m1', '2026-09-20T10:00:00.000Z', 10, 5, 900, 100)]);
    transcripts = [{ sessionName: 'dev-1', filePath: t.file, offset: t.size }];

    const report = await runUsageBackfill(deps(), { from: '2026-09-20', to: '2026-09-20', dryRun: false });

    expect(report.added).toBe(1);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'crewly', 'token-usage.json'), 'utf-8'));
    expect(saved[0].events[0]).toEqual({
      timestamp: '2026-09-20T10:00:00.000Z', agentId: 'dev-1', input: 10, output: 5, model: 'claude-opus-5',
      cachedInput: 1000, cacheWrite: 100, messageId: 'm1',
    });
  });

  it('never double counts: skips turns already in the ledger (any session), repeated ids, and a second run', async () => {
    // Already in the ledger without a message id (recorded before ids were kept), in another session.
    ledger.recordUsage('someone-else', 'someone-else', 100, 50, 'claude-opus-5', undefined, { timestamp: '2026-09-20T10:00:00.000Z', cachedInput: 0 });
    const t = await transcript('a', [
      line('m1', '2026-09-20T10:00:00.000Z'),
      line('m2', '2026-09-20T11:00:00.000Z'),
      line('m2', '2026-09-20T11:00:00.500Z'), // Claude Code rewrote the same message
    ]);
    transcripts = [{ sessionName: 'dev-1', filePath: t.file, offset: t.size }];

    const first = await runUsageBackfill(deps(), { from: '2026-09-20', to: '2026-09-20', dryRun: false });
    expect(first).toMatchObject({ added: 1, alreadyPresent: 1 });

    const second = await runUsageBackfill(deps(), { from: '2026-09-20', to: '2026-09-20', dryRun: false });
    expect(second).toMatchObject({ added: 0, alreadyPresent: 2 });
    expect(ledger.getUsageByAgent('dev-1').eventCount).toBe(1);
  });

  it('reads a transcript only up to the offset the live sync consumed', async () => {
    const consumed = `${line('m1', '2026-09-20T10:00:00.000Z')}\n`;
    const t = await transcript('a', [line('m1', '2026-09-20T10:00:00.000Z'), line('m2', '2026-09-20T10:05:00.000Z')]);
    transcripts = [{ sessionName: 'dev-1', filePath: t.file, offset: Buffer.byteLength(consumed) }];

    const report = await runUsageBackfill(deps(), { from: '2026-09-20', to: '2026-09-20' });
    expect(report.added).toBe(1);
  });

  it('only counts days in the range', async () => {
    const t = await transcript('a', [line('m1', '2026-08-31T23:59:59.000Z'), line('m2', '2026-09-01T00:00:00.000Z'), line('m3', '2026-10-03T00:00:00.000Z')]);
    transcripts = [{ sessionName: 'dev-1', filePath: t.file, offset: t.size }];
    expect((await runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-10-02' })).added).toBe(1);
  });

  it('reports missing transcripts and skips one attributed to two sessions', async () => {
    const shared = await transcript('shared', [line('m1', '2026-09-20T10:00:00.000Z')]);
    transcripts = [
      { sessionName: 'dev-1', filePath: path.join(dir, 'gone.jsonl'), offset: 100 },
      { sessionName: 'dev-1', filePath: shared.file, offset: shared.size },
      { sessionName: 'dev-2', filePath: shared.file, offset: shared.size },
    ];
    const report = await runUsageBackfill(deps(), { from: '2026-09-20', to: '2026-09-20' });
    expect(report.missingTranscripts).toEqual([path.join(dir, 'gone.jsonl')]);
    expect(report.ambiguousTranscripts).toEqual([shared.file]);
    expect(report.added).toBe(0);
  });

  it('merges events from a ledger backup, deduped against transcripts and the ledger', async () => {
    const t = await transcript('a', [line('m1', '2026-09-20T10:00:00.000Z')]);
    transcripts = [{ sessionName: 'dev-1', filePath: t.file, offset: t.size }];
    const backup = path.join(dir, 'token-usage.json.bak-0921');
    await fs.writeFile(backup, JSON.stringify([
      {
        sessionName: 'dev-1', agentId: 'dev-1', totalInput: 0, totalOutput: 0, eventCount: 2,
        events: [
          // Same turn as the transcript's, from an older build without cachedInput
          { timestamp: '2026-09-20T10:00:00.000Z', agentId: 'dev-1', input: 100, output: 50, model: 'claude-opus-5' },
          { timestamp: '2026-09-19T08:00:00.000Z', agentId: 'dev-1', input: 7, output: 3, model: 'deepseek/deepseek-chat', cachedInput: 5 },
        ],
      },
      { sessionName: 'orc', agentId: 'orc', totalInput: 0, totalOutput: 0, eventCount: 1, events: [{ timestamp: '2026-07-01T00:00:00.000Z', agentId: 'orc', input: 1, output: 1, model: 'x' }] },
    ]));
    const broken = path.join(dir, 'token-usage.json.corrupt-x');
    await fs.writeFile(broken, '[{"sess');

    const report = await runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-09-30', dryRun: false, ledgerFiles: [backup, broken] });

    expect(report.added).toBe(2);
    expect(report.alreadyPresent).toBe(1);
    expect(report.days['2026-09-19']).toEqual({ transcripts: 0, ledgerFiles: 1 });
    expect(report.ledgerFiles[0]).toEqual({ path: backup, events: 1 });
    expect(report.ledgerFiles[1]).toEqual({ path: broken, events: 0, error: 'not a usable ledger file' });
    expect(ledger.getUsageByAgent('dev-1').eventCount).toBe(2);
  });

  it('never echoes file contents or says why a ledger file was rejected', async () => {
    const env = path.join(dir, '.env');
    await fs.writeFile(env, 'OPENAI_API_KEY=sk-secret\n');
    const envJson = path.join(dir, 'secrets.json');
    await fs.writeFile(envJson, '"OPENAI_API_KEY=sk-secret');
    const notArray = path.join(dir, 'obj.json');
    await fs.writeFile(notArray, '{"OPENAI_API_KEY":"sk-secret"}');
    const folder = path.join(dir, 'folder.json');
    await fs.mkdir(folder);
    const missing = path.join(dir, 'missing.json');

    const report = await runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-09-30', ledgerFiles: [env, envJson, notArray, folder, missing] });

    expect(report.ledgerFiles.map((f) => f.error)).toEqual(new Array(5).fill('not a usable ledger file'));
    expect(JSON.stringify(report)).not.toContain('OPENAI');
    expect(JSON.stringify(report)).not.toContain('sk-secret');
  });

  it('skips a ledger file over the size limit without reading it', async () => {
    const big = path.join(dir, 'big.json');
    await fs.writeFile(big, '[]');
    const realStat = fs.stat.bind(fs);
    jest.spyOn(fs, 'stat').mockImplementation(async (p) => {
      const st = await realStat(p as string);
      return String(p) === big ? Object.assign(st, { size: 201 * 1024 * 1024 }) : st;
    });
    const read = jest.spyOn(fs, 'readFile');
    const report = await runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-09-30', ledgerFiles: [big] });
    expect(report.ledgerFiles[0].error).toBe('not a usable ledger file');
    expect(read).not.toHaveBeenCalledWith(big, expect.anything());
  });

  it('rejects bad input', async () => {
    await expect(runUsageBackfill(deps(), { from: '2026-9-1', to: '2026-09-02' })).rejects.toBeInstanceOf(UsageBackfillError);
    await expect(runUsageBackfill(deps(), { from: '2026-09-03', to: '2026-09-02' })).rejects.toThrow(/after/);
    await expect(runUsageBackfill(deps(), { from: '2025-01-01', to: '2026-09-02' })).rejects.toThrow(/At most/);
    await expect(runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-09-02', ledgerFiles: ['relative.json'] })).rejects.toThrow(/absolute/);
  });

  it('refuses to write while the ledger file is bad and not yet set aside', async () => {
    const crewly = path.join(dir, 'blocked');
    await fs.mkdir(crewly);
    await fs.writeFile(path.join(crewly, 'token-usage.json'), '[{"tru');
    jest.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
    ledger = new TokenUsageService(crewly);
    await ledger.loadFromDisk();
    jest.restoreAllMocks();

    await expect(runUsageBackfill(deps(), { from: '2026-09-01', to: '2026-09-02', dryRun: false })).rejects.toMatchObject({ status: 409 });
    expect(await fs.readFile(path.join(crewly, 'token-usage.json'), 'utf-8')).toBe('[{"tru');
  });
});
