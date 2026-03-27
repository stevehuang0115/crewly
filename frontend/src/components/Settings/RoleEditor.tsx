/**
 * RoleEditor Component
 *
 * Modal dialog for creating or editing roles.
 *
 * @module components/Settings/RoleEditor
 */

import React, { useState, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { useRole } from '../../hooks/useRole';
import { useSkills } from '../../hooks/useSkills';
import {
  CreateRoleInput,
  UpdateRoleInput,
  RoleCategory,
  ROLE_CATEGORIES,
  ROLE_CATEGORY_DISPLAY_NAMES,
} from '../../types/role.types';
import { Button, IconButton } from '../UI/Button';
import { Toggle } from '../UI/Toggle';
import { FormInput, FormLabel, FormSelect, FormTextarea } from '../UI/Form';

/**
 * Props for RoleEditor component
 */
interface RoleEditorProps {
  /** Role ID to edit (null for creating new role) */
  roleId: string | null;
  /** Called when editor should close */
  onClose: () => void;
  /** Called when role is saved */
  onSave: (input: CreateRoleInput | UpdateRoleInput) => Promise<void>;
}

/**
 * Form data structure
 */
interface FormData {
  name: string;
  displayName: string;
  description: string;
  category: RoleCategory;
  systemPromptContent: string;
  assignedSkills: string[];
  isDefault: boolean;
}

/**
 * Modal dialog for creating or editing roles
 *
 * @param props - Component props
 * @returns RoleEditor component
 */
export const RoleEditor: React.FC<RoleEditorProps> = ({
  roleId,
  onClose,
  onSave,
}) => {
  const { role, isLoading } = useRole(roleId);
  const { skills } = useSkills();

  const [formData, setFormData] = useState<FormData>({
    name: '',
    displayName: '',
    description: '',
    category: 'development',
    systemPromptContent: '',
    assignedSkills: [],
    isDefault: false,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCreating = roleId === null;
  const isBuiltin = role?.isBuiltin ?? false;
  const hasOverride = role?.hasOverride ?? false;

  // Populate form when role is loaded
  useEffect(() => {
    if (role) {
      setFormData({
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        category: role.category,
        systemPromptContent: role.systemPromptContent || '',
        assignedSkills: role.assignedSkills,
        isDefault: role.isDefault,
      });
    }
  }, [role]);

  /**
   * Handle form field change
   */
  const handleChange = (
    field: keyof FormData,
    value: string | boolean | string[]
  ) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    setError(null);
  };

  /**
   * Handle skill checkbox toggle
   */
  const handleSkillToggle = (skillId: string) => {
    setFormData((prev) => ({
      ...prev,
      assignedSkills: prev.assignedSkills.includes(skillId)
        ? prev.assignedSkills.filter((id) => id !== skillId)
        : [...prev.assignedSkills, skillId],
    }));
  };

  /**
   * Handle form submission
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSaving(true);

    try {
      if (isCreating) {
        await onSave({
          name: formData.name,
          displayName: formData.displayName,
          description: formData.description,
          category: formData.category,
          systemPromptContent: formData.systemPromptContent,
          assignedSkills: formData.assignedSkills,
          isDefault: formData.isDefault,
        } as CreateRoleInput);
      } else {
        await onSave({
          displayName: formData.displayName,
          description: formData.description,
          category: formData.category,
          systemPromptContent: formData.systemPromptContent,
          assignedSkills: formData.assignedSkills,
          isDefault: formData.isDefault,
        } as UpdateRoleInput);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save role');
    } finally {
      setIsSaving(false);
    }
  };

  /**
   * Handle overlay click (close modal)
   */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  if (isLoading && roleId) {
    return (
      <div
        className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50"
        onClick={handleOverlayClick}
      >
        <div className="bg-surface-dark border border-border-dark rounded-xl shadow-lg p-8">
          <div className="flex justify-center">
            <LoadingSpinner text="Loading role..." />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleOverlayClick}
    >
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-lg w-full max-w-2xl m-4 max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-dark sticky top-0 bg-surface-dark z-10">
          <div>
            <h2 className="text-xl font-semibold text-text-primary-dark">
              {isCreating ? 'Create Role' : 'Edit Role'}
            </h2>
            <p className="text-sm text-text-secondary-dark mt-1">
              {isCreating
                ? 'Configure a new agent role'
                : 'Modify role settings and prompt'}
            </p>
          </div>
          <IconButton
            icon={X}
            onClick={onClose}
            variant="ghost"
            aria-label="Close"
          />
        </div>

        {/* Built-in Role Notice */}
        {isBuiltin && !isCreating && (
          <div className="mx-6 mt-4 bg-blue-500/10 border border-blue-500/30 text-blue-400 px-4 py-3 rounded-lg text-sm">
            <strong>Built-in Role:</strong> Changes will be saved as a user override. You can reset to defaults anytime.
            {hasOverride && <span className="ml-1">(Currently has user override)</span>}
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="mx-6 mt-4 bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          {/* Basic Information Section */}
          <div className="p-6 border-b border-border-dark space-y-4">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
              Basic Information
            </h3>

            <div>
              <FormLabel htmlFor="displayName" required>Display Name</FormLabel>
              <FormInput
                id="displayName"
                type="text"
                value={formData.displayName}
                onChange={(e) => handleChange('displayName', e.target.value)}
                disabled={false}
                required
                placeholder="e.g., Senior Developer"
              />
            </div>

            {isCreating && (
              <div>
                <FormLabel htmlFor="name" required>Internal Name</FormLabel>
                <FormInput
                  id="name"
                  type="text"
                  value={formData.name}
                  onChange={(e) =>
                    handleChange(
                      'name',
                      e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
                    )
                  }
                  pattern="[a-z0-9-]+"
                  required
                  placeholder="e.g., senior-developer"
                />
                <p className="text-xs text-text-secondary-dark mt-1">
                  Lowercase letters, numbers, and hyphens only
                </p>
              </div>
            )}

            <div>
              <FormLabel htmlFor="description">Description</FormLabel>
              <FormTextarea
                id="description"
                value={formData.description}
                onChange={(e) => handleChange('description', e.target.value)}
                disabled={false}
                rows={2}
                placeholder="Brief description of this role's responsibilities"
              />
            </div>

            <div>
              <FormLabel htmlFor="category">Category</FormLabel>
              <FormSelect
                id="category"
                value={formData.category}
                onChange={(e) => handleChange('category', e.target.value as RoleCategory)}
                disabled={false}
              >
                {ROLE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {ROLE_CATEGORY_DISPLAY_NAMES[cat]}
                  </option>
                ))}
              </FormSelect>
            </div>

            <Toggle
              id="isDefault"
              label="Set as default role"
              checked={formData.isDefault}
              onChange={(e) => handleChange('isDefault', e.target.checked)}
            />
          </div>

          {/* System Prompt Section */}
          <div className="p-6 border-b border-border-dark space-y-4">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
              System Prompt
            </h3>
            <div>
              <FormTextarea
                id="systemPrompt"
                value={formData.systemPromptContent}
                onChange={(e) => handleChange('systemPromptContent', e.target.value)}
                disabled={false}
                rows={12}
                placeholder="# Role Name&#10;&#10;You are a..."
                className="font-mono text-sm"
              />
              <p className="text-xs text-text-secondary-dark mt-1">
                Markdown supported. This prompt defines the agent's behavior.
              </p>
            </div>
          </div>

          {/* Assigned Skills Section */}
          <div className="p-6 space-y-4">
            <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
              Assigned Skills
            </h3>
            <div className="space-y-2">
              {skills?.map((skill) => (
                <label
                  key={skill.id}
                  className={`flex items-start gap-3 p-3 bg-background-dark border border-border-dark rounded-lg cursor-pointer hover:border-primary/50 transition-colors ${
                    formData.assignedSkills.includes(skill.id) ? 'border-primary/50 bg-primary/5' : ''
                  }`}
                >
                  <Toggle
                    size="sm"
                    checked={formData.assignedSkills.includes(skill.id)}
                    onChange={() => handleSkillToggle(skill.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium text-text-primary-dark block">
                      {skill.name}
                    </span>
                    <span className="text-xs text-text-secondary-dark block mt-0.5">
                      {skill.description}
                    </span>
                  </div>
                  {formData.assignedSkills.includes(skill.id) && (
                    <Check className="w-4 h-4 text-primary flex-shrink-0" />
                  )}
                </label>
              ))}
              {(!skills || skills.length === 0) && (
                <p className="text-sm text-text-secondary-dark text-center py-6">
                  No skills available. Create skills in the Skills tab.
                </p>
              )}
            </div>
          </div>
        </form>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-border-dark bg-background-dark sticky bottom-0">
          <Button variant="secondary" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            type="submit"
            onClick={handleSubmit}
            disabled={isSaving}
            loading={isSaving}
          >
            {isSaving
              ? 'Saving...'
              : isCreating
              ? 'Create Role'
              : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default RoleEditor;
