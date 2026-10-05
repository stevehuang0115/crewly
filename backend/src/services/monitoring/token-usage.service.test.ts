// Cache-aware cost fix
/**
 * Tests for TokenUsageService
 *
 * @module services/monitoring/token-usage.service.test
 */

import { TokenUsageService, cachedIsPartOfInput, calculateCost, dropCrossSessionDuplicates, eventCostRateSource, eventCostUsd, eventTokens } from './token-usage.service.js';
import { calculateCost as cacheAwareCost } from './model-pricing.js';

describe('TokenUsageService', () => {
  let service: TokenUsageService;

  beforeEach(() => {
    TokenUsageService.resetInstance();
    service = new TokenUsageService('/tmp/test-crewly');
  });

  afterEach(() => {
    service.stopPeriodicFlush();
    TokenUsageService.resetInstance();
  });

  describe('singleton', () => {
    it('should return the same instance', () => {
      const a = TokenUsageService.getInstance();
      const b = TokenUsageService.getInstance();
      expect(a).toBe(b);
      TokenUsageService.resetInstance();
    });

    it('should create new instance after reset', () => {
      const a = TokenUsageService.getInstance();
      TokenUsageService.resetInstance();
      const b = TokenUsageService.getInstance();
      expect(a).not.toBe(b);
      TokenUsageService.resetInstance();
    });
  });

  describe('recordUsage', () => {
    it('should create a new session record on first call', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      expect(service.getSessionCount()).toBe(1);
    });

    it('bills DeepSeek cache hits at the hit rate, not the miss rate', () => {
      // 38,532 input of which 32,384 cached, 1 output — the local orc's
      // real smoke-test run. Flat miss pricing said $0.0116; cache-aware
      // pricing is 6,148 × $0.30/M + 32,384 × $0.006/M + 1 × $1.20/M.
      const cost = calculateCost(38_532, 1, 'deepseek/deepseek-chat', 32_384);
      expect(cost).toBeCloseTo(6_148 * 0.0000003 + 32_384 * 0.000000006 + 0.0000012, 9);
      // A model without a cache rate ignores the hint entirely.
      expect(calculateCost(1000, 10, 'claude-3-opus', 900)).toBe(1000 * 0.000015 + 10 * 0.000075);
      // Cached can never exceed input.
      expect(calculateCost(100, 0, 'deepseek/deepseek-chat', 5000)).toBeCloseTo(100 * 0.000000006, 12);
    });

    it('keeps cache-hit and step counts per event and totals cached input (2026-09-18)', () => {
      service.recordUsage('session-1', 'agent-a', 1200, 40, 'deepseek/deepseek-chat', undefined, { cachedInput: 38_000, steps: 3 });
      service.recordUsage('session-1', 'agent-a', 900, 20, 'deepseek/deepseek-chat', undefined, { cachedInput: 39_000, steps: 1 });
      service.recordUsage('session-1', 'agent-a', 100, 5, 'claude-opus'); // no detail → nothing invented

      const [session] = service.getUsageBySessions();
      expect(session.totalInput).toBe(2200);
      expect(session.totalCachedInput).toBe(77_000);
      expect(session.eventCount).toBe(3);
    });

    it('should accumulate totals for the same session', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-1', 'agent-a', 200, 80, 'claude-opus');

      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].totalInput).toBe(300);
      expect(sessions[0].totalOutput).toBe(130);
      expect(sessions[0].eventCount).toBe(2);
    });

    it('should track separate sessions independently', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      expect(service.getSessionCount()).toBe(2);
      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(2);
    });
  });

  describe('getUsageByAgent', () => {
    it('should aggregate across sessions for the same agent', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-a', 200, 80, 'claude-sonnet');

      const summary = service.getUsageByAgent('agent-a');
      expect(summary.totalInput).toBe(300);
      expect(summary.totalOutput).toBe(130);
      expect(summary.eventCount).toBe(2);
    });

    it('should return zeros for unknown agent', () => {
      const summary = service.getUsageByAgent('nonexistent');
      expect(summary.totalInput).toBe(0);
      expect(summary.totalOutput).toBe(0);
      expect(summary.eventCount).toBe(0);
    });

    it('should not include other agents', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      const summary = service.getUsageByAgent('agent-a');
      expect(summary.totalInput).toBe(100);
      expect(summary.totalOutput).toBe(50);
      expect(summary.eventCount).toBe(1);
    });
  });

  describe('getUsageBySessions', () => {
    it('should return empty array when no data', () => {
      const sessions = service.getUsageBySessions();
      expect(sessions).toEqual([]);
    });

    it('should return per-session summaries', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      const sessions = service.getUsageBySessions();
      expect(sessions).toHaveLength(2);

      const s1 = sessions.find(s => s.sessionName === 'session-1');
      expect(s1).toBeDefined();
      expect(s1!.agentId).toBe('agent-a');
      expect(s1!.totalInput).toBe(100);

      const s2 = sessions.find(s => s.sessionName === 'session-2');
      expect(s2).toBeDefined();
      expect(s2!.agentId).toBe('agent-b');
      expect(s2!.totalOutput).toBe(80);
    });
  });

  describe('getUsageByTask', () => {
    it('should return empty map when no data', () => {
      const taskMap = service.getUsageByTask();
      expect(taskMap.size).toBe(0);
    });

    it('should aggregate by task ID across sessions', () => {
      service.recordUsage('s1', 'a1', 100, 50, 'claude-opus', 'task-1');
      service.recordUsage('s2', 'a2', 200, 80, 'claude-opus', 'task-1');
      service.recordUsage('s1', 'a1', 300, 120, 'claude-opus', 'task-2');
      service.recordUsage('s1', 'a1', 50, 20, 'claude-opus'); // no taskId

      const taskMap = service.getUsageByTask();
      expect(taskMap.size).toBe(3);

      const task1 = taskMap.get('task-1')!;
      expect(task1.totalInput).toBe(300);
      expect(task1.totalOutput).toBe(130);
      expect(task1.eventCount).toBe(2);

      const task2 = taskMap.get('task-2')!;
      expect(task2.totalInput).toBe(300);
      expect(task2.eventCount).toBe(1);

      const unassigned = taskMap.get('unassigned')!;
      expect(unassigned.totalInput).toBe(50);
    });
  });

  describe('getSessionUsageSince', () => {
    it('prices cache hits at the cached rate (feeds the team budget gate)', () => {
      const since = new Date(Date.now() - 60_000);
      service.recordUsage('session-1', 'agent-a', 38_532, 1, 'deepseek/deepseek-chat', undefined, {
        cachedInput: 32_384,
      });

      const usage = service.getSessionUsageSince('session-1', since);

      expect(usage.inputTokens).toBe(38_532);
      expect(usage.outputTokens).toBe(1);
      expect(usage.cost).toBeCloseTo(calculateCost(38_532, 1, 'deepseek/deepseek-chat', 32_384), 12);
      expect(usage.cost).toBeLessThan(calculateCost(38_532, 1, 'deepseek/deepseek-chat'));
    });

    it('excludes events before the window', () => {
      service.recordUsage('session-1', 'agent-a', 100, 10, 'claude-opus');
      const future = new Date(Date.now() + 60_000);
      expect(service.getSessionUsageSince('session-1', future)).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        totalTokens: 0,
        budgetTokens: 0,
        cachedInputTokens: 0,
      });
      expect(service.getSessionUsageSince('missing', future).cost).toBe(0);
    });
  });

  describe('eventCostUsd (the one per-event cost computation)', () => {
    it('prices a Claude transcript turn with its cache reads and writes (fresh input beside them)', () => {
      const cost = eventCostUsd({ input: 10, output: 400, model: 'claude-opus-5-5', cachedInput: 102_000, cacheWrite: 2_000 });
      expect(cost).toBeCloseTo(cacheAwareCost({ input: 10, output: 400, cacheRead: 100_000, cacheWrite: 2_000 }, 'claude-opus-5-5').cost, 12);
    });

    it('prices an in-process DeepSeek run with its cache hits as part of input', () => {
      const e = { input: 70_000, output: 500, model: 'deepseek/deepseek-chat', cachedInput: 60_000 };
      expect(eventCostUsd(e)).toBeCloseTo(calculateCost(70_000, 500, 'deepseek/deepseek-chat', 60_000), 12);
    });

    it('falls back to the legacy table for other models', () => {
      expect(eventCostUsd({ input: 100, output: 10, model: 'gpt-4o' })).toBeCloseTo(calculateCost(100, 10, 'gpt-4o'), 12);
    });

    it('an exact id wins over a family match (gemini-2.5-flash-preview-05-20 keeps its own price)', () => {
      const e = { input: 1_000_000, output: 1_000_000, model: 'gemini-2.5-flash-preview-05-20' };
      expect(eventCostUsd(e)).toBeCloseTo(0.15 + 0.6, 9);
      expect(eventCostRateSource('gemini-2.5-flash-preview-05-20')).toBe('exact');
      // An unlisted 2.5 flash id falls to the family rate.
      expect(eventCostUsd({ ...e, model: 'gemini-2.5-flash-002' })).toBeCloseTo(cacheAwareCost({ input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, 'gemini-2.5-flash').cost, 9);
      expect(eventCostRateSource('gemini-2.5-flash-002')).toBe('family');
      expect(eventCostRateSource('claude-opus-5')).toBe('exact');
      expect(eventCostRateSource('codex-cli-default')).toBe('default');
    });

    it('getSessionUsageSince uses it, so a Claude agent\'s cached context is counted', () => {
      const since = new Date(Date.now() - 60_000);
      service.recordUsage('ella', 'ella', 10, 100, 'claude-opus-5-5', undefined, { cachedInput: 600_000 });
      expect(service.getSessionUsageSince('ella', since).cost).toBeGreaterThan(0.85);
    });
  });

  describe('forEachEvent', () => {
    it('visits events at or after `since`, with their session', () => {
      service.recordUsage('a', 'a', 1, 1, 'm', undefined, { timestamp: '2026-10-01T10:00:00.000Z' });
      service.recordUsage('b', 'b', 2, 2, 'm', undefined, { timestamp: '2026-10-02T10:00:00.000Z' });
      const all: string[] = [];
      service.forEachEvent((s) => all.push(s));
      expect(all.sort()).toEqual(['a', 'b']);
      const recent: string[] = [];
      service.forEachEvent((s, e) => recent.push(`${s}:${e.input}`), new Date('2026-10-02T00:00:00.000Z'));
      expect(recent).toEqual(['b:2']);
    });
  });

  describe('resetUsage', () => {
    it('should clear all tracked data', () => {
      service.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      service.recordUsage('session-2', 'agent-b', 200, 80, 'claude-sonnet');

      service.resetUsage();

      expect(service.getSessionCount()).toBe(0);
      expect(service.getUsageBySessions()).toEqual([]);
    });
  });

  describe('flushToDisk and loadFromDisk', () => {
    it('should round-trip data through disk', async () => {
      const tmpDir = `/tmp/test-crewly-${Date.now()}`;
      const diskService = new TokenUsageService(tmpDir);

      diskService.recordUsage('session-1', 'agent-a', 100, 50, 'claude-opus');
      await diskService.flushToDisk();

      const loadService = new TokenUsageService(tmpDir);
      await loadService.loadFromDisk();

      const sessions = loadService.getUsageBySessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionName).toBe('session-1');
      expect(sessions[0].totalInput).toBe(100);
    });

    it('drops turns that were booked to several agents at once, and recomputes their totals', () => {
      // Before the shared-cwd guard, one foreign transcript was booked to
      // five agents; the same turn cannot belong to two of them.
      const shared = { timestamp: '2026-09-21T13:55:34.388Z', agentId: 'x', input: 32, output: 3252, model: 'claude-fable-5-1', cachedInput: 302_168 };
      const own = { timestamp: '2026-09-22T22:31:54.358Z', agentId: 'atlas', input: 32, output: 620, model: 'claude-fable-5-1', cachedInput: 301_194 };
      const records = [
        { sessionName: 'atlas', agentId: 'atlas', totalInput: 96, totalOutput: 10376, eventCount: 3, totalCachedInput: 905_530, events: [shared, { ...shared }, own] },
        { sessionName: 'max', agentId: 'max', totalInput: 32, totalOutput: 3252, eventCount: 1, events: [{ ...shared }] },
      ];

      expect(dropCrossSessionDuplicates(records)).toBe(3);

      expect(records[0].events).toEqual([own]);
      expect(records[0]).toMatchObject({ eventCount: 1, totalInput: 32, totalOutput: 620, totalCachedInput: 301_194 });
      expect(records[1].events).toEqual([]);
    });

    it('leaves a clean ledger untouched', () => {
      const records = [
        { sessionName: 'a', agentId: 'a', totalInput: 1, totalOutput: 1, eventCount: 1, events: [{ timestamp: 't1', agentId: 'a', input: 1, output: 1, model: 'm' }] },
        { sessionName: 'b', agentId: 'b', totalInput: 1, totalOutput: 1, eventCount: 1, events: [{ timestamp: 't2', agentId: 'b', input: 1, output: 1, model: 'm' }] },
      ];
      expect(dropCrossSessionDuplicates(records)).toBe(0);
    });

    it('should not fail when loading from non-existent file', async () => {
      const loadService = new TokenUsageService('/tmp/nonexistent-dir');
      await expect(loadService.loadFromDisk()).resolves.toBeUndefined();
    });
  });

  describe('periodic flush', () => {
    it('should start and stop without errors', () => {
      service.startPeriodicFlush();
      service.startPeriodicFlush(); // idempotent
      service.stopPeriodicFlush();
      service.stopPeriodicFlush(); // idempotent
    });
  });
});

describe('eventTokens — the token unit', () => {
  const Svc = TokenUsageService;

  it('counts cached input once whether it is inside input (in-process) or on top (Claude / Codex / agy)', () => {
    expect(eventTokens({ model: 'deepseek/deepseek-chat', input: 1000, cachedInput: 900, output: 50 })).toMatchObject({ input: 1000, cachedInput: 900, output: 50, total: 1050 });
    expect(eventTokens({ model: 'claude-opus-5-5', input: 100, cachedInput: 900, output: 50 })).toMatchObject({ input: 1000, cachedInput: 900, output: 50, total: 1050 });
    expect(eventTokens({ model: 'gpt-6-sol', runtime: 'codex-cli', input: 100, cachedInput: 900, output: 50 }).total).toBe(1050);
    expect(eventTokens({ model: 'antigravity-cli-default', runtime: 'antigravity-cli', input: 12719, output: 169 }).total).toBe(12888);
    expect(cachedIsPartOfInput({ model: 'x', runtime: 'crewly-agent' })).toBe(true);
  });

  it('getSessionUsageSince reports totalTokens and cachedInputTokens; recordUsage keeps the runtime', () => {
    const svc = new Svc('/tmp/token-unit-test-unused');
    svc.recordUsage('nova', 'nova', 100, 50, 'gpt-6-sol', undefined, { cachedInput: 900, runtime: 'codex-cli', timestamp: '2026-10-02T10:00:00.000Z' });
    const u = svc.getSessionUsageSince('nova', new Date('2026-10-02T00:00:00.000Z'));
    expect(u).toMatchObject({ inputTokens: 100, outputTokens: 50, totalTokens: 1050, cachedInputTokens: 900 });
    let runtime: string | undefined;
    svc.forEachEvent((_s, e) => {
      runtime = e.runtime;
    });
    expect(runtime).toBe('codex-cli');
  });
});

// specs/2026-10-03-usage-ledger-durability.md — the 2026-10-03 ledger loss:
// a full disk truncated token-usage.json, the load "started fresh", and the
// next flush wrote the near-empty ledger over what was left.
describe('ledger durability', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeFs = require('fs') as typeof import('fs');
  const fsp = nodeFs.promises;
  const os = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  let dir: string;
  const file = (): string => pathMod.join(dir, 'token-usage.json');
  const enospc = (): NodeJS.ErrnoException => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const history = (n: number) => [{
    sessionName: 'old', agentId: 'old', totalInput: n, totalOutput: n, eventCount: n,
    events: Array.from({ length: n }, (_v, i) => ({ timestamp: `2026-09-${String(10 + (i % 20)).padStart(2, '0')}T00:00:0${i % 10}.000Z`, agentId: 'old', input: 1, output: 1, model: 'm' })),
  }];

  beforeEach(async () => {
    dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'ledger-durability-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('a flush that hits ENOSPC keeps the previous file intact (no truncation)', async () => {
    await fsp.writeFile(file(), JSON.stringify(history(50)));
    const svc = new TokenUsageService(dir);
    await svc.loadFromDisk();
    svc.recordUsage('new', 'new', 5, 5, 'm');

    const realWrite = fsp.writeFile.bind(fsp);
    jest.spyOn(fsp, 'writeFile').mockImplementation(async (p, data) => {
      // What a real full disk does: part of the data lands, then the write fails.
      await realWrite(p as string, String(data).slice(0, 10));
      throw enospc();
    });
    await expect(svc.flushToDisk()).rejects.toMatchObject({ code: 'ENOSPC' });
    jest.restoreAllMocks();

    expect(JSON.parse(await fsp.readFile(file(), 'utf-8'))).toEqual(history(50));
    expect((await fsp.readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);

    // Once there is space again, the next flush writes everything.
    await svc.flushToDisk();
    const reloaded = new TokenUsageService(dir);
    await reloaded.loadFromDisk();
    expect(reloaded.getSessionCount()).toBe(2);
  });

  it('a truncated ledger is copied aside as token-usage.json.corrupt-<ts> before anything overwrites it', async () => {
    const truncated = JSON.stringify(history(50)).slice(0, 200);
    await fsp.writeFile(file(), truncated);
    const svc = new TokenUsageService(dir);
    await svc.loadFromDisk();
    expect(svc.isBlocked()).toBe(false);
    expect(svc.getSessionCount()).toBe(0);

    const aside = (await fsp.readdir(dir)).filter((f) => f.startsWith('token-usage.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await fsp.readFile(pathMod.join(dir, aside[0]), 'utf-8')).toBe(truncated);

    svc.recordUsage('s', 's', 1, 1, 'm');
    await svc.flushToDisk();
    expect(JSON.parse(await fsp.readFile(file(), 'utf-8'))).toHaveLength(1);
    expect(await fsp.readFile(pathMod.join(dir, aside[0]), 'utf-8')).toBe(truncated);
  });

  it('when the bad file cannot be copied aside, flushes refuse to write until it can', async () => {
    await fsp.writeFile(file(), '[{"sessionName":"old","ev');
    jest.spyOn(fsp, 'copyFile').mockRejectedValue(enospc());
    const svc = new TokenUsageService(dir);
    await svc.loadFromDisk();
    expect(svc.isBlocked()).toBe(true);

    svc.recordUsage('s', 's', 1, 1, 'm');
    await expect(svc.flushToDisk()).rejects.toThrow(/not saved/);
    expect(await fsp.readFile(file(), 'utf-8')).toBe('[{"sessionName":"old","ev');

    jest.restoreAllMocks();
    await svc.flushToDisk();
    expect(svc.isBlocked()).toBe(false);
    const files = await fsp.readdir(dir);
    expect(files.filter((f) => f.startsWith('token-usage.json.corrupt-'))).toHaveLength(1);
    expect(JSON.parse(await fsp.readFile(file(), 'utf-8'))[0].sessionName).toBe('s');
  });

  it('a transient read error (EMFILE) on a good ledger blocks flushes; the next flush reads it and merges', async () => {
    await fsp.writeFile(file(), JSON.stringify(history(5)));
    const readFile = fsp.readFile.bind(fsp);
    jest.spyOn(fsp, 'readFile').mockImplementationOnce(async () => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    });
    const svc = new TokenUsageService(dir);
    await svc.loadFromDisk();
    expect(svc.isBlocked()).toBe(true);
    expect(svc.getSessionCount()).toBe(0);
    svc.recordUsage('new', 'new', 1, 1, 'm');

    // Still failing: refuse, leave the file alone, set nothing aside.
    jest.spyOn(fsp, 'readFile').mockImplementationOnce(async () => {
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    });
    await expect(svc.flushToDisk()).rejects.toThrow(/not saved/);
    expect(JSON.parse(await readFile(file(), 'utf-8'))).toEqual(history(5));

    jest.restoreAllMocks();
    await svc.flushToDisk();
    expect(svc.isBlocked()).toBe(false);
    const saved = JSON.parse(await fsp.readFile(file(), 'utf-8')) as Array<{ sessionName: string; events: unknown[] }>;
    expect(saved.find((r) => r.sessionName === 'old')?.events).toHaveLength(5);
    expect(saved.find((r) => r.sessionName === 'new')?.events).toHaveLength(1);
    expect((await fsp.readdir(dir)).filter((f) => f.includes('.corrupt'))).toEqual([]);
  });

  it('merges file and in-memory events of one session in time order', async () => {
    await fsp.writeFile(file(), JSON.stringify([{ sessionName: 's', agentId: 's', totalInput: 1, totalOutput: 1, eventCount: 1,
      events: [{ timestamp: '2026-09-02T00:00:00.000Z', agentId: 's', input: 1, output: 1, model: 'm' }] }]));
    const svc = new TokenUsageService(dir);
    svc.recordUsage('s', 's', 2, 2, 'm', undefined, { timestamp: '2026-09-01T00:00:00.000Z' });
    svc.recordUsage('s', 's', 3, 3, 'm', undefined, { timestamp: '2026-09-03T00:00:00.000Z' });
    await svc.loadFromDisk();
    const ts: string[] = [];
    svc.forEachEvent((_s, e) => ts.push(e.timestamp));
    expect(ts).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z']);
  });

  it('a flush before any load reads the file first instead of replacing it', async () => {
    await fsp.writeFile(file(), JSON.stringify(history(3)));
    const svc = new TokenUsageService(dir);
    svc.recordUsage('old', 'old', 7, 7, 'm', undefined, { timestamp: '2026-10-03T00:00:00.000Z' });
    await svc.flushToDisk();

    const saved = JSON.parse(await fsp.readFile(file(), 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].events).toHaveLength(4);
    expect(saved[0].eventCount).toBe(4);
  });

  it('a missing file starts fresh without quarantining anything', async () => {
    const svc = new TokenUsageService(dir);
    await svc.loadFromDisk();
    expect(svc.isBlocked()).toBe(false);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('importEvents skips events already in any session (by message id or event key) and adds the rest in order', () => {
    const svc = new TokenUsageService(dir);
    svc.recordUsage('a', 'a', 10, 1, 'm', undefined, { timestamp: '2026-09-02T00:00:00.000Z', cachedInput: 5, messageId: 'msg_2' });
    const r = svc.importEvents('a', 'a', [
      { timestamp: '2026-09-03T00:00:00.000Z', agentId: 'a', input: 1, output: 1, model: 'm', messageId: 'msg_3' },
      { timestamp: '2026-09-01T00:00:00.000Z', agentId: 'a', input: 1, output: 1, model: 'm', messageId: 'msg_1' },
      { timestamp: 'other', agentId: 'a', input: 0, output: 0, model: 'm', messageId: 'msg_2' },
      { timestamp: '2026-09-02T00:00:00.000Z', agentId: 'a', input: 10, output: 1, model: 'm', cachedInput: 5 },
    ]);
    expect(r).toEqual({ added: 2, present: 2 });
    const events: string[] = [];
    svc.forEachEvent((_s, e) => events.push(e.timestamp));
    expect(events).toEqual(['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z']);
    expect(svc.getUsageByAgent('a')).toEqual({ totalInput: 12, totalOutput: 3, eventCount: 3 });
  });
});
