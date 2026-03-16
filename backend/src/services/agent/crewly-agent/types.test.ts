import { describe, it, expect } from '@jest/globals';
import {
  isModelProvider,
  isModelConfig,
  MODEL_PROVIDERS,
  CREWLY_AGENT_DEFAULTS,
  WRITE_TOOLS,
  MODEL_CONTEXT_WINDOWS,
} from './types.js';
import type {
  ToolDefinition,
  ToolSensitivity,
  AuditEntry,
  SecurityPolicy,
  CompactionResult,
  ContextBudgetStatus,
  ToolCallbacks,
  ApprovalCheckResult,
  AuditLogFilters,
  AgentRunResult,
} from './types.js';

describe('Crewly Agent Types', () => {
  describe('MODEL_PROVIDERS', () => {
    it('should contain all supported providers', () => {
      expect(MODEL_PROVIDERS).toContain('anthropic');
      expect(MODEL_PROVIDERS).toContain('openai');
      expect(MODEL_PROVIDERS).toContain('google');
      expect(MODEL_PROVIDERS).toContain('ollama');
      expect(MODEL_PROVIDERS).toHaveLength(4);
    });
  });

  describe('CREWLY_AGENT_DEFAULTS', () => {
    it('should have sensible default values', () => {
      expect(CREWLY_AGENT_DEFAULTS.MAX_STEPS).toBe(30);
      expect(CREWLY_AGENT_DEFAULTS.API_BASE_URL).toBe('http://localhost:8787');
      expect(CREWLY_AGENT_DEFAULTS.MAX_HISTORY_MESSAGES).toBe(100);
      expect(CREWLY_AGENT_DEFAULTS.COMPACTION_THRESHOLD).toBe(0.8);
      expect(CREWLY_AGENT_DEFAULTS.API_TIMEOUT_MS).toBe(30000);
    });

    it('should have a valid default model config', () => {
      expect(CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.provider).toBe('google');
      expect(CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.modelId).toBeTruthy();
      expect(typeof CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.temperature).toBe('number');
      expect(typeof CREWLY_AGENT_DEFAULTS.DEFAULT_MODEL.maxTokens).toBe('number');
    });

    it('should have a valid default security policy', () => {
      const policy = CREWLY_AGENT_DEFAULTS.SECURITY_POLICY;
      expect(policy.auditEnabled).toBe(true);
      expect(policy.requireApproval).toEqual([]);
      expect(policy.blockedTools).toEqual([]);
      expect(policy.maxAuditEntries).toBe(500);
      expect(policy.readOnlyMode).toBe(false);
    });
  });

  describe('isModelProvider', () => {
    it('should return true for valid providers', () => {
      expect(isModelProvider('anthropic')).toBe(true);
      expect(isModelProvider('openai')).toBe(true);
      expect(isModelProvider('google')).toBe(true);
      expect(isModelProvider('ollama')).toBe(true);
    });

    it('should return false for invalid providers', () => {
      expect(isModelProvider('azure')).toBe(false);
      expect(isModelProvider('')).toBe(false);
      expect(isModelProvider('ANTHROPIC')).toBe(false);
    });
  });

  describe('isModelConfig', () => {
    it('should return true for valid configs', () => {
      expect(isModelConfig({ provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' })).toBe(true);
      expect(isModelConfig({ provider: 'openai', modelId: 'gpt-4o', temperature: 0.5 })).toBe(true);
      expect(isModelConfig({ provider: 'google', modelId: 'gemini-2.0-flash', maxTokens: 4096 })).toBe(true);
      expect(isModelConfig({ provider: 'ollama', modelId: 'llama3.3:70b' })).toBe(true);
    });

    it('should return false for invalid configs', () => {
      expect(isModelConfig(null)).toBe(false);
      expect(isModelConfig(undefined)).toBe(false);
      expect(isModelConfig(42)).toBe(false);
      expect(isModelConfig('string')).toBe(false);
      expect(isModelConfig({})).toBe(false);
      expect(isModelConfig({ provider: 'anthropic' })).toBe(false);
      expect(isModelConfig({ modelId: 'gpt-4o' })).toBe(false);
      expect(isModelConfig({ provider: 'invalid', modelId: 'test' })).toBe(false);
      expect(isModelConfig({ provider: 'anthropic', modelId: '' })).toBe(false);
    });
  });

  describe('ToolDefinition', () => {
    it('should be usable as a type for tool objects', () => {
      const tool: ToolDefinition = {
        description: 'A test tool',
        inputSchema: { parse: () => ({}) } as any,
        execute: async () => ({ result: 'ok' }),
      };
      expect(tool.description).toBe('A test tool');
      expect(typeof tool.execute).toBe('function');
    });

    it('should support optional sensitivity field', () => {
      const tool: ToolDefinition = {
        description: 'A sensitive tool',
        inputSchema: { parse: () => ({}) } as any,
        execute: async () => ({ result: 'ok' }),
        sensitivity: 'destructive',
      };
      expect(tool.sensitivity).toBe('destructive');
    });
  });

  describe('ToolSensitivity', () => {
    it('should accept valid sensitivity values', () => {
      const safe: ToolSensitivity = 'safe';
      const sensitive: ToolSensitivity = 'sensitive';
      const destructive: ToolSensitivity = 'destructive';
      expect(safe).toBe('safe');
      expect(sensitive).toBe('sensitive');
      expect(destructive).toBe('destructive');
    });
  });

  describe('AuditEntry', () => {
    it('should be constructible with required fields', () => {
      const entry: AuditEntry = {
        timestamp: '2026-03-12T00:00:00.000Z',
        toolName: 'edit_file',
        sensitivity: 'destructive',
        args: { file_path: '/test.ts' },
        success: true,
        durationMs: 42,
      };
      expect(entry.toolName).toBe('edit_file');
      expect(entry.sensitivity).toBe('destructive');
      expect(entry.error).toBeUndefined();
      expect(entry.sessionName).toBeUndefined();
    });

    it('should support optional error field', () => {
      const entry: AuditEntry = {
        timestamp: '2026-03-12T00:00:00.000Z',
        toolName: 'write_file',
        sensitivity: 'destructive',
        args: {},
        success: false,
        error: 'EACCES',
        durationMs: 5,
      };
      expect(entry.error).toBe('EACCES');
    });

    it('should support optional sessionName field', () => {
      const entry: AuditEntry = {
        timestamp: '2026-03-12T00:00:00.000Z',
        sessionName: 'agent-session-abc',
        toolName: 'delegate_task',
        sensitivity: 'sensitive',
        args: {},
        success: true,
        durationMs: 100,
      };
      expect(entry.sessionName).toBe('agent-session-abc');
    });
  });

  describe('SecurityPolicy', () => {
    it('should be constructible with all fields', () => {
      const policy: SecurityPolicy = {
        auditEnabled: true,
        requireApproval: ['destructive'],
        blockedTools: ['stop_agent'],
        maxAuditEntries: 100,
        readOnlyMode: false,
      };
      expect(policy.auditEnabled).toBe(true);
      expect(policy.requireApproval).toContain('destructive');
      expect(policy.blockedTools).toContain('stop_agent');
      expect(policy.readOnlyMode).toBe(false);
    });

    it('should support readOnlyMode', () => {
      const policy: SecurityPolicy = {
        auditEnabled: true,
        requireApproval: [],
        blockedTools: [],
        maxAuditEntries: 500,
        readOnlyMode: true,
      };
      expect(policy.readOnlyMode).toBe(true);
    });
  });

  describe('CompactionResult', () => {
    it('should represent a successful compaction', () => {
      const result: CompactionResult = {
        compacted: true,
        messagesBefore: 50,
        messagesAfter: 11,
      };
      expect(result.compacted).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should represent a skipped compaction with reason', () => {
      const result: CompactionResult = {
        compacted: false,
        messagesBefore: 5,
        messagesAfter: 5,
        reason: 'Too few messages to compact',
      };
      expect(result.compacted).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  });

  describe('ToolCallbacks', () => {
    it('should be constructible with optional fields', () => {
      const callbacks: ToolCallbacks = {};
      expect(callbacks.onCompactMemory).toBeUndefined();
      expect(callbacks.onAuditLog).toBeUndefined();
      expect(callbacks.onCheckApproval).toBeUndefined();
      expect(callbacks.onGetAuditLog).toBeUndefined();
    });

    it('should accept callback functions', () => {
      const callbacks: ToolCallbacks = {
        onCompactMemory: async () => ({ compacted: true, messagesBefore: 50, messagesAfter: 11 }),
        onAuditLog: () => {},
        onCheckApproval: () => ({ allowed: true }),
        onGetAuditLog: () => [],
      };
      expect(typeof callbacks.onCompactMemory).toBe('function');
      expect(typeof callbacks.onAuditLog).toBe('function');
      expect(typeof callbacks.onCheckApproval).toBe('function');
      expect(typeof callbacks.onGetAuditLog).toBe('function');
    });
  });

  describe('ApprovalCheckResult', () => {
    it('should represent an allowed result', () => {
      const result: ApprovalCheckResult = { allowed: true };
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.blocked).toBeUndefined();
    });

    it('should represent a blocked tool', () => {
      const result: ApprovalCheckResult = {
        allowed: false,
        blocked: true,
        reason: 'Tool is blocked by security policy',
      };
      expect(result.allowed).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.reason).toBeTruthy();
    });

    it('should represent a tool requiring approval', () => {
      const result: ApprovalCheckResult = {
        allowed: false,
        blocked: false,
        reason: 'Tool requires approval for destructive operations',
      };
      expect(result.allowed).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.reason).toContain('approval');
    });
  });

  describe('AuditLogFilters', () => {
    it('should be constructible with required limit', () => {
      const filters: AuditLogFilters = { limit: 50 };
      expect(filters.limit).toBe(50);
      expect(filters.sensitivity).toBeUndefined();
      expect(filters.toolName).toBeUndefined();
    });

    it('should support optional filters', () => {
      const filters: AuditLogFilters = {
        limit: 10,
        sensitivity: 'destructive',
        toolName: 'edit_file',
      };
      expect(filters.sensitivity).toBe('destructive');
      expect(filters.toolName).toBe('edit_file');
    });
  });

  describe('WRITE_TOOLS', () => {
    it('should be a non-empty readonly array', () => {
      expect(WRITE_TOOLS.length).toBeGreaterThan(0);
      expect(Array.isArray(WRITE_TOOLS)).toBe(true);
    });

    it('should contain all file-modifying tools', () => {
      expect(WRITE_TOOLS).toContain('edit_file');
      expect(WRITE_TOOLS).toContain('write_file');
    });

    it('should contain agent lifecycle tools', () => {
      expect(WRITE_TOOLS).toContain('start_agent');
      expect(WRITE_TOOLS).toContain('stop_agent');
      expect(WRITE_TOOLS).toContain('handle_agent_failure');
    });

    it('should not contain read-only tools', () => {
      expect(WRITE_TOOLS).not.toContain('read_file');
      expect(WRITE_TOOLS).not.toContain('get_team_status');
      expect(WRITE_TOOLS).not.toContain('recall_memory');
    });
  });

  describe('MODEL_CONTEXT_WINDOWS', () => {
    it('should have a default entry', () => {
      expect(MODEL_CONTEXT_WINDOWS.default).toBeDefined();
      expect(MODEL_CONTEXT_WINDOWS.default).toBeGreaterThan(0);
    });

    it('should include known Anthropic models', () => {
      expect(MODEL_CONTEXT_WINDOWS['claude-opus-4-20250514']).toBe(200_000);
      expect(MODEL_CONTEXT_WINDOWS['claude-sonnet-4-20250514']).toBe(200_000);
    });

    it('should include known Google models', () => {
      expect(MODEL_CONTEXT_WINDOWS['gemini-2.0-flash']).toBe(1_000_000);
    });

    it('should include known OpenAI models', () => {
      expect(MODEL_CONTEXT_WINDOWS['gpt-4o']).toBe(128_000);
    });
  });

  describe('ContextBudgetStatus type', () => {
    it('should accept valid normal status', () => {
      const status: ContextBudgetStatus = {
        totalTokensUsed: 5000,
        contextWindowSize: 200000,
        usagePercent: 0.025,
        level: 'normal',
        messageCount: 10,
        compactionPending: false,
        summary: '2.5% of context budget used',
      };
      expect(status.level).toBe('normal');
      expect(status.compactionPending).toBe(false);
    });

    it('should accept valid critical status', () => {
      const status: ContextBudgetStatus = {
        totalTokensUsed: 180000,
        contextWindowSize: 200000,
        usagePercent: 0.9,
        level: 'critical',
        messageCount: 95,
        compactionPending: true,
        summary: '90.0% — CRITICAL',
      };
      expect(status.level).toBe('critical');
      expect(status.compactionPending).toBe(true);
    });
  });

  describe('AgentRunResult budgetWarning', () => {
    it('should accept result with budgetWarning', () => {
      const result: AgentRunResult = {
        text: 'Done',
        steps: 1,
        usage: { input: 100, output: 50 },
        toolCalls: [],
        finishReason: 'stop',
        budgetWarning: 'WARNING: approaching compaction threshold',
      };
      expect(result.budgetWarning).toContain('WARNING');
    });

    it('should accept result without budgetWarning', () => {
      const result: AgentRunResult = {
        text: 'Done',
        steps: 1,
        usage: { input: 100, output: 50 },
        toolCalls: [],
        finishReason: 'stop',
      };
      expect(result.budgetWarning).toBeUndefined();
    });
  });

  describe('ToolCallbacks onGetContextBudget', () => {
    it('should accept callbacks with onGetContextBudget', () => {
      const callbacks: ToolCallbacks = {
        onGetContextBudget: () => ({
          totalTokensUsed: 0,
          contextWindowSize: 200000,
          usagePercent: 0,
          level: 'normal',
          messageCount: 0,
          compactionPending: false,
          summary: '0%',
        }),
      };
      expect(callbacks.onGetContextBudget).toBeDefined();
      const result = callbacks.onGetContextBudget!();
      expect(result.level).toBe('normal');
    });
  });
});
