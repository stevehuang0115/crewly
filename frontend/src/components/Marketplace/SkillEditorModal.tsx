/**
 * Skill editor and delete confirmation (moved from Settings › Skills, now
 * used by Marketplace › Installed).
 *
 * @module components/Marketplace/SkillEditorModal
 */

import React, { useState } from 'react';
import type { SkillSummary, SkillCategory } from '../../types/skill.types';
import type { CreateSkillInput } from '../../services/skills.service';
import { Button } from '@crewly/ui/Button';
import { FormInput, FormSelect, FormLabel, FormTextarea } from '@crewly/ui/Form';
import { Alert } from '@crewly/ui/Alert';
import { ConfirmPopup, Popup } from '@crewly/ui/Popup';
import { SKILL_CATEGORY_OPTIONS } from './skill-ui.constants';

// =============================================================================
// Skill Editor Modal
// =============================================================================

/**
 * Props for SkillEditorModal component
 */
export interface SkillEditorModalProps {
  /** Skill to edit (null for create) */
  skill: SkillSummary | null;
  /** Called when save is clicked */
  onSave: (data: CreateSkillInput) => Promise<void>;
  /** Called when close is clicked */
  onClose: () => void;
}

/**
 * Modal for creating or editing a skill
 */
export const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
  skill,
  onSave,
  onClose,
}) => {
  const isBuiltin = skill?.isBuiltin ?? false;
  const [formData, setFormData] = useState<CreateSkillInput>({
    name: skill?.name || '',
    displayName: skill?.name || '',
    description: skill?.description || '',
    category: skill?.category || 'development',
    promptContent: (skill as { promptContent?: string } | null)?.promptContent || '',
    triggers: [],
    tags: [],
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setFormError(null);

    // Validate required fields
    if (!formData.displayName.trim()) {
      setFormError('Display Name is required');
      return;
    }
    if (!formData.name.trim()) {
      setFormError('ID is required');
      return;
    }
    if (!formData.description.trim()) {
      setFormError('Description is required');
      return;
    }

    setSaving(true);
    try {
      await onSave(formData);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save skill');
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose} type="button">
        Cancel
      </Button>
      <Button
        type="submit"
        onClick={handleSubmit}
        disabled={saving}
        loading={saving}
      >
        {saving ? 'Saving...' : 'Save Skill'}
      </Button>
    </>
  );

  return (
    <Popup
      isOpen
      onClose={onClose}
      title={skill ? 'Edit Skill' : 'Create Skill'}
      subtitle={skill ? 'Modify skill configuration' : 'Configure a new skill for your agents'}
      size="lg"
      footer={footer}
    >
      {/* Body scrolls on its own so the header and footer stay in view. */}
      <div className="-m-6 max-h-[65vh] overflow-y-auto">
        {/* Built-in Skill Notice */}
        {isBuiltin && skill && (
          <Alert variant="info" className="mx-6 mt-4">
            <strong>Built-in Skill:</strong> Changes will be saved as a user override. You can reset to defaults anytime.
          </Alert>
        )}

        {/* Form Error */}
        {formError && (
          <div className="mx-6 mt-4">
            <Alert variant="error">
              {formError}
            </Alert>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <FormLabel htmlFor="skill-display-name" required>Display Name</FormLabel>
            <FormInput
              id="skill-display-name"
              type="text"
              value={formData.displayName}
              onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
              placeholder="Code Review"
              required
            />
          </div>

          <div>
            <FormLabel htmlFor="skill-name" required>ID</FormLabel>
            <FormInput
              id="skill-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="code-review"
              required
              disabled={!!skill}
            />
            <p className="text-xs text-text-2 mt-1">
              Lowercase letters, numbers, and hyphens only
            </p>
          </div>

          <div>
            <FormLabel htmlFor="skill-description" required>Description</FormLabel>
            <FormTextarea
              id="skill-description"
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Describe what this skill does..."
              rows={3}
              required
            />
          </div>

          <div>
            <FormLabel htmlFor="skill-category">Category</FormLabel>
            <FormSelect
              id="skill-category"
              value={formData.category}
              onChange={(e) => setFormData({ ...formData, category: e.target.value as SkillCategory })}
            >
              {SKILL_CATEGORY_OPTIONS.filter((o) => o.value).map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </FormSelect>
          </div>

          <div>
            <FormLabel htmlFor="skill-prompt">Instructions (Markdown)</FormLabel>
            <FormTextarea
              id="skill-prompt"
              value={formData.promptContent}
              onChange={(e) => setFormData({ ...formData, promptContent: e.target.value })}
              placeholder="# Skill Instructions&#10;&#10;Provide detailed instructions for this skill..."
              rows={8}
              className="font-mono text-sm"
            />
          </div>
        </form>
      </div>
    </Popup>
  );
};

// =============================================================================
// Delete Confirmation Modal
// =============================================================================

/**
 * Props for DeleteConfirmModal component
 */
export interface DeleteSkillConfirmProps {
  /** ID of skill to delete */
  skillId: string;
  /** Name of skill to delete */
  skillName: string;
  /** Called when delete is confirmed */
  onConfirm: () => void;
  /** Called when cancel is clicked */
  onCancel: () => void;
}

/**
 * Modal for confirming skill deletion
 */
export const DeleteSkillConfirm: React.FC<DeleteSkillConfirmProps> = ({
  skillName,
  onConfirm,
  onCancel,
}) => {
  return (
    <ConfirmPopup
      isOpen
      onClose={onCancel}
      onConfirm={onConfirm}
      title="Delete Skill"
      confirmText="Delete"
      confirmVariant="danger"
      message={
        <p className="text-text-2">
          Are you sure you want to delete <strong className="text-text">{skillName}</strong>?
          This action cannot be undone.
        </p>
      }
    />
  );
};

