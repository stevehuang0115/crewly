/**
 * Tests for Skill Executor Service
 *
 * @module services/skill/skill-executor.service.test
 */

// Jest globals are available automatically
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SkillExecutorService,
  getSkillExecutorService,
  resetSkillExecutorService,
  redactSecrets,
} from './skill-executor.service.js';
import { SkillWithPrompt, SkillExecutionContext } from '../../types/skill.types.js';
import * as skillService from './skill.service.js';
import * as settingsService from '../settings/settings.service.js';
import {
  CredentialStoreService,
  resetCredentialStoreService,
  _setCredentialStoreForTesting,
} from '../credential/credential-store.service.js';
import { _resetDerivedKeyCache } from '../../utils/encryption.utils.js';
import {
  MissingCredentialError,
  InsufficientScopeError,
  GoogleOAuthPayload,
} from '../../types/credential.types.js';

// Mock the skill service
jest.mock('./skill.service.js', () => ({
  getSkillService: jest.fn(),
}));

// Mock the settings service
jest.mock('../settings/settings.service.js', () => ({
  getSettingsService: jest.fn(),
}));

describe('SkillExecutorService', () => {
  let executor: SkillExecutorService;
  let testDir: string;

  const mockContext: SkillExecutionContext = {
    agentId: 'test-agent',
    roleId: 'developer',
    projectId: 'test-project',
    taskId: 'test-task',
    userInput: 'Test input',
  };

  const mockSettings = {
    skills: {
      enableScriptExecution: true,
      enableBrowserAutomation: true,
      skillExecutionTimeoutMs: 60000,
    },
  };

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `skill-executor-test-${Date.now()}-${Math.random()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create instructions.md file
    await fs.writeFile(path.join(testDir, 'instructions.md'), '# Test Instructions');

    executor = new SkillExecutorService();

    // Setup default mocks
    const mockSettingsServiceInstance = {
      getSettings: jest.fn().mockResolvedValue(mockSettings),
    };
    (settingsService.getSettingsService as jest.Mock).mockReturnValue(mockSettingsServiceInstance);
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    resetSkillExecutorService();
    jest.clearAllMocks();
  });

  // ===========================================================================
  // executeSkillInternal Tests
  // ===========================================================================

  describe('executeSkillInternal', () => {
    describe('prompt-only skills', () => {
      it('should return prompt content for prompt-only skill', async () => {
        const skill: SkillWithPrompt = {
          id: 'prompt-skill',
          name: 'Prompt Skill',
          description: 'Just instructions',
          category: 'development',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Test Prompt\n\nDo this thing.',
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output).toBe('# Test Prompt\n\nDo this thing.');
        expect(result.data?.type).toBe('prompt-only');
      });

      it('should handle prompt-only skill with no execution config', async () => {
        const skill: SkillWithPrompt = {
          id: 'simple-prompt',
          name: 'Simple Prompt',
          description: 'Basic skill',
          category: 'development',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: 'Simple instructions',
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output).toBe('Simple instructions');
      });
    });

    describe('script skills', () => {
      it('should execute bash script successfully', async () => {
        // Create test script
        const scriptPath = path.join(testDir, 'test.sh');
        await fs.writeFile(scriptPath, '#!/bin/bash\necho "Hello World"');
        await fs.chmod(scriptPath, 0o755);

        const skill: SkillWithPrompt = {
          id: 'script-skill',
          name: 'Script Skill',
          description: 'Runs a script',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Script Skill',
          execution: {
            type: 'script',
            script: {
              file: 'test.sh',
              interpreter: 'bash',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output?.trim()).toBe('Hello World');
      });

      it('should inject environment variables', async () => {
        const scriptPath = path.join(testDir, 'env-test.sh');
        await fs.writeFile(scriptPath, '#!/bin/bash\necho $CREWLY_AGENT_ID');
        await fs.chmod(scriptPath, 0o755);

        const skill: SkillWithPrompt = {
          id: 'env-skill',
          name: 'Env Skill',
          description: 'Uses env vars',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Env Skill',
          execution: {
            type: 'script',
            script: {
              file: 'env-test.sh',
              interpreter: 'bash',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output?.trim()).toBe('test-agent');
      });

      it('should inject custom environment variables', async () => {
        const scriptPath = path.join(testDir, 'custom-env.sh');
        await fs.writeFile(scriptPath, '#!/bin/bash\necho $CUSTOM_VAR');
        await fs.chmod(scriptPath, 0o755);

        const skill: SkillWithPrompt = {
          id: 'custom-env-skill',
          name: 'Custom Env Skill',
          description: 'Uses custom env vars',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Custom Env',
          execution: {
            type: 'script',
            script: {
              file: 'custom-env.sh',
              interpreter: 'bash',
            },
          },
          environment: {
            variables: { CUSTOM_VAR: 'custom-value' },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output?.trim()).toBe('custom-value');
      });

      it('should load environment variables from .env file', async () => {
        const scriptPath = path.join(testDir, 'env-file-test.sh');
        await fs.writeFile(scriptPath, '#!/bin/bash\necho $FROM_FILE');
        await fs.chmod(scriptPath, 0o755);

        // Create .env file
        await fs.writeFile(path.join(testDir, '.env'), 'FROM_FILE=loaded-from-file');

        const skill: SkillWithPrompt = {
          id: 'env-file-skill',
          name: 'Env File Skill',
          description: 'Loads env from file',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Env File',
          execution: {
            type: 'script',
            script: {
              file: 'env-file-test.sh',
              interpreter: 'bash',
            },
          },
          environment: {
            file: '.env',
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output?.trim()).toBe('loaded-from-file');
      });

      it('should return error for failed script', async () => {
        const scriptPath = path.join(testDir, 'fail.sh');
        await fs.writeFile(scriptPath, '#!/bin/bash\nexit 1');
        await fs.chmod(scriptPath, 0o755);

        const skill: SkillWithPrompt = {
          id: 'fail-skill',
          name: 'Fail Skill',
          description: 'Will fail',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Fail',
          execution: {
            type: 'script',
            script: {
              file: 'fail.sh',
              interpreter: 'bash',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.data?.exitCode).toBe(1);
      });

      it('should return error for missing script configuration', async () => {
        const skill: SkillWithPrompt = {
          id: 'no-script-config',
          name: 'No Script Config',
          description: 'Missing config',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# No Config',
          execution: {
            type: 'script',
            // Missing script config
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Script configuration missing');
      });

      it('should return error for missing script file', async () => {
        const skill: SkillWithPrompt = {
          id: 'missing-file',
          name: 'Missing File',
          description: 'File does not exist',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Missing File',
          execution: {
            type: 'script',
            script: {
              file: 'nonexistent.sh',
              interpreter: 'bash',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
      });

      it('should block script execution when disabled in settings', async () => {
        const mockSettingsServiceInstance = {
          getSettings: jest.fn().mockResolvedValue({
            skills: {
              enableScriptExecution: false,
              enableBrowserAutomation: true,
            },
          }),
        };
        (settingsService.getSettingsService as jest.Mock).mockReturnValue(
          mockSettingsServiceInstance
        );

        const skill: SkillWithPrompt = {
          id: 'blocked-script',
          name: 'Blocked Script',
          description: 'Should be blocked',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Blocked',
          execution: {
            type: 'script',
            script: {
              file: 'test.sh',
              interpreter: 'bash',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });

    describe('browser skills', () => {
      it('should return browser automation prompt', async () => {
        const skill: SkillWithPrompt = {
          id: 'browser-skill',
          name: 'Browser Skill',
          description: 'Uses browser',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Browser',
          execution: {
            type: 'browser',
            browser: {
              url: 'https://example.com',
              instructions: 'Click the button',
              actions: ['Step 1', 'Step 2'],
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output).toContain('https://example.com');
        expect(result.output).toContain('Click the button');
        expect(result.output).toContain('Claude Chrome MCP');
        expect(result.data?.requiresChromeMcp).toBe(true);
      });

      it('should include user context in browser prompt', async () => {
        const skill: SkillWithPrompt = {
          id: 'browser-context',
          name: 'Browser Context',
          description: 'With context',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Browser Context',
          execution: {
            type: 'browser',
            browser: {
              url: 'https://example.com',
              instructions: 'Do something',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output).toContain('Test input');
      });

      it('should return error for missing browser configuration', async () => {
        const skill: SkillWithPrompt = {
          id: 'no-browser-config',
          name: 'No Browser Config',
          description: 'Missing config',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# No Config',
          execution: {
            type: 'browser',
            // Missing browser config
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Browser configuration missing');
      });

      it('should block browser automation when disabled in settings', async () => {
        const mockSettingsServiceInstance = {
          getSettings: jest.fn().mockResolvedValue({
            skills: {
              enableScriptExecution: true,
              enableBrowserAutomation: false,
            },
          }),
        };
        (settingsService.getSettingsService as jest.Mock).mockReturnValue(
          mockSettingsServiceInstance
        );

        const skill: SkillWithPrompt = {
          id: 'blocked-browser',
          name: 'Blocked Browser',
          description: 'Should be blocked',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Blocked',
          execution: {
            type: 'browser',
            browser: {
              url: 'https://example.com',
              instructions: 'Click',
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });

    describe('mcp-tool skills', () => {
      it('should return MCP tool invocation prompt', async () => {
        const skill: SkillWithPrompt = {
          id: 'mcp-skill',
          name: 'MCP Skill',
          description: 'Calls MCP tool',
          category: 'integration',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# MCP',
          execution: {
            type: 'mcp-tool',
            mcpTool: {
              toolName: 'get_tasks',
              defaultParams: { status: 'open' },
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(true);
        expect(result.output).toContain('get_tasks');
        expect(result.output).toContain('"status": "open"');
        expect(result.data?.toolName).toBe('get_tasks');
      });

      it('should return error for missing MCP tool configuration', async () => {
        const skill: SkillWithPrompt = {
          id: 'no-mcp-config',
          name: 'No MCP Config',
          description: 'Missing config',
          category: 'integration',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# No Config',
          execution: {
            type: 'mcp-tool',
            // Missing mcpTool config
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('MCP tool configuration missing');
      });
    });

    describe('composite skills', () => {
      it('should return error for missing composite configuration', async () => {
        const skill: SkillWithPrompt = {
          id: 'no-composite-config',
          name: 'No Composite Config',
          description: 'Missing config',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# No Config',
          execution: {
            type: 'composite',
            // Missing composite config
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Composite configuration missing');
      });

      it('should return error for empty skill sequence', async () => {
        const skill: SkillWithPrompt = {
          id: 'empty-composite',
          name: 'Empty Composite',
          description: 'Empty sequence',
          category: 'automation',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Empty',
          execution: {
            type: 'composite',
            composite: {
              skillSequence: [],
            },
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('empty');
      });
    });

    describe('disabled skills', () => {
      it('should return error for disabled skill', async () => {
        const skill: SkillWithPrompt = {
          id: 'disabled-skill',
          name: 'Disabled',
          description: 'Is disabled',
          category: 'development',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Disabled',
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('disabled');
      });
    });

    describe('unknown execution type', () => {
      it('should return error for unknown execution type', async () => {
        const skill: SkillWithPrompt = {
          id: 'unknown-type',
          name: 'Unknown Type',
          description: 'Unknown execution',
          category: 'development',
          skillType: 'claude-skill',
          promptFile: path.join(testDir, 'instructions.md'),
          promptContent: '# Unknown',
          execution: {
            type: 'unknown-type' as any,
          },
          assignableRoles: [],
          triggers: [],
          tags: [],
          version: '1.0.0',
          isBuiltin: false,
          isEnabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await executor.executeSkillInternal(skill, mockContext);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown execution type');
      });
    });
  });

  // ===========================================================================
  // executeSkill Tests
  // ===========================================================================

  describe('executeSkill', () => {
    it('should return error for non-existent skill', async () => {
      const mockSkillServiceInstance = {
        getSkill: jest.fn().mockResolvedValue(null),
      };
      (skillService.getSkillService as jest.Mock).mockReturnValue(mockSkillServiceInstance);

      const result = await executor.executeSkill('non-existent', mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error for disabled skill', async () => {
      const disabledSkill: SkillWithPrompt = {
        id: 'disabled',
        name: 'Disabled',
        description: 'Disabled skill',
        category: 'development',
        skillType: 'claude-skill',
        promptFile: path.join(testDir, 'instructions.md'),
        promptContent: '# Disabled',
        assignableRoles: [],
        triggers: [],
        tags: [],
        version: '1.0.0',
        isBuiltin: false,
        isEnabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockSkillServiceInstance = {
        getSkill: jest.fn().mockResolvedValue(disabledSkill),
      };
      (skillService.getSkillService as jest.Mock).mockReturnValue(mockSkillServiceInstance);

      const result = await executor.executeSkill('disabled', mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('disabled');
    });

    it('should execute skill successfully', async () => {
      const promptSkill: SkillWithPrompt = {
        id: 'prompt',
        name: 'Prompt',
        description: 'Prompt skill',
        category: 'development',
        skillType: 'claude-skill',
        promptFile: path.join(testDir, 'instructions.md'),
        promptContent: '# Test Prompt',
        assignableRoles: [],
        triggers: [],
        tags: [],
        version: '1.0.0',
        isBuiltin: false,
        isEnabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const mockSkillServiceInstance = {
        getSkill: jest.fn().mockResolvedValue(promptSkill),
      };
      (skillService.getSkillService as jest.Mock).mockReturnValue(mockSkillServiceInstance);

      const result = await executor.executeSkill('prompt', mockContext);

      expect(result.success).toBe(true);
      expect(result.output).toBe('# Test Prompt');
    });
  });
});

// =============================================================================
// Singleton Tests
// =============================================================================

describe('SkillExecutorService Singleton', () => {
  afterEach(() => {
    resetSkillExecutorService();
  });

  describe('getSkillExecutorService', () => {
    it('should return singleton instance', () => {
      const instance1 = getSkillExecutorService();
      const instance2 = getSkillExecutorService();
      expect(instance1).toBe(instance2);
    });

    it('should return SkillExecutorService instance', () => {
      const instance = getSkillExecutorService();
      expect(instance).toBeInstanceOf(SkillExecutorService);
    });
  });

  describe('resetSkillExecutorService', () => {
    it('should reset singleton instance', () => {
      const instance1 = getSkillExecutorService();
      resetSkillExecutorService();
      const instance2 = getSkillExecutorService();
      expect(instance1).not.toBe(instance2);
    });
  });
});

// =============================================================================
// redactSecrets — pure function tests
// =============================================================================

describe('redactSecrets', () => {
  it('returns original text when secrets list is empty', () => {
    expect(redactSecrets('hello world', [])).toBe('hello world');
  });

  it('returns original text when text is empty', () => {
    expect(redactSecrets('', [{ value: 'x', label: 'y' }])).toBe('');
  });

  it('replaces a single occurrence with <redacted:label>', () => {
    const out = redactSecrets('token=sk-abc123 ok', [
      { value: 'sk-abc123', label: 'api' },
    ]);
    expect(out).toBe('token=<redacted:api> ok');
  });

  it('replaces every occurrence of the same secret', () => {
    const out = redactSecrets('a sk-1 b sk-1 c sk-1 d', [
      { value: 'sk-1', label: 'k' },
    ]);
    expect(out).toBe('a <redacted:k> b <redacted:k> c <redacted:k> d');
  });

  it('replaces different secrets with their own labels', () => {
    const out = redactSecrets('access=AT.123 refresh=RT.456', [
      { value: 'AT.123', label: 'gmail:access_token' },
      { value: 'RT.456', label: 'gmail:refresh_token' },
    ]);
    expect(out).toBe(
      'access=<redacted:gmail:access_token> refresh=<redacted:gmail:refresh_token>',
    );
  });

  it('leaves text unchanged when no secret value appears', () => {
    const out = redactSecrets('nothing sensitive here', [
      { value: 'sk-secret', label: 'k' },
    ]);
    expect(out).toBe('nothing sensitive here');
  });

  it('ignores empty-value entries (no unintended replacement)', () => {
    const out = redactSecrets('some text', [{ value: '', label: 'empty' }]);
    expect(out).toBe('some text');
  });

  it('handles secrets that contain regex-special characters', () => {
    const secret = '$token.*{value}[1]';
    const out = redactSecrets(`raw: ${secret} end`, [
      { value: secret, label: 'regex-safe' },
    ]);
    expect(out).toBe('raw: <redacted:regex-safe> end');
  });
});

// =============================================================================
// credentialEnvPrefix — slot-to-env-var naming
// =============================================================================

describe('credentialEnvPrefix (private)', () => {
  const executor = new SkillExecutorService();

  // The method is private; access via cast. This is intentional — it's the
  // naming contract skills depend on and must be stable across refactors.
  const call = (slot: string): string =>
    (executor as unknown as { credentialEnvPrefix: (s: string) => string })
      .credentialEnvPrefix(slot);

  it('uppercases a simple slot name', () => {
    expect(call('gmail')).toBe('CREWLY_CRED_GMAIL');
  });

  it('converts hyphens to underscores', () => {
    expect(call('gmail-drive')).toBe('CREWLY_CRED_GMAIL_DRIVE');
  });

  it('handles multiple hyphens', () => {
    expect(call('a-b-c')).toBe('CREWLY_CRED_A_B_C');
  });

  it('preserves digits', () => {
    expect(call('service-v2')).toBe('CREWLY_CRED_SERVICE_V2');
  });
});

// =============================================================================
// Credential resolution via buildEnvironmentWithSecrets
// =============================================================================

describe('resolveAndInjectCredentials (via buildEnvironmentWithSecrets)', () => {
  let executor: SkillExecutorService;
  let testDir: string;
  let store: CredentialStoreService;

  /** Build a minimal SkillWithPrompt for these tests. */
  function makeSkill(overrides: Partial<SkillWithPrompt> = {}): SkillWithPrompt {
    return {
      id: 'test-skill',
      name: 'Test',
      description: 'fixture',
      category: 'development',
      skillType: 'claude-skill',
      promptFile: path.join(testDir, 'SKILL.md'),
      promptContent: '',
      execution: { type: 'script', script: { file: 'x.sh', interpreter: 'bash' } },
      assignableRoles: [],
      tags: [],
      triggers: [],
      version: '1.0.0',
      isBuiltin: false,
      isEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  /** Invoke the private method via cast. */
  async function buildEnv(
    skill: SkillWithPrompt,
    context: SkillExecutionContext,
  ): Promise<{ env: NodeJS.ProcessEnv; liveSecrets: Array<{ value: string; label: string }> }> {
    return (executor as unknown as {
      buildEnvironmentWithSecrets: (
        s: SkillWithPrompt,
        c: SkillExecutionContext,
      ) => Promise<{ env: NodeJS.ProcessEnv; liveSecrets: Array<{ value: string; label: string }> }>;
    }).buildEnvironmentWithSecrets(skill, context);
  }

  beforeEach(async () => {
    _resetDerivedKeyCache();
    resetCredentialStoreService();
    testDir = path.join(
      os.tmpdir(),
      `skill-exec-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'SKILL.md'), '# fixture');

    store = new CredentialStoreService({ dir: testDir });
    await store.init();
    _setCredentialStoreForTesting(store);

    executor = new SkillExecutorService();
  });

  afterEach(async () => {
    resetCredentialStoreService();
    _resetDerivedKeyCache();
    resetSkillExecutorService();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  const ctx = (overrides: Partial<SkillExecutionContext> = {}): SkillExecutionContext => ({
    agentId: 'a',
    roleId: 'r',
    ...overrides,
  });

  it('does nothing when skill has no credential requirements', async () => {
    const skill = makeSkill();
    const { env, liveSecrets } = await buildEnv(skill, ctx());
    expect(env.CREWLY_AGENT_ID).toBe('a');
    expect(liveSecrets).toEqual([]);
    // No credential env vars
    expect(Object.keys(env).some((k) => k.startsWith('CREWLY_CRED_'))).toBe(false);
  });

  it('throws MissingCredentialError when a required slot has no binding and no default', async () => {
    const skill = makeSkill({
      credentials: [
        { slot: 'gmail', type: 'google-oauth', provider: 'google', required: true },
      ],
    });
    await expect(buildEnv(skill, ctx())).rejects.toBeInstanceOf(MissingCredentialError);
  });

  it('skips an optional slot with no binding and no default (no env vars, no throw)', async () => {
    const skill = makeSkill({
      credentials: [
        { slot: 'gmail', type: 'google-oauth', provider: 'google', required: false },
      ],
    });
    const { env, liveSecrets } = await buildEnv(skill, ctx());
    expect(Object.keys(env).some((k) => k.startsWith('CREWLY_CRED_'))).toBe(false);
    expect(liveSecrets).toEqual([]);
  });

  it('injects an API-key credential into CREWLY_CRED_<SLOT> and registers redaction', async () => {
    const added = await store.addApiKey({
      name: 'gemini-test',
      provider: 'gemini',
      value: 'k-secret-123',
    });
    const skill = makeSkill({
      credentials: [
        { slot: 'gemini', type: 'api-key', provider: 'gemini', required: true },
      ],
    });

    const { env, liveSecrets } = await buildEnv(
      skill,
      ctx({ credentialBindings: { gemini: added.id } }),
    );

    expect(env.CREWLY_CRED_GEMINI).toBe('k-secret-123');
    expect(liveSecrets).toEqual([{ value: 'k-secret-123', label: 'gemini' }]);
  });

  it('injects OAuth tokens into CREWLY_CRED_<SLOT>_* env vars', async () => {
    const payload: GoogleOAuthPayload = {
      type: 'google-oauth',
      accessToken: 'AT.not-near-expiry',
      refreshToken: 'RT.stable',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 3600_000,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      accountEmail: 'user@example.com',
      clientId: 'cid',
    };
    const added = await store.addOAuth({
      name: 'gmail-test',
      provider: 'google',
      // Use a non-gemini-cli helper so the refresh path is NOT exercised here.
      helper: 'byo-oauth',
      payload,
    });

    const skill = makeSkill({
      credentials: [
        {
          slot: 'gmail',
          type: 'google-oauth',
          provider: 'google',
          required: true,
          requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        },
      ],
    });

    const { env, liveSecrets } = await buildEnv(
      skill,
      ctx({ credentialBindings: { gmail: added.id } }),
    );

    expect(env.CREWLY_CRED_GMAIL_ACCESS_TOKEN).toBe('AT.not-near-expiry');
    expect(env.CREWLY_CRED_GMAIL_REFRESH_TOKEN).toBe('RT.stable');
    expect(env.CREWLY_CRED_GMAIL_TOKEN_TYPE).toBe('Bearer');
    expect(env.CREWLY_CRED_GMAIL_SCOPES).toContain('gmail.readonly');
    expect(env.CREWLY_CRED_GMAIL_EMAIL).toBe('user@example.com');
    expect(env.CREWLY_CRED_GMAIL_EXPIRES_AT).toBeDefined();

    // Both tokens registered for redaction
    const labels = liveSecrets.map((s) => s.label).sort();
    expect(labels).toEqual(['gmail:access_token', 'gmail:refresh_token']);
  });

  it('throws InsufficientScopeError when required scope is missing', async () => {
    const added = await store.addOAuth({
      name: 'incomplete',
      provider: 'google',
      helper: 'byo-oauth',
      payload: {
        type: 'google-oauth',
        accessToken: 'AT', refreshToken: 'RT', tokenType: 'Bearer',
        expiresAt: Date.now() + 3600_000,
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        clientId: 'cid',
      },
    });

    const skill = makeSkill({
      credentials: [
        {
          slot: 'gmail',
          type: 'google-oauth',
          provider: 'google',
          required: true,
          requiredScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
          ],
        },
      ],
    });

    await expect(
      buildEnv(skill, ctx({ credentialBindings: { gmail: added.id } })),
    ).rejects.toBeInstanceOf(InsufficientScopeError);
  });

  it('throws a type-mismatch error when requiredScopes is set but credential is api-key', async () => {
    const added = await store.addApiKey({
      name: 'wrong-type',
      provider: 'gemini',
      value: 'k',
    });

    const skill = makeSkill({
      credentials: [
        {
          slot: 'gmail',
          type: 'google-oauth',
          provider: 'google',
          required: true,
          requiredScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        },
      ],
    });

    await expect(
      buildEnv(skill, ctx({ credentialBindings: { gmail: added.id } })),
    ).rejects.toThrow(/declared requiredScopes but credential is type 'api-key'/);
  });

  it('throws when the bound credential is revoked', async () => {
    const added = await store.addApiKey({
      name: 'revoked-k',
      provider: 'gemini',
      value: 'k',
    });
    await store.updateCredential(added.id, { status: 'revoked' });

    const skill = makeSkill({
      credentials: [
        { slot: 'gemini', type: 'api-key', provider: 'gemini', required: true },
      ],
    });

    await expect(
      buildEnv(skill, ctx({ credentialBindings: { gemini: added.id } })),
    ).rejects.toThrow(/revoked/i);
  });

  it('prefers the agent binding over the skill default', async () => {
    const a = await store.addApiKey({ name: 'a', provider: 'p', value: 'VAL_A' });
    const b = await store.addApiKey({ name: 'b', provider: 'p', value: 'VAL_B' });

    const skill = makeSkill({
      credentials: [
        { slot: 'x', type: 'api-key', provider: 'p', required: true, default: a.id },
      ],
    });

    const { env } = await buildEnv(skill, ctx({ credentialBindings: { x: b.id } }));
    expect(env.CREWLY_CRED_X).toBe('VAL_B');
  });

  it('falls back to the skill default when no binding is supplied', async () => {
    const a = await store.addApiKey({ name: 'a', provider: 'p', value: 'VAL_A' });

    const skill = makeSkill({
      credentials: [
        { slot: 'x', type: 'api-key', provider: 'p', required: true, default: a.id },
      ],
    });

    const { env } = await buildEnv(skill, ctx());
    expect(env.CREWLY_CRED_X).toBe('VAL_A');
  });
});
