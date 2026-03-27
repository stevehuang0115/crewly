/**
 * Tests for OutputFilterService — API Key Redaction.
 */
import { describe, it, expect } from '@jest/globals';
import {
  OutputFilterService,
  REDACTION_PLACEHOLDER,
  API_KEY_PATTERNS,
  type ScanResult,
} from './output-filter.service.js';

describe('OutputFilterService', () => {
  const filter = new OutputFilterService();

  // ── OpenAI Keys ────────────────────────────────────────────────────────

  describe('OpenAI key detection', () => {
    it('redacts sk- keys (standard format)', () => {
      const text = 'Use this key: sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx234';
      const result = filter.redact(text);
      expect(result).toContain(REDACTION_PLACEHOLDER);
      expect(result).not.toContain('sk-proj-abc123');
    });

    it('redacts sk- keys in JSON output', () => {
      const text = '{"apiKey": "sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefghij"}';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain('OpenAI API Key');
    });
  });

  // ── Anthropic Keys ─────────────────────────────────────────────────────

  describe('Anthropic key detection', () => {
    it('redacts sk-ant- keys', () => {
      const text = 'ANTHROPIC_API_KEY=sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890';
      const result = filter.redact(text);
      expect(result).toContain(REDACTION_PLACEHOLDER);
      expect(result).not.toContain('sk-ant-api03');
    });
  });

  // ── Google Keys ────────────────────────────────────────────────────────

  describe('Google key detection', () => {
    it('redacts AIza keys', () => {
      const text = 'Google key: AIzaSyDAbCdEfGhIjKlMnOpQrStUvWxYz012345';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain('Google API Key');
      expect(result.redactedText).not.toContain('AIzaSy');
    });
  });

  // ── AWS Keys ───────────────────────────────────────────────────────────

  describe('AWS key detection', () => {
    it('redacts AKIA access keys', () => {
      const text = 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain('AWS Access Key');
    });
  });

  // ── GitHub Tokens ──────────────────────────────────────────────────────

  describe('GitHub token detection', () => {
    it('redacts ghp_ personal access tokens', () => {
      const text = 'Token: ghp_ABCDEFghijklmnopqrstuvwxyz0123456789';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain('GitHub Token');
    });

    it('redacts ghs_ server tokens', () => {
      const text = 'ghs_ABCDEFghijklmnopqrstuvwxyz0123456789';
      expect(filter.containsKeys(text)).toBe(true);
    });
  });

  // ── Stripe Keys ────────────────────────────────────────────────────────

  describe('Stripe key detection', () => {
    it('redacts sk_live_ keys', () => {
      // Construct token dynamically to avoid GitHub Push Protection false positive
      const text = 'stripe_key: ' + ['sk', 'live', 'abc123def456ghi789jkl012mno345'].join('_');
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain('Stripe API Key');
    });

    it('redacts sk_test_ keys', () => {
      const text = ['sk', 'test', 'abcdefghijklmnopqrst'].join('_');
      expect(filter.containsKeys(text)).toBe(true);
    });
  });

  // ── Generic Secrets ────────────────────────────────────────────────────

  describe('generic secret detection', () => {
    it('redacts api_key=value patterns', () => {
      const text = 'api_key=MySuper5ecretKey1234567890';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.redactedText).not.toContain('MySuper5ecret');
    });

    it('redacts secret_key: value patterns', () => {
      const text = 'secret_key: "abcdefghijklmnop1234"';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
    });

    it('redacts auth_token=value patterns', () => {
      const text = 'auth_token=MyAuthTokenValue1234567890';
      expect(filter.containsKeys(text)).toBe(true);
    });
  });

  // ── Environment Variable Secrets ───────────────────────────────────────

  describe('environment variable secret detection', () => {
    it('redacts OPENAI_API_KEY=value', () => {
      const text = 'export OPENAI_API_KEY=sk-proj-abcdef1234567890abcdef';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
    });

    it('redacts ANTHROPIC_API_KEY=value', () => {
      const text = 'ANTHROPIC_API_KEY=sk-ant-api03-secret123456789';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
    });

    it('redacts DATABASE_URL=value', () => {
      const text = 'DATABASE_URL=postgresql://user:password@host:5432/db';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
    });
  });

  // ── No False Positives ─────────────────────────────────────────────────

  describe('no false positives', () => {
    it('does not redact normal text', () => {
      const text = 'Hello world, this is a normal message with no keys.';
      const result = filter.scan(text);
      expect(result.detected).toBe(false);
      expect(result.redactedText).toBe(text);
    });

    it('does not redact short tokens', () => {
      const text = 'key=abc';
      const result = filter.scan(text);
      expect(result.detected).toBe(false);
    });

    it('does not redact code variable names', () => {
      const text = 'const apiKey = getApiKey();';
      const result = filter.scan(text);
      expect(result.detected).toBe(false);
    });

    it('does not redact empty string', () => {
      const result = filter.scan('');
      expect(result.detected).toBe(false);
      expect(result.redactedText).toBe('');
    });
  });

  // ── Multiple Keys ──────────────────────────────────────────────────────

  describe('multiple key detection', () => {
    it('redacts multiple keys in one string', () => {
      const text = 'OpenAI: sk-abcdefghijklmnopqrstuvwxyz1234567890abcdefghij, AWS: AKIAIOSFODNN7EXAMPLE';
      const result = filter.scan(text);
      expect(result.detected).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(2);
      expect(result.redactedText).not.toContain('sk-abcdef');
      expect(result.redactedText).not.toContain('AKIAIOSFODNN7');
    });
  });

  // ── scan() result shape ────────────────────────────────────────────────

  describe('scan result shape', () => {
    it('returns correct ScanResult structure', () => {
      const result = filter.scan('key: sk-abcdefghijklmnopqrstuvwxyz123456');
      expect(result).toHaveProperty('detected');
      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('matchedPatterns');
      expect(result).toHaveProperty('redactedText');
      expect(typeof result.detected).toBe('boolean');
      expect(typeof result.count).toBe('number');
      expect(Array.isArray(result.matchedPatterns)).toBe(true);
    });
  });

  // ── containsKeys() ────────────────────────────────────────────────────

  describe('containsKeys', () => {
    it('returns true when keys present', () => {
      expect(filter.containsKeys('sk-abcdefghijklmnopqrstuvwxyz12345678')).toBe(true);
    });

    it('returns false for clean text', () => {
      expect(filter.containsKeys('just normal text')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(filter.containsKeys('')).toBe(false);
    });
  });

  // ── redactObject() ────────────────────────────────────────────────────

  describe('redactObject', () => {
    it('redacts strings in flat objects', () => {
      const obj = { key: 'sk-abcdefghijklmnopqrstuvwxyz123456', name: 'safe' };
      const result = filter.redactObject(obj) as Record<string, string>;
      expect(result.key).toContain(REDACTION_PLACEHOLDER);
      expect(result.name).toBe('safe');
    });

    it('redacts strings in nested objects', () => {
      const obj = { config: { token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' } };
      const result = filter.redactObject(obj) as Record<string, Record<string, string>>;
      expect(result.config.token).toContain(REDACTION_PLACEHOLDER);
    });

    it('redacts strings in arrays', () => {
      const arr = ['normal', 'AKIAIOSFODNN7EXAMPLE'];
      const result = filter.redactObject(arr) as string[];
      expect(result[0]).toBe('normal');
      expect(result[1]).toContain(REDACTION_PLACEHOLDER);
    });

    it('passes through non-string values unchanged', () => {
      expect(filter.redactObject(42)).toBe(42);
      expect(filter.redactObject(null)).toBeNull();
      expect(filter.redactObject(true)).toBe(true);
    });
  });

  // ── Custom Patterns ────────────────────────────────────────────────────

  describe('custom patterns', () => {
    it('detects custom patterns when provided', () => {
      const custom = new OutputFilterService([
        { pattern: /\bCUSTOM-[A-Z]{20,}/g, label: 'Custom Key' },
      ]);
      const text = 'key: CUSTOM-ABCDEFGHIJKLMNOPQRST';
      const result = custom.scan(text);
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain('Custom Key');
    });
  });

  // ── API_KEY_PATTERNS export ────────────────────────────────────────────

  describe('API_KEY_PATTERNS', () => {
    it('exports non-empty patterns array', () => {
      expect(API_KEY_PATTERNS.length).toBeGreaterThan(0);
    });

    it('all patterns have label and pattern', () => {
      for (const p of API_KEY_PATTERNS) {
        expect(p.pattern).toBeInstanceOf(RegExp);
        expect(typeof p.label).toBe('string');
        expect(p.label.length).toBeGreaterThan(0);
      }
    });
  });
});
