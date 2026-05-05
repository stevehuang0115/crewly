/**
 * Settings Management Service
 *
 * Handles persistence and validation of Crewly application settings.
 * Settings are stored in ~/.crewly/settings.json.
 *
 * @module services/settings/settings.service
 */

import { promises as fs } from 'fs';
import path from 'path';
import {
  CrewlySettings,
  UpdateSettingsInput,
  SettingsValidationResult,
  getDefaultSettings,
  validateSettings,
  mergeSettings,
  AIRuntime,
  ApiKeyProvider,
  ApiKeyResolutionContext,
  resolveApiKey,
} from '../../types/settings.types.js';
import { atomicWriteJson, safeReadJson } from '../../utils/file-io.utils.js';

// ============================================================================
// Custom Error Classes
// ============================================================================

/**
 * Error thrown when settings validation fails
 */
export class SettingsValidationError extends Error {
  public readonly errors: string[];

  constructor(errors: string[]) {
    super(`Settings validation failed: ${errors.join(', ')}`);
    this.name = 'SettingsValidationError';
    this.errors = errors;
  }
}

/**
 * Error thrown when settings file cannot be read or parsed
 */
export class SettingsFileError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'SettingsFileError';
  }
}

// ============================================================================
// SettingsService Class
// ============================================================================

/**
 * Service for managing Crewly application settings
 *
 * Settings are stored in ~/.crewly/settings.json by default.
 * Default values are used when no settings file exists.
 *
 * @example
 * ```typescript
 * const service = getSettingsService();
 *
 * // Get current settings
 * const settings = await service.getSettings();
 *
 * // Update settings
 * await service.updateSettings({
 *   general: { verboseLogging: true },
 * });
 *
 * // Reset to defaults
 * await service.resetSettings();
 * ```
 */
export class SettingsService {
  private readonly settingsDir: string;
  private readonly settingsFile: string;
  private settingsCache: CrewlySettings | null = null;

  /**
   * Create a new SettingsService instance
   *
   * @param options - Configuration options
   * @param options.settingsDir - Directory for settings file
   */
  constructor(options?: { settingsDir?: string }) {
    this.settingsDir = options?.settingsDir ??
      path.join(process.env.HOME || '~', '.crewly');
    this.settingsFile = path.join(this.settingsDir, 'settings.json');
  }

  /**
   * Get current settings, loading from file if not cached
   *
   * If settings file doesn't exist or is invalid, returns default settings.
   *
   * @returns Current settings
   */
  async getSettings(): Promise<CrewlySettings> {
    if (this.settingsCache) {
      return this.settingsCache;
    }

    const loaded = await safeReadJson<Partial<CrewlySettings> | null>(this.settingsFile, null);
    if (loaded) {
      // Migrate legacy claudeCodeCommand/claudeCodeInitScript → runtimeCommands
      this.migrateSettings(loaded);
      this.settingsCache = mergeSettings(getDefaultSettings(), loaded);
      return this.settingsCache;
    }
    return getDefaultSettings();
  }

  /**
   * Update settings with partial input
   *
   * Merges the input with current settings and validates before saving.
   *
   * @param input - Partial settings to update
   * @returns Updated settings
   * @throws {SettingsValidationError} If validation fails
   */
  async updateSettings(input: UpdateSettingsInput): Promise<CrewlySettings> {
    const current = await this.getSettings();
    const merged = mergeSettings(current, input);

    const validation = validateSettings(merged);
    if (!validation.valid) {
      throw new SettingsValidationError(validation.errors);
    }

    await this.saveSettings(merged);
    this.settingsCache = merged;
    return merged;
  }

  /**
   * Reset all settings to defaults
   *
   * @returns Default settings
   */
  async resetSettings(): Promise<CrewlySettings> {
    const defaults = getDefaultSettings();
    await this.saveSettings(defaults);
    this.settingsCache = defaults;
    return defaults;
  }

  /**
   * Reset a specific settings section to defaults
   *
   * @param section - The section to reset ('general', 'chat', or 'skills')
   * @returns Updated settings
   */
  async resetSection(section: keyof CrewlySettings): Promise<CrewlySettings> {
    const current = await this.getSettings();
    const defaults = getDefaultSettings();

    const updated: CrewlySettings = {
      ...current,
      [section]: defaults[section],
    };

    await this.saveSettings(updated);
    this.settingsCache = updated;
    return updated;
  }

  /**
   * Validate settings input without saving
   *
   * Useful for form validation before submission.
   *
   * @param input - Settings to validate
   * @returns Validation result
   */
  async validateSettingsInput(input: UpdateSettingsInput): Promise<SettingsValidationResult> {
    const current = await this.getSettings();
    const merged = mergeSettings(current, input);
    return validateSettings(merged);
  }

  /**
   * Export settings to a file
   *
   * @param exportPath - Path to export file
   */
  async exportSettings(exportPath: string): Promise<void> {
    const settings = await this.getSettings();
    await atomicWriteJson(exportPath, settings);
  }

  /**
   * Import settings from a file
   *
   * Validates imported settings before saving.
   *
   * @param importPath - Path to import file
   * @returns Imported settings
   * @throws {SettingsValidationError} If imported settings are invalid
   * @throws {SettingsFileError} If file cannot be read or parsed
   */
  async importSettings(importPath: string): Promise<CrewlySettings> {
    let content: string;
    try {
      content = await fs.readFile(importPath, 'utf-8');
    } catch (err) {
      throw new SettingsFileError(`Failed to read settings file: ${importPath}`, err as Error);
    }

    let imported: Partial<CrewlySettings>;
    try {
      imported = JSON.parse(content);
    } catch (err) {
      throw new SettingsFileError('Failed to parse settings file: invalid JSON', err as Error);
    }

    // Merge with defaults to fill in missing properties
    const defaults = getDefaultSettings();
    const merged = mergeSettings(defaults, imported as UpdateSettingsInput);

    const validation = validateSettings(merged);
    if (!validation.valid) {
      throw new SettingsValidationError(validation.errors);
    }

    await this.saveSettings(merged);
    this.settingsCache = merged;
    return merged;
  }

  /**
   * Resolve an API key through the override chain: skill → runtime → global → env var
   *
   * @param provider - The API key provider (gemini, anthropic, openai)
   * @param context - Optional context with runtime and/or skill for override resolution
   * @returns The resolved API key or undefined if not configured anywhere
   */
  async getApiKey(provider: ApiKeyProvider, context?: ApiKeyResolutionContext): Promise<string | undefined> {
    const settings = await this.getSettings();
    return resolveApiKey(provider, settings.apiKeys, context);
  }

  /**
   * Clear the settings cache
   *
   * Forces the next getSettings call to reload from disk.
   */
  clearCache(): void {
    this.settingsCache = null;
  }

  /**
   * Get the path to the settings file
   *
   * @returns Absolute path to settings.json
   */
  getSettingsFilePath(): string {
    return this.settingsFile;
  }

  /**
   * Check if a settings file exists
   *
   * @returns True if settings file exists
   */
  async hasSettingsFile(): Promise<boolean> {
    try {
      await fs.access(this.settingsFile);
      return true;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Migrate legacy settings format to current format
   *
   * Converts old claudeCodeCommand/claudeCodeInitScript fields
   * to the new runtimeCommands map.
   *
   * @param loaded - Partially loaded settings from disk
   */
  private migrateSettings(loaded: Partial<CrewlySettings>): void {
    const general = loaded.general as Record<string, unknown> | undefined;
    if (!general) return;

    const hasLegacyCommand = typeof general['claudeCodeCommand'] === 'string';
    const hasRuntimeCommands = general['runtimeCommands'] !== undefined;

    if (hasLegacyCommand && !hasRuntimeCommands) {
      const defaults = getDefaultSettings();
      general['runtimeCommands'] = {
        'claude-code': general['claudeCodeCommand'] as string,
        'gemini-cli': defaults.general.runtimeCommands['gemini-cli'],
        'codex-cli': defaults.general.runtimeCommands['codex-cli'],
        'crewly-agent': defaults.general.runtimeCommands['crewly-agent'],
      } satisfies Record<AIRuntime, string>;
    }

    // Keep existing users aligned with the current safer Codex default.
    // Only rewrite when their value is exactly the previous built-in default.
    const runtimeCommands = general['runtimeCommands'] as Record<string, unknown> | undefined;
    if (runtimeCommands?.['codex-cli'] === 'codex --full-auto') {
      runtimeCommands['codex-cli'] = 'codex -a never -s danger-full-access';
    }

    // One-time flip: existing users with proactive compact enabled get switched
    // off per Steve user-position decision (2026-05-04). The Settings UI still
    // allows users to opt back in. The `_proactiveCompactMigrated` marker is
    // idempotent — a user who deliberately re-enables via Settings UI will not
    // be re-flipped on subsequent loads.
    //
    // Per spec 2026-05-05-compact-fix-AB-followup §A.1
    if (
      typeof general['enableProactiveCompact'] === 'boolean' &&
      general['enableProactiveCompact'] === true &&
      !general['_proactiveCompactMigrated']
    ) {
      general['enableProactiveCompact'] = false;
      general['_proactiveCompactMigrated'] = true;
    }

    // Clean up legacy fields
    delete general['claudeCodeCommand'];
    delete general['claudeCodeInitScript'];
  }

  /**
   * Save settings to disk
   *
   * @param settings - Settings to save
   */
  private async saveSettings(settings: CrewlySettings): Promise<void> {
    await fs.mkdir(this.settingsDir, { recursive: true });
    await atomicWriteJson(this.settingsFile, settings);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let settingsServiceInstance: SettingsService | null = null;

/**
 * Get the singleton SettingsService instance
 *
 * @returns The SettingsService instance
 */
export function getSettingsService(): SettingsService {
  if (!settingsServiceInstance) {
    settingsServiceInstance = new SettingsService();
  }
  return settingsServiceInstance;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetSettingsService(): void {
  settingsServiceInstance = null;
}
