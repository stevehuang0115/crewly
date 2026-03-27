/**
 * useBudgetConfig Hook Tests
 *
 * @module hooks/useBudgetConfig.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBudgetConfig, validateBudgetConfig } from './useBudgetConfig';
import type { BudgetConfig } from '../types';

const DEFAULT_CONFIG: BudgetConfig = {
  dailyLimit: 50,
  weeklyLimit: 200,
  monthlyLimit: 500,
  maxTokensPerTask: 100000,
  warningThreshold: 80,
};

describe('validateBudgetConfig', () => {
  it('should return null for valid config', () => {
    expect(validateBudgetConfig(DEFAULT_CONFIG)).toBeNull();
  });

  it('should reject negative daily limit', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, dailyLimit: -1 });
    expect(errors).not.toBeNull();
    expect(errors?.dailyLimit).toBeDefined();
  });

  it('should reject zero weekly limit', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, weeklyLimit: 0 });
    expect(errors).not.toBeNull();
    expect(errors?.weeklyLimit).toBeDefined();
  });

  it('should reject weekly < daily', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, dailyLimit: 100, weeklyLimit: 50 });
    expect(errors).not.toBeNull();
    expect(errors?.weeklyLimit).toContain('greater than or equal');
  });

  it('should reject monthly < weekly', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, weeklyLimit: 200, monthlyLimit: 100 });
    expect(errors).not.toBeNull();
    expect(errors?.monthlyLimit).toContain('greater than or equal');
  });

  it('should reject warning threshold > 100', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, warningThreshold: 150 });
    expect(errors).not.toBeNull();
    expect(errors?.warningThreshold).toBeDefined();
  });

  it('should reject warning threshold < 1', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, warningThreshold: 0 });
    expect(errors).not.toBeNull();
    expect(errors?.warningThreshold).toBeDefined();
  });

  it('should reject zero maxTokensPerTask', () => {
    const errors = validateBudgetConfig({ ...DEFAULT_CONFIG, maxTokensPerTask: 0 });
    expect(errors).not.toBeNull();
    expect(errors?.maxTokensPerTask).toBeDefined();
  });
});

describe('useBudgetConfig', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should return default config when localStorage is empty', () => {
    const { result } = renderHook(() => useBudgetConfig());
    expect(result.current.config).toEqual(DEFAULT_CONFIG);
  });

  it('should load config from localStorage', () => {
    const custom: BudgetConfig = { ...DEFAULT_CONFIG, dailyLimit: 100 };
    localStorage.setItem('crewly-budget-config', JSON.stringify(custom));

    const { result } = renderHook(() => useBudgetConfig());
    expect(result.current.config.dailyLimit).toBe(100);
  });

  it('should save valid config to localStorage', () => {
    const { result } = renderHook(() => useBudgetConfig());

    const newConfig = { ...DEFAULT_CONFIG, dailyLimit: 75 };
    let errors: ReturnType<typeof result.current.saveConfig>;

    act(() => {
      errors = result.current.saveConfig(newConfig);
    });

    expect(errors).toBeNull();
    expect(localStorage.getItem('crewly-budget-config')).toBe(JSON.stringify(newConfig));
    expect(result.current.config.dailyLimit).toBe(75);
  });

  it('should reject invalid config on save', () => {
    const { result } = renderHook(() => useBudgetConfig());

    const invalidConfig = { ...DEFAULT_CONFIG, dailyLimit: -5 };
    let errors: ReturnType<typeof result.current.saveConfig>;

    act(() => {
      errors = result.current.saveConfig(invalidConfig);
    });

    expect(errors).not.toBeNull();
    expect(errors?.dailyLimit).toBeDefined();
    // Config should remain unchanged
    expect(result.current.config.dailyLimit).toBe(50);
  });

  it('should reset config to defaults', () => {
    const { result } = renderHook(() => useBudgetConfig());

    // First save custom config
    act(() => {
      result.current.saveConfig({ ...DEFAULT_CONFIG, dailyLimit: 25 });
    });
    expect(result.current.config.dailyLimit).toBe(25);

    // Reset
    act(() => {
      result.current.resetConfig();
    });

    expect(result.current.config).toEqual(DEFAULT_CONFIG);
    expect(localStorage.getItem('crewly-budget-config')).toBeNull();
  });

  it('should handle corrupted localStorage data gracefully', () => {
    localStorage.setItem('crewly-budget-config', 'not-valid-json{{{');

    const { result } = renderHook(() => useBudgetConfig());
    expect(result.current.config).toEqual(DEFAULT_CONFIG);
  });

  it('should provide validateConfig function', () => {
    const { result } = renderHook(() => useBudgetConfig());
    const errors = result.current.validateConfig(DEFAULT_CONFIG);
    expect(errors).toBeNull();
  });
});
