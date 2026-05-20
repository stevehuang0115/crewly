/**
 * Unit tests for MemoryService Coordinator
 *
 * Tests the unified memory service that coordinates agent and project memory.
 *
 * @module services/memory/memory.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MemoryService } from './memory.service.js';

describe('MemoryService', () => {
  let service: MemoryService;
  let testDir: string;
  let testProjectPath: string;
  const testAgentId = 'test-agent-001';
  const testRole = 'developer';

  beforeEach(async () => {
    // Create unique temp directories for each test
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2)}`;
    testDir = path.join(os.tmpdir(), `crewly-unified-test-${uniqueId}`);
    testProjectPath = path.join(os.tmpdir(), `crewly-project-test-${uniqueId}`);

    await fs.mkdir(testDir, { recursive: true });
    await fs.mkdir(testProjectPath, { recursive: true });

    // Clear singleton and create new instance
    MemoryService.clearInstance();
    service = MemoryService.getInstance();
  });

  afterEach(async () => {
    // Clean up test directories
    MemoryService.clearInstance();
    try {
      await fs.rm(testDir, { recursive: true, force: true });
      await fs.rm(testProjectPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = MemoryService.getInstance();
      const instance2 = MemoryService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('getAgentMemoryService', () => {
    it('should return the agent memory service', () => {
      const agentService = service.getAgentMemoryService();
      expect(agentService).toBeDefined();
      expect(typeof agentService.initializeAgent).toBe('function');
    });
  });

  describe('getProjectMemoryService', () => {
    it('should return the project memory service', () => {
      const projectService = service.getProjectMemoryService();
      expect(projectService).toBeDefined();
      expect(typeof projectService.initializeProject).toBe('function');
    });
  });

  describe('initializeForSession', () => {
    it('should initialize both agent and project memory', async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);

      const agentService = service.getAgentMemoryService();
      const projectService = service.getProjectMemoryService();

      const agentMemory = await agentService.getAgentMemory(testAgentId);
      const projectMemory = await projectService.getProjectMemory(testProjectPath);

      expect(agentMemory).not.toBeNull();
      expect(projectMemory).not.toBeNull();
    });
  });

  describe('remember - agent scope', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('should store fact in agent memory', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        content: 'Always run tests before committing',
        category: 'fact',
        scope: 'agent',
      });

      expect(id).toBeDefined();

      const agentService = service.getAgentMemoryService();
      const knowledge = await agentService.getRoleKnowledge(testAgentId);
      expect(knowledge.some(k => k.content.includes('Always run tests'))).toBe(true);
    });

    it('should store pattern in agent memory', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        content: 'Use async/await instead of callbacks',
        category: 'pattern',
        scope: 'agent',
      });

      expect(id).toBeDefined();
    });

    it('should update preferences', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        content: 'I prefer concise responses',
        category: 'preference',
        scope: 'agent',
      });

      expect(id).toBe('preference-updated');

      const agentService = service.getAgentMemoryService();
      const prefs = await agentService.getPreferences(testAgentId);
      expect(prefs.communicationStyle?.verbosity).toBe('concise');
    });

    // Steve 2026-05-15 dogfood: agents (Sam, Atlas) repeatedly called
    // `category=decision, scope=agent` and the throw dropped their
    // completion summaries. Coerce instead of reject — preserve data,
    // warn so the next call is correct.

    it('auto-promotes scope to project when category is project-only AND projectPath is provided', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Use composite dedup keys to support re-target',
        category: 'decision',
        scope: 'agent',
        metadata: { title: 'Dispatch dedup key shape', rationale: 'reassign repro' },
      });

      // Should land as a project-scope decision (not throw, not lose data)
      expect(id).toBeDefined();
      const projectService = service.getProjectMemoryService();
      const decisions = await projectService.getDecisions(testProjectPath);
      expect(decisions.some(d => d.decision.includes('composite dedup keys'))).toBe(true);
    });

    it('falls back to agent-scope fact (with a [coerced from] prefix) when projectPath is missing', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        content: 'Decisions need a projectPath to be useful here',
        category: 'decision',
        scope: 'agent',
        // projectPath intentionally omitted
      });

      expect(id).toBeDefined();
      const agentService = service.getAgentMemoryService();
      const knowledge = await agentService.getRoleKnowledge(testAgentId);
      const stored = knowledge.find(k => k.content.includes('[coerced from category=decision]'));
      expect(stored).toBeDefined();
      expect(stored?.content).toContain('Decisions need a projectPath');
    });

    // ===== F4 fix (2026-05-06): gotcha is now valid for agent scope =====
    // ORC Audit Cycle 3 finding F4. Previously rejected with "not valid for
    // agent scope" because rememberForAgent only accepted fact/pattern/preference,
    // forcing callers to pollute project memory with personal gotchas.

    it('should store gotcha in agent memory (F4 fix)', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        content: 'My grep -A audit pattern produced false positives — use yq instead',
        category: 'gotcha',
        scope: 'agent',
      });

      expect(id).toBeDefined();
      expect(id).not.toBe('preference-updated');

      const agentService = service.getAgentMemoryService();
      const knowledge = await agentService.getRoleKnowledge(testAgentId);
      const stored = knowledge.find(k => k.content.includes('grep -A audit'));
      expect(stored).toBeDefined();
      expect(stored?.category).toBe('anti-pattern');
    });

    it('should keep gotcha valid for project scope (no regression)', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Database connections leak without explicit cleanup',
        category: 'gotcha',
        scope: 'project',
        metadata: {
          title: 'Connection Pool Leak',
          solution: 'Use try/finally with client.release()',
          severity: 'high',
        },
      });

      expect(id).toBeDefined();

      const projectService = service.getProjectMemoryService();
      const gotchas = await projectService.getGotchas(testProjectPath);
      expect(gotchas.some(g => g.title === 'Connection Pool Leak')).toBe(true);
    });

    it('should make agent-scope gotcha recallable (F4 fix)', async () => {
      await service.remember({
        agentId: testAgentId,
        content: 'Never run git checkout -- . without stashing first — destructive',
        category: 'gotcha',
        scope: 'agent',
      });

      const result = await service.recall({
        agentId: testAgentId,
        context: 'git checkout destructive stash',
        scope: 'agent',
      });

      expect(result.agentMemories.length).toBeGreaterThan(0);
      expect(
        result.agentMemories.some(m => m.includes('git checkout'))
      ).toBe(true);
    });

    it('should reject relationship for agent scope (project-only by design)', async () => {
      await expect(service.remember({
        agentId: testAgentId,
        content: 'UserController',
        category: 'relationship',
        scope: 'agent',
      })).rejects.toThrow('not valid for agent scope');
    });

    it('should reject user_preference for agent scope (project-only by design)', async () => {
      await expect(service.remember({
        agentId: testAgentId,
        content: 'User prefers concise replies',
        category: 'user_preference',
        scope: 'agent',
      })).rejects.toThrow('not valid for agent scope');
    });
  });

  describe('remember - project scope', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('should store pattern in project memory', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Use error wrapper for all API endpoints',
        category: 'pattern',
        scope: 'project',
        metadata: {
          title: 'API Error Handling',
          patternCategory: 'api',
        },
      });

      expect(id).toBeDefined();

      const projectService = service.getProjectMemoryService();
      const patterns = await projectService.getPatterns(testProjectPath);
      expect(patterns.some(p => p.title === 'API Error Handling')).toBe(true);
    });

    it('should store decision in project memory', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Use React Context for state management',
        category: 'decision',
        scope: 'project',
        metadata: {
          title: 'State Management',
          rationale: 'Project scope is small',
        },
      });

      expect(id).toBeDefined();

      const projectService = service.getProjectMemoryService();
      const decisions = await projectService.getDecisions(testProjectPath);
      expect(decisions.some(d => d.title === 'State Management')).toBe(true);
    });

    it('should store gotcha in project memory', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Database connections leak without cleanup',
        category: 'gotcha',
        scope: 'project',
        metadata: {
          title: 'Connection Pool Leak',
          solution: 'Use try/finally with client.release()',
          severity: 'high',
        },
      });

      expect(id).toBeDefined();

      const projectService = service.getProjectMemoryService();
      const gotchas = await projectService.getGotchas(testProjectPath);
      expect(gotchas.some(g => g.title === 'Connection Pool Leak')).toBe(true);
    });

    it('should store relationship in project memory', async () => {
      const id = await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'UserController',
        category: 'relationship',
        scope: 'project',
        metadata: {
          targetComponent: 'AuthService',
          relationshipType: 'depends-on',
        },
      });

      expect(id).toBeDefined();

      const projectService = service.getProjectMemoryService();
      const relationships = await projectService.getRelationships(testProjectPath);
      expect(relationships.some(r => r.from === 'UserController' && r.to === 'AuthService')).toBe(true);
    });

    it('should throw error when projectPath is missing', async () => {
      await expect(service.remember({
        agentId: testAgentId,
        content: 'Some content',
        category: 'pattern',
        scope: 'project',
      })).rejects.toThrow('projectPath is required');
    });

    it('should throw error for invalid category', async () => {
      await expect(service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Some content',
        category: 'fact', // not valid for project scope
        scope: 'project',
      })).rejects.toThrow('not valid for project scope');
    });
  });

  describe('recall', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);

      // Add some test data
      await service.remember({
        agentId: testAgentId,
        content: 'Always validate user input before processing',
        category: 'fact',
        scope: 'agent',
      });

      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Use Joi for input validation',
        category: 'pattern',
        scope: 'project',
        metadata: { title: 'Input Validation', patternCategory: 'api' },
      });
    });

    it('should recall from agent scope only', async () => {
      const result = await service.recall({
        agentId: testAgentId,
        context: 'input validation',
        scope: 'agent',
      });

      expect(result.agentMemories.length).toBeGreaterThan(0);
      expect(result.projectMemories).toHaveLength(0);
    });

    it('should recall from project scope only', async () => {
      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'input validation',
        scope: 'project',
      });

      expect(result.projectMemories.length).toBeGreaterThan(0);
      expect(result.agentMemories).toHaveLength(0);
    });

    it('should recall from both scopes', async () => {
      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'input validation',
        scope: 'both',
      });

      expect(result.agentMemories.length).toBeGreaterThan(0);
      expect(result.projectMemories.length).toBeGreaterThan(0);
      expect(result.combined).toContain('From Your Experience');
      expect(result.combined).toContain('From Project Knowledge');
    });

    it('should separate completed task markers into dedicated section (#219)', async () => {
      // Store a completed task marker (mimics what report-status/complete-task does)
      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: '[COMPLETED] Task completed by dev-001: Fixed login bug',
        category: 'decision',
        scope: 'project',
        metadata: { title: 'Completed Task' },
      });

      // Also store a regular (non-completed) agent memory for contrast
      await service.remember({
        agentId: testAgentId,
        content: '[COMPLETED] Task completed by dev-001: Added auth module',
        category: 'fact',
        scope: 'agent',
      });

      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'login bug completed task auth module',
        scope: 'both',
      });

      // The [COMPLETED] markers should be separated by combineMemories:
      // any memory with [COMPLETED] goes to the dedicated section,
      // NOT into "From Your Experience" or "From Project Knowledge".
      const combined = result.combined;
      // If there are any [COMPLETED] items in the memories, they should
      // be in the "Completed Tasks" section
      const allMemories = [...result.agentMemories, ...result.projectMemories];
      const completedItems = allMemories.filter(m => m.includes('[COMPLETED]'));
      if (completedItems.length > 0) {
        expect(combined).toContain('Completed Tasks (do NOT re-delegate)');
      }
    });

    it('should respect limit parameter', async () => {
      // Add more data
      for (let i = 0; i < 5; i++) {
        await service.remember({
          agentId: testAgentId,
          content: `Validation rule ${i} for user input`,
          category: 'fact',
          scope: 'agent',
        });
      }

      const result = await service.recall({
        agentId: testAgentId,
        context: 'validation',
        scope: 'agent',
        limit: 2,
      });

      expect(result.agentMemories.length).toBeLessThanOrEqual(2);
    });
  });

  describe('getFullContext', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);

      // Add test data to both services
      await service.remember({
        agentId: testAgentId,
        content: 'Always write tests first',
        category: 'fact',
        scope: 'agent',
      });

      // Reinforce to increase confidence above 0.6
      const agentService = service.getAgentMemoryService();
      const knowledge = await agentService.getRoleKnowledge(testAgentId);
      if (knowledge.length > 0) {
        await agentService.reinforceKnowledge(testAgentId, knowledge[0].id);
        await agentService.reinforceKnowledge(testAgentId, knowledge[0].id);
      }

      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Database connections leak',
        category: 'gotcha',
        scope: 'project',
        metadata: {
          title: 'Connection Leak',
          solution: 'Use connection pooling',
          severity: 'critical',
        },
      });
    });

    it('should return combined context from both services', async () => {
      const context = await service.getFullContext(testAgentId, testProjectPath);

      expect(context).toContain('Agent Memory');
      expect(context).toContain('Project Knowledge');
    });

    it('should include critical gotchas', async () => {
      const context = await service.getFullContext(testAgentId, testProjectPath);

      expect(context).toContain('Critical Gotchas');
      expect(context).toContain('Connection Leak');
    });
  });

  describe('recordLearning', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('should record learning to project memory', async () => {
      await service.recordLearning({
        agentId: testAgentId,
        agentRole: testRole,
        projectPath: testProjectPath,
        learning: 'Discovered that database queries need optimization',
        relatedTask: 'TICKET-123',
      });

      const projectService = service.getProjectMemoryService();
      const learnings = await projectService.getRecentLearnings(testProjectPath);

      expect(learnings).toContain('database queries');
    });

    it('should also store role-relevant learning in agent memory', async () => {
      await service.recordLearning({
        agentId: testAgentId,
        agentRole: testRole,
        projectPath: testProjectPath,
        learning: 'Always use parameterized queries to prevent SQL injection',
      });

      const agentService = service.getAgentMemoryService();
      const knowledge = await agentService.getRoleKnowledge(testAgentId);

      expect(knowledge.some(k => k.content.includes('parameterized queries'))).toBe(true);
    });

    it('should not store non-role-relevant learning in agent memory', async () => {
      await service.recordLearning({
        agentId: testAgentId,
        agentRole: testRole,
        projectPath: testProjectPath,
        learning: 'The config file is located in /etc/app',
      });

      const agentService = service.getAgentMemoryService();
      const knowledge = await agentService.getRoleKnowledge(testAgentId);

      expect(knowledge.some(k => k.content.includes('config file is located'))).toBe(false);
    });
  });

  describe('integration scenarios', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('should support a typical development workflow', async () => {
      // Agent discovers a pattern
      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'All controllers use dependency injection',
        category: 'pattern',
        scope: 'project',
        metadata: {
          title: 'Dependency Injection Pattern',
          patternCategory: 'service',
          example: 'constructor(private readonly service: MyService) {}',
        },
      });

      // Agent makes a decision
      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Use TypeScript strict mode',
        category: 'decision',
        scope: 'project',
        metadata: {
          title: 'TypeScript Configuration',
          rationale: 'Catches more bugs at compile time',
        },
      });

      // Agent discovers a gotcha
      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Circular dependencies cause runtime errors',
        category: 'gotcha',
        scope: 'project',
        metadata: {
          title: 'Circular Dependencies',
          solution: 'Use interfaces to break cycles',
          severity: 'high',
        },
      });

      // Agent records a learning
      await service.recordLearning({
        agentId: testAgentId,
        agentRole: testRole,
        projectPath: testProjectPath,
        learning: 'Always check for null before accessing properties',
        relatedTask: 'TICKET-456',
      });

      // Get full context for prompts
      const context = await service.getFullContext(testAgentId, testProjectPath);

      // Verify context contains all relevant information
      expect(context).toContain('Dependency Injection Pattern');
      expect(context).toContain('TypeScript Configuration');
      expect(context).toContain('Circular Dependencies');

      // Recall specific information
      const recalled = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'dependency',
        scope: 'both',
      });

      expect(recalled.projectMemories.some(m => m.includes('Dependency Injection'))).toBe(true);
    });
  });

  describe('semantic recall integration', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('should call embedMemory on remember without throwing', async () => {
      // embedMemory is fire-and-forget; verify remember still works when no provider
      const id = await service.remember({
        agentId: testAgentId,
        content: 'Semantic test content for embedding',
        category: 'fact',
        scope: 'agent',
      });

      expect(id).toBeDefined();
    });

    it('should include semantic search in recall without error when no provider', async () => {
      // Without an embedding API key, semantic search returns empty — should not fail
      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'semantic search test query',
        scope: 'both',
      });

      expect(result).toBeDefined();
      expect(result.agentMemories).toBeInstanceOf(Array);
      expect(result.projectMemories).toBeInstanceOf(Array);
    });

    it('should gracefully handle recall with project-only semantic search', async () => {
      await service.remember({
        agentId: testAgentId,
        projectPath: testProjectPath,
        content: 'Project-level semantic memory',
        category: 'pattern',
        scope: 'project',
        metadata: { title: 'Semantic Pattern' },
      });

      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'semantic memory',
        scope: 'project',
      });

      expect(result).toBeDefined();
      expect(result.agentMemories).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // M3 — recall-eligibility filtering (spec §183-187).
  //
  // These wire tests prove that filterRelevant() — the LIVE recall path called
  // by service.recall() at memory.service.ts:757 — correctly drops entries
  // that are superseded or expired (TTL in the past). They use the agent
  // memory service's addRoleKnowledge() API to seed entries with the v3
  // fields (supersededBy / ttl) that service.remember() does not yet expose
  // through the high-level API.
  // ---------------------------------------------------------------------------
  describe('M3 recall filtering', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('hides entries with supersededBy set from recall results', async () => {
      const agentService = service.getAgentMemoryService();
      // Seed a healthy + a superseded entry that both match the same context.
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Always validate user input thoroughly',
        confidence: 0.9,
      });
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Stale validation guidance from older spec',
        confidence: 0.9,
        supersededBy: 'rk-newer',
      });

      const result = await service.recall({
        agentId: testAgentId,
        context: 'validation user input',
        scope: 'agent',
      });

      const joined = result.agentMemories.join('\n');
      expect(joined).toContain('validate user input thoroughly');
      expect(joined).not.toContain('Stale validation guidance');
    });

    it('hides expired entries (ttl < now) from recall results', async () => {
      const agentService = service.getAgentMemoryService();
      const PAST_TTL = '2000-01-01T00:00:00Z';
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Active testing convention',
        confidence: 0.9,
      });
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Expired testing convention from old framework',
        confidence: 0.9,
        ttl: PAST_TTL,
      });

      const result = await service.recall({
        agentId: testAgentId,
        context: 'testing convention',
        scope: 'agent',
      });

      const joined = result.agentMemories.join('\n');
      expect(joined).toContain('Active testing convention');
      expect(joined).not.toContain('Expired testing convention');
    });

    it('surfaces healthy entries on recall (positive control)', async () => {
      const agentService = service.getAgentMemoryService();
      const FUTURE_TTL = '2099-01-01T00:00:00Z';
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Healthy long-lived pattern about retries',
        confidence: 0.8,
        ttl: FUTURE_TTL,
      });

      const result = await service.recall({
        agentId: testAgentId,
        context: 'retries pattern',
        scope: 'agent',
      });

      expect(result.agentMemories.join('\n')).toContain(
        'Healthy long-lived pattern about retries',
      );
    });

    // -----------------------------------------------------------------------
    // M4 — NOTE-A: includeHidden=true surfaces hidden entries (audit path).
    // -----------------------------------------------------------------------
    it('M4/NOTE-A: includeHidden=true surfaces superseded entries', async () => {
      const agentService = service.getAgentMemoryService();
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Stale validation guidance from older spec',
        confidence: 0.9,
        supersededBy: 'rk-newer',
      });

      const defaultRecall = await service.recall({
        agentId: testAgentId,
        context: 'validation guidance',
        scope: 'agent',
      });
      expect(defaultRecall.agentMemories.join('\n')).not.toContain(
        'Stale validation guidance',
      );

      const auditRecall = await service.recall({
        agentId: testAgentId,
        context: 'validation guidance',
        scope: 'agent',
        includeHidden: true,
      });
      expect(auditRecall.agentMemories.join('\n')).toContain(
        'Stale validation guidance',
      );
    });

    it('M4/NOTE-A: includeHidden=true surfaces TTL-expired entries', async () => {
      const agentService = service.getAgentMemoryService();
      const PAST_TTL = '2000-01-01T00:00:00Z';
      await agentService.addRoleKnowledge(testAgentId, {
        category: 'best-practice',
        content: 'Expired testing convention from old framework',
        confidence: 0.9,
        ttl: PAST_TTL,
      });

      const defaultRecall = await service.recall({
        agentId: testAgentId,
        context: 'testing convention',
        scope: 'agent',
      });
      expect(defaultRecall.agentMemories.join('\n')).not.toContain(
        'Expired testing convention',
      );

      const auditRecall = await service.recall({
        agentId: testAgentId,
        context: 'testing convention',
        scope: 'agent',
        includeHidden: true,
      });
      expect(auditRecall.agentMemories.join('\n')).toContain(
        'Expired testing convention',
      );
    });
  });

  describe('recall.capability — task-history routing', () => {
    beforeEach(async () => {
      await service.initializeForSession(testAgentId, testRole, testProjectPath);
    });

    it('returns empty taskHistory when ledger has no matching capability', async () => {
      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'gmail',
        scope: 'project',
        capability: 'gmail:read',
      });
      expect(result.taskHistory).toEqual([]);
      // No "### Capability Routing" block appended when there are no matches.
      expect(result.combined).not.toContain('### Capability Routing');
    });

    it('surfaces matching entries and appends Capability Routing block', async () => {
      const projectMemory = service.getProjectMemoryService();
      await projectMemory.addTaskHistory(testProjectPath, {
        id: 'th-ella-1',
        completedAt: '2026-05-18T14:00:00Z',
        agent: {
          sessionName: 'crewly-product-ella',
          role: 'fullstack-dev',
        },
        task: { description: 'Read MIT Role email', outcome: 'success' },
        capabilities: ['gmail:read', 'oauth:gmail'],
        toolsUsed: ['read_email_oauth'],
      });

      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'gmail',
        scope: 'project',
        capability: 'gmail:read',
      });

      expect(result.taskHistory).toHaveLength(1);
      expect(result.taskHistory![0]!.agent.sessionName).toBe(
        'crewly-product-ella',
      );
      expect(result.combined).toContain('### Capability Routing — `gmail:read`');
      expect(result.combined).toContain('crewly-product-ella');
      expect(result.combined).toContain('fullstack-dev');
    });

    it('ranks members by most-recent activity and aggregates per-member count', async () => {
      const projectMemory = service.getProjectMemoryService();
      // Ella did it once, on an earlier date.
      await projectMemory.addTaskHistory(testProjectPath, {
        id: 'th-old-ella',
        completedAt: '2026-04-01T00:00:00Z',
        agent: { sessionName: 'crewly-product-ella', role: 'fullstack-dev' },
        task: { description: 'old gmail read', outcome: 'success' },
        capabilities: ['gmail:read'],
        toolsUsed: ['read_email_oauth'],
      });
      // Sam did it twice, both more recent than Ella's.
      await projectMemory.addTaskHistory(testProjectPath, {
        id: 'th-sam-1',
        completedAt: '2026-05-10T00:00:00Z',
        agent: { sessionName: 'crewly-product-sam', role: 'fullstack-dev' },
        task: { description: 'gmail read A', outcome: 'success' },
        capabilities: ['gmail:read'],
        toolsUsed: ['read_email_oauth'],
      });
      await projectMemory.addTaskHistory(testProjectPath, {
        id: 'th-sam-2',
        completedAt: '2026-05-18T00:00:00Z',
        agent: { sessionName: 'crewly-product-sam', role: 'fullstack-dev' },
        task: { description: 'gmail read B', outcome: 'success' },
        capabilities: ['gmail:read'],
        toolsUsed: ['read_email_oauth'],
      });

      const result = await service.recall({
        agentId: testAgentId,
        projectPath: testProjectPath,
        context: 'gmail',
        scope: 'project',
        capability: 'gmail:read',
      });

      // The capability-routing block lists Sam first (more recent) with
      // count=2, then Ella with count=1.
      const block = result.combined.split('### Capability Routing')[1] ?? '';
      const samIdx = block.indexOf('crewly-product-sam');
      const ellaIdx = block.indexOf('crewly-product-ella');
      expect(samIdx).toBeGreaterThan(-1);
      expect(ellaIdx).toBeGreaterThan(-1);
      expect(samIdx).toBeLessThan(ellaIdx);
      expect(block).toMatch(/crewly-product-sam.*2×/);
      expect(block).toMatch(/crewly-product-ella.*1×/);
    });

    it('is omitted entirely when projectPath is not provided', async () => {
      const result = await service.recall({
        agentId: testAgentId,
        context: 'gmail',
        scope: 'agent',
        capability: 'gmail:read',
      });
      // No projectPath → no query at all → field absent.
      expect(result.taskHistory).toBeUndefined();
    });
  });
});
