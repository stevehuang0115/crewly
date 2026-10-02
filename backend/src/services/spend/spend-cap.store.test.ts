import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileSpendCapStore, MemorySpendCapStore, emptySpendCapFile } from './spend-cap.store.js';

describe('FileSpendCapStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'spend-cap-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when there is no file, round-trips what it wrote', () => {
    const store = new FileSpendCapStore(path.join(dir, 'nested', 'spend-caps.json'));
    expect(store.read()).toBeNull();
    const file = emptySpendCapFile('2026-10-02');
    file.config.defaultAgentCapUsd = 5;
    file.config.agentCapsUsd['crewly-orc'] = null;
    file.day.raised['crewly-orc'] = 9;
    store.write(file);
    expect(store.read()).toEqual(file);
  });

  it('fills defaults for an older / partial file and ignores garbage', () => {
    const file = path.join(dir, 'spend-caps.json');
    writeFileSync(file, JSON.stringify({ config: { totalCapUsd: 20 } }));
    const store = new FileSpendCapStore(file);
    expect(store.read()).toEqual({
      config: { defaultAgentCapUsd: null, totalCapUsd: 20, agentCapsUsd: {} },
      day: { date: '', raised: {}, warned: [], stopped: [], cards: {} },
    });
    writeFileSync(file, 'not json');
    expect(store.read()).toBeNull();
  });

  it('writes atomically (no temp file left behind)', () => {
    const file = path.join(dir, 'spend-caps.json');
    new FileSpendCapStore(file).write(emptySpendCapFile('2026-10-02'));
    expect(JSON.parse(readFileSync(file, 'utf-8')).day.date).toBe('2026-10-02');
    expect(() => readFileSync(`${file}.tmp`)).toThrow();
  });
});

describe('MemorySpendCapStore', () => {
  it('stores copies', () => {
    const store = new MemorySpendCapStore();
    const file = emptySpendCapFile('2026-10-02');
    store.write(file);
    file.config.totalCapUsd = 1;
    expect(store.read()!.config.totalCapUsd).toBeNull();
  });
});
