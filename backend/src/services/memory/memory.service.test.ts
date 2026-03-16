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

    it('should throw error for invalid category', async () => {
      await expect(service.remember({
        agentId: testAgentId,
        content: 'Some content',
        category: 'decision', // not valid for agent scope
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
});
