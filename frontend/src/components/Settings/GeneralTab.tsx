/**
 * GeneralTab Component
 *
 * General settings tab for configuring application-wide options.
 * What people change is visible (agents, chat basics); the rest sits under a
 * collapsed "Advanced" (specs/2026-10-02-ui-redesign.md, simplify rules).
 *
 * @uses LoadingSpinner from UI library
 * @module components/Settings/GeneralTab
 */

import React, { useEffect, useState } from 'react';
import { Save, RotateCcw, Check, HelpCircle } from 'lucide-react';
import { useSettings } from '../../hooks/useSettings';
import { CrewlySettings, AIRuntime, AI_RUNTIMES, AI_RUNTIME_DISPLAY_NAMES } from '../../types/settings.types';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { CollapsibleSection } from '@crewly/ui';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Toggle } from '@crewly/ui/Toggle';
import { FormInput, FormSelect } from '@crewly/ui/Form';
import { getSelectableRuntimes, runtimeOptionLabel } from '../../utils/runtime-options';

/**
 * Save status states
 */
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

/**
 * A titled group of setting rows, separated by hairlines.
 *
 * @param props - Title, optional one-line meta, rows
 * @returns Section
 */
export const SettingsSection: React.FC<{ title: string; meta?: string; children: React.ReactNode }> = ({ title, meta, children }) => (
  <section>
    <h2 className="text-[15px] font-semibold text-text">{title}</h2>
    {meta && <p className="mt-0.5 text-[13px] text-text-2">{meta}</p>}
    <div className="mt-2">{children}</div>
  </section>
);

/**
 * One setting: label + one quiet meta line on the left, the control on the right.
 *
 * @param props - Label, the control's id, meta line, optional "?" tooltip text, stacked layout
 * @returns Row
 */
export const SettingRow: React.FC<{
  label: string;
  htmlFor: string;
  meta?: string;
  help?: string;
  stacked?: boolean;
  children: React.ReactNode;
}> = ({ label, htmlFor, meta, help, stacked = false, children }) => (
  <div
    className={`border-b border-border-soft py-3 last:border-b-0 ${stacked ? 'space-y-2' : 'flex items-center justify-between gap-4'}`}
  >
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <label htmlFor={htmlFor} className="text-[15px] font-semibold text-text">
          {label}
        </label>
        {help && (
          <span title={help} aria-label={help} className="inline-flex text-text-3">
            <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        )}
      </div>
      {meta && <p className="mt-0.5 text-[13px] text-text-2">{meta}</p>}
    </div>
    <div className={stacked ? '' : 'shrink-0'}>{children}</div>
  </div>
);

/**
 * A setting row whose control is an on/off switch.
 *
 * @param props - Input id, label, meta, help, value and change handler
 * @returns Row
 */
const ToggleRow: React.FC<{
  id: string;
  label: string;
  meta?: string;
  help?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}> = ({ id, label, meta, help, checked, onChange }) => (
  <SettingRow label={label} htmlFor={id} meta={meta} help={help}>
    <Toggle id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </SettingRow>
);

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

  const g = localSettings.general;
  const c = localSettings.chat;

  return (
    <div className="max-w-3xl space-y-8" data-testid="general-tab">
      <SettingsSection title="Agents">
        <SettingRow label="Default AI runtime" htmlFor="defaultRuntime" meta="The runtime new agents start on">
          <div className="w-48">
            <FormSelect
              id="defaultRuntime"
              value={g.defaultRuntime}
              onChange={(e) => handleChange('general', 'defaultRuntime', e.target.value as AIRuntime)}
            >
              {getSelectableRuntimes(g.defaultRuntime).map((runtime) => (
                <option key={runtime} value={runtime}>
                  {runtimeOptionLabel(runtime, AI_RUNTIME_DISPLAY_NAMES)}
                </option>
              ))}
            </FormSelect>
          </div>
        </SettingRow>
        <ToggleRow
          id="autoStart"
          label="Auto-start orchestrator"
          meta="Start the orchestrator when Crewly launches"
          checked={g.autoStartOrchestrator}
          onChange={(v) => handleChange('general', 'autoStartOrchestrator', v)}
        />
        <ToggleRow
          id="autoResume"
          label="Auto-resume sessions on restart"
          meta="Resume agent sessions when they restart"
          checked={g.autoResumeOnRestart}
          onChange={(v) => handleChange('general', 'autoResumeOnRestart', v)}
        />
        <ToggleRow
          id="autoUpdate"
          label="Automatic updates"
          meta="Install new releases when no agent is busy, then restart"
          help="npm installs only; CREWLY_AUTO_UPDATE=0 turns it off on a machine."
          checked={g.autoUpdate !== false}
          onChange={(v) => handleChange('general', 'autoUpdate', v)}
        />
        <SettingRow label="Max concurrent agents" htmlFor="maxAgents" meta="Most agents that can run at once">
          <FormInput
            id="maxAgents"
            type="number"
            min={1}
            max={50}
            className="w-24"
            value={g.maxConcurrentAgents}
            onChange={(e) => handleChange('general', 'maxConcurrentAgents', parseInt(e.target.value) || 10)}
          />
        </SettingRow>
        <SettingRow
          label="Agent idle timeout (minutes)"
          htmlFor="idleTimeout"
          meta="Suspend an idle agent after this long. 0 = off."
          help="Takes effect immediately, no restart."
        >
          <FormInput
            id="idleTimeout"
            type="number"
            min={0}
            max={1440}
            className="w-24"
            value={g.agentIdleTimeoutMinutes}
            onChange={(e) => handleChange('general', 'agentIdleTimeoutMinutes', parseInt(e.target.value) || 0)}
          />
        </SettingRow>
        <SettingRow
          label="Max running agents under pressure"
          htmlFor="pressureMaxAgents"
          meta="When the machine is short on memory or CPU, no more than this many agents run at once (orchestrator exempt)."
          help="Takes effect immediately, no restart."
        >
          <FormInput
            id="pressureMaxAgents"
            type="number"
            min={1}
            max={100}
            className="w-24"
            value={g.pressureMaxRunningAgents ?? 6}
            onChange={(e) => handleChange('general', 'pressureMaxRunningAgents', parseInt(e.target.value) || 6)}
          />
        </SettingRow>
        <SettingRow
          label="Idle timeout under pressure (minutes)"
          htmlFor="pressureIdleTimeout"
          meta="Stop idle agents this quickly while the machine is under pressure. 0 = use the normal timeout."
          help="Takes effect immediately, no restart."
        >
          <FormInput
            id="pressureIdleTimeout"
            type="number"
            min={0}
            max={1440}
            className="w-24"
            value={g.pressureIdleTimeoutMinutes ?? 10}
            onChange={(e) => handleChange('general', 'pressureIdleTimeoutMinutes', parseInt(e.target.value) || 0)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Chat">
        <ToggleRow
          id="showTimestamps"
          label="Show timestamps"
          meta="Show the time on each chat message"
          checked={c.showTimestamps}
          onChange={(v) => handleChange('chat', 'showTimestamps', v)}
        />
        <ToggleRow
          id="autoScroll"
          label="Auto-scroll to bottom"
          meta="Scroll to new messages as they arrive"
          checked={c.autoScrollToBottom}
          onChange={(v) => handleChange('chat', 'autoScrollToBottom', v)}
        />
      </SettingsSection>

      <CollapsibleSection
        title="Advanced"
        summary="Check-ins, logging, auditor, runtime commands, chat history"
        data-testid="general-advanced"
      >
        <div className="space-y-8">
          <div>
            <SettingRow label="Check-in interval (minutes)" htmlFor="checkInInterval" meta="How often agents check in with the orchestrator">
              <FormInput
                id="checkInInterval"
                type="number"
                min={1}
                max={60}
                className="w-24"
                value={g.checkInIntervalMinutes}
                onChange={(e) => handleChange('general', 'checkInIntervalMinutes', parseInt(e.target.value) || 5)}
              />
            </SettingRow>
            <ToggleRow
              id="verboseLogging"
              label="Verbose logging"
              meta="Detailed logs for debugging"
              checked={g.verboseLogging}
              onChange={(v) => handleChange('general', 'verboseLogging', v)}
            />
            <ToggleRow
              id="enableProactiveCompact"
              label="Proactive context compaction"
              meta="Run the runtime's compact when output grows large"
              checked={g.enableProactiveCompact}
              onChange={(v) => handleChange('general', 'enableProactiveCompact', v)}
            />
            <ToggleRow
              id="enableSelfEvolution"
              label="Self-evolution mode"
              meta="The orchestrator triages errors and reports bugs"
              help="When on, it reads system and session logs to diagnose problems."
              checked={g.enableSelfEvolution}
              onChange={(v) => handleChange('general', 'enableSelfEvolution', v)}
            />
            <ToggleRow
              id="enableAuditor"
              label="Enable auditor"
              meta="An agent that watches all agents and writes audit reports. Needs a restart."
              checked={g.enableAuditor ?? false}
              onChange={(v) => handleChange('general', 'enableAuditor', v)}
            />
            <ToggleRow
              id="tokenTracking"
              label="Token usage tracking"
              meta="Count tokens per agent and task, shown on the Usage page"
              help="Stored locally in ~/.crewly/token-usage.json."
              checked={g.tokenTracking ?? false}
              onChange={(v) => handleChange('general', 'tokenTracking', v)}
            />
          </div>

          <SettingsSection title="Runtime commands" meta="The command that starts each runtime. Applies on the next agent start.">
            {AI_RUNTIMES.map((runtime) => (
              <SettingRow key={runtime} label={AI_RUNTIME_DISPLAY_NAMES[runtime]} htmlFor={`runtime-cmd-${runtime}`} stacked>
                <FormInput
                  id={`runtime-cmd-${runtime}`}
                  type="text"
                  className="font-mono"
                  value={g.runtimeCommands?.[runtime] ?? ''}
                  onChange={(e) => handleRuntimeCommandChange(runtime, e.target.value)}
                />
              </SettingRow>
            ))}
          </SettingsSection>

          <SettingsSection title="Chat display">
            <ToggleRow
              id="showRawOutput"
              label="Show raw terminal output"
              meta="Raw output next to formatted messages"
              checked={c.showRawTerminalOutput}
              onChange={(v) => handleChange('chat', 'showRawTerminalOutput', v)}
            />
            <ToggleRow
              id="typingIndicator"
              label="Typing indicator"
              meta="Animate while agents are working"
              checked={c.enableTypingIndicator}
              onChange={(v) => handleChange('chat', 'enableTypingIndicator', v)}
            />
            <SettingRow label="Message history limit" htmlFor="maxHistory" meta="Most messages kept in chat history">
              <FormInput
                id="maxHistory"
                type="number"
                min={10}
                max={10000}
                className="w-28"
                value={c.maxMessageHistory}
                onChange={(e) => handleChange('chat', 'maxMessageHistory', parseInt(e.target.value) || 1000)}
              />
            </SettingRow>
          </SettingsSection>
        </div>
      </CollapsibleSection>

      {/* Action Buttons */}
      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-3 border-t border-border-soft bg-bg/95 px-4 py-4 backdrop-blur-sm">
        <Button variant="secondary" onClick={handleReset} icon={RotateCcw}>
          Reset to defaults
        </Button>
        <Button
          onClick={handleSave}
          disabled={!hasChanges || saveStatus === 'saving'}
          icon={saveStatus === 'saved' ? Check : Save}
        >
          {saveStatus === 'saving'
            ? 'Saving...'
            : saveStatus === 'saved'
            ? 'Saved'
            : saveStatus === 'error'
            ? 'Error - Retry'
            : 'Save changes'}
        </Button>
      </div>
    </div>
  );
};

export default GeneralTab;
