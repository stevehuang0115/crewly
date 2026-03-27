/**
 * SkillsTab Component
 *
 * Full skill management interface in Settings.
 * Provides filtering, CRUD operations, and skill execution.
 *
 * @module components/Settings/SkillsTab
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import {
  Target,
  Pencil,
  Trash2,
  AlertTriangle,
  Info,
  AlertCircle,
  ExternalLink,
  Brain,
  Globe,
  Plus,
  RefreshCw,
  X,
  Save,
  Check,
  Monitor,
} from 'lucide-react';
import { useSkills, type UseSkillsOptions } from '../../hooks/useSkills';
import { useSettings } from '../../hooks/useSettings';
import type {
  Skill,
  SkillSummary,
  SkillCategory,
  SkillType,
  SkillNotice,
} from '../../types/skill.types';
import type { CrewlySettings } from '../../types/settings.types';
import type { CreateSkillInput } from '../../services/skills.service';
import { getSkillCategoryLabel, getSkillTypeLabel, SKILL_CATEGORIES } from '../../types/skill.types';
import { Button, IconButton } from '../UI/Button';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { Toggle } from '../UI/Toggle';
import { FormInput, FormSelect, FormLabel, FormTextarea } from '../UI/Form';
import { Card } from '../UI/Card';
import { Alert } from '../UI/Alert';

/**
 * Build category options from the canonical SKILL_CATEGORIES list for consistency.
 * Uses the shared constant to stay in sync with all valid categories.
 */
const buildCategoryOptions = (): { value: SkillCategory | ''; label: string }[] => {
  return [
    { value: '', label: 'All Categories' },
    ...SKILL_CATEGORIES.map((cat) => ({
      value: cat,
      label: getSkillCategoryLabel(cat),
    })),
  ];
};

/**
 * Category filter options derived from skill types
 */
const CATEGORY_OPTIONS = buildCategoryOptions();

/**
 * Category badge color mapping
 */
const CATEGORY_COLORS: Record<SkillCategory, string> = {
  development: 'bg-blue-500/15 text-blue-400',
  design: 'bg-pink-500/15 text-pink-400',
  communication: 'bg-emerald-500/15 text-emerald-400',
  research: 'bg-primary/15 text-primary',
  'content-creation': 'bg-amber-500/15 text-amber-400',
  automation: 'bg-primary/15 text-primary',
  analysis: 'bg-cyan-500/15 text-cyan-400',
  integration: 'bg-rose-500/15 text-rose-400',
  management: 'bg-orange-500/15 text-orange-400',
  monitoring: 'bg-teal-500/15 text-teal-400',
  memory: 'bg-primary/15 text-primary',
  system: 'bg-slate-500/15 text-slate-400',
  'task-management': 'bg-sky-500/15 text-sky-400',
  quality: 'bg-lime-500/15 text-lime-400',
};

/**
 * Skill type badge color mapping
 */
const SKILL_TYPE_COLORS: Record<SkillType, string> = {
  'claude-skill': 'bg-primary/15 text-primary',
  'web-page': 'bg-blue-500/15 text-blue-400',
};

/**
 * SkillsTab component for managing skills
 *
 * @returns SkillsTab component
 */
export const SkillsTab: React.FC = () => {
  // Browser automation settings state
  const { settings, updateSettings } = useSettings();
  const [browserSettings, setBrowserSettings] = useState<CrewlySettings['skills'] | null>(null);
  const [browserHasChanges, setBrowserHasChanges] = useState(false);
  const [browserSaveStatus, setBrowserSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    if (settings) {
      setBrowserSettings(settings.skills);
      setBrowserHasChanges(false);
    }
  }, [settings]);

  const handleBrowserChange = <K extends keyof CrewlySettings['skills']>(
    field: K,
    value: CrewlySettings['skills'][K]
  ) => {
    if (!browserSettings) return;
    setBrowserSettings({ ...browserSettings, [field]: value });
    setBrowserHasChanges(true);
    setBrowserSaveStatus('idle');
  };

  const handleBrowserProfileChange = (
    field: keyof NonNullable<CrewlySettings['skills']['browserProfile']>,
    value: boolean | number
  ) => {
    if (!browserSettings) return;
    setBrowserSettings({
      ...browserSettings,
      browserProfile: {
        ...browserSettings.browserProfile!,
        [field]: value,
      },
    });
    setBrowserHasChanges(true);
    setBrowserSaveStatus('idle');
  };

  const handleBrowserSave = async () => {
    if (!browserSettings) return;
    setBrowserSaveStatus('saving');
    try {
      await updateSettings({ skills: browserSettings });
      setBrowserSaveStatus('saved');
      setBrowserHasChanges(false);
      setTimeout(() => setBrowserSaveStatus('idle'), 2000);
    } catch {
      setBrowserSaveStatus('error');
    }
  };

  // Filter state
  const [categoryFilter, setCategoryFilter] = useState<SkillCategory | ''>('');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal state
  const [showEditor, setShowEditor] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillSummary | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);

  // Build hook options
  const hookOptions: UseSkillsOptions = useMemo(
    () => ({
      category: categoryFilter || undefined,
      search: searchQuery || undefined,
    }),
    [categoryFilter, searchQuery]
  );

  // Fetch skills
  const { skills, loading, error, refresh, create, update, remove, selectSkill, selectedSkill, clearSelection } =
    useSkills(hookOptions);

  /**
   * Handle creating a new skill
   */
  const handleCreate = useCallback((): void => {
    setEditingSkill(null);
    setShowEditor(true);
  }, []);

  /**
   * Handle editing a skill - fetches full skill data including promptContent
   */
  const handleEdit = useCallback(async (skill: SkillSummary): Promise<void> => {
    setEditingSkill(skill);
    await selectSkill(skill.id); // Fetch full skill data with promptContent
    setShowEditor(true);
  }, [selectSkill]);

  /**
   * Handle saving skill (create or update)
   */
  const handleSave = useCallback(
    async (skillData: CreateSkillInput): Promise<void> => {
      try {
        if (editingSkill?.id) {
          await update(editingSkill.id, skillData);
        } else {
          await create(skillData);
        }
        setShowEditor(false);
        setEditingSkill(null);
      } catch (err) {
        console.error('Failed to save skill:', err);
      }
    },
    [editingSkill, update, create]
  );

  /**
   * Handle deleting a skill
   */
  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      try {
        await remove(id);
        setShowDeleteConfirm(null);
      } catch (err) {
        console.error('Failed to delete skill:', err);
      }
    },
    [remove]
  );

  return (
    <div className="space-y-6">
      {/* Browser Automation Settings */}
      {browserSettings && (
        <Card padding="lg">
          <div className="flex items-center gap-2 mb-4">
            <Monitor className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Browser Automation</h2>
          </div>

          <div className="space-y-5">
            <Toggle
              id="enableBrowserAutomation"
              label="Enable Browser Automation"
              description="Allow agents to use Playwright for browser tasks (navigate, click, screenshot, etc.)"
              checked={browserSettings.enableBrowserAutomation}
              onChange={(e) => handleBrowserChange('enableBrowserAutomation', e.target.checked)}
            />

            {browserSettings.enableBrowserAutomation && browserSettings.browserProfile && (
              <div className="pl-4 border-l-2 border-border-dark space-y-4">
                <Toggle
                  id="headless"
                  label="Headless Mode"
                  description="Run browser invisibly in the background (recommended)"
                  checked={browserSettings.browserProfile.headless}
                  onChange={(e) => handleBrowserProfileChange('headless', e.target.checked)}
                />

                <Toggle
                  id="stealth"
                  label="Stealth Mode"
                  description="Use anti-detection features to avoid bot blocking (uses community fork)"
                  checked={browserSettings.browserProfile.stealth}
                  onChange={(e) => handleBrowserProfileChange('stealth', e.target.checked)}
                />

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <FormLabel htmlFor="humanDelayMin">Min Delay (ms)</FormLabel>
                    <FormInput
                      id="humanDelayMin"
                      type="number"
                      min={0}
                      max={browserSettings.browserProfile.humanDelayMaxMs}
                      value={browserSettings.browserProfile.humanDelayMinMs}
                      onChange={(e) => handleBrowserProfileChange('humanDelayMinMs', parseInt(e.target.value, 10) || 0)}
                    />
                    <p className="text-xs text-text-secondary-dark mt-1">Minimum delay between actions</p>
                  </div>
                  <div>
                    <FormLabel htmlFor="humanDelayMax">Max Delay (ms)</FormLabel>
                    <FormInput
                      id="humanDelayMax"
                      type="number"
                      min={browserSettings.browserProfile.humanDelayMinMs}
                      max={10000}
                      value={browserSettings.browserProfile.humanDelayMaxMs}
                      onChange={(e) => handleBrowserProfileChange('humanDelayMaxMs', parseInt(e.target.value, 10) || 0)}
                    />
                    <p className="text-xs text-text-secondary-dark mt-1">Maximum delay between actions</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Save/status bar */}
          <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-border-dark">
            {browserSaveStatus === 'saved' && (
              <span className="text-sm text-emerald-400 flex items-center gap-1">
                <Check className="w-4 h-4" /> Saved
              </span>
            )}
            {browserSaveStatus === 'error' && (
              <span className="text-sm text-rose-400 flex items-center gap-1">
                <AlertCircle className="w-4 h-4" /> Save failed
              </span>
            )}
            <Button
              onClick={handleBrowserSave}
              disabled={!browserHasChanges || browserSaveStatus === 'saving'}
              icon={Save}
              size="sm"
            >
              {browserSaveStatus === 'saving' ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </Card>
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Skills Management</h2>
          <p className="text-sm text-text-secondary-dark mt-1">Create and manage AI agent skills</p>
        </div>
        <Button onClick={handleCreate} icon={Plus}>
          New Skill
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row items-end gap-4">
        <div className="flex-1 w-full md:w-auto">
          <FormLabel htmlFor="category-filter">Category</FormLabel>
          <FormSelect
            id="category-filter"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as SkillCategory | '')}
          >
            {CATEGORY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </FormSelect>
        </div>

        <div className="flex-1 w-full md:w-auto">
          <FormLabel htmlFor="search-filter">Search</FormLabel>
          <FormInput
            id="search-filter"
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <Button
          variant="secondary"
          onClick={refresh}
          disabled={loading}
          icon={RefreshCw}
          className={loading ? 'animate-spin' : ''}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </Button>
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="error">
          <div className="flex items-center justify-between">
            <span>Error: {error}</span>
            <Button variant="outline" size="sm" onClick={refresh}>
              Retry
            </Button>
          </div>
        </Alert>
      )}

      {/* Loading state */}
      {loading && skills.length === 0 && (
        <div className="flex justify-center py-16">
          <LoadingSpinner text="Loading skills..." />
        </div>
      )}

      {/* Empty state */}
      {!loading && skills.length === 0 && !error && (
        <div className="text-center py-16">
          <div className="flex justify-center mb-4">
            <Target className="w-12 h-12 text-text-secondary-dark" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No Skills Found</h3>
          <p className="text-sm text-text-secondary-dark mb-6">
            {searchQuery || categoryFilter
              ? 'Try adjusting your filters'
              : 'Create your first skill to get started'}
          </p>
          {!searchQuery && !categoryFilter && (
            <Button onClick={handleCreate} icon={Plus}>
              Create Skill
            </Button>
          )}
        </div>
      )}

      {/* Skills grid */}
      {skills.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onEdit={() => handleEdit(skill)}
              onDelete={() => setShowDeleteConfirm(skill.id)}
            />
          ))}
        </div>
      )}

      {/* Skill Editor Modal */}
      {showEditor && (
        <SkillEditorModal
          skill={selectedSkill || editingSkill}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false);
            setEditingSkill(null);
            clearSelection();
          }}
        />
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <DeleteConfirmModal
          skillId={showDeleteConfirm}
          skillName={skills.find((s) => s.id === showDeleteConfirm)?.name || ''}
          onConfirm={() => handleDelete(showDeleteConfirm)}
          onCancel={() => setShowDeleteConfirm(null)}
        />
      )}
    </div>
  );
};

// =============================================================================
// Skill Card Component
// =============================================================================

/**
 * Props for SkillCard component
 */
interface SkillCardProps {
  /** Skill to display */
  skill: SkillSummary;
  /** Called when edit is clicked */
  onEdit: () => void;
  /** Called when delete is clicked */
  onDelete: () => void;
}

/**
 * Get icon component for skill type
 */
const getSkillTypeIcon = (skillType: SkillType): React.ReactNode => {
  switch (skillType) {
    case 'claude-skill':
      return <Brain className="w-3.5 h-3.5" />;
    case 'web-page':
      return <Globe className="w-3.5 h-3.5" />;
    default:
      return <Brain className="w-3.5 h-3.5" />;
  }
};

/**
 * Get icon for notice type
 */
const getNoticeIcon = (type: SkillNotice['type']): React.ReactNode => {
  switch (type) {
    case 'warning':
      return <AlertTriangle className="w-4 h-4" />;
    case 'requirement':
      return <AlertCircle className="w-4 h-4" />;
    case 'info':
    default:
      return <Info className="w-4 h-4" />;
  }
};

/**
 * Notice type color mapping
 */
const NOTICE_COLORS: Record<SkillNotice['type'], { bg: string; border: string; icon: string }> = {
  info: { bg: 'bg-blue-500/10', border: 'border-blue-500/20', icon: 'text-blue-400' },
  warning: { bg: 'bg-amber-500/10', border: 'border-amber-500/20', icon: 'text-amber-400' },
  requirement: { bg: 'bg-rose-500/10', border: 'border-rose-500/20', icon: 'text-rose-400' },
};

/**
 * Card component for displaying a skill
 */
const SkillCard: React.FC<SkillCardProps> = ({ skill, onEdit, onDelete }) => {
  const skillType = skill.skillType || 'claude-skill';

  return (
    <div className="bg-surface-dark border border-border-dark rounded-lg p-4 hover:border-primary/50 transition-colors flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <h3 className="font-medium text-text-primary-dark">{skill.name}</h3>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[skill.category]}`}>
          {getSkillCategoryLabel(skill.category)}
        </span>
      </div>

      {/* Description */}
      <p className="text-sm text-text-secondary-dark flex-grow mb-3 line-clamp-2">
        {skill.description}
      </p>

      {/* Meta */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded ${SKILL_TYPE_COLORS[skillType]}`}>
          {getSkillTypeIcon(skillType)}
          <span>{getSkillTypeLabel(skillType)}</span>
        </span>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          skill.isEnabled
            ? 'bg-emerald-500/10 text-emerald-400'
            : 'bg-gray-500/10 text-gray-400'
        }`}>
          {skill.isEnabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>

      {/* Notices */}
      {skill.notices && skill.notices.length > 0 && (
        <div className="space-y-2 mb-3">
          {skill.notices.map((notice, index) => {
            const colors = NOTICE_COLORS[notice.type];
            return (
              <div key={index} className={`flex gap-2 p-2 rounded ${colors.bg} border ${colors.border}`}>
                <div className={`flex-shrink-0 ${colors.icon}`}>
                  {getNoticeIcon(notice.type)}
                </div>
                <div className="text-xs space-y-0.5">
                  <span className="font-medium text-text-primary-dark block">{notice.title}</span>
                  <span className="text-text-secondary-dark block">{notice.message}</span>
                  {notice.link && (
                    <a
                      href={notice.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-1"
                    >
                      {notice.linkText || 'Learn more'}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-3 border-t border-border-dark mt-auto">
        {skill.isBuiltin && (
          <span className="text-xs text-text-secondary-dark italic">Built-in</span>
        )}
        <div className="flex gap-1 ml-auto">
          <IconButton
            icon={Pencil}
            onClick={onEdit}
            variant="ghost"
            size="sm"
            aria-label="Edit skill"
          />
          {!skill.isBuiltin && (
            <IconButton
              icon={Trash2}
              onClick={onDelete}
              variant="danger-ghost"
              size="sm"
              aria-label="Delete skill"
            />
          )}
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// Skill Editor Modal
// =============================================================================

/**
 * Props for SkillEditorModal component
 */
interface SkillEditorModalProps {
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
const SkillEditorModal: React.FC<SkillEditorModalProps> = ({
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
    promptContent: (skill as any)?.promptContent || '',
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

  /**
   * Handle overlay click
   */
  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleOverlayClick}
    >
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-lg w-full max-w-lg m-4 max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-dark">
          <div>
            <h2 className="text-xl font-semibold text-text-primary-dark">
              {skill ? 'Edit Skill' : 'Create Skill'}
            </h2>
            <p className="text-sm text-text-secondary-dark mt-1">
              {skill ? 'Modify skill configuration' : 'Configure a new skill for your agents'}
            </p>
          </div>
          <IconButton
            icon={X}
            onClick={onClose}
            variant="ghost"
            aria-label="Close"
          />
        </div>

        {/* Built-in Skill Notice */}
        {isBuiltin && skill && (
          <div className="mx-6 mt-4 bg-blue-500/10 border border-blue-500/30 text-blue-400 px-4 py-3 rounded-lg text-sm">
            <strong>Built-in Skill:</strong> Changes will be saved as a user override. You can reset to defaults anytime.
          </div>
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
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
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
            <p className="text-xs text-text-secondary-dark mt-1">
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
              {CATEGORY_OPTIONS.filter((o) => o.value).map((opt) => (
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

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-border-dark bg-background-dark">
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
        </div>
      </div>
    </div>
  );
};

// =============================================================================
// Delete Confirmation Modal
// =============================================================================

/**
 * Props for DeleteConfirmModal component
 */
interface DeleteConfirmModalProps {
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
const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  skillName,
  onConfirm,
  onCancel,
}) => {
  /**
   * Handle overlay click
   */
  const handleOverlayClick = (e: React.MouseEvent): void => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleOverlayClick}
    >
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-lg w-full max-w-md m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 border-b border-border-dark">
          <h2 className="text-xl font-semibold text-text-primary-dark">Delete Skill</h2>
        </div>

        {/* Body */}
        <div className="p-6">
          <p className="text-text-secondary-dark">
            Are you sure you want to delete <strong className="text-text-primary-dark">{skillName}</strong>?
            This action cannot be undone.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-6 border-t border-border-dark bg-background-dark rounded-b-xl">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SkillsTab;
