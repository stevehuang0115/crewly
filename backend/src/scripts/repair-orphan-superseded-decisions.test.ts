/**
 * Tests for repair-orphan-superseded-decisions.
 * @module scripts/repair-orphan-superseded-decisions.test
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { repairDecisionsFile, runRepair, DECISIONS_REL_PATH } from './repair-orphan-superseded-decisions.js';

describe('repair-orphan-superseded-decisions', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repair-dec-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  async function seed(root: string, data: unknown): Promise<string> {
    const f = path.join(root, DECISIONS_REL_PATH);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, typeof data === 'string' ? data : JSON.stringify(data));
    return f;
  }
  const sample = [
    { id: 'a', status: 'superseded' },
    { id: 'b', status: 'superseded', supersededBy: 'c' },
    { id: 'c', status: 'active' },
  ];

  it('dry-run reports but does not write', async () => {
    const f = await seed(dir, sample);
    const r = await repairDecisionsFile(f, false);
    expect(r).toMatchObject({ examined: 3, orphans: 1, repaired: 0 });
    expect(JSON.parse(await fs.readFile(f, 'utf8'))[0].status).toBe('superseded');
  });

  it('apply reactivates only orphans, keeps real supersessions, writes a backup', async () => {
    const f = await seed(dir, sample);
    const r = await repairDecisionsFile(f, true);
    expect(r.repaired).toBe(1);
    const out = JSON.parse(await fs.readFile(f, 'utf8'));
    expect(out.map((d: any) => d.status)).toEqual(['active', 'superseded', 'active']);
    expect(JSON.parse(await fs.readFile(r.backup!, 'utf8'))).toEqual(sample);
  });

  it('reports malformed files as errors', async () => {
    const f = await seed(dir, '{not json');
    expect((await repairDecisionsFile(f, true)).error).toBeDefined();
  });

  it('refuses success when zero files are examined', async () => {
    const out = await runRepair({ apply: false, projectPaths: [dir] });
    expect(out.results).toHaveLength(0);
    expect(out.ok).toBe(false);
  });

  it('succeeds over a project with a decisions file', async () => {
    await seed(dir, sample);
    const out = await runRepair({ apply: true, projectPaths: [dir] });
    expect(out.ok).toBe(true);
    expect(out.results[0].repaired).toBe(1);
  });
});
