import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WikiHistoryService } from './wiki-history.service.js';
import { WIKI_KB_CONSTANTS } from '../../constants.js';

let vault: string;
beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-hist-'));
  await fs.mkdir(path.join(vault, 'llm-curated/decisions'), { recursive: true });
});
afterEach(() => fs.rm(vault, { recursive: true, force: true }));

describe('WikiHistoryService', () => {
  it('snapshots prior content with author/action and lists newest first', async () => {
    let t = Date.parse('2026-09-19T00:00:00Z');
    const svc = new WikiHistoryService(() => new Date(t));
    const rel = 'llm-curated/decisions/p.md';
    expect(await svc.snapshot(vault, rel, 'atlas', 'write')).toBeNull(); // nothing to snapshot yet
    await fs.writeFile(path.join(vault, rel), 'v1');
    const r1 = await svc.snapshot(vault, rel, 'atlas', 'write');
    expect(r1).toMatchObject({ author: 'atlas', action: 'write', bytes: 2 });
    t += 1000;
    await fs.writeFile(path.join(vault, rel), 'v2 longer');
    await svc.snapshot(vault, rel, 'kai', 'supersede');
    const list = await svc.list(vault, rel);
    expect(list.map((r) => `${r.author}:${r.action}:${r.bytes}`)).toEqual(['kai:supersede:9', 'atlas:write:2']);
    expect(await svc.read(list[1].file)).toBe('v1');
  });

  it('keeps at most HISTORY_MAX_REVISIONS per page', async () => {
    let t = Date.parse('2026-09-19T00:00:00Z');
    const svc = new WikiHistoryService(() => new Date(t));
    const rel = 'llm-curated/decisions/p.md';
    for (let i = 0; i < WIKI_KB_CONSTANTS.HISTORY_MAX_REVISIONS + 5; i++) {
      await fs.writeFile(path.join(vault, rel), `v${i}`);
      await svc.snapshot(vault, rel, 'a', 'write');
      t += 1000;
    }
    expect(await svc.list(vault, rel)).toHaveLength(WIKI_KB_CONSTANTS.HISTORY_MAX_REVISIONS);
  });
});
