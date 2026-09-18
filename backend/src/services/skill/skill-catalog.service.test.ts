/**
 * Tests for Skill Catalog Service
 *
 * Verifies catalog generation from orchestrator skill directories,
 * including scanning, grouping by category, rendering Markdown output,
 * and error handling for missing or malformed skill definitions.
 *
 * @module services/skill/skill-catalog.service.test
 */

// Jest globals are available automatically
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock os.homedir() to isolate tests from real marketplace skills.
// We store the fake home dir in a module-level variable that tests update in beforeEach.
let fakeHomeDir = os.tmpdir();
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => fakeHomeDir,
}));

import { SkillCatalogService, CatalogGenerationResult } from './skill-catalog.service.js';

/**
 * Helper type to access private readonly fields on the service for testing.
 * Used to redirect the catalog output directory away from the real home directory.
 */
interface SkillCatalogServiceTestAccess {
  catalogDir: string;
}

describe('SkillCatalogService', () => {
  let service: SkillCatalogService;
  let testDir: string;
  let projectRoot: string;
  let catalogOutputDir: string;

  /**
   * Create a skill directory with skill.json and optionally instructions.md
   *
   * @param skillName - Directory name for the skill
   * @param skillJson - Object to serialize as skill.json
   * @param instructions - Optional instructions.md content
   */
  async function createSkillDir(
    skillName: string,
    skillJson: Record<string, unknown>,
    instructions?: string
  ): Promise<void> {
    const skillDir = path.join(projectRoot, 'config', 'skills', 'orchestrator', skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(skillJson, null, 2));

    if (instructions !== undefined) {
      await fs.writeFile(path.join(skillDir, 'instructions.md'), instructions);
    }
  }

  /**
   * Create a standard skill directory with typical fields
   *
   * @param dirName - Directory name (e.g., "assign-task")
   * @param overrides - Partial overrides for skill.json fields
   * @param instructions - Optional instructions.md content
   */
  async function createStandardSkill(
    dirName: string,
    overrides: Record<string, unknown> = {},
    instructions?: string
  ): Promise<void> {
    const defaults = {
      id: `orc-${dirName}`,
      name: dirName
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
      description: `Description for ${dirName}`,
      category: 'management',
      skillType: 'claude-skill',
      promptFile: 'instructions.md',
      execution: {
        type: 'script',
        script: {
          file: 'execute.sh',
          interpreter: 'bash',
          timeoutMs: 30000,
        },
      },
      assignableRoles: ['orchestrator'],
      tags: ['test'],
      version: '1.0.0',
    };

    const skillJson = { ...defaults, ...overrides };
    const defaultInstructions =
      instructions ??
      `# ${skillJson.name}\n\nSome description.\n\n## Parameters\n\n| Parameter | Required | Description |\n|-----------|----------|-------------|\n| \`param1\` | Yes | A test parameter |\n\n## Output\n\nJSON result.`;

    await createSkillDir(dirName, skillJson, defaultInstructions);
  }

  /**
   * Create an agent skill directory with skill.json and optionally instructions.md
   *
   * @param subPath - Subdirectory path relative to config/skills/agent/ (e.g., "core/accept-task" or "marketplace/code-review")
   * @param skillJson - Object to serialize as skill.json
   * @param instructions - Optional instructions.md content
   */
  async function createAgentSkillDir(
    subPath: string,
    skillJson: Record<string, unknown>,
    instructions?: string
  ): Promise<void> {
    const skillDir = path.join(projectRoot, 'config', 'skills', 'agent', subPath);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(skillJson, null, 2));
    if (instructions !== undefined) {
      await fs.writeFile(path.join(skillDir, 'instructions.md'), instructions);
    }
  }

  /**
   * Create a standard agent skill directory with typical fields
   *
   * @param subPath - Subdirectory path relative to config/skills/agent/ (e.g., "core/accept-task")
   * @param overrides - Partial overrides for skill.json fields
   * @param instructions - Optional instructions.md content
   */
  async function createStandardAgentSkill(
    subPath: string,
    overrides: Record<string, unknown> = {},
    instructions?: string
  ): Promise<void> {
    const dirName = subPath.split('/').pop() || subPath;
    const defaults = {
      id: `agent-${dirName}`,
      name: dirName
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' '),
      description: `Description for ${dirName}`,
      category: 'core',
      skillType: 'claude-skill',
      promptFile: 'instructions.md',
      execution: {
        type: 'script',
        script: {
          file: 'execute.sh',
          interpreter: 'bash',
          timeoutMs: 30000,
        },
      },
      assignableRoles: ['agent'],
      tags: ['test'],
      version: '1.0.0',
    };

    const skillJson = { ...defaults, ...overrides };
    const defaultInstructions =
      instructions ??
      `# ${skillJson.name}\n\nSome description.\n\n## Parameters\n\n| Parameter | Required | Description |\n|-----------|----------|-------------|\n| \`param1\` | Yes | A test parameter |\n\n## Output\n\nJSON result.`;

    await createAgentSkillDir(subPath, skillJson, defaultInstructions);
  }

  beforeEach(async () => {
    // Create unique test directory structure
    testDir = path.join(os.tmpdir(), `skill-catalog-test-${Date.now()}-${Math.random()}`);
    projectRoot = path.join(testDir, 'project');
    catalogOutputDir = path.join(testDir, 'home', '.crewly', 'skills');

    // Point fakeHomeDir to the test's home directory to isolate marketplace scans
    fakeHomeDir = path.join(testDir, 'home');

    // Create the orchestrator skills directory
    await fs.mkdir(path.join(projectRoot, 'config', 'skills', 'orchestrator'), {
      recursive: true,
    });

    // Create the catalog output directory parent
    await fs.mkdir(path.join(testDir, 'home'), { recursive: true });

    // Create service with overridden paths.
    // We construct the service and patch the catalogDir to use our test directory
    // instead of the real home directory.
    service = new SkillCatalogService(projectRoot);

    // Override the private catalogDir to point to our test location
    // This avoids writing to the real ~/.crewly/skills/ during tests
    (service as unknown as SkillCatalogServiceTestAccess).catalogDir = catalogOutputDir;
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    SkillCatalogService.clearInstance();
  });

  // ===========================================================================
  // generateCatalog Tests
  // ===========================================================================

  describe('generateCatalog', () => {
    it('should generate catalog file successfully with skills', async () => {
      await createStandardSkill('assign-task', { category: 'management' });
      await createStandardSkill('get-agent-status', { category: 'monitoring' });

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(2);
      expect(result.categoryCount).toBe(2);
      expect(result.error).toBeUndefined();

      // Verify file was actually written
      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('# Orchestrator Skills Catalog');
    });

    it('should create output directory if it does not exist', async () => {
      await createStandardSkill('test-skill');

      // Remove the catalog output directory to verify it gets created
      await fs.rm(catalogOutputDir, { recursive: true, force: true });

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);

      // Verify directory was created and file written
      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should handle empty skills directory gracefully', async () => {
      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(0);
      expect(result.categoryCount).toBe(0);

      // Should still write a file with the header
      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('# Orchestrator Skills Catalog');
    });

    it('should handle missing skills directory gracefully', async () => {
      // Remove the orchestrator skills directory
      await fs.rm(path.join(projectRoot, 'config', 'skills', 'orchestrator'), {
        recursive: true,
        force: true,
      });

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(0);
    });

    it('should skip _common directory', async () => {
      // Create _common directory with a skill.json (should be skipped)
      await createSkillDir('_common', {
        id: 'common-lib',
        name: 'Common Library',
        description: 'Shared utilities',
        category: 'system',
      });

      await createStandardSkill('assign-task');

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).not.toContain('Common Library');
    });

    it('should skip directories without skill.json', async () => {
      // Create a directory with no skill.json
      const emptyDir = path.join(
        projectRoot,
        'config',
        'skills',
        'orchestrator',
        'no-skill-json'
      );
      await fs.mkdir(emptyDir, { recursive: true });
      await fs.writeFile(path.join(emptyDir, 'readme.md'), 'Not a skill');

      await createStandardSkill('valid-skill');

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);
    });

    it('should skip skills with missing required fields', async () => {
      // Create a skill.json missing the required "name" field
      await createSkillDir('incomplete-skill', {
        id: 'orc-incomplete',
        // name is missing
        description: 'Incomplete',
        category: 'management',
      });

      await createStandardSkill('valid-skill');

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).not.toContain('Incomplete');
    });

    it('should skip files with invalid JSON in skill.json', async () => {
      const invalidDir = path.join(
        projectRoot,
        'config',
        'skills',
        'orchestrator',
        'invalid-json'
      );
      await fs.mkdir(invalidDir, { recursive: true });
      await fs.writeFile(path.join(invalidDir, 'skill.json'), '{ broken json!!!');

      await createStandardSkill('valid-skill');

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);
    });

    it('should handle skills without instructions.md', async () => {
      // Create skill without instructions.md
      await createSkillDir(
        'no-instructions',
        {
          id: 'orc-no-instructions',
          name: 'No Instructions',
          description: 'A skill without instructions.md',
          category: 'management',
        }
        // No instructions parameter - file will not be created
      );

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('No Instructions');
    });

    it('should skip non-directory entries in the skills folder', async () => {
      // Create a file (not a directory) in the orchestrator skills directory
      await fs.writeFile(
        path.join(projectRoot, 'config', 'skills', 'orchestrator', 'stray-file.txt'),
        'not a skill directory'
      );

      await createStandardSkill('valid-skill');

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);
    });
  });

  // ===========================================================================
  // Catalog Content Tests
  // ===========================================================================

  describe('catalog content', () => {
    it('should include header with timestamp', async () => {
      await createStandardSkill('test-skill');

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('# Orchestrator Skills Catalog');
      expect(content).toContain('Auto-generated on');
      expect(content).toContain('Execute skills via bash scripts');
    });

    it('should include How to Use section', async () => {
      await createStandardSkill('test-skill');

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('## How to Use');
      const orcPath = path.join(projectRoot, 'config', 'skills', 'orchestrator');
      expect(content).toContain(
        `bash ${orcPath}/{skill-name}/execute.sh '{"param":"value"}'`
      );
      expect(content).toContain('All scripts output JSON to stdout. Errors go to stderr.');
    });

    it('should group skills by category with proper headings', async () => {
      await createStandardSkill('assign-task', { category: 'management' });
      await createStandardSkill('get-agent-status', { category: 'monitoring' });
      await createStandardSkill('send-message', { category: 'communication' });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('## Management');
      expect(content).toContain('## Monitoring');
      expect(content).toContain('## Communication');
    });

    it('should format category names with title case', async () => {
      await createStandardSkill('test-skill', { category: 'task-management' });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('## Task Management');
    });

    it('should include skill name as h3 heading', async () => {
      await createStandardSkill('assign-task', {
        name: 'Assign Task',
      });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('### Assign Task');
    });

    it('should include skill description', async () => {
      await createStandardSkill('test-skill', {
        description: 'This is a very specific test description',
      });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('This is a very specific test description');
    });

    it('should include usage command with correct directory name', async () => {
      await createStandardSkill('assign-task');

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      // Absolute path: the orc's cwd is not the Crewly root on a global install.
      const orcPath = path.join(projectRoot, 'config', 'skills', 'orchestrator');
      expect(content).toContain(`**Usage:** \`bash ${orcPath}/assign-task/execute.sh '{}'\``);
    });

    it('renders cross-scanned agent/core skills with their real agent/core path (finding 12)', async () => {
      await createStandardSkill('assign-task');
      await createStandardAgentSkill('core/recall', { assignableRoles: ['developer', 'orchestrator'] });
      await createStandardAgentSkill('core/worker-only', { assignableRoles: ['developer'] });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      const agentCorePath = path.join(projectRoot, 'config', 'skills', 'agent', 'core');
      expect(content).toContain(`**Usage:** \`bash ${agentCorePath}/recall/execute.sh '{}'\``);
      expect(content).not.toContain('config/skills/orchestrator/recall/');
      // Not tagged for the orchestrator → not in the orc catalog at all.
      expect(content).not.toContain('worker-only');
    });

    it('should extract and include Parameters section from instructions.md', async () => {
      const instructions = [
        '# Send Message',
        '',
        'Sends a message to an agent.',
        '',
        '## Parameters',
        '',
        '| Parameter | Required | Description |',
        '|-----------|----------|-------------|',
        '| `sessionName` | Yes | The target session |',
        '| `message` | Yes | The message text |',
        '',
        '## Output',
        '',
        'JSON confirmation.',
      ].join('\n');

      await createStandardSkill('send-message', {}, instructions);

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('| `sessionName` | Yes | The target session |');
      expect(content).toContain('| `message` | Yes | The message text |');
    });

    it('should not include Output section from instructions.md', async () => {
      const instructions = [
        '# Test',
        '',
        '## Parameters',
        '',
        '| Parameter | Required | Description |',
        '|-----------|----------|-------------|',
        '| `param1` | Yes | A parameter |',
        '',
        '## Output',
        '',
        'This output section should NOT appear in the catalog.',
      ].join('\n');

      await createStandardSkill('test-skill', {}, instructions);

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).not.toContain('This output section should NOT appear in the catalog.');
    });

    it('should handle instructions.md without Parameters section', async () => {
      const instructions = [
        '# Simple Skill',
        '',
        'No parameters needed.',
        '',
        '## Output',
        '',
        'JSON result.',
      ].join('\n');

      await createStandardSkill('simple-skill', {}, instructions);

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      // Should still have the skill entry but no parameters table
      expect(content).toContain('### Simple Skill');
      expect(content).not.toContain('| Parameter |');
    });

    it('should include separators between skills', async () => {
      await createStandardSkill('skill-one', { category: 'management' });
      await createStandardSkill('skill-two', { category: 'management' });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      // Each skill entry should end with a horizontal rule
      const separators = content.match(/^---$/gm);
      expect(separators).not.toBeNull();
      expect(separators!.length).toBeGreaterThanOrEqual(2);
    });

    it('should sort categories alphabetically', async () => {
      await createStandardSkill('skill-z', { category: 'zzz-category' });
      await createStandardSkill('skill-a', { category: 'aaa-category' });
      await createStandardSkill('skill-m', { category: 'mmm-category' });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      const aaaIndex = content.indexOf('## Aaa Category');
      const mmmIndex = content.indexOf('## Mmm Category');
      const zzzIndex = content.indexOf('## Zzz Category');

      expect(aaaIndex).toBeLessThan(mmmIndex);
      expect(mmmIndex).toBeLessThan(zzzIndex);
    });

    it('should sort skills alphabetically within categories', async () => {
      await createStandardSkill('zebra-skill', {
        name: 'Zebra Skill',
        category: 'management',
      });
      await createStandardSkill('alpha-skill', {
        name: 'Alpha Skill',
        category: 'management',
      });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      const alphaIndex = content.indexOf('### Alpha Skill');
      const zebraIndex = content.indexOf('### Zebra Skill');

      expect(alphaIndex).toBeLessThan(zebraIndex);
    });

    it('should handle multiple skills in the same category', async () => {
      await createStandardSkill('assign-task', {
        name: 'Assign Task',
        category: 'management',
      });
      await createStandardSkill('complete-task', {
        name: 'Complete Task',
        category: 'management',
      });
      await createStandardSkill('delegate-task', {
        name: 'Delegate Task',
        category: 'management',
      });

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      // Only one Management heading
      const managementHeadings = content.match(/^## Management$/gm);
      expect(managementHeadings).toHaveLength(1);

      // All three skills present
      expect(content).toContain('### Assign Task');
      expect(content).toContain('### Complete Task');
      expect(content).toContain('### Delegate Task');
    });
  });

  // ===========================================================================
  // getCatalogPath Tests
  // ===========================================================================

  describe('getCatalogPath', () => {
    it('should return path ending with SKILLS_CATALOG.md', () => {
      const catalogPath = service.getCatalogPath();

      expect(catalogPath).toMatch(/SKILLS_CATALOG\.md$/);
    });

    it('should return path under the catalog directory', () => {
      const catalogPath = service.getCatalogPath();

      expect(catalogPath).toContain('skills');
      expect(catalogPath).toContain('SKILLS_CATALOG.md');
    });

    it('should return an absolute path', () => {
      const catalogPath = service.getCatalogPath();

      expect(path.isAbsolute(catalogPath)).toBe(true);
    });
  });

  // ===========================================================================
  // Singleton Tests
  // ===========================================================================

  describe('singleton pattern', () => {
    afterEach(() => {
      SkillCatalogService.clearInstance();
    });

    it('should return the same instance on subsequent calls', () => {
      const instance1 = SkillCatalogService.getInstance('/some/path');
      const instance2 = SkillCatalogService.getInstance('/other/path');

      expect(instance1).toBe(instance2);
    });

    it('should return a new instance after clearInstance', () => {
      const instance1 = SkillCatalogService.getInstance('/some/path');
      SkillCatalogService.clearInstance();
      const instance2 = SkillCatalogService.getInstance('/some/path');

      expect(instance1).not.toBe(instance2);
    });

    it('should return a SkillCatalogService instance', () => {
      const instance = SkillCatalogService.getInstance();
      expect(instance).toBeInstanceOf(SkillCatalogService);
    });
  });

  // ===========================================================================
  // Edge Case Tests
  // ===========================================================================

  describe('edge cases', () => {
    it('should handle skill.json with only required fields', async () => {
      await createSkillDir(
        'minimal-skill',
        {
          id: 'orc-minimal',
          name: 'Minimal Skill',
          description: 'Has only required fields',
          category: 'system',
        },
        '# Minimal\n\nNo parameters.'
      );

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('### Minimal Skill');
    });

    it('should handle empty instructions.md', async () => {
      await createSkillDir(
        'empty-instructions',
        {
          id: 'orc-empty-inst',
          name: 'Empty Instructions',
          description: 'Has empty instructions.md',
          category: 'management',
        },
        ''
      );

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);
    });

    it('should handle special characters in skill names and descriptions', async () => {
      await createStandardSkill('special-chars', {
        name: 'Skill with "Quotes" & <Angles>',
        description: 'Description with `backticks` and *asterisks*',
      });

      const result = await service.generateCatalog();

      expect(result.success).toBe(true);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('Skill with "Quotes" & <Angles>');
      expect(content).toContain('Description with `backticks` and *asterisks*');
    });

    it('should handle Parameters section at end of instructions without trailing newline', async () => {
      const instructions =
        '# Test\n\n## Parameters\n\n| Param | Req | Desc |\n|-------|-----|------|\n| `x` | Yes | Value |';

      await createStandardSkill('trailing-skill', {}, instructions);

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('| `x` | Yes | Value |');
    });

    it('should handle Parameters section as plain text (not table)', async () => {
      const instructions = [
        '# Test',
        '',
        '## Parameters',
        '',
        'Pass the full JSON body as expected by `POST /api/task-management/assign`.',
        '',
        '## Output',
        '',
        'JSON confirmation.',
      ].join('\n');

      await createStandardSkill('plain-params', {}, instructions);

      const result = await service.generateCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain(
        'Pass the full JSON body as expected by `POST /api/task-management/assign`.'
      );
    });

    it('should return error result when write fails', async () => {
      // Point catalog directory to an invalid path that cannot be created
      (service as unknown as SkillCatalogServiceTestAccess).catalogDir =
        '/dev/null/impossible/path';

      const result = await service.generateCatalog();

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.skillCount).toBe(0);
    });
  });

  // ===========================================================================
  // CatalogGenerationResult Tests
  // ===========================================================================

  describe('CatalogGenerationResult', () => {
    it('should report correct skill count', async () => {
      await createStandardSkill('skill-1', { category: 'a' });
      await createStandardSkill('skill-2', { category: 'b' });
      await createStandardSkill('skill-3', { category: 'c' });

      const result = await service.generateCatalog();

      expect(result.skillCount).toBe(3);
    });

    it('should report correct category count', async () => {
      await createStandardSkill('skill-1', { category: 'management' });
      await createStandardSkill('skill-2', { category: 'management' });
      await createStandardSkill('skill-3', { category: 'monitoring' });
      await createStandardSkill('skill-4', { category: 'communication' });

      const result = await service.generateCatalog();

      expect(result.categoryCount).toBe(3);
    });

    it('should return the correct catalog path', async () => {
      await createStandardSkill('test-skill');

      const result = await service.generateCatalog();

      expect(result.catalogPath).toBe(service.getCatalogPath());
    });
  });

  // ===========================================================================
  // generateAgentCatalog Tests
  // ===========================================================================

  describe('generateAgentCatalog', () => {
    it('should generate agent catalog with skills in nested directories', async () => {
      await createStandardAgentSkill('core/accept-task', {
        category: 'core',
        description: 'Accepts a task from the orchestrator',
      });
      await createStandardAgentSkill('core/heartbeat', {
        category: 'core',
        description: 'Sends heartbeat to orchestrator',
      });
      await createStandardAgentSkill('marketplace/code-review', {
        category: 'marketplace',
        description: 'Reviews code changes',
      });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(3);
      expect(result.categoryCount).toBe(2);
      expect(result.error).toBeUndefined();

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('# Agent Skills Catalog');
      expect(content).toContain('### Accept Task');
      expect(content).toContain('### Heartbeat');
      expect(content).toContain('### Code Review');
    });

    it('should write to AGENT_SKILLS_CATALOG.md, not SKILLS_CATALOG.md', async () => {
      await createStandardAgentSkill('core/accept-task', { category: 'core' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.catalogPath).toMatch(/AGENT_SKILLS_CATALOG\.md$/);
      expect(result.catalogPath).not.toMatch(/\/SKILLS_CATALOG\.md$/);

      // Verify the file actually exists
      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should handle empty agent directory', async () => {
      // Create agent directory but with no skills
      await fs.mkdir(path.join(projectRoot, 'config', 'skills', 'agent'), {
        recursive: true,
      });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(0);
      expect(result.categoryCount).toBe(0);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('# Agent Skills Catalog');
    });

    it('should handle missing agent directory', async () => {
      // Don't create the agent directory at all
      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(0);
      expect(result.categoryCount).toBe(0);
    });

    it('should use absolute paths in usage commands', async () => {
      await createStandardAgentSkill('core/accept-task', {
        category: 'core',
      });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);

      const content = await fs.readFile(result.catalogPath, 'utf-8');

      // The usage command should contain the absolute path to the skill
      const absoluteSkillsPath = path.join(projectRoot, 'config', 'skills', 'agent');
      expect(content).toContain(`bash ${absoluteSkillsPath}`);
      expect(content).toContain('/accept-task/execute.sh');
    });

    it('should skip _common directory in agent skills', async () => {
      // Create _common directory with a skill.json (should be skipped)
      await createAgentSkillDir('_common', {
        id: 'common-lib',
        name: 'Common Library',
        description: 'Shared utilities',
        category: 'system',
      });

      await createStandardAgentSkill('core/accept-task', { category: 'core' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).not.toContain('Common Library');
    });

    it('should handle nested category directories without skill.json', async () => {
      // Create category directory without skill.json
      await fs.mkdir(path.join(projectRoot, 'config', 'skills', 'agent', 'core'), {
        recursive: true,
      });

      // Create a skill inside the category directory
      await createStandardAgentSkill('core/accept-task', { category: 'core' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('### Accept Task');
    });

    it('should group skills by category', async () => {
      await createStandardAgentSkill('core/accept-task', { category: 'task-management' });
      await createStandardAgentSkill('core/heartbeat', { category: 'monitoring' });
      await createStandardAgentSkill('marketplace/code-review', { category: 'code-quality' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.categoryCount).toBe(3);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).toContain('## Task Management');
      expect(content).toContain('## Monitoring');
      expect(content).toContain('## Code Quality');
    });

    it('should skip directories without skill.json at nested level', async () => {
      // Create nested directory without skill.json
      await fs.mkdir(
        path.join(projectRoot, 'config', 'skills', 'agent', 'core', 'not-a-skill'),
        { recursive: true }
      );
      await fs.writeFile(
        path.join(projectRoot, 'config', 'skills', 'agent', 'core', 'not-a-skill', 'readme.md'),
        'Not a skill'
      );

      await createStandardAgentSkill('core/accept-task', { category: 'core' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);
    });

    it('should handle skills with missing required fields', async () => {
      // Create a skill.json missing the required "name" field
      await createAgentSkillDir('core/incomplete-skill', {
        id: 'agent-incomplete',
        // name is missing
        description: 'Incomplete',
        category: 'core',
      });

      await createStandardAgentSkill('core/valid-skill', { category: 'core' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);

      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content).not.toContain('Incomplete');
    });

    it('should handle invalid JSON in skill.json', async () => {
      const invalidDir = path.join(projectRoot, 'config', 'skills', 'agent', 'core', 'invalid');
      await fs.mkdir(invalidDir, { recursive: true });
      await fs.writeFile(path.join(invalidDir, 'skill.json'), '{ broken json!!!');

      await createStandardAgentSkill('core/valid-skill', { category: 'core' });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);
      expect(result.skillCount).toBe(1);
    });

    it('should include Parameters section from instructions.md', async () => {
      const instructions = [
        '# Accept Task',
        '',
        'Accepts a task from the orchestrator.',
        '',
        '## Parameters',
        '',
        '| Parameter | Required | Description |',
        '|-----------|----------|-------------|',
        '| `taskId` | Yes | The task identifier |',
        '| `priority` | No | Task priority level |',
        '',
        '## Output',
        '',
        'JSON confirmation.',
      ].join('\n');

      await createStandardAgentSkill('core/accept-task', { category: 'core' }, instructions);

      const result = await service.generateAgentCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      expect(content).toContain('| `taskId` | Yes | The task identifier |');
      expect(content).toContain('| `priority` | No | Task priority level |');
    });

    it('should sort skills alphabetically within categories', async () => {
      await createStandardAgentSkill('core/zebra-skill', {
        name: 'Zebra Skill',
        category: 'core',
      });
      await createStandardAgentSkill('core/alpha-skill', {
        name: 'Alpha Skill',
        category: 'core',
      });

      const result = await service.generateAgentCatalog();
      const content = await fs.readFile(result.catalogPath, 'utf-8');

      const alphaIndex = content.indexOf('### Alpha Skill');
      const zebraIndex = content.indexOf('### Zebra Skill');

      expect(alphaIndex).toBeLessThan(zebraIndex);
    });

    it('should create output directory if it does not exist', async () => {
      await createStandardAgentSkill('core/test-skill', { category: 'core' });

      // Remove the catalog output directory to verify it gets created
      await fs.rm(catalogOutputDir, { recursive: true, force: true });

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(true);

      // Verify directory was created and file written
      const content = await fs.readFile(result.catalogPath, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    });

    it('should return error result when write fails', async () => {
      await createStandardAgentSkill('core/test-skill', { category: 'core' });

      // Point catalog directory to an invalid path that cannot be created
      (service as unknown as SkillCatalogServiceTestAccess).catalogDir =
        '/dev/null/impossible/path';

      const result = await service.generateAgentCatalog();

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.skillCount).toBe(0);
    });
  });

  // ===========================================================================
  // getAgentCatalogPath Tests
  // ===========================================================================

  describe('getAgentCatalogPath', () => {
    it('should return path ending with AGENT_SKILLS_CATALOG.md', () => {
      const catalogPath = service.getAgentCatalogPath();

      expect(catalogPath).toMatch(/AGENT_SKILLS_CATALOG\.md$/);
    });

    it('should return path under the catalog directory', () => {
      const catalogPath = service.getAgentCatalogPath();

      expect(catalogPath).toContain('skills');
      expect(catalogPath).toContain('AGENT_SKILLS_CATALOG.md');
    });

    it('should return an absolute path', () => {
      const catalogPath = service.getAgentCatalogPath();

      expect(path.isAbsolute(catalogPath)).toBe(true);
    });

    it('should return different path than getCatalogPath', () => {
      const orchestratorPath = service.getCatalogPath();
      const agentPath = service.getAgentCatalogPath();

      expect(orchestratorPath).not.toBe(agentPath);
      expect(orchestratorPath).toContain('SKILLS_CATALOG.md');
      expect(agentPath).toContain('AGENT_SKILLS_CATALOG.md');
    });
  });
});
