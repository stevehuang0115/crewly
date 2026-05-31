/**
 * Tests for WikiSearchService.
 *
 * Uses an os.tmpdir scratch vault so we exercise real filesystem walks
 * (matches how the other wiki services are tested).
 *
 * @module services/wiki/wiki-search.service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  WikiSearchService,
  WIKI_SEARCH_MAX_QUERY_LENGTH,
  WIKI_SEARCH_MAX_SNIPPETS_PER_FILE,
} from './wiki-search.service.js';

let vaultRoot: string;
let svc: WikiSearchService;

async function writePage(rel: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-search-test-'));
  WikiSearchService.resetInstance();
  svc = WikiSearchService.getInstance();
  // Minimal vault skeleton.
  await writePage('SCHEMA.md', 'vault_scope: project\nvault_id: test\n');
  await writePage(
    'llm-curated/customers/anthropic.md',
    'Anthropic SMB pilot signed at $799/month.\nFirst paid SMB customer.\n',
  );
  await writePage(
    'llm-curated/customers/closie.md',
    'Closie is a separate project — not under Crewly Pro.\n',
  );
  await writePage(
    'llm-curated/decisions/pricing.md',
    '# Pricing decision\n\n$799 setup, $999/mo (locked).\n',
  );
  await writePage(
    'llm-curated/log.md',
    'Activity log.\n2026-05-22 — Anthropic pilot ingested.\n',
  );
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('WikiSearchService', () => {
  describe('input validation', () => {
    it('rejects relative vaultPath', async () => {
      const result = await svc.search({ vaultPath: 'relative/path', query: 'x' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_input');
    });

    it('returns vault_missing when path does not exist', async () => {
      const result = await svc.search({
        vaultPath: path.join(os.tmpdir(), 'definitely-not-here'),
        query: 'x',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('vault_missing');
    });

    it('rejects empty query', async () => {
      const result = await svc.search({ vaultPath: vaultRoot, query: '   ' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_query');
    });

    it('rejects oversize query', async () => {
      const result = await svc.search({
        vaultPath: vaultRoot,
        query: 'a'.repeat(WIKI_SEARCH_MAX_QUERY_LENGTH + 1),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid_query');
    });
  });

  describe('matching', () => {
    it('finds a content match and includes a line-number snippet', async () => {
      const result = await svc.search({ vaultPath: vaultRoot, query: 'anthropic' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const anthropic = result.hits.find((h) => h.relativePath.endsWith('anthropic.md'));
      expect(anthropic).toBeDefined();
      expect(anthropic!.matchCount).toBeGreaterThan(0);
      expect(anthropic!.snippets[0].lineNumber).toBe(1);
      expect(anthropic!.snippets[0].text.toLowerCase()).toContain('anthropic');
    });

    it('matches by filename even when content has no hits', async () => {
      await writePage('llm-curated/people/special-name.md', 'no body match here\n');
      const result = await svc.search({ vaultPath: vaultRoot, query: 'special-name' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hit = result.hits.find((h) => h.relativePath.endsWith('special-name.md'));
      expect(hit).toBeDefined();
      expect(hit!.filenameMatch).toBe(true);
    });

    it('is case-insensitive', async () => {
      const lower = await svc.search({ vaultPath: vaultRoot, query: 'pricing' });
      const upper = await svc.search({ vaultPath: vaultRoot, query: 'PRICING' });
      expect(lower.ok).toBe(true);
      expect(upper.ok).toBe(true);
      if (!lower.ok || !upper.ok) return;
      expect(upper.hits.length).toBe(lower.hits.length);
    });

    it('returns multiple files when query spans them', async () => {
      const result = await svc.search({ vaultPath: vaultRoot, query: '$799' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const paths = result.hits.map((h) => h.relativePath);
      expect(paths).toContain('llm-curated/customers/anthropic.md');
      expect(paths).toContain('llm-curated/decisions/pricing.md');
    });

    it('caps snippets per file', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join('\n');
      await writePage('llm-curated/big.md', lines);
      const result = await svc.search({ vaultPath: vaultRoot, query: 'match' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const big = result.hits.find((h) => h.relativePath.endsWith('big.md'));
      expect(big).toBeDefined();
      expect(big!.matchCount).toBe(20);
      expect(big!.snippets.length).toBe(WIKI_SEARCH_MAX_SNIPPETS_PER_FILE);
    });

    it('skips dotfile directories like .queue', async () => {
      await writePage('.queue/secret.md', 'pricing inside queue');
      const result = await svc.search({ vaultPath: vaultRoot, query: 'queue' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const queueHit = result.hits.find((h) => h.relativePath.startsWith('.queue/'));
      expect(queueHit).toBeUndefined();
    });

    it('skips non-md files', async () => {
      await writePage('llm-curated/notes.txt', 'pricing text file');
      const result = await svc.search({ vaultPath: vaultRoot, query: 'pricing' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const txt = result.hits.find((h) => h.relativePath.endsWith('.txt'));
      expect(txt).toBeUndefined();
    });

    it('returns empty hits when nothing matches', async () => {
      // Single nonsense token: BM25 matches at the term level, so use a query
      // that tokenises to one term present in no document.
      const result = await svc.search({ vaultPath: vaultRoot, query: 'zzzzzqqqqq' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hits).toEqual([]);
      expect(result.truncated).toBe(false);
    });
  });

  describe('BM25 scoring', () => {
    it('exposes a positive BM25 score on hits', async () => {
      const result = await svc.search({ vaultPath: vaultRoot, query: 'anthropic' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.hits[0].score).toBeGreaterThan(0);
    });

    it('matches at the term level (multi-word query is OR over terms)', async () => {
      const result = await svc.search({ vaultPath: vaultRoot, query: 'anthropic pricing' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const paths = result.hits.map((h) => h.relativePath);
      expect(paths).toContain('llm-curated/customers/anthropic.md');
      expect(paths).toContain('llm-curated/decisions/pricing.md');
    });

    it('ranks a rare term above a doc that only matches a common term', async () => {
      // "the" is common (appears everywhere we add); "zephyr" is rare → higher idf.
      await writePage('llm-curated/common-a.md', 'the the the the the the the the');
      await writePage('llm-curated/common-b.md', 'the the the the the the the the');
      await writePage('llm-curated/rare.md', 'the zephyr protocol');
      const result = await svc.search({ vaultPath: vaultRoot, query: 'zephyr the' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // The doc containing the rare term should rank first.
      expect(result.hits[0].relativePath).toBe('llm-curated/rare.md');
    });

    it('tokenises and matches CJK (Chinese) content', async () => {
      await writePage('llm-curated/zh.md', '小红书运营策略：每天发布三篇笔记。\n');
      const result = await svc.search({ vaultPath: vaultRoot, query: '小红书' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const zh = result.hits.find((h) => h.relativePath.endsWith('zh.md'));
      expect(zh).toBeDefined();
      expect(zh!.snippets.length).toBeGreaterThan(0);
    });
  });

  describe('ranking', () => {
    it('ranks filename matches above content-only matches', async () => {
      // "anthropic.md" filename hits "anthropic"; "closie.md" body merely
      // mentions the word once. Filename match must come first.
      await writePage('llm-curated/people/anthropic-team.md', 'no body match');
      await writePage(
        'llm-curated/people/closie.md',
        'closie talked about anthropic once',
      );
      const result = await svc.search({ vaultPath: vaultRoot, query: 'anthropic' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const idxFilename = result.hits.findIndex((h) =>
        h.relativePath.endsWith('anthropic-team.md'),
      );
      const idxBodyOnly = result.hits.findIndex((h) =>
        h.relativePath.endsWith('closie.md'),
      );
      expect(idxFilename).toBeGreaterThanOrEqual(0);
      expect(idxBodyOnly).toBeGreaterThan(idxFilename);
    });

    it('within filename/content tier ranks by matchCount descending', async () => {
      await writePage('llm-curated/decisions/one-hit.md', 'pricing mentioned once');
      await writePage(
        'llm-curated/decisions/many-hits.md',
        'pricing pricing pricing — three mentions of pricing',
      );
      const result = await svc.search({ vaultPath: vaultRoot, query: 'pricing' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const idxMany = result.hits.findIndex((h) =>
        h.relativePath.endsWith('many-hits.md'),
      );
      const idxOne = result.hits.findIndex((h) => h.relativePath.endsWith('one-hit.md'));
      expect(idxMany).toBeLessThan(idxOne);
    });
  });
});

describe('WikiSearchService — overlay (sop/team-norm) content', () => {
  let teamRoot: string;
  let vault: string;
  let svc: WikiSearchService;

  beforeEach(async () => {
    // Vault at <teamRoot>/wiki so the overlay siblings (sops/, norms/) sit
    // under <teamRoot> — matching the real ~/.crewly/teams/<id>/ layout.
    teamRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-search-overlay-'));
    vault = path.join(teamRoot, 'wiki');
    await fs.mkdir(vault, { recursive: true });
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), 'vault_scope: team\n', 'utf8');
    // Installed/custom SOP + a team norm live in sibling dirs.
    await fs.mkdir(path.join(teamRoot, 'sops', 'common'), { recursive: true });
    await fs.writeFile(
      path.join(teamRoot, 'sops', 'common', 'blocker-handling.md'),
      '# Blocker Handling\nEscalate blockers within 30 minutes.\n',
      'utf8',
    );
    await fs.mkdir(path.join(teamRoot, 'norms'), { recursive: true });
    await fs.writeFile(
      path.join(teamRoot, 'norms', 'delegation.md'),
      '# Delegation\nLeads delegate within their own team only.\n',
      'utf8',
    );
    WikiSearchService.resetInstance();
    svc = WikiSearchService.getInstance();
  });

  afterEach(async () => {
    await fs.rm(teamRoot, { recursive: true, force: true });
  });

  it('finds SOP content under the sop/ overlay prefix', async () => {
    const result = await svc.search({ vaultPath: vault, query: 'escalate' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.hits.find((h) => h.relativePath === 'sop/common/blocker-handling.md');
    expect(hit).toBeDefined();
    expect(hit!.matchCount).toBeGreaterThan(0);
  });

  it('finds team-norm content under the team-norm/ overlay prefix', async () => {
    const result = await svc.search({ vaultPath: vault, query: 'delegate' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.hits.find((h) => h.relativePath === 'team-norm/delegation.md');
    expect(hit).toBeDefined();
  });
});
