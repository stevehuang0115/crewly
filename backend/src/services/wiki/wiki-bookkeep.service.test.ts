/**
 * Tests for WikiBookkeepService.
 *
 * @module services/wiki/wiki-bookkeep.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WikiQueueService } from './wiki-queue.service.js';
import { WikiBookkeepService } from './wiki-bookkeep.service.js';

const SCHEMA = `
vault_scope: project
vault_id: crewly
hardcoded:
  - path: memory/
    frozen: true
    description: "Project memory."
    referenced_by: [skill:remember]
llm_curated:
  - path: llm-curated/
    frozen: false
    seed_subdirs: [decisions, customers, patterns]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`;

describe('WikiBookkeepService', () => {
  let vault: string;
  let queueRoot: string;
  let svc: WikiBookkeepService;

  beforeEach(async () => {
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-bookkeep-vault-'));
    queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-bookkeep-queue-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), SCHEMA, 'utf8');
    await fs.mkdir(path.join(vault, 'llm-curated'), { recursive: true });
    WikiBookkeepService._resetForTesting();
    svc = new WikiBookkeepService(undefined, new WikiQueueService(queueRoot));
  });

  afterEach(async () => {
    await fs.rm(vault, { recursive: true, force: true });
    await fs.rm(queueRoot, { recursive: true, force: true });
  });

  describe('input validation', () => {
    it('rejects relative paths', async () => {
      const r = await svc.generate({ vaultPath: 'rel' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('invalid_input');
    });

    it('reports vault_missing when the dir does not exist', async () => {
      const r = await svc.generate({ vaultPath: '/nowhere/at/all' });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('vault_missing');
    });

    it('reports schema_missing when SCHEMA.md is absent', async () => {
      await fs.unlink(path.join(vault, 'SCHEMA.md'));
      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('schema_missing');
    });
  });

  describe('empty vault', () => {
    it('totalMdCount=0, shouldFire=false, recommendation says quiet', async () => {
      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.totalMdCount).toBe(0);
      expect(r.report.recentMdCount).toBe(0);
      expect(r.report.shouldFire).toBe(false);
      expect(r.report.recommendations.join(' ')).toMatch(/quiet|no action/i);
    });
  });

  describe('shouldFire trigger', () => {
    it('fires when recentMdCount meets the threshold', async () => {
      for (let i = 0; i < 4; i++) {
        await fs.writeFile(
          path.join(vault, `llm-curated/page-${i}.md`),
          `# Page ${i}\nfoo`,
          'utf8',
        );
      }
      const r = await svc.generate({ vaultPath: vault, threshold: 4 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.recentMdCount).toBe(4);
      expect(r.report.shouldFire).toBe(true);
      expect(r.report.recommendations.join(' ')).toMatch(/threshold/);
    });

    it('does NOT fire when below threshold and no duplicates', async () => {
      await fs.writeFile(path.join(vault, 'llm-curated/single.md'), '# single', 'utf8');
      const r = await svc.generate({ vaultPath: vault, threshold: 10 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.shouldFire).toBe(false);
    });
  });

  describe('net-new baseline (shouldFire driven by baselineMdCount)', () => {
    const writeMds = async (n: number) => {
      for (let i = 0; i < n; i++) {
        await fs.writeFile(path.join(vault, `llm-curated/n-${i}.md`), `# n ${i}`, 'utf8');
      }
    };

    it('does NOT fire when the whole vault is already baselined (migration scenario)', async () => {
      // 12 mtime-recent files but baseline == total → 0 net-new. The old
      // mtime-window logic would have fired; net-new must not.
      await writeMds(12);
      const r = await svc.generate({ vaultPath: vault, threshold: 10, baselineMdCount: 12 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.recentMdCount).toBe(12); // window still counts them
      expect(r.report.netNewMdCount).toBe(0); // but net-new is 0
      expect(r.report.shouldFire).toBe(false);
    });

    it('fires when net-new since the baseline reaches the threshold', async () => {
      await writeMds(12);
      const r = await svc.generate({ vaultPath: vault, threshold: 10, baselineMdCount: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.netNewMdCount).toBe(10); // 12 - 2
      expect(r.report.shouldFire).toBe(true);
    });

    it('clamps net-new to 0 when the vault shrank below the baseline', async () => {
      await writeMds(3);
      const r = await svc.generate({ vaultPath: vault, threshold: 1, baselineMdCount: 50 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.netNewMdCount).toBe(0);
      expect(r.report.shouldFire).toBe(false);
    });

    it('duplicate clusters alone do NOT force a fire under net-new', async () => {
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic-pricing.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic-pricing-v2.md'), '#', 'utf8');
      const r = await svc.generate({ vaultPath: vault, threshold: 10, baselineMdCount: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.duplicateCandidates.length).toBeGreaterThan(0);
      expect(r.report.shouldFire).toBe(false);
    });
  });

  describe('duplicate detection', () => {
    it('flags near-duplicate filenames as a cluster', async () => {
      await fs.mkdir(path.join(vault, 'llm-curated/customers'), { recursive: true });
      await fs.writeFile(
        path.join(vault, 'llm-curated/customers/anthropic-pricing.md'),
        '# a',
        'utf8',
      );
      await fs.writeFile(
        path.join(vault, 'llm-curated/customers/anthropic-pricing-update.md'),
        '# b',
        'utf8',
      );
      await fs.writeFile(
        path.join(vault, 'llm-curated/customers/anthropic-pricing-v2.md'),
        '# c',
        'utf8',
      );
      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.duplicateCandidates.length).toBeGreaterThan(0);
      const cluster = r.report.duplicateCandidates[0];
      expect(cluster.pages.length).toBe(3);
      expect(cluster.basis).toContain('anthropic-pricing');
    });

    it('does NOT flag unrelated filenames', async () => {
      await fs.writeFile(path.join(vault, 'llm-curated/anthropic.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/pricing.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/onboarding.md'), '#', 'utf8');
      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.duplicateCandidates).toHaveLength(0);
    });

    it('ignores ISO-date prefix when computing similarity', async () => {
      // Same topic, different dates — Steve's actual pattern.
      await fs.mkdir(path.join(vault, 'llm-curated/decisions'), { recursive: true });
      await fs.writeFile(
        path.join(vault, 'llm-curated/decisions/2026-05-22-pricing-lock.md'),
        '#',
        'utf8',
      );
      await fs.writeFile(
        path.join(vault, 'llm-curated/decisions/2026-05-23-pricing-lock-v2.md'),
        '#',
        'utf8',
      );
      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.duplicateCandidates.length).toBeGreaterThan(0);
    });
  });

  describe('folder bucket counts', () => {
    it('groups pages by their llm-curated/<folder> bucket', async () => {
      await fs.mkdir(path.join(vault, 'llm-curated/customers'), { recursive: true });
      await fs.mkdir(path.join(vault, 'llm-curated/decisions'), { recursive: true });
      await fs.writeFile(path.join(vault, 'llm-curated/customers/a.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/customers/b.md'), '#', 'utf8');
      await fs.writeFile(path.join(vault, 'llm-curated/decisions/d.md'), '#', 'utf8');

      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.countsByFolder).toEqual({
        'llm-curated/customers': 2,
        'llm-curated/decisions': 1,
      });
    });
  });

  describe('queue snapshot is included', () => {
    it('reports queue stats scoped to the vault', async () => {
      const q = new WikiQueueService(queueRoot);
      await q.add({
        vaultPath: vault,
        queuedBy: 'crewly-orc',
        sourceType: 'user_chat',
        sourceRef: 'r1',
        content: 'x',
        reason: 'why',
      });
      const svcWithQ = new WikiBookkeepService(undefined, q);
      const r = await svcWithQ.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.queue.pending).toBe(1);
      expect(r.report.queue.total).toBe(1);
    });
  });

  describe('stale-page detection', () => {
    it('counts pages older than 90 days as stale', async () => {
      const p = path.join(vault, 'llm-curated/old.md');
      await fs.writeFile(p, '#', 'utf8');
      // Force mtime to 100 days ago.
      const oldTime = new Date(Date.now() - 100 * 24 * 3600 * 1000);
      await fs.utimes(p, oldTime, oldTime);
      const r = await svc.generate({ vaultPath: vault });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.report.staleCount).toBeGreaterThanOrEqual(1);
    });
  });
});
