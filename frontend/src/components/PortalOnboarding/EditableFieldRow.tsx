/**
 * EditableFieldRow Component
 *
 * A single row in a review card showing an AI-extracted field value
 * with its confidence pill, source disclosure link, and inline edit capability.
 * When edited manually, confidence changes to "Manual" and source to "User confirmed".
 *
 * @module components/PortalOnboarding/EditableFieldRow
 */

import React, { useState, useCallback } from 'react';
import { Pencil, Check, RotateCcw, Info } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import { FormInput } from '@crewly/ui/Form';
import type { PrefillField, PrefillConfidence, PrefillExtractionMethod } from '../../types/onboarding.types';
import { ConfidencePill } from './ConfidencePill';
import { SourceDrawer } from './SourceDrawer';

export interface EditableFieldRowProps {
  /** Display label for the field */
  label: string;
  /** The prefill field data (null if not extracted) */
  field: PrefillField | null;
  /** Whether this field is required for confirmation */
  required: boolean;
  /** Called when the user edits the value */
  onEdit: (newValue: string | string[]) => void;
  /** Called when the user resets to AI draft */
  onReset?: () => void;
  /** Whether the field has been manually edited */
  isEdited?: boolean;
}

/**
 * Renders an editable field row with confidence, source link, and inline edit.
 *
 * @param props - Field row configuration
 * @returns EditableFieldRow element
 */
export const EditableFieldRow: React.FC<EditableFieldRowProps> = ({
  label,
  field,
  required,
  onEdit,
  onReset,
  isEdited = false,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [showSource, setShowSource] = useState(false);

  const displayValue = field?.value;
  const confidence: PrefillConfidence | 'manual' = isEdited
    ? 'manual'
    : field?.confidence ?? 'low';
  const extractionMethod: PrefillExtractionMethod = isEdited
    ? 'manual'
    : field?.extractionMethod ?? 'manual';

  /** Start inline editing */
  const handleStartEdit = useCallback(() => {
    const current = Array.isArray(displayValue)
      ? displayValue.join(', ')
      : displayValue ?? '';
    setEditValue(current);
    setIsEditing(true);
  }, [displayValue]);

  /** Save the edit */
  const handleSaveEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed) {
      // If original was array, split by comma
      if (Array.isArray(field?.value)) {
        onEdit(trimmed.split(',').map((s) => s.trim()).filter(Boolean));
      } else {
        onEdit(trimmed);
      }
    }
    setIsEditing(false);
  }, [editValue, field?.value, onEdit]);

  /** Format value for display */
  const formatValue = (val: string | string[] | undefined): string => {
    if (!val) return 'Not detected';
    if (Array.isArray(val)) return val.join(' / ');
    return val;
  };

  const isEmpty = !displayValue || (Array.isArray(displayValue) && displayValue.length === 0);

  return (
    <div
      className="py-3 border-b border-border-dark/50 last:border-b-0"
      data-testid={`field-row-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Label + Value */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-text-secondary-dark uppercase tracking-wide">
              {label}
            </span>
            {required && isEmpty && (
              <span className="text-xs text-red-400">Required</span>
            )}
          </div>

          {isEditing ? (
            <div className="flex items-center gap-2">
              <FormInput
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveEdit();
                  if (e.key === 'Escape') setIsEditing(false);
                }}
                className="flex-1"
                autoFocus
                data-testid="field-edit-input"
              />
              <IconButton
                icon={Check}
                size="xs"
                onClick={handleSaveEdit}
                className="text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-400"
                aria-label="Save edit"
                data-testid="field-save-btn"
              />
            </div>
          ) : (
            <p
              className={`text-sm ${
                isEmpty
                  ? 'text-text-secondary-dark italic'
                  : 'text-text-primary-dark'
              }`}
            >
              {formatValue(displayValue)}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0 pt-1">
          <ConfidencePill confidence={confidence} />

          {field && !isEditing && (
            <>
              {field.sourceUrls?.length > 0 && (
                <IconButton
                  icon={Info}
                  size="xs"
                  onClick={() => setShowSource((prev) => !prev)}
                  className="hover:text-primary hover:bg-primary/10"
                  aria-label={`Why we think ${label}`}
                  data-testid="field-source-btn"
                />
              )}

              <IconButton
                icon={Pencil}
                size="xs"
                onClick={handleStartEdit}
                className="hover:text-primary hover:bg-primary/10"
                aria-label={`Edit ${label}`}
                data-testid="field-edit-btn"
              />

              {isEdited && onReset && (
                <IconButton
                  icon={RotateCcw}
                  size="xs"
                  onClick={onReset}
                  className="hover:text-amber-400 hover:bg-amber-500/10"
                  aria-label="Reset to AI draft"
                  data-testid="field-reset-btn"
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Source drawer */}
      {field && (
        <SourceDrawer
          isOpen={showSource}
          onClose={() => setShowSource(false)}
          fieldLabel={label}
          confidence={field.confidence}
          sourceUrls={field.sourceUrls}
          sourceSnippet={field.sourceSnippet}
          extractionMethod={extractionMethod}
        />
      )}
    </div>
  );
};

EditableFieldRow.displayName = 'EditableFieldRow';
