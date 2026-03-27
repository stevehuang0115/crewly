/**
 * Tests for Chat Sanitizer Service
 *
 * Validates sensitive content detection and masking for JWT tokens,
 * file paths, API keys, and other secrets.
 *
 * @module services/chat/chat-sanitizer.service.test
 */

import { sanitizeText, sanitizeMessage, sanitizeMessages } from './chat-sanitizer.service.js';
import type { SanitizeResult } from './chat-sanitizer.service.js';

describe('ChatSanitizerService', () => {
  // ===========================================================================
  // sanitizeText
  // ===========================================================================

  describe('sanitizeText', () => {
    it('should return original text when no sensitive content found', () => {
      const result = sanitizeText('Hello, this is a normal message.');
      expect(result.sanitized).toBe('Hello, this is a normal message.');
      expect(result.wasMasked).toBe(false);
      expect(result.matchedPatterns).toEqual([]);
    });

    it('should handle empty string', () => {
      const result = sanitizeText('');
      expect(result.sanitized).toBe('');
      expect(result.wasMasked).toBe(false);
    });

    it('should handle null/undefined gracefully', () => {
      const result = sanitizeText(null as unknown as string);
      expect(result.wasMasked).toBe(false);
    });

    // --- JWT Tokens ---

    it('should mask JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = sanitizeText(`Bearer ${jwt}`);
      expect(result.sanitized).not.toContain('eyJ');
      expect(result.wasMasked).toBe(true);
      expect(result.matchedPatterns).toContain('jwt');
    });

    it('should mask JWT embedded in text', () => {
      const result = sanitizeText('Auth token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U end');
      expect(result.sanitized).toContain('Auth token:');
      expect(result.sanitized).toContain('end');
      expect(result.sanitized).not.toContain('eyJ');
    });

    // --- API Keys ---

    it('should mask OpenAI/Anthropic sk- keys', () => {
      const result = sanitizeText('API key: sk-proj-abc123def456ghi789jkl012mno345pqr678');
      expect(result.sanitized).not.toContain('sk-proj-');
      expect(result.wasMasked).toBe(true);
      expect(result.matchedPatterns).toContain('openai_key');
    });

    it('should mask GitHub PATs (ghp_)', () => {
      const result = sanitizeText('Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl');
      expect(result.sanitized).not.toContain('ghp_');
      expect(result.matchedPatterns).toContain('github_pat');
    });

    it('should mask GitHub fine-grained PATs (github_pat_)', () => {
      const result = sanitizeText('github_pat_11AAAAAAA0123456789012345678901234567890');
      expect(result.sanitized).not.toContain('github_pat_');
      expect(result.matchedPatterns).toContain('github_pat_fine');
    });

    it('should mask GitHub OAuth tokens (gho_)', () => {
      const result = sanitizeText('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl');
      expect(result.sanitized).not.toContain('gho_');
      expect(result.matchedPatterns).toContain('github_oauth');
    });

    it('should mask AWS access keys', () => {
      const result = sanitizeText('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
      expect(result.sanitized).not.toContain('AKIA');
      expect(result.matchedPatterns).toContain('aws_key');
    });

    it('should mask Slack tokens', () => {
      // Use a clearly-fake token that won't trigger GitHub Push Protection
      const fakeToken = ['xoxb', '000000000000', '0000000000000', 'FakeTestTokenValue00000'].join('-');
      const result = sanitizeText(fakeToken);
      expect(result.sanitized).not.toContain('xoxb-');
      expect(result.matchedPatterns).toContain('slack_token');
    });

    it('should mask Bearer authorization headers', () => {
      const result = sanitizeText('Authorization: Bearer eyABCDEFGHIJKLMNOPQRST.token.here1234');
      expect(result.sanitized).not.toContain('eyABCDEFGHIJKLMNOPQRST');
      expect(result.wasMasked).toBe(true);
    });

    // --- File Paths ---

    it('should mask Unix /Users/ paths', () => {
      const result = sanitizeText('File at /Users/testuser/Desktop/projects/crewly');
      expect(result.sanitized).not.toContain('/Users/testuser');
      expect(result.sanitized).toContain('File at');
      expect(result.matchedPatterns).toContain('unix_path');
    });

    it('should mask Unix /home/ paths', () => {
      const result = sanitizeText('Config: /home/ubuntu/.config/crewly/settings.json');
      expect(result.sanitized).not.toContain('/home/ubuntu');
      expect(result.matchedPatterns).toContain('unix_path');
    });

    it('should mask Windows paths', () => {
      const result = sanitizeText('Located at C:\\Users\\admin\\Documents\\project');
      expect(result.sanitized).not.toContain('C:\\Users\\admin');
      expect(result.matchedPatterns).toContain('windows_path');
    });

    // --- Multiple patterns ---

    it('should mask multiple different sensitive items in one string', () => {
      const text = 'Path /Users/dev/project, key sk-abcdefghijklmnopqrstuvwxyz1234567890';
      const result = sanitizeText(text);
      expect(result.sanitized).not.toContain('/Users/dev');
      expect(result.sanitized).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
      expect(result.matchedPatterns.length).toBeGreaterThanOrEqual(2);
    });

    it('should not mask safe content that resembles patterns', () => {
      // Short "sk-" that doesn't meet minimum length (< 20 chars after sk-)
      const result = sanitizeText('Use sk-short as prefix');
      expect(result.sanitized).toBe('Use sk-short as prefix');
      expect(result.wasMasked).toBe(false);
    });
  });

  // ===========================================================================
  // sanitizeMessage
  // ===========================================================================

  describe('sanitizeMessage', () => {
    it('should sanitize message content', () => {
      const msg = {
        content: 'Deployed to /Users/deploy/app with key sk-abcdefghijklmnopqrstuvwxyz1234567890',
        metadata: {},
      };
      const clean = sanitizeMessage(msg);
      expect(clean.content).not.toContain('/Users/deploy');
      expect(clean.content).not.toContain('sk-abcdef');
    });

    it('should not mutate the original message', () => {
      const original = {
        content: 'Key: sk-abcdefghijklmnopqrstuvwxyz1234567890',
        metadata: { rawOutput: '/Users/test/path' },
      };
      const originalContent = original.content;
      sanitizeMessage(original);
      expect(original.content).toBe(originalContent);
    });

    it('should sanitize metadata.rawOutput', () => {
      const msg = {
        content: 'Clean content',
        metadata: {
          rawOutput: 'Output with /Users/dev/secret/path inside',
          otherField: 'safe',
        },
      };
      const clean = sanitizeMessage(msg);
      expect(clean.metadata?.rawOutput).not.toContain('/Users/dev');
      expect(clean.metadata?.otherField).toBe('safe');
    });

    it('should handle message without metadata', () => {
      const msg = { content: 'Hello world' };
      const clean = sanitizeMessage(msg);
      expect(clean.content).toBe('Hello world');
    });

    it('should preserve all other message fields', () => {
      const msg = {
        id: 'msg-1',
        content: 'Safe content',
        timestamp: '2026-03-26T00:00:00Z',
        from: { type: 'user' as const, name: 'You' },
        metadata: { source: 'web' },
      };
      const clean = sanitizeMessage(msg);
      expect(clean.id).toBe('msg-1');
      expect(clean.timestamp).toBe('2026-03-26T00:00:00Z');
      expect(clean.from).toEqual({ type: 'user', name: 'You' });
    });
  });

  // ===========================================================================
  // sanitizeMessages
  // ===========================================================================

  describe('sanitizeMessages', () => {
    it('should sanitize all messages in array', () => {
      const messages = [
        { content: 'Key: sk-abcdefghijklmnopqrstuvwxyz1234567890', metadata: {} },
        { content: 'Path: /Users/admin/secrets', metadata: {} },
        { content: 'Safe message', metadata: {} },
      ];
      const clean = sanitizeMessages(messages);
      expect(clean).toHaveLength(3);
      expect(clean[0].content).not.toContain('sk-');
      expect(clean[1].content).not.toContain('/Users/admin');
      expect(clean[2].content).toBe('Safe message');
    });

    it('should handle empty array', () => {
      const clean = sanitizeMessages([]);
      expect(clean).toEqual([]);
    });

    it('should not mutate original array', () => {
      const originals = [
        { content: 'sk-abcdefghijklmnopqrstuvwxyz1234567890' },
      ];
      const originalContent = originals[0].content;
      sanitizeMessages(originals);
      expect(originals[0].content).toBe(originalContent);
    });
  });
});
