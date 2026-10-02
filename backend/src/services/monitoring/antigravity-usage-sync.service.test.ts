/**
 * Tests for the Antigravity usage sync. The metadata blobs are built with
 * the same protobuf shape agy 1.x writes (step timestamp in field 1, usage
 * message in field 9 with input in 2 and output in 3).
 */

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AntigravityUsageSyncService,
  antigravityStepTime,
  antigravityStepUsage,
  decodeProtoFields,
  sqliteStepReader,
  type AntigravityStepRow,
  type AntigravityUsageEvent,
} from './antigravity-usage-sync.service.js';

function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return Buffer.from(out);
}
const vfield = (f: number, n: number) => Buffer.concat([varint(f * 8), varint(n)]);
const lfield = (f: number, b: Buffer) => Buffer.concat([varint(f * 8 + 2), varint(b.length), b]);

/** A model step's metadata as agy writes it. */
function stepMeta(seconds: number, input: number, output: number): Buffer {
  const ts = Buffer.concat([vfield(1, seconds), vfield(2, 299870000)]);
  const usage = Buffer.concat([vfield(1, 1036), vfield(2, input), vfield(3, output), lfield(7, Buffer.from('pWK-auiKJ76')), vfield(9, output - 2), vfield(10, 2)]);
  return Buffer.concat([lfield(1, ts), vfield(3, 2), lfield(9, usage), vfield(11, 1036), lfield(12, Buffer.from('7e954d21'))]);
}
/** A user-input step: no usage. */
function userMeta(seconds: number): Buffer {
  return Buffer.concat([lfield(1, Buffer.concat([vfield(1, seconds)])), vfield(3, 4), lfield(12, Buffer.from('7e954d21'))]);
}

describe('protobuf helpers', () => {
  it('reads input/output and time from a model step, nothing from other steps', () => {
    const meta = stepMeta(1790861989, 12719, 169);
    expect(antigravityStepUsage(meta)).toEqual({ input: 12719, output: 169 });
    expect(antigravityStepTime(meta)).toBe(new Date(1790861989 * 1000 + 299).toISOString());
    expect(antigravityStepUsage(userMeta(1790861989))).toBeNull();
    expect(antigravityStepUsage(Buffer.from([0xff, 0xff]))).toBeNull();
    expect(antigravityStepUsage(null)).toBeNull();
  });

  it('rejects truncated messages', () => {
    expect(decodeProtoFields(stepMeta(1, 2, 3).subarray(0, 15))).toBeNull();
  });
});

describe('AntigravityUsageSyncService', () => {
  let home: string;
  let recorded: Array<{ session: string; event: AntigravityUsageEvent }>;
  let rows: AntigravityStepRow[];
  const ID = '4eb3a9c8-d057-45f2-a3fa-740fbd776e53';

  const make = (readSteps: (p: string) => AntigravityStepRow[] | null = () => rows) =>
    new AntigravityUsageSyncService({
      configDir: home,
      cursorFile: path.join(home, 'cursors.json'),
      sessions: () => new Map([['ce-ana-1', { runtimeType: 'antigravity-cli', claudeSessionId: ID }]]),
      readSteps,
      record: (session, event) => recorded.push({ session, event }),
    });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-sync-'));
    await fs.mkdir(path.join(home, 'conversations'));
    await fs.writeFile(path.join(home, 'conversations', `${ID}.db`), 'x');
    recorded = [];
    rows = [
      { idx: 0, metadata: userMeta(1790861989) },
      { idx: 1, metadata: stepMeta(1790861990, 12719, 169) },
    ];
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('counts each step once, across passes and restarts', async () => {
    const sync = make();
    expect((await sync.sync()).eventsRecorded).toBe(1);
    expect(recorded[0]).toMatchObject({ session: 'ce-ana-1', event: { model: 'antigravity-cli-default', input: 12719, output: 169 } });

    // New step; the file changed.
    rows.push({ idx: 2, metadata: stepMeta(1790861999, 13000, 50) });
    const later = new Date(Date.now() + 5000);
    await fs.utimes(path.join(home, 'conversations', `${ID}.db`), later, later);
    expect((await sync.sync()).eventsRecorded).toBe(1);

    // Restart: cursor persisted, nothing re-counted even if the file changes.
    const again = make();
    const later2 = new Date(Date.now() + 10000);
    await fs.utimes(path.join(home, 'conversations', `${ID}.db`), later2, later2);
    expect((await again.sync()).eventsRecorded).toBe(0);
    expect(recorded).toHaveLength(2);
  });

  it('reads a real SQLite conversation database', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const dbPath = path.join(home, 'conversations', `${ID}.db`);
    await fs.rm(dbPath);
    const db = new Database(dbPath);
    db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer, metadata blob)');
    const ins = db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)');
    ins.run(0, 14, userMeta(1790861989));
    ins.run(1, 15, stepMeta(1790861990, 12719, 169));
    db.close();
    const sync = make(sqliteStepReader(require));
    expect((await sync.sync()).tokensRecorded).toBe(12719 + 169);
  });
});
