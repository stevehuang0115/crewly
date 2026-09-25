/**
 * Archive Creator Tests
 *
 * Tests for skill archive creation, checksum generation,
 * and registry entry generation.
 *
 * @module cli/utils/archive-creator.test
 */

import { createSkillArchive, generateChecksum, generateRegistryEntry, includeInArchive } from './archive-creator.js';
import * as tar from 'tar';
import type { SkillManifest } from './package-validator.js';
import path from 'path';
import os from 'os';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';

describe('archive-creator', () => {
  const tmpDir = path.join(os.tmpdir(), 'crewly-archive-test');

  /** Create a temporary skill directory with files */
  function createSkill(id: string, version: string): string {
    const dir = path.join(tmpDir, id);
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      path.join(dir, 'skill.json'),
      JSON.stringify({
        id,
        name: `Test ${id}`,
        description: 'Test skill',
        version,
        category: 'development',
        assignableRoles: ['developer'],
        tags: ['test'],
        author: 'Test Author',
        license: 'MIT',
        triggers: ['test trigger'],
      })
    );
    writeFileSync(path.join(dir, 'execute.sh'), '#!/bin/bash\necho test');
    writeFileSync(path.join(dir, 'instructions.md'), '# Test');

    return dir;
  }

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('createSkillArchive', () => {
    it('should create a tar.gz archive', async () => {
      const skillDir = createSkill('test-archive', '1.0.0');
      const outputDir = path.join(tmpDir, 'output');
      mkdirSync(outputDir, { recursive: true });

      const archivePath = await createSkillArchive(skillDir, outputDir);

      expect(archivePath).toContain('test-archive-1.0.0.tar.gz');
      expect(existsSync(archivePath)).toBe(true);
    });

    it('should name archive as id-version.tar.gz', async () => {
      const skillDir = createSkill('my-skill', '2.1.0');
      const outputDir = path.join(tmpDir, 'output2');
      mkdirSync(outputDir, { recursive: true });

      const archivePath = await createSkillArchive(skillDir, outputDir);

      expect(path.basename(archivePath)).toBe('my-skill-2.1.0.tar.gz');
    });
  });

  describe('archive contents', () => {
    it('leaves tests, mocks and litter out of the archive', async () => {
      const skillDir = createSkill('test-exclude', '1.0.0');
      writeFileSync(path.join(skillDir, 'execute.test.sh'), 'test');
      writeFileSync(path.join(skillDir, 'mock-server.py'), 'mock');
      writeFileSync(path.join(skillDir, 'install-x.sh'), 'exit 0');
      const outputDir = path.join(tmpDir, 'output-exclude');
      mkdirSync(outputDir, { recursive: true });
      const archivePath = await createSkillArchive(skillDir, outputDir);
      const entries: string[] = [];
      await tar.t({ file: archivePath, onReadEntry: (e: { path: string }) => { entries.push(e.path); } } as never);
      const files = entries.filter((e) => !e.endsWith('/')).sort();
      // `<id>/<file>`: what installers expect when they extract with strip: 1
      expect(files).toEqual(['test-exclude/execute.sh', 'test-exclude/install-x.sh', 'test-exclude/instructions.md', 'test-exclude/skill.json']);
    });

    it('extracts with strip: 1 into exactly the skill files', async () => {
      const skillDir = createSkill('test-strip', '1.0.0');
      const outputDir = path.join(tmpDir, 'output-strip');
      const dest = path.join(tmpDir, 'installed-strip');
      mkdirSync(outputDir, { recursive: true });
      mkdirSync(dest, { recursive: true });
      const archivePath = await createSkillArchive(skillDir, outputDir);
      await tar.x({ file: archivePath, cwd: dest, strip: 1 });
      expect(existsSync(path.join(dest, 'skill.json'))).toBe(true);
      expect(existsSync(path.join(dest, 'execute.sh'))).toBe(true);
    });

    it('includeInArchive checks every path segment', () => {
      expect(includeInArchive('x/execute.sh')).toBe(true);
      expect(includeInArchive('x/__pycache__/a.pyc')).toBe(false);
      expect(includeInArchive('x/execute.test.sh')).toBe(false);
    });
  });

  describe('generateChecksum', () => {
    it('should generate a sha256 checksum', () => {
      const testFile = path.join(tmpDir, 'checksum-test.txt');
      writeFileSync(testFile, 'hello world');

      const checksum = generateChecksum(testFile);

      expect(checksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    });

    it('should produce consistent checksums for same content', () => {
      const file1 = path.join(tmpDir, 'check1.txt');
      const file2 = path.join(tmpDir, 'check2.txt');
      writeFileSync(file1, 'same content');
      writeFileSync(file2, 'same content');

      expect(generateChecksum(file1)).toBe(generateChecksum(file2));
    });

    it('should produce different checksums for different content', () => {
      const file1 = path.join(tmpDir, 'diff1.txt');
      const file2 = path.join(tmpDir, 'diff2.txt');
      writeFileSync(file1, 'content a');
      writeFileSync(file2, 'content b');

      expect(generateChecksum(file1)).not.toBe(generateChecksum(file2));
    });
  });

  describe('generateRegistryEntry', () => {
    it('should generate a complete registry entry', () => {
      const testFile = path.join(tmpDir, 'entry-test.txt');
      writeFileSync(testFile, 'archive data');

      const manifest: SkillManifest = {
        id: 'my-entry',
        name: 'My Entry',
        description: 'Test entry',
        version: '1.0.0',
        category: 'development',
        assignableRoles: ['developer'],
        tags: ['test'],
        author: 'Test Author',
        license: 'MIT',
        triggers: ['test trigger'],
      };

      const entry = generateRegistryEntry(manifest, testFile, 'sha256:abc123');

      expect(entry.id).toBe('my-entry');
      expect(entry.type).toBe('skill');
      expect(entry.name).toBe('My Entry');
      expect(entry.version).toBe('1.0.0');
      expect(entry.assets.checksum).toBe('sha256:abc123');
      expect(entry.assets.archive).toBe('skills/my-entry/entry-test.txt');
      expect(entry.assets.sizeBytes).toBeGreaterThan(0);
      expect(entry.metadata.assignableRoles).toEqual(['developer']);
      expect(entry.metadata.triggers).toEqual(['test trigger']);
      expect(entry.downloads).toBe(0);
      expect(entry.rating).toBe(0);
    });

    it('copies the setup block into metadata.setup', () => {
      const setup = { estimatedMinutes: 6, steps: [{ id: 'ffmpeg', type: 'command', check: { commands: ['ffmpeg'] } }] };
      const outputDir = path.join(tmpDir, 'out-setup');
      mkdirSync(outputDir, { recursive: true });
      const archive = path.join(outputDir, 'x.tar.gz');
      writeFileSync(archive, 'x');
      const manifest = { id: 'test-setup-entry', name: 'n', description: 'd', version: '1.1.0', category: 'development', assignableRoles: ['*'], tags: ['t'], setup } as SkillManifest;
      expect(generateRegistryEntry(manifest, archive, 'sha256:abc').metadata.setup).toEqual(setup);
    });

    it('should default author to Crewly Team when missing', () => {
      const testFile = path.join(tmpDir, 'entry-no-author.txt');
      writeFileSync(testFile, 'data');

      const manifest: SkillManifest = {
        id: 'no-author',
        name: 'No Author',
        description: 'Test',
        version: '1.0.0',
        category: 'development',
        assignableRoles: ['developer'],
        tags: ['test'],
      };

      const entry = generateRegistryEntry(manifest, testFile, 'sha256:abc');

      expect(entry.author).toBe('Crewly Team');
      expect(entry.license).toBe('MIT');
    });
  });
});
