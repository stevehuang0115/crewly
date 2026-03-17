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
} from '../../types/settings.types.js';

const router = Router();

/** Timeout in milliseconds for API key validation requests */
const API_KEY_TEST_TIMEOUT_MS = 10_000;

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
    const safeSettings = { ...settings };
    if (safeSettings.apiKeys) {
      safeSettings.apiKeys = maskApiKeysSettings(safeSettings.apiKeys);
    }

    res.json({
      success: true,
      data: safeSettings,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/settings
 * Update application settings (partial update supported)
 */
router.put('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateSettingsInput = req.body;

    const settingsService = getSettingsService();
    const settings = await settingsService.updateSettings(input);

    res.json({
      success: true,
      data: settings,
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
router.post('/reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settingsService = getSettingsService();
    const settings = await settingsService.resetSettings();

    res.json({
      success: true,
      data: settings,
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
router.post('/reset/:section', async (req: Request, res: Response, next: NextFunction) => {
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
      data: settings,
      message: `${section} settings reset to defaults`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/settings/export
 * Export settings to a downloadable file
 */
router.post('/export', async (req: Request, res: Response, next: NextFunction) => {
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
router.post('/import', async (req: Request, res: Response, next: NextFunction) => {
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
      data: settings,
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
 * POST /api/settings/test-api-key
 * Test if an API key is valid by making a minimal API call
 */
router.post('/test-api-key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { provider, key } = req.body as { provider?: string; key?: string };

    if (!provider || !isValidApiKeyProvider(provider)) {
      return res.status(400).json({
        success: false,
        error: `Invalid provider. Must be one of: gemini, anthropic, openai`,
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
      default:
        return { valid: false, error: `Unknown provider: ${provider}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { valid: false, error: message };
  }
}

export default router;
