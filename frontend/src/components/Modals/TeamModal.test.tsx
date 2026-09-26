import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import { TeamModal } from './TeamModal';

// Mock fetch globally
global.fetch = vi.fn();

// Mock window.alert
Object.defineProperty(window, 'alert', {
  value: vi.fn(),
  writable: true
});

// Mock UI components to simplify testing
vi.mock('@crewly/ui', () => ({
  FormPopup: ({ isOpen, onClose, onSubmit, title, subtitle, size, submitText, submitDisabled, loading, children }: any) => (
    isOpen ? (
      <div data-testid="form-popup">
        <h2>{title}</h2>
        <p>{subtitle}</p>
        <div>Size: {size}</div>
        <form onSubmit={onSubmit}>
          {children}
          <button
            type="submit"
            disabled={submitDisabled}
            data-testid="submit-button"
          >
            {loading ? 'Loading...' : submitText}
          </button>
          <button type="button" onClick={onClose} data-testid="close-button">
            Close
          </button>
        </form>
      </div>
    ) : null
  ),
  Dropdown: ({ id, name, value, onChange, placeholder, options, required }: any) => (
    <div data-testid={`dropdown-${id || name}`}>
      <select
        id={id}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      >
        <option value="">{placeholder}</option>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  ),
  FormLabel: ({ children, htmlFor }: any) => <label htmlFor={htmlFor}>{children}</label>,
  FormInput: (props: any) => <input {...props} />,
  FormSelect: ({ children, ...props }: any) => <select {...props}>{children}</select>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

// Mock hooks
const mockTeamsData = [
  { id: 'team-alpha', name: 'Alpha Team', members: [], projectIds: [], createdAt: '', updatedAt: '' },
  { id: 'team-beta', name: 'Beta Team', members: [], projectIds: [], createdAt: '', updatedAt: '' },
];

vi.mock('../../hooks/useTeams', () => ({
  useTeams: () => ({ teams: mockTeamsData, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock('../../hooks/useRoles', () => ({
  useRoles: () => ({ roles: [], isLoading: false }),
}));

vi.mock('../../hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [
      { id: 'project-1', name: 'Frontend App', path: '/path/to/frontend' },
      { id: 'project-2', name: 'Backend API', path: '/path/to/backend' },
    ],
    isLoading: false,
  }),
}));

vi.mock('../../hooks/useSkills', () => ({
  useSkills: () => ({ skills: [], loading: false }),
}));

vi.mock('../../services/roles.service', () => ({
  rolesService: { getRole: vi.fn() },
}));

vi.mock('@crewly/ui/Dialog', () => ({
  useAlert: () => ({
    showWarning: vi.fn(),
    AlertComponent: () => null,
  }),
}));

vi.mock('../Hierarchy', () => ({
  HierarchyModeConfig: () => <div data-testid="hierarchy-config">Hierarchy Config</div>,
}));

// Test data
const mockProjects = [
  {
    id: 'project-1',
    name: 'Frontend App',
    path: '/path/to/frontend'
  },
  {
    id: 'project-2',
    name: 'Backend API',
    path: '/path/to/backend'
  }
];

const mockRoles = {
  roles: [
    {
      key: 'tpm',
      displayName: 'Technical Product Manager',
      promptFile: 'tpm.md',
      description: 'Technical Product Manager role',
      category: 'management',
      isDefault: true
    },
    {
      key: 'fullstack-dev',
      displayName: 'Fullstack Developer',
      promptFile: 'fullstack-dev.md',
      description: 'Fullstack Developer role',
      category: 'development',
      isDefault: true
    },
    {
      key: 'qa',
      displayName: 'QA Engineer',
      promptFile: 'qa.md',
      description: 'QA Engineer role',
      category: 'quality',
      isDefault: false
    }
  ]
};

const mockTeam = {
  id: 'team-1',
  name: 'Development Team',
  description: 'Frontend development team',
  projectPath: 'project-1',
  members: [
    {
      id: '1',
      name: 'John Doe',
      role: 'tpm',
      systemPrompt: 'Load from tpm.md'
    },
    {
      id: '2',
      name: 'Jane Smith',
      role: 'fullstack-dev',
      systemPrompt: 'Load from fullstack-dev.md'
    }
  ]
};

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onSubmit: vi.fn()
};

describe('TeamModal Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default fetch mocks
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: mockProjects
          })
        });
      }
      if (url.includes('/api/config/available_team_roles.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockRoles)
        });
      }
      return Promise.resolve({ ok: false });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render modal when isOpen is true', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      expect(screen.getByTestId('form-popup')).toBeInTheDocument();
      expect(screen.getByText('Create New Team')).toBeInTheDocument();
      expect(screen.getByText('Set up a new collaborative team')).toBeInTheDocument();
    });

    it('should not render modal when isOpen is false', () => {
      render(<TeamModal {...defaultProps} isOpen={false} />);
      
      expect(screen.queryByTestId('form-popup')).not.toBeInTheDocument();
    });

    it('should render edit mode when team is provided', () => {
      render(<TeamModal {...defaultProps} team={mockTeam} />);
      
      expect(screen.getByText('Edit Team')).toBeInTheDocument();
      expect(screen.getByText('Modify team configuration and members')).toBeInTheDocument();
    });

    it('should render modal with lg size', () => {
      render(<TeamModal {...defaultProps} />);
      
      expect(screen.getByText('Size: lg')).toBeInTheDocument();
    });
  });

  describe('Form Fields', () => {
    it('should render all form fields', async () => {
      render(<TeamModal {...defaultProps} />);
      
      expect(screen.getByLabelText('Team Name *')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toBeInTheDocument();
      expect(screen.getByLabelText('Project (Optional)')).toBeInTheDocument();
    });

    it('should populate form fields when editing team', async () => {
      render(<TeamModal {...defaultProps} team={mockTeam} />);
      
      await waitFor(() => {
        const nameInput = screen.getByDisplayValue('Development Team');
        expect(nameInput).toBeInTheDocument();
        
        const descriptionInput = screen.getByDisplayValue('Frontend development team');
        expect(descriptionInput).toBeInTheDocument();
      });
    });

    it('should handle form field changes', async () => {
      render(<TeamModal {...defaultProps} />);
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team Name' } });
      
      expect(nameInput).toHaveValue('New Team Name');
      
      const descriptionInput = screen.getByLabelText('Description');
      fireEvent.change(descriptionInput, { target: { value: 'New description' } });
      
      expect(descriptionInput).toHaveValue('New description');
    });
  });

  describe('Projects Dropdown', () => {
    it('should fetch and render projects', async () => {
      render(<TeamModal {...defaultProps} />);
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/projects');
      });

      await waitFor(() => {
        const dropdown = screen.getByTestId('dropdown-projectPath');
        const select = dropdown.querySelector('select');
        expect(select).toBeInTheDocument();
      });
    });

    it('should handle project selection', async () => {
      render(<TeamModal {...defaultProps} />);
      
      await waitFor(() => {
        const dropdown = screen.getByTestId('dropdown-projectPath');
        const select = dropdown.querySelector('select');
        fireEvent.change(select!, { target: { value: 'project-1' } });
        expect(select).toHaveValue('project-1');
      });
    });

    it('should handle projects fetch error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/projects')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(mockRoles) });
      });

      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Error fetching projects:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });
  });

  describe('Team Roles', () => {
    it('should fetch and use team roles', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/config/available_team_roles.json');
      });
    });

    it('should handle roles fetch error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/config/available_team_roles.json')) {
          return Promise.reject(new Error('Config error'));
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: mockProjects }) });
      });

      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Error fetching available roles:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });
  });

  describe('Team Members', () => {
    it('should initialize with default members for new teams', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Team Members (2)')).toBeInTheDocument();
        expect(screen.getByText('Member 1')).toBeInTheDocument();
        expect(screen.getByText('Member 2')).toBeInTheDocument();
      });
    });

    it('should render existing members when editing team', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} team={mockTeam} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Team Members (2)')).toBeInTheDocument();
        expect(screen.getByDisplayValue('John Doe')).toBeInTheDocument();
        expect(screen.getByDisplayValue('Jane Smith')).toBeInTheDocument();
      });
    });

    it('should add new member when Add Member button is clicked', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Team Members (2)')).toBeInTheDocument();
      });

      const addButton = screen.getByText('+ Add Member');
      fireEvent.click(addButton);

      await waitFor(() => {
        expect(screen.getByText('Team Members (3)')).toBeInTheDocument();
        expect(screen.getByText('Member 3')).toBeInTheDocument();
      });
    });

    it('should remove member when Remove button is clicked', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Team Members (2)')).toBeInTheDocument();
      });

      const removeButtons = screen.getAllByText('Remove');
      fireEvent.click(removeButtons[0]);

      await waitFor(() => {
        expect(screen.getByText('Team Members (1)')).toBeInTheDocument();
      });
    });

    it('should not allow removing the last member', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      // Remove all but one member
      await waitFor(() => {
        const removeButtons = screen.getAllByText('Remove');
        fireEvent.click(removeButtons[0]);
      });

      await waitFor(() => {
        expect(screen.getByText('Team Members (1)')).toBeInTheDocument();
        expect(screen.queryByText('Remove')).not.toBeInTheDocument();
      });
    });

    it('should handle member name change', async () => {
      render(<TeamModal {...defaultProps} />);
      
      await waitFor(() => {
        const nameInputs = screen.getAllByPlaceholderText('Member name');
        expect(nameInputs).toHaveLength(2);
      });

      const nameInputs = screen.getAllByPlaceholderText('Member name');
      fireEvent.change(nameInputs[0], { target: { value: 'Updated Name' } });
      
      expect(nameInputs[0]).toHaveValue('Updated Name');
    });

    it('should handle member role change and update system prompt', async () => {
      render(<TeamModal {...defaultProps} />);
      
      await waitFor(() => {
        const roleDropdowns = screen.getAllByTestId(/dropdown-/);
        expect(roleDropdowns.length).toBeGreaterThan(0);
      });

      // Find role dropdowns (not the project dropdown)
      const roleDropdown = screen.getAllByTestId(/dropdown-/)[1]; // Skip project dropdown
      const select = roleDropdown.querySelector('select');
      
      if (select) {
        fireEvent.change(select, { target: { value: 'qa' } });
        expect(select).toHaveValue('qa');
      }
    });
  });

  describe('Form Submission', () => {
    it('should disable submit button when team name is empty', () => {
      render(<TeamModal {...defaultProps} />);
      
      const submitButton = screen.getByTestId('submit-button');
      expect(submitButton).toBeDisabled();
    });

    it('should enable submit button when team name is provided', async () => {
      render(<TeamModal {...defaultProps} />);
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });
    });

    it('should handle form submission for new team', async () => {
      render(<TeamModal {...defaultProps} />);
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });
      
      const descriptionInput = screen.getByLabelText('Description');
      fireEvent.change(descriptionInput, { target: { value: 'Team description' } });

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(defaultProps.onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'New Team',
            description: 'Team description',
            members: expect.any(Array)
          })
        );
      });
    });

    it('should handle form submission for team edit', async () => {
      const onSubmit = vi.fn();
      render(<TeamModal {...defaultProps} team={mockTeam} onSubmit={onSubmit} />);
      
      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Development Team',
            description: 'Frontend development team',
            members: expect.any(Array)
          })
        );
      });
    });

    it('should validate member names before submission', async () => {
      const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
      
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });

      // Clear member names
      await waitFor(() => {
        const memberNameInputs = screen.getAllByPlaceholderText('Member name');
        memberNameInputs.forEach(input => {
          fireEvent.change(input, { target: { value: '' } });
        });
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('All team members must have a name');
        expect(defaultProps.onSubmit).not.toHaveBeenCalled();
      });

      alertSpy.mockRestore();
    });

    it('should handle submission error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onSubmit = vi.fn().mockRejectedValue(new Error('Submission failed'));
      
      await act(async () => {
        render(<TeamModal {...defaultProps} onSubmit={onSubmit} />);
      });
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith('Error submitting team:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });
  });

  describe('Loading States', () => {
    it('should show loading state on submit button during submission', async () => {
      const onSubmit = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 100)));
      
      await act(async () => {
        render(<TeamModal {...defaultProps} onSubmit={onSubmit} />);
      });
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      // Should show loading state briefly
      await waitFor(() => {
        expect(screen.getByText('Loading...')).toBeInTheDocument();
      });
    });
  });

  describe('Modal Controls', () => {
    it('should handle close button click', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      const closeButton = screen.getByTestId('close-button');
      fireEvent.click(closeButton);
      
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Submit Button Text', () => {
    it('should show "Create Team" for new team', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      expect(screen.getByText('Create Team')).toBeInTheDocument();
    });

    it('should show "Update Team" for existing team', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} team={mockTeam} />);
      });
      
      expect(screen.getByText('Update Team')).toBeInTheDocument();
    });
  });

  describe('Data Processing', () => {
    it('should process project data correctly', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });

      // Select a project
      await waitFor(() => {
        const dropdown = screen.getByTestId('dropdown-projectPath');
        const select = dropdown.querySelector('select');
        fireEvent.change(select!, { target: { value: 'project-1' } });
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(defaultProps.onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            projectIds: ['project-1'],
            projectPath: '/path/to/frontend'
          })
        );
      });
    });

    it('should handle no project selection', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      const nameInput = screen.getByLabelText('Team Name *');
      fireEvent.change(nameInput, { target: { value: 'New Team' } });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(defaultProps.onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            projectIds: [],
            projectPath: undefined
          })
        );
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty members array in team data', async () => {
      const teamWithNoMembers = { ...mockTeam, members: [] };
      await act(async () => {
        render(<TeamModal {...defaultProps} team={teamWithNoMembers} />);
      });
      
      // Should still initialize with default members since members is empty
      expect(screen.getByText('Team Members')).toBeInTheDocument();
    });

    it('should handle invalid roles data', async () => {
      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/config/available_team_roles.json')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ invalid: 'data' })
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data: mockProjects }) });
      });

      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });
      
      // Should handle gracefully
      await waitFor(() => {
        expect(screen.getByText('Team Members')).toBeInTheDocument();
      });
    });

    it('should handle missing team data gracefully', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} team={undefined} />);
      });

      expect(screen.getByText('Create New Team')).toBeInTheDocument();
      expect(screen.getByLabelText('Team Name *')).toHaveValue('');
    });
  });

  describe('Parent Team Dropdown', () => {
    it('should render Parent Team dropdown with all teams listed', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });

      const parentSelect = screen.getByLabelText('Parent Team') as HTMLSelectElement;
      expect(parentSelect).toBeInTheDocument();

      // Should have "None" option plus the two mock teams
      const options = parentSelect.querySelectorAll('option');
      expect(options).toHaveLength(3); // None + Alpha + Beta
      expect(options[0].textContent).toBe('None (Independent Team)');
      expect(options[1].textContent).toBe('Alpha Team');
      expect(options[2].textContent).toBe('Beta Team');
    });

    it('should default to no parent team selected', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });

      const parentSelect = screen.getByLabelText('Parent Team') as HTMLSelectElement;
      expect(parentSelect.value).toBe('');
    });

    it('should allow selecting a parent team', async () => {
      await act(async () => {
        render(<TeamModal {...defaultProps} />);
      });

      const parentSelect = screen.getByLabelText('Parent Team') as HTMLSelectElement;
      fireEvent.change(parentSelect, { target: { name: 'parentTeamId', value: 'team-alpha' } });
      expect(parentSelect.value).toBe('team-alpha');
    });

    it('should exclude current team from parent dropdown when editing', async () => {
      // Use a team with empty members to avoid fetchRoleDetails infinite loop
      const editTeam = {
        id: 'team-alpha',
        name: 'Alpha Edit',
        members: [],
        projectIds: [],
      };

      await act(async () => {
        render(<TeamModal {...defaultProps} team={editTeam} />);
      });

      const parentSelect = screen.getByLabelText('Parent Team') as HTMLSelectElement;
      const options = parentSelect.querySelectorAll('option');
      // Should exclude team-alpha (self) — only None + Beta
      expect(options).toHaveLength(2);
      expect(options[0].textContent).toBe('None (Independent Team)');
      expect(options[1].textContent).toBe('Beta Team');
    });

    it('should pre-select parent team when editing team with parentTeamId', async () => {
      const editTeam = {
        id: 'team-1',
        name: 'Test',
        members: [],
        projectIds: [],
        parentTeamId: 'team-beta',
      };

      await act(async () => {
        render(<TeamModal {...defaultProps} team={editTeam} />);
      });

      const parentSelect = screen.getByLabelText('Parent Team') as HTMLSelectElement;
      expect(parentSelect.value).toBe('team-beta');
    });

    it('should include parentTeamId in submit data when parent is selected', async () => {
      const onSubmit = vi.fn();
      // Provide a team with a member (no role to avoid fetchRoleDetails loop)
      const teamWithMember = {
        id: 'team-1',
        name: 'Child Team',
        members: [{ id: '1', name: 'Agent', role: '', systemPrompt: '', runtimeType: 'claude-code' }],
        projectIds: [],
      };

      await act(async () => {
        render(<TeamModal {...defaultProps} onSubmit={onSubmit} team={teamWithMember} />);
      });

      // Select parent team
      const parentSelect = screen.getByLabelText('Parent Team');
      fireEvent.change(parentSelect, { target: { name: 'parentTeamId', value: 'team-alpha' } });

      // Submit the form
      const form = parentSelect.closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            parentTeamId: 'team-alpha',
          })
        );
      });
    });

    it('should send null parentTeamId when no parent selected', async () => {
      const onSubmit = vi.fn();
      const teamWithMember = {
        id: 'team-1',
        name: 'Independent Team',
        members: [{ id: '1', name: 'Agent', role: '', systemPrompt: '', runtimeType: 'claude-code' }],
        projectIds: [],
      };

      await act(async () => {
        render(<TeamModal {...defaultProps} onSubmit={onSubmit} team={teamWithMember} />);
      });

      // Submit without selecting parent
      const form = screen.getByLabelText('Parent Team').closest('form');
      await act(async () => {
        fireEvent.submit(form!);
      });

      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith(
          expect.objectContaining({
            parentTeamId: null,
          })
        );
      });
    });

    it('should allow clearing parent team selection', async () => {
      const editTeam = {
        id: 'team-1',
        name: 'Test',
        members: [],
        projectIds: [],
        parentTeamId: 'team-beta',
      };

      await act(async () => {
        render(<TeamModal {...defaultProps} team={editTeam} />);
      });

      const parentSelect = screen.getByLabelText('Parent Team') as HTMLSelectElement;
      expect(parentSelect.value).toBe('team-beta');

      // Clear selection
      fireEvent.change(parentSelect, { target: { name: 'parentTeamId', value: '' } });
      expect(parentSelect.value).toBe('');
    });
  });

  // Runs last on purpose: it is the only test in this file that successfully
  // adds a member (the rest of the suite predates the current modal markup),
  // and the role-details effect it triggers must not bleed into other tests.
  describe('Runtime selector (#306)', () => {
    it('should offer OpenCode CLI in the member runtime selector (#306)', async () => {
      // Adding a member fetches its role details; resolve to a real role so the
      // details cache short-circuits instead of re-fetching on every render.
      const { rolesService } = await import('../../services/roles.service');
      vi.mocked(rolesService.getRole).mockResolvedValue({
        ...mockRoles.roles[1],
        prompt: 'Fullstack developer prompt',
        skills: [],
      } as any);

      let view: ReturnType<typeof render> | undefined;
      await act(async () => {
        view = render(<TeamModal {...defaultProps} />);
      });

      // A new team starts with no members; add one to render the per-member runtime selector.
      await act(async () => {
        fireEvent.click(screen.getByText('Add Team Member'));
      });

      const runtimeSelect = await waitFor(() => {
        const el = document.getElementById('runtime-type-0') as HTMLSelectElement | null;
        expect(el).not.toBeNull();
        return el as HTMLSelectElement;
      });
      const values = Array.from(runtimeSelect.querySelectorAll('option')).map((o) => o.value);
      // Antigravity CLI replaces the retired Gemini CLI for new members.
      expect(values).toEqual(['claude-code', 'codex-cli', 'antigravity-cli', 'opencode-cli', 'crewly-agent']);
      const opencodeOption = runtimeSelect.querySelector('option[value="opencode-cli"]');
      expect(opencodeOption?.textContent).toBe('OpenCode CLI');
      expect(runtimeSelect.querySelector('option[value="antigravity-cli"]')?.textContent).toBe('Antigravity CLI');

      // Tear down explicitly so the role-details effect cannot keep running into the next test.
      await act(async () => {
        view?.unmount();
      });
      vi.mocked(rolesService.getRole).mockReset();
    });
  });
});