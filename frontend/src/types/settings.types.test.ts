/**
 * Tests for Settings Types
 *
 * @module types/settings.types.test
 */

import { describe, it, expect } from 'vitest';
import {
  AI_RUNTIMES,
  AI_RUNTIME_DISPLAY_NAMES,
  API_KEY_PROVIDERS,
  ApiKeyProvider,
  getAIRuntimeDisplayName,
  isValidAIRuntime,
} from './settings.types';

describe('Settings Types', () => {
  describe('AI_RUNTIMES', () => {
    it('should contain all supported runtimes', () => {
      expect(AI_RUNTIMES).toContain('claude-code');
      expect(AI_RUNTIMES).toContain('gemini-cli');
      expect(AI_RUNTIMES).toContain('codex-cli');
      expect(AI_RUNTIMES).toContain('crewly-agent');
    });

    it('should have exactly 4 runtimes', () => {
      expect(AI_RUNTIMES).toHaveLength(4);
    });
  });

  describe('AI_RUNTIME_DISPLAY_NAMES', () => {
    it('should have display names for all runtimes', () => {
      expect(AI_RUNTIME_DISPLAY_NAMES['claude-code']).toBe('Claude Code');
      expect(AI_RUNTIME_DISPLAY_NAMES['gemini-cli']).toBe('Gemini CLI');
      expect(AI_RUNTIME_DISPLAY_NAMES['codex-cli']).toBe('Codex CLI');
      expect(AI_RUNTIME_DISPLAY_NAMES['crewly-agent']).toBe('Crewly Agent');
    });
  });

  describe('getAIRuntimeDisplayName', () => {
    it('should return display name for claude-code', () => {
      expect(getAIRuntimeDisplayName('claude-code')).toBe('Claude Code');
    });

    it('should return display name for gemini-cli', () => {
      expect(getAIRuntimeDisplayName('gemini-cli')).toBe('Gemini CLI');
    });

    it('should return display name for codex-cli', () => {
      expect(getAIRuntimeDisplayName('codex-cli')).toBe('Codex CLI');
    });

    it('should return display name for crewly-agent', () => {
      expect(getAIRuntimeDisplayName('crewly-agent')).toBe('Crewly Agent');
    });
  });

  describe('isValidAIRuntime', () => {
    it('should return true for valid runtimes', () => {
      expect(isValidAIRuntime('claude-code')).toBe(true);
      expect(isValidAIRuntime('gemini-cli')).toBe(true);
      expect(isValidAIRuntime('codex-cli')).toBe(true);
      expect(isValidAIRuntime('crewly-agent')).toBe(true);
    });

    it('should return false for invalid runtimes', () => {
      expect(isValidAIRuntime('invalid')).toBe(false);
      expect(isValidAIRuntime('')).toBe(false);
      expect(isValidAIRuntime('claude')).toBe(false);
      expect(isValidAIRuntime('CLAUDE-CODE')).toBe(false);
    });
  });

  describe('API_KEY_PROVIDERS', () => {
    it('should contain all supported API key providers', () => {
      expect(API_KEY_PROVIDERS).toContain('gemini');
      expect(API_KEY_PROVIDERS).toContain('anthropic');
      expect(API_KEY_PROVIDERS).toContain('openai');
      expect(API_KEY_PROVIDERS).toContain('deepseek');
    });

    it('should have exactly 4 providers (mirrors backend ApiKeyProvider union)', () => {
      expect(API_KEY_PROVIDERS).toHaveLength(4);
    });

    it('should match the backend provider order so UI rows render consistently', () => {
      // Order is part of the contract — UI iterates this array to render
      // global key inputs and per-runtime override inputs.
      expect([...API_KEY_PROVIDERS]).toEqual(['gemini', 'anthropic', 'openai', 'deepseek']);
    });

    it('should accept deepseek as a valid ApiKeyProvider value', () => {
      // Compile-time check: assignment fails if the union excludes 'deepseek'.
      const provider: ApiKeyProvider = 'deepseek';
      expect(API_KEY_PROVIDERS).toContain(provider);
    });
  });
});
