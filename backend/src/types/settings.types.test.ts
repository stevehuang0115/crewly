/**
 * Tests for Settings Type Definitions
 *
 * @module types/settings.types.test
 */

// Jest globals are available automatically
import {
  AIRuntime,
  CrewlySettings,
  GeneralSettings,
  ChatSettings,
  SkillsSettings,
  UpdateSettingsInput,
  SettingsValidationResult,
  AI_RUNTIMES,
  SETTINGS_CONSTRAINTS,
  isValidAIRuntime,
  getDefaultSettings,
  validateSettings,
  mergeSettings,
  hasSettingsUpdates,
  getAIRuntimeDisplayName,
  ApiKeyProvider,
  API_KEY_PROVIDERS,
  API_KEY_ENV_VARS,
  ApiKeysSettings,
  ApiKeyConfig,
  isValidApiKeyProvider,
  maskApiKey,
  resolveApiKey,
  maskApiKeysSettings,
} from './settings.types.js';

describe('Settings Types', () => {
  describe('AI_RUNTIMES constant', () => {
    it('should contain all valid AI runtimes', () => {
      expect(AI_RUNTIMES).toContain('claude-code');
      expect(AI_RUNTIMES).toContain('gemini-cli');
      expect(AI_RUNTIMES).toContain('codex-cli');
      expect(AI_RUNTIMES).toContain('crewly-agent');
    });

    it('should have exactly 4 runtimes', () => {
      expect(AI_RUNTIMES).toHaveLength(4);
    });
  });

  describe('SETTINGS_CONSTRAINTS constant', () => {
    it('should have sensible minimum values', () => {
      expect(SETTINGS_CONSTRAINTS.MIN_CHECK_IN_INTERVAL).toBe(1);
      expect(SETTINGS_CONSTRAINTS.MIN_MAX_CONCURRENT_AGENTS).toBe(1);
      expect(SETTINGS_CONSTRAINTS.MIN_MAX_MESSAGE_HISTORY).toBe(10);
      expect(SETTINGS_CONSTRAINTS.MIN_SKILL_EXECUTION_TIMEOUT).toBe(1000);
    });
  });

  describe('GeneralSettings interface', () => {
    it('should define all required properties', () => {
      const settings: GeneralSettings = {
        defaultRuntime: 'claude-code',
        autoStartOrchestrator: false,
        autoRecoverHungOrchestrator: true,
        checkInIntervalMinutes: 5,
        maxConcurrentAgents: 10,
        verboseLogging: false,
        autoResumeOnRestart: true,
        announceOnBoot: true,
        runtimeCommands: {
          'claude-code': 'claude --dangerously-skip-permissions',
          'gemini-cli': 'gemini --yolo',
          'codex-cli': 'codex -a never -s danger-full-access',
          'crewly-agent': 'crewly-agent-in-process',
        },
        agentIdleTimeoutMinutes: 10,
        enableProactiveCompact: true,
        enableThresholdCompact: false,
        enableSelfEvolution: false,
        tokenTracking: false,
        enableAuditor: false,
        autonomyTickIntervalMinutes: 5,
      };

      expect(settings.defaultRuntime).toBe('claude-code');
      expect(settings.autoStartOrchestrator).toBe(false);
      expect(settings.checkInIntervalMinutes).toBe(5);
      expect(settings.maxConcurrentAgents).toBe(10);
      expect(settings.verboseLogging).toBe(false);
      expect(settings.autoResumeOnRestart).toBe(true);
      expect(settings.runtimeCommands['claude-code']).toBe('claude --dangerously-skip-permissions');
      expect(settings.agentIdleTimeoutMinutes).toBe(10);
    });

    it('should allow custom runtime commands for all runtimes', () => {
      const settings: GeneralSettings = {
        defaultRuntime: 'claude-code',
        autoStartOrchestrator: true,
        autoRecoverHungOrchestrator: true,
        checkInIntervalMinutes: 10,
        maxConcurrentAgents: 5,
        verboseLogging: true,
        autoResumeOnRestart: false,
        announceOnBoot: true,
        runtimeCommands: {
          'claude-code': '/custom/path/to/claude --dangerously-skip-permissions',
          'gemini-cli': '/custom/gemini --custom-flag',
          'codex-cli': '/custom/codex --custom-flag',
          'crewly-agent': 'crewly-agent-in-process',
        },
        agentIdleTimeoutMinutes: 15,
        enableProactiveCompact: true,
        enableThresholdCompact: false,
        enableSelfEvolution: false,
        tokenTracking: false,
        enableAuditor: false,
        autonomyTickIntervalMinutes: 5,
      };

      expect(settings.runtimeCommands['claude-code']).toContain('/custom/path');
      expect(settings.runtimeCommands['gemini-cli']).toContain('/custom/gemini');
      expect(settings.runtimeCommands['codex-cli']).toContain('/custom/codex');
    });
  });

  describe('ChatSettings interface', () => {
    it('should define all required properties', () => {
      const settings: ChatSettings = {
        showRawTerminalOutput: false,
        enableTypingIndicator: true,
        maxMessageHistory: 1000,
        autoScrollToBottom: true,
        showTimestamps: true,
      };

      expect(settings.showRawTerminalOutput).toBe(false);
      expect(settings.enableTypingIndicator).toBe(true);
      expect(settings.maxMessageHistory).toBe(1000);
      expect(settings.autoScrollToBottom).toBe(true);
      expect(settings.showTimestamps).toBe(true);
    });
  });

  describe('SkillsSettings interface', () => {
    it('should define all required properties', () => {
      const settings: SkillsSettings = {
        skillsDirectory: '/custom/skills',
        enableBrowserAutomation: true,
        enableScriptExecution: true,
        skillExecutionTimeoutMs: 60000,
      };

      expect(settings.skillsDirectory).toBe('/custom/skills');
      expect(settings.enableBrowserAutomation).toBe(true);
      expect(settings.enableScriptExecution).toBe(true);
      expect(settings.skillExecutionTimeoutMs).toBe(60000);
    });
  });

  describe('CrewlySettings interface', () => {
    it('should combine all settings sections', () => {
      const settings: CrewlySettings = {
        general: {
          defaultRuntime: 'claude-code',
          autoStartOrchestrator: false,
          autoRecoverHungOrchestrator: true,
          checkInIntervalMinutes: 5,
          maxConcurrentAgents: 10,
          verboseLogging: false,
          autoResumeOnRestart: true,
          announceOnBoot: true,
          runtimeCommands: {
            'claude-code': 'claude --dangerously-skip-permissions',
            'gemini-cli': 'gemini --yolo',
            'codex-cli': 'codex -a never -s danger-full-access',
            'crewly-agent': 'crewly-agent-in-process',
          },
          agentIdleTimeoutMinutes: 10,
          enableProactiveCompact: true,
          enableThresholdCompact: false,
          enableSelfEvolution: false,
          tokenTracking: false,
          enableAuditor: false,
          autonomyTickIntervalMinutes: 5,
        },
        chat: {
          showRawTerminalOutput: false,
          enableTypingIndicator: true,
          maxMessageHistory: 1000,
          autoScrollToBottom: true,
          showTimestamps: true,
        },
        skills: {
          skillsDirectory: '',
          enableBrowserAutomation: true,
          enableScriptExecution: true,
          skillExecutionTimeoutMs: 60000,
        },
      };

      expect(settings.general).toBeDefined();
      expect(settings.chat).toBeDefined();
      expect(settings.skills).toBeDefined();
      expect(settings.general.runtimeCommands).toBeDefined();
      expect(settings.general.runtimeCommands['claude-code']).toBeDefined();
    });
  });

  describe('UpdateSettingsInput interface', () => {
    it('should allow partial updates', () => {
      const input: UpdateSettingsInput = {
        general: { defaultRuntime: 'gemini-cli' },
      };

      expect(input.general?.defaultRuntime).toBe('gemini-cli');
      expect(input.chat).toBeUndefined();
      expect(input.skills).toBeUndefined();
    });

    it('should allow multiple partial sections', () => {
      const input: UpdateSettingsInput = {
        general: { verboseLogging: true },
        chat: { showTimestamps: false },
      };

      expect(input.general?.verboseLogging).toBe(true);
      expect(input.chat?.showTimestamps).toBe(false);
    });
  });

  describe('SettingsValidationResult interface', () => {
    it('should define valid result', () => {
      const result: SettingsValidationResult = {
        valid: true,
        errors: [],
      };

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should define invalid result with errors', () => {
      const result: SettingsValidationResult = {
        valid: false,
        errors: ['Error 1', 'Error 2'],
      };

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
    });
  });

  describe('isValidAIRuntime', () => {
    it('should return true for valid runtimes', () => {
      expect(isValidAIRuntime('claude-code')).toBe(true);
      expect(isValidAIRuntime('gemini-cli')).toBe(true);
      expect(isValidAIRuntime('codex-cli')).toBe(true);
    });

    it('should return false for invalid runtimes', () => {
      expect(isValidAIRuntime('invalid')).toBe(false);
      expect(isValidAIRuntime('')).toBe(false);
      expect(isValidAIRuntime('Claude-Code')).toBe(false);
      expect(isValidAIRuntime('claude_code')).toBe(false);
    });

    it('should return false for non-string types coerced to string', () => {
      expect(isValidAIRuntime(String(null))).toBe(false);
      expect(isValidAIRuntime(String(undefined))).toBe(false);
      expect(isValidAIRuntime(String(123))).toBe(false);
    });
  });

  describe('getDefaultSettings', () => {
    it('should return complete default settings', () => {
      const defaults = getDefaultSettings();

      expect(defaults.general).toBeDefined();
      expect(defaults.chat).toBeDefined();
      expect(defaults.skills).toBeDefined();
    });

    it('should have sensible general defaults', () => {
      const defaults = getDefaultSettings();

      expect(defaults.general.defaultRuntime).toBe('claude-code');
      expect(defaults.general.autoStartOrchestrator).toBe(true);
      expect(defaults.general.checkInIntervalMinutes).toBe(5);
      expect(defaults.general.maxConcurrentAgents).toBe(10);
      expect(defaults.general.verboseLogging).toBe(false);
      expect(defaults.general.autoResumeOnRestart).toBe(true);
    });

    it('defaults enableProactiveCompact to false to prevent proactive-compact state loss', () => {
      // Per Steve user-position decision (2026-05-04): proactive cumulative-output-bytes
      // compact trigger causes state loss + idle-after-compact issues. Threshold-driven
      // compact at RED (85%) / CRITICAL (95%) is preserved separately. This default
      // disables only the proactive trigger; users can re-enable via settings UI.
      const defaults = getDefaultSettings();
      expect(defaults.general.enableProactiveCompact).toBe(false);
    });

    it('defaults enableThresholdCompact to false so threshold-compact is opt-in', () => {
      // Per spec 2026-05-05-compact-fix-AB-followup §B: threshold-driven compact at
      // RED (85%) / CRITICAL (95%) is gated behind this flag. Default `false` aligns
      // wrapper behavior with Steve's user-position — "Claude Code self-compacts
      // internally, external compact is unnecessary". Auto-recovery (kill+restart)
      // still runs at CRITICAL when AUTO_RECOVERY_ENABLED, regardless of this flag.
      const defaults = getDefaultSettings();
      expect(defaults.general.enableThresholdCompact).toBe(false);
    });

    it('should have runtime commands defaults for all runtimes', () => {
      const defaults = getDefaultSettings();

      expect(defaults.general.runtimeCommands['claude-code']).toBe('claude --dangerously-skip-permissions');
      expect(defaults.general.runtimeCommands['gemini-cli']).toBe('gemini --yolo');
      expect(defaults.general.runtimeCommands['codex-cli']).toBe('codex -a never -s danger-full-access');
    });

    it('defaults crewly-agent to the managed binary, NOT the stale in-process sentinel (issue #693)', () => {
      // The old default 'crewly-agent-in-process' is not a real executable;
      // it shelled out via `sh -lc` and exited 127, so orchestrators using
      // the crewly-agent runtime never started. PR #599 made crewly-agent an
      // external binary — the default must be the real command name.
      const defaults = getDefaultSettings();
      expect(defaults.general.runtimeCommands['crewly-agent']).toBe('crewly-agent');
      expect(defaults.general.runtimeCommands['crewly-agent']).not.toBe('crewly-agent-in-process');
    });

    it('should include non-empty runtime commands for all runtimes', () => {
      const defaults = getDefaultSettings();

      for (const runtime of AI_RUNTIMES) {
        const cmd = defaults.general.runtimeCommands[runtime];
        expect(typeof cmd).toBe('string');
        expect(cmd.length).toBeGreaterThan(0);
      }
    });

    it('should have sensible chat defaults', () => {
      const defaults = getDefaultSettings();

      expect(defaults.chat.showRawTerminalOutput).toBe(false);
      expect(defaults.chat.enableTypingIndicator).toBe(true);
      expect(defaults.chat.maxMessageHistory).toBe(1000);
      expect(defaults.chat.autoScrollToBottom).toBe(true);
      expect(defaults.chat.showTimestamps).toBe(true);
    });

    it('should have sensible skills defaults', () => {
      const defaults = getDefaultSettings();

      expect(defaults.skills.skillsDirectory).toBe('');
      expect(defaults.skills.enableBrowserAutomation).toBe(true);
      expect(defaults.skills.enableScriptExecution).toBe(true);
      expect(defaults.skills.skillExecutionTimeoutMs).toBe(60000);
    });

    it('should return a new object each time', () => {
      const defaults1 = getDefaultSettings();
      const defaults2 = getDefaultSettings();

      expect(defaults1).not.toBe(defaults2);
      expect(defaults1.general).not.toBe(defaults2.general);
    });
  });

  describe('validateSettings', () => {
    it('should validate correct settings', () => {
      const settings = getDefaultSettings();
      const result = validateSettings(settings);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect invalid runtime', () => {
      const settings = getDefaultSettings();
      settings.general.defaultRuntime = 'invalid' as AIRuntime;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('runtime'))).toBe(true);
    });

    it('should detect non-boolean autoResumeOnRestart', () => {
      const settings = getDefaultSettings();
      (settings.general as any).autoResumeOnRestart = 'yes';

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('autoResumeOnRestart'))).toBe(true);
    });

    it('should detect negative checkInIntervalMinutes', () => {
      const settings = getDefaultSettings();
      settings.general.checkInIntervalMinutes = -1;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Check-in interval'))).toBe(true);
    });

    it('should detect zero checkInIntervalMinutes', () => {
      const settings = getDefaultSettings();
      settings.general.checkInIntervalMinutes = 0;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
    });

    it('should detect negative maxConcurrentAgents', () => {
      const settings = getDefaultSettings();
      settings.general.maxConcurrentAgents = 0;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Max concurrent agents'))).toBe(true);
    });

    it('should detect too small maxMessageHistory', () => {
      const settings = getDefaultSettings();
      settings.chat.maxMessageHistory = 5;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Max message history'))).toBe(true);
    });

    it('should detect too small skillExecutionTimeoutMs', () => {
      const settings = getDefaultSettings();
      settings.skills.skillExecutionTimeoutMs = 500;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Skill execution timeout'))).toBe(true);
    });

    it('should detect empty runtime command', () => {
      const settings = getDefaultSettings();
      settings.general.runtimeCommands['gemini-cli'] = '';

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('gemini-cli'))).toBe(true);
    });

    it('should detect whitespace-only runtime command', () => {
      const settings = getDefaultSettings();
      settings.general.runtimeCommands['codex-cli'] = '   ';

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('codex-cli'))).toBe(true);
    });

    it('should collect multiple errors', () => {
      const settings = getDefaultSettings();
      settings.general.defaultRuntime = 'invalid' as AIRuntime;
      settings.general.checkInIntervalMinutes = -1;
      settings.chat.maxMessageHistory = 5;

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it('should accept boundary values', () => {
      const settings = getDefaultSettings();
      settings.general.checkInIntervalMinutes = 1;
      settings.general.maxConcurrentAgents = 1;
      settings.chat.maxMessageHistory = 10;
      settings.skills.skillExecutionTimeoutMs = 1000;

      const result = validateSettings(settings);

      expect(result.valid).toBe(true);
    });

    it('should detect non-boolean enableThresholdCompact', () => {
      // Per spec 2026-05-05-compact-fix-AB-followup §B: validate the new field
      // alongside enableProactiveCompact. Cast to bypass compile-time type check
      // — the runtime validator is the contract.
      const settings = getDefaultSettings();
      (settings.general as unknown as Record<string, unknown>).enableThresholdCompact = 'yes';

      const result = validateSettings(settings);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('enableThresholdCompact'))).toBe(true);
    });
  });

  describe('mergeSettings', () => {
    it('should merge partial updates into existing settings', () => {
      const existing = getDefaultSettings();
      const update: UpdateSettingsInput = {
        general: { defaultRuntime: 'gemini-cli' },
      };

      const merged = mergeSettings(existing, update);

      expect(merged.general.defaultRuntime).toBe('gemini-cli');
      expect(merged.general.autoStartOrchestrator).toBe(existing.general.autoStartOrchestrator);
      expect(merged.chat).toEqual(existing.chat);
    });

    it('should not modify the original settings', () => {
      const existing = getDefaultSettings();
      const originalRuntime = existing.general.defaultRuntime;

      mergeSettings(existing, {
        general: { defaultRuntime: 'gemini-cli' },
      });

      expect(existing.general.defaultRuntime).toBe(originalRuntime);
    });

    it('should merge multiple sections', () => {
      const existing = getDefaultSettings();
      const update: UpdateSettingsInput = {
        general: { verboseLogging: true },
        chat: { showTimestamps: false },
        skills: { enableBrowserAutomation: false },
      };

      const merged = mergeSettings(existing, update);

      expect(merged.general.verboseLogging).toBe(true);
      expect(merged.chat.showTimestamps).toBe(false);
      expect(merged.skills.enableBrowserAutomation).toBe(false);
    });

    it('should handle empty update', () => {
      const existing = getDefaultSettings();
      const update: UpdateSettingsInput = {};

      const merged = mergeSettings(existing, update);

      expect(merged).toEqual(existing);
    });

    it('should handle undefined sections in update', () => {
      const existing = getDefaultSettings();
      const update: UpdateSettingsInput = {
        general: { verboseLogging: true },
        chat: undefined,
        skills: undefined,
      };

      const merged = mergeSettings(existing, update);

      expect(merged.general.verboseLogging).toBe(true);
      expect(merged.chat).toEqual(existing.chat);
      expect(merged.skills).toEqual(existing.skills);
    });

    it('should return a new object', () => {
      const existing = getDefaultSettings();
      const update: UpdateSettingsInput = {};

      const merged = mergeSettings(existing, update);

      expect(merged).not.toBe(existing);
      expect(merged.general).not.toBe(existing.general);
    });

    it('should backfill missing runtimeCommands from defaults', () => {
      // Simulate old settings file missing crewly-agent
      const existing = getDefaultSettings();
      const oldRuntimeCommands = {
        'claude-code': 'claude --dangerously-skip-permissions',
        'gemini-cli': 'gemini --yolo',
        'codex-cli': 'codex -a never -s danger-full-access',
      } as any;
      existing.general.runtimeCommands = oldRuntimeCommands;

      const merged = mergeSettings(existing, {});

      // crewly-agent should be backfilled from defaults (the managed binary,
      // not the stale 'crewly-agent-in-process' sentinel — issue #693).
      expect(merged.general.runtimeCommands['crewly-agent']).toBe('crewly-agent');
      // Existing entries should be preserved
      expect(merged.general.runtimeCommands['claude-code']).toBe('claude --dangerously-skip-permissions');
    });

    it('should allow updates to override runtimeCommands', () => {
      const existing = getDefaultSettings();

      const merged = mergeSettings(existing, {
        general: {
          runtimeCommands: {
            'claude-code': 'custom-claude',
            'gemini-cli': 'custom-gemini',
            'codex-cli': 'custom-codex',
            'crewly-agent': 'custom-agent',
          },
        },
      });

      expect(merged.general.runtimeCommands['claude-code']).toBe('custom-claude');
      expect(merged.general.runtimeCommands['crewly-agent']).toBe('custom-agent');
    });
  });

  describe('hasSettingsUpdates', () => {
    it('should return false for empty input', () => {
      const input: UpdateSettingsInput = {};
      expect(hasSettingsUpdates(input)).toBe(false);
    });

    it('should return false for empty sections', () => {
      const input: UpdateSettingsInput = {
        general: {},
        chat: {},
        skills: {},
      };
      expect(hasSettingsUpdates(input)).toBe(false);
    });

    it('should return true for general updates', () => {
      const input: UpdateSettingsInput = {
        general: { verboseLogging: true },
      };
      expect(hasSettingsUpdates(input)).toBe(true);
    });

    it('should return true for chat updates', () => {
      const input: UpdateSettingsInput = {
        chat: { showTimestamps: false },
      };
      expect(hasSettingsUpdates(input)).toBe(true);
    });

    it('should return true for skills updates', () => {
      const input: UpdateSettingsInput = {
        skills: { enableBrowserAutomation: false },
      };
      expect(hasSettingsUpdates(input)).toBe(true);
    });
  });

  describe('getAIRuntimeDisplayName', () => {
    it('should return correct display names', () => {
      expect(getAIRuntimeDisplayName('claude-code')).toBe('Claude Code');
      expect(getAIRuntimeDisplayName('gemini-cli')).toBe('Gemini CLI');
      expect(getAIRuntimeDisplayName('codex-cli')).toBe('Codex CLI');
    });

    it('should handle unknown runtime gracefully', () => {
      const name = getAIRuntimeDisplayName('unknown' as AIRuntime);
      expect(name).toBe('unknown');
    });
  });

  describe('hasSettingsUpdates - apiKeys', () => {
    it('should return true for apiKeys updates', () => {
      const input: UpdateSettingsInput = {
        apiKeys: { global: { gemini: 'test-key' } },
      };
      expect(hasSettingsUpdates(input)).toBe(true);
    });
  });
});

describe('API Key Management Types', () => {
  describe('API_KEY_PROVIDERS', () => {
    it('should contain all valid providers', () => {
      expect(API_KEY_PROVIDERS).toContain('gemini');
      expect(API_KEY_PROVIDERS).toContain('anthropic');
      expect(API_KEY_PROVIDERS).toContain('openai');
      expect(API_KEY_PROVIDERS).toContain('deepseek');
      expect(API_KEY_PROVIDERS).toHaveLength(4);
    });

    /**
     * B1: DeepSeek must appear in API_KEY_PROVIDERS so that the settings
     * service iterates over it during getApiKey/maskApiKeysSettings/
     * resolveApiKey, exposing the same skill→runtime→global→env chain
     * as the other cloud providers.
     */
    it('should include deepseek for B1 (provider parity in settings UI/resolution)', () => {
      expect(API_KEY_PROVIDERS).toContain('deepseek');
    });
  });

  describe('API_KEY_ENV_VARS', () => {
    it('should map providers to environment variable names', () => {
      expect(API_KEY_ENV_VARS.gemini).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
      expect(API_KEY_ENV_VARS.gemini).toContain('GEMINI_API_KEY');
      expect(API_KEY_ENV_VARS.anthropic).toContain('ANTHROPIC_API_KEY');
      expect(API_KEY_ENV_VARS.openai).toContain('OPENAI_API_KEY');
    });

    /**
     * B1: DeepSeek key fallback env var. Required so resolveApiKey('deepseek', ...)
     * picks up DEEPSEEK_API_KEY when no settings entry is configured — preserves
     * env-var-only flow for users who don't open the Settings UI.
     */
    it('should map deepseek to DEEPSEEK_API_KEY for B1 env-var fallback', () => {
      expect(API_KEY_ENV_VARS.deepseek).toEqual(['DEEPSEEK_API_KEY']);
    });
  });

  describe('isValidApiKeyProvider', () => {
    it('should return true for valid providers', () => {
      expect(isValidApiKeyProvider('gemini')).toBe(true);
      expect(isValidApiKeyProvider('anthropic')).toBe(true);
      expect(isValidApiKeyProvider('openai')).toBe(true);
    });

    it('should return true for deepseek (B1)', () => {
      expect(isValidApiKeyProvider('deepseek')).toBe(true);
    });

    it('should return false for invalid providers', () => {
      expect(isValidApiKeyProvider('invalid')).toBe(false);
      expect(isValidApiKeyProvider('')).toBe(false);
      expect(isValidApiKeyProvider('google')).toBe(false);
    });
  });

  describe('maskApiKey', () => {
    it('should mask keys showing only last 4 chars', () => {
      expect(maskApiKey('sk-1234567890abcdef')).toBe('••••••••cdef');
    });

    it('should handle short keys', () => {
      expect(maskApiKey('abc')).toBe('••••');
      expect(maskApiKey('')).toBe('••••');
    });

    it('should handle exactly 4-char keys', () => {
      expect(maskApiKey('abcd')).toBe('••••');
    });

    it('should handle 5-char keys', () => {
      expect(maskApiKey('abcde')).toBe('••••••••bcde');
    });
  });

  describe('resolveApiKey', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return undefined when no key is configured anywhere', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const result = resolveApiKey('anthropic', undefined);
      expect(result).toBeUndefined();
    });

    it('should fall back to env var when no settings configured', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const result = resolveApiKey('anthropic', undefined);
      expect(result).toBe('env-key');
    });

    it('should use global key over env var', () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const apiKeys: ApiKeysSettings = {
        global: { anthropic: 'global-key' },
      };
      const result = resolveApiKey('anthropic', apiKeys);
      expect(result).toBe('global-key');
    });

    it('should use runtime override over global key', () => {
      const apiKeys: ApiKeysSettings = {
        global: { anthropic: 'global-key' },
        runtimeOverrides: {
          'claude-code': {
            anthropic: { key: 'runtime-key', source: 'custom' },
          },
        },
      };
      const result = resolveApiKey('anthropic', apiKeys, { runtime: 'claude-code' });
      expect(result).toBe('runtime-key');
    });

    it('should fall back to global when runtime override uses global source', () => {
      const apiKeys: ApiKeysSettings = {
        global: { anthropic: 'global-key' },
        runtimeOverrides: {
          'claude-code': {
            anthropic: { key: '', source: 'global' },
          },
        },
      };
      const result = resolveApiKey('anthropic', apiKeys, { runtime: 'claude-code' });
      expect(result).toBe('global-key');
    });

    it('should use skill override over runtime override', () => {
      const apiKeys: ApiKeysSettings = {
        global: { gemini: 'global-key' },
        runtimeOverrides: {
          'gemini-cli': {
            gemini: { key: 'runtime-key', source: 'custom' },
          },
        },
        skillOverrides: {
          'nano-banana': {
            gemini: { key: 'skill-key', source: 'custom' },
          },
        },
      };
      const result = resolveApiKey('gemini', apiKeys, {
        runtime: 'gemini-cli',
        skill: 'nano-banana',
      });
      expect(result).toBe('skill-key');
    });

    it('should check multiple env var names for gemini', () => {
      delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      process.env.GEMINI_API_KEY = 'gemini-env-key';
      const result = resolveApiKey('gemini', { global: {} });
      expect(result).toBe('gemini-env-key');
    });

    it('should prefer GOOGLE_GENERATIVE_AI_API_KEY over GEMINI_API_KEY', () => {
      process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'google-key';
      process.env.GEMINI_API_KEY = 'gemini-key';
      const result = resolveApiKey('gemini', { global: {} });
      expect(result).toBe('google-key');
    });

    // ----- B1: deepseek resolution chain (skill → runtime → global → env) -----

    it('should fall back to DEEPSEEK_API_KEY env var for deepseek when no settings (B1)', () => {
      delete process.env.DEEPSEEK_API_KEY;
      process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
      const result = resolveApiKey('deepseek', undefined);
      expect(result).toBe('env-deepseek-key');
    });

    it('should use global deepseek key over DEEPSEEK_API_KEY env var (B1)', () => {
      process.env.DEEPSEEK_API_KEY = 'env-deepseek-key';
      const apiKeys: ApiKeysSettings = {
        global: { deepseek: 'global-deepseek-key' },
      };
      const result = resolveApiKey('deepseek', apiKeys);
      expect(result).toBe('global-deepseek-key');
    });

    it('should use runtime override deepseek key over global (B1)', () => {
      const apiKeys: ApiKeysSettings = {
        global: { deepseek: 'global-deepseek-key' },
        runtimeOverrides: {
          'crewly-agent': {
            deepseek: { key: 'runtime-deepseek-key', source: 'custom' },
          },
        },
      };
      const result = resolveApiKey('deepseek', apiKeys, { runtime: 'crewly-agent' });
      expect(result).toBe('runtime-deepseek-key');
    });

    it('should use skill override deepseek key over runtime override (B1)', () => {
      const apiKeys: ApiKeysSettings = {
        global: { deepseek: 'global-deepseek-key' },
        runtimeOverrides: {
          'crewly-agent': {
            deepseek: { key: 'runtime-deepseek-key', source: 'custom' },
          },
        },
        skillOverrides: {
          'reasoning-task': {
            deepseek: { key: 'skill-deepseek-key', source: 'custom' },
          },
        },
      };
      const result = resolveApiKey('deepseek', apiKeys, {
        runtime: 'crewly-agent',
        skill: 'reasoning-task',
      });
      expect(result).toBe('skill-deepseek-key');
    });

    it('should return undefined when no deepseek key configured anywhere (B1)', () => {
      delete process.env.DEEPSEEK_API_KEY;
      const result = resolveApiKey('deepseek', undefined);
      expect(result).toBeUndefined();
    });
  });

  describe('maskApiKeysSettings', () => {
    it('should mask all global keys', () => {
      const apiKeys: ApiKeysSettings = {
        global: {
          gemini: 'sk-gemini-1234567890',
          anthropic: 'sk-ant-1234567890',
        },
      };
      const masked = maskApiKeysSettings(apiKeys);
      expect(masked.global.gemini).toBe('••••••••7890');
      expect(masked.global.anthropic).toBe('••••••••7890');
      expect(masked.global.openai).toBeUndefined();
    });

    it('should mask runtime override keys', () => {
      const apiKeys: ApiKeysSettings = {
        global: {},
        runtimeOverrides: {
          'claude-code': {
            anthropic: { key: 'sk-ant-secret-key-12', source: 'custom' },
          },
        },
      };
      const masked = maskApiKeysSettings(apiKeys);
      expect(masked.runtimeOverrides!['claude-code'].anthropic!.key).toBe('••••••••y-12');
      expect(masked.runtimeOverrides!['claude-code'].anthropic!.source).toBe('custom');
    });

    it('should mask skill override keys', () => {
      const apiKeys: ApiKeysSettings = {
        global: {},
        skillOverrides: {
          'nano-banana': {
            openai: { key: 'sk-openai-key-abcd', source: 'custom' },
          },
        },
      };
      const masked = maskApiKeysSettings(apiKeys);
      expect(masked.skillOverrides!['nano-banana'].openai!.key).toBe('••••••••abcd');
    });

    it('should handle empty settings', () => {
      const apiKeys: ApiKeysSettings = { global: {} };
      const masked = maskApiKeysSettings(apiKeys);
      expect(masked.global).toEqual({});
    });
  });

  describe('getDefaultSettings - apiKeys', () => {
    it('should include apiKeys defaults', () => {
      const defaults = getDefaultSettings();
      expect(defaults.apiKeys).toBeDefined();
      expect(defaults.apiKeys!.global).toEqual({});
      expect(defaults.apiKeys!.runtimeOverrides).toEqual({});
      expect(defaults.apiKeys!.skillOverrides).toEqual({});
    });
  });

  describe('mergeSettings - apiKeys', () => {
    it('should merge apiKeys global updates', () => {
      const existing = getDefaultSettings();
      const updates: UpdateSettingsInput = {
        apiKeys: { global: { gemini: 'new-key' } },
      };
      const merged = mergeSettings(existing, updates);
      expect(merged.apiKeys!.global.gemini).toBe('new-key');
    });

    it('should preserve existing apiKeys when not updated', () => {
      const existing = getDefaultSettings();
      existing.apiKeys = {
        global: { gemini: 'existing-key' },
        runtimeOverrides: {},
        skillOverrides: {},
      };
      const merged = mergeSettings(existing, { general: { verboseLogging: true } });
      expect(merged.apiKeys!.global.gemini).toBe('existing-key');
    });

    it('should merge runtime overrides', () => {
      const existing = getDefaultSettings();
      existing.apiKeys = {
        global: { gemini: 'global-key' },
        runtimeOverrides: {
          'claude-code': { anthropic: { key: 'cc-key', source: 'custom' } },
        },
        skillOverrides: {},
      };
      const updates: UpdateSettingsInput = {
        apiKeys: {
          runtimeOverrides: {
            'gemini-cli': { gemini: { key: 'gc-key', source: 'custom' } },
          },
        },
      };
      const merged = mergeSettings(existing, updates);
      // New override should be present
      expect(merged.apiKeys!.runtimeOverrides!['gemini-cli']).toBeDefined();
      // Note: shallow merge means existing claude-code override is replaced
      // This is consistent with other settings sections
    });
  });
});
