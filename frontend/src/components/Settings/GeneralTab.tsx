/**
 * GeneralTab Component
 *
 * General settings tab for configuring application-wide options.
 *
 * @uses LoadingSpinner from UI library
 * @module components/Settings/GeneralTab
 */

import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Check } from 'lucide-react';
import { useSettings } from '../../hooks/useSettings';
import { CrewlySettings, AIRuntime, AI_RUNTIMES, AI_RUNTIME_DISPLAY_NAMES } from '../../types/settings.types';
import { Alert } from '../UI/Alert';
import { Button } from '../UI/Button';
import { Card } from '../UI/Card';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Toggle } from '../UI/Toggle';
import { FormInput, FormLabel, FormSelect } from '../UI/Form';

/**
 * Save status states
 */
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * General settings tab for configuring application-wide options
 *
 * @returns GeneralTab component
 */
export const GeneralTab: React.FC = () => {
  const { settings, updateSettings, resetSection, isLoading, error } = useSettings();
  const [localSettings, setLocalSettings] = useState<CrewlySettings | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  // Sync local state with fetched settings
  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
      setHasChanges(false);
    }
  }, [settings]);

  /**
   * Handle setting change
   */
  const handleChange = <K extends keyof CrewlySettings>(
    section: K,
    field: keyof CrewlySettings[K],
    value: CrewlySettings[K][keyof CrewlySettings[K]]
  ) => {
    if (!localSettings) return;

    setLocalSettings({
      ...localSettings,
      [section]: {
        ...localSettings[section],
        [field]: value,
      },
    });
    setHasChanges(true);
    setSaveStatus('idle');
  };

  /**
   * Handle runtime command change for a specific runtime
   */
  const handleRuntimeCommandChange = (runtime: AIRuntime, value: string) => {
    if (!localSettings) return;

    setLocalSettings({
      ...localSettings,
      general: {
        ...localSettings.general,
        runtimeCommands: {
          ...localSettings.general.runtimeCommands,
          [runtime]: value,
        },
      },
    });
    setHasChanges(true);
    setSaveStatus('idle');
  };

  /**
   * Handle save
   */
  const handleSave = async () => {
    if (!localSettings) return;

    setSaveStatus('saving');
    try {
      await updateSettings({
        general: localSettings.general,
        chat: localSettings.chat,
      });
      setSaveStatus('saved');
      setHasChanges(false);
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  /**
   * Handle reset
   */
  const handleReset = async () => {
    if (window.confirm('Reset all general and chat settings to defaults?')) {
      await resetSection('general');
      await resetSection('chat');
      setHasChanges(false);
      setSaveStatus('idle');
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner text="Loading settings..." />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="error">Error loading settings: {error}</Alert>
    );
  }

  if (!localSettings) {
    return null;
  }

  return (
    <div className="space-y-8 max-w-3xl">
      {/* Runtime Settings Section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold mb-4 pb-3 border-b border-border-dark">Runtime Settings</h2>

        <div className="space-y-5">
          <div>
            <FormLabel htmlFor="defaultRuntime">Default AI Runtime</FormLabel>
            <FormSelect
              id="defaultRuntime"
              value={localSettings.general.defaultRuntime}
              onChange={(e) => handleChange('general', 'defaultRuntime', e.target.value as AIRuntime)}
            >
              {(Object.keys(AI_RUNTIME_DISPLAY_NAMES) as AIRuntime[]).map((runtime) => (
                <option key={runtime} value={runtime}>
                  {AI_RUNTIME_DISPLAY_NAMES[runtime]}
                </option>
              ))}
            </FormSelect>
            <p className="text-xs text-text-secondary-dark mt-1">
              The default AI runtime to use for new agents
            </p>
          </div>

          <Toggle
            id="autoStart"
            label="Auto-Start Orchestrator"
            description="Automatically start the orchestrator when Crewly launches"
            checked={localSettings.general.autoStartOrchestrator}
            onChange={(e) => handleChange('general', 'autoStartOrchestrator', e.target.checked)}
          />

          <Toggle
            id="autoResume"
            label="Auto-Resume Sessions on Restart"
            description="Automatically resume agent sessions when they restart"
            checked={localSettings.general.autoResumeOnRestart}
            onChange={(e) => handleChange('general', 'autoResumeOnRestart', e.target.checked)}
          />

          <div>
            <FormLabel htmlFor="checkInInterval">Check-in Interval (minutes)</FormLabel>
            <FormInput
              id="checkInInterval"
              type="number"
              min={1}
              max={60}
              value={localSettings.general.checkInIntervalMinutes}
              onChange={(e) => handleChange('general', 'checkInIntervalMinutes', parseInt(e.target.value) || 5)}
            />
            <p className="text-xs text-text-secondary-dark mt-1">
              How often agents should check in with the orchestrator
            </p>
          </div>

          <div>
            <FormLabel htmlFor="maxAgents">Max Concurrent Agents</FormLabel>
            <FormInput
              id="maxAgents"
              type="number"
              min={1}
              max={50}
              value={localSettings.general.maxConcurrentAgents}
              onChange={(e) => handleChange('general', 'maxConcurrentAgents', parseInt(e.target.value) || 10)}
            />
            <p className="text-xs text-text-secondary-dark mt-1">
              Maximum number of agents that can run simultaneously
            </p>
          </div>

          <Toggle
            id="verboseLogging"
            label="Verbose Logging"
            description="Enable detailed logging for debugging"
            checked={localSettings.general.verboseLogging}
            onChange={(e) => handleChange('general', 'verboseLogging', e.target.checked)}
          />

          <Toggle
            id="enableProactiveCompact"
            label="Proactive Context Compaction"
            description="Automatically run runtime compact/compress when output volume grows large"
            checked={localSettings.general.enableProactiveCompact}
            onChange={(e) => handleChange('general', 'enableProactiveCompact', e.target.checked)}
          />

          <Toggle
            id="enableSelfEvolution"
            label="Self Evolution Mode"
            description="Orchestrator monitors for errors, triages issues, and reports bugs. When enabled, the orchestrator will proactively read system and session logs to diagnose problems."
            checked={localSettings.general.enableSelfEvolution}
            onChange={(e) => handleChange('general', 'enableSelfEvolution', e.target.checked)}
          />

          <Toggle
            id="enableAuditor"
            label="Enable Auditor"
            description="Run the auditor agent — an autonomous quality observer that monitors all agents, detects problems, and writes audit reports. Requires server restart to take effect."
            checked={localSettings.general.enableAuditor ?? false}
            onChange={(e) => handleChange('general', 'enableAuditor', e.target.checked)}
          />

          <div>
            <FormLabel htmlFor="idleTimeout">Agent Idle Timeout (minutes)</FormLabel>
            <FormInput
              id="idleTimeout"
              type="number"
              min={0}
              max={1440}
              value={localSettings.general.agentIdleTimeoutMinutes}
              onChange={(e) => handleChange('general', 'agentIdleTimeoutMinutes', parseInt(e.target.value) || 0)}
            />
            <p className="text-xs text-text-secondary-dark mt-1">
              Minutes of inactivity before an agent is automatically suspended. Set to 0 to disable.
              Changes take effect immediately — no restart required.
            </p>
          </div>
        </div>
      </Card>

      {/* Runtime Commands Section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold mb-2 pb-3 border-b border-border-dark">Runtime Commands</h2>
        <p className="text-sm text-text-secondary-dark mb-4">
          Configure the CLI command used to start each runtime. Changes take effect on next agent start.
        </p>

        <div className="space-y-5">
          {AI_RUNTIMES.map((runtime) => (
            <div key={runtime}>
              <FormLabel htmlFor={`runtime-cmd-${runtime}`}>
                {AI_RUNTIME_DISPLAY_NAMES[runtime]}
              </FormLabel>
              <FormInput
                id={`runtime-cmd-${runtime}`}
                type="text"
                value={localSettings.general.runtimeCommands?.[runtime] ?? ''}
                onChange={(e) => handleRuntimeCommandChange(runtime, e.target.value)}
              />
            </div>
          ))}
        </div>
      </Card>

      {/* Chat Settings Section */}
      <Card padding="lg">
        <h2 className="text-lg font-semibold mb-4 pb-3 border-b border-border-dark">Chat Settings</h2>

        <div className="space-y-5">
          <Toggle
            id="showRawOutput"
            label="Show Raw Terminal Output"
            description="Display raw terminal output alongside formatted messages"
            checked={localSettings.chat.showRawTerminalOutput}
            onChange={(e) => handleChange('chat', 'showRawTerminalOutput', e.target.checked)}
          />

          <Toggle
            id="typingIndicator"
            label="Enable Typing Indicator"
            description="Show typing animation when agents are processing"
            checked={localSettings.chat.enableTypingIndicator}
            onChange={(e) => handleChange('chat', 'enableTypingIndicator', e.target.checked)}
          />

          <div>
            <FormLabel htmlFor="maxHistory">Message History Limit</FormLabel>
            <FormInput
              id="maxHistory"
              type="number"
              min={10}
              max={10000}
              value={localSettings.chat.maxMessageHistory}
              onChange={(e) => handleChange('chat', 'maxMessageHistory', parseInt(e.target.value) || 1000)}
            />
            <p className="text-xs text-text-secondary-dark mt-1">
              Maximum number of messages to keep in chat history
            </p>
          </div>

          <Toggle
            id="autoScroll"
            label="Auto-Scroll to Bottom"
            description="Automatically scroll to new messages"
            checked={localSettings.chat.autoScrollToBottom}
            onChange={(e) => handleChange('chat', 'autoScrollToBottom', e.target.checked)}
          />

          <Toggle
            id="showTimestamps"
            label="Show Timestamps"
            description="Display timestamps on chat messages"
            checked={localSettings.chat.showTimestamps}
            onChange={(e) => handleChange('chat', 'showTimestamps', e.target.checked)}
          />
        </div>
      </Card>

      {/* Action Buttons */}
      <div className="sticky bottom-0 bg-background-dark/95 backdrop-blur-sm border-t border-border-dark pt-4 pb-4 -mx-4 px-4 flex items-center justify-end gap-3">
        <Button variant="secondary" onClick={handleReset} icon={RotateCcw}>
          Reset to Defaults
        </Button>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saveStatus === 'saving'}
          icon={saveStatus === 'saved' ? Check : Save}
        >
          {saveStatus === 'saving'
            ? 'Saving...'
            : saveStatus === 'saved'
            ? 'Saved!'
            : saveStatus === 'error'
            ? 'Error - Retry'
            : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
};

export default GeneralTab;
