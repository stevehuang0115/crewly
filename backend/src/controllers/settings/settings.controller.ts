/**
 * Settings Controller
 *
 * REST API endpoints for managing Crewly application settings.
 *
 * @module controllers/settings/settings.controller
 */

import { Router, Request, Response, NextFunction } from 'express';
import {
  getSettingsService,
  SettingsValidationError,
} from '../../services/settings/settings.service.js';
import {
  UpdateSettingsInput,
  CrewlySettings,
  maskApiKeysSettings,
  isValidApiKeyProvider,
  ApiKeyProvider,
  API_KEY_PROVIDERS,
} from '../../types/settings.types.js';
import {
  getCallerIdentity,
  ownerOnly,
  rejectUnverifiedCaller,
} from '../../middleware/caller-identity.middleware.js';
import { decideAgentApiKeyAccess, logApiKeyRead } from '../../services/settings/api-key-access.service.js';
import { OWNER_AUTH_CONSTANTS } from '../../constants.js';

const router = Router();

/**
 * Settings writes are the owner's (#1012): they replace provider API keys
 * and the runtime commands agents are launched with. Agents get 403, a
 * caller with no credential 401.
 */
const ownerGate = ownerOnly({
  success: false,
  error: OWNER_AUTH_CONSTANTS.ERRORS.OWNER_ONLY,
  message: 'Only the owner can change Crewly settings.',
});

/**
 * A copy of settings safe to return: provider API keys masked. Every
 * settings response but the owner's export goes through this.
 *
 * @param settings - Settings as stored
 * @returns Settings with `apiKeys` masked
 */
function maskedSettings(settings: CrewlySettings): CrewlySettings {
  return settings.apiKeys ? { ...settings, apiKeys: maskApiKeysSettings(settings.apiKeys) } : { ...settings };
}

/** Timeout in milliseconds for API key validation requests */
const API_KEY_TEST_TIMEOUT_MS = 10_000;

/** DeepSeek's OpenAI-compatible model-list endpoint, used to validate a key. */
const DEEPSEEK_MODELS_URL = 'https://api.deepseek.com/v1/models';

/**
 * Valid section names for reset endpoints
 */
const VALID_SECTIONS: (keyof CrewlySettings)[] = ['general', 'chat', 'skills', 'apiKeys'];

/**
 * GET /api/settings
 * Get current application settings
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settingsService = getSettingsService();
    const settings = await settingsService.getSettings();

    // Mask API keys before returning to prevent leaking secrets
    res.json({
      success: true,
      data: maskedSettings(settings),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/settings
 * Update application settings (partial update supported). Owner-only; the
 * response masks API keys, and a masked key sent back keeps the stored one.
 */
router.put('/', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateSettingsInput = req.body;

    const settingsService = getSettingsService();
    const settings = await settingsService.updateSettings(input);

    res.json({
      success: true,
      data: maskedSettings(settings),
    });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        validationErrors: error.errors,
      });
    }
    next(error);
  }
});

/**
 * POST /api/settings/validate
 * Validate settings without saving
 */
router.post('/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateSettingsInput = req.body;

    const settingsService = getSettingsService();
    const result = await settingsService.validateSettingsInput(input);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/reset
 * Reset all settings to defaults
 */
router.post('/reset', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settingsService = getSettingsService();
    const settings = await settingsService.resetSettings();

    res.json({
      success: true,
      data: maskedSettings(settings),
      message: 'Settings reset to defaults',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/reset/:section
 * Reset a specific settings section to defaults
 */
router.post('/reset/:section', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const section = req.params.section as keyof CrewlySettings;

    if (!VALID_SECTIONS.includes(section)) {
      return res.status(400).json({
        success: false,
        error: `Invalid section. Must be one of: ${VALID_SECTIONS.join(', ')}`,
      });
    }

    const settingsService = getSettingsService();
    const settings = await settingsService.resetSection(section);

    res.json({
      success: true,
      data: maskedSettings(settings),
      message: `${section} settings reset to defaults`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/export
 * Export settings to a downloadable file. Owner-only: this is the one
 * response that carries the API keys in full (it is the owner's backup).
 */
router.post('/export', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settingsService = getSettingsService();
    const settings = await settingsService.getSettings();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=crewly-settings.json');
    res.json(settings);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/import
 * Import settings from uploaded JSON
 */
router.post('/import', ownerGate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const importedSettings = req.body;

    if (!importedSettings || typeof importedSettings !== 'object' || Array.isArray(importedSettings)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid settings format',
      });
    }

    const settingsService = getSettingsService();

    // Validate first
    const validation = await settingsService.validateSettingsInput(importedSettings);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid settings',
        validationErrors: validation.errors,
      });
    }

    const settings = await settingsService.updateSettings(importedSettings);

    res.json({
      success: true,
      data: maskedSettings(settings),
      message: 'Settings imported successfully',
    });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return res.status(400).json({
        success: false,
        error: error.message,
        validationErrors: error.errors,
      });
    }
    next(error);
  }
});

/**
 * GET /api/settings/api-key/:provider?skill=<id>&runtime=<runtime>
 *
 * The resolved key for one provider, for a skill that needs it at run time
 * (transcribe-audio, screenshot-compare). Resolution is the usual chain:
 * skill override, runtime override, global, environment (#1012).
 *
 * Who may read it:
 * - the owner (dashboard session, API token, relay): any provider;
 * - an agent identified by its badge, or proven an agent's process by the
 *   process tree — scoped to what it needs (#1024,
 *   services/settings/api-key-access.service.ts): its own runtime's
 *   provider, or a provider the `?skill=` it names declares. The runtime is
 *   the agent's own, never the query's; a different `?runtime=` is refused.
 *
 * An agent with only the legacy `X-Agent-Session` header is refused (403):
 * any local process can set that header. A caller with no credential gets
 * 401. A provider with nothing configured is 404. Every read and refusal is
 * logged (provider, caller, scope — never the key).
 */
router.get('/api-key/:provider', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (rejectUnverifiedCaller(req, res, 'Reading an API key')) {
      logApiKeyRead({ provider: String(req.params.provider), identity: getCallerIdentity(req), outcome: 'refused', code: 'unverified_caller' });
      return;
    }
    const identity = getCallerIdentity(req);

    const provider = req.params.provider;
    if (!isValidApiKeyProvider(provider)) {
      res.status(400).json({
        success: false,
        error: `Invalid provider. Must be one of: ${API_KEY_PROVIDERS.join(', ')}`,
      });
      return;
    }
    let skill = typeof req.query.skill === 'string' && req.query.skill ? req.query.skill : undefined;
    let runtime = typeof req.query.runtime === 'string' && req.query.runtime ? req.query.runtime : undefined;

    if (identity.kind === 'agent' && identity.session) {
      const decision = await decideAgentApiKeyAccess(identity.session, provider, { skill, runtime });
      if (!decision.allowed) {
        logApiKeyRead({ provider, identity, skill, runtime, outcome: 'refused', code: decision.code });
        res.status(403).json({ success: false, error: decision.code, code: decision.code, message: decision.message });
        return;
      }
      skill = decision.skill;
      runtime = decision.runtime;
    }

    const key = await getSettingsService().getApiKey(provider, { skill, runtime });
    if (!key) {
      logApiKeyRead({ provider, identity, skill, runtime, outcome: 'not-configured' });
      res.status(404).json({ success: false, error: `No ${provider} API key is configured` });
      return;
    }
    logApiKeyRead({ provider, identity, skill, runtime, outcome: 'served' });
    res.json({ success: true, data: { provider, key } });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/test-api-key
 * Test if an API key is valid by making a minimal API call
 */
router.post('/test-api-key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider, key } = req.body as { provider?: string; key?: string };

    if (!provider || !isValidApiKeyProvider(provider)) {
      return res.status(400).json({
        success: false,
        error: `Invalid provider. Must be one of: ${API_KEY_PROVIDERS.join(', ')}`,
      });
    }

    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'API key is required',
      });
    }

    const result = await testApiKey(provider as ApiKeyProvider, key.trim());

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Test an API key by making a minimal request to the provider
 *
 * @param provider - The API key provider
 * @param key - The API key to test
 * @returns Test result with valid flag and optional error
 */
async function testApiKey(
  provider: ApiKeyProvider,
  key: string
): Promise<{ valid: boolean; error?: string }> {
  try {
    switch (provider) {
      case 'gemini': {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
          { method: 'GET', signal: AbortSignal.timeout(API_KEY_TEST_TIMEOUT_MS) }
        );
        if (response.ok) return { valid: true };
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        const geminiError = body?.error;
        const errorMsg = typeof geminiError === 'object' && geminiError !== null
          ? (geminiError as Record<string, unknown>).message as string || `HTTP ${response.status}`
          : typeof geminiError === 'string' ? geminiError : `HTTP ${response.status}`;
        return { valid: false, error: errorMsg };
      }
      case 'anthropic': {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
          signal: AbortSignal.timeout(API_KEY_TEST_TIMEOUT_MS),
        });
        // 200 or 429 (rate limited) both mean the key is valid
        if (response.ok || response.status === 429) return { valid: true };
        if (response.status === 401) return { valid: false, error: 'Invalid API key' };
        return { valid: false, error: `HTTP ${response.status}` };
      }
      case 'openai': {
        const response = await fetch('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(API_KEY_TEST_TIMEOUT_MS),
        });
        if (response.ok) return { valid: true };
        if (response.status === 401) return { valid: false, error: 'Invalid API key' };
        return { valid: false, error: `HTTP ${response.status}` };
      }
      case 'deepseek': {
        // DeepSeek serves an OpenAI-compatible API, so the same
        // bearer-auth model listing validates the key.
        const response = await fetch(DEEPSEEK_MODELS_URL, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${key}` },
          signal: AbortSignal.timeout(API_KEY_TEST_TIMEOUT_MS),
        });
        if (response.ok) return { valid: true };
        if (response.status === 401) return { valid: false, error: 'Invalid API key' };
        return { valid: false, error: `HTTP ${response.status}` };
      }
      default:
        return { valid: false, error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { valid: false, error: message };
  }
}

export default router;
