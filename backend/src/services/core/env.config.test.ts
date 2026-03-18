/**
 * Tests for Unified Environment Configuration Loader
 *
 * @module services/core/env.config.test
 */

import {
  getEnvConfig,
  resetEnvConfig,
  validateEnvConfig,
  logEnvValidation,
  type EnvConfig,
} from './env.config.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('EnvConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resetEnvConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetEnvConfig();
  });

  // ----- getEnvConfig() ----------------------------------------------------

  describe('getEnvConfig()', () => {
    it('should return default values when no env vars are set', () => {
      // Clear relevant env vars
      delete process.env.PORT;
      delete process.env.HOST;
      delete process.env.CREWLY_SUPABASE_URL;
      delete process.env.CREWLY_SUPABASE_ANON_KEY;
      delete process.env.CREWLY_JWT_SECRET;
      delete process.env.CREWLY_CLOUD_URL;

      const config = getEnvConfig();

      expect(config.server.port).toBe(3000);
      expect(config.server.host).toBe('localhost');
      expect(config.supabase.url).toContain('supabase.co');
      expect(config.supabase.anonKey).toBeTruthy();
      expect(config.auth.jwtSecret).toBe('crewly-dev-jwt-secret-change-in-production');
      expect(config.cloud.apiUrl).toBe('https://cloud.crewly.dev');
    });

    it('should read PORT from environment', () => {
      process.env.PORT = '4000';

      const config = getEnvConfig();

      expect(config.server.port).toBe(4000);
    });

    it('should read Supabase config from environment', () => {
      process.env.CREWLY_SUPABASE_URL = 'https://custom.supabase.co';
      process.env.CREWLY_SUPABASE_ANON_KEY = 'custom-anon-key';

      const config = getEnvConfig();

      expect(config.supabase.url).toBe('https://custom.supabase.co');
      expect(config.supabase.anonKey).toBe('custom-anon-key');
    });

    it('should read auth secrets from environment', () => {
      process.env.CREWLY_JWT_SECRET = 'my-strong-secret';
      process.env.CREWLY_TOKEN_ENCRYPTION_KEY = 'my-encryption-key';

      const config = getEnvConfig();

      expect(config.auth.jwtSecret).toBe('my-strong-secret');
      expect(config.auth.tokenEncryptionKey).toBe('my-encryption-key');
    });

    it('should fall back to CREWLY_SECRET when CREWLY_TOKEN_ENCRYPTION_KEY is not set', () => {
      delete process.env.CREWLY_TOKEN_ENCRYPTION_KEY;
      process.env.CREWLY_SECRET = 'fallback-secret';

      const config = getEnvConfig();

      expect(config.auth.tokenEncryptionKey).toBe('fallback-secret');
    });

    it('should read Slack config from environment', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'sign-secret';

      const config = getEnvConfig();

      expect(config.slack.botToken).toBe('xoxb-test');
      expect(config.slack.appToken).toBe('xapp-test');
      expect(config.slack.signingSecret).toBe('sign-secret');
    });

    it('should read Google OAuth config from environment', () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'goog-id';
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'goog-secret';

      const config = getEnvConfig();

      expect(config.google.clientId).toBe('goog-id');
      expect(config.google.clientSecret).toBe('goog-secret');
    });

    it('should read WhatsApp config from environment', () => {
      process.env.WHATSAPP_ENABLED = 'true';
      process.env.WHATSAPP_PHONE_NUMBER = '+1234567890';

      const config = getEnvConfig();

      expect(config.whatsapp.enabled).toBe(true);
      expect(config.whatsapp.phoneNumber).toBe('+1234567890');
    });

    it('should default WhatsApp enabled to false', () => {
      delete process.env.WHATSAPP_ENABLED;

      const config = getEnvConfig();

      expect(config.whatsapp.enabled).toBe(false);
    });

    it('should read cloud config from environment', () => {
      process.env.CREWLY_CLOUD_URL = 'https://custom-cloud.dev';
      process.env.CREWLY_HOME = '/custom/.crewly';
      process.env.CREWLY_API_URL = 'http://localhost:9999';

      const config = getEnvConfig();

      expect(config.cloud.apiUrl).toBe('https://custom-cloud.dev');
      expect(config.cloud.crewlyHome).toBe('/custom/.crewly');
      expect(config.cloud.crewlyApiUrl).toBe('http://localhost:9999');
    });

    it('should read Gemini API key from environment', () => {
      process.env.GEMINI_API_KEY = 'test-gemini-key';

      const config = getEnvConfig();

      expect(config.ai.geminiApiKey).toBe('test-gemini-key');
    });

    it('should cache config on repeated calls', () => {
      process.env.PORT = '5000';
      const config1 = getEnvConfig();

      process.env.PORT = '6000';
      const config2 = getEnvConfig();

      // Should still be cached value
      expect(config1).toBe(config2);
      expect(config2.server.port).toBe(5000);
    });

    it('should return fresh config after resetEnvConfig()', () => {
      process.env.PORT = '5000';
      const config1 = getEnvConfig();

      resetEnvConfig();
      process.env.PORT = '6000';
      const config2 = getEnvConfig();

      expect(config1.server.port).toBe(5000);
      expect(config2.server.port).toBe(6000);
    });

    it('should handle invalid numeric env var gracefully', () => {
      process.env.PORT = 'not-a-number';

      const config = getEnvConfig();

      expect(config.server.port).toBe(3000); // Falls back to default
    });
  });

  // ----- validateEnvConfig() -----------------------------------------------

  describe('validateEnvConfig()', () => {
    it('should pass validation with defaults in development', () => {
      delete process.env.NODE_ENV;
      delete process.env.CREWLY_JWT_SECRET;

      const result = validateEnvConfig();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should warn about default JWT secret in development', () => {
      delete process.env.NODE_ENV;
      delete process.env.CREWLY_JWT_SECRET;

      const result = validateEnvConfig();

      expect(result.warnings).toContainEqual(
        expect.stringContaining('CREWLY_JWT_SECRET'),
      );
    });

    it('should warn (not error) on default JWT secret in production', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.CREWLY_JWT_SECRET;

      const result = validateEnvConfig();

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('CREWLY_JWT_SECRET'),
      );
    });

    it('should warn (not error) on missing encryption key in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.CREWLY_JWT_SECRET = 'prod-secret';
      delete process.env.CREWLY_TOKEN_ENCRYPTION_KEY;
      delete process.env.CREWLY_SECRET;

      const result = validateEnvConfig();

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('CREWLY_TOKEN_ENCRYPTION_KEY'),
      );
    });

    it('should pass when production secrets are properly set', () => {
      process.env.NODE_ENV = 'production';
      process.env.CREWLY_JWT_SECRET = 'prod-secret';
      process.env.CREWLY_TOKEN_ENCRYPTION_KEY = 'prod-enc-key';

      const result = validateEnvConfig();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should error on invalid port', () => {
      process.env.PORT = '99999';

      const result = validateEnvConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringContaining('PORT'),
      );
    });

    it('should warn when Slack is partially configured', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      delete process.env.SLACK_APP_TOKEN;
      delete process.env.SLACK_SIGNING_SECRET;

      const result = validateEnvConfig();

      expect(result.warnings).toContainEqual(
        expect.stringContaining('Slack'),
      );
    });

    it('should not warn when all Slack vars are set', () => {
      process.env.SLACK_BOT_TOKEN = 'xoxb-test';
      process.env.SLACK_APP_TOKEN = 'xapp-test';
      process.env.SLACK_SIGNING_SECRET = 'secret';

      const result = validateEnvConfig();

      const slackWarnings = result.warnings.filter(w => w.includes('Slack'));
      expect(slackWarnings).toHaveLength(0);
    });

    it('should warn when Google OAuth is partially configured', () => {
      process.env.GOOGLE_OAUTH_CLIENT_ID = 'goog-id';
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

      const result = validateEnvConfig();

      expect(result.warnings).toContainEqual(
        expect.stringContaining('Google OAuth'),
      );
    });

    it('should fall back to default when Supabase URL is set to empty string', () => {
      process.env.CREWLY_SUPABASE_URL = '';

      const config = getEnvConfig();
      const result = validateEnvConfig();

      // Empty string triggers || fallback to default
      expect(config.supabase.url).toContain('supabase.co');
      expect(result.valid).toBe(true);
    });

    it('should warn about dev Supabase URL in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.CREWLY_JWT_SECRET = 'prod-secret';
      process.env.CREWLY_TOKEN_ENCRYPTION_KEY = 'prod-key';
      // Don't set CREWLY_SUPABASE_URL — will use default dev URL

      const result = validateEnvConfig();

      expect(result.warnings).toContainEqual(
        expect.stringContaining('CREWLY_SUPABASE_URL'),
      );
    });
  });

  // ----- logEnvValidation() ------------------------------------------------

  describe('logEnvValidation()', () => {
    it('should log warnings to console.warn', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      logEnvValidation({
        valid: true,
        errors: [],
        warnings: ['Test warning'],
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test warning'),
      );
      warnSpy.mockRestore();
    });

    it('should log errors to console.error', () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();

      logEnvValidation({
        valid: false,
        errors: ['Test error'],
        warnings: [],
      });

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Test error'),
      );
      errorSpy.mockRestore();
    });

    it('should not log when everything is valid with no warnings', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();

      logEnvValidation({
        valid: true,
        errors: [],
        warnings: [],
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  // ----- Type completeness -------------------------------------------------

  describe('config structure', () => {
    it('should have all expected top-level sections', () => {
      const config = getEnvConfig();

      expect(config).toHaveProperty('server');
      expect(config).toHaveProperty('supabase');
      expect(config).toHaveProperty('auth');
      expect(config).toHaveProperty('slack');
      expect(config).toHaveProperty('google');
      expect(config).toHaveProperty('whatsapp');
      expect(config).toHaveProperty('ai');
      expect(config).toHaveProperty('cloud');
    });

    it('should have correct server fields', () => {
      const { server } = getEnvConfig();

      expect(typeof server.port).toBe('number');
      expect(typeof server.host).toBe('string');
      expect(typeof server.nodeEnv).toBe('string');
    });

    it('should have correct supabase fields', () => {
      const { supabase } = getEnvConfig();

      expect(typeof supabase.url).toBe('string');
      expect(typeof supabase.anonKey).toBe('string');
    });
  });
});
