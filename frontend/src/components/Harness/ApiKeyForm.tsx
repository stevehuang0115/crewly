/**
 * ApiKeyForm
 *
 * Password field + Save for API-key login. The key is cleared from state
 * the moment it is submitted (before the request resolves) and is never
 * logged.
 *
 * @module components/Harness/ApiKeyForm
 */

import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Alert, Button, Input } from '@crewly/ui';
import type { HarnessId, HarnessStatus } from '../../types/harness.types';
import { API_KEY_CONSOLE_URLS, API_KEY_NOTES, API_KEY_PLACEHOLDERS } from '../../constants/harness.constants';
import { harnessService } from '../../services/harness.service';

export interface ApiKeyFormProps {
  /** Harness the key is for */
  harnessId: HarnessId;
  /** Field label (e.g. "使用 OpenAI API Key") */
  label: string;
  /** Called with the updated harness status after a successful save */
  onSaved?: (status: HarnessStatus) => void;
}

/**
 * API-key login form.
 *
 * @param props - {@link ApiKeyFormProps}
 * @returns Form element
 */
export const ApiKeyForm: React.FC<ApiKeyFormProps> = ({ harnessId, label, onSaved }) => {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const consoleLink = API_KEY_CONSOLE_URLS[harnessId];
  const note = API_KEY_NOTES[harnessId];

  /**
   * Submit the key: clear it from state first, then save.
   *
   * @param e - Form submit event
   */
  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const value = key.trim();
    if (!value) return;
    setKey('');
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const status = await harnessService.setApiKey(harnessId, value);
      setSaved(true);
      onSaved?.(status);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败 / Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3" data-testid="api-key-form">
      <Input
        type="password"
        label={label}
        name={`${harnessId}-api-key`}
        autoComplete="off"
        spellCheck={false}
        placeholder={API_KEY_PLACEHOLDERS[harnessId] ?? 'sk-…'}
        value={key}
        onChange={(e) => setKey(e.target.value)}
        fullWidth
      />
      {note && (
        <p className="text-xs text-text-secondary-dark" data-testid="api-key-note">
          {note}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {consoleLink ? (
          <a
            href={consoleLink.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-2"
          >
            在 {consoleLink.label} 获取 Key
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" loading={saving} disabled={!key.trim() || saving}>
          保存 / Save
        </Button>
      </div>
      {saved && (
        <Alert variant="success" size="sm">
          API Key 已保存。Key saved.
        </Alert>
      )}
      {error && (
        <Alert variant="error" size="sm">
          {error}
        </Alert>
      )}
    </form>
  );
};
