/**
 * Tests for EnvIsolationService.
 */
import { describe, it, expect } from '@jest/globals';
import {
  EnvIsolationService,
  SAFE_ENV_ALLOWLIST,
  SENSITIVE_ENV_PATTERNS,
} from './env-isolation.service.js';

describe('EnvIsolationService', () => {
  const service = new EnvIsolationService();

  // ── createSafeEnv ──────────────────────────────────────────────────────

  describe('createSafeEnv', () => {
    it('keeps allowlisted variables', () => {
      const env = { PATH: '/usr/bin', HOME: '/home/user', NODE_ENV: 'production' };
      const safe = service.createSafeEnv(env);
      expect(safe.PATH).toBe('/usr/bin');
      expect(safe.HOME).toBe('/home/user');
      expect(safe.NODE_ENV).toBe('production');
    });

    it('strips API key variables', () => {
      const env = {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-secret',
        OPENAI_API_KEY: 'sk-secret',
        GOOGLE_API_KEY: 'AIza-secret',
      };
      const safe = service.createSafeEnv(env);
      expect(safe.PATH).toBe('/usr/bin');
      expect(safe.ANTHROPIC_API_KEY).toBeUndefined();
      expect(safe.OPENAI_API_KEY).toBeUndefined();
      expect(safe.GOOGLE_API_KEY).toBeUndefined();
    });

    it('strips AWS secret keys', () => {
      const env = {
        HOME: '/home',
        AWS_SECRET_ACCESS_KEY: 'secret123',
        AWS_SESSION_TOKEN: 'token456',
      };
      const safe = service.createSafeEnv(env);
      expect(safe.HOME).toBe('/home');
      expect(safe.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(safe.AWS_SESSION_TOKEN).toBeUndefined();
    });

    it('strips database URLs', () => {
      const env = {
        PATH: '/usr/bin',
        DATABASE_URL: 'postgresql://user:pass@host/db',
        REDIS_URL: 'redis://host:6379',
        MONGODB_URI: 'mongodb://host/db',
      };
      const safe = service.createSafeEnv(env);
      expect(safe.DATABASE_URL).toBeUndefined();
      expect(safe.REDIS_URL).toBeUndefined();
      expect(safe.MONGODB_URI).toBeUndefined();
    });

    it('strips token variables', () => {
      const env = {
        GITHUB_TOKEN: 'ghp_abc123',
        NPM_TOKEN: 'npm_tok',
        SLACK_BOT_TOKEN: 'xoxb-123',
        DISCORD_TOKEN: 'disc_tok',
      };
      const safe = service.createSafeEnv(env);
      expect(safe.GITHUB_TOKEN).toBeUndefined();
      expect(safe.NPM_TOKEN).toBeUndefined();
      expect(safe.SLACK_BOT_TOKEN).toBeUndefined();
      expect(safe.DISCORD_TOKEN).toBeUndefined();
    });

    it('strips generic secret/password patterns', () => {
      const env = {
        MY_API_KEY: 'secret',
        SERVICE_PASSWORD: 'p@ss',
        AUTH_TOKEN: 'tok',
        MY_SECRET_KEY: 'shh',
        APP_CREDENTIAL: 'cred',
      };
      const safe = service.createSafeEnv(env);
      expect(safe.MY_API_KEY).toBeUndefined();
      expect(safe.SERVICE_PASSWORD).toBeUndefined();
      expect(safe.AUTH_TOKEN).toBeUndefined();
      expect(safe.MY_SECRET_KEY).toBeUndefined();
      expect(safe.APP_CREDENTIAL).toBeUndefined();
    });

    it('keeps non-sensitive custom variables', () => {
      const env = {
        PATH: '/usr/bin',
        MY_APP_CONFIG: 'value',
        DEBUG: 'true',
        PORT: '3000',
      };
      const safe = service.createSafeEnv(env);
      expect(safe.MY_APP_CONFIG).toBe('value');
      expect(safe.DEBUG).toBe('true');
      expect(safe.PORT).toBe('3000');
    });

    it('skips undefined values', () => {
      const env = { PATH: '/usr/bin', MISSING: undefined };
      const safe = service.createSafeEnv(env);
      expect(safe.PATH).toBe('/usr/bin');
      expect('MISSING' in safe).toBe(false);
    });

    it('includes explicitly requested vars even if sensitive', () => {
      const env = {
        ANTHROPIC_API_KEY: 'needed-for-this-run',
        PATH: '/usr/bin',
      };
      const safe = service.createSafeEnv(env, ['ANTHROPIC_API_KEY']);
      expect(safe.ANTHROPIC_API_KEY).toBe('needed-for-this-run');
      expect(safe.PATH).toBe('/usr/bin');
    });

    it('handles empty env', () => {
      const safe = service.createSafeEnv({});
      expect(Object.keys(safe)).toHaveLength(0);
    });
  });

  // ── isSensitive ────────────────────────────────────────────────────────

  describe('isSensitive', () => {
    it('returns true for ANTHROPIC_API_KEY', () => {
      expect(service.isSensitive('ANTHROPIC_API_KEY')).toBe(true);
    });

    it('returns true for OPENAI_API_KEY', () => {
      expect(service.isSensitive('OPENAI_API_KEY')).toBe(true);
    });

    it('returns true for DATABASE_URL', () => {
      expect(service.isSensitive('DATABASE_URL')).toBe(true);
    });

    it('returns true for generic PASSWORD vars', () => {
      expect(service.isSensitive('DB_PASSWORD')).toBe(true);
      expect(service.isSensitive('ADMIN_PASSWORD')).toBe(true);
    });

    it('returns true for generic API_TOKEN vars', () => {
      expect(service.isSensitive('MY_API_TOKEN')).toBe(true);
    });

    it('returns false for PATH', () => {
      expect(service.isSensitive('PATH')).toBe(false);
    });

    it('returns false for NODE_ENV', () => {
      expect(service.isSensitive('NODE_ENV')).toBe(false);
    });

    it('returns false for arbitrary non-sensitive vars', () => {
      expect(service.isSensitive('DEBUG')).toBe(false);
      expect(service.isSensitive('PORT')).toBe(false);
      expect(service.isSensitive('LOG_LEVEL')).toBe(false);
    });
  });

  // ── findSensitiveVars ──────────────────────────────────────────────────

  describe('findSensitiveVars', () => {
    it('finds sensitive vars in env', () => {
      const env = {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'secret',
        DATABASE_URL: 'pg://host/db',
        DEBUG: 'true',
      };
      const sensitive = service.findSensitiveVars(env);
      expect(sensitive).toContain('ANTHROPIC_API_KEY');
      expect(sensitive).toContain('DATABASE_URL');
      expect(sensitive).not.toContain('PATH');
      expect(sensitive).not.toContain('DEBUG');
    });

    it('returns empty array for clean env', () => {
      const env = { PATH: '/usr/bin', HOME: '/home' };
      expect(service.findSensitiveVars(env)).toHaveLength(0);
    });
  });

  // ── getAllowlist ───────────────────────────────────────────────────────

  describe('getAllowlist', () => {
    it('returns array of allowlisted vars', () => {
      const list = service.getAllowlist();
      expect(list).toContain('PATH');
      expect(list).toContain('HOME');
      expect(list).toContain('NODE_ENV');
    });
  });

  // ── Custom configuration ──────────────────────────────────────────────

  describe('custom configuration', () => {
    it('adds custom safe vars to allowlist', () => {
      const custom = new EnvIsolationService(['MY_SAFE_VAR']);
      expect(custom.getAllowlist()).toContain('MY_SAFE_VAR');
    });

    it('adds custom sensitive patterns', () => {
      const custom = new EnvIsolationService([], [/^CUSTOM_SECRET/i]);
      expect(custom.isSensitive('CUSTOM_SECRET_VALUE')).toBe(true);
    });
  });

  // ── Exported constants ─────────────────────────────────────────────────

  describe('SAFE_ENV_ALLOWLIST', () => {
    it('includes essential system vars', () => {
      expect(SAFE_ENV_ALLOWLIST).toContain('PATH');
      expect(SAFE_ENV_ALLOWLIST).toContain('HOME');
      expect(SAFE_ENV_ALLOWLIST).toContain('USER');
      expect(SAFE_ENV_ALLOWLIST).toContain('SHELL');
      expect(SAFE_ENV_ALLOWLIST).toContain('NODE_ENV');
    });
  });

  describe('SENSITIVE_ENV_PATTERNS', () => {
    it('has patterns for major providers', () => {
      expect(SENSITIVE_ENV_PATTERNS.length).toBeGreaterThan(10);
      // Check that at least the major providers are covered
      const labels = SENSITIVE_ENV_PATTERNS.map(p => p.source);
      expect(labels.some(l => l.includes('ANTHROPIC'))).toBe(true);
      expect(labels.some(l => l.includes('OPENAI'))).toBe(true);
    });
  });
});
