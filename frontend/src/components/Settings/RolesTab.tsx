/**
 * RolesTab Component
 *
 * Roles management tab for viewing and editing agent roles.
 * @uses LoadingSpinner from UI library
 * @module components/Settings/RolesTab
 */

import React, { useState, useMemo } from 'react';
import { Plus, Trash2, User, RefreshCw } from 'lucide-react';
import { Alert } from '../UI/Alert';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { useRoles } from '../../hooks/useRoles';
import {
  RoleSummary,
  RoleCategory,
  ROLE_CATEGORY_DISPLAY_NAMES,
} from '../../types/role.types';
import { RoleEditor } from './RoleEditor';
import { Button } from '../UI/Button';
import { FormInput, FormLabel, FormSelect } from '../UI/Form';

/**
 * Role category badge color mapping
 */
const CATEGORY_COLORS: Record<RoleCategory, string> = {
  development: 'bg-blue-500/15 text-blue-400',
  management: 'bg-amber-500/15 text-amber-400',
  quality: 'bg-emerald-500/15 text-emerald-400',
  design: 'bg-pink-500/15 text-pink-400',
  sales: 'bg-primary/15 text-primary',
  support: 'bg-cyan-500/15 text-cyan-400',
  automation: 'bg-orange-500/15 text-orange-400',
};

/**
 * Category filter options
 */
const CATEGORY_OPTIONS: { value: RoleCategory | ''; label: string }[] = [
  { value: '', label: 'All Categories' },
  { value: 'development', label: 'Development' },
  { value: 'management', label: 'Management' },
  { value: 'quality', label: 'Quality' },
  { value: 'design', label: 'Design' },
  { value: 'sales', label: 'Sales' },
  { value: 'support', label: 'Support' },
  { value: 'automation', label: 'Automation' },
];

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
  const [categoryFilter, setCategoryFilter] = useState<RoleCategory | ''>('');
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Roles Management</h2>
          <p className="text-sm text-text-secondary-dark mt-1">Create and manage AI agent roles</p>
        </div>
        <Button onClick={handleCreateNew} icon={Plus}>
          New Role
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row items-end gap-4">
        <div className="flex-1 w-full md:w-auto">
          <FormLabel htmlFor="category-filter">Category</FormLabel>
          <FormSelect
            id="category-filter"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value as RoleCategory | '')}
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
            placeholder="Search roles..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>

        <Button
          variant="secondary"
          onClick={handleRefresh}
          disabled={isLoading || isRefreshing}
          icon={RefreshCw}
          className={isRefreshing ? 'animate-spin' : ''}
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </Button>
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
            <User className="w-12 h-12 text-text-secondary-dark" />
          </div>
          <h3 className="text-lg font-semibold mb-2">No Roles Found</h3>
          <p className="text-sm text-text-secondary-dark mb-6">
            {filter || categoryFilter
              ? 'Try adjusting your filters'
              : 'Create your first role to get started'}
          </p>
          {!filter && !categoryFilter && (
            <Button onClick={handleCreateNew} icon={Plus}>
              Create Role
            </Button>
          )}
        </div>
      )}

      {/* Roles grid */}
      {filteredRoles.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredRoles.map((role) => (
            <div
              key={role.id}
              className="bg-surface-dark border border-border-dark rounded-lg p-4 hover:border-primary/50 transition-colors flex flex-col"
            >
              {/* Card Header */}
              <div className="flex items-start justify-between gap-2 mb-3">
                <h3 className="font-medium text-text-primary-dark">{role.displayName}</h3>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${CATEGORY_COLORS[role.category]}`}>
                  {ROLE_CATEGORY_DISPLAY_NAMES[role.category]}
                </span>
              </div>

              {/* Description */}
              <p className="text-sm text-text-secondary-dark flex-grow mb-3 line-clamp-2">
                {role.description}
              </p>

              {/* Meta */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs text-text-secondary-dark">
                  {role.skillCount} skills assigned
                </span>
                {role.isDefault && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                    Default
                  </span>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-3 border-t border-border-dark mt-auto">
                {role.isBuiltin && (
                  <span className="text-xs text-text-secondary-dark italic">Built-in</span>
                )}
                {!role.isBuiltin && <span />}
                <div className="flex gap-2 ml-auto">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleEdit(role.id)}
                  >
                    Edit
                  </Button>
                  {!role.isBuiltin && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(role.id, role.isBuiltin)}
                      className="text-rose-400 hover:text-rose-300 hover:border-rose-400"
                      icon={Trash2}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
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
