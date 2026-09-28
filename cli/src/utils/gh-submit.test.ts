/**
 * GitHub CLI Submit Utility Tests
 *
 * Tests for the gh-based marketplace submission workflow.
 * All shell commands are mocked to avoid real Git/GitHub operations.
 *
 * @module cli/utils/gh-submit.test
 */

import { checkGhPrerequisites, getGhUsername, submitToGitHub } from './gh-submit.js';
import type { SkillManifest } from './package-validator.js';
import * as fs from 'fs';

// Mock child_process
const mockExecSync = jest.fn();
jest.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock chalk to pass through strings
jest.mock('chalk', () => ({
  default: {
    red: (s: string) => s,
    blue: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    gray: (s: string) => s,
    white: (s: string) => s,
  },
  red: (s: string) => s,
  blue: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  gray: (s: string) => s,
  white: (s: string) => s,
}));

// Mock fs for PR body file
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn(),
  };
});

/** Dirent stand-in for the mocked readdirSync */
function fileEntry(name: string): { name: string; isFile: () => boolean } {
  return { name, isFile: () => true };
}

describe('gh-submit', () => {
  const mockConsole = jest.spyOn(console, 'log').mockImplementation();

  beforeEach(() => {
    jest.clearAllMocks();
    // A current-layout skill: SKILL.md + execute.sh
    (fs.readdirSync as unknown as jest.Mock).mockReturnValue([
      fileEntry('execute.sh'),
      fileEntry('SKILL.md'),
      { name: 'assets', isFile: () => false },
    ]);
  });

  afterAll(() => {
    mockConsole.mockRestore();
  });

  const testManifest: SkillManifest = {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill for unit testing',
    version: '1.0.0',
    category: 'development',
    assignableRoles: ['developer'],
    tags: ['test'],
  };

  describe('checkGhPrerequisites', () => {
    it('should pass when gh is installed and authenticated', () => {
      mockExecSync.mockReturnValue('gh version 2.40.0');
      expect(() => checkGhPrerequisites()).not.toThrow();
    });

    it('should throw when gh is not installed', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('command not found: gh');
      });

      expect(() => checkGhPrerequisites()).toThrow('GitHub CLI (gh) is not installed');
    });

    it('should throw when gh is not authenticated', () => {
      // First call (gh --version) succeeds
      mockExecSync.mockReturnValueOnce('gh version 2.40.0');
      // Second call (gh auth status) fails
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not logged in');
      });

      expect(() => checkGhPrerequisites()).toThrow('not authenticated');
    });
  });

  describe('getGhUsername', () => {
    it('should return the authenticated username', () => {
      mockExecSync.mockReturnValue('testuser\n');
      expect(getGhUsername()).toBe('testuser');
    });
  });

  describe('submitToGitHub', () => {
    it('should execute the full fork-clone-branch-push-PR flow', async () => {
      // Mock all execSync calls in order
      mockExecSync
        // checkGhPrerequisites: gh --version
        .mockReturnValueOnce('gh version 2.40.0')
        // checkGhPrerequisites: gh auth status
        .mockReturnValueOnce('Logged in')
        // getGhUsername: gh api user
        .mockReturnValueOnce('testuser')
        // fork
        .mockReturnValueOnce('')
        // clone
        .mockReturnValueOnce('')
        // git remote add upstream
        .mockReturnValueOnce('')
        // git fetch upstream main
        .mockReturnValueOnce('')
        // git checkout -b
        .mockReturnValueOnce('')
        // mkdir -p
        .mockReturnValueOnce('')
        // cp -r
        .mockReturnValueOnce('')
        // git add
        .mockReturnValueOnce('')
        // git commit
        .mockReturnValueOnce('')
        // git push
        .mockReturnValueOnce('')
        // gh pr create
        .mockReturnValueOnce('https://github.com/stevehuang0115/crewly/pull/42')
        // rm -rf cleanup
        .mockReturnValueOnce('');

      const result = await submitToGitHub('/path/to/test-skill', testManifest);

      expect(result.prUrl).toBe('https://github.com/stevehuang0115/crewly/pull/42');
      expect(result.branch).toBe('skill/test-skill');
      expect(result.username).toBe('testuser');

      // Verify key commands were called
      const calls = mockExecSync.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual(expect.stringContaining('gh repo fork'));
      expect(calls).toContainEqual(expect.stringContaining('gh repo clone'));
      expect(calls).toContainEqual(expect.stringContaining('gh pr create'));
    });

    it('lists the files actually in the skill directory in the PR body (SKILL.md layout)', async () => {
      mockExecSync.mockReturnValue('https://github.com/stevehuang0115/crewly/pull/44');

      await submitToGitHub('/path/to/test-skill', testManifest);

      const body = String((fs.writeFileSync as unknown as jest.Mock).mock.calls[0][1]);
      expect(body).toContain('- `config/skills/agent/marketplace/test-skill/SKILL.md`');
      expect(body).toContain('- `config/skills/agent/marketplace/test-skill/execute.sh`');
      expect(body).not.toContain('skill.json');
      expect(body).not.toContain('instructions.md');
      expect(body).not.toContain('/assets`');
    });

    it('fails before any gh command when the skill directory cannot be read', async () => {
      (fs.readdirSync as unknown as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      await expect(submitToGitHub('/path/to/missing-skill', testManifest)).rejects.toThrow('ENOENT');
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('should handle fork already exists gracefully', async () => {
      mockExecSync
        .mockReturnValueOnce('gh version 2.40.0')
        .mockReturnValueOnce('Logged in')
        .mockReturnValueOnce('testuser')
        // fork throws "already exists"
        .mockImplementationOnce(() => {
          throw new Error('already exists');
        })
        // remaining calls succeed
        .mockReturnValue('https://github.com/stevehuang0115/crewly/pull/43');

      const result = await submitToGitHub('/path/to/test-skill', testManifest);
      expect(result.prUrl).toContain('github.com');
    });

    it('should throw on fork failure (non-exists error)', async () => {
      mockExecSync
        .mockReturnValueOnce('gh version 2.40.0')
        .mockReturnValueOnce('Logged in')
        .mockReturnValueOnce('testuser')
        // fork throws unexpected error
        .mockImplementationOnce(() => {
          throw new Error('permission denied');
        });

      await expect(
        submitToGitHub('/path/to/test-skill', testManifest),
      ).rejects.toThrow('Failed to fork repository');
    });

    it('should clean up temp directory even on failure', async () => {
      mockExecSync
        .mockReturnValueOnce('gh version 2.40.0')
        .mockReturnValueOnce('Logged in')
        .mockReturnValueOnce('testuser')
        // fork succeeds
        .mockReturnValueOnce('')
        // clone succeeds
        .mockReturnValueOnce('')
        // git remote add upstream fails
        .mockImplementationOnce(() => {
          throw new Error('network error');
        })
        // rm -rf cleanup
        .mockReturnValueOnce('');

      await expect(
        submitToGitHub('/path/to/test-skill', testManifest),
      ).rejects.toThrow('network error');

      // Verify cleanup was attempted (last call should be rm -rf)
      const lastCall = mockExecSync.mock.calls[mockExecSync.mock.calls.length - 1];
      expect(lastCall[0]).toContain('rm -rf');
    });
  });
});
