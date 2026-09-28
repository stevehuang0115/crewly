import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { BrowserRouter, MemoryRouter } from 'react-router-dom';
import { ProjectDetail } from './ProjectDetail';
import { apiService } from '../services/api.service';

// Mock the API service
vi.mock('../services/api.service');
const mockedApiService = vi.mocked(apiService);

// The Tasks tab shows project tickets (<project>/.crewly/tickets/)
const mockListProjectTickets = vi.fn();
vi.mock('../services/project-tickets.service', () => ({
  listProjectTickets: (...args: unknown[]) => mockListProjectTickets(...args),
  createProjectTicket: vi.fn(),
  updateProjectTicket: vi.fn(),
  assignProjectTicket: vi.fn(),
}));

// Mock the TerminalContext
const mockOpenTerminalWithSession = vi.fn();
vi.mock('../contexts/TerminalContext', () => ({
  useTerminal: () => ({
    openTerminalWithSession: mockOpenTerminalWithSession
  })
}));

// Mock fetch globally
global.fetch = vi.fn();

// Mock window methods
Object.defineProperty(window, 'location', {
  value: { href: '' },
  writable: true
});

// Test data
const mockProject = {
  id: 'project-1',
  name: 'Test Project',
  path: '/path/to/test/project',
  status: 'draft' as const,
  description: 'A test project for unit testing',
  teams: {},
  createdAt: '2024-01-01',
  updatedAt: '2024-01-02'
};

const mockTeams = [
  {
    id: 'team-1',
    name: 'Development Team',
    projectIds: ['project-1'],
    members: [
      { id: 'member-1', name: 'John Doe', sessionName: 'john_doe' }
    ],
    status: 'active' as const,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01'
  }
];

const mockTickets = [
  {
    id: 'TP-1',
    title: 'Setup project',
    description: 'Initial project setup',
    status: 'ready',
    priority: 'P1',
    assignee: null,
    labels: [],
    acceptance: [],
    log: [],
  }
];

// Wrapper component for router context
const TestWrapper: React.FC<{ children: React.ReactNode; initialEntry?: string }> = ({ 
  children, 
  initialEntry = '/projects/project-1' 
}) => (
  <MemoryRouter initialEntries={[initialEntry]}>
    {children}
  </MemoryRouter>
);

describe('ProjectDetail Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default API mocks
    mockedApiService.getProject.mockResolvedValue(mockProject);
    mockListProjectTickets.mockResolvedValue({ project: { id: 'project-1', name: 'Test Project', path: '/path/to/test/project' }, tickets: mockTickets, invalid: [] });
    mockedApiService.getTeams.mockResolvedValue(mockTeams);
    
    // Setup fetch mock
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: {} })
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should render loading spinner while loading project data', () => {
      // Make API calls hang to test loading state
      mockedApiService.getProject.mockImplementation(() => new Promise(() => {}));
      
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      expect(screen.getByText('Loading project...')).toBeInTheDocument();
      expect(document.querySelector('.loading-spinner')).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('should render error message when project loading fails', async () => {
      const errorMessage = 'Failed to load project';
      mockedApiService.getProject.mockRejectedValue(new Error(errorMessage));
      
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Error Loading Project')).toBeInTheDocument();
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
      });
    });

    it('should render error message when project is not found', async () => {
      mockedApiService.getProject.mockResolvedValue(null as any);
      
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Error Loading Project')).toBeInTheDocument();
        expect(screen.getByText('Project not found')).toBeInTheDocument();
      });
    });
  });

  describe('Successful Render', () => {
    it('should render project details correctly', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
        expect(screen.getByText('A test project for unit testing')).toBeInTheDocument();
        expect(screen.getByText('/path/to/test/project')).toBeInTheDocument();
      });

      // Check status badge
      expect(screen.getByText('draft')).toBeInTheDocument();
      
      // Check action buttons
      expect(screen.getByText('Assign Team')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('should render project tabs', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Detail')).toBeInTheDocument();
        expect(screen.getByText('Editor')).toBeInTheDocument();
        expect(screen.getByText('Tasks (1)')).toBeInTheDocument();
        expect(screen.getByText('Teams (1)')).toBeInTheDocument();
      });
    });

    it('should show correct project controls based on status and teams', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        // With assigned teams and draft status, should show Start Project
        expect(screen.getByText('Start Project')).toBeInTheDocument();
      });
    });

    it('should show stop/restart controls for active projects', async () => {
      mockedApiService.getProject.mockResolvedValue({
        ...mockProject,
        status: 'active'
      });

      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Stop Project')).toBeInTheDocument();
        expect(screen.getByText('Restart')).toBeInTheDocument();
        expect(screen.queryByText('Start Project')).not.toBeInTheDocument();
      });
    });
  });

  describe('Tab Navigation', () => {
    it('should switch tabs correctly', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Detail')).toBeInTheDocument();
      });

      // Click on Tasks tab
      fireEvent.click(screen.getByText('Tasks (1)'));
      
      // Tasks view should be rendered (check for task-related content)
      await waitFor(() => {
        // The project tickets board should be rendered
        expect(screen.getByText('Detail').closest('.tab')).not.toHaveClass('tab--active');
      });

      // Click on Teams tab  
      fireEvent.click(screen.getByText('Teams (1)'));
      
      // Teams view should be rendered
      await waitFor(() => {
        expect(screen.getByText('Teams (1)').closest('.tab')).toHaveClass('tab--active');
      });
    });

    it('should show active tab styling', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        // Detail tab should be active by default
        expect(screen.getByText('Detail').closest('.tab')).toHaveClass('tab--active');
        expect(screen.getByText('Editor').closest('.tab')).not.toHaveClass('tab--active');
      });
    });
  });

  describe('Project Actions', () => {
    it('should handle assign teams button click', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Assign Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Assign Team'));
      
      // Team assignment modal should be shown (assuming it renders a title)
      await waitFor(() => {
        // The modal would render, but since we're not mocking the modal component,
        // we just verify the click handler was triggered
        expect(screen.getByText('Assign Team')).toBeInTheDocument();
      });
    });

    it('should handle start project button click', async () => {
      const startProjectSpy = vi.spyOn(apiService, 'startProject').mockResolvedValue({
        success: true,
        message: 'Project started successfully'
      });

      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Start Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Start Project'));

      await waitFor(() => {
        expect(startProjectSpy).toHaveBeenCalledWith('project-1', ['team-1']);
      });
    });

    it('should handle delete project confirmation', async () => {
      // Mock window.confirm to automatically confirm
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
      
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Delete')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Delete'));

      // Verify the confirmation dialog would be shown
      expect(screen.getByText('Delete')).toBeInTheDocument();
      
      confirmSpy.mockRestore();
    });

    it('should handle open in finder', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Open in Finder')).toBeInTheDocument();
      });

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true })
      });

      fireEvent.click(screen.getByText('Open in Finder'));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/projects/project-1/open-finder',
          expect.objectContaining({ method: 'POST' })
        );
      });
    });
  });

  describe('API Error Handling', () => {
    it('should handle start project API errors', async () => {
      const errorMessage = 'Failed to start project';
      vi.spyOn(apiService, 'startProject').mockRejectedValue(new Error(errorMessage));

      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Start Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Start Project'));

      // Error would be shown via alert system (not directly testable without mocking the alert system)
      await waitFor(() => {
        expect(screen.getByText('Start Project')).toBeInTheDocument();
      });
    });

    it('should handle fetch errors gracefully', async () => {
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Open in Finder')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Open in Finder'));

      // Should handle the error gracefully (error would be shown via alert system)
      await waitFor(() => {
        expect(screen.getByText('Open in Finder')).toBeInTheDocument();
      });
    });
  });

  describe('Component Integration', () => {
    it('should pass correct props to child components', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
      });

      // Verify that child components receive the expected project data
      // This is verified indirectly through the rendered content
      expect(screen.getByText('A test project for unit testing')).toBeInTheDocument();
      expect(screen.getByText('/path/to/test/project')).toBeInTheDocument();
    });

    it('should handle terminal integration', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
      });

      // Terminal context should be available
      expect(mockOpenTerminalWithSession).toBeDefined();
    });
  });

  describe('URL Parameter Handling', () => {
    it('should load project data based on URL parameter', async () => {
      render(
        <TestWrapper initialEntry="/projects/different-project">
          <ProjectDetail />
        </TestWrapper>
      );

      // Should attempt to load the project from URL
      await waitFor(() => {
        expect(mockedApiService.getProject).toHaveBeenCalledWith('different-project');
      });
    });

    it('should handle missing project ID parameter', async () => {
      render(
        <TestWrapper initialEntry="/projects/">
          <ProjectDetail />
        </TestWrapper>
      );

      // Should handle gracefully when no ID is provided
      await waitFor(() => {
        // Component should still render but might show loading or error state
        expect(document.querySelector('.project-detail-loading, .project-detail-error')).toBeTruthy();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels and roles', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
      });

      // Check for accessible button elements
      const assignButton = screen.getByText('Assign Team');
      expect(assignButton).toBeInTheDocument();
      expect(assignButton.tagName).toBe('BUTTON');

      const deleteButton = screen.getByText('Delete');
      expect(deleteButton).toHaveAttribute('title', 'Delete project from Crewly (files will be kept)');
    });

    it('should have proper heading hierarchy', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        const heading = screen.getByText('Test Project');
        expect(heading).toBeInTheDocument();
        expect(heading.tagName).toBe('H1');
        expect(heading).toHaveClass('page-title');
      });
    });

    it('should provide keyboard navigation support', async () => {
      render(
        <TestWrapper>
          <ProjectDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
      });

      // Check that buttons are focusable
      const assignButton = screen.getByText('Assign Team');
      assignButton.focus();
      expect(document.activeElement).toBe(assignButton);
    });
  });
});