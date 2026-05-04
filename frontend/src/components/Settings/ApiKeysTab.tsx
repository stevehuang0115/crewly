/**
 * ApiKeysTab Component
 *
 * Settings tab for managing global API keys and per-runtime/per-skill overrides.
 * Keys are masked in the UI and validated against provider APIs.
 *
 * @module components/Settings/ApiKeysTab
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Save, RotateCcw, Check, AlertCircle, Eye, EyeOff, ChevronDown, ChevronRight, Zap, Key } from 'lucide-react';
import { useSettings } from '../../hooks/useSettings';
import { settingsService } from '../../services/settings.service';
import {
  ApiKeysSettings,
  ApiKeyProvider,
  API_KEY_PROVIDERS,
  AI_RUNTIMES,
  AI_RUNTIME_DISPLAY_NAMES,
  ApiKeyConfig,
} from '../../types/settings.types';
import { Alert } from '../UI/Alert';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { Toggle } from '../UI/Toggle';
import { FormInput, FormLabel } from '../UI/Form';

/**
 * Display name for each provider
 */
const PROVIDER_DISPLAY_NAMES: Record<ApiKeyProvider, string> = {
  gemini: 'Google Gemini',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
};

/**
 * Environment variable hint for each provider
 */
const PROVIDER_ENV_HINTS: Record<ApiKeyProvider, string> = {
  gemini: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
type TestStatus = Record<string, 'idle' | 'testing' | 'valid' | 'invalid'>;

/** Delay in ms before resetting save status back to idle. */
const SAVE_STATUS_RESET_DELAY_MS = 2_000;

/**
 * API Keys settings tab for managing provider API keys
 *
 * @returns ApiKeysTab component
 */
export const ApiKeysTab: React.FC = () => {
  const { settings, updateSettings, isLoading, error } = useSettings();
  const [localApiKeys, setLocalApiKeys] = useState<ApiKeysSettings>({
    global: {},
    runtimeOverrides: {},
    skillOverrides: {},
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const [testStatus, setTestStatus] = useState<TestStatus>({});
  const [testErrors, setTestErrors] = useState<Record<string, string>>({});
  const [expandedRuntimes, setExpandedRuntimes] = useState<Record<string, boolean>>({});

  // Sync local state with fetched settings
  useEffect(() => {
    if (settings?.apiKeys) {
      setLocalApiKeys(settings.apiKeys);
      setHasChanges(false);
    }
  }, [settings]);

  /**
   * Handle global key change
   */
  const handleGlobalKeyChange = useCallback((provider: ApiKeyProvider, value: string) => {
    setLocalApiKeys(prev => ({
      ...prev,
      global: { ...prev.global, [provider]: value },
    }));
    setHasChanges(true);
    setSaveStatus('idle');
    // Reset test status when key changes
    setTestStatus(prev => ({ ...prev, [`global-${provider}`]: 'idle' }));
  }, []);

  /**
   * Handle runtime override toggle/change
   */
  const handleRuntimeOverrideChange = useCallback((
    runtime: string,
    provider: ApiKeyProvider,
    field: 'source' | 'key',
    value: string
  ) => {
    setLocalApiKeys(prev => {
      const existing = prev.runtimeOverrides?.[runtime]?.[provider] ?? { key: '', source: 'global' as const };
      const updated: ApiKeyConfig = { ...existing, [field]: value };
      return {
        ...prev,
        runtimeOverrides: {
          ...prev.runtimeOverrides,
          [runtime]: {
            ...prev.runtimeOverrides?.[runtime],
            [provider]: updated,
          },
        },
      };
    });
    setHasChanges(true);
    setSaveStatus('idle');
  }, []);

  /**
   * Save API keys
   */
  const handleSave = async () => {
    setSaveStatus('saving');
    setSaveError(null);
    try {
      await updateSettings({ apiKeys: localApiKeys });
      setSaveStatus('saved');
      setHasChanges(false);
      setTimeout(() => setSaveStatus('idle'), SAVE_STATUS_RESET_DELAY_MS);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
    }
  };

  /**
   * Test an API key
   */
  const handleTestKey = async (provider: ApiKeyProvider, key: string, statusKey: string) => {
    if (!key || key.startsWith('••••')) return;

    setTestStatus(prev => ({ ...prev, [statusKey]: 'testing' }));
    setTestErrors(prev => ({ ...prev, [statusKey]: '' }));

    try {
      const result = await settingsService.testApiKey(provider, key);
      setTestStatus(prev => ({ ...prev, [statusKey]: result.valid ? 'valid' : 'invalid' }));
      if (!result.valid && result.error) {
        setTestErrors(prev => ({ ...prev, [statusKey]: result.error! }));
      }
    } catch {
      setTestStatus(prev => ({ ...prev, [statusKey]: 'invalid' }));
      setTestErrors(prev => ({ ...prev, [statusKey]: 'Connection failed' }));
    }
  };

  /**
   * Toggle key visibility
   */
  const toggleShowKey = (id: string) => {
    setShowKeys(prev => ({ ...prev, [id]: !prev[id] }));
  };

  /**
   * Toggle runtime expansion
   */
  const toggleRuntime = (runtime: string) => {
    setExpandedRuntimes(prev => ({ ...prev, [runtime]: !prev[runtime] }));
  };

  /**
   * Get status indicator for a key
   */
  const getKeyStatus = (key: string | undefined, statusKey: string): React.ReactNode => {
    const status = testStatus[statusKey];
    if (status === 'testing') {
      return <span className="text-xs text-text-secondary-dark animate-pulse">Testing...</span>;
    }
    if (status === 'valid') {
      return <span className="flex items-center gap-1 text-xs text-green-400"><Check className="w-3 h-3" /> Valid</span>;
    }
    if (status === 'invalid') {
      return <span className="flex items-center gap-1 text-xs text-red-400"><AlertCircle className="w-3 h-3" /> {testErrors[statusKey] || 'Invalid'}</span>;
    }
    if (key && !key.startsWith('••••')) {
      return <span className="flex items-center gap-1 text-xs text-green-400"><Check className="w-3 h-3" /> Configured</span>;
    }
    if (key && key.startsWith('••••')) {
      return <span className="flex items-center gap-1 text-xs text-blue-400"><Key className="w-3 h-3" /> Saved</span>;
    }
    return <span className="flex items-center gap-1 text-xs text-text-secondary-dark"><AlertCircle className="w-3 h-3" /> Not set</span>;
  };

  if (isLoading) {
    return <div className="text-text-secondary-dark">Loading settings...</div>;
  }

  if (error) {
    return (
      <Alert variant="error">{error}</Alert>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header with save/reset buttons */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">API Keys</h2>
          <p className="text-sm text-text-secondary-dark mt-1">
            Configure AI provider API keys. Keys are encrypted at rest and never logged.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || saveStatus === 'saving'}
          >
            {saveStatus === 'saving' ? (
              <><RotateCcw className="w-4 h-4 animate-spin" /> Saving...</>
            ) : saveStatus === 'saved' ? (
              <><Check className="w-4 h-4" /> Saved</>
            ) : (
              <><Save className="w-4 h-4" /> Save Changes</>
            )}
          </Button>
        </div>
      </div>

      {saveStatus === 'error' && saveError && (
        <Alert variant="error">{saveError}</Alert>
      )}

      {/* Global Keys Section */}
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <Key className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-medium">Global API Keys</h3>
        </div>
        <p className="text-sm text-text-secondary-dark mb-6">
          These keys are used system-wide as defaults. Runtimes and skills can override them with their own keys.
        </p>

        <div className="space-y-5">
          {API_KEY_PROVIDERS.map(provider => {
            const globalKey = localApiKeys.global[provider] || '';
            const statusKey = `global-${provider}`;
            const isVisible = showKeys[statusKey];

            return (
              <div key={provider} className="space-y-1">
                <div className="flex items-center justify-between">
                  <FormLabel htmlFor={`global-${provider}`}>
                    {PROVIDER_DISPLAY_NAMES[provider]}
                  </FormLabel>
                  {getKeyStatus(globalKey, statusKey)}
                </div>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <FormInput
                      id={`global-${provider}`}
                      type={isVisible ? 'text' : 'password'}
                      value={globalKey}
                      onChange={(e) => handleGlobalKeyChange(provider, e.target.value)}
                      placeholder={`Enter ${PROVIDER_ENV_HINTS[provider]}`}
                      className="pr-10 font-mono text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => toggleShowKey(statusKey)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary-dark hover:text-text-primary-dark"
                      aria-label={isVisible ? 'Hide key' : 'Show key'}
                    >
                      {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleTestKey(provider, globalKey, statusKey)}
                    disabled={!globalKey || globalKey.startsWith('••••') || testStatus[statusKey] === 'testing'}
                  >
                    <Zap className="w-4 h-4" />
                    Test
                  </Button>
                </div>
                <p className="text-xs text-text-secondary-dark">
                  Env var: <code className="bg-surface-dark px-1 rounded">{PROVIDER_ENV_HINTS[provider]}</code>
                </p>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Runtime Overrides Section */}
      <Card padding="lg">
        <div className="flex items-center gap-2 mb-4">
          <Zap className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-medium">Runtime Overrides</h3>
        </div>
        <p className="text-sm text-text-secondary-dark mb-4">
          Override global keys for specific AI runtimes. By default, runtimes use the global key.
        </p>

        <div className="space-y-2">
          {AI_RUNTIMES.map(runtime => {
            const isExpanded = expandedRuntimes[runtime];

            return (
              <div key={runtime} className="border border-border-dark rounded-lg">
                <button
                  type="button"
                  onClick={() => toggleRuntime(runtime)}
                  className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-surface-dark/50 rounded-lg"
                >
                  <span>{AI_RUNTIME_DISPLAY_NAMES[runtime]}</span>
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-text-secondary-dark" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-text-secondary-dark" />
                  )}
                </button>

                {isExpanded && (
                  <div className="px-4 pb-4 space-y-4 border-t border-border-dark pt-4">
                    {API_KEY_PROVIDERS.map(provider => {
                      const override = localApiKeys.runtimeOverrides?.[runtime]?.[provider];
                      const isCustom = override?.source === 'custom';
                      const overrideKey = isCustom ? (override?.key || '') : '';
                      const statusKey = `runtime-${runtime}-${provider}`;

                      return (
                        <div key={provider} className="space-y-2">
                          <div className="flex items-center justify-between">
                            <FormLabel htmlFor={`${runtime}-${provider}-toggle`}>
                              {PROVIDER_DISPLAY_NAMES[provider]}
                            </FormLabel>
                            <Toggle
                              id={`${runtime}-${provider}-toggle`}
                              size="sm"
                              label={isCustom ? 'Custom key' : 'Use global'}
                              checked={isCustom}
                              onChange={(e) => handleRuntimeOverrideChange(
                                runtime, provider, 'source',
                                e.target.checked ? 'custom' : 'global'
                              )}
                            />
                          </div>

                          {isCustom && (
                            <div className="flex gap-2">
                              <div className="relative flex-1">
                                <FormInput
                                  type={showKeys[statusKey] ? 'text' : 'password'}
                                  value={overrideKey}
                                  onChange={(e) => handleRuntimeOverrideChange(
                                    runtime, provider, 'key', e.target.value
                                  )}
                                  placeholder={`Custom ${PROVIDER_DISPLAY_NAMES[provider]} key for ${AI_RUNTIME_DISPLAY_NAMES[runtime]}`}
                                  className="pr-10 font-mono text-sm"
                                />
                                <button
                                  type="button"
                                  onClick={() => toggleShowKey(statusKey)}
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary-dark hover:text-text-primary-dark"
                                >
                                  {showKeys[statusKey] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                              </div>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleTestKey(provider, overrideKey, statusKey)}
                                disabled={!overrideKey || overrideKey.startsWith('••••') || testStatus[statusKey] === 'testing'}
                              >
                                <Zap className="w-4 h-4" />
                                Test
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};

export default ApiKeysTab;
