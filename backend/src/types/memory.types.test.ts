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
  type MemoryType,
  type TaskHistoryEntry,
  type TaskOutcome,
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

  // ---------------------------------------------------------------------------
  // M3 — v3 schema fields on RoleKnowledgeEntry
  // (spec §158-216: importance, evidence, ttl, shouldInjectByDefault).
  //
  // These tests assert the v3 fields are part of the type contract so that
  // accidental removal/rename produces a compile-time signal in addition to
  // the runtime eligibility tests in role-knowledge-eligibility.test.ts.
  // ---------------------------------------------------------------------------
  describe('RoleKnowledgeEntry v3 fields (M3)', () => {
    it('accepts an entry with all v3 lifecycle fields', () => {
      const entry: RoleKnowledgeEntry = {
        id: 'rk-v3-001',
        category: 'best-practice',
        content: 'Use parameterized queries to prevent SQL injection',
        confidence: 0.95,
        importance: 0.9,
        evidence: ['REQ-101', 'wi-202', 'TICKET-303'],
        ttl: '2099-12-31T23:59:59Z',
        shouldInjectByDefault: true,
        createdAt: '2026-05-04T10:00:00Z',
      };

      expect(entry.importance).toBe(0.9);
      expect(entry.evidence).toEqual(['REQ-101', 'wi-202', 'TICKET-303']);
      expect(entry.ttl).toBe('2099-12-31T23:59:59Z');
      expect(entry.shouldInjectByDefault).toBe(true);
    });

    it('accepts an entry with supersededBy reference (audit pointer)', () => {
      const entry: RoleKnowledgeEntry = {
        id: 'rk-old',
        category: 'workflow',
        content: 'Stale workflow note',
        confidence: 0.7,
        supersededBy: 'rk-newer',
        createdAt: '2026-04-01T00:00:00Z',
      };

      expect(entry.supersededBy).toBe('rk-newer');
    });

    it('treats v3 fields as optional (legacy entries remain valid)', () => {
      // A legacy entry without any v3 fields must still compile and behave
      // correctly — backward compatibility is non-negotiable.
      const legacy: RoleKnowledgeEntry = {
        id: 'rk-legacy',
        category: 'tool-usage',
        content: 'Legacy entry from pre-M3 schema',
        confidence: 0.8,
        createdAt: '2026-04-01T00:00:00Z',
      };

      expect(legacy.importance).toBeUndefined();
      expect(legacy.evidence).toBeUndefined();
      expect(legacy.ttl).toBeUndefined();
      expect(legacy.shouldInjectByDefault).toBeUndefined();
    });

    it('accepts shouldInjectByDefault=false for explicit opt-out entries', () => {
      const entry: RoleKnowledgeEntry = {
        id: 'rk-opt-out',
        category: 'anti-pattern',
        content: 'Niche guidance, only on explicit recall',
        confidence: 0.9,
        importance: 0.95,
        shouldInjectByDefault: false,
        createdAt: '2026-05-04T10:00:00Z',
      };

      expect(entry.shouldInjectByDefault).toBe(false);
    });
  });

  describe('TaskHistoryEntry — type-level constraints', () => {
    it('accepts a minimal real-task entry shaped like the JSDoc example', () => {
      const entry: TaskHistoryEntry = {
        id: 'th-7f3a2b',
        completedAt: '2026-05-18T14:32:11Z',
        agent: { sessionName: 'crewly-product-ella', role: 'fullstack-dev' },
        task: { description: 'Read MIT Role email from inbox', outcome: 'success', durationSec: 12 },
        capabilities: ['gmail:read', 'oauth:gmail'],
        toolsUsed: ['read_email_oauth'],
        taskId: 'task-1747575131-742',
      };

      expect(entry.task.outcome).toBe('success');
      expect(entry.capabilities).toContain('gmail:read');
      expect(entry.agent.teamId).toBeUndefined();
    });

    it('accepts a synthetic register_self declaration with outcome=declared', () => {
      const entry: TaskHistoryEntry = {
        id: 'th-decl-001',
        completedAt: '2026-05-18T10:00:00Z',
        agent: { sessionName: 'crewly-product-ella', role: 'fullstack-dev', teamId: 'team-mit' },
        task: {
          description: 'Self-declared capabilities at register_self',
          outcome: 'declared',
        },
        capabilities: ['oauth:gmail', 'oauth:calendar'],
        toolsUsed: [],
      };

      expect(entry.task.outcome).toBe('declared');
      expect(entry.toolsUsed).toEqual([]);
    });

    it('accepts a redactedDescription for privacy-sensitive entries', () => {
      const entry: TaskHistoryEntry = {
        id: 'th-redacted',
        completedAt: '2026-05-18T14:00:00Z',
        agent: { sessionName: 'crewly-finance-bob', role: 'analyst' },
        task: {
          description: 'Pulled card statements for user steve@example.com, total $4,231.22',
          outcome: 'success',
        },
        capabilities: ['plaid:read'],
        toolsUsed: ['fetch_transactions'],
        redactedDescription: 'Pulled card statements for current user',
      };

      expect(entry.redactedDescription).toBeDefined();
      expect(entry.redactedDescription).not.toContain('steve@example.com');
    });

    it('every TaskOutcome member is assignable to task.outcome', () => {
      // Compile-time check — the array literal forces TS to verify each value
      // is a valid TaskOutcome. Run-time assertion is just for coverage.
      const outcomes: TaskOutcome[] = ['success', 'failure', 'partial', 'declared'];
      for (const outcome of outcomes) {
        const entry: TaskHistoryEntry = {
          id: `th-${outcome}`,
          completedAt: '2026-05-18T00:00:00Z',
          agent: { sessionName: 's', role: 'r' },
          task: { description: 'x', outcome },
          capabilities: [],
          toolsUsed: [],
        };
        expect(entry.task.outcome).toBe(outcome);
      }
    });
  });

  describe('MemoryType — task-history admission', () => {
    it("includes 'task-history' alongside the five prior values", () => {
      const expected: MemoryType[] = [
        'procedural',
        'risk',
        'preference',
        'domain',
        'performance',
        'task-history',
      ];

      // Each value is assignable to MemoryType (compile-time).
      for (const t of expected) {
        const x: MemoryType = t;
        expect(typeof x).toBe('string');
      }
    });
  });

  describe('ProjectMemory.taskHistory — optional ledger', () => {
    it('allows ProjectMemory to carry a taskHistory array', () => {
      const project: ProjectMemory = {
        ...DEFAULT_PROJECT_MEMORY,
        projectId: 'proj-1',
        projectPath: '/tmp/proj',
        createdAt: '2026-05-18T00:00:00Z',
        updatedAt: '2026-05-18T00:00:00Z',
        taskHistory: [
          {
            id: 'th-1',
            completedAt: '2026-05-18T01:00:00Z',
            agent: { sessionName: 'crewly-orc', role: 'orchestrator' },
            task: { description: 'Bootstrap memory', outcome: 'success' },
            capabilities: ['code:read'],
            toolsUsed: ['read_file'],
          },
        ],
      };

      expect(project.taskHistory).toHaveLength(1);
      expect(project.taskHistory![0]!.capabilities).toEqual(['code:read']);
    });

    it('is omittable for backwards compatibility with older project memory files', () => {
      const legacy: ProjectMemory = {
        ...DEFAULT_PROJECT_MEMORY,
        projectId: 'proj-legacy',
        projectPath: '/tmp/legacy',
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      };

      expect(legacy.taskHistory).toBeUndefined();
    });
  });
});
