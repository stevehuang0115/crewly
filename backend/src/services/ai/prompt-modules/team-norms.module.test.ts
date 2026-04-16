/**
 * Unit tests for TeamNormsModule
 *
 * Tests loading of team norms/SOPs from a temporary norms directory.
 *
 * @module services/ai/prompt-modules/team-norms.module.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TeamNormsModule } from './team-norms.module.js';
import type { ModuleConfig } from './prompt-module.interface.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let normsDir: string;

/** Minimal ModuleConfig for testing */
function makeConfig(overrides: Partial<ModuleConfig> = {}): ModuleConfig {
  return {
    sessionName: 'test-agent',
    memberId: 'member-1',
    role: 'developer',
    agentSkillsPath: '/tmp/skills',
    tlSkillsPath: '/tmp/tl-skills',
    projectRoot: '/tmp/project',
    ...overrides,
  };
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-norms-test-'));
  normsDir = path.join(tempDir, 'norms');
  fs.mkdirSync(normsDir, { recursive: true });

  // Create test norm files
  fs.writeFileSync(
    path.join(normsDir, 'brand-consistency.md'),
    '# Brand Consistency\n\nAll content must follow brand guidelines.',
    'utf-8',
  );
  fs.writeFileSync(
    path.join(normsDir, 'quality-checklist.md'),
    '# Quality Checklist\n\n- [ ] Grammar check\n- [ ] Tone review',
    'utf-8',
  );
});

afterAll(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamNormsModule', () => {
  let mod: TeamNormsModule;

  beforeEach(() => {
    mod = new TeamNormsModule();
  });

  describe('metadata', () => {
    it('should have correct name and priority', () => {
      expect(mod.name).toBe('team-norms');
      expect(mod.priority).toBe(9.5);
      expect(mod.compactable).toBe(true);
    });
  });

  describe('shouldInclude', () => {
    it('should return false when teamNormsPath is not set', () => {
      expect(mod.shouldInclude(makeConfig())).toBe(false);
    });

    it('should return false when teamNormsPath is empty string', () => {
      expect(mod.shouldInclude(makeConfig({ teamNormsPath: '' }))).toBe(false);
    });

    it('should return false when directory does not exist', () => {
      expect(mod.shouldInclude(makeConfig({ teamNormsPath: '/nonexistent/path' }))).toBe(false);
    });

    it('should return true when norms directory exists', () => {
      expect(mod.shouldInclude(makeConfig({ teamNormsPath: normsDir }))).toBe(true);
    });
  });

  describe('build', () => {
    it('should load all .md files from norms directory', async () => {
      const config = makeConfig({ teamNormsPath: normsDir });
      const content = await mod.build(config);

      expect(content).toContain('Team Norms & SOPs');
      expect(content).toContain('Brand Consistency');
      expect(content).toContain('Quality Checklist');
    });

    it('should return empty string for empty directory', async () => {
      const emptyDir = path.join(tempDir, 'empty-norms');
      fs.mkdirSync(emptyDir, { recursive: true });

      const config = makeConfig({ teamNormsPath: emptyDir });
      const content = await mod.build(config);

      expect(content).toBe('');
    });

    it('should only load .md files', async () => {
      const mixedDir = path.join(tempDir, 'mixed-norms');
      fs.mkdirSync(mixedDir, { recursive: true });
      fs.writeFileSync(path.join(mixedDir, 'norm.md'), '# Norm\nContent.', 'utf-8');
      fs.writeFileSync(path.join(mixedDir, 'data.json'), '{}', 'utf-8');
      fs.writeFileSync(path.join(mixedDir, 'script.sh'), '#!/bin/bash', 'utf-8');

      const config = makeConfig({ teamNormsPath: mixedDir });
      const content = await mod.build(config);

      expect(content).toContain('Norm');
      expect(content).not.toContain('{}');
      expect(content).not.toContain('#!/bin/bash');
    });

    it('should handle nonexistent directory gracefully', async () => {
      const config = makeConfig({ teamNormsPath: '/nonexistent' });
      const content = await mod.build(config);
      expect(content).toBe('');
    });
  });
});
