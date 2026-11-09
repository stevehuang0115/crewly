/**
 * Tests for SOP Type Definitions
 *
 * @module types/sop.types.test
 */
import {
  SOP,
  SOPRole,
  SOPCategory,
  SOPCondition,
  SOPExample,
  SOPIndexEntry,
  SOPIndex,
  SOPMatchParams,
  SOPFrontmatter,
  ParsedSOP,
  SOP_CONSTANTS,
  DEFAULT_SOP_CATEGORIES,
  ALL_SOP_ROLES,
  ALL_SOP_CATEGORIES,
} from './sop.types.js';

describe('SOP Types', () => {
  describe('SOPRole type', () => {
    it('should allow all valid roles', () => {
      const roles: SOPRole[] = [
        'orchestrator',
        'pm',
        'tpm',
        'pgm',
        'developer',
        'frontend-developer',
        'backend-developer',
        'qa',
        'tester',
        'designer',
        'devops',
      ];

      expect(roles).toHaveLength(11);
    });
  });

  describe('SOPCategory type', () => {
    it('should allow all valid categories', () => {
      const categories: SOPCategory[] = [
        'workflow',
        'quality',
        'communication',
        'escalation',
        'tools',
        'debugging',
        'testing',
        'git',
        'security',
      ];

      expect(categories).toHaveLength(9);
    });
  });

  describe('SOPFrontmatter rule metadata (#877)', () => {
    it('carries the optional prevents / seenOn / reviewBy / source fields', () => {
      const fm: SOPFrontmatter = {
        id: 'common-x',
        version: 1,
        createdAt: '2026-10-23T00:00:00Z',
        updatedAt: '2026-10-23T00:00:00Z',
        createdBy: 'system',
        role: 'all',
        category: 'communication',
        priority: 5,
        title: 'X',
        description: 'd',
        triggers: ['x'],
        tags: [],
        prevents: 'Owner-facing messages leaked task ids',
        seenOn: 'claude-code (2026-05)',
        reviewBy: '2027-01-31',
        source: 'https://github.com/stevehuang0115/crewly/pull/413',
      };
      expect(fm.prevents).toContain('leaked');
      expect(fm.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const bare: SOPFrontmatter = { ...fm, prevents: undefined, seenOn: undefined, reviewBy: undefined, source: undefined };
      expect(bare.prevents).toBeUndefined();
    });
  });

  describe('SOPCondition interface', () => {
    it('should define a task-type condition', () => {
      const condition: SOPCondition = {
        type: 'task-type',
        value: 'feature',
        operator: 'equals',
      };

      expect(condition.type).toBe('task-type');
      expect(condition.operator).toBe('equals');
    });

    it('should define a file-pattern condition', () => {
      const condition: SOPCondition = {
        type: 'file-pattern',
        value: '*.test.ts',
        operator: 'matches',
      };

      expect(condition.type).toBe('file-pattern');
      expect(condition.operator).toBe('matches');
    });

    it('should define a project-type condition', () => {
      const condition: SOPCondition = {
        type: 'project-type',
        value: 'typescript',
        operator: 'contains',
      };

      expect(condition.type).toBe('project-type');
    });
  });

  describe('SOPExample interface', () => {
    it('should define an example with all fields', () => {
      const example: SOPExample = {
        title: 'Good Commit Message',
        scenario: 'Adding a new API endpoint',
        correctApproach: 'feat(api): add user search endpoint',
        incorrectApproach: 'WIP',
      };

      expect(example.title).toBe('Good Commit Message');
      expect(example.incorrectApproach).toBe('WIP');
    });

    it('should define an example without incorrectApproach', () => {
      const example: SOPExample = {
        title: 'Test Example',
        scenario: 'Writing a unit test',
        correctApproach: 'Use describe/it blocks',
      };

      expect(example.incorrectApproach).toBeUndefined();
    });
  });

  describe('SOP interface', () => {
    it('should define a complete SOP', () => {
      const sop: SOP = {
        id: 'dev-git-workflow',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-29T00:00:00Z',
        createdBy: 'system',
        role: 'developer',
        category: 'git',
        priority: 10,
        title: 'Git Workflow',
        description: 'Standard git workflow for developers',
        content: '# Git Workflow\n\nFollow these steps...',
        triggers: ['commit', 'push', 'branch'],
        tags: ['git', 'workflow'],
      };

      expect(sop.id).toBe('dev-git-workflow');
      expect(sop.role).toBe('developer');
      expect(sop.triggers).toHaveLength(3);
    });

    it('should define an SOP with role "all"', () => {
      const sop: SOP = {
        id: 'common-communication',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        createdBy: 'system',
        role: 'all',
        category: 'communication',
        priority: 5,
        title: 'Communication Protocol',
        description: 'How to communicate with team members',
        content: '# Communication\n\n...',
        triggers: ['message', 'broadcast'],
        tags: ['communication'],
      };

      expect(sop.role).toBe('all');
    });

    it('should define an SOP with optional fields', () => {
      const sop: SOP = {
        id: 'dev-testing',
        version: 2,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-15T00:00:00Z',
        createdBy: 'agent-123',
        role: 'qa',
        category: 'testing',
        priority: 8,
        title: 'Testing Procedures',
        description: 'How to write tests',
        content: '# Testing\n\n...',
        triggers: ['test', 'spec'],
        conditions: [
          { type: 'file-pattern', value: '*.test.ts', operator: 'matches' },
        ],
        tags: ['testing', 'qa'],
        relatedSOPs: ['dev-code-review'],
        examples: [
          {
            title: 'Test Structure',
            scenario: 'Writing a unit test',
            correctApproach: 'Use describe/it blocks',
          },
        ],
      };

      expect(sop.conditions).toHaveLength(1);
      expect(sop.relatedSOPs).toContain('dev-code-review');
      expect(sop.examples).toHaveLength(1);
    });
  });

  describe('SOPIndexEntry interface', () => {
    it('should define an index entry', () => {
      const entry: SOPIndexEntry = {
        id: 'dev-git-workflow',
        path: 'system/developer/git-workflow.md',
        role: 'developer',
        category: 'git',
        priority: 10,
        triggers: ['commit', 'push'],
        title: 'Git Workflow',
        isSystem: true,
      };

      expect(entry.isSystem).toBe(true);
      expect(entry.path).toContain('system/');
    });
  });

  describe('SOPIndex interface', () => {
    it('should define a complete index', () => {
      const index: SOPIndex = {
        version: '1.0',
        lastUpdated: '2026-01-29T00:00:00Z',
        sops: [
          {
            id: 'dev-git-workflow',
            path: 'system/developer/git-workflow.md',
            role: 'developer',
            category: 'git',
            priority: 10,
            triggers: ['commit', 'push'],
            title: 'Git Workflow',
            isSystem: true,
          },
          {
            id: 'custom-team-process',
            path: 'custom/custom-team-process.md',
            role: 'all',
            category: 'workflow',
            priority: 5,
            triggers: ['team', 'process'],
            title: 'Custom Team Process',
            isSystem: false,
          },
        ],
      };

      expect(index.sops).toHaveLength(2);
      expect(index.sops[0].isSystem).toBe(true);
      expect(index.sops[1].isSystem).toBe(false);
    });
  });

  describe('SOPMatchParams interface', () => {
    it('should define match parameters', () => {
      const params: SOPMatchParams = {
        role: 'developer',
        taskContext: 'implementing a new API endpoint',
        taskType: 'feature',
        filePatterns: ['*.ts', '*.tsx'],
        limit: 3,
      };

      expect(params.role).toBe('developer');
      expect(params.limit).toBe(3);
    });

    it('should work with minimal parameters', () => {
      const params: SOPMatchParams = {
        role: 'qa',
        taskContext: 'writing tests',
      };

      expect(params.taskType).toBeUndefined();
      expect(params.filePatterns).toBeUndefined();
    });
  });

  describe('SOPFrontmatter interface', () => {
    it('should define frontmatter', () => {
      const frontmatter: SOPFrontmatter = {
        id: 'dev-testing',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        createdBy: 'system',
        role: 'developer',
        category: 'testing',
        priority: 5,
        title: 'Testing Requirements',
        description: 'How to write tests',
        triggers: ['test', 'spec'],
        tags: ['testing'],
      };

      expect(frontmatter.id).toBe('dev-testing');
    });
  });

  describe('ParsedSOP interface', () => {
    it('should define a parsed SOP', () => {
      const parsed: ParsedSOP = {
        frontmatter: {
          id: 'dev-testing',
          version: 1,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          createdBy: 'system',
          role: 'developer',
          category: 'testing',
          priority: 5,
          title: 'Testing Requirements',
          description: 'How to write tests',
          triggers: ['test', 'spec'],
          tags: ['testing'],
        },
        content: '# Testing Requirements\n\n...',
        examples: [
          {
            title: 'Test Example',
            scenario: 'Writing a unit test',
            correctApproach: 'Use describe/it blocks',
          },
        ],
      };

      expect(parsed.frontmatter.id).toBe('dev-testing');
      expect(parsed.content).toContain('# Testing');
    });
  });

  describe('SOP_CONSTANTS', () => {
    describe('PATHS', () => {
      it('should have correct path constants', () => {
        expect(SOP_CONSTANTS.PATHS.SOP_DIR).toBe('sops');
        expect(SOP_CONSTANTS.PATHS.SYSTEM_SOP_DIR).toBe('system');
        expect(SOP_CONSTANTS.PATHS.CUSTOM_SOP_DIR).toBe('custom');
        expect(SOP_CONSTANTS.PATHS.INDEX_FILE).toBe('index.json');
      });
    });

    describe('LIMITS', () => {
      it('should have correct limit constants', () => {
        expect(SOP_CONSTANTS.LIMITS.MAX_SOPS_IN_PROMPT).toBe(5);
        expect(SOP_CONSTANTS.LIMITS.MAX_SOP_CONTENT_LENGTH).toBe(2000);
        expect(SOP_CONSTANTS.LIMITS.MAX_TRIGGERS_PER_SOP).toBe(20);
        expect(SOP_CONSTANTS.LIMITS.MAX_CONDITIONS_PER_SOP).toBe(10);
        expect(SOP_CONSTANTS.LIMITS.MAX_EXAMPLES_PER_SOP).toBe(5);
      });
    });

    describe('MATCHING', () => {
      it('should have correct matching constants', () => {
        expect(SOP_CONSTANTS.MATCHING.MIN_TRIGGER_MATCH_SCORE).toBe(0.3);
        expect(SOP_CONSTANTS.MATCHING.DEFAULT_PRIORITY).toBe(5);
        expect(SOP_CONSTANTS.MATCHING.ROLE_MATCH_BOOST).toBe(0.3);
        expect(SOP_CONSTANTS.MATCHING.CATEGORY_MATCH_BOOST).toBe(0.2);
      });
    });

    describe('INDEX_VERSION', () => {
      it('should have correct index version', () => {
        expect(SOP_CONSTANTS.INDEX_VERSION).toBe('1.0');
      });
    });
  });

  describe('DEFAULT_SOP_CATEGORIES', () => {
    it('should have categories for all roles', () => {
      expect(DEFAULT_SOP_CATEGORIES.all).toContain('communication');
      expect(DEFAULT_SOP_CATEGORIES.developer).toContain('git');
      expect(DEFAULT_SOP_CATEGORIES.qa).toContain('testing');
      expect(DEFAULT_SOP_CATEGORIES.orchestrator).toContain('escalation');
    });

    it('should have security for backend-developer', () => {
      expect(DEFAULT_SOP_CATEGORIES['backend-developer']).toContain('security');
    });
  });

  describe('ALL_SOP_ROLES', () => {
    it('should contain all 11 roles', () => {
      expect(ALL_SOP_ROLES).toHaveLength(11);
      expect(ALL_SOP_ROLES).toContain('developer');
      expect(ALL_SOP_ROLES).toContain('orchestrator');
      expect(ALL_SOP_ROLES).toContain('qa');
    });
  });

  describe('ALL_SOP_CATEGORIES', () => {
    it('should contain all 9 categories', () => {
      expect(ALL_SOP_CATEGORIES).toHaveLength(9);
      expect(ALL_SOP_CATEGORIES).toContain('workflow');
      expect(ALL_SOP_CATEGORIES).toContain('security');
      expect(ALL_SOP_CATEGORIES).toContain('git');
    });
  });
});
