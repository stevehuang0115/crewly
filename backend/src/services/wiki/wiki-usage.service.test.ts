import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WikiUsageService } from './wiki-usage.service.js';

let vault: string;
beforeEach(async () => { vault = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-usage-')); });
afterEach(() => fs.rm(vault, { recursive: true, force: true }));

describe('WikiUsageService', () => {
  it('records queries and reports reads, misses and unread pages over the window', async () => {
    let t = Date.parse('2026-09-19T00:00:00Z');
    const svc = new WikiUsageService(() => new Date(t));
    await svc.record(vault, { via: 'wiki-query', agent: 'atlas', query: 'pricing', hits: ['llm-curated/decisions/pricing.md'], miss: false });
    t += 1000;
    await svc.record(vault, { via: 'recall', agent: 'kai', query: 'refund policy', hits: [], miss: true });
    t += 1000;
    await svc.record(vault, { via: 'wiki-query', agent: 'atlas', query: 'pricing again', hits: ['llm-curated/decisions/pricing.md', 'llm-curated/patterns/x.md'], miss: false });

    const r = await svc.report(vault, 7);
    expect(r).toMatchObject({ queries: 3, misses: 1, pagesRead: 2, missedQueries: ['refund policy'] });
    expect(r.topPages[0]).toEqual({ path: 'llm-curated/decisions/pricing.md', reads: 2 });
    expect(r.byAgent[0]).toEqual({ agent: 'atlas', queries: 2 });
    expect(await svc.unreadPages(vault, ['llm-curated/decisions/pricing.md', 'llm-curated/patterns/x.md', 'llm-curated/patterns/never.md'])).toEqual(['llm-curated/patterns/never.md']);

    // Outside the window nothing counts.
    t += 30 * 24 * 3600 * 1000;
    expect((await svc.report(vault, 7)).queries).toBe(0);
  });

  it('never throws on an unwritable ledger', async () => {
    const svc = new WikiUsageService();
    await expect(svc.record('/nonexistent/root/that/cannot/be/created\0', { via: 'x', agent: 'a', query: 'q', hits: [], miss: false })).resolves.toBeUndefined();
  });
});
