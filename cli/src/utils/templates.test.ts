/**
 * Tests for the team template loader utility.
 *
 * Validates template listing, retrieval by ID, handling of missing
 * templates directory, and malformed template files.
 */

import path from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';
import {
  listTemplates,
  getTemplate,
  getTemplatesDir,
  listOnboardingStarters,
  getDefaultStarterTemplate,
  type TeamTemplate,
} from './templates.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('fs', () => ({
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
  existsSync: jest.fn(),
  statSync: jest.fn(),
}));

const mockReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>;
const mockReaddirSync = readdirSync as jest.MockedFunction<typeof readdirSync>;
const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const { statSync: mockStatSync } = require('fs') as { statSync: jest.MockedFunction<typeof import('fs').statSync> };

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const SAMPLE_TEMPLATE: TeamTemplate = {
  id: 'test-team',
  name: 'Test Team',
  description: 'A test template',
  members: [
    {
      name: 'Dev',
      role: 'developer',
      systemPrompt: 'You are a developer.',
    },
  ],
};

const ANOTHER_TEMPLATE: TeamTemplate = {
  id: 'another-team',
  name: 'Another Team',
  description: 'Another test template',
  members: [
    {
      name: 'QA',
      role: 'qa',
      systemPrompt: 'You are a QA engineer.',
    },
    {
      name: 'PM',
      role: 'product-manager',
      systemPrompt: 'You are a product manager.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('templates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: existsSync returns false so getTemplatesDir falls back to CWD
    mockExistsSync.mockReturnValue(false);
    // Default: statSync returns a file (not directory) so legacy loading works
    mockStatSync.mockReturnValue({ isDirectory: () => false } as any);
  });

  // -----------------------------------------------------------------------
  // getTemplatesDir
  // -----------------------------------------------------------------------

  describe('getTemplatesDir', () => {
    it('returns a path ending in config/templates', () => {
      // When the walk-up finds config/templates, it returns that path.
      // When it does not, it falls back to CWD-based path.
      const dir = getTemplatesDir();
      expect(dir).toContain(path.join('config', 'templates'));
    });
  });

  // -----------------------------------------------------------------------
  // listTemplates
  // -----------------------------------------------------------------------

  describe('listTemplates', () => {
    it('returns templates sorted by name', () => {
      // First call to readdirSync is the walk-up probing; subsequent is the actual listing.
      // We need readdirSync to succeed on some calls for getTemplatesDir, and then for listing.
      mockReaddirSync.mockImplementation(() => {
        return ['b-team.json', 'a-team.json', 'not-json.txt'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.endsWith('a-team.json')) {
          return JSON.stringify(SAMPLE_TEMPLATE);
        }
        if (p.endsWith('b-team.json')) {
          return JSON.stringify(ANOTHER_TEMPLATE);
        }
        throw new Error('unknown file');
      });

      const templates = listTemplates();
      expect(templates).toHaveLength(2);
      // "Another Team" < "Test Team" alphabetically
      expect(templates[0].id).toBe('another-team');
      expect(templates[1].id).toBe('test-team');
    });

    it('returns empty array when templates directory does not exist', () => {
      mockReaddirSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const templates = listTemplates();
      expect(templates).toEqual([]);
    });

    it('skips malformed JSON files', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['good.json', 'bad.json'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.endsWith('good.json')) {
          return JSON.stringify(SAMPLE_TEMPLATE);
        }
        return '{ invalid json';
      });

      const templates = listTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].id).toBe('test-team');
    });

    it('skips files missing required fields', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['incomplete.json'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify({ id: 'no-name', description: 'missing name and members' });
      });

      const templates = listTemplates();
      expect(templates).toEqual([]);
    });

    it('filters to only .json files', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['readme.md', 'template.json', '.gitkeep'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify(SAMPLE_TEMPLATE);
      });

      const templates = listTemplates();
      // Only template.json should be processed
      expect(templates).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // getTemplate
  // -----------------------------------------------------------------------

  describe('getTemplate', () => {
    beforeEach(() => {
      mockReaddirSync.mockImplementation(() => {
        return ['a.json', 'b.json'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.endsWith('a.json')) {
          return JSON.stringify(SAMPLE_TEMPLATE);
        }
        if (p.endsWith('b.json')) {
          return JSON.stringify(ANOTHER_TEMPLATE);
        }
        throw new Error('unknown');
      });
    });

    it('returns the matching template by id', () => {
      const template = getTemplate('test-team');
      expect(template).toBeDefined();
      expect(template!.name).toBe('Test Team');
      expect(template!.members).toHaveLength(1);
    });

    it('returns undefined for unknown id', () => {
      const template = getTemplate('nonexistent');
      expect(template).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // New-format template loading
  // -----------------------------------------------------------------------

  describe('new-format templates (subdirectory with template.json)', () => {
    const NEW_FORMAT_TEMPLATE = {
      id: 'dev-fullstack',
      name: 'Fullstack Dev Team',
      description: 'TL + 2 devs',
      category: 'development',
      version: '1.0.0',
      hierarchical: true,
      roles: [
        {
          role: 'team-leader',
          label: 'Tech Lead',
          defaultName: 'Tech Lead',
          count: 1,
          hierarchyLevel: 1,
          canDelegate: true,
          defaultSkills: ['delegate-task', 'verify-output'],
        },
        {
          role: 'developer',
          label: 'Developer',
          defaultName: 'Dev',
          count: 2,
          hierarchyLevel: 2,
          canDelegate: false,
          reportsTo: 'team-leader',
          defaultSkills: ['complete-task'],
          promptAdditions: 'You are a skilled developer.',
        },
      ],
      defaultRuntime: 'claude-code',
      verificationPipeline: {
        name: 'Dev Pipeline',
        steps: [],
        passPolicy: 'all',
        maxRetries: 2,
      },
    };

    it('loads new-format template from subdirectory', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['dev-fullstack'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockStatSync.mockReturnValue({ isDirectory: () => true } as any);
      mockExistsSync.mockImplementation((p) => {
        return String(p).endsWith('template.json');
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify(NEW_FORMAT_TEMPLATE);
      });

      const templates = listTemplates();
      expect(templates).toHaveLength(1);
      expect(templates[0].id).toBe('dev-fullstack');
      expect(templates[0].name).toBe('Fullstack Dev Team');
    });

    it('converts roles to members correctly', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['dev-fullstack'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockStatSync.mockReturnValue({ isDirectory: () => true } as any);
      mockExistsSync.mockImplementation((p) => {
        return String(p).endsWith('template.json');
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify(NEW_FORMAT_TEMPLATE);
      });

      const templates = listTemplates();
      // 1 TL + 2 devs = 3 members
      expect(templates[0].members).toHaveLength(3);
      expect(templates[0].members[0].name).toBe('Tech Lead');
      expect(templates[0].members[0].role).toBe('team-leader');
      expect(templates[0].members[1].name).toBe('Dev 1');
      expect(templates[0].members[1].role).toBe('developer');
      expect(templates[0].members[2].name).toBe('Dev 2');
    });

    it('uses promptAdditions as systemPrompt when available', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['dev-fullstack'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockStatSync.mockReturnValue({ isDirectory: () => true } as any);
      mockExistsSync.mockImplementation((p) => {
        return String(p).endsWith('template.json');
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify(NEW_FORMAT_TEMPLATE);
      });

      const templates = listTemplates();
      // Dev role has promptAdditions
      expect(templates[0].members[1].systemPrompt).toBe('You are a skilled developer.');
      // TL role has no promptAdditions, falls back to label
      expect(templates[0].members[0].systemPrompt).toBe('You are a Tech Lead.');
    });

    it('carries over skillOverrides from defaultSkills', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['dev-fullstack'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockStatSync.mockReturnValue({ isDirectory: () => true } as any);
      mockExistsSync.mockImplementation((p) => {
        return String(p).endsWith('template.json');
      });
      mockReadFileSync.mockImplementation(() => {
        return JSON.stringify(NEW_FORMAT_TEMPLATE);
      });

      const templates = listTemplates();
      expect(templates[0].members[0].skillOverrides).toEqual(['delegate-task', 'verify-output']);
      expect(templates[0].members[1].skillOverrides).toEqual(['complete-task']);
    });

    it('does not duplicate template when new-format and legacy have same id', () => {
      mockReaddirSync.mockImplementation(() => {
        return ['dev-fullstack', 'dev-fullstack.json'] as unknown as ReturnType<typeof readdirSync>;
      });
      mockStatSync.mockImplementation((p) => {
        return { isDirectory: () => String(p).endsWith('dev-fullstack') && !String(p).endsWith('.json') } as any;
      });
      mockExistsSync.mockImplementation((p) => {
        return String(p).endsWith('template.json');
      });
      mockReadFileSync.mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.endsWith('template.json')) {
          return JSON.stringify(NEW_FORMAT_TEMPLATE);
        }
        return JSON.stringify({ ...SAMPLE_TEMPLATE, id: 'dev-fullstack' });
      });

      const templates = listTemplates();
      // Only one entry for dev-fullstack (new format wins)
      const devTemplates = templates.filter(t => t.id === 'dev-fullstack');
      expect(devTemplates).toHaveLength(1);
    });
  });
});

describe('onboarding starters', () => {
  const onboarding = (order: number, recommended: boolean) => ({
    order,
    recommended,
    label: `s${order}`,
    tagline: 't',
    suggestions: ['a', 'b', 'c'],
  });
  const plain: TeamTemplate = { id: 'a-plain', name: 'A Plain', description: 'd', members: [] };
  const marketing: TeamTemplate = { id: 'growth-marketing-team', name: 'Growth Marketing Team', description: 'd', members: [], onboarding: onboarding(2, false) };
  const assistant: TeamTemplate = { id: 'personal-assistant-team', name: 'Personal Assistant', description: 'd', members: [], onboarding: onboarding(1, true) };

  it('lists only templates with valid onboarding metadata, by order', () => {
    const broken = { ...plain, id: 'broken', onboarding: { order: 'x' } } as unknown as TeamTemplate;
    expect(listOnboardingStarters([plain, marketing, broken, assistant]).map((t) => t.id)).toEqual([
      'personal-assistant-team',
      'growth-marketing-team',
    ]);
  });

  it('defaults to the recommended starter, not the first template alphabetically', () => {
    expect(getDefaultStarterTemplate([plain, marketing, assistant])?.id).toBe('personal-assistant-team');
  });

  it('falls back to the first starter, then the first template, then null', () => {
    expect(getDefaultStarterTemplate([plain, marketing])?.id).toBe('growth-marketing-team');
    expect(getDefaultStarterTemplate([plain])?.id).toBe('a-plain');
    expect(getDefaultStarterTemplate([])).toBeNull();
  });
});
