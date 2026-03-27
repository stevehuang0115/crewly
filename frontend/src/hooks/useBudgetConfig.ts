/**
 * useBudgetConfig Hook
 *
 * Manages budget configuration persisted in localStorage.
 * Provides load, save, and validation for spending limits.
 *
 * TODO: Replace localStorage persistence with backend API
 * when the budget configuration endpoint is available.
 *
 * @module hooks/useBudgetConfig
 */

import { useState, useCallback, useEffect } from 'react';
import type { BudgetConfig } from '../types';

/** localStorage key for budget configuration */
const STORAGE_KEY = 'crewly-budget-config';

/** Default budget configuration values */
const DEFAULT_CONFIG: BudgetConfig = {
  dailyLimit: 50,
  weeklyLimit: 200,
  monthlyLimit: 500,
  maxTokensPerTask: 100000,
  warningThreshold: 80,
};

/**
 * Validation error details for budget configuration fields.
 */
export interface BudgetValidationErrors {
  dailyLimit?: string;
  weeklyLimit?: string;
  monthlyLimit?: string;
  maxTokensPerTask?: string;
  warningThreshold?: string;
}

/**
 * Return type for the useBudgetConfig hook.
 */
export interface UseBudgetConfigResult {
  /** Current budget configuration */
  config: BudgetConfig;
  /** Update the budget configuration and persist to localStorage */
  saveConfig: (newConfig: BudgetConfig) => BudgetValidationErrors | null;
  /** Reset configuration to defaults */
  resetConfig: () => void;
  /** Validate a configuration without saving */
  validateConfig: (config: BudgetConfig) => BudgetValidationErrors | null;
}

/**
 * Validates budget configuration values.
 *
 * Rules:
 * - All limits must be positive numbers
 * - Weekly limit must be >= daily limit
 * - Monthly limit must be >= weekly limit
 * - Warning threshold must be between 1 and 100
 * - Max tokens per task must be positive
 *
 * @param config - Configuration to validate
 * @returns Validation errors object, or null if valid
 */
export function validateBudgetConfig(config: BudgetConfig): BudgetValidationErrors | null {
  const errors: BudgetValidationErrors = {};

  if (config.dailyLimit <= 0) {
    errors.dailyLimit = 'Daily limit must be a positive number';
  }
  if (config.weeklyLimit <= 0) {
    errors.weeklyLimit = 'Weekly limit must be a positive number';
  }
  if (config.monthlyLimit <= 0) {
    errors.monthlyLimit = 'Monthly limit must be a positive number';
  }
  if (config.maxTokensPerTask <= 0) {
    errors.maxTokensPerTask = 'Max tokens per task must be a positive number';
  }
  if (config.warningThreshold < 1 || config.warningThreshold > 100) {
    errors.warningThreshold = 'Warning threshold must be between 1 and 100';
  }
  if (config.weeklyLimit < config.dailyLimit) {
    errors.weeklyLimit = 'Weekly limit must be greater than or equal to daily limit';
  }
  if (config.monthlyLimit < config.weeklyLimit) {
    errors.monthlyLimit = 'Monthly limit must be greater than or equal to weekly limit';
  }

  return Object.keys(errors).length > 0 ? errors : null;
}

/**
 * Loads budget configuration from localStorage, falling back to defaults.
 *
 * @returns Parsed budget configuration
 */
function loadFromStorage(): BudgetConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<BudgetConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // Corrupted data; fall back to defaults
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Hook for managing budget configuration with localStorage persistence.
 *
 * Loads configuration on mount and provides save/reset/validate operations.
 * Configuration is validated before saving; invalid values are rejected.
 *
 * @returns Budget configuration and management functions
 *
 * @example
 * ```tsx
 * const { config, saveConfig } = useBudgetConfig();
 * const errors = saveConfig({ ...config, dailyLimit: 100 });
 * if (errors) console.log('Validation failed:', errors);
 * ```
 */
export function useBudgetConfig(): UseBudgetConfigResult {
  const [config, setConfig] = useState<BudgetConfig>(loadFromStorage);

  // Sync with localStorage on mount (handle external changes)
  useEffect(() => {
    setConfig(loadFromStorage());
  }, []);

  /**
   * Validates and saves a new budget configuration.
   *
   * @param newConfig - New configuration values
   * @returns Validation errors, or null on success
   */
  const saveConfig = useCallback((newConfig: BudgetConfig): BudgetValidationErrors | null => {
    const errors = validateBudgetConfig(newConfig);
    if (errors) return errors;

    localStorage.setItem(STORAGE_KEY, JSON.stringify(newConfig));
    setConfig(newConfig);
    return null;
  }, []);

  /**
   * Resets configuration to default values.
   */
  const resetConfig = useCallback((): void => {
    localStorage.removeItem(STORAGE_KEY);
    setConfig({ ...DEFAULT_CONFIG });
  }, []);

  return {
    config,
    saveConfig,
    resetConfig,
    validateConfig: validateBudgetConfig,
  };
}
