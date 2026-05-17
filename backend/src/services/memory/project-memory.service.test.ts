/**
 * Unit tests for ProjectMemoryService
 *
 * Tests project-level memory management including patterns, decisions, gotchas, and relationships.
 *
 * @module services/memory/project-memory.service.test
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ProjectMemoryService } from './project-memory.service.js';
import { MEMORY_CONSTANTS, CREWLY_CONSTANTS } from '../../constants.js';

describe('ProjectMemoryService', () => {
  let service: ProjectMemoryService;
  let testProjectPath: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testProjectPath = path.join(os.tmpdir(), `crewly-project-test-${Date.now()}-${Math.random().toString(36).substring(2)}`);
    await fs.mkdir(testProjectPath, { recursive: true });

    // Clear singleton and create new instance
    ProjectMemoryService.clearInstance();
    service = ProjectMemoryService.getInstance();
  });

  afterEach(async () => {
    // Clean up test directory
    ProjectMemoryService.clearInstance();
    try {
      await fs.rm(testProjectPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ProjectMemoryService.getInstance();
      const instance2 = ProjectMemoryService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initializeProject', () => {
    it('should create knowledge directory structure', async () => {
      await service.initializeProject(testProjectPath);

      const knowledgePath = path.join(testProjectPath, CREWLY_CONSTANTS.PATHS.CREWLY_HOME, MEMORY_CONSTANTS.PATHS.KNOWLEDGE_DIR);
      const indexFile = path.join(knowledgePath, MEMORY_CONSTANTS.PROJECT_FILES.INDEX);
      const patternsFile = path.join(knowledgePath, MEMORY_CONSTANTS.PROJECT_FILES.PATTERNS);
      const learningsFile = path.join(knowledgePath, MEMORY_CONSTANTS.PROJECT_FILES.LEARNINGS);

      const indexExists = await fs.stat(indexFile).then(() => true).catch(() => false);
      const patternsExists = await fs.stat(patternsFile).then(() => true).catch(() => false);
      const learningsExists = await fs.stat(learningsFile).then(() => true).catch(() => false);

      expect(indexExists).toBe(true);
      expect(patternsExists).toBe(true);
      expect(learningsExists).toBe(true);
    });

    it('should create project memory with correct initial values', async () => {
      await service.initializeProject(testProjectPath);

      const memory = await service.getProjectMemory(testProjectPath);

      expect(memory).not.toBeNull();
      expect(memory?.projectPath).toBe(testProjectPath);
      expect(memory?.patterns).toEqual([]);
      expect(memory?.decisions).toEqual([]);
    });

    it('should not reinitialize existing project', async () => {
      await service.initializeProject(testProjectPath);
      const firstMemory = await service.getProjectMemory(testProjectPath);

      await service.initializeProject(testProjectPath);
      const secondMemory = await service.getProjectMemory(testProjectPath);

      expect(secondMemory?.createdAt).toBe(firstMemory?.createdAt);
    });
  });

  describe('Patterns', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    describe('addPattern', () => {
      it('should add new pattern entry', async () => {
        const patternId = await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'Error Handling Wrapper',
          description: 'All API endpoints use handleApiError() wrapper',
          discoveredBy: 'backend-dev-001',
        });

        expect(patternId).toBeDefined();

        const patterns = await service.getPatterns(testProjectPath);
        expect(patterns).toHaveLength(1);
        expect(patterns[0].title).toBe('Error Handling Wrapper');
      });

      it('should return existing pattern for similar content', async () => {
        const firstId = await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'Error Handling',
          description: 'All API endpoints use handleApiError() wrapper',
          discoveredBy: 'dev-001',
        });

        const secondId = await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'Error Handling',
          description: 'All API endpoints use handleApiError() wrapper',
          discoveredBy: 'dev-002',
        });

        expect(firstId).toBe(secondId);

        const patterns = await service.getPatterns(testProjectPath);
        expect(patterns).toHaveLength(1);
      });

      it('should update existing pattern with new example', async () => {
        const firstId = await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'Error Handling',
          description: 'Use error wrapper',
          discoveredBy: 'dev-001',
        });

        await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'Error Handling',
          description: 'Use error wrapper',
          example: 'handleApiError(handler)',
          discoveredBy: 'dev-002',
        });

        const patterns = await service.getPatterns(testProjectPath);
        expect(patterns[0].example).toBe('handleApiError(handler)');
      });
    });

    describe('getPatterns', () => {
      beforeEach(async () => {
        await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'API Pattern',
          description: 'API description',
          discoveredBy: 'dev-001',
        });
        await service.addPattern(testProjectPath, {
          category: 'component',
          title: 'Component Pattern',
          description: 'Component description',
          discoveredBy: 'dev-001',
        });
      });

      it('should return all patterns', async () => {
        const patterns = await service.getPatterns(testProjectPath);
        expect(patterns).toHaveLength(2);
      });

      it('should filter by category', async () => {
        const apiPatterns = await service.getPatterns(testProjectPath, 'api');
        expect(apiPatterns).toHaveLength(1);
        expect(apiPatterns[0].category).toBe('api');
      });
    });

    describe('searchPatterns', () => {
      beforeEach(async () => {
        await service.addPattern(testProjectPath, {
          category: 'api',
          title: 'Error Handling',
          description: 'Use error wrapper for all endpoints',
          discoveredBy: 'dev-001',
        });
        await service.addPattern(testProjectPath, {
          category: 'testing',
          title: 'Test Setup',
          description: 'Initialize test fixtures before each test',
          discoveredBy: 'dev-001',
        });
      });

      it('should find patterns by title', async () => {
        const results = await service.searchPatterns(testProjectPath, 'error');
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('Error Handling');
      });

      it('should find patterns by description', async () => {
        const results = await service.searchPatterns(testProjectPath, 'fixtures');
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('Test Setup');
      });

      it('should return empty array for no matches', async () => {
        const results = await service.searchPatterns(testProjectPath, 'nonexistent');
        expect(results).toHaveLength(0);
      });
    });
  });

  describe('Decisions', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    describe('addDecision', () => {
      it('should add new decision entry', async () => {
        const decisionId = await service.addDecision(testProjectPath, {
          title: 'State Management',
          decision: 'Use React Context instead of Redux',
          rationale: 'Project scope is small',
          decidedBy: 'tech-lead',
        });

        expect(decisionId).toBeDefined();

        const decisions = await service.getDecisions(testProjectPath);
        expect(decisions).toHaveLength(1);
        expect(decisions[0].status).toBe('active');
      });

      it('should return existing decision when title AND decision content both match', async () => {
        // P0-SEV: post-fix, dedup requires BOTH title and decision-content similarity.
        const firstId = await service.addDecision(testProjectPath, {
          title: 'Database Choice',
          decision: 'Use PostgreSQL',
          rationale: 'Team familiarity',
          decidedBy: 'tech-lead',
        });

        const secondId = await service.addDecision(testProjectPath, {
          title: 'Database Choice',
          decision: 'Use PostgreSQL',
          rationale: 'Different rationale (ignored on dedup)',
          decidedBy: 'dev-001',
        });

        expect(firstId).toBe(secondId);
      });
    });

    describe('getDecisions', () => {
      it('should return decisions sorted by status and date', async () => {
        await service.addDecision(testProjectPath, {
          title: 'First Decision',
          decision: 'Decision 1',
          rationale: 'Rationale 1',
          decidedBy: 'tech-lead',
        });

        await new Promise(resolve => setTimeout(resolve, 10));

        await service.addDecision(testProjectPath, {
          title: 'Second Decision',
          decision: 'Decision 2',
          rationale: 'Rationale 2',
          decidedBy: 'tech-lead',
        });

        const decisions = await service.getDecisions(testProjectPath);
        expect(decisions).toHaveLength(2);
        expect(decisions[0].status).toBe('active');
      });
    });
  });

  describe('Gotchas', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    describe('addGotcha', () => {
      it('should add new gotcha entry', async () => {
        const gotchaId = await service.addGotcha(testProjectPath, {
          title: 'Connection Pool Leak',
          problem: 'Database connections leak without cleanup',
          solution: 'Always use try/finally with client.release()',
          severity: 'high',
          discoveredBy: 'backend-dev',
        });

        expect(gotchaId).toBeDefined();

        const gotchas = await service.getGotchas(testProjectPath);
        expect(gotchas).toHaveLength(1);
        expect(gotchas[0].severity).toBe('high');
      });

      it('should update solution for similar gotcha', async () => {
        await service.addGotcha(testProjectPath, {
          title: 'Memory Issue',
          problem: 'Memory leaks in component',
          solution: 'Short solution',
          severity: 'medium',
          discoveredBy: 'dev-001',
        });

        await service.addGotcha(testProjectPath, {
          title: 'Memory Issue',
          problem: 'Memory leaks in component',
          solution: 'Much longer and more detailed solution with better explanation',
          severity: 'medium',
          discoveredBy: 'dev-002',
        });

        const gotchas = await service.getGotchas(testProjectPath);
        expect(gotchas).toHaveLength(1);
        expect(gotchas[0].solution).toContain('longer and more detailed');
      });
    });

    describe('getGotchas', () => {
      beforeEach(async () => {
        await service.addGotcha(testProjectPath, {
          title: 'Low Priority Issue',
          problem: 'Minor issue',
          solution: 'Minor fix',
          severity: 'low',
          discoveredBy: 'dev-001',
        });
        await service.addGotcha(testProjectPath, {
          title: 'Critical Issue',
          problem: 'Critical problem',
          solution: 'Critical fix',
          severity: 'critical',
          discoveredBy: 'dev-001',
        });
        await service.addGotcha(testProjectPath, {
          title: 'High Priority Issue',
          problem: 'High issue',
          solution: 'High fix',
          severity: 'high',
          discoveredBy: 'dev-001',
        });
      });

      it('should return gotchas sorted by severity', async () => {
        const gotchas = await service.getGotchas(testProjectPath);
        expect(gotchas[0].severity).toBe('critical');
        expect(gotchas[1].severity).toBe('high');
        expect(gotchas[2].severity).toBe('low');
      });

      it('should filter by severity', async () => {
        const highGotchas = await service.getGotchas(testProjectPath, 'high');
        expect(highGotchas).toHaveLength(1);
        expect(highGotchas[0].severity).toBe('high');
      });
    });
  });

  describe('Relationships', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    describe('addRelationship', () => {
      it('should add new relationship entry', async () => {
        const relationshipId = await service.addRelationship(testProjectPath, {
          from: 'UserController',
          to: 'AuthService',
          relationshipType: 'depends-on',
          description: 'Controller needs auth for validation',
        });

        expect(relationshipId).toBeDefined();

        const relationships = await service.getRelationships(testProjectPath);
        expect(relationships).toHaveLength(1);
      });

      it('should return existing relationship for same connection', async () => {
        const firstId = await service.addRelationship(testProjectPath, {
          from: 'A',
          to: 'B',
          relationshipType: 'uses',
        });

        const secondId = await service.addRelationship(testProjectPath, {
          from: 'A',
          to: 'B',
          relationshipType: 'uses',
          description: 'Now with description',
        });

        expect(firstId).toBe(secondId);

        const relationships = await service.getRelationships(testProjectPath);
        expect(relationships).toHaveLength(1);
        expect(relationships[0].description).toBe('Now with description');
      });
    });

    describe('getRelationships', () => {
      beforeEach(async () => {
        await service.addRelationship(testProjectPath, {
          from: 'A',
          to: 'B',
          relationshipType: 'uses',
        });
        await service.addRelationship(testProjectPath, {
          from: 'B',
          to: 'C',
          relationshipType: 'depends-on',
        });
        await service.addRelationship(testProjectPath, {
          from: 'D',
          to: 'E',
          relationshipType: 'implements',
        });
      });

      it('should return all relationships', async () => {
        const relationships = await service.getRelationships(testProjectPath);
        expect(relationships).toHaveLength(3);
      });

      it('should filter by component name', async () => {
        const bRelationships = await service.getRelationships(testProjectPath, 'B');
        expect(bRelationships).toHaveLength(2);
      });
    });
  });

  describe('Learnings', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    describe('recordLearning', () => {
      it('should append learning to log', async () => {
        await service.recordLearning(
          testProjectPath,
          'dev-001',
          'developer',
          'Discovered that async/await is preferred over callbacks'
        );

        const learnings = await service.getRecentLearnings(testProjectPath);
        expect(learnings).toContain('async/await');
        expect(learnings).toContain('dev-001');
      });

      it('should include metadata in learning entry', async () => {
        await service.recordLearning(
          testProjectPath,
          'dev-001',
          'developer',
          'Found pattern in API',
          { type: 'pattern', relatedFiles: ['src/api.ts'] }
        );

        const learnings = await service.getRecentLearnings(testProjectPath);
        expect(learnings).toContain('src/api.ts');
        expect(learnings).toContain('pattern');
      });
    });

    describe('getRecentLearnings', () => {
      beforeEach(async () => {
        for (let i = 0; i < 15; i++) {
          await service.recordLearning(
            testProjectPath,
            'dev-001',
            'developer',
            `Learning number ${i}`
          );
        }
      });

      it('should return limited number of entries', async () => {
        const learnings = await service.getRecentLearnings(testProjectPath, 5);
        // Count occurrences of "Learning number"
        const matches = learnings.match(/Learning number \d+/g);
        expect(matches?.length).toBe(5);
      });

      it('should return most recent entries', async () => {
        const learnings = await service.getRecentLearnings(testProjectPath, 3);
        expect(learnings).toContain('Learning number 14');
        expect(learnings).toContain('Learning number 13');
        expect(learnings).toContain('Learning number 12');
      });
    });
  });

  describe('generateProjectContext', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    it('should include critical gotchas', async () => {
      await service.addGotcha(testProjectPath, {
        title: 'Critical Bug',
        problem: 'Critical problem',
        solution: 'Critical solution',
        severity: 'critical',
        discoveredBy: 'dev-001',
      });

      const context = await service.generateProjectContext(testProjectPath);
      expect(context).toContain('Critical Gotchas');
      expect(context).toContain('Critical Bug');
    });

    it('should include patterns', async () => {
      await service.addPattern(testProjectPath, {
        category: 'api',
        title: 'API Pattern',
        description: 'Use this pattern for APIs',
        discoveredBy: 'dev-001',
      });

      const context = await service.generateProjectContext(testProjectPath);
      expect(context).toContain('Code Patterns');
      expect(context).toContain('API Pattern');
    });

    it('should include active decisions', async () => {
      await service.addDecision(testProjectPath, {
        title: 'Tech Choice',
        decision: 'Use TypeScript',
        rationale: 'Type safety',
        decidedBy: 'tech-lead',
      });

      const context = await service.generateProjectContext(testProjectPath);
      expect(context).toContain('Architecture Decisions');
      expect(context).toContain('Tech Choice');
    });
  });

  describe('searchAll', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
      await service.addPattern(testProjectPath, {
        category: 'api',
        title: 'Authentication Pattern',
        description: 'JWT authentication flow',
        discoveredBy: 'dev-001',
      });
      await service.addDecision(testProjectPath, {
        title: 'Auth Decision',
        decision: 'Use JWT for authentication',
        rationale: 'Stateless auth',
        decidedBy: 'tech-lead',
      });
      await service.addGotcha(testProjectPath, {
        title: 'Auth Token Expiry',
        problem: 'Tokens expire silently',
        solution: 'Implement refresh token flow',
        severity: 'medium',
        discoveredBy: 'dev-001',
      });
    });

    it('should search across all entity types', async () => {
      const results = await service.searchAll(testProjectPath, 'auth');
      expect(results.patterns.length).toBeGreaterThan(0);
      expect(results.decisions.length).toBeGreaterThan(0);
      expect(results.gotchas.length).toBeGreaterThan(0);
      expect(results.totalCount).toBe(3);
    });

    it('should return empty results for no matches', async () => {
      const results = await service.searchAll(testProjectPath, 'nonexistent');
      expect(results.totalCount).toBe(0);
    });
  });

  describe('getProjectMemory', () => {
    it('should return null for uninitialized project', async () => {
      const memory = await service.getProjectMemory('/nonexistent/path');
      expect(memory).toBeNull();
    });

    it('should return project memory object', async () => {
      await service.initializeProject(testProjectPath);

      const memory = await service.getProjectMemory(testProjectPath);

      expect(memory).not.toBeNull();
      expect(memory).toHaveProperty('projectId');
      expect(memory).toHaveProperty('projectPath');
    });
  });

  /**
   * Regression suite for the P0-SEV silent-success bug: rememberForProject
   * collisions on default titles caused different content to be silently
   * collapsed onto the same (stale) entry id.
   *
   * Pre-fix invariant (broken): same title OR similar content => dedup hit
   * Post-fix invariant: same title AND similar content => dedup hit
   *
   * These tests FAIL on main and PASS on the fix branch.
   */
  describe('Silent-success regression (P0-SEV: dedup tightened to title AND content)', () => {
    beforeEach(async () => {
      await service.initializeProject(testProjectPath);
    });

    describe('Patterns', () => {
      it('does NOT dedup two distinct contents that share the default title', async () => {
        const firstId = await service.addPattern(testProjectPath, {
          category: 'other',
          title: 'Untitled Pattern',
          description: 'first distinct pattern body — auth retry policy is 3x with jitter',
          discoveredBy: 'dev-001',
        });

        const secondId = await service.addPattern(testProjectPath, {
          category: 'other',
          title: 'Untitled Pattern',
          description: 'second distinct pattern body — DB pool size capped at 20',
          discoveredBy: 'dev-002',
        });

        expect(firstId).not.toBe(secondId);
        const patterns = await service.getPatterns(testProjectPath);
        expect(patterns).toHaveLength(2);
      });

      it('STILL dedups identical content+title (legitimate dedup preserved)', async () => {
        const firstId = await service.addPattern(testProjectPath, {
          category: 'other',
          title: 'Same Title',
          description: 'identical content body',
          discoveredBy: 'dev-001',
        });
        const secondId = await service.addPattern(testProjectPath, {
          category: 'other',
          title: 'Same Title',
          description: 'identical content body',
          discoveredBy: 'dev-002',
        });

        expect(firstId).toBe(secondId);
        const patterns = await service.getPatterns(testProjectPath);
        expect(patterns).toHaveLength(1);
      });
    });

    describe('Decisions', () => {
      it('does NOT dedup two distinct contents that share the default title', async () => {
        const firstId = await service.addDecision(testProjectPath, {
          title: 'Untitled Decision',
          decision: 'first distinct decision — adopt Vitest for unit testing',
          rationale: 'r1',
          decidedBy: 'tech-lead',
        });

        const secondId = await service.addDecision(testProjectPath, {
          title: 'Untitled Decision',
          decision: 'second distinct decision — switch to pnpm for monorepo',
          rationale: 'r2',
          decidedBy: 'dev-001',
        });

        expect(firstId).not.toBe(secondId);
        const decisions = await service.getDecisions(testProjectPath);
        expect(decisions).toHaveLength(2);
      });

      it('STILL dedups identical content+title (legitimate dedup preserved)', async () => {
        const firstId = await service.addDecision(testProjectPath, {
          title: 'Pinned Decision',
          decision: 'identical decision body',
          rationale: 'r1',
          decidedBy: 'tech-lead',
        });
        const secondId = await service.addDecision(testProjectPath, {
          title: 'Pinned Decision',
          decision: 'identical decision body',
          rationale: 'r2',
          decidedBy: 'dev-001',
        });

        expect(firstId).toBe(secondId);
      });
    });

    describe('Gotchas', () => {
      it('does NOT dedup two distinct contents that share the default title', async () => {
        const firstId = await service.addGotcha(testProjectPath, {
          title: 'Gotcha',
          problem: 'first distinct gotcha problem — race in webhook retry queue',
          solution: 's1',
          severity: 'medium',
          discoveredBy: 'dev-001',
        });

        const secondId = await service.addGotcha(testProjectPath, {
          title: 'Gotcha',
          problem: 'second distinct gotcha problem — float comparison in pricing module',
          solution: 's2',
          severity: 'medium',
          discoveredBy: 'dev-002',
        });

        expect(firstId).not.toBe(secondId);
        const gotchas = await service.getGotchas(testProjectPath);
        expect(gotchas).toHaveLength(2);
      });

      it('STILL dedups identical content+title (legitimate dedup preserved)', async () => {
        const firstId = await service.addGotcha(testProjectPath, {
          title: 'Pinned Gotcha',
          problem: 'identical gotcha body',
          solution: 's1',
          severity: 'medium',
          discoveredBy: 'dev-001',
        });
        const secondId = await service.addGotcha(testProjectPath, {
          title: 'Pinned Gotcha',
          problem: 'identical gotcha body',
          solution: 's1 (no longer)',
          severity: 'medium',
          discoveredBy: 'dev-002',
        });

        expect(firstId).toBe(secondId);
      });
    });

    describe('Visibility', () => {
      it('logs a WARN line when a dedup hit occurs (observable signal)', async () => {
        // Spy on the service's logger to confirm WARN-level surfacing of dedup hits.
        // This is the regression-detector for the silent-fail class of bugs:
        // future dedup-predicate drift will be visible in observability instead of vanishing.
        // We capture the logger from the service instance and watch for `.warn` calls.
        const logger = (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger;
        const warnSpy = jest.spyOn(logger, 'warn');

        await service.addGotcha(testProjectPath, {
          title: 'Pinned Gotcha',
          problem: 'identical gotcha body',
          solution: 's',
          severity: 'medium',
          discoveredBy: 'dev-001',
        });
        await service.addGotcha(testProjectPath, {
          title: 'Pinned Gotcha',
          problem: 'identical gotcha body',
          solution: 's',
          severity: 'medium',
          discoveredBy: 'dev-002',
        });

        // First call: insert (no warn). Second call: dedup hit (warn).
        const dedupWarns = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === 'string' && msg.includes('dedup hit')
        );
        expect(dedupWarns.length).toBeGreaterThanOrEqual(1);
        // Payload includes the colliding-id field for triage
        const dedupCall = dedupWarns[0];
        expect(dedupCall[1]).toHaveProperty('existingGotchaId');

        warnSpy.mockRestore();
      });
    });
  });
});
