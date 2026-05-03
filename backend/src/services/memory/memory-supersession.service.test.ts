/**
 * Unit tests for MemorySupersessionService (Memory Phase 1 — M4)
 *
 * @module services/memory/memory-supersession.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AgentMemoryService } from './agent-memory.service.js';
import { MemorySupersessionService } from './memory-supersession.service.js';
import { isHiddenFromDefaultRecall } from './role-knowledge-eligibility.js';

describe('MemorySupersessionService', () => {
  let agentService: AgentMemoryService;
  let supersession: MemorySupersessionService;
  let testDir: string;
  const agentId = 'test-agent-supersession';

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `crewly-supersession-${Date.now()}-${Math.random().toString(36).substring(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });

    AgentMemoryService.clearInstance();
    MemorySupersessionService.clearInstance();
    agentService = AgentMemoryService.getInstance(testDir);
    supersession = MemorySupersessionService.getInstance(agentService);

    await agentService.initializeAgent(agentId, 'developer');
  });

  afterEach(async () => {
    AgentMemoryService.clearInstance();
    MemorySupersessionService.clearInstance();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  /**
   * Helper: seed two entries and return their ids.
   * Convenience wrapper so individual tests stay focused on the supersession
   * behavior rather than knowledge-entry plumbing.
   */
  async function seedTwoEntries(): Promise<{ oldId: string; newId: string }> {
    const oldId = await agentService.addRoleKnowledge(agentId, {
      category: 'best-practice',
      content: 'Pricing is $799/month',
      confidence: 0.8,
    });
    const newId = await agentService.addRoleKnowledge(agentId, {
      category: 'best-practice',
      content: 'Pricing is $800/month + 1000 credits',
      confidence: 0.9,
    });
    return { oldId, newId };
  }

  describe('supersede', () => {
    it('marks the old entry as superseded with supersededBy ref', async () => {
      const { oldId, newId } = await seedTwoEntries();

      const result = await supersession.supersede({ agentId, oldId, newId });

      expect(result.oldId).toBe(oldId);
      expect(result.newId).toBe(newId);
      expect(result.supersededAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const memory = await agentService.getAgentMemory(agentId);
      const oldEntry = memory!.roleKnowledge.find((e) => e.id === oldId);
      expect(oldEntry?.superseded).toBe(true);
      expect(oldEntry?.supersededBy).toBe(newId);
    });

    it('appends a supersession-reason tag to evidence when reason is provided', async () => {
      const { oldId, newId } = await seedTwoEntries();
      await supersession.supersede({
        agentId,
        oldId,
        newId,
        reason: 'Steve updated pricing on 2026-05-01',
      });

      const memory = await agentService.getAgentMemory(agentId);
      const oldEntry = memory!.roleKnowledge.find((e) => e.id === oldId);
      expect(oldEntry?.evidence).toEqual(
        expect.arrayContaining(['supersession-reason:Steve updated pricing on 2026-05-01'])
      );
    });

    it('falls back to a timestamp tag when reason is omitted', async () => {
      const { oldId, newId } = await seedTwoEntries();
      await supersession.supersede({ agentId, oldId, newId });

      const memory = await agentService.getAgentMemory(agentId);
      const oldEntry = memory!.roleKnowledge.find((e) => e.id === oldId);
      const supersessionTag = oldEntry?.evidence?.find((e) => e.startsWith('supersession:'));
      expect(supersessionTag).toBeDefined();
      expect(supersessionTag).toMatch(/^supersession:\d{4}-\d{2}-\d{2}T/);
    });

    it('preserves existing evidence entries (additive, not destructive)', async () => {
      const oldId = await agentService.addRoleKnowledge(agentId, {
        category: 'best-practice',
        content: 'Old fact with prior evidence',
        confidence: 0.7,
        evidence: ['request:req-original-1', 'slack:1772999999.000001'],
      });
      const newId = await agentService.addRoleKnowledge(agentId, {
        category: 'best-practice',
        content: 'New fact',
        confidence: 0.9,
      });

      await supersession.supersede({ agentId, oldId, newId, reason: 'updated' });

      const memory = await agentService.getAgentMemory(agentId);
      const oldEntry = memory!.roleKnowledge.find((e) => e.id === oldId);
      expect(oldEntry?.evidence).toEqual([
        'request:req-original-1',
        'slack:1772999999.000001',
        'supersession-reason:updated',
      ]);
    });

    it('throws when oldId equals newId', async () => {
      const { oldId } = await seedTwoEntries();
      await expect(
        supersession.supersede({ agentId, oldId, newId: oldId })
      ).rejects.toThrow(/oldId and newId must differ/);
    });

    it('throws when the agent has no memory store', async () => {
      await expect(
        supersession.supersede({ agentId: 'nonexistent', oldId: 'x', newId: 'y' })
      ).rejects.toThrow(/has no memory store/);
    });

    it('throws when oldId is not found', async () => {
      const { newId } = await seedTwoEntries();
      await expect(
        supersession.supersede({ agentId, oldId: 'missing-old', newId })
      ).rejects.toThrow(/Old memory entry "missing-old" not found/);
    });

    it('throws when newId is not found', async () => {
      const { oldId } = await seedTwoEntries();
      await expect(
        supersession.supersede({ agentId, oldId, newId: 'missing-new' })
      ).rejects.toThrow(/New memory entry "missing-new" not found/);
    });

    it('superseded entries are hidden from default recall after supersession', async () => {
      const { oldId, newId } = await seedTwoEntries();
      await supersession.supersede({ agentId, oldId, newId });

      const memory = await agentService.getAgentMemory(agentId);
      const oldEntry = memory!.roleKnowledge.find((e) => e.id === oldId)!;
      const now = new Date();

      expect(isHiddenFromDefaultRecall(oldEntry, now)).toBe(true);

      // The new entry remains visible.
      const newEntry = memory!.roleKnowledge.find((e) => e.id === newId)!;
      expect(isHiddenFromDefaultRecall(newEntry, now)).toBe(false);
    });

    it('persists across reads (cache-invalidation works)', async () => {
      const { oldId, newId } = await seedTwoEntries();
      await supersession.supersede({ agentId, oldId, newId, reason: 'persistence test' });

      // Force a fresh service instance to bypass in-memory cache.
      AgentMemoryService.clearInstance();
      const fresh = AgentMemoryService.getInstance(testDir);
      const memory = await fresh.getAgentMemory(agentId);
      const oldEntry = memory!.roleKnowledge.find((e) => e.id === oldId);
      expect(oldEntry?.supersededBy).toBe(newId);
      expect(oldEntry?.evidence).toContain('supersession-reason:persistence test');
    });
  });

  describe('singleton lifecycle', () => {
    it('reuses the same instance across getInstance() calls without arg', () => {
      const a = MemorySupersessionService.getInstance();
      const b = MemorySupersessionService.getInstance();
      expect(a).toBe(b);
    });

    it('rebuilds when an explicit agentMemory is passed (test-injection path)', () => {
      const a = MemorySupersessionService.getInstance();
      const customAgent = AgentMemoryService.getInstance(testDir);
      const b = MemorySupersessionService.getInstance(customAgent);
      expect(a).not.toBe(b);
    });
  });
});
