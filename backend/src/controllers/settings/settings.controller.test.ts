/**
 * Tests for Settings Controller
 *
 * @module controllers/settings/settings.controller.test
 */

// Jest globals are available automatically
import request from 'supertest';
import express, { Express, Request, Response, NextFunction, Router } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { SettingsService, SettingsValidationError, resetSettingsService } from '../../services/settings/settings.service.js';
import { getDefaultSettings, UpdateSettingsInput, CrewlySettings, maskApiKeysSettings } from '../../types/settings.types.js';
import settingsRouter from './settings.controller.js';
import { agentAuthHeaders, callerIdentityForTests, ownerAuthHeaders } from '../../middleware/caller-identity.testing.js';

const VALID_SECTIONS: (keyof CrewlySettings)[] = ['general', 'chat', 'skills', 'apiKeys'];

/**
 * Create a settings controller router with a specific service.
 * Includes API key masking on GET to match production behavior.
 */
function createSettingsControllerWithService(service: SettingsService): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const settings = await service.getSettings();
      const safeSettings = { ...settings };
      if (safeSettings.apiKeys) {
        safeSettings.apiKeys = maskApiKeysSettings(safeSettings.apiKeys);
      }
      res.json({ success: true, data: safeSettings });
    } catch (error) { next(error); }
  });

  router.put('/', async (req, res, next) => {
    try {
      const input: UpdateSettingsInput = req.body;
      const settings = await service.updateSettings(input);
      res.json({ success: true, data: settings });
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return res.status(400).json({ success: false, error: error.message, validationErrors: error.errors });
      }
      next(error);
    }
  });

  router.post('/validate', async (req, res, next) => {
    try {
      const input: UpdateSettingsInput = req.body;
      const result = await service.validateSettingsInput(input);
      res.json({ success: true, data: result });
    } catch (error) { next(error); }
  });

  router.post('/reset', async (_req, res, next) => {
    try {
      const settings = await service.resetSettings();
      res.json({ success: true, data: settings, message: 'Settings reset to defaults' });
    } catch (error) { next(error); }
  });

  router.post('/reset/:section', async (req, res, next) => {
    try {
      const section = req.params.section as keyof CrewlySettings;
      if (!VALID_SECTIONS.includes(section)) {
        return res.status(400).json({ success: false, error: `Invalid section. Must be one of: ${VALID_SECTIONS.join(', ')}` });
      }
      const settings = await service.resetSection(section);
      res.json({ success: true, data: settings, message: `${section} settings reset to defaults` });
    } catch (error) { next(error); }
  });

  router.post('/export', async (_req, res, next) => {
    try {
      const settings = await service.getSettings();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=crewly-settings.json');
      res.json(settings);
    } catch (error) { next(error); }
  });

  router.post('/import', async (req, res, next) => {
    try {
      const importedSettings = req.body;
      if (!importedSettings || typeof importedSettings !== 'object' || Array.isArray(importedSettings)) {
        return res.status(400).json({ success: false, error: 'Invalid settings format' });
      }
      const validation = await service.validateSettingsInput(importedSettings);
      if (!validation.valid) {
        return res.status(400).json({ success: false, error: 'Invalid settings', validationErrors: validation.errors });
      }
      const settings = await service.updateSettings(importedSettings);
      res.json({ success: true, data: settings, message: 'Settings imported successfully' });
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return res.status(400).json({ success: false, error: error.message, validationErrors: error.errors });
      }
      next(error);
    }
  });

  return router;
}

describe('Settings Controller', () => {
  let app: Express;
  let testDir: string;
  let settingsService: SettingsService;

  beforeEach(async () => {
    // Create temporary directory for testing
    testDir = path.join(os.tmpdir(), `settings-controller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create settings service with test directory
    settingsService = new SettingsService({ settingsDir: testDir });

    // Create Express app with injected service
    app = express();
    app.use(express.json());
    app.use('/api/settings', createSettingsControllerWithService(settingsService));

    // Error handler
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ success: false, error: err.message });
    });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    resetSettingsService();
  });

  describe('GET /api/settings', () => {
    it('should return current settings', async () => {
      const response = await request(app).get('/api/settings');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveProperty('general');
      expect(response.body.data).toHaveProperty('chat');
      expect(response.body.data).toHaveProperty('skills');
    });

    it('should return default settings when no file exists', async () => {
      const response = await request(app).get('/api/settings');
      const defaults = getDefaultSettings();

      expect(response.status).toBe(200);
      expect(response.body.data.general.defaultRuntime).toBe(defaults.general.defaultRuntime);
    });
  });

  describe('PUT /api/settings', () => {
    it('should update settings', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          general: { defaultRuntime: 'gemini-cli' },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.general.defaultRuntime).toBe('gemini-cli');
    });

    it('should update multiple sections', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          general: { verboseLogging: true },
          chat: { showTimestamps: false },
        });

      expect(response.status).toBe(200);
      expect(response.body.data.general.verboseLogging).toBe(true);
      expect(response.body.data.chat.showTimestamps).toBe(false);
    });

    it('should return 400 for invalid settings', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          general: { checkInIntervalMinutes: -5 },
        });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.validationErrors).toBeDefined();
    });

    it('should persist settings', async () => {
      await request(app)
        .put('/api/settings')
        .send({
          general: { verboseLogging: true },
        });

      // Clear cache and fetch again
      settingsService.clearCache();
      const response = await request(app).get('/api/settings');

      expect(response.body.data.general.verboseLogging).toBe(true);
    });
  });

  describe('POST /api/settings/validate', () => {
    it('should validate valid settings', async () => {
      const response = await request(app)
        .post('/api/settings/validate')
        .send({
          general: { defaultRuntime: 'gemini-cli' },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
      expect(response.body.data.errors).toHaveLength(0);
    });

    it('should return errors for invalid settings', async () => {
      const response = await request(app)
        .post('/api/settings/validate')
        .send({
          general: { checkInIntervalMinutes: -5 },
        });

      expect(response.status).toBe(200);
      expect(response.body.data.valid).toBe(false);
      expect(response.body.data.errors.length).toBeGreaterThan(0);
    });

    it('should not persist validated settings', async () => {
      await request(app)
        .post('/api/settings/validate')
        .send({
          general: { verboseLogging: true },
        });

      const response = await request(app).get('/api/settings');

      expect(response.body.data.general.verboseLogging).toBe(false);
    });
  });

  describe('POST /api/settings/reset', () => {
    it('should reset all settings to defaults', async () => {
      // First modify settings
      await request(app)
        .put('/api/settings')
        .send({
          general: { defaultRuntime: 'gemini-cli' },
          chat: { showTimestamps: false },
        });

      // Then reset
      const response = await request(app).post('/api/settings/reset');
      const defaults = getDefaultSettings();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.general.defaultRuntime).toBe(defaults.general.defaultRuntime);
      expect(response.body.data.chat.showTimestamps).toBe(defaults.chat.showTimestamps);
    });

    it('should include reset message', async () => {
      const response = await request(app).post('/api/settings/reset');

      expect(response.body.message).toContain('reset');
    });
  });

  describe('POST /api/settings/reset/:section', () => {
    it('should reset only general section', async () => {
      // First modify both sections
      await request(app)
        .put('/api/settings')
        .send({
          general: { defaultRuntime: 'gemini-cli' },
          chat: { showTimestamps: false },
        });

      // Reset only general
      const response = await request(app).post('/api/settings/reset/general');
      const defaults = getDefaultSettings();

      expect(response.status).toBe(200);
      expect(response.body.data.general.defaultRuntime).toBe(defaults.general.defaultRuntime);
      expect(response.body.data.chat.showTimestamps).toBe(false);
    });

    it('should reset only chat section', async () => {
      await request(app)
        .put('/api/settings')
        .send({
          general: { verboseLogging: true },
          chat: { showTimestamps: false },
        });

      const response = await request(app).post('/api/settings/reset/chat');
      const defaults = getDefaultSettings();

      expect(response.status).toBe(200);
      expect(response.body.data.general.verboseLogging).toBe(true);
      expect(response.body.data.chat.showTimestamps).toBe(defaults.chat.showTimestamps);
    });

    it('should reset only skills section', async () => {
      await request(app)
        .put('/api/settings')
        .send({
          general: { verboseLogging: true },
          skills: { enableBrowserAutomation: false },
        });

      const response = await request(app).post('/api/settings/reset/skills');
      const defaults = getDefaultSettings();

      expect(response.status).toBe(200);
      expect(response.body.data.general.verboseLogging).toBe(true);
      expect(response.body.data.skills.enableBrowserAutomation).toBe(defaults.skills.enableBrowserAutomation);
    });

    it('should return 400 for invalid section', async () => {
      const response = await request(app).post('/api/settings/reset/invalid');

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid section');
    });
  });

  describe('POST /api/settings/export', () => {
    it('should export settings as JSON', async () => {
      await request(app)
        .put('/api/settings')
        .send({
          general: { verboseLogging: true },
        });

      const response = await request(app).post('/api/settings/export');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.headers['content-disposition']).toContain('attachment');
      expect(response.body.general.verboseLogging).toBe(true);
    });
  });

  describe('POST /api/settings/import', () => {
    it('should import valid settings', async () => {
      const importData = {
        general: { defaultRuntime: 'codex-cli' },
        chat: { showTimestamps: false },
      };

      const response = await request(app)
        .post('/api/settings/import')
        .send(importData);

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.general.defaultRuntime).toBe('codex-cli');
      expect(response.body.data.chat.showTimestamps).toBe(false);
    });

    it('should return 400 for invalid settings', async () => {
      const importData = {
        general: { checkInIntervalMinutes: -5 },
      };

      const response = await request(app)
        .post('/api/settings/import')
        .send(importData);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.validationErrors).toBeDefined();
    });

    it('should return 400 when body is empty/falsy', async () => {
      // Empty object is technically valid since it will pass through merge
      // So we test with array which should be rejected
      const response = await request(app)
        .post('/api/settings/import')
        .send([]);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 400 for array input', async () => {
      const response = await request(app)
        .post('/api/settings/import')
        .send([{ general: {} }]);

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should persist imported settings', async () => {
      await request(app)
        .post('/api/settings/import')
        .send({
          general: { verboseLogging: true },
        });

      settingsService.clearCache();
      const response = await request(app).get('/api/settings');

      expect(response.body.data.general.verboseLogging).toBe(true);
    });
  });

  describe('API Keys settings', () => {
    it('should accept apiKeys in PUT', async () => {
      const response = await request(app)
        .put('/api/settings')
        .send({
          apiKeys: {
            global: { gemini: 'test-gemini-key-1234' },
          },
        });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should persist apiKeys settings', async () => {
      await request(app)
        .put('/api/settings')
        .send({
          apiKeys: {
            global: { anthropic: 'sk-ant-test-key-5678' },
          },
        });

      settingsService.clearCache();
      const response = await request(app).get('/api/settings');
      expect(response.body.data.apiKeys).toBeDefined();
      expect(response.body.data.apiKeys.global.anthropic).toBeDefined();
    });

    it('should include apiKeys defaults in GET response', async () => {
      const response = await request(app).get('/api/settings');
      expect(response.body.data.apiKeys).toBeDefined();
      expect(response.body.data.apiKeys.global).toBeDefined();
    });

    it('should accept apiKeys as valid section in reset', async () => {
      const response = await request(app).post('/api/settings/reset/apiKeys');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
    });

    it('should mask API keys in GET response', async () => {
      const fullKey = 'sk-ant-api-secret-key-with-many-chars-1234';

      // Store a real API key
      await request(app)
        .put('/api/settings')
        .send({
          apiKeys: {
            global: { anthropic: fullKey },
          },
        });

      // GET should return the masked version
      const response = await request(app).get('/api/settings');

      expect(response.status).toBe(200);
      const returnedKey = response.body.data.apiKeys.global.anthropic;
      // Must not return the full key
      expect(returnedKey).not.toBe(fullKey);
      // Should end with last 4 chars of the original key
      expect(returnedKey).toContain(fullKey.slice(-4));
      // Should start with masking dots
      expect(returnedKey).toMatch(/^[•]+/);
    });

    it('should mask multiple provider keys in GET response', async () => {
      const geminiKey = 'AIzaSyB-test-gemini-key-abcdef1234';
      const openaiKey = 'sk-openai-test-key-xxxxxxxxxxxx5678';

      await request(app)
        .put('/api/settings')
        .send({
          apiKeys: {
            global: { gemini: geminiKey, openai: openaiKey },
          },
        });

      const response = await request(app).get('/api/settings');

      expect(response.status).toBe(200);
      const { global } = response.body.data.apiKeys;
      // Both keys masked, neither reveals the full value
      expect(global.gemini).not.toBe(geminiKey);
      expect(global.openai).not.toBe(openaiKey);
      expect(global.gemini).toContain(geminiKey.slice(-4));
      expect(global.openai).toContain(openaiKey.slice(-4));
    });
  });

  describe('POST /api/settings/test-api-key', () => {
    let prodApp: Express;
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      // Build a minimal Express app using the production router (default export)
      // so that the test-api-key route is available.
      prodApp = express();
      prodApp.use(express.json());
      prodApp.use('/api/settings', settingsRouter);
      prodApp.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ success: false, error: err.message });
      });

      // Save the real fetch so we can restore it
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('should return 400 when provider is missing', async () => {
      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ key: 'some-key' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid provider');
    });

    // 'deepseek' became a supported provider in #419, so an unsupported
    // name is used here; the error lists every supported provider.
    it('should return 400 when provider is invalid', async () => {
      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'not-a-provider', key: 'some-key' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('Invalid provider');
      expect(response.body.error).toContain('deepseek');
    });

    // Regression: deepseek passed validation but testApiKey had no case
    // for it, so every DeepSeek key was reported as "Unknown provider".
    it('should validate a deepseek key against the DeepSeek models endpoint', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });
      global.fetch = fetchMock;

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'deepseek', key: 'sk-deepseek-valid' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.deepseek.com/v1/models',
        expect.objectContaining({
          headers: { Authorization: 'Bearer sk-deepseek-valid' },
        }),
      );
    });

    it('should return valid:false for an invalid deepseek key (401)', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'deepseek', key: 'sk-deepseek-bad' });

      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ valid: false, error: 'Invalid API key' });
    });

    it('should return 400 when key is missing', async () => {
      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'gemini' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('API key is required');
    });

    it('should return 400 when key is empty string', async () => {
      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'anthropic', key: '   ' });

      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain('API key is required');
    });

    it('should return valid:true for a valid gemini key', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ models: [] }),
      });

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'gemini', key: 'AIzaSy-valid-key' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
    });

    it('should return valid:false with error for an invalid anthropic key (401)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'invalid x-api-key' } }),
      });

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'anthropic', key: 'sk-ant-bad-key' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(false);
      expect(response.body.data.error).toBe('Invalid API key');
    });

    it('should return valid:true for a rate-limited anthropic key (429)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: 'rate limited' } }),
      });

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'anthropic', key: 'sk-ant-valid-but-throttled' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
    });

    it('should return valid:false with error message on network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network error: ECONNREFUSED'));

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'openai', key: 'sk-openai-key' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(false);
      expect(response.body.data.error).toBe('Network error: ECONNREFUSED');
    });

    it('should return valid:true for a valid openai key', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      });

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'openai', key: 'sk-openai-valid' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(true);
    });

    it('should return valid:false for an invalid openai key (401)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Incorrect API key' } }),
      });

      const response = await request(prodApp)
        .post('/api/settings/test-api-key')
        .send({ provider: 'openai', key: 'sk-openai-bad' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.valid).toBe(false);
      expect(response.body.data.error).toBe('Invalid API key');
    });
  });
});

describe('Settings Controller — who may write and read keys (#1012)', () => {
  // The real router over the real singleton, which keeps settings under $HOME/.crewly.
  let app: Express;
  let home: string;
  const originalHome = process.env.HOME;
  const REAL = { gemini: 'AIza-real-gemini-key-1111', openai: 'sk-real-openai-key-2222' };

  beforeEach(async () => {
    home = path.join(os.tmpdir(), `settings-auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(home, '.crewly'), { recursive: true });
    process.env.HOME = home;
    resetSettingsService();
    const { getSettingsService } = await import('../../services/settings/settings.service.js');
    await getSettingsService().updateSettings({
      apiKeys: {
        global: { ...REAL },
        skillOverrides: { 'transcribe-audio': { openai: { key: 'sk-skill-override-3333', source: 'custom' } } },
      },
    });
    app = express();
    app.use(express.json());
    app.use(callerIdentityForTests());
    app.use('/api/settings', settingsRouter);
    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ success: false, error: err.message });
    });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    resetSettingsService();
    await fs.rm(home, { recursive: true, force: true }).catch(() => undefined);
  });

  const AGENT = 'crewly-dev-sam-1234abcd';
  const writes: Array<{ name: string; method: 'put' | 'post'; path: string; body?: object }> = [
    { name: 'PUT /', method: 'put', path: '/api/settings', body: {} },
    { name: 'POST /reset', method: 'post', path: '/api/settings/reset' },
    { name: 'POST /reset/apiKeys', method: 'post', path: '/api/settings/reset/apiKeys' },
    { name: 'POST /import', method: 'post', path: '/api/settings/import', body: { apiKeys: { global: { gemini: 'attacker' } } } },
    { name: 'POST /export', method: 'post', path: '/api/settings/export' },
  ];

  describe.each(writes)('$name', (w) => {
    const send = (headers: Record<string, string>) => {
      const req = request(app)[w.method](w.path).set(headers);
      return w.body ? req.send(w.body) : req.send();
    };

    it('refuses a caller with no credential (401) and leaks no key', async () => {
      const res = await send({});
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain(REAL.gemini);
    });

    it('refuses an agent (403) and leaks no key', async () => {
      const res = await send(agentAuthHeaders(AGENT));
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain(REAL.gemini);
    });

    it('lets the owner through', async () => {
      const res = await send(ownerAuthHeaders());
      expect(res.status).toBe(200);
    });
  });

  it('PUT {} by the owner answers with masked keys (it used to echo them all)', async () => {
    const res = await request(app).put('/api/settings').set(ownerAuthHeaders()).send({});
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(REAL.gemini);
    expect(body).not.toContain(REAL.openai);
    expect(res.body.data.apiKeys.global.gemini).toMatch(/^•+1111$/);
  });

  it('import by the owner answers with masked keys', async () => {
    const res = await request(app).post('/api/settings/import').set(ownerAuthHeaders()).send({ general: { verboseLogging: true } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(REAL.gemini);
  });

  it('export (the owner backup) still carries the full keys', async () => {
    const res = await request(app).post('/api/settings/export').set(ownerAuthHeaders());
    expect(res.body.apiKeys.global.gemini).toBe(REAL.gemini);
  });

  it('the dashboard saving the masked copy back keeps the stored keys', async () => {
    const masked = (await request(app).get('/api/settings')).body.data.apiKeys;
    const res = await request(app)
      .put('/api/settings')
      .set(ownerAuthHeaders())
      .send({ apiKeys: { ...masked, global: { ...masked.global, anthropic: 'sk-ant-new-key-5555' } } });
    expect(res.status).toBe(200);
    const exported = (await request(app).post('/api/settings/export').set(ownerAuthHeaders())).body;
    expect(exported.apiKeys.global).toEqual({ ...REAL, anthropic: 'sk-ant-new-key-5555' });
    expect(exported.apiKeys.skillOverrides['transcribe-audio'].openai.key).toBe('sk-skill-override-3333');
  });

  it('GET / and POST /validate stay open and masked', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(REAL.gemini);
    expect((await request(app).post('/api/settings/validate').send({})).status).toBe(200);
  });

  describe('GET /api-key/:provider (the skills\' key path)', () => {
    it('gives an agent with its badge the resolved key', async () => {
      const res = await request(app).get('/api/settings/api-key/gemini').set(agentAuthHeaders(AGENT));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ provider: 'gemini', key: REAL.gemini });
    });

    it('applies the skill override', async () => {
      const res = await request(app).get('/api/settings/api-key/openai?skill=transcribe-audio').set(agentAuthHeaders(AGENT));
      expect(res.body.data.key).toBe('sk-skill-override-3333');
      const plain = await request(app).get('/api/settings/api-key/openai?skill=other-skill').set(agentAuthHeaders(AGENT));
      expect(plain.body.data.key).toBe(REAL.openai);
    });

    it('gives the owner the key', async () => {
      const res = await request(app).get('/api/settings/api-key/openai').set(ownerAuthHeaders());
      expect(res.body.data.key).toBe(REAL.openai);
    });

    it('refuses the legacy header alone (any local process can set it)', async () => {
      const res = await request(app).get('/api/settings/api-key/gemini').set({ 'X-Agent-Session': AGENT });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('agent_badge_required');
      expect(JSON.stringify(res.body)).not.toContain(REAL.gemini);
    });

    it('refuses a caller with no credential, and an invalid badge', async () => {
      expect((await request(app).get('/api/settings/api-key/gemini')).status).toBe(401);
      expect((await request(app).get('/api/settings/api-key/gemini').set({ 'X-Agent-Badge': 'cab1.forged.sig' })).status).toBe(401);
    });

    it('answers 404 for a provider with no key and 400 for an unknown provider', async () => {
      const saved = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      try {
        expect((await request(app).get('/api/settings/api-key/anthropic').set(agentAuthHeaders(AGENT))).status).toBe(404);
      } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      }
      expect((await request(app).get('/api/settings/api-key/nope').set(agentAuthHeaders(AGENT))).status).toBe(400);
    });
  });
});
