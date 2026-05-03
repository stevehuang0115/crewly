/**
 * Unit tests for Memory Data Models
 *
 * Tests type validation helpers and default values for the memory system.
 *
 * @module types/memory.types.test
 */

import {
  DEFAULT_AGENT_MEMORY,
  DEFAULT_PROJECT_MEMORY,
  MEMORY_SCHEMA_VERSION,
  type AgentMemory,
  type ProjectMemory,
  type RoleKnowledgeEntry,
  type PatternEntry,
  type DecisionEntry,
  type GotchaEntry,
  type RelationshipEntry,
  type LearningEntry,
  type MemoryQueryOptions,
  type RoleKnowledgeCategory,
  type PatternCategory,
  type GotchaSeverity,
  type RelationshipType,
  type LearningCategory,
  type VerbosityLevel,
  type BreakdownSize,
} from './memory.types.js';

describe('Memory Types', () => {
  describe('DEFAULT_AGENT_MEMORY', () => {
    it('should have empty roleKnowledge array', () => {
      expect(DEFAULT_AGENT_MEMORY.roleKnowledge).toEqual([]);
    });

    it('should have default preferences set', () => {
      expect(DEFAULT_AGENT_MEMORY.preferences).toBeDefined();
      expect(DEFAULT_AGENT_MEMORY.preferences.communicationStyle).toBeDefined();
      expect(DEFAULT_AGENT_MEMORY.preferences.communicationStyle?.verbosity).toBe('detailed');
      expect(DEFAULT_AGENT_MEMORY.preferences.communicationStyle?.askBeforeAction).toBe(true);
    });

    it('should have default work patterns', () => {
      expect(DEFAULT_AGENT_MEMORY.preferences.workPatterns).toBeDefined();
      expect(DEFAULT_AGENT_MEMORY.preferences.workPatterns?.breakdownSize).toBe('medium');
    });

    it('should have zeroed performance metrics', () => {
      expect(DEFAULT_AGENT_MEMORY.performance.tasksCompleted).toBe(0);
      expect(DEFAULT_AGENT_MEMORY.performance.averageIterations).toBe(0);
      expect(DEFAULT_AGENT_MEMORY.performance.qualityGatePassRate).toBe(0);
      expect(DEFAULT_AGENT_MEMORY.performance.commonErrors).toEqual([]);
    });

    it('should have current schema version', () => {
      expect(DEFAULT_AGENT_MEMORY.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    });
  });

  describe('DEFAULT_PROJECT_MEMORY', () => {
    it('should have empty patterns array', () => {
      expect(DEFAULT_PROJECT_MEMORY.patterns).toEqual([]);
    });

    it('should have empty decisions array', () => {
      expect(DEFAULT_PROJECT_MEMORY.decisions).toEqual([]);
    });

    it('should have empty gotchas array', () => {
      expect(DEFAULT_PROJECT_MEMORY.gotchas).toEqual([]);
    });

    it('should have empty relationships array', () => {
      expect(DEFAULT_PROJECT_MEMORY.relationships).toEqual([]);
    });

    it('should have current schema version', () => {
      expect(DEFAULT_PROJECT_MEMORY.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    });
  });

  describe('MEMORY_SCHEMA_VERSION', () => {
    it('should be a positive integer', () => {
      expect(MEMORY_SCHEMA_VERSION).toBeGreaterThan(0);
      expect(Number.isInteger(MEMORY_SCHEMA_VERSION)).toBe(true);
    });

    it('should be at version 2 (Memory Phase 1 — M3 fields)', () => {
      // v1 = original schema; v2 = adds importance/evidence/ttl/shouldInjectByDefault.
      // If you bump this past 2, also update DEFAULT_AGENT_MEMORY.schemaVersion in
      // memory.types.ts and the migration logic in agent-memory.service.ts.
      expect(MEMORY_SCHEMA_VERSION).toBe(2);
    });
  });

  describe('MEMORY_V2_MIGRATION_DEFAULTS', () => {
    it('exposes the Phase 1 (M3) backfill defaults', async () => {
      const { MEMORY_V2_MIGRATION_DEFAULTS } = await import('./memory.types.js');
      expect(MEMORY_V2_MIGRATION_DEFAULTS.importance).toBe(0.5);
      expect(MEMORY_V2_MIGRATION_DEFAULTS.confidence).toBe(0.7);
      expect(MEMORY_V2_MIGRATION_DEFAULTS.evidence).toEqual([]);
      expect(MEMORY_V2_MIGRATION_DEFAULTS.shouldInjectByDefault).toBe(false);
    });

    it('does NOT include a default ttl (pre-v2 entries do not expire)', async () => {
      const { MEMORY_V2_MIGRATION_DEFAULTS } = await import('./memory.types.js');
      expect((MEMORY_V2_MIGRATION_DEFAULTS as Record<string, unknown>).ttl).toBeUndefined();
    });
  });

  describe('RoleKnowledgeEntry v3 (M3) optional fields', () => {
    it('accepts importance, evidence, ttl, shouldInjectByDefault on a fresh entry', () => {
      const entry: RoleKnowledgeEntry = {
        id: 'rk-v3-001',
        category: 'best-practice',
        content: 'Steve prefers vehicle-tier pricing reviewed quarterly',
        confidence: 0.9,
        createdAt: '2026-05-03T17:00:00Z',
        importance: 0.95,
        evidence: ['slack:1772912297.332929', 'request:req-pricing-2026-q2'],
        ttl: '2026-08-01T00:00:00Z',
        shouldInjectByDefault: true,
      };
      expect(entry.importance).toBe(0.95);
      expect(entry.evidence).toHaveLength(2);
      expect(entry.ttl).toBe('2026-08-01T00:00:00Z');
      expect(entry.shouldInjectByDefault).toBe(true);
    });

    it('treats all v3 fields as optional (existing v1-shape entries still typecheck)', () => {
      const entry: RoleKnowledgeEntry = {
        id: 'rk-legacy-001',
        category: 'workflow',
        content: 'Old entry without v3 fields',
        confidence: 0.7,
        createdAt: '2026-01-01T00:00:00Z',
      };
      expect(entry.importance).toBeUndefined();
      expect(entry.evidence).toBeUndefined();
      expect(entry.ttl).toBeUndefined();
      expect(entry.shouldInjectByDefault).toBeUndefined();
    });
  });

  describe('Type Structure Validation', () => {
    it('should create a valid RoleKnowledgeEntry', () => {
      const entry: RoleKnowledgeEntry = {
        id: 'rk-001',
        category: 'best-practice',
        content: 'Always run tests before committing',
        learnedFrom: 'TICKET-123',
        confidence: 0.85,
        createdAt: '2026-01-29T10:00:00Z',
        lastUsed: '2026-01-29T14:30:00Z',
        tags: ['testing', 'workflow'],
      };

      expect(entry.id).toBe('rk-001');
      expect(entry.category).toBe('best-practice');
      expect(entry.confidence).toBeGreaterThanOrEqual(0);
      expect(entry.confidence).toBeLessThanOrEqual(1);
    });

    it('should create a valid PatternEntry', () => {
      const pattern: PatternEntry = {
        id: 'pat-001',
        category: 'api',
        title: 'Error Handling Wrapper',
        description: 'All API endpoints use handleApiError() wrapper',
        example: 'app.get("/api/users", handleApiError(handler))',
        files: ['backend/src/utils/api-errors.ts'],
        discoveredBy: 'backend-dev-001',
        createdAt: '2026-01-15T10:00:00Z',
        tags: ['api', 'error-handling'],
      };

      expect(pattern.id).toBe('pat-001');
      expect(pattern.category).toBe('api');
      expect(pattern.files).toContain('backend/src/utils/api-errors.ts');
    });

    it('should create a valid DecisionEntry', () => {
      const decision: DecisionEntry = {
        id: 'dec-001',
        title: 'State Management Choice',
        decision: 'Use React Context API instead of Redux',
        rationale: 'Project scope is small',
        alternatives: ['Redux', 'MobX', 'Zustand'],
        decidedBy: 'tech-lead',
        decidedAt: '2026-01-10T14:00:00Z',
        affectedAreas: ['frontend/src/contexts/'],
        status: 'active',
      };

      expect(decision.id).toBe('dec-001');
      expect(decision.status).toBe('active');
      expect(decision.alternatives).toHaveLength(3);
    });

    it('should create a valid GotchaEntry', () => {
      const gotcha: GotchaEntry = {
        id: 'got-001',
        title: 'PostgreSQL connection pool exhaustion',
        problem: 'Database connections leak without proper cleanup',
        solution: 'Always use try/finally with client.release()',
        severity: 'high',
        discoveredBy: 'backend-dev-001',
        createdAt: '2026-01-20T09:00:00Z',
        relatedFiles: ['backend/src/db/pool.ts'],
        resolved: false,
      };

      expect(gotcha.id).toBe('got-001');
      expect(gotcha.severity).toBe('high');
      expect(gotcha.resolved).toBe(false);
    });

    it('should create a valid RelationshipEntry', () => {
      const relationship: RelationshipEntry = {
        id: 'rel-001',
        from: 'UserController',
        to: 'AuthService',
        relationshipType: 'depends-on',
        description: 'UserController requires AuthService for auth checks',
        fromFile: 'backend/src/controllers/user.controller.ts',
        toFile: 'backend/src/services/auth.service.ts',
      };

      expect(relationship.id).toBe('rel-001');
      expect(relationship.relationshipType).toBe('depends-on');
    });

    it('should create a valid LearningEntry', () => {
      const learning: LearningEntry = {
        timestamp: '2026-01-29T15:00:00Z',
        agentId: 'backend-dev-001',
        agentRole: 'backend-developer',
        category: 'pattern',
        title: 'API Error Handling Pattern',
        content: 'All API endpoints use handleApiError() wrapper',
        relatedFiles: ['backend/src/utils/api-errors.ts'],
        relatedTask: 'TICKET-456',
      };

      expect(learning.agentId).toBe('backend-dev-001');
      expect(learning.category).toBe('pattern');
    });

    it('should create a valid AgentMemory', () => {
      const agentMemory: AgentMemory = {
        agentId: 'frontend-dev-001',
        role: 'frontend-developer',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-29T15:00:00Z',
        ...DEFAULT_AGENT_MEMORY,
      };

      expect(agentMemory.agentId).toBe('frontend-dev-001');
      expect(agentMemory.role).toBe('frontend-developer');
      expect(agentMemory.roleKnowledge).toEqual([]);
    });

    it('should create a valid ProjectMemory', () => {
      const projectMemory: ProjectMemory = {
        projectId: 'proj-001',
        projectPath: '/home/user/projects/my-app',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-29T15:00:00Z',
        ...DEFAULT_PROJECT_MEMORY,
      };

      expect(projectMemory.projectId).toBe('proj-001');
      expect(projectMemory.projectPath).toBe('/home/user/projects/my-app');
      expect(projectMemory.patterns).toEqual([]);
    });

    it('should create valid MemoryQueryOptions', () => {
      const queryOptions: MemoryQueryOptions = {
        scope: 'agent',
        category: 'best-practice',
        tags: ['testing'],
        minConfidence: 0.5,
        limit: 10,
        searchText: 'test',
        since: '2026-01-01T00:00:00Z',
      };

      expect(queryOptions.scope).toBe('agent');
      expect(queryOptions.minConfidence).toBe(0.5);
    });
  });

  describe('Type Categories', () => {
    it('should accept valid RoleKnowledgeCategory values', () => {
      const categories: RoleKnowledgeCategory[] = ['best-practice', 'anti-pattern', 'tool-usage', 'workflow'];
      categories.forEach(cat => {
        const entry: RoleKnowledgeEntry = {
          id: 'test',
          category: cat,
          content: 'test',
          confidence: 0.5,
          createdAt: '2026-01-01T00:00:00Z',
        };
        expect(entry.category).toBe(cat);
      });
    });

    it('should accept valid PatternCategory values', () => {
      const categories: PatternCategory[] = ['api', 'component', 'service', 'testing', 'styling', 'database', 'config', 'other'];
      categories.forEach(cat => {
        const pattern: PatternEntry = {
          id: 'test',
          category: cat,
          title: 'Test',
          description: 'Test',
          discoveredBy: 'test-agent',
          createdAt: '2026-01-01T00:00:00Z',
        };
        expect(pattern.category).toBe(cat);
      });
    });

    it('should accept valid GotchaSeverity values', () => {
      const severities: GotchaSeverity[] = ['low', 'medium', 'high', 'critical'];
      severities.forEach(sev => {
        const gotcha: GotchaEntry = {
          id: 'test',
          title: 'Test',
          problem: 'Test problem',
          solution: 'Test solution',
          severity: sev,
          discoveredBy: 'test-agent',
          createdAt: '2026-01-01T00:00:00Z',
        };
        expect(gotcha.severity).toBe(sev);
      });
    });

    it('should accept valid RelationshipType values', () => {
      const types: RelationshipType[] = ['depends-on', 'uses', 'extends', 'implements', 'calls', 'imported-by'];
      types.forEach(type => {
        const rel: RelationshipEntry = {
          id: 'test',
          from: 'ComponentA',
          to: 'ComponentB',
          relationshipType: type,
        };
        expect(rel.relationshipType).toBe(type);
      });
    });

    it('should accept valid LearningCategory values', () => {
      const categories: LearningCategory[] = ['pattern', 'decision', 'gotcha', 'insight', 'improvement'];
      categories.forEach(cat => {
        const learning: LearningEntry = {
          timestamp: '2026-01-01T00:00:00Z',
          agentId: 'test',
          agentRole: 'developer',
          category: cat,
          title: 'Test',
          content: 'Test content',
        };
        expect(learning.category).toBe(cat);
      });
    });

    it('should accept valid VerbosityLevel values', () => {
      const levels: VerbosityLevel[] = ['concise', 'detailed'];
      levels.forEach(level => {
        expect(['concise', 'detailed']).toContain(level);
      });
    });

    it('should accept valid BreakdownSize values', () => {
      const sizes: BreakdownSize[] = ['small', 'medium', 'large'];
      sizes.forEach(size => {
        expect(['small', 'medium', 'large']).toContain(size);
      });
    });
  });
});
