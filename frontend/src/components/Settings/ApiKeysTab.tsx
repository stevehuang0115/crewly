/**
 * ApiKeysTab Component
 *
 * Settings tab for managing global API keys and per-runtime/per-skill overrides.
 * Keys are masked in the UI and validated against provider APIs.
 *
 * @module components/Settings/ApiKeysTab
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Save, Check, AlertCircle, Eye, EyeOff, ChevronDown, ChevronRight, Zap, Key } from 'lucide-react';
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
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { CollapsibleSection } from '@crewly/ui';
import { Toggle } from '@crewly/ui/Toggle';
import { FormInput } from '@crewly/ui/Form';

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
      return <span className="text-[13px] text-text-2 animate-pulse">Testing...</span>;
    }
    if (status === 'valid') {
      return <span className="flex items-center gap-1 text-[13px] text-text-2"><Check className="w-3 h-3" /> Valid</span>;
    }
    if (status === 'invalid') {
      return <span className="flex items-center gap-1 text-[13px] font-semibold text-danger"><AlertCircle className="w-3 h-3" /> {testErrors[statusKey] || 'Invalid'}</span>;
    }
    if (key && !key.startsWith('••••')) {
      return <span className="flex items-center gap-1 text-[13px] text-text-2"><Check className="w-3 h-3" /> Configured</span>;
    }
    if (key && key.startsWith('••••')) {
      return <span className="flex items-center gap-1 text-[13px] text-text-2"><Key className="w-3 h-3" /> Saved</span>;
    }
    return <span className="text-[13px] text-text-3">Not set</span>;
  };

  /**
   * Summary of a runtime's overrides, e.g. "Uses global keys" or "Own key: Anthropic".
   */
  const runtimeSummary = (runtime: string): string => {
    const custom = API_KEY_PROVIDERS.filter((p) => localApiKeys.runtimeOverrides?.[runtime]?.[p]?.source === 'custom');
    return custom.length === 0 ? 'Uses global keys' : `Own key: ${custom.map((p) => PROVIDER_DISPLAY_NAMES[p]).join(', ')}`;
  };

  /** Number of runtimes with at least one own key. */
  const customRuntimeCount = AI_RUNTIMES.filter((r) => runtimeSummary(r) !== 'Uses global keys').length;

  if (isLoading) {
    return <LoadingSpinner size="md" text="Loading settings..." />;
  }

  if (error) {
    return (
      <Alert variant="error">{error}</Alert>
    );
  }

  return (
    <div className="max-w-3xl space-y-8" data-testid="api-keys-tab">
      {/* Header with save button */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold text-text">API Keys</h2>
          <p className="mt-0.5 text-[13px] text-text-2">
            AI provider keys for your agents. Encrypted at rest and never logged.
          </p>
        </div>
        <Button
          size="sm"
          onClick={handleSave}
          icon={saveStatus === 'saved' ? Check : Save}
          loading={saveStatus === 'saving'}
          disabled={!hasChanges}
        >
          {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Save changes'}
        </Button>
      </div>

      {saveStatus === 'error' && saveError && (
        <Alert variant="error">{saveError}</Alert>
      )}

      {/* Global Keys Section */}
      <section>
        <h3 className="text-[15px] font-semibold text-text">Global API keys</h3>
        <p className="mt-0.5 text-[13px] text-text-2">Used everywhere unless a runtime has its own key.</p>
        <div className="mt-2">
          {API_KEY_PROVIDERS.map(provider => {
            const globalKey = localApiKeys.global[provider] || '';
            const statusKey = `global-${provider}`;
            const isVisible = showKeys[statusKey];

            return (
              <div key={provider} className="space-y-2 border-b border-border-soft py-3 last:border-b-0" data-testid={`api-key-row-${provider}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <label htmlFor={`global-${provider}`} className="text-[15px] font-semibold text-text">
                      {PROVIDER_DISPLAY_NAMES[provider]}
                    </label>
                    <p className="text-[13px] text-text-3">
                      Env var <code className="font-mono">{PROVIDER_ENV_HINTS[provider]}</code>
                    </p>
                  </div>
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
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-text-2 hover:text-text"
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
                    icon={Zap}
                  >
                    Test
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Runtime Overrides: under Advanced */}
      <CollapsibleSection
        title="Advanced"
        summary={customRuntimeCount === 0 ? 'Runtime overrides: all runtimes use the global keys' : `Runtime overrides: ${customRuntimeCount} with their own key`}
        data-testid="api-keys-advanced"
      >
        <h3 className="text-[15px] font-semibold text-text">Runtime overrides</h3>
        <p className="mt-0.5 text-[13px] text-text-2">Give a runtime its own key. By default, runtimes use the global key.</p>

        <div className="mt-2">
          {AI_RUNTIMES.map(runtime => {
            const isExpanded = expandedRuntimes[runtime];

            return (
              <div key={runtime} className="border-b border-border-soft last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleRuntime(runtime)}
                  aria-expanded={!!isExpanded}
                  className="flex w-full items-center gap-3 py-3 text-left"
                >
                  <span className="text-[15px] font-semibold text-text">{AI_RUNTIME_DISPLAY_NAMES[runtime]}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text-2">{runtimeSummary(runtime)}</span>
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-text-2" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-text-2" />
                  )}
                </button>

                {isExpanded && (
                  <div className="space-y-4 pb-4 pl-4">
                    {API_KEY_PROVIDERS.map(provider => {
                      const override = localApiKeys.runtimeOverrides?.[runtime]?.[provider];
                      const isCustom = override?.source === 'custom';
                      const overrideKey = isCustom ? (override?.key || '') : '';
                      const statusKey = `runtime-${runtime}-${provider}`;

                      return (
                        <div key={provider} className="space-y-2">
                          <div className="flex items-center justify-between gap-3">
                            <label htmlFor={`${runtime}-${provider}-toggle`} className="text-sm font-semibold text-text">
                              {PROVIDER_DISPLAY_NAMES[provider]}
                            </label>
                            <div className="flex items-center gap-3">
                              {isCustom && getKeyStatus(overrideKey, statusKey)}
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
                                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-2 hover:text-text"
                                  aria-label={showKeys[statusKey] ? 'Hide key' : 'Show key'}
                                >
                                  {showKeys[statusKey] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                              </div>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => handleTestKey(provider, overrideKey, statusKey)}
                                disabled={!overrideKey || overrideKey.startsWith('••••') || testStatus[statusKey] === 'testing'}
                                icon={Zap}
                              >
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
      </CollapsibleSection>
    </div>
  );
};

export default ApiKeysTab;
