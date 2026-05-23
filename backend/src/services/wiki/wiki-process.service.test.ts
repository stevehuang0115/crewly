/**
 * Tests for WikiProcessService.
 *
 * Each test stands up a temp queue root + a temp vault so the queue and
 * the query services are exercised end-to-end against the real filesystem.
 *
 * @module services/wiki/wiki-process.service.test
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { WikiQueueService } from './wiki-queue.service.js';
import { WikiQueryService } from './wiki-query.service.js';
import { WikiProcessService } from './wiki-process.service.js';

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
    seed_subdirs: [decisions, customers]
    llm_can_create_subdirs: true
    lint_may_restructure: true
write_policy:
  canonical: [team-leader, orchestrator]
  proposed_only: [worker]
  schema_writer: [steve]
`;

describe('WikiProcessService', () => {
  let queueRoot: string;
  let vault: string;
  let queue: WikiQueueService;
  let svc: WikiProcessService;

  beforeEach(async () => {
    WikiQueryService._resetForTesting();
    WikiProcessService._resetForTesting();
    queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-process-queue-'));
    vault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-process-vault-'));
    await fs.writeFile(path.join(vault, 'SCHEMA.md'), SCHEMA, 'utf8');
    queue = new WikiQueueService(queueRoot);
    svc = new WikiProcessService(queue, WikiQueryService.getInstance());
  });

  afterEach(async () => {
    await fs.rm(queueRoot, { recursive: true, force: true });
    await fs.rm(vault, { recursive: true, force: true });
  });

  const enqueue = (overrides: Partial<Parameters<typeof queue.add>[0]> = {}) =>
    queue.add({
      vaultPath: vault,
      queuedBy: 'crewly-orc',
      sourceType: 'user_chat',
      sourceRef: 'chat:slack-x:msg-1',
      content: 'Anthropic SMB pilot signed at $799/month — 12-mo commit',
      reason: 'first paid SMB customer + pricing validation point',
      ...overrides,
    });

  describe('claimNext (happy path)', () => {
    it('returns no_pending_items when the queue is empty', async () => {
      const out = await svc.claimNext({ claimedBy: 'crewly-orc' });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe('no_pending_items');
    });

    it('claims the only pending item and returns vault context', async () => {
      const queued = await enqueue();
      const out = await svc.claimNext({ claimedBy: 'crewly-orc' });
      expect(out.ok).toBe(true);
      if (!out.ok) return;

      expect(out.result.item.id).toBe(queued.id);
      expect(out.result.item.status).toBe('claimed');
      expect(out.result.item.claimedBy).toBe('crewly-orc');
      expect(out.result.vaultContext?.vault.id).toBe('crewly');
      expect(out.result.classifierNotes.length).toBeGreaterThan(0);
    });

    it('scopes to the requested vault when multiple are present', async () => {
      const otherVault = await fs.mkdtemp(path.join(os.tmpdir(), 'crewly-other-vault-'));
      try {
        await fs.writeFile(path.join(otherVault, 'SCHEMA.md'), SCHEMA, 'utf8');
        const a = await enqueue({ vaultPath: vault, sourceRef: 'in-vault-a' });
        const b = await enqueue({ vaultPath: otherVault, sourceRef: 'in-vault-b' });
        const out = await svc.claimNext({
          claimedBy: 'crewly-orc',
          vaultPath: otherVault,
        });
        expect(out.ok).toBe(true);
        if (!out.ok) return;
        expect(out.result.item.id).toBe(b.id);
        expect(out.result.item.vaultPath).toBe(otherVault);

        // The other-vault item stays pending.
        const remaining = await queue.list({ status: 'pending' });
        expect(remaining.map((r) => r.id)).toContain(a.id);
      } finally {
        await fs.rm(otherVault, { recursive: true, force: true });
      }
    });

    it('honors offset to skip the newest item', async () => {
      const a = await enqueue({ sourceRef: 'older' });
      await new Promise((r) => setTimeout(r, 10));
      const b = await enqueue({ sourceRef: 'newer' });
      const out = await svc.claimNext({ claimedBy: 'crewly-orc', offset: 1 });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      // Newest-first list with offset=1 gets the older item.
      expect(out.result.item.id).toBe(a.id);
    });

    it('returns no_pending_items when offset exceeds queue size', async () => {
      await enqueue();
      const out = await svc.claimNext({ claimedBy: 'crewly-orc', offset: 5 });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.reason).toBe('no_pending_items');
    });
  });

  describe('classifierNotes contract', () => {
    it('reminds the agent NEVER to target frozen folders', async () => {
      await enqueue();
      const out = await svc.claimNext({ claimedBy: 'crewly-orc' });
      if (!out.ok) throw new Error('expected ok');
      const joined = out.result.classifierNotes.join(' ');
      expect(joined).toMatch(/NEVER target a frozen folder/);
      expect(joined).toMatch(/no preset taxonomy/i);
      expect(joined).toMatch(/wiki-ingest/);
    });

    it('tells the agent to prefer merging over creating', async () => {
      await enqueue();
      const out = await svc.claimNext({ claimedBy: 'crewly-orc' });
      if (!out.ok) throw new Error('expected ok');
      const joined = out.result.classifierNotes.join(' ');
      expect(joined).toMatch(/merging into an existing/i);
      expect(joined).toMatch(/candidatePages/);
    });

    it('tells the agent how to skip if the item turns out not wiki-worthy', async () => {
      await enqueue();
      const out = await svc.claimNext({ claimedBy: 'crewly-orc' });
      if (!out.ok) throw new Error('expected ok');
      const joined = out.result.classifierNotes.join(' ');
      expect(joined).toMatch(/skip/i);
      expect(joined).toMatch(/skipReason/);
    });
  });

  describe('vault context includes existing pages so dedupe works', () => {
    it('surfaces a matching existing page in candidatePages', async () => {
      // Seed an existing customer page that should outrank a fresh enqueue.
      await fs.mkdir(path.join(vault, 'llm-curated/customers'), { recursive: true });
      await fs.writeFile(
        path.join(vault, 'llm-curated/customers/anthropic.md'),
        '# Anthropic\n\nFirst SMB pilot. Pricing: $799/month. Anthropic Anthropic Anthropic.',
        'utf8',
      );

      await enqueue({
        content: 'Anthropic just doubled their seat count — 12 → 24 users.',
        reason: 'expansion event for existing customer',
      });
      const out = await svc.claimNext({ claimedBy: 'crewly-orc' });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.result.vaultContext).not.toBeNull();
      const paths = out.result.vaultContext!.candidatePages.map((p) => p.path);
      expect(paths).toContain('llm-curated/customers/anthropic.md');
    });
  });

  describe('claim state transition', () => {
    it('after claimNext, the queue shows the item as claimed (not pending)', async () => {
      await enqueue();
      await svc.claimNext({ claimedBy: 'crewly-orc' });
      const stats = await queue.getStats(vault);
      expect(stats.pending).toBe(0);
      expect(stats.claimed).toBe(1);
    });

    it('does NOT re-claim an item that is already claimed', async () => {
      await enqueue();
      const first = await svc.claimNext({ claimedBy: 'crewly-orc' });
      expect(first.ok).toBe(true);
      const second = await svc.claimNext({ claimedBy: 'another' });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.reason).toBe('no_pending_items');
    });
  });
});
