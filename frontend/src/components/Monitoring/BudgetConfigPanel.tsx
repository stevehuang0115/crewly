/**
 * BudgetConfigPanel Component
 *
 * Collapsible panel for viewing and editing budget configuration.
 * Read-only by default; an Edit button switches to input mode
 * with validation and Save/Cancel controls.
 *
 * @module components/Monitoring/BudgetConfigPanel
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { FormInput, FormLabel } from '@crewly/ui/Form';
import type { BudgetConfig } from '../../types';
import type { BudgetValidationErrors } from '../../hooks/useBudgetConfig';

/**
 * Props for the BudgetConfigPanel component.
 */
interface BudgetConfigPanelProps {
  /** Current budget configuration */
  config: BudgetConfig;
  /** Callback to save updated configuration; returns validation errors or null */
  onSave: (config: BudgetConfig) => BudgetValidationErrors | null;
  /** Callback to reset configuration to defaults */
  onReset: () => void;
}

/**
 * Configuration field definition for rendering form inputs.
 */
interface FieldDef {
  /** BudgetConfig property key */
  key: keyof BudgetConfig;
  /** Display label */
  label: string;
  /** Unit suffix for display */
  unit: string;
  /** Input step attribute */
  step: number;
}

/** Field definitions for the budget configuration form */
const FIELDS: FieldDef[] = [
  { key: 'dailyLimit', label: 'Daily Limit', unit: 'USD', step: 1 },
  { key: 'weeklyLimit', label: 'Weekly Limit', unit: 'USD', step: 5 },
  { key: 'monthlyLimit', label: 'Monthly Limit', unit: 'USD', step: 10 },
  { key: 'maxTokensPerTask', label: 'Max Tokens / Task', unit: 'tokens', step: 1000 },
  { key: 'warningThreshold', label: 'Warning Threshold', unit: '%', step: 5 },
];

/**
 * Collapsible budget configuration panel with read-only and edit modes.
 *
 * In read-only mode, displays current values in a compact grid.
 * In edit mode, renders number inputs with validation feedback
 * and Save/Cancel buttons.
 *
 * @param props - Configuration, save callback, and reset callback
 * @returns Collapsible panel component
 */
export const BudgetConfigPanel: React.FC<BudgetConfigPanelProps> = ({
  config,
  onSave,
  onReset,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<BudgetConfig>({ ...config });
  const [errors, setErrors] = useState<BudgetValidationErrors | null>(null);

  /**
   * Enters edit mode with a copy of the current configuration.
   */
  const handleEdit = (): void => {
    setDraft({ ...config });
    setErrors(null);
    setIsEditing(true);
  };

  /**
   * Cancels editing and reverts to read-only mode.
   */
  const handleCancel = (): void => {
    setIsEditing(false);
    setErrors(null);
  };

  /**
   * Validates and saves the draft configuration.
   * If validation fails, displays error messages inline.
   */
  const handleSave = (): void => {
    const validationErrors = onSave(draft);
    if (validationErrors) {
      setErrors(validationErrors);
    } else {
      setErrors(null);
      setIsEditing(false);
    }
  };

  /**
   * Updates a single field in the draft configuration.
   *
   * @param key - BudgetConfig field key
   * @param value - New numeric value
   */
  const updateField = (key: keyof BudgetConfig, value: number): void => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Formats a field value for display in read-only mode.
   *
   * @param field - Field definition
   * @param value - Current value
   * @returns Formatted display string
   */
  const formatValue = (field: FieldDef, value: number): string => {
    if (field.unit === 'USD') return `$${value}`;
    if (field.unit === '%') return `${value}%`;
    return value.toLocaleString();
  };

  return (
    <Card padding="none" data-testid="budget-config-panel">
      {/* Header / Toggle */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-background-dark/30 transition-colors rounded-2xl"
        aria-expanded={isOpen}
      >
        <span className="text-sm font-semibold text-text-primary-dark">Budget Configuration</span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-text-secondary-dark" />
        ) : (
          <ChevronRight className="h-4 w-4 text-text-secondary-dark" />
        )}
      </button>

      {/* Collapsible content */}
      {isOpen && (
        <div className="px-4 pb-4 space-y-4">
          {/* Action buttons */}
          <div className="flex gap-2 justify-end">
            {!isEditing ? (
              <Button size="xs" onClick={handleEdit} data-testid="budget-edit-btn">
                Edit
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="xs" onClick={handleCancel} data-testid="budget-cancel-btn">
                  Cancel
                </Button>
                <Button variant="success" size="xs" onClick={handleSave} data-testid="budget-save-btn">
                  Save
                </Button>
              </>
            )}
          </div>

          {/* Fields grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {FIELDS.map((field) => (
              <div key={field.key}>
                <FormLabel className="text-xs text-text-secondary-dark mb-1" htmlFor={`budget-${field.key}`}>
                  {field.label}
                </FormLabel>
                {isEditing ? (
                  <>
                    <FormInput
                      id={`budget-${field.key}`}
                      type="number"
                      value={draft[field.key]}
                      step={field.step}
                      min={0}
                      onChange={(e) => updateField(field.key, parseFloat(e.target.value) || 0)}
                      error={Boolean(errors?.[field.key])}
                      data-testid={`budget-input-${field.key}`}
                    />
                    {errors?.[field.key] && (
                      <p className="text-xs text-red-400 mt-1" role="alert">
                        {errors[field.key]}
                      </p>
                    )}
                  </>
                ) : (
                  <p
                    className="text-sm text-text-primary-dark"
                    data-testid={`budget-value-${field.key}`}
                  >
                    {formatValue(field, config[field.key])}
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Reset button */}
          {!isEditing && (
            <div className="flex justify-end pt-2">
              <Button variant="danger-ghost" size="xs" onClick={onReset} data-testid="budget-reset-btn">
                Reset to Defaults
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
