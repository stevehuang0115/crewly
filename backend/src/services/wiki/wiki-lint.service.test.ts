/**
 * Tests for WikiLintService.
 *
 * Uses real-filesystem scratch vaults (consistent with the bookkeep /
 * search service tests).
 *
 * @module services/wiki/wiki-lint.service.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  WikiLintService,
  WIKI_LINT_ROLLUP_THRESHOLD,
} from './wiki-lint.service.js';

let vaultRoot: string;
let svc: WikiLintService;

const SCHEMA_MD = `# test vault
vault_scope: project
vault_id: lint-test

hardcoded:
  - path: memory/
    frozen: true
    description: "Project-scoped facts."
    referenced_by:
      - skill:remember

  - path: sop-overrides/
    frozen: true
    description: "Project-specific SOP deltas."
    referenced_by:
      - skill:get-sops

llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [decisions, customers, log.md, index.md]
    llm_can_create_subdirs: true
    lint_may_restructure: true

write_policy:
  canonical:
    - team-leader
  proposed_only:
    - worker
  schema_writer:
    - steve
`;

async function writePage(rel: string, content: string): Promise<void> {
  const abs = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

beforeEach(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-lint-test-'));
  WikiLintService.resetInstance();
  svc = WikiLintService.getInstance();
  await writePage('SCHEMA.md', SCHEMA_MD);
});

afterEach(async () => {
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('WikiLintService input validation', () => {
  it('rejects relative vaultPath', async () => {
    const out = await svc.generate({ vaultPath: 'relative/here' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });

  it('rejects non-positive staleDays', async () => {
    const out = await svc.generate({ vaultPath: vaultRoot, staleDays: 0 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('invalid_input');
  });

  it('returns vault_missing for non-existent dir', async () => {
    const out = await svc.generate({
      vaultPath: path.join(os.tmpdir(), 'nope-not-here'),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('vault_missing');
  });

  it('returns schema_missing when SCHEMA.md is absent', async () => {
    await fs.rm(path.join(vaultRoot, 'SCHEMA.md'));
    const out = await svc.generate({ vaultPath: vaultRoot });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('schema_missing');
  });
});

describe('WikiLintService.generate', () => {
  it('returns a clean report for an empty vault', async () => {
    const out = await svc.generate({ vaultPath: vaultRoot });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.report.frozenPathRespected).toBe(true);
    expect(out.report.frozenViolations).toEqual([]);
    expect(out.report.missingEntities).toEqual([]);
    expect(out.report.orphanPages).toEqual([]);
    expect(out.report.staleClaims).toEqual([]);
    expect(out.report.restructureProposals).toEqual([]);
  });

  describe('frozen-path violations', () => {
    it('flags a date-prefixed page placed in a frozen folder', async () => {
      await writePage('memory/2026-05-22-leak.md', '# Leak');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.frozenPathRespected).toBe(false);
      expect(out.report.frozenViolations[0].path).toBe('memory/2026-05-22-leak.md');
      expect(out.report.frozenViolations[0].frozenFolder).toBe('memory');
    });

    it('flags a stray log.md inside a frozen folder', async () => {
      await writePage('memory/log.md', 'leaked log');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.frozenPathRespected).toBe(false);
    });

    it('ignores legitimate sibling content in a frozen folder', async () => {
      await writePage('memory/decisions.md', 'preexisting frozen page'); // no date prefix
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.frozenPathRespected).toBe(true);
    });
  });

  describe('missing entities', () => {
    it('flags wikilinks that do not resolve to any page', async () => {
      await writePage(
        'llm-curated/decisions/pricing.md',
        'see [[anthropic]] and [[ghost-page]] for context.',
      );
      await writePage('llm-curated/customers/anthropic.md', '# Anthropic');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.missingEntities.length).toBe(1);
      expect(out.report.missingEntities[0].target).toBe('ghost-page');
      expect(out.report.missingEntities[0].sourcePath).toBe(
        'llm-curated/decisions/pricing.md',
      );
    });

    it('resolves slashed wikilinks via suffix matching', async () => {
      await writePage('llm-curated/customers/anthropic.md', '# A');
      await writePage(
        'llm-curated/decisions/pricing.md',
        'see [[customers/anthropic]].',
      );
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.missingEntities).toEqual([]);
    });
  });

  describe('missing concepts (Karpathy lint contract)', () => {
    it('surfaces a target referenced 3+ times with no page', async () => {
      // "verify-output" mentioned in 4 distinct pages, but no
      // verify-output.md exists → load-bearing missing concept.
      await writePage(
        'llm-curated/log.md',
        '## 2026-05-01 — [[verify-output]] race observed in worker pool',
      );
      await writePage(
        'llm-curated/patterns/race-pool.md',
        '# Race pool\n\nsee [[verify-output]] for context',
      );
      await writePage(
        'llm-curated/decisions/2026-05-04-fix.md',
        '# Fix\n\nLink [[verify-output]] not yet authored.',
      );
      await writePage(
        'llm-curated/patterns/worker-claim.md',
        '# Worker claim\n\n[[verify-output]] flow needed here.',
      );
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const concept = out.report.missingConcepts.find((c) => c.target === 'verify-output');
      expect(concept).toBeDefined();
      expect(concept!.referenceCount).toBeGreaterThanOrEqual(4);
      expect(concept!.sources.length).toBeGreaterThanOrEqual(4);
    });

    it('does NOT surface one-off dangling refs (below threshold)', async () => {
      await writePage(
        'llm-curated/log.md',
        '## 2026-05-01 — [[some-typo-ref]] seen once',
      );
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const concept = out.report.missingConcepts.find((c) => c.target === 'some-typo-ref');
      expect(concept).toBeUndefined();
      // But it should still show up in missingEntities (per-occurrence).
      const dangling = out.report.missingEntities.find((e) => e.target === 'some-typo-ref');
      expect(dangling).toBeDefined();
    });

    it('sorts missingConcepts by referenceCount descending', async () => {
      // Concept A: 5 refs (no page)
      // Concept B: 3 refs (no page)
      await writePage('llm-curated/p1.md', 'A: [[topic-a]] [[topic-a]] [[topic-a]]');
      await writePage('llm-curated/p2.md', 'A: [[topic-a]] B: [[topic-b]]');
      await writePage('llm-curated/p3.md', 'A: [[topic-a]] B: [[topic-b]] B: [[topic-b]]');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const idxA = out.report.missingConcepts.findIndex((c) => c.target === 'topic-a');
      const idxB = out.report.missingConcepts.findIndex((c) => c.target === 'topic-b');
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThanOrEqual(0);
      expect(idxA).toBeLessThan(idxB);
    });

    it('does NOT surface targets that DO resolve to a page', async () => {
      // "anthropic" target appears 3 times AND anthropic.md exists → resolved, not missing.
      await writePage('llm-curated/customers/anthropic.md', '# Anthropic');
      await writePage('llm-curated/p1.md', '[[anthropic]] one');
      await writePage('llm-curated/p2.md', '[[anthropic]] two');
      await writePage('llm-curated/p3.md', '[[anthropic]] three');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const concept = out.report.missingConcepts.find((c) => c.target === 'anthropic');
      expect(concept).toBeUndefined();
    });
  });

  describe('orphans', () => {
    it('flags pages with no incoming wikilinks', async () => {
      await writePage('llm-curated/customers/anthropic.md', '# A');
      await writePage('llm-curated/customers/closie.md', '# C — unrelated');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.orphanPages).toContain('llm-curated/customers/anthropic.md');
      expect(out.report.orphanPages).toContain('llm-curated/customers/closie.md');
    });

    it('does not flag seed pages (log.md, index.md) as orphans', async () => {
      await writePage('llm-curated/log.md', '# log');
      await writePage('llm-curated/index.md', '# index');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.orphanPages).not.toContain('llm-curated/log.md');
      expect(out.report.orphanPages).not.toContain('llm-curated/index.md');
    });

    it('does not flag a page that has an incoming wikilink', async () => {
      await writePage('llm-curated/customers/anthropic.md', '# A');
      await writePage(
        'llm-curated/decisions/pricing.md',
        'see [[anthropic]] for the deal.',
      );
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.orphanPages).not.toContain(
        'llm-curated/customers/anthropic.md',
      );
    });
  });

  describe('stale claims', () => {
    it('flags files older than staleDays', async () => {
      await writePage('llm-curated/old.md', '# old');
      // Force the file's mtime ~200 days back.
      const past = Date.now() - 200 * 24 * 60 * 60 * 1000;
      await fs.utimes(
        path.join(vaultRoot, 'llm-curated/old.md'),
        new Date(past),
        new Date(past),
      );
      const out = await svc.generate({ vaultPath: vaultRoot, staleDays: 90 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.staleClaims).toContain('llm-curated/old.md');
    });
  });

  describe('restructure proposals', () => {
    it('proposes an index.md when a folder has many pages and no index', async () => {
      for (let i = 0; i < WIKI_LINT_ROLLUP_THRESHOLD + 1; i++) {
        await writePage(`llm-curated/decisions/d-${i}.md`, `# D${i}`);
      }
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const indexProposal = out.report.restructureProposals.find((p) =>
        p.description.includes('index.md'),
      );
      expect(indexProposal).toBeDefined();
      expect(indexProposal!.path).toBe('llm-curated/decisions');
    });

    it('does NOT propose index.md when one already exists', async () => {
      for (let i = 0; i < WIKI_LINT_ROLLUP_THRESHOLD + 1; i++) {
        await writePage(`llm-curated/decisions/d-${i}.md`, `# D${i}`);
      }
      await writePage('llm-curated/decisions/index.md', '# index');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const indexProposal = out.report.restructureProposals.find((p) =>
        p.description.includes('index.md'),
      );
      expect(indexProposal).toBeUndefined();
    });

    it('proposes merging near-duplicate filenames', async () => {
      await writePage('llm-curated/decisions/pricing-v1.md', '# v1');
      await writePage('llm-curated/decisions/pricing-v2.md', '# v2');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const mergeProposal = out.report.restructureProposals.find((p) =>
        p.description.includes('merging'),
      );
      expect(mergeProposal).toBeDefined();
    });

    it('does NOT cluster by date-prefix alone (only by content slug)', async () => {
      // Three pages with the same `2026-05-` date prefix but UNRELATED content.
      // The pre-fix lint would group them as a near-duplicate cluster. The
      // current lint strips the `YYYY-MM-DD-` prefix before clustering, so
      // these three should not produce a merge proposal.
      await writePage('llm-curated/patterns/2026-05-01-thing-alpha.md', '# alpha');
      await writePage('llm-curated/patterns/2026-05-02-other-beta.md', '# beta');
      await writePage('llm-curated/patterns/2026-05-03-third-gamma.md', '# gamma');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const bogusProposal = out.report.restructureProposals.find((p) =>
        /2026-05-/.test(p.description),
      );
      expect(bogusProposal).toBeUndefined();
    });

    it('strips ISO-timestamp slugs (handles YYYY-MM-DDtHH-MMz forms)', async () => {
      // Migrated memory entries sometimes embed full ISO timestamps as
      // the content slug (colons replaced with hyphens by slugifier).
      // Both forms must be stripped so the remaining content prefix is
      // what gets clustered.
      await writePage(
        'llm-curated/patterns/2026-05-06-2026-05-06t00-26z-wipe-incident-alpha.md',
        '# A',
      );
      await writePage(
        'llm-curated/patterns/2026-05-16-2026-05-16t01-20z-wipe-incident-beta.md',
        '# B',
      );
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const bogus = out.report.restructureProposals.find((p) =>
        /"2026-05-"/.test(p.description),
      );
      expect(bogus).toBeUndefined();
      const wipeCluster = out.report.restructureProposals.find((p) =>
        p.description.includes('wipe-inc'),
      );
      expect(wipeCluster).toBeDefined();
    });

    it('strips NESTED date prefixes (handles migration double-date filenames)', async () => {
      // Filenames like `2026-05-04-2026-05-04-audit-followup.md` occur
      // when the legacy content body itself started with a date and the
      // migrator also prepended the entry's createdAt. The pre-fix lint
      // would cluster these on the inner `2026-05-` and fire a noisy
      // "26 pages share 2026-05-" proposal. After repeated stripping
      // both files reduce to the SAME content prefix and cluster cleanly.
      await writePage(
        'llm-curated/patterns/2026-05-04-2026-05-04-audit-followup-one.md',
        '# A',
      );
      await writePage(
        'llm-curated/patterns/2026-05-15-2026-05-15-audit-followup-two.md',
        '# B',
      );
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const bogus2026 = out.report.restructureProposals.find((p) =>
        /"2026-05-"/.test(p.description),
      );
      expect(bogus2026).toBeUndefined();
      const auditMerge = out.report.restructureProposals.find((p) =>
        p.description.includes('audit-fo'),
      );
      expect(auditMerge).toBeDefined();
    });

    it('still clusters real near-duplicate content slugs after stripping the date prefix', async () => {
      // Two pages whose date differs but the content slug is the same prefix
      // — that's a real merge candidate.
      await writePage('llm-curated/patterns/2026-05-01-pricing-v1.md', '# pricing v1');
      await writePage('llm-curated/patterns/2026-05-15-pricing-v2.md', '# pricing v2');
      const out = await svc.generate({ vaultPath: vaultRoot });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      const mergeProposal = out.report.restructureProposals.find((p) =>
        p.description.includes('pricing-'),
      );
      expect(mergeProposal).toBeDefined();
    });
  });

  describe('staleClaims with frontmatter original_date', () => {
    it('uses original_date when present (even if mtime is fresh)', async () => {
      // File written today, but frontmatter says original_date 1 year ago.
      // Stale window is 30 days → this should be flagged.
      const yearAgoIso = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      await writePage(
        'llm-curated/decisions/migrated-old.md',
        `---\ntitle: "Old"\noriginal_date: "${yearAgoIso}"\n---\n\n# Old decision\n`,
      );
      const out = await svc.generate({ vaultPath: vaultRoot, staleDays: 30 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.staleClaims).toContain('llm-curated/decisions/migrated-old.md');
    });

    it('falls back to mtime when frontmatter has no original_date', async () => {
      await writePage(
        'llm-curated/decisions/no-frontmatter.md',
        '# No frontmatter — just markdown\n',
      );
      const past = Date.now() - 200 * 24 * 60 * 60 * 1000;
      await fs.utimes(
        path.join(vaultRoot, 'llm-curated/decisions/no-frontmatter.md'),
        new Date(past),
        new Date(past),
      );
      const out = await svc.generate({ vaultPath: vaultRoot, staleDays: 90 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.staleClaims).toContain(
        'llm-curated/decisions/no-frontmatter.md',
      );
    });

    it('does NOT flag a freshly migrated entry whose original_date is recent', async () => {
      const recentIso = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
      await writePage(
        'llm-curated/decisions/fresh.md',
        `---\ntitle: "Fresh"\noriginal_date: "${recentIso}"\n---\n\n# Fresh\n`,
      );
      const out = await svc.generate({ vaultPath: vaultRoot, staleDays: 30 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.report.staleClaims).not.toContain('llm-curated/decisions/fresh.md');
    });
  });
});
