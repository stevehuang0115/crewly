/**
 * MissingInfoPromptGroup Component
 *
 * Compact unresolved-field resolution UI at the bottom of the review screen.
 * Shows max 3 prompts for low-confidence or missing required fields.
 *
 * @module components/PortalOnboarding/MissingInfoPromptGroup
 */

import React from 'react';
import { AlertCircle } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

export interface MissingPrompt {
  /** Field key in the prefill */
  key: string;
  /** Display label for the field */
  label: string;
  /** Input type for resolution */
  type: 'text' | 'select' | 'chips';
  /** Options for select/chips type */
  options?: string[];
  /** Whether this field is required */
  required?: boolean;
}

export interface MissingInfoPromptGroupProps {
  /** Prompts to display (max 3 recommended) */
  prompts: MissingPrompt[];
  /** Current values for each prompt key */
  values: Record<string, string | string[]>;
  /** Called when a prompt value changes */
  onChange: (key: string, value: string | string[]) => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders compact input prompts for unresolved fields.
 *
 * @param props - Component props
 * @returns MissingInfoPromptGroup element
 */
export const MissingInfoPromptGroup: React.FC<MissingInfoPromptGroupProps> = ({
  prompts,
  values,
  onChange,
}) => {
  if (prompts.length === 0) return null;

  return (
    <div
      className="rounded-xl bg-surface-dark border border-amber-500/20 p-5 mt-6"
      data-testid="missing-info-prompts"
    >
      <div className="flex items-center gap-2 mb-4">
        <AlertCircle className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-text-primary-dark">
          Help us complete your profile
        </h3>
      </div>

      <div className="space-y-4">
        {prompts.map((prompt) => {
          const currentValue = values[prompt.key] ?? '';

          return (
            <div key={prompt.key} data-testid={`prompt-${prompt.key}`}>
              <label className="block text-sm font-medium text-text-secondary-dark mb-1.5">
                {prompt.label}
                {prompt.required && <span className="text-red-400 ml-1">*</span>}
              </label>

              {prompt.type === 'text' && (
                <input
                  type="text"
                  value={typeof currentValue === 'string' ? currentValue : ''}
                  onChange={(e) => onChange(prompt.key, e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-background-dark border border-border-dark text-sm text-text-primary-dark placeholder:text-text-secondary-dark/50 focus:border-primary focus:outline-none"
                  placeholder={`Enter ${prompt.label.toLowerCase()}`}
                  data-testid={`prompt-input-${prompt.key}`}
                />
              )}

              {prompt.type === 'select' && prompt.options && (
                <select
                  value={typeof currentValue === 'string' ? currentValue : ''}
                  onChange={(e) => onChange(prompt.key, e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-background-dark border border-border-dark text-sm text-text-primary-dark focus:border-primary focus:outline-none"
                  data-testid={`prompt-select-${prompt.key}`}
                >
                  <option value="">Select...</option>
                  {prompt.options.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              )}

              {prompt.type === 'chips' && prompt.options && (
                <div className="flex flex-wrap gap-2" data-testid={`prompt-chips-${prompt.key}`}>
                  {prompt.options.map((opt) => {
                    const selected = Array.isArray(currentValue) && currentValue.includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          const current = Array.isArray(currentValue) ? currentValue : [];
                          const updated = selected
                            ? current.filter((v) => v !== opt)
                            : [...current, opt];
                          onChange(prompt.key, updated);
                        }}
                        className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                          selected
                            ? 'bg-primary/10 border-primary text-primary'
                            : 'bg-background-dark border-border-dark text-text-secondary-dark hover:border-primary/50'
                        }`}
                        data-testid={`prompt-chip-${opt}`}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

MissingInfoPromptGroup.displayName = 'MissingInfoPromptGroup';
