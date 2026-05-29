/**
 * Tests for WikiBacklinksService.
 *
 * @module services/wiki/wiki-backlinks.service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  WikiBacklinksService,
  wikilinkMatchesTarget,
  WIKI_BACKLINKS_MAX_SNIPPETS_PER_FILE,
} from './wiki-backlinks.service.js';

let vaultRoot: string;
let svc: WikiBacklinksService;

async function writePage(rel: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-backlinks-test-'));
  WikiBacklinksService.resetInstance();
  svc = WikiBacklinksService.getInstance();
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('wikilinkMatchesTarget', () => {
  const target = 'llm-curated/customers/anthropic.md';

  it('matches exact relative path', () => {
    expect(wikilinkMatchesTarget('llm-curated/customers/anthropic.md', target)).toBe(true);
    expect(wikilinkMatchesTarget('llm-curated/customers/anthropic', target)).toBe(true);
  });

  it('matches suffix path', () => {
    expect(wikilinkMatchesTarget('customers/anthropic', target)).toBe(true);
    expect(wikilinkMatchesTarget('customers/anthropic.md', target)).toBe(true);
  });

  it('matches basename', () => {
    expect(wikilinkMatchesTarget('anthropic', target)).toBe(true);
    expect(wikilinkMatchesTarget('Anthropic', target)).toBe(true);
  });

  it('does not match unrelated names', () => {
    expect(wikilinkMatchesTarget('closie', target)).toBe(false);
    expect(wikilinkMatchesTarget('anthropic-other', target)).toBe(false);
  });

  it('does not loose-match partial paths that include slashes', () => {
    // Slashed wikilinks fall through to suffix-only matching — no basename fallback.
    expect(wikilinkMatchesTarget('not/anthropic', target)).toBe(false);
  });

  it('rejects empty target', () => {
    expect(wikilinkMatchesTarget('', target)).toBe(false);
    expect(wikilinkMatchesTarget('   ', target)).toBe(false);
  });
});

describe('WikiBacklinksService.find', () => {
  it('returns invalid_input for missing relativePath', async () => {
    await writePage('SCHEMA.md', '');
    const out = await svc.find({ vaultPath: vaultRoot, relativePath: '' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });

  it('returns invalid_input for non-md relativePath', async () => {
    await writePage('SCHEMA.md', '');
    const out = await svc.find({ vaultPath: vaultRoot, relativePath: 'page.txt' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });

  it('returns vault_missing when path does not exist', async () => {
    const out = await svc.find({
      vaultPath: path.join(os.tmpdir(), 'does-not-exist-xyz'),
      relativePath: 'a.md',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('vault_missing');
  });

  it('finds a single basename-style backlink', async () => {
    await writePage('llm-curated/customers/anthropic.md', '# Anthropic');
    await writePage(
      'llm-curated/decisions/pricing.md',
      '# Pricing\n\nLocked after [[anthropic]] pilot.\n',
    );
    const out = await svc.find({
      vaultPath: vaultRoot,
      relativePath: 'llm-curated/customers/anthropic.md',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backlinks).toHaveLength(1);
    expect(out.backlinks[0].relativePath).toBe('llm-curated/decisions/pricing.md');
    expect(out.backlinks[0].snippets[0].text.toLowerCase()).toContain('[[anthropic]]');
  });

  it('finds path-style backlinks', async () => {
    await writePage('llm-curated/customers/anthropic.md', '# Anthropic');
    await writePage(
      'llm-curated/decisions/pricing.md',
      'see [[customers/anthropic]] for the deal.',
    );
    const out = await svc.find({
      vaultPath: vaultRoot,
      relativePath: 'llm-curated/customers/anthropic.md',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backlinks).toHaveLength(1);
  });

  it('does not self-link', async () => {
    await writePage(
      'llm-curated/customers/anthropic.md',
      'Self-ref [[anthropic]] — should not count.',
    );
    const out = await svc.find({
      vaultPath: vaultRoot,
      relativePath: 'llm-curated/customers/anthropic.md',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backlinks).toEqual([]);
  });

  it('caps snippets per file', async () => {
    await writePage('llm-curated/customers/anthropic.md', '# A');
    const refs = Array.from(
      { length: 5 },
      (_, i) => `line ${i}: see [[anthropic]] here`,
    ).join('\n');
    await writePage('llm-curated/decisions/pricing.md', refs);
    const out = await svc.find({
      vaultPath: vaultRoot,
      relativePath: 'llm-curated/customers/anthropic.md',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backlinks[0].snippets.length).toBe(WIKI_BACKLINKS_MAX_SNIPPETS_PER_FILE);
  });

  it('ignores wikilinks that do not resolve to this target', async () => {
    await writePage('llm-curated/customers/anthropic.md', '# A');
    await writePage(
      'llm-curated/decisions/pricing.md',
      'see [[closie]] and [[other]] — not anthropic.',
    );
    const out = await svc.find({
      vaultPath: vaultRoot,
      relativePath: 'llm-curated/customers/anthropic.md',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backlinks).toEqual([]);
  });

  it('handles alias form [[target|alias]]', async () => {
    await writePage('llm-curated/customers/anthropic.md', '# A');
    await writePage(
      'llm-curated/decisions/pricing.md',
      'see [[customers/anthropic|Anthropic]] for context.',
    );
    const out = await svc.find({
      vaultPath: vaultRoot,
      relativePath: 'llm-curated/customers/anthropic.md',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.backlinks).toHaveLength(1);
  });
});
