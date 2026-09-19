/**
 * Tests for WikiQueryService.
 *
 * Coverage: log parse + entry ordering, page scoring + topK, frozen-path
 * exclusion (we only walk llm-curated/), input validation, and the
 * caller-notes contract that's a soft-spec guard for downstream LLMs.
 *
 * @module services/wiki/wiki-query.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WikiQueryService } from './wiki-query.service.js';

const PROJECT_VAULT_YAML = `
vault_scope: project
vault_id: crewly
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by: [skill:remember, skill:recall]
  - path: sop-overrides/
    frozen: true
    description: "Project SOP deltas."
    referenced_by: [skill:get-sops]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [decisions, people, log.md]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`;

describe('WikiQueryService', () => {
  let vault: string;
  let svc: WikiQueryService;

  beforeEach(async () => {
    WikiQueryService._resetForTesting();
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-query-test-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), PROJECT_VAULT_YAML, 'utf8');
    svc = new WikiQueryService();
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('rejects relative vaultPath', async () => {
      const r = await svc.query({ vaultPath: 'rel', query: 'x' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('invalid_input');
      expect(r.message).toMatch(/absolute/);
    });

    it('rejects empty query', async () => {
      const r = await svc.query({ vaultPath: vault, query: '   ' });
      expect(r.ok).toBe(false);
      if (r.ok || r.reason !== 'invalid_input') return;
      expect(r.message).toMatch(/non-empty/);
    });

    it('rejects non-positive topK', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'x', topK: 0 });
      expect(r.ok).toBe(false);
      if (r.ok || r.reason !== 'invalid_input') return;
      expect(r.message).toMatch(/topK/);
    });

    it('reports schema_missing when SCHEMA.md is absent', async () => {
      await fs.unlink(path.join(vault, 'SCHEMA.md'));
      const r = await svc.query({ vaultPath: vault, query: 'x' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('schema_missing');
    });
  });

  describe('happy path: empty vault', () => {
    it('returns context with no candidate pages + empty recentLog', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'pricing decision' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.vault.scope).toBe('project');
      expect(r.context.recentLog).toEqual([]);
      expect(r.context.candidatePages).toEqual([]);
      expect(r.context.schemaSummary.frozenPaths).toContain('memory/');
      expect(r.context.callerNotes.length).toBeGreaterThan(0);
    });
  });

  describe('recentLog parsing', () => {
    beforeEach(async () => {
      // Build a log.md with multiple entries mimicking the format
      // WikiIngestService emits.
      const log = [
        '# Activity log\n\nAppend-only log of ingested sources.\n',
        '\n## [2026-05-22T10:00:00.000Z] user_chat | user/steve\n\nref: chat:abc:1\n\nPricing locked at $999 setup + $799/month.\n',
        '\n## [2026-05-22T11:00:00.000Z] slack_message | user/steve\n\nref: slack://thread/2\n\nReviewed SLA targets.\n',
        '\n## [2026-05-22T12:00:00.000Z] pr_merge | system\n\nref: sha:def456\n\nMerged auth refactor.\n',
      ].join('');
      await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
      await fs.writeFile(path.join(vault, 'llm-curated/log.md'), log, 'utf8');
    });

    it('parses entries and returns them most-recent-first', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'pricing' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.recentLog).toHaveLength(3);
      expect(r.context.recentLog[0].timestamp).toBe('2026-05-22T12:00:00.000Z');
      expect(r.context.recentLog[0].sourceType).toBe('pr_merge');
      expect(r.context.recentLog[2].body).toContain('$999 setup');
    });

    it('honors recentLogEntries cap', async () => {
      const r = await svc.query({
        vaultPath: vault,
        query: 'pricing',
        recentLogEntries: 1,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.recentLog).toHaveLength(1);
      // Most-recent kept after slicing.
      expect(r.context.recentLog[0].sourceType).toBe('pr_merge');
    });
  });

  describe('candidate page ranking', () => {
    beforeEach(async () => {
      await fs.mkdir(path.join(vault, 'llm-curated/decisions'), { recursive: true });
      await fs.mkdir(path.join(vault, 'llm-curated/people'), { recursive: true });
      await fs.mkdir(path.join(vault, 'memory'), { recursive: true });

      await fs.writeFile(
        path.join(vault, 'llm-curated/decisions/2026-05-22-pricing.md'),
        '# Crewly Pro Pricing\n\nLocked at $999 setup + $799/month after pricing review. Pricing matters because conversion.',
        'utf8',
      );
      await fs.writeFile(
        path.join(vault, 'llm-curated/decisions/2026-05-21-auth.md'),
        '# Auth refactor\n\nDeprecated legacy session-cookie path.',
        'utf8',
      );
      await fs.writeFile(
        path.join(vault, 'llm-curated/people/steve.md'),
        '# Steve\n\nFounder & CEO. Drives pricing strategy.',
        'utf8',
      );
      // Decoy in FROZEN folder — should NOT be scanned.
      await fs.writeFile(
        path.join(vault, 'memory/leaked-pricing.md'),
        '# Memory pricing decoy\n\npricing pricing pricing pricing pricing',
        'utf8',
      );
    });

    it('returns top-K pages from llm-curated only', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'pricing', topK: 5 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const paths = r.context.candidatePages.map((p) => p.path);
      expect(paths.every((p) => p.startsWith('llm-curated/'))).toBe(true);
      expect(paths).not.toContain('memory/leaked-pricing.md');
    });

    it('ranks more-relevant pages higher', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'pricing' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // 2026-05-22-pricing.md mentions "pricing" 3x; people/steve.md once;
      // auth.md not at all.
      expect(r.context.candidatePages[0].path).toBe(
        'llm-curated/decisions/2026-05-22-pricing.md',
      );
      expect(r.context.candidatePages[0].score).toBeGreaterThan(
        r.context.candidatePages[1].score,
      );
    });

    it('caps topK', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'pricing', topK: 1 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.candidatePages).toHaveLength(1);
    });

    it('excludes log.md from candidate pages (surfaced via recentLog)', async () => {
      // Add a log.md that contains the query term — should be skipped.
      await fs.writeFile(
        path.join(vault, 'llm-curated/log.md'),
        '# Activity log\n\npricing pricing pricing pricing pricing',
        'utf8',
      );
      const r = await svc.query({ vaultPath: vault, query: 'pricing' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const paths = r.context.candidatePages.map((p) => p.path);
      expect(paths).not.toContain('llm-curated/log.md');
    });

    it('returns no candidates when the query matches nothing', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'quantum entanglement' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.context.candidatePages).toEqual([]);
    });
  });

  describe('caller-notes contract', () => {
    it('always includes the frozen-path refusal hint', async () => {
      const r = await svc.query({ vaultPath: vault, query: 'whatever' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const joined = r.context.callerNotes.join(' ');
      expect(joined).toMatch(/frozenPaths/);
      expect(joined).toMatch(/refuse/);
    });
  });

  describe('two-step retrieval (knowledge-base contract)', () => {
    const writePage = async (rel: string, fm: Record<string, unknown>, body: string) => {
      const { serializePage } = await import('./wiki-page.js');
      await fs.mkdir(path.dirname(path.join(vault, rel)), { recursive: true });
      await fs.writeFile(path.join(vault, rel), serializePage(fm, body), 'utf8');
    };

    beforeEach(async () => {
      const { WikiIndexService } = await import('./wiki-index.service.js');
      WikiIndexService._resetForTesting();
      await writePage('llm-curated/decisions/pricing.md', { title: 'Pricing', summary: 'Pro is $800 + credits', keep_because: 'hard_fact' }, '# Pricing\n\nPro costs $800 plus 1000 credits.');
      await writePage('llm-curated/decisions/pricing-old.md', { title: 'Pricing (old)', summary: 'Pro was $799', keep_because: 'hard_fact', superseded_by: 'llm-curated/decisions/pricing.md' }, '# Old\n\nPro cost $799 pricing.');
      await writePage('llm-curated/people/parent-notes.md', { title: 'Parent notes', summary: 'Teacher-only notes', keep_because: 'hard_fact', visibility: ['teacher'] }, '# Notes\n\npricing complaints from parents');
      await WikiIndexService.getInstance().rebuild(vault);
    });

    it('leads with the index, hides superseded and invisible pages, and returns requested pages in full', async () => {
      const step1 = await svc.query({ vaultPath: vault, query: 'pricing', agent: 'kai', viewerRole: 'developer' });
      expect(step1.ok).toBe(true);
      if (!step1.ok) return;
      expect(step1.context.index.text).toContain('[Pricing](llm-curated/decisions/pricing.md) — Pro is $800 + credits');
      expect(step1.context.index.text).toContain('⟶ superseded by');
      const paths = step1.context.candidatePages.map((c) => c.path);
      expect(paths).toContain('llm-curated/decisions/pricing.md');
      expect(paths).not.toContain('llm-curated/decisions/pricing-old.md'); // superseded
      expect(paths).not.toContain('llm-curated/people/parent-notes.md'); // teacher-only
      expect(step1.context.pages).toEqual([]);
      expect(step1.context.callerNotes[0]).toMatch(/Two-step/);

      const step2 = await svc.query({ vaultPath: vault, query: 'pricing', agent: 'kai', viewerRole: 'developer', pages: ['llm-curated/decisions/pricing.md', 'llm-curated/people/parent-notes.md', '../SCHEMA.md'] });
      expect(step2.ok).toBe(true);
      if (!step2.ok) return;
      expect(step2.context.pages.map((p) => p.path)).toEqual(['llm-curated/decisions/pricing.md']);
      expect(step2.context.pages[0].frontmatter.summary).toBe('Pro is $800 + credits');
      expect(step2.context.pages[0].content).toContain('1000 credits');

      // The teacher sees the teacher-only page; the owner (no role) sees everything incl. superseded on request.
      const teacher = await svc.query({ vaultPath: vault, query: 'pricing', viewerRole: 'teacher', pages: ['llm-curated/people/parent-notes.md'] });
      expect(teacher.ok && teacher.context.pages.length).toBe(1);
      const owner = await svc.query({ vaultPath: vault, query: 'pricing', includeSuperseded: true });
      expect(owner.ok && owner.context.candidatePages.map((c) => c.path)).toContain('llm-curated/decisions/pricing-old.md');
    });

    it('writes every query to the usage ledger and marks misses', async () => {
      const { WikiUsageService } = await import('./wiki-usage.service.js');
      await svc.query({ vaultPath: vault, query: 'pricing', agent: 'kai' });
      await svc.query({ vaultPath: vault, query: 'zzqx nonexistent topic', agent: 'kai' });
      const report = await WikiUsageService.getInstance().report(vault, 7);
      expect(report.queries).toBe(2);
      expect(report.misses).toBe(1);
      expect(report.missedQueries).toEqual(['zzqx nonexistent topic']);
      expect(report.topPages[0].path).toBe('llm-curated/decisions/pricing.md');
    });
  });
});
