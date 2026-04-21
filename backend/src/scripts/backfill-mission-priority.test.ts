/**
 * Tests for backfill-mission-priority script.
 *
 * @module scripts/backfill-mission-priority.test
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import {
  backfillMissionPriority,
  BACKFILL_DEFAULT_PRIORITY,
} from './backfill-mission-priority.js';

describe('backfillMissionPriority', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-backfill-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /**
   * Writes a mission JSON fixture to the temp dir and returns the path.
   */
  async function writeMission(id: string, body: Record<string, unknown>): Promise<string> {
    const p = path.join(tmpDir, `${id}.json`);
    await fs.writeFile(p, JSON.stringify({ id, ...body }));
    return p;
  }

  it('returns zero counts when the directory is missing', async () => {
    const missing = path.join(tmpDir, 'nope');
    const result = await backfillMissionPriority(missing);
    expect(result.scanned).toBe(0);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('adds default priority when a mission file is missing the field', async () => {
    const filePath = await writeMission('m1', { objective: 'do X' });

    const result = await backfillMissionPriority(tmpDir);

    expect(result.scanned).toBe(1);
    expect(result.updated).toEqual(['m1']);
    expect(result.skipped).toEqual([]);

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(persisted.priority).toBe(BACKFILL_DEFAULT_PRIORITY);
  });

  it('leaves missions with an existing priority untouched', async () => {
    const filePath = await writeMission('m2', { objective: 'do Y', priority: 'critical' });

    const result = await backfillMissionPriority(tmpDir);

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(['m2']);

    const persisted = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    expect(persisted.priority).toBe('critical');
  });

  it('is idempotent when run twice', async () => {
    await writeMission('m3', { objective: 'do Z' });

    const first = await backfillMissionPriority(tmpDir);
    const second = await backfillMissionPriority(tmpDir);

    expect(first.updated).toEqual(['m3']);
    expect(second.updated).toEqual([]);
    expect(second.skipped).toEqual(['m3']);
  });

  it('skips non-JSON files silently', async () => {
    await fs.writeFile(path.join(tmpDir, 'notes.txt'), 'ignore me');
    await writeMission('m4', { objective: 'real mission' });

    const result = await backfillMissionPriority(tmpDir);

    expect(result.scanned).toBe(1);
    expect(result.updated).toEqual(['m4']);
  });

  it('records parse failures in `failed` and keeps scanning the rest', async () => {
    await writeMission('m5', { objective: 'ok' });
    await fs.writeFile(path.join(tmpDir, 'broken.json'), '{not json');

    const result = await backfillMissionPriority(tmpDir);

    expect(result.scanned).toBe(2);
    expect(result.updated).toEqual(['m5']);
    expect(result.failed).toEqual([path.join(tmpDir, 'broken.json')]);
  });

  it('records files with missing id in `failed` rather than pushing undefined', async () => {
    // Valid JSON, no id field.
    await fs.writeFile(path.join(tmpDir, 'no-id.json'), JSON.stringify({ objective: 'x' }));

    const result = await backfillMissionPriority(tmpDir);

    expect(result.scanned).toBe(1);
    expect(result.updated).toEqual([]);
    expect(result.failed).toEqual([path.join(tmpDir, 'no-id.json')]);
  });
});
