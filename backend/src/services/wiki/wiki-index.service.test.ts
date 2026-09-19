import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WikiIndexService, parseIndex } from './wiki-index.service.js';
import { serializePage } from './wiki-page.js';

let vault: string;
beforeEach(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-index-'));
  await fs.mkdir(path.join(vault, 'llm-curated/decisions'), { recursive: true });
  await fs.mkdir(path.join(vault, 'llm-curated/patterns'), { recursive: true });
  await fs.mkdir(path.join(vault, 'llm-curated/_proposed/decisions'), { recursive: true });
  await fs.writeFile(path.join(vault, 'llm-curated/log.md'), '# Activity log\n');
});
afterEach(() => fs.rm(vault, { recursive: true, force: true }));

describe('WikiIndexService', () => {
  it('upserts, replaces and removes lines, grouped by folder', async () => {
    const svc = new WikiIndexService();
    await svc.upsert(vault, 'llm-curated/decisions/pricing.md', { title: 'Pricing', summary: 'We charge 800', keep_because: 'hard_fact' });
    await svc.upsert(vault, 'llm-curated/patterns/claims.md', { title: 'Claims', summary: 'Release inside transition', keep_because: 'reusable_method' });
    await svc.upsert(vault, 'llm-curated/decisions/pricing.md', { title: 'Pricing v2', summary: 'Now 900', keep_because: 'hard_fact' });
    const index = await svc.read(vault);
    expect(index.entries.map((e) => `${e.group}:${e.title}`)).toEqual(['decisions:Pricing v2', 'patterns:Claims']);
    expect(index.raw).toContain('## decisions');
    await svc.remove(vault, 'llm-curated/patterns/claims.md');
    expect((await svc.read(vault)).entries).toHaveLength(1);
  });

  it('rebuilds from frontmatter (falling back to the first heading) and reports coverage', async () => {
    const svc = new WikiIndexService();
    await fs.writeFile(path.join(vault, 'llm-curated/decisions/a.md'), serializePage({ title: 'A', summary: 'a means x', keep_because: 'hard_fact' }, '# A\nbody'));
    await fs.writeFile(path.join(vault, 'llm-curated/patterns/b.md'), '# Legacy B\n\nno frontmatter');
    await fs.writeFile(path.join(vault, 'llm-curated/_proposed/decisions/p.md'), '# proposed\n');
    expect(await svc.rebuild(vault)).toBe(2);
    const index = await svc.read(vault);
    expect(index.entries.map((e) => e.title).sort()).toEqual(['A', 'Legacy B']);
    expect(index.raw).not.toContain('_proposed');
    await fs.writeFile(path.join(vault, 'llm-curated/patterns/c.md'), '# C\n');
    const cov = await svc.coverage(vault);
    expect(cov).toMatchObject({ pages: 3, indexed: 2, missingFromIndex: ['llm-curated/patterns/c.md'], indexedButMissing: [] });
  });

  it('serialises concurrent upserts (no lost lines)', async () => {
    const svc = new WikiIndexService();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => svc.upsert(vault, `llm-curated/decisions/d${i}.md`, { title: `D${i}`, summary: 's', keep_because: 'hard_fact' })),
    );
    expect((await svc.read(vault)).entries).toHaveLength(12);
  });

  it('trims a too-large index to the query-relevant lines', async () => {
    const svc = new WikiIndexService();
    for (let i = 0; i < 40; i++) {
      await svc.upsert(vault, `llm-curated/patterns/p${i}.md`, { title: i === 7 ? 'Slack typing placeholder' : `Page ${i}`, summary: 'x'.repeat(100), keep_because: 'hard_fact' });
    }
    const full = await svc.readForQuery(vault, ['slack'], 1_000_000);
    expect(full.truncated).toBe(false);
    const trimmed = await svc.readForQuery(vault, ['slack', 'typing'], 1200);
    expect(trimmed.truncated).toBe(true);
    expect(trimmed.text).toContain('Slack typing placeholder');
    expect(trimmed.entries).toBeLessThan(40);
  });

  it('parseIndex reads supersession markers', () => {
    const [e] = parseIndex('- [Old](llm-curated/decisions/old.md) — was true ⟶ superseded by llm-curated/decisions/new.md');
    expect(e).toMatchObject({ title: 'Old', summary: 'was true', supersededBy: 'llm-curated/decisions/new.md', group: 'decisions' });
  });
});
