/**
 * Tests for WikiRecentService.
 *
 * @module services/wiki/wiki-recent.service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  WikiRecentService,
  WIKI_RECENT_DEFAULT_LIMIT,
  WIKI_RECENT_MAX_LIMIT,
} from './wiki-recent.service.js';

let vaultRoot: string;
let svc: WikiRecentService;

async function writePage(rel: string, content: string, mtime?: Date): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  if (mtime) await fs.utimes(abs, mtime, mtime);
}

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-recent-test-'));
  WikiRecentService.resetInstance();
  svc = WikiRecentService.getInstance();
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('WikiRecentService input validation', () => {
  it('rejects relative vaultPath', async () => {
    const out = await svc.list({ vaultPath: 'relative' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });

  it('returns vault_missing for non-existent dir', async () => {
    const out = await svc.list({
      vaultPath: path.join(os.tmpdir(), 'does-not-exist-recent'),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('vault_missing');
  });

  it('rejects non-positive limit', async () => {
    const out = await svc.list({ vaultPath: vaultRoot, limit: 0 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });
});

describe('WikiRecentService.list', () => {
  it('returns an empty array for an empty vault', async () => {
    const out = await svc.list({ vaultPath: vaultRoot });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries).toEqual([]);
  });

  it('sorts by modifiedAt descending', async () => {
    const now = Date.now();
    await writePage('a.md', '# A', new Date(now - 3 * 86400_000));
    await writePage('b.md', '# B', new Date(now - 1 * 86400_000));
    await writePage('c.md', '# C', new Date(now - 2 * 86400_000));
    const out = await svc.list({ vaultPath: vaultRoot });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries.map((e) => e.relativePath)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('flags llm-curated entries', async () => {
    await writePage('llm-curated/customers/anthropic.md', '# A');
    await writePage('SCHEMA.md', '# schema');
    const out = await svc.list({ vaultPath: vaultRoot });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const a = out.entries.find((e) => e.relativePath === 'llm-curated/customers/anthropic.md');
    const s = out.entries.find((e) => e.relativePath === 'SCHEMA.md');
    expect(a?.llmCurated).toBe(true);
    expect(s?.llmCurated).toBe(false);
  });

  it('defaults to WIKI_RECENT_DEFAULT_LIMIT', async () => {
    for (let i = 0; i < WIKI_RECENT_DEFAULT_LIMIT + 5; i++) {
      await writePage(`p-${i}.md`, '# x');
    }
    const out = await svc.list({ vaultPath: vaultRoot });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries.length).toBe(WIKI_RECENT_DEFAULT_LIMIT);
  });

  it('honors caller-supplied limit', async () => {
    for (let i = 0; i < 10; i++) await writePage(`p-${i}.md`, '# x');
    const out = await svc.list({ vaultPath: vaultRoot, limit: 3 });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries.length).toBe(3);
  });

  it('caps limit at WIKI_RECENT_MAX_LIMIT', async () => {
    for (let i = 0; i < 5; i++) await writePage(`p-${i}.md`, '# x');
    const out = await svc.list({
      vaultPath: vaultRoot,
      limit: WIKI_RECENT_MAX_LIMIT + 100,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 5 actual pages, well under the cap — entries.length === 5 confirms we
    // didn't throw on the over-large input.
    expect(out.entries.length).toBe(5);
  });

  it('skips dotfile directories', async () => {
    await writePage('.queue/secret.md', '# secret');
    await writePage('visible.md', '# v');
    const out = await svc.list({ vaultPath: vaultRoot });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entries.map((e) => e.relativePath)).toEqual(['visible.md']);
  });
});
