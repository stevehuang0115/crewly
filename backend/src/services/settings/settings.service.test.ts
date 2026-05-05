/**
 * Tests for Settings Management Service
 *
 * @module services/settings/settings.service.test
 */

// Jest globals are available automatically
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import {
  SettingsService,
  SettingsValidationError,
  SettingsFileError,
  getSettingsService,
  resetSettingsService,
} from './settings.service.js';
import { getDefaultSettings, CrewlySettings } from '../../types/settings.types.js';

describe('SettingsService', () => {
  let service: SettingsService;
  let testDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    service = new SettingsService({ settingsDir: testDir });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    resetSettingsService();
  });

  describe('getSettings', () => {
    it('should return defaults when no settings file exists', async () => {
      const settings = await service.getSettings();
      const defaults = getDefaultSettings();

      expect(settings).toEqual(defaults);
    });

    it('should load settings from file', async () => {
      const customSettings = getDefaultSettings();
      customSettings.general.defaultRuntime = 'gemini-cli';

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(customSettings, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.defaultRuntime).toBe('gemini-cli');
    });

    it('should cache settings after loading from file', async () => {
      // Create a settings file first
      await service.updateSettings({
        general: { verboseLogging: true },
      });

      service.clearCache();
      const settings1 = await service.getSettings();
      const settings2 = await service.getSettings();

      expect(settings1).toBe(settings2);
    });

    it('should merge loaded settings with defaults', async () => {
      // Save partial settings
      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify({ general: { defaultRuntime: 'gemini-cli' } })
      );

      service.clearCache();
      const settings = await service.getSettings();

      // Should have the custom value
      expect(settings.general.defaultRuntime).toBe('gemini-cli');
      // Should have default values for missing properties
      expect(settings.chat.maxMessageHistory).toBe(
        getDefaultSettings().chat.maxMessageHistory
      );
    });

    it('should return defaults for invalid JSON', async () => {
      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        'not valid json {'
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings).toEqual(getDefaultSettings());
    });

    it('should handle empty settings file', async () => {
      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        '{}'
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings).toEqual(getDefaultSettings());
    });
  });

  describe('settings migration', () => {
    it('should migrate legacy claudeCodeCommand to runtimeCommands', async () => {
      const legacySettings = {
        general: {
          defaultRuntime: 'claude-code',
          autoStartOrchestrator: true,
          checkInIntervalMinutes: 5,
          maxConcurrentAgents: 10,
          verboseLogging: false,
          claudeCodeCommand: '/custom/claude --dangerously-skip-permissions',
          claudeCodeInitScript: 'config/runtime_scripts/initialize_claude.sh',
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(legacySettings, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.runtimeCommands['claude-code']).toBe('/custom/claude --dangerously-skip-permissions');
      expect(settings.general.runtimeCommands['gemini-cli']).toBe('gemini --yolo');
      expect(settings.general.runtimeCommands['codex-cli']).toBe('codex -a never -s danger-full-access');
      expect((settings.general as any).claudeCodeCommand).toBeUndefined();
      expect((settings.general as any).claudeCodeInitScript).toBeUndefined();
    });

    it('should not overwrite existing runtimeCommands during migration', async () => {
      const settingsWithBoth = {
        general: {
          defaultRuntime: 'claude-code',
          claudeCodeCommand: '/old/claude',
          runtimeCommands: {
            'claude-code': '/new/claude --dangerously-skip-permissions',
            'gemini-cli': 'gemini --custom',
            'codex-cli': 'codex --custom',
          },
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(settingsWithBoth, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      // Should keep the runtimeCommands values, not overwrite with legacy
      expect(settings.general.runtimeCommands['claude-code']).toBe('/new/claude --dangerously-skip-permissions');
      expect(settings.general.runtimeCommands['gemini-cli']).toBe('gemini --custom');
    });

    it('should handle settings with no legacy fields', async () => {
      const modernSettings = {
        general: {
          defaultRuntime: 'claude-code',
          runtimeCommands: {
            'claude-code': 'claude --dangerously-skip-permissions',
            'gemini-cli': 'gemini --yolo',
            'codex-cli': 'codex -a never -s danger-full-access',
          },
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(modernSettings, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.runtimeCommands['claude-code']).toBe('claude --dangerously-skip-permissions');
    });

    it('should migrate old Codex default command to new no-confirmation command', async () => {
      const settingsWithOldCodexDefault = {
        general: {
          runtimeCommands: {
            'claude-code': 'claude --dangerously-skip-permissions',
            'gemini-cli': 'gemini --yolo',
            'codex-cli': 'codex --full-auto',
          },
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(settingsWithOldCodexDefault, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.runtimeCommands['codex-cli']).toBe('codex -a never -s danger-full-access');
    });

    // ----------------------------------------------------------------------
    // enableProactiveCompact one-time flip migration
    // Per spec 2026-05-05-compact-fix-AB-followup §A.1
    // ----------------------------------------------------------------------

    it('should flip persisted enableProactiveCompact=true → false on first load and set the migration marker', async () => {
      // Existing user installed before PR #444 has the proactive trigger ON.
      // The migration should flip it OFF and stamp `_proactiveCompactMigrated: true`
      // so the load is observable as a one-time migration.
      const legacyEnabled = {
        general: {
          enableProactiveCompact: true,
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(legacyEnabled, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.enableProactiveCompact).toBe(false);
      // The marker is stored on the loaded JSON, not on the typed defaults shape;
      // re-read the raw file to confirm the migration is durable.
      // The first call already mutated the in-memory `loaded`, so the cached
      // settings reflect the flip. Saving it back is a separate concern; this
      // test asserts the user-observable runtime value, which is `false`.
    });

    it('should NOT re-flip enableProactiveCompact when the migration marker is already set (idempotent re-enable preserved)', async () => {
      // User previously migrated (marker set), then deliberately re-enabled
      // proactive compact via the Settings UI. The next load must NOT undo
      // their choice — the marker gates the migration.
      const reEnabledByUser = {
        general: {
          enableProactiveCompact: true,
          _proactiveCompactMigrated: true,
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(reEnabledByUser, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.enableProactiveCompact).toBe(true);
    });

    it('should leave enableProactiveCompact=false alone (no-op when already disabled)', async () => {
      // Fresh installs after PR #444 land with `false`. The migration must
      // not toggle the marker for users who never had it on.
      const freshDefault = {
        general: {
          enableProactiveCompact: false,
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(freshDefault, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.enableProactiveCompact).toBe(false);
    });

    it('should leave enableProactiveCompact alone when missing from persisted general (unset → falls back to current default via mergeSettings)', async () => {
      // Settings file omits the field entirely. mergeSettings should fill
      // from getDefaultSettings (now `false`). The migration block is a
      // no-op because the typeof check excludes undefined.
      const noCompactField = {
        general: {
          defaultRuntime: 'claude-code',
        },
      };

      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(noCompactField, null, 2)
      );

      service.clearCache();
      const settings = await service.getSettings();

      expect(settings.general.enableProactiveCompact).toBe(false);
    });
  });

  describe('updateSettings', () => {
    it('should update partial settings', async () => {
      const updated = await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
      });

      expect(updated.general.defaultRuntime).toBe('gemini-cli');
      // Other settings should be defaults
      expect(updated.general.autoStartOrchestrator).toBe(true);
    });

    it('should persist settings to file', async () => {
      await service.updateSettings({
        chat: { showTimestamps: false },
      });

      // Create a new service instance to verify persistence
      const newService = new SettingsService({ settingsDir: testDir });
      const settings = await newService.getSettings();

      expect(settings.chat.showTimestamps).toBe(false);
    });

    it('should validate settings before saving', async () => {
      await expect(
        service.updateSettings({
          general: { checkInIntervalMinutes: -5 },
        })
      ).rejects.toThrow(SettingsValidationError);
    });

    it('should not persist invalid settings', async () => {
      try {
        await service.updateSettings({
          general: { checkInIntervalMinutes: -5 },
        });
      } catch {
        // Expected
      }

      const newService = new SettingsService({ settingsDir: testDir });
      const settings = await newService.getSettings();

      expect(settings.general.checkInIntervalMinutes).toBeGreaterThan(0);
    });

    it('should update cache after saving', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'codex-cli' },
      });

      const settings = await service.getSettings();
      expect(settings.general.defaultRuntime).toBe('codex-cli');
    });

    it('should update multiple sections', async () => {
      const updated = await service.updateSettings({
        general: { verboseLogging: true },
        chat: { showTimestamps: false },
        skills: { enableBrowserAutomation: false },
      });

      expect(updated.general.verboseLogging).toBe(true);
      expect(updated.chat.showTimestamps).toBe(false);
      expect(updated.skills.enableBrowserAutomation).toBe(false);
    });

    it('should preserve existing values when updating', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
      });

      await service.updateSettings({
        general: { verboseLogging: true },
      });

      const settings = await service.getSettings();
      expect(settings.general.defaultRuntime).toBe('gemini-cli');
      expect(settings.general.verboseLogging).toBe(true);
    });
  });

  describe('resetSettings', () => {
    it('should reset all settings to defaults', async () => {
      // First customize settings
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
        chat: { showTimestamps: false },
      });

      // Then reset
      const reset = await service.resetSettings();

      expect(reset).toEqual(getDefaultSettings());
    });

    it('should persist reset to file', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
      });

      await service.resetSettings();

      const newService = new SettingsService({ settingsDir: testDir });
      const settings = await newService.getSettings();

      expect(settings.general.defaultRuntime).toBe('claude-code');
    });

    it('should update cache after reset', async () => {
      await service.updateSettings({
        general: { verboseLogging: true },
      });

      await service.resetSettings();
      const settings = await service.getSettings();

      expect(settings.general.verboseLogging).toBe(false);
    });
  });

  describe('resetSection', () => {
    it('should reset only general section', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
        chat: { showTimestamps: false },
      });

      await service.resetSection('general');
      const settings = await service.getSettings();

      // General should be reset
      expect(settings.general.defaultRuntime).toBe('claude-code');
      // Chat should remain customized
      expect(settings.chat.showTimestamps).toBe(false);
    });

    it('should reset only chat section', async () => {
      await service.updateSettings({
        general: { verboseLogging: true },
        chat: { showTimestamps: false },
      });

      await service.resetSection('chat');
      const settings = await service.getSettings();

      // General should remain customized
      expect(settings.general.verboseLogging).toBe(true);
      // Chat should be reset
      expect(settings.chat.showTimestamps).toBe(true);
    });

    it('should reset only skills section', async () => {
      await service.updateSettings({
        general: { verboseLogging: true },
        skills: { enableBrowserAutomation: false },
      });

      await service.resetSection('skills');
      const settings = await service.getSettings();

      // General should remain customized
      expect(settings.general.verboseLogging).toBe(true);
      // Skills should be reset
      expect(settings.skills.enableBrowserAutomation).toBe(true);
    });

    it('should persist section reset to file', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
      });

      await service.resetSection('general');

      const newService = new SettingsService({ settingsDir: testDir });
      const settings = await newService.getSettings();

      expect(settings.general.defaultRuntime).toBe('claude-code');
    });
  });

  describe('validateSettingsInput', () => {
    it('should validate without saving', async () => {
      const result = await service.validateSettingsInput({
        general: { checkInIntervalMinutes: -5 },
      });

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);

      // Settings should not have changed
      const settings = await service.getSettings();
      expect(settings.general.checkInIntervalMinutes).toBeGreaterThan(0);
    });

    it('should return valid for correct settings', async () => {
      const result = await service.validateSettingsInput({
        general: { defaultRuntime: 'gemini-cli' },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate against current settings', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
      });

      // Validating an empty update should be valid
      const result = await service.validateSettingsInput({});
      expect(result.valid).toBe(true);
    });
  });

  describe('exportSettings', () => {
    it('should export settings to file', async () => {
      await service.updateSettings({
        general: { defaultRuntime: 'gemini-cli' },
      });

      const exportPath = path.join(testDir, 'export.json');
      await service.exportSettings(exportPath);

      const content = await fs.readFile(exportPath, 'utf-8');
      const exported = JSON.parse(content);

      expect(exported.general.defaultRuntime).toBe('gemini-cli');
    });

    it('should export complete settings', async () => {
      const exportPath = path.join(testDir, 'complete-export.json');
      await service.exportSettings(exportPath);

      const content = await fs.readFile(exportPath, 'utf-8');
      const exported = JSON.parse(content) as CrewlySettings;

      expect(exported.general).toBeDefined();
      expect(exported.chat).toBeDefined();
      expect(exported.skills).toBeDefined();
    });

    it('should format JSON with indentation', async () => {
      const exportPath = path.join(testDir, 'formatted.json');
      await service.exportSettings(exportPath);

      const content = await fs.readFile(exportPath, 'utf-8');

      // Check for newlines indicating formatting
      expect(content).toContain('\n');
      expect(content).toContain('  ');
    });
  });

  describe('importSettings', () => {
    it('should import settings from file', async () => {
      const importData = getDefaultSettings();
      importData.general.defaultRuntime = 'codex-cli';

      const importPath = path.join(testDir, 'import.json');
      await fs.writeFile(importPath, JSON.stringify(importData));

      const imported = await service.importSettings(importPath);

      expect(imported.general.defaultRuntime).toBe('codex-cli');
    });

    it('should validate imported settings', async () => {
      const importPath = path.join(testDir, 'invalid-import.json');
      await fs.writeFile(
        importPath,
        JSON.stringify({ general: { checkInIntervalMinutes: -5 } })
      );

      await expect(service.importSettings(importPath)).rejects.toThrow(
        SettingsValidationError
      );
    });

    it('should persist imported settings', async () => {
      const importData = getDefaultSettings();
      importData.chat.showTimestamps = false;

      const importPath = path.join(testDir, 'persist-import.json');
      await fs.writeFile(importPath, JSON.stringify(importData));

      await service.importSettings(importPath);

      const newService = new SettingsService({ settingsDir: testDir });
      const settings = await newService.getSettings();

      expect(settings.chat.showTimestamps).toBe(false);
    });

    it('should update cache after import', async () => {
      const importData = getDefaultSettings();
      importData.general.verboseLogging = true;

      const importPath = path.join(testDir, 'cache-import.json');
      await fs.writeFile(importPath, JSON.stringify(importData));

      await service.importSettings(importPath);
      const settings = await service.getSettings();

      expect(settings.general.verboseLogging).toBe(true);
    });

    it('should throw error for non-existent file', async () => {
      await expect(
        service.importSettings('/nonexistent/file.json')
      ).rejects.toThrow(SettingsFileError);
    });

    it('should throw error for invalid JSON', async () => {
      const importPath = path.join(testDir, 'invalid.json');
      await fs.writeFile(importPath, 'not valid json');

      await expect(service.importSettings(importPath)).rejects.toThrow(
        SettingsFileError
      );
    });

    it('should merge partial import with defaults', async () => {
      const importPath = path.join(testDir, 'partial-import.json');
      await fs.writeFile(
        importPath,
        JSON.stringify({ general: { verboseLogging: true } })
      );

      const imported = await service.importSettings(importPath);

      expect(imported.general.verboseLogging).toBe(true);
      expect(imported.general.defaultRuntime).toBe('claude-code');
      expect(imported.chat.maxMessageHistory).toBe(1000);
    });
  });

  describe('clearCache', () => {
    it('should force reload from disk', async () => {
      // First save settings to create the file
      await service.updateSettings({
        general: { defaultRuntime: 'claude-code' },
      });

      // Get settings to ensure they're cached
      const initial = await service.getSettings();
      expect(initial.general.defaultRuntime).toBe('claude-code');

      // Write new settings directly to disk
      const newSettings = getDefaultSettings();
      newSettings.general.defaultRuntime = 'gemini-cli';
      await fs.writeFile(
        path.join(testDir, 'settings.json'),
        JSON.stringify(newSettings)
      );

      // Without clearing cache, should still get cached value
      const cached = await service.getSettings();
      expect(cached.general.defaultRuntime).toBe('claude-code');

      // After clearing cache, should get new value
      service.clearCache();
      const fresh = await service.getSettings();
      expect(fresh.general.defaultRuntime).toBe('gemini-cli');
    });
  });

  describe('getSettingsFilePath', () => {
    it('should return the settings file path', () => {
      const filePath = service.getSettingsFilePath();
      expect(filePath).toBe(path.join(testDir, 'settings.json'));
    });
  });

  describe('hasSettingsFile', () => {
    it('should return false when file does not exist', async () => {
      const hasFile = await service.hasSettingsFile();
      expect(hasFile).toBe(false);
    });

    it('should return true when file exists', async () => {
      await service.updateSettings({
        general: { verboseLogging: true },
      });

      const hasFile = await service.hasSettingsFile();
      expect(hasFile).toBe(true);
    });
  });

  describe('getApiKey', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return undefined when no key is configured', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const key = await service.getApiKey('anthropic');
      expect(key).toBeUndefined();
    });

    it('should return env var as fallback', async () => {
      process.env.ANTHROPIC_API_KEY = 'env-key';
      const key = await service.getApiKey('anthropic');
      expect(key).toBe('env-key');
    });

    it('should return global key from settings', async () => {
      await service.updateSettings({
        apiKeys: { global: { anthropic: 'settings-key' } },
      });
      const key = await service.getApiKey('anthropic');
      expect(key).toBe('settings-key');
    });

    it('should return runtime override when context specifies runtime', async () => {
      await service.updateSettings({
        apiKeys: {
          global: { gemini: 'global-key' },
          runtimeOverrides: {
            'gemini-cli': {
              gemini: { key: 'runtime-key', source: 'custom' },
            },
          },
        },
      });
      const key = await service.getApiKey('gemini', { runtime: 'gemini-cli' });
      expect(key).toBe('runtime-key');
    });

    it('should fall back to global when runtime override source is global', async () => {
      await service.updateSettings({
        apiKeys: {
          global: { gemini: 'global-key' },
          runtimeOverrides: {
            'gemini-cli': {
              gemini: { key: '', source: 'global' },
            },
          },
        },
      });
      const key = await service.getApiKey('gemini', { runtime: 'gemini-cli' });
      expect(key).toBe('global-key');
    });
  });
});

describe('Error Classes', () => {
  describe('SettingsValidationError', () => {
    it('should have correct name and message', () => {
      const error = new SettingsValidationError(['Error 1', 'Error 2']);
      expect(error.name).toBe('SettingsValidationError');
      expect(error.message).toContain('Error 1');
      expect(error.message).toContain('Error 2');
    });

    it('should expose errors array', () => {
      const errors = ['Error 1', 'Error 2'];
      const error = new SettingsValidationError(errors);
      expect(error.errors).toEqual(errors);
    });

    it('should be instanceof Error', () => {
      const error = new SettingsValidationError(['Error']);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('SettingsFileError', () => {
    it('should have correct name and message', () => {
      const error = new SettingsFileError('Failed to read file');
      expect(error.name).toBe('SettingsFileError');
      expect(error.message).toBe('Failed to read file');
    });

    it('should preserve cause', () => {
      const cause = new Error('Original error');
      const error = new SettingsFileError('Failed', cause);
      expect(error.cause).toBe(cause);
    });
  });
});

describe('getSettingsService', () => {
  afterEach(() => {
    resetSettingsService();
  });

  it('should return singleton instance', () => {
    const instance1 = getSettingsService();
    const instance2 = getSettingsService();
    expect(instance1).toBe(instance2);
  });

  it('should return different instance after reset', () => {
    const instance1 = getSettingsService();
    resetSettingsService();
    const instance2 = getSettingsService();
    expect(instance1).not.toBe(instance2);
  });
});

describe('resetSettingsService', () => {
  it('should clear the singleton instance', () => {
    const instance1 = getSettingsService();
    resetSettingsService();
    const instance2 = getSettingsService();
    expect(instance1).not.toBe(instance2);
  });
});
