import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import { StartTeamModal } from './StartTeamModal';

// Mock fetch globally
global.fetch = vi.fn();

// Mock showWarning from useAlert hook
const mockShowWarning = vi.fn();
vi.mock('@crewly/ui/Dialog', () => ({
  useAlert: () => ({
    showWarning: mockShowWarning,
    AlertComponent: () => null
  })
}));

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
            disabled={submitDisabled || loading}
            data-testid="submit-button"
          >
            {submitText}
          </button>
          <button type="button" onClick={onClose} data-testid="close-button">
            Close
          </button>
        </form>
      </div>
    ) : null
  ),
  FormSection: ({ title, description, children }: any) => (
    <div data-testid="form-section">
      {title && <h3>{title}</h3>}
      {description && <p>{description}</p>}
      {children}
    </div>
  ),
  FormGroup: ({ children }: any) => (
    <div data-testid="form-group">{children}</div>
  ),
  FormLabel: ({ htmlFor, required, children }: any) => (
    <label htmlFor={htmlFor} data-testid="form-label">
      {children}
      {required && ' *'}
    </label>
  ),
  Dropdown: ({ id, value, onChange, placeholder, loading, required, options }: any) => (
    <div data-testid="dropdown">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      >
        <option value="">{loading ? 'Loading...' : placeholder}</option>
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  ),
}));

// Test data
const mockTeam = {
  id: 'team-1',
  name: 'Development Team',
  status: 'active',
  members: [
    { id: 'member-1', name: 'John Doe', role: 'Developer' },
    { id: 'member-2', name: 'Jane Smith', role: 'Designer' }
  ],
  projectIds: []
};

const mockTeamAssigned = {
  ...mockTeam,
  projectIds: ['project-1']
};

const mockProjects = [
  {
    id: 'project-1',
    name: 'Frontend App',
    path: '/path/to/frontend',
    description: 'Frontend application'
  },
  {
    id: 'project-2',
    name: 'Backend API',
    path: '/path/to/backend',
    description: 'Backend API service'
  }
];

const defaultProps = {
  isOpen: true,
  onClose: vi.fn(),
  onStartTeam: vi.fn(),
  team: mockTeam,
  loading: false
};

describe('StartTeamModal Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShowWarning.mockClear();

    // Setup default fetch mock for projects
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: mockProjects
      })
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Rendering', () => {
    it('should render modal when isOpen is true', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      expect(screen.getByTestId('form-popup')).toBeInTheDocument();
      expect(screen.getByText('Start Team')).toBeInTheDocument();
      expect(screen.getByText('Configure settings for Development Team')).toBeInTheDocument();
    });

    it('should not render modal when isOpen is false', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} isOpen={false} />);
      });
      
      expect(screen.queryByTestId('form-popup')).not.toBeInTheDocument();
    });

    it('should render team information', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Team: Development Team')).toBeInTheDocument();
        expect(screen.getByText('Members: 2')).toBeInTheDocument();
        expect(screen.getByText('Status: active')).toBeInTheDocument();
      });
    });

    it('should render modal size as xl', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });

      expect(screen.getByText('Size: xl')).toBeInTheDocument();
    });
  });

  describe('Project Selection', () => {
    it('should fetch projects when modal opens', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/projects');
      });
    });

    it('should render project dropdown for unassigned teams', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(screen.getByTestId('dropdown')).toBeInTheDocument();
        expect(screen.getByText('Select Project *')).toBeInTheDocument();
      });

      // Check if projects are loaded in dropdown
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        expect(select).toBeInTheDocument();
      });
    });

    it('should show assigned project info for assigned teams', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} team={mockTeamAssigned} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Already assigned to:')).toBeInTheDocument();
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      // Should not show dropdown for assigned teams
      expect(screen.queryByTestId('dropdown')).not.toBeInTheDocument();
    });

    it('should handle project selection', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        expect(select).toBeInTheDocument();
      });

      const select = screen.getByRole('combobox');
      fireEvent.change(select, { target: { value: 'project-1' } });
      
      expect(select).toHaveValue('project-1');
    });

    it('should handle projects fetch error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/projects');
        expect(consoleSpy).toHaveBeenCalledWith('Error fetching projects:', expect.any(Error));
      });

      consoleSpy.mockRestore();
    });

    it('should handle invalid API response format', async () => {
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ invalid: 'response' })
      });

      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalled();
      });

      // Should handle gracefully and show empty dropdown
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        expect(select).toBeInTheDocument();
      });
    });
  });

  describe('Form Submission', () => {
    it('should disable submit button when no project is selected', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).toBeDisabled();
      });
    });

    it('should enable submit button when project is selected', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'project-1' } });
      });

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });
    });

    it('should enable submit button for assigned teams', async () => {
      render(<StartTeamModal {...defaultProps} team={mockTeamAssigned} />);
      
      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });
    });

    it('should handle form submission for unassigned team', async () => {
      render(<StartTeamModal {...defaultProps} />);
      
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        fireEvent.change(select, { target: { value: 'project-1' } });
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(defaultProps.onStartTeam).toHaveBeenCalledWith('project-1');
        expect(defaultProps.onClose).toHaveBeenCalled();
      });
    });

    it('should handle form submission for assigned team', async () => {
      const props = { ...defaultProps, team: mockTeamAssigned };
      render(<StartTeamModal {...props} />);
      
      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).not.toBeDisabled();
      });

      const submitButton = screen.getByTestId('submit-button');
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(props.onStartTeam).toHaveBeenCalledWith('project-1');
        expect(props.onClose).toHaveBeenCalled();
      });
    });

    it('should show warning when no project is selected on submit', async () => {
      render(<StartTeamModal {...defaultProps} />);

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).toBeDisabled();
      });

      // Force submit by triggering form submit event
      const form = screen.getByTestId('form-popup').querySelector('form');
      fireEvent.submit(form!);

      expect(mockShowWarning).toHaveBeenCalledWith('Please select a project');
      expect(defaultProps.onStartTeam).not.toHaveBeenCalled();
    });
  });

  describe('Loading States', () => {
    it('should show loading state on submit button when loading', async () => {
      render(<StartTeamModal {...defaultProps} loading={true} />);

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).toHaveTextContent('Starting...');
        expect(submitButton).toBeDisabled();
      });
    });

    it('should show normal submit text when not loading', async () => {
      render(<StartTeamModal {...defaultProps} loading={false} />);

      await waitFor(() => {
        const submitButton = screen.getByTestId('submit-button');
        expect(submitButton).toHaveTextContent('Proceed');
      });
    });

    it('should show loading in project dropdown while fetching', async () => {
      // Make fetch take time to resolve
      (global.fetch as any).mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, data: mockProjects })
        }), 100))
      );

      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      // Initially should show loading
      await waitFor(() => {
        const select = screen.getByRole('combobox');
        const loadingOption = screen.getByText('Loading...');
        expect(loadingOption).toBeInTheDocument();
      });
    });
  });

  describe('Modal Controls', () => {
    it('should handle close button click', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      const closeButton = screen.getByTestId('close-button');
      fireEvent.click(closeButton);
      
      expect(defaultProps.onClose).toHaveBeenCalledTimes(1);
    });

    it('should not close modal automatically unless explicitly closed', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      // Modal should remain open
      expect(screen.getByTestId('form-popup')).toBeInTheDocument();
      
      // Only onClose should close the modal
      expect(defaultProps.onClose).not.toHaveBeenCalled();
    });
  });

  describe('Team Information Display', () => {
    it('should handle team with missing data gracefully', async () => {
      const incompleteTeam = {
        id: 'team-incomplete',
        name: undefined,
        members: undefined,
        status: undefined
      };

      await act(async () => {
        render(<StartTeamModal {...defaultProps} team={incompleteTeam} />);
      });
      
      expect(screen.getByText('Configure settings for team')).toBeInTheDocument();
      expect(screen.getByText('Team:')).toBeInTheDocument();
      expect(screen.getByText('Members: 0')).toBeInTheDocument();
      expect(screen.getByText('Status: idle')).toBeInTheDocument();
    });

    it('should display correct member count', async () => {
      const teamWithMoreMembers = {
        ...mockTeam,
        members: [
          { id: '1', name: 'Member 1' },
          { id: '2', name: 'Member 2' },
          { id: '3', name: 'Member 3' },
        ]
      };

      await act(async () => {
        render(<StartTeamModal {...defaultProps} team={teamWithMoreMembers} />);
      });
      
      expect(screen.getByText('Members: 3')).toBeInTheDocument();
    });
  });

  describe('Project Name Resolution', () => {
    it('should show "Unknown Project" for assigned team with missing project', async () => {
      const teamWithUnknownProject = {
        ...mockTeam,
        projectIds: ['non-existent-project']
      };

      await act(async () => {
        render(<StartTeamModal {...defaultProps} team={teamWithUnknownProject} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Already assigned to: Unknown Project')).toBeInTheDocument();
      });
    });

    it('should correctly resolve project name for assigned team', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} team={mockTeamAssigned} />);
      });
      
      await waitFor(() => {
        expect(screen.getByText('Already assigned to:')).toBeInTheDocument();
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });
    });
  });

  describe('Form Sections', () => {
    it('should render project assignment section', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} />);
      });
      
      expect(screen.getByText('Project Assignment')).toBeInTheDocument();
      expect(screen.getByText('Select which project this team will work on')).toBeInTheDocument();
    });

    it('should not show project selection description for assigned teams', async () => {
      await act(async () => {
        render(<StartTeamModal {...defaultProps} team={mockTeamAssigned} />);
      });
      
      expect(screen.getByText('Project Assignment')).toBeInTheDocument();
      expect(screen.queryByText('Select which project this team will work on')).not.toBeInTheDocument();
    });
  });
});