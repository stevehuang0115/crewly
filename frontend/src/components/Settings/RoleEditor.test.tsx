/**
 * Tests for RoleEditor Component
 *
 * @module components/Settings/RoleEditor.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { RoleEditor } from './RoleEditor';
import * as useRoleHook from '../../hooks/useRole';
import * as useSkillsHook from '../../hooks/useSkills';

describe('RoleEditor', () => {
  const mockRole = {
    id: 'developer',
    name: 'developer',
    displayName: 'Developer',
    description: 'Software developer role',
    category: 'development' as const,
    systemPromptFile: 'developer-prompt.md',
    systemPromptContent: '# Developer\n\nYou are a developer...',
    assignedSkills: ['file-operations', 'git-operations'],
    isDefault: true,
    isBuiltin: true,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const mockSkills = [
    {
      id: 'file-operations',
      name: 'file-operations',
      displayName: 'File Operations',
      description: 'Read and write files',
      type: 'builtin' as const,
      isEnabled: true,
    },
    {
      id: 'git-operations',
      name: 'git-operations',
      displayName: 'Git Operations',
      description: 'Git version control',
      type: 'builtin' as const,
      isEnabled: true,
    },
  ];

  const mockOnClose = vi.fn();
  const mockOnSave = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();

    vi.spyOn(useRoleHook, 'useRole').mockReturnValue({
      role: null,
      isLoading: false,
      error: null,
      refreshRole: vi.fn(),
    });

    vi.spyOn(useSkillsHook, 'useSkills').mockReturnValue({
      skills: mockSkills,
      isLoading: false,
      error: null,
      refreshSkills: vi.fn(),
    });
  });

  describe('Create Mode', () => {
    it('should render create mode header when roleId is null', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const header = screen.getByRole('heading', { name: 'Create Role' });
      expect(header).toBeInTheDocument();
    });

    it('should show Internal Name field in create mode', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByLabelText('Internal Name *')).toBeInTheDocument();
    });

    it('should show Create Role button in create mode', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const submitButton = screen.getByRole('button', { name: 'Create Role' });
      expect(submitButton).toBeInTheDocument();
    });
  });

  describe('Edit Mode', () => {
    beforeEach(() => {
      vi.spyOn(useRoleHook, 'useRole').mockReturnValue({
        role: { ...mockRole, isBuiltin: false },
        isLoading: false,
        error: null,
        refreshRole: vi.fn(),
      });
    });

    it('should render edit mode header', () => {
      render(<RoleEditor roleId="custom-role" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('Edit Role')).toBeInTheDocument();
    });

    it('should not show Internal Name field in edit mode', () => {
      render(<RoleEditor roleId="custom-role" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.queryByLabelText('Internal Name *')).not.toBeInTheDocument();
    });

    it('should show Save Changes button in edit mode', () => {
      render(<RoleEditor roleId="custom-role" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('Save Changes')).toBeInTheDocument();
    });

    it('should populate form with role data', () => {
      render(<RoleEditor roleId="custom-role" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByDisplayValue('Developer')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Software developer role')).toBeInTheDocument();
    });
  });

  describe('View Mode (Builtin Role)', () => {
    beforeEach(() => {
      vi.spyOn(useRoleHook, 'useRole').mockReturnValue({
        role: mockRole,
        isLoading: false,
        error: null,
        refreshRole: vi.fn(),
      });
    });

    it('should render view mode header for builtin role', () => {
      render(<RoleEditor roleId="developer" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('View Role')).toBeInTheDocument();
    });

    it('should disable form fields for builtin role', () => {
      render(<RoleEditor roleId="developer" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByLabelText('Display Name *')).toBeDisabled();
      expect(screen.getByLabelText('Description')).toBeDisabled();
      expect(screen.getByLabelText('Category')).toBeDisabled();
    });

    it('should show Close button instead of Cancel for builtin role', () => {
      render(<RoleEditor roleId="developer" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('Close')).toBeInTheDocument();
      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    });

    it('should not show submit button for builtin role', () => {
      render(<RoleEditor roleId="developer" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.queryByText('Save Changes')).not.toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('should show loading state when loading role', () => {
      vi.spyOn(useRoleHook, 'useRole').mockReturnValue({
        role: null,
        isLoading: true,
        error: null,
        refreshRole: vi.fn(),
      });

      render(<RoleEditor roleId="developer" onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('Loading role...')).toBeInTheDocument();
    });
  });

  describe('Form Fields', () => {
    it('should render all form sections', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('Basic Information')).toBeInTheDocument();
      expect(screen.getByText('System Prompt')).toBeInTheDocument();
      expect(screen.getByText('Assigned Skills')).toBeInTheDocument();
    });

    it('should render category select with all options', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const select = screen.getByLabelText('Category');
      expect(select).toBeInTheDocument();

      fireEvent.click(select);
      expect(screen.getByText('Development')).toBeInTheDocument();
      expect(screen.getByText('Management')).toBeInTheDocument();
      expect(screen.getByText('Quality')).toBeInTheDocument();
    });

    it('should render skills checkboxes', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByText('File Operations')).toBeInTheDocument();
      expect(screen.getByText('Git Operations')).toBeInTheDocument();
    });

    it('should render default role checkbox', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      expect(screen.getByLabelText('Set as default role')).toBeInTheDocument();
    });
  });

  describe('Form Interactions', () => {
    it('should update display name on change', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const input = screen.getByLabelText('Display Name *');
      fireEvent.change(input, { target: { value: 'New Role' } });

      expect(input).toHaveValue('New Role');
    });

    it('should format internal name to lowercase with hyphens', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const input = screen.getByLabelText('Internal Name *');
      fireEvent.change(input, { target: { value: 'My New Role' } });

      expect(input).toHaveValue('my-new-role');
    });

    it('should toggle skill selection', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const fileOpsCheckbox = screen.getByRole('checkbox', { name: /File Operations/i });
      expect(fileOpsCheckbox).not.toBeChecked();

      fireEvent.click(fileOpsCheckbox);
      expect(fileOpsCheckbox).toBeChecked();

      fireEvent.click(fileOpsCheckbox);
      expect(fileOpsCheckbox).not.toBeChecked();
    });
  });

  describe('Form Submission', () => {
    it('should call onSave with form data on submit', async () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      // Fill in required fields
      fireEvent.change(screen.getByLabelText('Display Name *'), { target: { value: 'Test Role' } });
      fireEvent.change(screen.getByLabelText('Internal Name *'), { target: { value: 'test-role' } });

      // Submit form
      const submitButton = screen.getByRole('button', { name: 'Create Role' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(mockOnSave).toHaveBeenCalled();
      });
    });

    it('should call onClose after successful save', async () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      // Fill in required fields
      fireEvent.change(screen.getByLabelText('Display Name *'), { target: { value: 'Test Role' } });
      fireEvent.change(screen.getByLabelText('Internal Name *'), { target: { value: 'test-role' } });

      // Submit form
      fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));

      await waitFor(() => {
        expect(mockOnClose).toHaveBeenCalled();
      });
    });

    it('should show error message on save failure', async () => {
      const errorOnSave = vi.fn().mockRejectedValue(new Error('Save failed'));

      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={errorOnSave} />);

      // Fill in required fields
      fireEvent.change(screen.getByLabelText('Display Name *'), { target: { value: 'Test Role' } });
      fireEvent.change(screen.getByLabelText('Internal Name *'), { target: { value: 'test-role' } });

      // Submit form
      fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));

      await waitFor(() => {
        expect(screen.getByText('Save failed')).toBeInTheDocument();
      });
    });

    it('should show saving state while saving', async () => {
      const slowSave = vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));

      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={slowSave} />);

      // Fill in required fields
      fireEvent.change(screen.getByLabelText('Display Name *'), { target: { value: 'Test Role' } });
      fireEvent.change(screen.getByLabelText('Internal Name *'), { target: { value: 'test-role' } });

      // Submit form
      fireEvent.click(screen.getByRole('button', { name: 'Create Role' }));

      expect(screen.getByText('Saving...')).toBeInTheDocument();
    });
  });

  describe('Modal Interactions', () => {
    it('should call onClose when Cancel is clicked', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      fireEvent.click(screen.getByText('Cancel'));

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should call onClose when X button is clicked', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      // The shared Popup owns the close button (labelled "Close modal").
      fireEvent.click(screen.getByLabelText('Close modal'));

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should call onClose when clicking overlay', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      // The shared Popup's overlay is the role="dialog" element.
      fireEvent.click(screen.getByRole('dialog'));

      expect(mockOnClose).toHaveBeenCalled();
    });

    it('should not close when clicking inside modal', () => {
      render(<RoleEditor roleId={null} onClose={mockOnClose} onSave={mockOnSave} />);

      const modal = document.querySelector('.role-editor-modal');
      if (modal) {
        fireEvent.click(modal);
      }

      expect(mockOnClose).not.toHaveBeenCalled();
    });
  });
});
