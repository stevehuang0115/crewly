/**
 * Browser Automation settings (moved from Settings › Skills, now under
 * Marketplace › Installed): enable Playwright for agents, headless and
 * stealth mode, and the human-like delay range. Collapsed by default; the
 * header says whether it is on.
 *
 * @module components/Marketplace/BrowserAutomationSettings
 */

import React, { useEffect, useState } from 'react';
import { AlertCircle, Check, Monitor, Save } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { Toggle } from '@crewly/ui/Toggle';
import { FormInput, FormLabel } from '@crewly/ui/Form';
import { CollapsibleSection } from '@crewly/ui';
import { useSettings } from '../../hooks/useSettings';
import type { CrewlySettings } from '../../types/settings.types';

type SkillSettings = CrewlySettings['skills'];

/**
 * One-line summary of the current browser settings for the collapsed header.
 *
 * @param s - Browser settings
 * @returns e.g. "On · headless", "Off"
 */
export function browserAutomationSummary(s: SkillSettings): string {
  if (!s.enableBrowserAutomation) return 'Off';
  const bits = ['On'];
  if (s.browserProfile?.headless) bits.push('headless');
  if (s.browserProfile?.stealth) bits.push('stealth');
  return bits.join(' · ');
}

/**
 * Browser Automation settings card.
 *
 * @returns The section, or nothing until settings have loaded
 */
export const BrowserAutomationSettings: React.FC = () => {
  const { settings, updateSettings } = useSettings();
  const [browserSettings, setBrowserSettings] = useState<SkillSettings | null>(null);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (settings) {
      setBrowserSettings(settings.skills);
      setHasChanges(false);
    }
  }, [settings]);

  if (!browserSettings) return null;

  const change = <K extends keyof SkillSettings>(field: K, value: SkillSettings[K]) => {
    setBrowserSettings({ ...browserSettings, [field]: value });
    setHasChanges(true);
    setSaveStatus('idle');
  };

  const changeProfile = (field: keyof NonNullable<SkillSettings['browserProfile']>, value: boolean | number) => {
    setBrowserSettings({
      ...browserSettings,
      browserProfile: { ...browserSettings.browserProfile!, [field]: value },
    });
    setHasChanges(true);
    setSaveStatus('idle');
  };

  const save = async () => {
    setSaveStatus('saving');
    try {
      await updateSettings({ skills: browserSettings });
      setSaveStatus('saved');
      setHasChanges(false);
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  return (
    <CollapsibleSection
      title={
        <span className="inline-flex items-center gap-2">
          <Monitor className="h-4 w-4 text-text-3" aria-hidden="true" />
          Browser Automation
        </span>
      }
      summary={browserAutomationSummary(browserSettings)}
      data-testid="browser-automation-settings"
    >
      <div className="space-y-5 pt-2">
        <Toggle
          id="enableBrowserAutomation"
          label="Enable Browser Automation"
          description="Allow agents to use Playwright for browser tasks (navigate, click, screenshot, etc.)"
          checked={browserSettings.enableBrowserAutomation}
          onChange={(e) => change('enableBrowserAutomation', e.target.checked)}
        />

        {browserSettings.enableBrowserAutomation && browserSettings.browserProfile && (
          <div className="space-y-4 border-l-2 border-border-soft pl-4">
            <Toggle
              id="headless"
              label="Headless Mode"
              description="Run browser invisibly in the background (recommended)"
              checked={browserSettings.browserProfile.headless}
              onChange={(e) => changeProfile('headless', e.target.checked)}
            />
            <Toggle
              id="stealth"
              label="Stealth Mode"
              description="Use anti-detection features to avoid bot blocking (uses community fork)"
              checked={browserSettings.browserProfile.stealth}
              onChange={(e) => changeProfile('stealth', e.target.checked)}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <FormLabel htmlFor="humanDelayMin">Min Delay (ms)</FormLabel>
                <FormInput
                  id="humanDelayMin"
                  type="number"
                  min={0}
                  max={browserSettings.browserProfile.humanDelayMaxMs}
                  value={browserSettings.browserProfile.humanDelayMinMs}
                  onChange={(e) => changeProfile('humanDelayMinMs', parseInt(e.target.value, 10) || 0)}
                />
                <p className="mt-1 text-xs text-text-2">Minimum delay between actions</p>
              </div>
              <div>
                <FormLabel htmlFor="humanDelayMax">Max Delay (ms)</FormLabel>
                <FormInput
                  id="humanDelayMax"
                  type="number"
                  min={browserSettings.browserProfile.humanDelayMinMs}
                  max={10000}
                  value={browserSettings.browserProfile.humanDelayMaxMs}
                  onChange={(e) => changeProfile('humanDelayMaxMs', parseInt(e.target.value, 10) || 0)}
                />
                <p className="mt-1 text-xs text-text-2">Maximum delay between actions</p>
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1 text-sm text-success">
              <Check className="h-4 w-4" aria-hidden="true" /> Saved
            </span>
          )}
          {saveStatus === 'error' && (
            <span className="flex items-center gap-1 text-sm text-danger">
              <AlertCircle className="h-4 w-4" aria-hidden="true" /> Save failed
            </span>
          )}
          <Button onClick={save} disabled={!hasChanges || saveStatus === 'saving'} icon={Save} size="sm">
            {saveStatus === 'saving' ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </CollapsibleSection>
  );
};

export default BrowserAutomationSettings;
