/**
 * Tests for RuntimeTokenParser Service
 *
 * @module services/monitoring/runtime-token-parser.service.test
 */

import {
  parseClaudeCodeTokens,
  parseGeminiCliTokens,
  parseCodexCliTokens,
  parseRuntimeTokens,
} from './runtime-token-parser.service.js';

describe('RuntimeTokenParser', () => {
  describe('parseClaudeCodeTokens', () => {
    it('should parse "X input / Y output tokens" format', () => {
      const output = 'Total: 15,234 input / 3,456 output tokens';
      const result = parseClaudeCodeTokens(output);
      expect(result).toEqual({
        inputTokens: 15234,
        outputTokens: 3456,
        runtime: 'claude-code',
      });
    });

    it('should parse "X input, Y output" format', () => {
      const output = '8500 input, 2100 output tokens used';
      const result = parseClaudeCodeTokens(output);
      expect(result).toEqual({
        inputTokens: 8500,
        outputTokens: 2100,
        runtime: 'claude-code',
      });
    });

    it('should parse cost alongside token summary', () => {
      const output = 'Total: 15,234 input / 3,456 output tokens\nTotal cost: $0.05';
      const result = parseClaudeCodeTokens(output);
      expect(result).toEqual({
        inputTokens: 15234,
        outputTokens: 3456,
        cost: 0.05,
        runtime: 'claude-code',
      });
    });

    it('should parse arrow notation "↑ X ↓ Y"', () => {
      const output = '↑ 12000 ↓ 4500';
      const result = parseClaudeCodeTokens(output);
      expect(result).toEqual({
        inputTokens: 12000,
        outputTokens: 4500,
        runtime: 'claude-code',
      });
    });

    it('should parse arrow notation "X↑ Y↓"', () => {
      const output = '12000↑ 4500↓';
      const result = parseClaudeCodeTokens(output);
      expect(result).toEqual({
        inputTokens: 12000,
        outputTokens: 4500,
        runtime: 'claude-code',
      });
    });

    it('should parse compact "tokens: X in, Y out" format', () => {
      const output = 'tokens: 5000 in, 1500 out';
      const result = parseClaudeCodeTokens(output);
      expect(result).toEqual({
        inputTokens: 5000,
        outputTokens: 1500,
        runtime: 'claude-code',
      });
    });

    it('should return null for unrelated output', () => {
      const output = 'Hello, how can I help you today?';
      expect(parseClaudeCodeTokens(output)).toBeNull();
    });

    it('should return null for empty input', () => {
      expect(parseClaudeCodeTokens('')).toBeNull();
    });
  });

  describe('parseGeminiCliTokens', () => {
    it('should parse "Input tokens: X, Output tokens: Y" format', () => {
      const output = 'Input tokens: 1234, Output tokens: 456';
      const result = parseGeminiCliTokens(output);
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 456,
        runtime: 'gemini-cli',
      });
    });

    it('should parse "Input: X tokens, Output: Y tokens" format', () => {
      const output = 'Cost for this turn: $0.0012 (Input: 1,234 tokens, Output: 456 tokens)';
      const result = parseGeminiCliTokens(output);
      expect(result).toEqual({
        inputTokens: 1234,
        outputTokens: 456,
        cost: 0.0012,
        runtime: 'gemini-cli',
      });
    });

    it('should parse "prompt_tokens: X, completion_tokens: Y" format', () => {
      const output = 'prompt_tokens: 5000, completion_tokens: 1200';
      const result = parseGeminiCliTokens(output);
      expect(result).toEqual({
        inputTokens: 5000,
        outputTokens: 1200,
        runtime: 'gemini-cli',
      });
    });

    it('should parse "Tokens used: X input, Y output" format', () => {
      const output = 'Tokens used: 3000 input, 800 output';
      const result = parseGeminiCliTokens(output);
      expect(result).toEqual({
        inputTokens: 3000,
        outputTokens: 800,
        runtime: 'gemini-cli',
      });
    });

    it('should return null for unrelated output', () => {
      expect(parseGeminiCliTokens('Gemini is ready')).toBeNull();
    });
  });

  describe('parseCodexCliTokens', () => {
    it('should parse "X prompt + Y completion" format', () => {
      const output = 'Tokens: 2000 prompt + 600 completion = 2600 total';
      const result = parseCodexCliTokens(output);
      expect(result).toEqual({
        inputTokens: 2000,
        outputTokens: 600,
        runtime: 'codex-cli',
      });
    });

    it('should parse "prompt_tokens=X completion_tokens=Y" format', () => {
      const output = 'prompt_tokens=3500 completion_tokens=900';
      const result = parseCodexCliTokens(output);
      expect(result).toEqual({
        inputTokens: 3500,
        outputTokens: 900,
        runtime: 'codex-cli',
      });
    });

    it('should parse "Usage: X input, Y output" format', () => {
      const output = 'Usage: 4000 input, 1200 output';
      const result = parseCodexCliTokens(output);
      expect(result).toEqual({
        inputTokens: 4000,
        outputTokens: 1200,
        runtime: 'codex-cli',
      });
    });

    it('should return null for unrelated output', () => {
      expect(parseCodexCliTokens('Codex is ready')).toBeNull();
    });
  });

  describe('parseRuntimeTokens', () => {
    it('should parse Claude output with runtime hint', () => {
      const output = '15000 input / 3000 output tokens';
      const result = parseRuntimeTokens(output, 'claude-code');
      expect(result).not.toBeNull();
      expect(result!.runtime).toBe('claude-code');
      expect(result!.inputTokens).toBe(15000);
    });

    it('should parse Gemini output with runtime hint', () => {
      const output = 'Input tokens: 5000, Output tokens: 1000';
      const result = parseRuntimeTokens(output, 'gemini-cli');
      expect(result).not.toBeNull();
      expect(result!.runtime).toBe('gemini-cli');
    });

    it('should parse Codex output with runtime hint', () => {
      const output = '2000 prompt + 500 completion';
      const result = parseRuntimeTokens(output, 'codex-cli');
      expect(result).not.toBeNull();
      expect(result!.runtime).toBe('codex-cli');
    });

    it('should try all parsers without a hint', () => {
      const output = '10000 input / 2000 output tokens';
      const result = parseRuntimeTokens(output);
      expect(result).not.toBeNull();
      expect(result!.inputTokens).toBe(10000);
    });

    it('should return null for empty string', () => {
      expect(parseRuntimeTokens('')).toBeNull();
    });

    it('should return null for whitespace-only string', () => {
      expect(parseRuntimeTokens('   \n  ')).toBeNull();
    });

    it('should return null when no parser matches', () => {
      expect(parseRuntimeTokens('Hello world', 'claude-code')).toBeNull();
    });
  });
});
