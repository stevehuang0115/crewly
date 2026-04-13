// Updated: PageToolbar adoption
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Projects } from './Projects';
import axios from 'axios';

// Mock axios
vi.mock('axios');
const mockedAxios = vi.mocked(axios);

// Mock the useNavigate hook
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock child components to simplify testing
vi.mock('@/components/Cards/ProjectCard', () => ({
  ProjectCard: ({ project, onClick }: any) => (
    <div 
      data-testid={`project-card-${project.id}`}
      onClick={() => onClick()}
      className="project-card"
    >
      <h3>{project.name}</h3>
      <p>{project.path}</p>
      <span className={`status-${project.status}`}>{project.status}</span>
    </div>
  )
}));

vi.mock('@/components/Cards/CreateCard', () => ({
  CreateCard: ({ title, onClick }: any) => (
    <div 
      data-testid="create-card"
      onClick={onClick}
      className="create-card"
    >
      {title}
    </div>
  )
}));

vi.mock('@/components/Modals/ProjectCreator', () => ({
  ProjectCreator: ({ onSave, onClose }: any) => (
    <div data-testid="project-creator">
      <h2>Create New Project</h2>
      <button 
        onClick={() => onSave('/test/project/path')}
      >
        Create Project
      </button>
      <button onClick={onClose}>Close</button>
    </div>
  )
}));

// Test data
const mockProjects = [
  {
    id: 'project-1',
    name: 'Frontend App',
    path: '/path/to/frontend',
    status: 'active',
    description: 'Frontend application',
    teams: {},
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02'
  },
  {
    id: 'project-2',
    name: 'Backend API',
    path: '/path/to/backend',
    status: 'paused',
    description: 'Backend API service',
    teams: {},
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02'
  },
  {
    id: 'project-3',
    name: 'Mobile App',
    path: '/path/to/mobile',
    status: 'completed',
    description: 'Mobile application',
    teams: {},
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02'
  }
];

const TestWrapper: React.FC<{ children: React.ReactNode; initialEntry?: string }> = ({ 
  children, 
  initialEntry = '/' 
}) => (
  <MemoryRouter initialEntries={[initialEntry]}>
    {children}
  </MemoryRouter>
);

describe('Projects Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup default axios mock for projects
    mockedAxios.get.mockResolvedValue({
      data: {
        success: true,
        data: mockProjects
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should render loading state initially', () => {
      // Make axios hang to test loading state
      mockedAxios.get.mockImplementation(() => new Promise(() => {}));
      
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      expect(screen.getByText('Loading projects...')).toBeInTheDocument();
      expect(document.querySelector('.loading-spinner')).toBeInTheDocument();
    });
  });

  describe('Successful Render', () => {
    it('should render projects page with header and controls', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Projects')).toBeInTheDocument();
      });

      expect(screen.getByText('Manage and monitor your Crewly projects')).toBeInTheDocument();
      expect(screen.getByText('New Project')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search projects...')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });

    it('should render project cards correctly', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      expect(screen.getByText('Backend API')).toBeInTheDocument();
      expect(screen.getByText('Mobile App')).toBeInTheDocument();
      expect(screen.getByText('/path/to/frontend')).toBeInTheDocument();
      expect(screen.getByText('/path/to/backend')).toBeInTheDocument();
      expect(screen.getByText('/path/to/mobile')).toBeInTheDocument();
    });

    it('should render create card', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('create-card')).toBeInTheDocument();
      });

      expect(screen.getByText('New Project')).toBeInTheDocument();
    });
  });

  describe('Search and Filter Functionality', () => {
    it('should filter projects by search term', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search projects...');
      fireEvent.change(searchInput, { target: { value: 'frontend' } });

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
        expect(screen.queryByText('Backend API')).not.toBeInTheDocument();
        expect(screen.queryByText('Mobile App')).not.toBeInTheDocument();
      });
    });

    it('should filter projects by path', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search projects...');
      fireEvent.change(searchInput, { target: { value: 'backend' } });

      await waitFor(() => {
        expect(screen.queryByText('Frontend App')).not.toBeInTheDocument();
        expect(screen.getByText('Backend API')).toBeInTheDocument();
        expect(screen.queryByText('Mobile App')).not.toBeInTheDocument();
      });
    });

    it('should filter projects by status', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      const statusFilter = screen.getByRole('combobox');
      fireEvent.change(statusFilter, { target: { value: 'active' } });

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
        expect(screen.queryByText('Backend API')).not.toBeInTheDocument();
        expect(screen.queryByText('Mobile App')).not.toBeInTheDocument();
      });
    });

    it('should filter projects by paused status', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      const statusFilter = screen.getByRole('combobox');
      fireEvent.change(statusFilter, { target: { value: 'paused' } });

      await waitFor(() => {
        expect(screen.queryByText('Frontend App')).not.toBeInTheDocument();
        expect(screen.getByText('Backend API')).toBeInTheDocument();
        expect(screen.queryByText('Mobile App')).not.toBeInTheDocument();
      });
    });

    it('should combine search and filter criteria', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search projects...');
      fireEvent.change(searchInput, { target: { value: 'app' } });

      const statusFilter = screen.getByRole('combobox');
      fireEvent.change(statusFilter, { target: { value: 'completed' } });

      await waitFor(() => {
        expect(screen.queryByText('Frontend App')).not.toBeInTheDocument();
        expect(screen.queryByText('Backend API')).not.toBeInTheDocument();
        expect(screen.getByText('Mobile App')).toBeInTheDocument();
      });
    });

    it('should show empty state when no projects match filters', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend App')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search projects...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent' } });

      await waitFor(() => {
        expect(screen.getByText('No projects found')).toBeInTheDocument();
        expect(screen.getByText('Try adjusting your search or filter criteria')).toBeInTheDocument();
      });
    });
  });

  describe('Project Interactions', () => {
    it('should navigate to project detail on project card click', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-card-project-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('project-card-project-1'));

      expect(mockNavigate).toHaveBeenCalledWith('/projects/project-1');
    });

    it('should open project creator modal from header button', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Project'));

      await waitFor(() => {
        expect(screen.getByTestId('project-creator')).toBeInTheDocument();
        expect(screen.getByText('Create New Project')).toBeInTheDocument();
      });
    });

    it('should open project creator modal from create card', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('create-card')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('create-card'));

      await waitFor(() => {
        expect(screen.getByTestId('project-creator')).toBeInTheDocument();
      });
    });
  });

  describe('Project Creation', () => {
    it('should create new project successfully', async () => {
      const newProject = {
        id: 'project-4',
        name: 'New Project',
        path: '/test/project/path',
        status: 'active',
        description: 'New test project',
        teams: {},
        createdAt: '2024-01-03',
        updatedAt: '2024-01-03'
      };

      mockedAxios.get.mockResolvedValue({
        data: { success: true, data: mockProjects }
      });

      mockedAxios.post.mockResolvedValue({
        data: { success: true, data: newProject }
      });

      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Project'));

      await waitFor(() => {
        expect(screen.getByTestId('project-creator')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Create Project'));

      await waitFor(() => {
        expect(mockedAxios.post).toHaveBeenCalledWith('/api/projects', { 
          path: '/test/project/path' 
        });
        expect(mockNavigate).toHaveBeenCalledWith('/projects/project-4');
      });
    });

    it('should handle project creation error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockedAxios.get.mockResolvedValue({
        data: { success: true, data: mockProjects }
      });

      mockedAxios.post.mockRejectedValue(new Error('Project creation failed'));

      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Project'));

      await waitFor(() => {
        expect(screen.getByTestId('project-creator')).toBeInTheDocument();
      });

      await expect(async () => {
        fireEvent.click(screen.getByText('Create Project'));
        await waitFor(() => {
          expect(mockedAxios.post).toHaveBeenCalled();
        });
      }).rejects.toThrow('Project creation failed');

      consoleSpy.mockRestore();
    });

    it('should close project creator modal', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Project')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Project'));

      await waitFor(() => {
        expect(screen.getByTestId('project-creator')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Close'));

      await waitFor(() => {
        expect(screen.queryByTestId('project-creator')).not.toBeInTheDocument();
      });
    });
  });

  describe('URL Parameters', () => {
    it('should open project creator modal when create param is true', async () => {
      render(
        <TestWrapper initialEntry="/?create=true">
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('project-creator')).toBeInTheDocument();
      });
    });

    it('should not open project creator modal when create param is false', async () => {
      render(
        <TestWrapper initialEntry="/?create=false">
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Projects')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('project-creator')).not.toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('should handle API fetch error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      mockedAxios.get.mockRejectedValue(new Error('Network error'));

      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Projects')).toBeInTheDocument();
      });

      // Should show empty state when no projects are loaded due to error
      await waitFor(() => {
        expect(screen.getByText('No projects yet')).toBeInTheDocument();
        expect(screen.getByText('Create your first project to get started with Crewly')).toBeInTheDocument();
      });

      consoleSpy.mockRestore();
    });

    it('should handle unsuccessful API response', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { success: false, data: null }
      });

      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No projects yet')).toBeInTheDocument();
      });
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no projects exist', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { success: true, data: [] }
      });

      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No projects yet')).toBeInTheDocument();
        expect(screen.getByText('Create your first project to get started with Crewly')).toBeInTheDocument();
        expect(screen.getByText('Create Project')).toBeInTheDocument();
      });
    });

    it('should show create button in empty state only when no filters', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { success: true, data: [] }
      });

      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Create Project')).toBeInTheDocument();
      });

      // Apply a filter
      const statusFilter = screen.getByRole('combobox');
      fireEvent.change(statusFilter, { target: { value: 'active' } });

      await waitFor(() => {
        expect(screen.queryByText('Create Project')).not.toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        const heading = screen.getByText('Projects');
        expect(heading).toBeInTheDocument();
        expect(heading.tagName).toBe('H1');
        expect(heading).toHaveClass('page-title');
      });
    });

    it('should have accessible form controls', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText('Search projects...');
        expect(searchInput).toBeInTheDocument();
        expect(searchInput).toHaveAttribute('type', 'text');

        const selectFilter = screen.getByRole('combobox');
        expect(selectFilter).toBeInTheDocument();
      });
    });

    it('should support keyboard navigation', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        const newProjectButton = screen.getByText('New Project');
        expect(newProjectButton).toBeInTheDocument();
      });

      const newProjectButton = screen.getByText('New Project');
      newProjectButton.focus();
      expect(document.activeElement).toBe(newProjectButton);
    });

    it('should have proper search input labeling', async () => {
      render(
        <TestWrapper>
          <Projects />
        </TestWrapper>
      );

      await waitFor(() => {
        const searchInput = screen.getByPlaceholderText('Search projects...');
        expect(searchInput).toBeInTheDocument();
        expect(searchInput).toHaveAttribute('placeholder', 'Search projects...');
      });
    });
  });
});