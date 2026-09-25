/**
 * Package Validator Tests
 *
 * Tests for skill package validation including file checks,
 * JSON schema validation, and field requirements.
 *
 * @module cli/utils/package-validator.test
 */

import { validatePackage } from './package-validator.js';
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

  it('should fail when skill.json is missing', () => {
    const dir = createSkill({
      'execute.sh': '#!/bin/bash',
      'instructions.md': '# Instructions',
    });

    const result = validatePackage(dir);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required file: skill.json');
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

  describe('setup block', () => {
    const setup = { steps: [{ id: 'whisper-cli', type: 'command', check: { commands: ['whisper-cli'] }, install: { linux: { script: 'install-whisper.sh' } } }] };

    it('accepts a valid setup block whose install script ships with the skill', () => {
      const dir = createSkill({ 'skill.json': validManifest({ setup }), 'execute.sh': '#!/bin/bash', 'instructions.md': '# x', 'install-whisper.sh': 'exit 0' });
      expect(validatePackage(dir).errors).toEqual([]);
    });

    it('rejects an invalid setup block', () => {
      const dir = createSkill({ 'skill.json': validManifest({ setup: { steps: [{ id: 'x', type: 'npm' }] } }), 'execute.sh': '#!/bin/bash', 'instructions.md': '# x' });
      const result = validatePackage(dir);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/^skill\.json setup\.steps\[0\]\.type must be one of/);
    });

    it('rejects a setup block naming an install script that is missing', () => {
      const dir = createSkill({ 'skill.json': validManifest({ setup }), 'execute.sh': '#!/bin/bash', 'instructions.md': '# x' });
      expect(validatePackage(dir).errors).toEqual(['skill.json setup step "whisper-cli" names install script install-whisper.sh, which is not in the skill directory']);
    });

    it.each(['transcribe-audio', 'pdf-tools'])('the shipped %s skill passes publish validation', (id) => {
      const result = validatePackage(path.resolve(__dirname, '../../../config/skills/agent', id));
      expect(result.errors).toEqual([]);
    });
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
});
