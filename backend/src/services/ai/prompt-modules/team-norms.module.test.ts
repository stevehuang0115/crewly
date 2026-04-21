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

  // -------------------------------------------------------------------------
  // Frontmatter-driven filtering (solves "SOP overload" with 50+ files)
  // -------------------------------------------------------------------------

  describe('frontmatter filtering', () => {
    it('skips norms marked deprecated: true', async () => {
      const dir = path.join(tempDir, 'deprecated-norms');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'old.md'),
        '---\ndeprecated: true\n---\n# Old SOP\nRetired content.',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(dir, 'current.md'),
        '# Current SOP\nStill in force.',
        'utf-8',
      );

      const content = await mod.build(makeConfig({ teamNormsPath: dir }));
      expect(content).toContain('Current SOP');
      expect(content).not.toContain('Old SOP');
      expect(content).not.toContain('Retired content');
    });

    it('includes universal norms (no appliesTo) for any role', async () => {
      const dir = path.join(tempDir, 'universal-norms');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'all.md'),
        '# Universal SOP\nApplies to everyone.',
        'utf-8',
      );

      const content = await mod.build(
        makeConfig({ teamNormsPath: dir, role: 'some-obscure-role' }),
      );
      expect(content).toContain('Universal SOP');
    });

    it('filters by appliesTo when present', async () => {
      const dir = path.join(tempDir, 'role-scoped-norms');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'writer-only.md'),
        '---\nappliesTo: [writer]\n---\n# Writer SOP\nFor writers.',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(dir, 'strategist-only.md'),
        '---\nappliesTo: [strategist]\n---\n# Strategist SOP\nFor strategists.',
        'utf-8',
      );

      const writerContent = await mod.build(
        makeConfig({ teamNormsPath: dir, role: 'writer' }),
      );
      expect(writerContent).toContain('Writer SOP');
      expect(writerContent).not.toContain('Strategist SOP');

      const strategistContent = await mod.build(
        makeConfig({ teamNormsPath: dir, role: 'strategist' }),
      );
      expect(strategistContent).toContain('Strategist SOP');
      expect(strategistContent).not.toContain('Writer SOP');
    });

    it('strips frontmatter from the emitted content', async () => {
      const dir = path.join(tempDir, 'frontmatter-strip');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'norm.md'),
        '---\ntitle: My Norm\npriority: 10\n---\n# Body\nThe real content.',
        'utf-8',
      );

      const content = await mod.build(makeConfig({ teamNormsPath: dir }));
      expect(content).toContain('The real content');
      expect(content).not.toContain('priority:');
      expect(content).not.toContain('title:');
    });

    it('ranks by priority desc so critical norms win limited slots', async () => {
      const dir = path.join(tempDir, 'priority-norms');
      fs.mkdirSync(dir, { recursive: true });
      // Create 7 norms — 2 high-priority, 5 normal. MAX_NORM_FILES=5 caps output,
      // so both high-priority must survive while 2 normal ones get dropped.
      fs.writeFileSync(
        path.join(dir, 'high-a.md'),
        '---\npriority: 100\n---\n# High A\nCritical rule A.',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(dir, 'high-b.md'),
        '---\npriority: 100\n---\n# High B\nCritical rule B.',
        'utf-8',
      );
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(
          path.join(dir, `normal-${i}.md`),
          `# Normal ${i}\nRoutine guidance ${i}.`,
          'utf-8',
        );
      }

      const content = await mod.build(makeConfig({ teamNormsPath: dir }));
      expect(content).toContain('Critical rule A');
      expect(content).toContain('Critical rule B');
      // Only 3 of the 5 normals fit in the remaining slots.
      const normalMatches = (content.match(/Routine guidance/g) ?? []).length;
      expect(normalMatches).toBe(3);
    });
  });
});
