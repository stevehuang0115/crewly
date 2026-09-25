/**
 * Package Validator Tests
 *
 * Tests for skill package validation including file checks,
 * JSON schema validation, and field requirements.
 *
 * @module cli/utils/package-validator.test
 */

import { NO_DESCRIPTOR_ERROR, validatePackage } from './package-validator.js';
import path from 'path';
import os from 'os';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

describe('validatePackage', () => {
  const tmpDir = path.join(os.tmpdir(), 'crewly-validator-test');

  /** Helper to create a temporary skill directory with given files */
  function createSkill(files: Record<string, string>): string {
    const dir = path.join(tmpDir, `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  /** Minimal valid skill.json */
  function validManifest(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      id: 'test-skill',
      name: 'Test Skill',
      description: 'A test skill',
      version: '1.0.0',
      category: 'development',
      assignableRoles: ['developer'],
      tags: ['test'],
      ...overrides,
    });
  }

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should pass for a valid skill directory', () => {
    const dir = createSkill({
      'skill.json': validManifest(),
      'execute.sh': '#!/bin/bash\necho hello',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should fail for a non-existent directory', () => {
    const result = validatePackage('/nonexistent/path');
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('does not exist');
  });

  it('fails with an error naming both accepted layouts when neither SKILL.md nor skill.json exists', () => {
    const dir = createSkill({
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([NO_DESCRIPTOR_ERROR]);
    expect(NO_DESCRIPTOR_ERROR).toContain('SKILL.md (YAML frontmatter + instructions) and execute.sh');
    expect(NO_DESCRIPTOR_ERROR).toContain('legacy: skill.json, instructions.md and execute.sh');
  });

  it('reports the legacy skill.json layout and returns its manifest', () => {
    const dir = createSkill({
      'skill.json': validManifest(),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result).toMatchObject({ valid: true, layout: 'skill.json', manifest: { id: 'test-skill', version: '1.0.0' } });
  });

  it('should fail when execute.sh is missing', () => {
    const dir = createSkill({
      'skill.json': validManifest(),
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required file: execute.sh');
  });

  it('should fail when instructions.md is missing', () => {
    const dir = createSkill({
      'skill.json': validManifest(),
      'execute.sh': '#!/bin/bash',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required file: instructions.md');
  });

  it('should fail when skill.json has invalid JSON', () => {
    const dir = createSkill({
      'skill.json': 'not json',
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Invalid JSON'))).toBe(true);
  });

  it('should fail when id is missing', () => {
    const dir = createSkill({
      'skill.json': validManifest({ id: '' }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('id'))).toBe(true);
  });

  it('should fail when id is not kebab-case', () => {
    const dir = createSkill({
      'skill.json': validManifest({ id: 'TestSkill' }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('kebab-case'))).toBe(true);
  });

  it('should fail when version is not semver', () => {
    const dir = createSkill({
      'skill.json': validManifest({ version: 'v1' }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('semver'))).toBe(true);
  });

  it('should fail when assignableRoles is empty', () => {
    const dir = createSkill({
      'skill.json': validManifest({ assignableRoles: [] }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('assignableRoles'))).toBe(true);
  });

  it('should fail when tags is empty', () => {
    const dir = createSkill({
      'skill.json': validManifest({ tags: [] }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tags'))).toBe(true);
  });

  it('should warn when category is non-standard', () => {
    const dir = createSkill({
      'skill.json': validManifest({ category: 'exotic-category' }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes('exotic-category'))).toBe(true);
  });

  it('should warn when author is missing', () => {
    const dir = createSkill({
      'skill.json': validManifest(),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.warnings.some((w) => w.includes('author'))).toBe(true);
  });

  it('should warn when license is missing', () => {
    const dir = createSkill({
      'skill.json': validManifest(),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.warnings.some((w) => w.includes('license'))).toBe(true);
  });

  it('should accept valid kebab-case IDs', () => {
    const dir = createSkill({
      'skill.json': validManifest({ id: 'git-commit-helper' }),
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(true);
  });

  describe('SKILL.md layout', () => {
    /** SKILL.md content with the given frontmatter lines */
    function skillMd(frontmatter: string, body = '# Instructions\n\nDo the thing.'): string {
      return `---\n${frontmatter}\n---\n\n${body}\n`;
    }

    /** Frontmatter of a valid current-layout skill, no id (the usual case) */
    const VALID_FRONTMATTER = [
      'name: Test Skill',
      'description: "A test skill"',
      'version: 1.0.0',
      'category: development',
      'assignableRoles:',
      '  - developer',
      'tags:',
      '  - test',
      'triggers:',
      '  - test trigger',
    ].join('\n');

    it('passes for SKILL.md + execute.sh with no skill.json or instructions.md', () => {
      const dir = createSkill({ 'SKILL.md': skillMd(VALID_FRONTMATTER), 'execute.sh': '#!/bin/bash' });

      const result = validatePackage(dir);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
      expect(result.layout).toBe('SKILL.md');
    });

    it('takes the id from the directory name when the frontmatter has none, as the registry does', () => {
      const dir = createSkill({ 'SKILL.md': skillMd(VALID_FRONTMATTER), 'execute.sh': '#!/bin/bash' });

      expect(validatePackage(dir).manifest).toMatchObject({
        id: path.basename(dir),
        name: 'Test Skill',
        version: '1.0.0',
        category: 'development',
        tags: ['test'],
      });
    });

    it('uses an explicit frontmatter id over the directory name', () => {
      const dir = createSkill({
        'SKILL.md': skillMd(`id: explicit-id\n${VALID_FRONTMATTER}`),
        'execute.sh': '#!/bin/bash',
      });

      expect(validatePackage(dir).manifest?.id).toBe('explicit-id');
    });

    it('still requires execute.sh', () => {
      const dir = createSkill({ 'SKILL.md': skillMd(VALID_FRONTMATTER) });

      const result = validatePackage(dir);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(['Missing required file: execute.sh']);
    });

    it('fails when SKILL.md has no frontmatter', () => {
      const dir = createSkill({ 'SKILL.md': '# Just markdown\n', 'execute.sh': '#!/bin/bash' });

      const result = validatePackage(dir);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SKILL.md has no YAML frontmatter (it must start with a --- block)');
    });

    it('fails when the frontmatter is not valid YAML', () => {
      const dir = createSkill({
        'SKILL.md': skillMd('name: [unclosed\ndescription: x'),
        'execute.sh': '#!/bin/bash',
      });

      const result = validatePackage(dir);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/^Invalid YAML frontmatter in SKILL\.md:/);
    });

    it('names the frontmatter as the source of a missing field', () => {
      const dir = createSkill({
        'SKILL.md': skillMd(VALID_FRONTMATTER.replace('version: 1.0.0\n', '')),
        'execute.sh': '#!/bin/bash',
      });

      const result = validatePackage(dir);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SKILL.md frontmatter missing required field: version');
    });

    it('merges like the registry when both files exist: frontmatter wins, skill.json fills gaps', () => {
      const dir = createSkill({
        'SKILL.md': skillMd(VALID_FRONTMATTER.replace('version: 1.0.0', 'version: 2.0.0')),
        'skill.json': validManifest({ id: 'json-id', version: '1.0.0', author: 'From Json' }),
        'execute.sh': '#!/bin/bash',
      });

      const result = validatePackage(dir);
      expect(result).toMatchObject({
        valid: true,
        layout: 'SKILL.md',
        manifest: { id: 'json-id', version: '2.0.0', author: 'From Json' },
      });
    });

    it('passes for a real built-in SKILL.md skill (config/skills/agent/marketplace/code-review)', () => {
      const builtIn = path.resolve(__dirname, '..', '..', '..', 'config', 'skills', 'agent', 'marketplace', 'code-review');

      const result = validatePackage(builtIn);
      expect(result.errors).toEqual([]);
      expect(result).toMatchObject({ valid: true, layout: 'SKILL.md', manifest: { id: 'code-review' } });
    });
  });
});
