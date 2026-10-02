/**
 * InstalledSkills — Marketplace › Installed (former Settings › Skills).
 *
 * The skills this instance has, as compact rows: name, one quiet line
 * (category · built-in or custom), the enable switch and Edit. Delete sits
 * behind "⋯"; a row opens to show its description and any setup notices.
 * Category lives behind the Filter button, next to a search box; the
 * Browser Automation settings are a collapsed section underneath.
 *
 * @module components/Marketplace/InstalledSkills
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Target,
  Trash2,
} from 'lucide-react';
import {
  Alert,
  Button,
  CompactRow,
  FilterButton,
  IconButton,
  LoadingSpinner,
  ShowAll,
  StatusLabel,
  Toggle,
  type FilterValue,
} from '@crewly/ui';
import { useSkills, type UseSkillsOptions } from '../../hooks/useSkills';
import type { SkillCategory, SkillNotice, SkillSummary } from '../../types/skill.types';
import { getSkillCategoryLabel, getSkillTypeLabel } from '../../types/skill.types';
import type { CreateSkillInput } from '../../services/skills.service';
import { DeleteSkillConfirm, SkillEditorModal } from './SkillEditorModal';
import { BrowserAutomationSettings } from './BrowserAutomationSettings';
import { INSTALLED_LIST_LIMIT, SKILL_CATEGORY_OPTIONS } from './skill-ui.constants';

/** Props for {@link InstalledSkills}. */
export interface InstalledSkillsProps {
  /** Reports how many skills are listed (unfiltered list), for the tab pill */
  onCountChange?: (count: number) => void;
}

/** Icon and tone per notice type. */
const NOTICE_STYLE: Record<SkillNotice['type'], { icon: React.ElementType; text: string }> = {
  info: { icon: Info, text: 'text-primary-text' },
  warning: { icon: AlertTriangle, text: 'text-attention' },
  requirement: { icon: AlertCircle, text: 'text-danger' },
};

/**
 * The quiet meta line of a skill row.
 *
 * @param skill - Skill
 * @returns e.g. "Development · Built-in", "Research · Custom · Web page"
 */
export function skillMeta(skill: SkillSummary): string {
  const category = getSkillCategoryLabel(skill.category);
  // Categories outside the known list come back raw ("browser"): capitalise them.
  const bits = [category.charAt(0).toUpperCase() + category.slice(1), skill.isBuiltin ? 'Built-in' : 'Custom'];
  if (skill.skillType === 'web-page') bits.push(getSkillTypeLabel('web-page'));
  return bits.join(' · ');
}

/**
 * The installed skills panel.
 *
 * @param props - {@link InstalledSkillsProps}
 * @returns Panel element
 */
export const InstalledSkills: React.FC<InstalledSkillsProps> = ({ onCountChange }) => {
  const [filters, setFilters] = useState<FilterValue>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillSummary | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const categoryFilter = (filters.category?.[0] ?? '') as SkillCategory | '';

  const hookOptions: UseSkillsOptions = useMemo(
    () => ({ category: categoryFilter || undefined, search: searchQuery || undefined }),
    [categoryFilter, searchQuery],
  );

  const { skills, loading, error, refresh, create, update, remove, selectSkill, selectedSkill, clearSelection } =
    useSkills(hookOptions);

  const filtered = Boolean(searchQuery || categoryFilter);
  useEffect(() => {
    if (!filtered && !loading) onCountChange?.(skills.length);
  }, [filtered, loading, skills.length, onCountChange]);

  const disabledCount = skills.filter((s) => !s.isEnabled).length;

  const handleCreate = useCallback((): void => {
    setEditingSkill(null);
    setShowEditor(true);
  }, []);

  const handleEdit = useCallback(
    async (skill: SkillSummary): Promise<void> => {
      setEditingSkill(skill);
      await selectSkill(skill.id); // full skill data, including promptContent
      setShowEditor(true);
    },
    [selectSkill],
  );

  const handleSave = useCallback(
    async (data: CreateSkillInput): Promise<void> => {
      try {
        if (editingSkill?.id) await update(editingSkill.id, data);
        else await create(data);
        setShowEditor(false);
        setEditingSkill(null);
      } catch (err) {
        console.error('Failed to save skill:', err);
      }
    },
    [editingSkill, update, create],
  );

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      try {
        await remove(id);
        setDeleteId(null);
      } catch (err) {
        console.error('Failed to delete skill:', err);
      }
    },
    [remove],
  );

  /** Turn a custom skill on or off (built-in skills cannot be changed). */
  const handleToggle = useCallback(
    async (skill: SkillSummary, enabled: boolean): Promise<void> => {
      setToggling(skill.id);
      setToggleError(null);
      try {
        await update(skill.id, { isEnabled: enabled });
      } catch (err) {
        setToggleError(err instanceof Error ? err.message : `Could not ${enabled ? 'enable' : 'disable'} ${skill.name}`);
      } finally {
        setToggling(null);
      }
    },
    [update],
  );

  return (
    <div className="space-y-6" data-testid="installed-skills">
      {/* Toolbar: search, Filter (category), refresh, New skill */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="search-filter" className="sr-only">Search skills</label>
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-3" aria-hidden="true" />
          <input
            id="search-filter"
            type="text"
            placeholder="Search skills..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-9 w-full rounded-2xl border border-border bg-surface pl-9 pr-3 text-sm text-text placeholder:text-text-3 focus:border-primary focus:outline-none"
          />
        </div>
        <FilterButton
          value={filters}
          onChange={setFilters}
          groups={[
            {
              id: 'category',
              label: 'Category',
              single: true,
              options: SKILL_CATEGORY_OPTIONS.filter((o) => o.value).map((o) => ({ value: o.value, label: o.label })),
            },
          ]}
        />
        <IconButton
          icon={RefreshCw}
          variant="outline"
          onClick={() => void refresh()}
          loading={loading}
          disabled={loading}
          aria-label="Refresh skills"
          title="Refresh skills"
        />
        <Button onClick={handleCreate} icon={Plus} size="sm">
          New Skill
        </Button>
      </div>

      {!loading && skills.length > 0 && (
        <p className="-mt-3 px-1 text-[13px] text-text-2" data-testid="installed-summary">
          {skills.length} {filtered ? 'shown' : 'installed'}
          {disabledCount > 0 ? ` · ${disabledCount} disabled` : ' · all enabled'}
        </p>
      )}

      {error && (
        <Alert variant="error">
          <div className="flex items-center justify-between gap-3">
            <span>Error: {error}</span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        </Alert>
      )}
      {toggleError && <Alert variant="error">{toggleError}</Alert>}

      {loading && skills.length === 0 && (
        <div className="flex justify-center py-16">
          <LoadingSpinner text="Loading skills..." />
        </div>
      )}

      {!loading && skills.length === 0 && !error && (
        <div className="py-12 text-center">
          <Target className="mx-auto mb-3 h-10 w-10 text-text-3" aria-hidden="true" />
          <h3 className="mb-1 text-[15px] font-semibold text-text">No Skills Found</h3>
          <p className="mb-5 text-sm text-text-2">
            {filtered ? 'Try adjusting your filters' : 'Create your first skill to get started'}
          </p>
          {!filtered && (
            <Button onClick={handleCreate} icon={Plus} size="sm">
              Create Skill
            </Button>
          )}
        </div>
      )}

      {skills.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface">
          <ShowAll limit={INSTALLED_LIST_LIMIT}>
            {skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                open={openId === skill.id}
                busy={toggling === skill.id}
                onOpen={() => setOpenId((cur) => (cur === skill.id ? null : skill.id))}
                onEdit={() => void handleEdit(skill)}
                onDelete={() => setDeleteId(skill.id)}
                onToggle={(enabled) => void handleToggle(skill, enabled)}
              />
            ))}
          </ShowAll>
        </div>
      )}

      <BrowserAutomationSettings />

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

      {deleteId && (
        <DeleteSkillConfirm
          skillId={deleteId}
          skillName={skills.find((s) => s.id === deleteId)?.name || ''}
          onConfirm={() => void handleDelete(deleteId)}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
};

/** Props for one skill row. */
interface SkillRowProps {
  skill: SkillSummary;
  open: boolean;
  busy: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}

/**
 * One installed skill: a compact row that opens to its description and
 * notices.
 */
const SkillRow: React.FC<SkillRowProps> = ({ skill, open, busy, onOpen, onEdit, onDelete, onToggle }) => {
  const needsSetup = skill.notices?.some((n) => n.type === 'requirement');
  const trailing = !skill.isEnabled ? (
    <StatusLabel tone="neutral" size="sm">Disabled</StatusLabel>
  ) : needsSetup ? (
    <StatusLabel tone="attention" size="sm">Needs setup</StatusLabel>
  ) : null;

  const enableControl = skill.isBuiltin ? (
    <span className="hidden text-xs text-text-3 sm:inline" title="Built-in skills are always available">Built-in</span>
  ) : (
    <Toggle
      size="sm"
      checked={skill.isEnabled}
      disabled={busy}
      onChange={(e) => onToggle(e.target.checked)}
      aria-label={`Enable ${skill.name}`}
    />
  );

  return (
    <div className="border-b border-border-soft last:border-b-0" data-testid={`installed-skill-${skill.id}`}>
      <CompactRow
        className="border-b-0"
        primary={skill.name}
        meta={skillMeta(skill)}
        onClick={onOpen}
        selected={open}
        trailing={trailing}
        actions={[
          enableControl,
          <IconButton key="edit" icon={Pencil} onClick={onEdit} variant="ghost" size="sm" aria-label={`Edit ${skill.name}`} title="Edit" />,
        ]}
        overflow={[
          { label: 'Edit', icon: Pencil, onClick: onEdit },
          ...(!skill.isBuiltin ? [{ label: 'Delete', icon: Trash2, danger: true, separator: true, onClick: onDelete }] : []),
        ]}
        overflowLabel={`More actions for ${skill.name}`}
      />
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-4 sm:pl-6" data-testid={`installed-skill-detail-${skill.id}`}>
          <p className="text-sm text-text-2">{skill.description}</p>
          {skill.notices?.map((notice, i) => {
            const style = NOTICE_STYLE[notice.type] ?? NOTICE_STYLE.info;
            const Icon = style.icon;
            return (
              <div key={i} className="flex gap-2 text-[13px]">
                <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.text}`} aria-hidden="true" />
                <div>
                  <span className="block font-semibold text-text">{notice.title}</span>
                  <span className="block text-text-2">{notice.message}</span>
                  {notice.link && (
                    <a
                      href={notice.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary-text hover:underline"
                    >
                      {notice.linkText || 'Learn more'}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          {!skill.isBuiltin && (
            <Button variant="ghost" size="xs" icon={Trash2} className="text-danger" onClick={onDelete}>
              Delete skill
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

export default InstalledSkills;
