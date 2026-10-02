/**
 * Tests for RolesTab Component
 *
 * @module components/Settings/RolesTab.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { RolesTab, roleMeta } from './RolesTab';
import * as useRolesHook from '../../hooks/useRoles';

// Mock RoleEditor component
vi.mock('./RoleEditor', () => ({
  RoleEditor: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="role-editor">
      <button onClick={onClose}>Close Editor</button>
    </div>
  ),
}));

describe('RolesTab', () => {
  const mockRoles = [
    {
      id: 'developer',
      name: 'developer',
      displayName: 'Developer',
      description: 'Software developer role for coding tasks',
      category: 'development' as const,
      skillCount: 3,
      isDefault: true,
      isBuiltin: true,
    },
    {
      id: 'product-manager',
      name: 'product-manager',
      displayName: 'Product Manager',
      description: 'Product management role',
      category: 'management' as const,
      skillCount: 2,
      isDefault: false,
      isBuiltin: true,
    },
    {
      id: 'custom-role',
      name: 'custom-role',
      displayName: 'Custom Role',
      description: 'A custom user-created role',
      category: 'development' as const,
      skillCount: 1,
      isDefault: false,
      isBuiltin: false,
    },
  ];

  const mockCreateRole = vi.fn().mockResolvedValue(undefined);
  const mockUpdateRole = vi.fn().mockResolvedValue(undefined);
  const mockDeleteRole = vi.fn().mockResolvedValue(undefined);
  const mockRefreshRoles = vi.fn().mockResolvedValue(undefined);
  const mockRefreshFromDisk = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(useRolesHook, 'useRoles').mockReturnValue({
      roles: mockRoles,
      isLoading: false,
      error: null,
      createRole: mockCreateRole,
      updateRole: mockUpdateRole,
      deleteRole: mockDeleteRole,
      refreshRoles: mockRefreshRoles,
      refreshFromDisk: mockRefreshFromDisk,
    });
  });

  const mockHook = (over: Partial<ReturnType<typeof useRolesHook.useRoles>>) =>
    vi.spyOn(useRolesHook, 'useRoles').mockReturnValue({
      roles: mockRoles,
      isLoading: false,
      error: null,
      createRole: mockCreateRole,
      updateRole: mockUpdateRole,
      deleteRole: mockDeleteRole,
      refreshRoles: mockRefreshRoles,
      refreshFromDisk: mockRefreshFromDisk,
      ...over,
    });

  describe('Rendering', () => {
    it('renders one row per role with a quiet meta line', () => {
      render(<RolesTab />);

      expect(screen.getByText('Developer')).toBeInTheDocument();
      expect(screen.getByText('Product Manager')).toBeInTheDocument();
      expect(screen.getByText('Custom Role')).toBeInTheDocument();
      expect(screen.getByText(/Development · 3 skills · Default · Built-in/)).toBeInTheDocument();
      expect(screen.getByText(/Software developer role for coding tasks/)).toBeInTheDocument();
    });

    it('renders the search box and the New role button', () => {
      render(<RolesTab />);

      expect(screen.getByPlaceholderText('Search roles...')).toBeInTheDocument();
      expect(screen.getByText('New role')).toBeInTheDocument();
    });

    it('shows five roles, then Show all', () => {
      const many = Array.from({ length: 7 }, (_, i) => ({ ...mockRoles[2], id: `r${i}`, displayName: `Role ${i}` }));
      mockHook({ roles: many });
      render(<RolesTab />);

      expect(screen.getByText('Role 4')).toBeInTheDocument();
      expect(screen.queryByText('Role 5')).not.toBeInTheDocument();
      fireEvent.click(screen.getByText('Show all 7'));
      expect(screen.getByText('Role 6')).toBeInTheDocument();
    });
  });

  describe('roleMeta', () => {
    it('lists category, skills and flags', () => {
      expect(roleMeta(mockRoles[1])).toBe('Management · 2 skills · Built-in');
      expect(roleMeta({ ...mockRoles[2], skillCount: 1 })).toBe('Development · 1 skill');
    });
  });

  describe('Filtering', () => {
    it('filters roles by display name', () => {
      render(<RolesTab />);
      fireEvent.change(screen.getByPlaceholderText('Search roles...'), { target: { value: 'Developer' } });
      expect(screen.getByText('Developer')).toBeInTheDocument();
      expect(screen.queryByText('Product Manager')).not.toBeInTheDocument();
    });

    it('filters roles by description', () => {
      render(<RolesTab />);
      fireEvent.change(screen.getByPlaceholderText('Search roles...'), { target: { value: 'coding' } });
      expect(screen.getByText('Developer')).toBeInTheDocument();
      expect(screen.queryByText('Product Manager')).not.toBeInTheDocument();
    });

    it('shows the empty state when nothing matches', () => {
      render(<RolesTab />);
      fireEvent.change(screen.getByPlaceholderText('Search roles...'), { target: { value: 'nonexistent' } });
      expect(screen.getByText(/No roles found/)).toBeInTheDocument();
    });

    it('filters by category through the Filter button', () => {
      render(<RolesTab />);
      fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
      fireEvent.click(screen.getByRole('radio', { name: 'Management' }));
      expect(screen.getByText('Product Manager')).toBeInTheDocument();
      expect(screen.queryByText('Custom Role')).not.toBeInTheDocument();
    });
  });

  describe('Actions', () => {
    it('shows Edit on every role', () => {
      render(<RolesTab />);
      expect(screen.getAllByText('Edit')).toHaveLength(3);
    });

    it('opens the editor for New role and Edit, and closes it', () => {
      render(<RolesTab />);
      fireEvent.click(screen.getByText('New role'));
      expect(screen.getByTestId('role-editor')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Close Editor'));
      expect(screen.queryByTestId('role-editor')).not.toBeInTheDocument();

      fireEvent.click(screen.getAllByText('Edit')[0]);
      expect(screen.getByTestId('role-editor')).toBeInTheDocument();
    });

    it('offers Delete only for custom roles, in the overflow menu', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<RolesTab />);

      expect(screen.queryByLabelText('More for Developer')).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('More for Custom Role'));
      fireEvent.click(screen.getByText('Delete'));
      await waitFor(() => expect(mockDeleteRole).toHaveBeenCalledWith('custom-role'));
    });

    it('does not delete when cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      render(<RolesTab />);
      fireEvent.click(screen.getByLabelText('More for Custom Role'));
      fireEvent.click(screen.getByText('Delete'));
      expect(mockDeleteRole).not.toHaveBeenCalled();
    });

    it('refreshes roles from disk', async () => {
      render(<RolesTab />);
      fireEvent.click(screen.getByText('Refresh'));
      await waitFor(() => expect(mockRefreshFromDisk).toHaveBeenCalled());
    });
  });

  describe('States', () => {
    it('shows loading', () => {
      mockHook({ roles: null, isLoading: true });
      render(<RolesTab />);
      expect(screen.getByText('Loading roles...')).toBeInTheDocument();
    });

    it('shows the error with Retry', () => {
      mockHook({ roles: [], error: 'boom' });
      render(<RolesTab />);
      expect(screen.getByText(/Error: boom/)).toBeInTheDocument();
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });
});
