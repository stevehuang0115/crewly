/**
 * RoleEditor Component
 *
 * Modal dialog for creating or editing roles.
 *
 * @module components/Settings/RoleEditor
 */

import React, { useState, useEffect } from 'react';
import { Check } from 'lucide-react';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { useRole } from '../../hooks/useRole';
import { useSkills } from '../../hooks/useSkills';
import {
  CreateRoleInput,
  UpdateRoleInput,
  RoleCategory,
  ROLE_CATEGORIES,
  ROLE_CATEGORY_DISPLAY_NAMES,
} from '../../types/role.types';
import { Button } from '@crewly/ui/Button';
import { Alert } from '@crewly/ui/Alert';
import { Modal } from '@crewly/ui/Modal';
import { Popup } from '@crewly/ui/Popup';
import { Toggle } from '@crewly/ui/Toggle';
import { FormInput, FormLabel, FormSelect, FormTextarea } from '@crewly/ui/Form';

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

  const footer = (
    <>
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
    </>
  );

  if (isLoading && roleId) {
    return (
      <Modal isOpen onClose={onClose} size="sm">
        <div className="flex justify-center">
          <LoadingSpinner text="Loading role..." />
        </div>
      </Modal>
    );
  }

  return (
    <Popup
      isOpen
      onClose={onClose}
      title={isCreating ? 'Create Role' : 'Edit Role'}
      subtitle={isCreating ? 'Configure a new agent role' : 'Modify role settings and prompt'}
      size="xl"
      className="max-w-2xl"
      footer={footer}
    >
      {/* Body scrolls on its own so the header and footer stay in view. */}
      <div className="-m-6 max-h-[65vh] overflow-y-auto">
        {/* Built-in Role Notice */}
        {isBuiltin && !isCreating && (
          <Alert variant="info" className="mx-6 mt-4">
            <strong>Built-in Role:</strong> Changes will be saved as a user override. You can reset to defaults anytime.
            {hasOverride && <span className="ml-1">(Currently has user override)</span>}
          </Alert>
        )}

        {/* Error Banner */}
        {error && (
          <Alert variant="error" className="mx-6 mt-4">
            {error}
          </Alert>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit}>
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
                  className={`flex items-start gap-3 p-3 bg-background-dark border border-border-dark rounded-2xl cursor-pointer hover:border-primary/50 transition-colors ${
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
      </div>
    </Popup>
  );
};

export default RoleEditor;
