/**
 * RolesTab Component
 *
 * Roles management tab for viewing and editing agent roles.
 * @uses LoadingSpinner from UI library
 * @module components/Settings/RolesTab
 */

import React, { useState, useMemo } from 'react';
import { Plus, Trash2, User, RefreshCw, Pencil } from 'lucide-react';
import { CompactRow, FilterButton, ShowAll, type FilterValue } from '@crewly/ui';
import { Alert } from '@crewly/ui/Alert';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { useRoles } from '../../hooks/useRoles';
import {
  RoleSummary,
  RoleCategory,
  ROLE_CATEGORY_DISPLAY_NAMES,
} from '../../types/role.types';
import { RoleEditor } from './RoleEditor';
import { Button } from '@crewly/ui/Button';
import { FormInput } from '@crewly/ui/Form';

/**
 * Category filter options
 */
const CATEGORY_OPTIONS: { value: RoleCategory; label: string }[] = [
  { value: 'development', label: 'Development' },
  { value: 'management', label: 'Management' },
  { value: 'quality', label: 'Quality' },
  { value: 'design', label: 'Design' },
  { value: 'sales', label: 'Sales' },
  { value: 'support', label: 'Support' },
  { value: 'automation', label: 'Automation' },
];

/**
 * Quiet meta line of a role row: category, skills, Default / Built-in.
 *
 * @param role - Role summary
 * @returns e.g. "Development · 3 skills · Default · Built-in"
 */
export function roleMeta(role: RoleSummary): string {
  const parts = [
    ROLE_CATEGORY_DISPLAY_NAMES[role.category] ?? 'Uncategorized',
    `${role.skillCount} skill${role.skillCount === 1 ? '' : 's'}`,
  ];
  if (role.isDefault) parts.push('Default');
  if (role.isBuiltin) parts.push('Built-in');
  return parts.join(' · ');
}

/**
 * Roles management tab for viewing and editing agent roles
 *
 * @returns RolesTab component
 */
export const RolesTab: React.FC = () => {
  const { roles, isLoading, error, createRole, updateRole, deleteRole, refreshFromDisk } = useRoles();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [filter, setFilter] = useState('');
  const [filters, setFilters] = useState<FilterValue>({ category: [] });
  const categoryFilter = (filters.category?.[0] ?? '') as RoleCategory | '';
  const [isRefreshing, setIsRefreshing] = useState(false);

  /**
   * Filter roles by search query and category
   */
  const filteredRoles = useMemo(() => {
    if (!roles) return [];

    return roles.filter((role) => {
      // Filter by category
      if (categoryFilter && role.category !== categoryFilter) {
        return false;
      }

      // Filter by search
      if (filter) {
        const lowerFilter = filter.toLowerCase();
        return (
          role.displayName.toLowerCase().includes(lowerFilter) ||
          role.description.toLowerCase().includes(lowerFilter) ||
          role.category.toLowerCase().includes(lowerFilter)
        );
      }

      return true;
    });
  }, [roles, filter, categoryFilter]);

  /**
   * Handle create new role
   */
  const handleCreateNew = () => {
    setSelectedRoleId(null);
    setIsCreating(true);
    setIsEditorOpen(true);
  };

  /**
   * Handle edit role
   */
  const handleEdit = (roleId: string) => {
    setSelectedRoleId(roleId);
    setIsCreating(false);
    setIsEditorOpen(true);
  };

  /**
   * Handle delete role
   */
  const handleDelete = async (roleId: string, isBuiltin: boolean) => {
    if (isBuiltin) {
      window.alert('Built-in roles cannot be deleted');
      return;
    }

    if (window.confirm('Are you sure you want to delete this role?')) {
      await deleteRole(roleId);
    }
  };

  /**
   * Handle editor close
   */
  const handleEditorClose = () => {
    setIsEditorOpen(false);
    setSelectedRoleId(null);
    setIsCreating(false);
  };

  /**
   * Handle refresh from disk
   */
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshFromDisk();
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="roles-tab">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-text">Roles</h2>
          <p className="mt-0.5 text-[13px] text-text-2">
            {roles ? `${roles.length} roles. ` : ''}Built-in roles can be edited but not deleted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isLoading || isRefreshing}
            icon={RefreshCw}
            loading={isRefreshing}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </Button>
          <Button onClick={handleCreateNew} icon={Plus}>
            New role
          </Button>
        </div>
      </div>

      {/* Filters: one search box + one Filter button */}
      <div className="flex flex-wrap items-center gap-3">
        <FormInput
          id="search-filter"
          type="text"
          aria-label="Search roles"
          placeholder="Search roles..."
          className="sm:max-w-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <FilterButton
          groups={[{ id: 'category', label: 'Category', options: CATEGORY_OPTIONS, single: true }]}
          value={filters}
          onChange={setFilters}
        />
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="error">
          <div className="flex items-center justify-between">
            <span>Error: {error}</span>
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          </div>
        </Alert>
      )}

      {/* Loading state */}
      {isLoading && filteredRoles.length === 0 && (
        <div className="flex justify-center py-16">
          <LoadingSpinner text="Loading roles..." />
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filteredRoles.length === 0 && !error && (
        <div className="text-center py-16">
          <div className="flex justify-center mb-4">
            <User className="w-10 h-10 text-text-3" />
          </div>
          <h3 className="text-[15px] font-semibold mb-2">No roles found</h3>
          <p className="text-[13px] text-text-2 mb-6">
            {filter || categoryFilter
              ? 'Try adjusting your filters'
              : 'Create your first role to get started'}
          </p>
          {!filter && !categoryFilter && (
            <Button onClick={handleCreateNew} icon={Plus}>
              Create role
            </Button>
          )}
        </div>
      )}

      {/* Roles list */}
      {filteredRoles.length > 0 && (
        <ShowAll limit={5} data-testid="roles-list">
          {filteredRoles.map((role) => (
            <CompactRow
              key={role.id}
              data-testid={`role-row-${role.id}`}
              className="px-0"
              primary={role.displayName}
              meta={<span title={role.description}>{[roleMeta(role), role.description].filter(Boolean).join(' · ')}</span>}
              actions={[
                <Button key="edit" variant="secondary" size="sm" icon={Pencil} onClick={() => handleEdit(role.id)}>
                  Edit
                </Button>,
              ]}
              overflowLabel={`More for ${role.displayName}`}
              overflow={
                role.isBuiltin
                  ? undefined
                  : [{ label: 'Delete', icon: Trash2, danger: true, onClick: () => void handleDelete(role.id, role.isBuiltin) }]
              }
            />
          ))}
        </ShowAll>
      )}

      {/* Role Editor Modal */}
      {isEditorOpen && (
        <RoleEditor
          roleId={isCreating ? null : selectedRoleId}
          onClose={handleEditorClose}
          onSave={async (input) => {
            if (isCreating) {
              await createRole(input as Parameters<typeof createRole>[0]);
            } else if (selectedRoleId) {
              await updateRole(selectedRoleId, input as Parameters<typeof updateRole>[1]);
            }
          }}
        />
      )}
    </div>
  );
};

export default RolesTab;
