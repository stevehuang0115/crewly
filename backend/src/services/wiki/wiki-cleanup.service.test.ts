/**
 * Tests for WikiCleanupService.
 *
 * Coverage:
 *   - scan: rule application (confidence threshold, agent memory dump,
 *     per-agent cap), frozen-folder exclusion, truncation
 *   - apply: deletion + archive + manifest invalidation + safe-path guard
 *   - parseFrontmatter / parseConfidence: edge cases (quoted, missing,
 *     malformed)
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  WikiCleanupService,
  parseFrontmatter,
  parseConfidence,
  WIKI_CLEANUP_ARCHIVE_FILENAME,
} from './wiki-cleanup.service.js';

jest.mock('../core/logger.service.js', () => ({
  LoggerService: {
    getInstance: () => ({
      createComponentLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
      }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface PageSpec {
  relPath: string;
  confidence?: number | null | string;
  migratedFrom?: string;
  originalAuthor?: string;
  originalId?: string;
  originalDate?: string;
  body?: string;
}

async function writePage(vault: string, spec: PageSpec): Promise<void> {
  const fmLines: string[] = ['---'];
  if (spec.confidence !== undefined && spec.confidence !== null) {
    fmLines.push(`confidence: ${spec.confidence}`);
  }
  if (spec.migratedFrom) fmLines.push(`migrated_from: "${spec.migratedFrom}"`);
  if (spec.originalAuthor) fmLines.push(`original_author: "${spec.originalAuthor}"`);
  if (spec.originalId) fmLines.push(`original_id: "${spec.originalId}"`);
  if (spec.originalDate) fmLines.push(`original_date: "${spec.originalDate}"`);
  fmLines.push('---');
  const body = spec.body ?? `# ${path.basename(spec.relPath, '.md')}\n\nContent.`;
  const abs = path.join(vault, spec.relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, fmLines.join('\n') + '\n' + body, 'utf8');
}

async function makeVault(specs: PageSpec[]): Promise<string> {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-cleanup-test-'));
  // Marker file so the bootstrap-like checks in production code don't get
  // confused — not strictly required by the cleanup service but mirrors
  // the real vault shape.
  await fs.writeFile(path.join(vault, 'SCHEMA.md'), '# Test vault\n', 'utf8');
  for (const s of specs) await writePage(vault, s);
  return vault;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

describe('WikiCleanupService.scan', () => {
  beforeEach(() => {
    WikiCleanupService.resetInstance();
  });

  it('flags pages with confidence below the threshold', async () => {
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/low-a.md', confidence: 0.3, originalAuthor: 'alice', originalId: 'low-a' },
      { relPath: 'llm-curated/patterns/mid-b.md', confidence: 0.5, originalAuthor: 'bob', originalId: 'mid-b' },
      { relPath: 'llm-curated/patterns/high-c.md', confidence: 0.9, originalAuthor: 'carol', originalId: 'high-c' },
    ]);

    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: vault,
      rules: { minConfidence: 0.5, dropAgentMemoryDumps: false },
    });

    if (!result.ok || !('candidates' in result)) throw new Error('expected scan result');
    expect(result.candidates.map((c) => c.relPath)).toEqual(['llm-curated/patterns/low-a.md']);
    expect(result.summary.lowConfidence).toBe(1);
    await fs.rm(vault, { recursive: true });
  });

  it('never flags the orchestrator’s own notes for cleanup (self-loop guard)', async () => {
    // Root cause B: orc notes mis-filed into a (customer) vault, flagged
    // low-quality, re-dispatched as cleanup → orc writes more → loop. The
    // orc-authored page must be excluded even though its confidence is low.
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/orc-note.md', confidence: 0.2, originalAuthor: 'crewly-orc', originalId: 'orc-1' },
      { relPath: 'llm-curated/patterns/user-junk.md', confidence: 0.2, originalAuthor: 'alice', originalId: 'usr-1' },
    ]);

    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: vault,
      rules: { minConfidence: 0.5, dropAgentMemoryDumps: false },
    });

    if (!result.ok || !('candidates' in result)) throw new Error('expected scan result');
    // Only the non-orc low-confidence page is a candidate.
    expect(result.candidates.map((c) => c.relPath)).toEqual(['llm-curated/patterns/user-junk.md']);
    await fs.rm(vault, { recursive: true });
  });

  it('flags pages migrated_from "agent/.../memory.json"', async () => {
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/a.md', migratedFrom: 'agent/crewly-orc/memory.json', confidence: 0.9, originalId: 'mem-a' },
      { relPath: 'llm-curated/patterns/b.md', migratedFrom: 'agent/crewly-orc/decisions.json', confidence: 0.9, originalId: 'dec-b' },
      { relPath: 'llm-curated/patterns/c.md', confidence: 0.9, originalId: 'org-c' },
    ]);

    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: vault,
      rules: { minConfidence: 0, dropAgentMemoryDumps: true },
    });
    if (!result.ok || !('candidates' in result)) throw new Error('expected scan result');
    expect(result.candidates.map((c) => c.relPath)).toEqual(['llm-curated/patterns/a.md']);
    expect(result.summary.agentMemoryDump).toBe(1);
    await fs.rm(vault, { recursive: true });
  });

  it('applies the per-agent cap to non-already-flagged pages only', async () => {
    // alice has 5 pages all confidence 0.9. With maxPerAgent=2, the
    // bottom 3 (by confidence/date) should be flagged. bob has 1 page,
    // not capped.
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/a1.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a1', originalDate: '2026-05-01' },
      { relPath: 'llm-curated/patterns/a2.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a2', originalDate: '2026-05-02' },
      { relPath: 'llm-curated/patterns/a3.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a3', originalDate: '2026-05-03' },
      { relPath: 'llm-curated/patterns/a4.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a4', originalDate: '2026-05-04' },
      { relPath: 'llm-curated/patterns/a5.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a5', originalDate: '2026-05-05' },
      { relPath: 'llm-curated/patterns/b1.md', confidence: 0.9, originalAuthor: 'bob', originalId: 'b1' },
    ]);

    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: vault,
      rules: { minConfidence: 0, dropAgentMemoryDumps: false, maxPerAgent: 2 },
    });
    if (!result.ok || !('candidates' in result)) throw new Error('expected scan result');
    // 5 alice pages → 3 over the cap, 1 bob page → 0 over the cap.
    expect(result.summary.perAgentCapped).toBe(3);
    // The 3 lowest by (confidence desc, date desc) → a1, a2, a3 (oldest).
    const capped = result.candidates.filter((c) => c.reasons.some((r) => r.includes('per-agent cap')));
    expect(capped.map((c) => c.relPath).sort()).toEqual([
      'llm-curated/patterns/a1.md',
      'llm-curated/patterns/a2.md',
      'llm-curated/patterns/a3.md',
    ]);
    await fs.rm(vault, { recursive: true });
  });

  it('does not double-flag a page: low-confidence pages are excluded from the per-agent cap input', async () => {
    // alice has 3 pages, 1 low-confidence. With maxPerAgent=1, only the
    // top 1 (out of the 2 non-flagged) survives — so the cap should drop
    // 1 more, not 2.
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/a1.md', confidence: 0.3, originalAuthor: 'alice', originalId: 'a1' }, // low-conf
      { relPath: 'llm-curated/patterns/a2.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a2', originalDate: '2026-05-02' },
      { relPath: 'llm-curated/patterns/a3.md', confidence: 0.9, originalAuthor: 'alice', originalId: 'a3', originalDate: '2026-05-03' },
    ]);

    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: vault,
      rules: { minConfidence: 0.5, dropAgentMemoryDumps: false, maxPerAgent: 1 },
    });
    if (!result.ok || !('candidates' in result)) throw new Error('expected scan result');
    expect(result.summary.lowConfidence).toBe(1);
    expect(result.summary.perAgentCapped).toBe(1); // a2 OR a3 (whichever loses tie-break)
    await fs.rm(vault, { recursive: true });
  });

  it('skips frozen folders (memory, sop, sop-overrides, okr)', async () => {
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/visible.md', confidence: 0.3, originalId: 'visible' },
      { relPath: 'memory/secret.md', confidence: 0.3, originalId: 'frozen-mem' },
      { relPath: 'sop/frozen.md', confidence: 0.3, originalId: 'frozen-sop' },
    ]);

    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: vault,
      rules: { minConfidence: 0.5 },
    });
    if (!result.ok || !('candidates' in result)) throw new Error('expected scan result');
    expect(result.candidates.map((c) => c.relPath)).toEqual(['llm-curated/patterns/visible.md']);
    await fs.rm(vault, { recursive: true });
  });

  it('returns ok:false with vault_missing for absent paths', async () => {
    const result = await WikiCleanupService.getInstance().scan({
      vaultPath: '/definitely/not/a/real/path-xyz',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('vault_missing');
  });
});

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

describe('WikiCleanupService.apply', () => {
  beforeEach(() => {
    WikiCleanupService.resetInstance();
  });

  it('deletes listed pages, archives their body + frontmatter', async () => {
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/drop-1.md', confidence: 0.3, originalId: 'src-1', body: '# drop-1\n\nBody A.' },
      { relPath: 'llm-curated/patterns/keep.md', confidence: 0.9, originalId: 'src-keep', body: '# keep\n\nBody K.' },
    ]);

    const result = await WikiCleanupService.getInstance().apply({
      vaultPath: vault,
      pages: ['llm-curated/patterns/drop-1.md'],
    });
    if (!result.ok || !('deleted' in result)) throw new Error('expected apply result');
    expect(result.deleted).toEqual(['llm-curated/patterns/drop-1.md']);
    expect(result.skipped).toEqual([]);

    // File removed.
    await expect(fs.access(path.join(vault, 'llm-curated/patterns/drop-1.md'))).rejects.toThrow();
    // Sibling untouched.
    await fs.access(path.join(vault, 'llm-curated/patterns/keep.md'));

    // Archive has the body + frontmatter.
    const archive = JSON.parse(await fs.readFile(path.join(vault, WIKI_CLEANUP_ARCHIVE_FILENAME), 'utf8'));
    expect(archive.version).toBe(1);
    expect(archive.entries).toHaveLength(1);
    expect(archive.entries[0].relPath).toBe('llm-curated/patterns/drop-1.md');
    expect(archive.entries[0].body).toContain('Body A');
    expect(archive.entries[0].frontmatter.original_id).toBe('src-1');

    await fs.rm(vault, { recursive: true });
  });

  it('does NOT modify the migrate manifest (regression: 2026-05-28 deletion-resurrection loop)', async () => {
    // The migrate manifest is what makes `wiki-migrate --apply`
    // IDEMPOTENT. Removing the matching entries on cleanup means the
    // next migrate tick re-imports the page we just deleted — observed
    // 2026-05-28 ~05:30 with the original 20 deletes immediately
    // resurrected on the next bridge tick. Cleanup leaves the page on
    // disk gone; that is the whole job. The manifest stays intact so
    // future migrate-applies see "already migrated" and skip.
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/m1.md', confidence: 0.3, originalId: 'mig-id-1' },
      { relPath: 'llm-curated/patterns/m2.md', confidence: 0.3, originalId: 'mig-id-2' },
    ]);
    const manifestPath = path.join(vault, '.migration-state.json');
    const originalManifest = {
      version: 1,
      entries: [
        { sourceId: 'mig-id-1', contentHash: 'aa', targetRelativePath: 'llm-curated/patterns/m1.md', migratedAt: '2026-05-27' },
        { sourceId: 'mig-id-2', contentHash: 'bb', targetRelativePath: 'llm-curated/patterns/m2.md', migratedAt: '2026-05-27' },
        { sourceId: 'kept-id', contentHash: 'cc', targetRelativePath: 'llm-curated/patterns/keep.md', migratedAt: '2026-05-27' },
      ],
    };
    await fs.writeFile(manifestPath, JSON.stringify(originalManifest), 'utf8');

    const result = await WikiCleanupService.getInstance().apply({
      vaultPath: vault,
      pages: ['llm-curated/patterns/m1.md', 'llm-curated/patterns/m2.md'],
    });
    if (!result.ok || !('manifestEntriesInvalidated' in result)) throw new Error('expected apply result');
    expect(result.deleted).toEqual(['llm-curated/patterns/m1.md', 'llm-curated/patterns/m2.md']);
    // Critical: manifest must be untouched (mig-id-1 + mig-id-2 still
    // present), so the next `wiki-migrate --apply` sees "already
    // migrated" by sourceId+hash and skips re-import.
    expect(result.manifestEntriesInvalidated).toBe(0);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries.map((e: { sourceId: string }) => e.sourceId).sort()).toEqual([
      'kept-id',
      'mig-id-1',
      'mig-id-2',
    ]);
    await fs.rm(vault, { recursive: true });
  });

  it('skips not_found / outside_vault / frozen paths without throwing', async () => {
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/real.md', confidence: 0.3, originalId: 'real-id' },
    ]);
    const result = await WikiCleanupService.getInstance().apply({
      vaultPath: vault,
      pages: [
        'llm-curated/patterns/real.md',
        'llm-curated/patterns/ghost.md', // doesn't exist
        '../../../etc/passwd', // path traversal
        'memory/secret.md', // frozen folder
      ],
    });
    if (!result.ok || !('skipped' in result)) throw new Error('expected apply result');
    expect(result.deleted).toEqual(['llm-curated/patterns/real.md']);
    const reasons = result.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['frozen', 'not_found', 'outside_vault']);
    await fs.rm(vault, { recursive: true });
  });

  it('appends to an existing archive instead of overwriting', async () => {
    const vault = await makeVault([
      { relPath: 'llm-curated/patterns/a.md', confidence: 0.3, originalId: 'a-id' },
      { relPath: 'llm-curated/patterns/b.md', confidence: 0.3, originalId: 'b-id' },
    ]);
    await WikiCleanupService.getInstance().apply({
      vaultPath: vault,
      pages: ['llm-curated/patterns/a.md'],
    });
    await WikiCleanupService.getInstance().apply({
      vaultPath: vault,
      pages: ['llm-curated/patterns/b.md'],
    });
    const archive = JSON.parse(await fs.readFile(path.join(vault, WIKI_CLEANUP_ARCHIVE_FILENAME), 'utf8'));
    expect(archive.entries).toHaveLength(2);
    expect(archive.entries.map((e: { relPath: string }) => e.relPath).sort()).toEqual([
      'llm-curated/patterns/a.md',
      'llm-curated/patterns/b.md',
    ]);
    await fs.rm(vault, { recursive: true });
  });

  it('returns ok:false for empty pages list', async () => {
    const vault = await makeVault([]);
    const result = await WikiCleanupService.getInstance().apply({ vaultPath: vault, pages: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid_input');
    await fs.rm(vault, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('parseConfidence', () => {
  it('accepts numeric values', () => {
    expect(parseConfidence(0.3)).toBe(0.3);
    expect(parseConfidence(0)).toBe(0);
    expect(parseConfidence(1)).toBe(1);
  });
  it('accepts string numeric values', () => {
    expect(parseConfidence('0.3')).toBe(0.3);
    expect(parseConfidence('"0.5"')).toBe(null); // parseFloat('"0.5"') = NaN
    expect(parseConfidence('0.5"')).toBe(0.5);
  });
  it('returns null for missing/unparseable', () => {
    expect(parseConfidence(undefined)).toBe(null);
    expect(parseConfidence(null)).toBe(null);
    expect(parseConfidence('high')).toBe(null);
    expect(parseConfidence({})).toBe(null);
  });
});

describe('parseFrontmatter', () => {
  it('parses key:value frontmatter into a record', () => {
    const { frontmatter, body } = parseFrontmatter(
      '---\ntitle: "X"\nconfidence: 0.5\nrouting_uncertain: false\n---\n\nBody.',
    );
    expect(frontmatter).toEqual({ title: 'X', confidence: 0.5, routing_uncertain: false });
    expect(body.trim()).toBe('Body.');
  });
  it('returns empty frontmatter when no `---` block is present', () => {
    const { frontmatter, body } = parseFrontmatter('# Plain page\n\nNo frontmatter.');
    expect(frontmatter).toEqual({});
    expect(body).toContain('Plain page');
  });
  it('strips both single and double quotes from values', () => {
    const { frontmatter } = parseFrontmatter(
      `---\na: "double"\nb: 'single'\nc: unquoted\n---\n`,
    );
    expect(frontmatter).toEqual({ a: 'double', b: 'single', c: 'unquoted' });
  });
});
