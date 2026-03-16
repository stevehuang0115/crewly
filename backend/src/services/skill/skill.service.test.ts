/**
 * Tests for Skill Service
 *
 * @module services/skill/skill.service.test
 */

// Jest globals are available automatically
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SkillService,
  getSkillService,
  resetSkillService,
  SkillNotFoundError,
  SkillValidationError,
  BuiltinSkillModificationError,
} from './skill.service.js';
import { CreateSkillInput, SkillStorageFormat } from '../../types/skill.types.js';

describe('SkillService', () => {
  let service: SkillService;
  let testDir: string;
  let builtinSkillsDir: string;
  let userSkillsDir: string;

  /**
   * Create a sample skill in a directory
   */
  async function createSampleSkill(
    dir: string,
    id: string,
    overrides: Partial<SkillStorageFormat> = {}
  ): Promise<void> {
    const skillDir = path.join(dir, id);
    await fs.mkdir(skillDir, { recursive: true });

    const skillData: SkillStorageFormat = {
      id,
      name: overrides.name || `${id} Skill`,
      description: overrides.description || `Description for ${id}`,
      category: overrides.category || 'development',
      skillType: overrides.skillType || 'claude-skill',
      promptFile: 'instructions.md',
      triggers: overrides.triggers || ['trigger1', 'trigger2'],
      tags: overrides.tags || ['tag1', 'tag2'],
      assignableRoles: overrides.assignableRoles || ['developer'],
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };

    await fs.writeFile(path.join(skillDir, 'skill.json'), JSON.stringify(skillData, null, 2));

    await fs.writeFile(
      path.join(skillDir, 'instructions.md'),
      `# ${skillData.name}\n\nInstructions for ${skillData.name}`
    );
  }

  beforeEach(async () => {
    // Create unique test directory
    testDir = path.join(os.tmpdir(), `skill-service-test-${Date.now()}-${Math.random()}`);
    builtinSkillsDir = path.join(testDir, 'builtin');
    userSkillsDir = path.join(testDir, 'user');

    await fs.mkdir(builtinSkillsDir, { recursive: true });
    await fs.mkdir(userSkillsDir, { recursive: true });

    // Create a sample builtin skill
    await createSampleSkill(builtinSkillsDir, 'code-review', {
      name: 'Code Review',
      description: 'Review code for quality and security',
      category: 'development',
      triggers: ['review', 'code review', 'check code'],
      tags: ['code', 'quality'],
      assignableRoles: ['developer', 'qa'],
    });

    // Create another builtin skill
    await createSampleSkill(builtinSkillsDir, 'documentation', {
      name: 'Documentation',
      description: 'Write and update documentation',
      category: 'development',
      triggers: ['document', 'docs', 'write docs'],
      tags: ['docs', 'writing'],
      assignableRoles: ['developer'],
    });

    service = new SkillService({
      builtinSkillsDir,
      userSkillsDir,
      marketplaceSkillsDir: path.join(testDir, 'marketplace'),
    });

    await service.initialize();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    resetSkillService();
  });

  // ===========================================================================
  // Initialization Tests
  // ===========================================================================

  describe('initialize', () => {
    it('should load builtin skills from directory', async () => {
      const skills = await service.listSkills();
      expect(skills.length).toBeGreaterThan(0);
      expect(skills.find((s) => s.id === 'code-review')).toBeDefined();
    });

    it('should mark builtin skills as isBuiltin: true', async () => {
      const skill = await service.getSkill('code-review');
      expect(skill?.isBuiltin).toBe(true);
    });

    it('should only initialize once', async () => {
      const initialCount = await service.getSkillCount();
      await service.initialize();
      await service.initialize();
      const afterCount = await service.getSkillCount();
      expect(afterCount).toBe(initialCount);
    });

    it('should create user skills directory if it does not exist', async () => {
      const newUserDir = path.join(testDir, 'new-user-skills');
      const newService = new SkillService({
        builtinSkillsDir,
        userSkillsDir: newUserDir,
        marketplaceSkillsDir: path.join(testDir, 'marketplace'),
      });

      await newService.initialize();

      const exists = await fs
        .access(newUserDir)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it('should handle missing builtin skills directory gracefully', async () => {
      const newService = new SkillService({
        builtinSkillsDir: '/nonexistent/path',
        userSkillsDir,
        marketplaceSkillsDir: path.join(testDir, 'marketplace'),
      });

      // Should not throw
      await expect(newService.initialize()).resolves.not.toThrow();
    });
  });

  // ===========================================================================
  // listSkills Tests
  // ===========================================================================

  describe('listSkills', () => {
    it('should return all skills without filter', async () => {
      const skills = await service.listSkills();
      expect(Array.isArray(skills)).toBe(true);
      expect(skills.length).toBe(2);
    });

    it('should filter by category', async () => {
      const skills = await service.listSkills({ category: 'development' });
      expect(skills.every((s) => s.category === 'development')).toBe(true);
    });

    it('should filter by roleId', async () => {
      const skills = await service.listSkills({ roleId: 'developer' });
      expect(skills.length).toBeGreaterThan(0);
    });

    it('should filter by search term in name', async () => {
      const skills = await service.listSkills({ search: 'code' });
      expect(skills.length).toBeGreaterThan(0);
      expect(skills.some((s) => s.name.toLowerCase().includes('code'))).toBe(true);
    });

    it('should filter by search term in description', async () => {
      const skills = await service.listSkills({ search: 'quality' });
      expect(skills.length).toBeGreaterThan(0);
    });

    it('should filter by tags', async () => {
      const skills = await service.listSkills({ tags: ['code'] });
      expect(skills.length).toBeGreaterThan(0);
    });

    it('should filter by isBuiltin', async () => {
      const skills = await service.listSkills({ isBuiltin: true });
      expect(skills.every((s) => s.isBuiltin === true)).toBe(true);
    });

    it('should filter by isEnabled', async () => {
      const skills = await service.listSkills({ isEnabled: true });
      expect(skills.every((s) => s.isEnabled === true)).toBe(true);
    });

    it('should return empty array for no matches', async () => {
      const skills = await service.listSkills({ category: 'analysis' });
      expect(skills).toHaveLength(0);
    });

    it('should combine multiple filters', async () => {
      const skills = await service.listSkills({
        category: 'development',
        isBuiltin: true,
        roleId: 'developer',
      });
      expect(skills.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // getSkill Tests
  // ===========================================================================

  describe('getSkill', () => {
    it('should return skill with prompt content', async () => {
      const skill = await service.getSkill('code-review');
      expect(skill).not.toBeNull();
      expect(skill?.promptContent).toContain('Code Review');
    });

    it('should return null for non-existent skill', async () => {
      const skill = await service.getSkill('non-existent');
      expect(skill).toBeNull();
    });

    it('should return all skill properties', async () => {
      const skill = await service.getSkill('code-review');
      expect(skill).toMatchObject({
        id: 'code-review',
        name: 'Code Review',
        category: 'development',
        isBuiltin: true,
        isEnabled: true,
      });
    });
  });

  // ===========================================================================
  // matchSkills Tests
  // ===========================================================================

  describe('matchSkills', () => {
    it('should match skills by trigger keywords', async () => {
      const matches = await service.matchSkills('I need to review this code');
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].id).toBe('code-review');
    });

    it('should match skills by name', async () => {
      const matches = await service.matchSkills('code review');
      expect(matches.length).toBeGreaterThan(0);
    });

    it('should match skills by tags', async () => {
      const matches = await service.matchSkills('quality check');
      expect(matches.length).toBeGreaterThan(0);
    });

    it('should filter by roleId', async () => {
      const matches = await service.matchSkills('review code', 'developer');
      expect(matches.length).toBeGreaterThan(0);
    });

    it('should return empty for unassigned role', async () => {
      // Create a skill only for a specific role
      await service.createSkill({
        name: 'Designer Only',
        description: 'Only for designers',
        category: 'design',
        promptContent: 'Design instructions',
        assignableRoles: ['designer'],
        triggers: ['design something'],
      });

      const matches = await service.matchSkills('design something', 'developer');
      expect(matches.find((m) => m.name === 'Designer Only')).toBeUndefined();
    });

    it('should return empty for no matches', async () => {
      const matches = await service.matchSkills('xyz completely unrelated 12345');
      expect(matches).toHaveLength(0);
    });

    it('should limit results', async () => {
      const matches = await service.matchSkills('code', undefined, 1);
      expect(matches.length).toBeLessThanOrEqual(1);
    });

    it('should sort by relevance score', async () => {
      // code-review has "code" in name and triggers, should rank higher
      const matches = await service.matchSkills('code review');
      expect(matches[0].id).toBe('code-review');
    });

    it('should skip disabled skills', async () => {
      // Create and disable a skill
      const skill = await service.createSkill({
        name: 'Disabled Skill',
        description: 'This is disabled',
        category: 'development',
        promptContent: 'Content',
        triggers: ['unique-disabled-trigger'],
      });

      await service.updateSkill(skill.id, { isEnabled: false });

      const matches = await service.matchSkills('unique-disabled-trigger');
      expect(matches.find((m) => m.name === 'Disabled Skill')).toBeUndefined();
    });
  });

  // ===========================================================================
  // createSkill Tests
  // ===========================================================================

  describe('createSkill', () => {
    it('should create a new skill', async () => {
      const input: CreateSkillInput = {
        name: 'Test Skill',
        description: 'A test skill',
        category: 'development',
        promptContent: '# Test\n\nInstructions here',
        triggers: ['test'],
      };

      const skill = await service.createSkill(input);

      expect(skill.id).toBeDefined();
      expect(skill.name).toBe('Test Skill');
      expect(skill.isBuiltin).toBe(false);
      expect(skill.isEnabled).toBe(true);
    });

    it('should save skill to disk as SKILL.md', async () => {
      const input: CreateSkillInput = {
        name: 'Saved Skill',
        description: 'Will be saved',
        category: 'automation',
        promptContent: 'Content here',
      };

      const skill = await service.createSkill(input);

      const files = await fs.readdir(userSkillsDir);
      expect(files.some((f) => f.includes(skill.id))).toBe(true);

      // Verify SKILL.md exists with frontmatter
      const skillMd = await fs.readFile(path.join(userSkillsDir, skill.id, 'SKILL.md'), 'utf-8');
      expect(skillMd).toContain('---');
      expect(skillMd).toContain('name: Saved Skill');
    });

    it('should save prompt content in SKILL.md body', async () => {
      const input: CreateSkillInput = {
        name: 'Prompt Test',
        description: 'Test prompt saving',
        category: 'development',
        promptContent: '# Instructions\n\nDo this thing',
      };

      const skill = await service.createSkill(input);

      const skillMd = await fs.readFile(
        path.join(userSkillsDir, skill.id, 'SKILL.md'),
        'utf-8'
      );
      expect(skillMd).toContain('# Instructions\n\nDo this thing');
    });

    it('should throw for invalid input - missing name', async () => {
      const input = {
        name: '',
        description: 'Description',
        category: 'development' as const,
        promptContent: 'Content',
      };

      await expect(service.createSkill(input)).rejects.toThrow(SkillValidationError);
    });

    it('should throw for invalid input - invalid category', async () => {
      const input = {
        name: 'Test',
        description: 'Description',
        category: 'invalid-category' as any,
        promptContent: 'Content',
      };

      await expect(service.createSkill(input)).rejects.toThrow(SkillValidationError);
    });

    it('should create skill with optional fields', async () => {
      const input: CreateSkillInput = {
        name: 'Full Skill',
        description: 'With all options',
        category: 'automation',
        promptContent: 'Content',
        triggers: ['trigger1', 'trigger2'],
        tags: ['tag1', 'tag2'],
        assignableRoles: ['developer', 'qa'],
        execution: {
          type: 'script',
          script: {
            file: 'run.sh',
            interpreter: 'bash',
          },
        },
        environment: {
          variables: { API_KEY: 'secret' },
        },
      };

      const skill = await service.createSkill(input);

      expect(skill.triggers).toEqual(['trigger1', 'trigger2']);
      expect(skill.tags).toEqual(['tag1', 'tag2']);
      expect(skill.assignableRoles).toEqual(['developer', 'qa']);
      expect(skill.execution?.type).toBe('script');
    });

    it('should add created skill to cache', async () => {
      const input: CreateSkillInput = {
        name: 'Cached Skill',
        description: 'Test caching',
        category: 'development',
        promptContent: 'Content',
      };

      const skill = await service.createSkill(input);

      // Should be retrievable immediately
      const retrieved = await service.getSkill(skill.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe('Cached Skill');
    });
  });

  // ===========================================================================
  // updateSkill Tests
  // ===========================================================================

  describe('updateSkill', () => {
    let createdSkillId: string;

    beforeEach(async () => {
      const skill = await service.createSkill({
        name: 'Update Test',
        description: 'Will be updated',
        category: 'development',
        promptContent: 'Original content',
      });
      createdSkillId = skill.id;
    });

    it('should update skill properties', async () => {
      const updated = await service.updateSkill(createdSkillId, {
        description: 'Updated description',
      });

      expect(updated.description).toBe('Updated description');
    });

    it('should update multiple properties', async () => {
      const updated = await service.updateSkill(createdSkillId, {
        name: 'New Name',
        description: 'New description',
        category: 'automation',
        tags: ['new-tag'],
      });

      expect(updated.name).toBe('New Name');
      expect(updated.description).toBe('New description');
      expect(updated.category).toBe('automation');
      expect(updated.tags).toEqual(['new-tag']);
    });

    it('should update prompt content', async () => {
      await service.updateSkill(createdSkillId, {
        promptContent: 'Updated prompt content',
      });

      const skill = await service.getSkill(createdSkillId);
      expect(skill?.promptContent).toBe('Updated prompt content');
    });

    it('should update updatedAt timestamp', async () => {
      const before = await service.getSkill(createdSkillId);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await service.updateSkill(createdSkillId, {
        description: 'Changed',
      });

      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
        new Date(before!.updatedAt).getTime()
      );
    });

    it('should throw for builtin skill', async () => {
      await expect(
        service.updateSkill('code-review', { description: 'Modified' })
      ).rejects.toThrow(BuiltinSkillModificationError);
    });

    it('should throw for non-existent skill', async () => {
      await expect(service.updateSkill('non-existent', { description: 'Test' })).rejects.toThrow(
        SkillNotFoundError
      );
    });

    it('should validate update input', async () => {
      await expect(
        service.updateSkill(createdSkillId, { category: 'invalid' as any })
      ).rejects.toThrow(SkillValidationError);
    });

    it('should preserve unchanged properties', async () => {
      const updated = await service.updateSkill(createdSkillId, {
        description: 'Only this changed',
      });

      expect(updated.name).toBe('Update Test');
      expect(updated.category).toBe('development');
    });
  });

  // ===========================================================================
  // deleteSkill Tests
  // ===========================================================================

  describe('deleteSkill', () => {
    let createdSkillId: string;

    beforeEach(async () => {
      const skill = await service.createSkill({
        name: 'Delete Test',
        description: 'Will be deleted',
        category: 'development',
        promptContent: 'Content',
      });
      createdSkillId = skill.id;
    });

    it('should delete user-created skill', async () => {
      await service.deleteSkill(createdSkillId);
      const skill = await service.getSkill(createdSkillId);
      expect(skill).toBeNull();
    });

    it('should remove skill directory from disk', async () => {
      const skillDir = path.join(userSkillsDir, createdSkillId);

      // Verify directory exists before delete
      const existsBefore = await fs
        .access(skillDir)
        .then(() => true)
        .catch(() => false);
      expect(existsBefore).toBe(true);

      await service.deleteSkill(createdSkillId);

      // Verify directory is removed
      const existsAfter = await fs
        .access(skillDir)
        .then(() => true)
        .catch(() => false);
      expect(existsAfter).toBe(false);
    });

    it('should throw for builtin skill', async () => {
      await expect(service.deleteSkill('code-review')).rejects.toThrow(
        BuiltinSkillModificationError
      );
    });

    it('should throw for non-existent skill', async () => {
      await expect(service.deleteSkill('non-existent')).rejects.toThrow(SkillNotFoundError);
    });

    it('should remove skill from cache', async () => {
      const countBefore = await service.getSkillCount();
      await service.deleteSkill(createdSkillId);
      const countAfter = await service.getSkillCount();

      expect(countAfter).toBe(countBefore - 1);
    });
  });

  // ===========================================================================
  // setSkillEnabled Tests
  // ===========================================================================

  describe('setSkillEnabled', () => {
    let createdSkillId: string;

    beforeEach(async () => {
      const skill = await service.createSkill({
        name: 'Enable Test',
        description: 'Test enabling/disabling',
        category: 'development',
        promptContent: 'Content',
      });
      createdSkillId = skill.id;
    });

    it('should disable a skill', async () => {
      const updated = await service.setSkillEnabled(createdSkillId, false);
      expect(updated.isEnabled).toBe(false);
    });

    it('should enable a disabled skill', async () => {
      await service.setSkillEnabled(createdSkillId, false);
      const updated = await service.setSkillEnabled(createdSkillId, true);
      expect(updated.isEnabled).toBe(true);
    });
  });

  // ===========================================================================
  // getSkillsForRole Tests
  // ===========================================================================

  describe('getSkillsForRole', () => {
    it('should return skills assigned to role', async () => {
      const skills = await service.getSkillsForRole('developer');
      expect(skills.length).toBeGreaterThan(0);
    });

    it('should return only enabled skills', async () => {
      // Create and disable a skill for developer
      const skill = await service.createSkill({
        name: 'Disabled Dev Skill',
        description: 'For developer but disabled',
        category: 'development',
        promptContent: 'Content',
        assignableRoles: ['developer'],
      });

      await service.updateSkill(skill.id, { isEnabled: false });

      const skills = await service.getSkillsForRole('developer');
      expect(skills.find((s) => s.name === 'Disabled Dev Skill')).toBeUndefined();
    });

    it('should return empty for role with no skills', async () => {
      const skills = await service.getSkillsForRole('nonexistent-role');
      expect(skills).toHaveLength(0);
    });
  });

  // ===========================================================================
  // refresh Tests
  // ===========================================================================

  describe('refresh', () => {
    it('should reload skills from disk', async () => {
      // Create a skill
      const skill = await service.createSkill({
        name: 'Refresh Test',
        description: 'Test',
        category: 'development',
        promptContent: 'Content',
      });

      // Manually clear and refresh
      await service.refresh();

      const skills = await service.listSkills();
      expect(skills.find((s) => s.id === skill.id)).toBeDefined();
    });

    it('should reload after new skill added to directory', async () => {
      // Add a new skill directly to user directory
      await createSampleSkill(userSkillsDir, 'manually-added', {
        name: 'Manually Added',
        description: 'Added after initialization',
      });

      // Skill should not be in cache yet
      const before = await service.getSkill('manually-added');
      expect(before).toBeNull();

      // Refresh and check
      await service.refresh();
      const after = await service.getSkill('manually-added');
      expect(after).not.toBeNull();
    });
  });

  // ===========================================================================
  // skillExists Tests
  // ===========================================================================

  describe('skillExists', () => {
    it('should return true for existing skill', async () => {
      const exists = await service.skillExists('code-review');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent skill', async () => {
      const exists = await service.skillExists('non-existent');
      expect(exists).toBe(false);
    });
  });

  // ===========================================================================
  // getSkillCount Tests
  // ===========================================================================

  describe('getSkillCount', () => {
    it('should return correct count', async () => {
      const count = await service.getSkillCount();
      expect(count).toBe(2); // Two builtin skills
    });

    it('should increase after creating skill', async () => {
      const before = await service.getSkillCount();

      await service.createSkill({
        name: 'Count Test',
        description: 'Test',
        category: 'development',
        promptContent: 'Content',
      });

      const after = await service.getSkillCount();
      expect(after).toBe(before + 1);
    });
  });

  // ===========================================================================
  // Error Handling Tests
  // ===========================================================================

  describe('Error Classes', () => {
    describe('SkillNotFoundError', () => {
      it('should have correct properties', () => {
        const error = new SkillNotFoundError('test-id');
        expect(error.name).toBe('SkillNotFoundError');
        expect(error.skillId).toBe('test-id');
        expect(error.message).toContain('test-id');
      });
    });

    describe('SkillValidationError', () => {
      it('should have correct properties', () => {
        const errors = ['Error 1', 'Error 2'];
        const error = new SkillValidationError(errors);
        expect(error.name).toBe('SkillValidationError');
        expect(error.errors).toEqual(errors);
        expect(error.message).toContain('Error 1');
        expect(error.message).toContain('Error 2');
      });
    });

    describe('BuiltinSkillModificationError', () => {
      it('should have correct properties', () => {
        const error = new BuiltinSkillModificationError('delete');
        expect(error.name).toBe('BuiltinSkillModificationError');
        expect(error.action).toBe('delete');
        expect(error.message).toContain('delete');
      });
    });
  });
});

// =============================================================================
// Singleton Tests
// =============================================================================

describe('Skill Service Singleton', () => {
  afterEach(() => {
    resetSkillService();
  });

  describe('getSkillService', () => {
    it('should return singleton instance', () => {
      const instance1 = getSkillService();
      const instance2 = getSkillService();
      expect(instance1).toBe(instance2);
    });

    it('should return SkillService instance', () => {
      const instance = getSkillService();
      expect(instance).toBeInstanceOf(SkillService);
    });
  });

  describe('resetSkillService', () => {
    it('should reset singleton instance', () => {
      const instance1 = getSkillService();
      resetSkillService();
      const instance2 = getSkillService();
      expect(instance1).not.toBe(instance2);
    });
  });
});
