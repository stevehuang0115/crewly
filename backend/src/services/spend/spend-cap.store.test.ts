import fsMod, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSpendCapStore, MemorySpendCapStore, emptySpendCapFile, migrateUsdConfig } from './spend-cap.store.js';

describe('FileSpendCapStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'spend-cap-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when there is no file, round-trips what it wrote', () => {
    const store = new FileSpendCapStore(path.join(dir, 'nested', 'usage-caps.json'));
    expect(store.read()).toBeNull();
    const file = emptySpendCapFile('2026-10-02');
    file.config.defaultAgentCapTokens = 5_000_000;
    file.config.agentCapsTokens['crewly-orc'] = null;
    file.config.teamCapsTokens['team-ce'] = 50_000_000;
    file.boosts.push({ id: 'b1', target: '*', unlimited: true, until: '2026-10-03T04:00:00.000Z', createdAt: '2026-10-02T15:00:00.000Z' });
    store.write(file);
    expect(store.read()).toEqual(file);
  });

  it('fills defaults for a partial file and ignores garbage', () => {
    const file = path.join(dir, 'usage-caps.json');
    writeFileSync(file, JSON.stringify({ config: { totalCapTokens: 20 } }));
    const store = new FileSpendCapStore(file);
    expect(store.read()).toEqual({
      config: { defaultAgentCapTokens: null, totalCapTokens: 20, agentCapsTokens: {}, teamCapsTokens: {} },
      boosts: [],
      day: { date: '', warned: [], stopped: [], cards: {} },
    });
    writeFileSync(file, 'not json');
    expect(store.read()).toBeNull();
  });

  it('migrates the pre-token USD file once (documented rate), and not when it held no caps', () => {
    const legacy = path.join(dir, 'spend-caps.json');
    const target = path.join(dir, 'usage-caps.json');
    writeFileSync(legacy, JSON.stringify({ config: { defaultAgentCapUsd: null, totalCapUsd: null, agentCapsUsd: {} } }));
    expect(new FileSpendCapStore(target, legacy).read()).toBeNull();
    writeFileSync(legacy, JSON.stringify({ config: { defaultAgentCapUsd: 5, totalCapUsd: 20, agentCapsUsd: { a: 1.25, b: null } } }));
    const migrated: unknown[] = [];
    const read = new FileSpendCapStore(target, legacy, (c) => migrated.push(c)).read();
    expect(read?.config).toMatchObject({ defaultAgentCapTokens: 5_000_000, totalCapTokens: 20_000_000, agentCapsTokens: { a: 1_250_000, b: null }, teamCapsTokens: {} });
    expect(migrated).toHaveLength(1);
    // Written: the next read uses the token file.
    expect(JSON.parse(readFileSync(target, 'utf-8')).config.totalCapTokens).toBe(20_000_000);
    expect(migrateUsdConfig(null)).toBeNull();
  });

  it('writes atomically (no temp file left behind)', () => {
    const file = path.join(dir, 'usage-caps.json');
    new FileSpendCapStore(file).write(emptySpendCapFile('2026-10-02'));
    expect(JSON.parse(readFileSync(file, 'utf-8')).day.date).toBe('2026-10-02');
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });

  // specs/2026-10-03-usage-ledger-durability.md
  describe('durability', () => {
    const enospc = (): NodeJS.ErrnoException => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    afterEach(() => jest.restoreAllMocks());

    it('copies a bad caps file aside (usage-caps.json.corrupt-<ts>) before starting empty', () => {
      const file = path.join(dir, 'usage-caps.json');
      writeFileSync(file, '{"config":{"totalCap');
      const logger = { warn: jest.fn(), error: jest.fn() };
      expect(new FileSpendCapStore(file, undefined, undefined, logger).read()).toBeNull();
      const aside = readdirSync(dir).filter((f) => f.startsWith('usage-caps.json.corrupt-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(path.join(dir, aside[0]), 'utf-8')).toBe('{"config":{"totalCap');
      expect(logger.error).toHaveBeenCalled();
    });

    it('a write on a full disk keeps the previous caps', () => {
      const file = path.join(dir, 'usage-caps.json');
      const store = new FileSpendCapStore(file);
      const caps = emptySpendCapFile('2026-10-02');
      caps.config.totalCapTokens = 42;
      store.write(caps);
      jest.spyOn(fsMod, 'writeFileSync').mockImplementation(() => {
        throw enospc();
      });
      expect(() => store.write(emptySpendCapFile('2026-10-03'))).toThrow(/ENOSPC/);
      jest.restoreAllMocks();
      expect(JSON.parse(readFileSync(file, 'utf-8')).config.totalCapTokens).toBe(42);
    });

    it('refuses to write over a bad file it could not copy aside', () => {
      const file = path.join(dir, 'usage-caps.json');
      writeFileSync(file, '{"config":');
      const store = new FileSpendCapStore(file);
      const copy = jest.spyOn(fsMod, 'copyFileSync').mockImplementation(() => {
        throw enospc();
      });
      expect(store.read()).toBeNull();
      expect(() => store.write(emptySpendCapFile('2026-10-03'))).toThrow(/could not be set aside/);
      expect(readFileSync(file, 'utf-8')).toBe('{"config":');
      copy.mockRestore();
      store.write(emptySpendCapFile('2026-10-03'));
      expect(JSON.parse(readFileSync(file, 'utf-8')).day.date).toBe('2026-10-03');
      expect(readdirSync(dir).filter((f) => f.startsWith('usage-caps.json.corrupt-'))).toHaveLength(1);
    });
  });
});

describe('MemorySpendCapStore', () => {
  it('stores copies', () => {
    const store = new MemorySpendCapStore();
    const file = emptySpendCapFile('2026-10-02');
    store.write(file);
    file.config.totalCapTokens = 1;
    expect(store.read()!.config.totalCapTokens).toBeNull();
  });
});
