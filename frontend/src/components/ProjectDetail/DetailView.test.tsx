import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi } from 'vitest';
import { DetailView } from './DetailView';
import { DetailViewProps } from './types';

// Project metrics come from the project's own backlog (project tickets).
const mockListProjectTickets = vi.fn();
vi.mock('../../services/project-tickets.service', () => ({
  listProjectTickets: (...args: unknown[]) => mockListProjectTickets(...args),
}));

// Mock the fetch function
global.fetch = vi.fn();

// Mock data
const mockProject = {
  id: 'test-project-1',
  name: 'Test Project',
  path: '/path/to/test/project',
  status: 'active',
  description: 'A test project for unit testing',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-02')
};

const mockBuildSpecsWorkflow = {
  isActive: false,
  steps: []
};

const mockAlignmentStatus = {
  hasAlignmentIssues: false,
  alignmentFilePath: null,
  content: null
};

const mockAvailableTeams = [
  {
    id: 'team-1',
    name: 'Development Team',
    projectIds: ['test-project-1'],
    members: [
      { id: 'member-1', name: 'John Doe', sessionName: 'john-session' }
    ]
  }
];

const defaultProps = {
  project: mockProject,
  onAddGoal: vi.fn(),
  onEditGoal: vi.fn(),
  onAddUserJourney: vi.fn(),
  onEditUserJourney: vi.fn(),
  onBuildSpecs: vi.fn(),
  buildSpecsWorkflow: mockBuildSpecsWorkflow,
  alignmentStatus: mockAlignmentStatus,
  onContinueWithMisalignment: vi.fn(),
  onViewAlignment: vi.fn(),
  selectedBuildSpecsTeam: '',
  setSelectedBuildSpecsTeam: vi.fn(),
  availableTeams: mockAvailableTeams,
} as unknown as DetailViewProps;

describe('DetailView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListProjectTickets.mockResolvedValue({
      project: { id: 'test-project-1', name: 'Test Project', path: '/path/to/test/project' },
      tickets: [{ status: 'done' }, { status: 'in_progress' }, { status: 'cancelled' }],
      invalid: [],
    });

    // Mock successful API responses
    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          mdFileCount: 3,
          taskCount: 10,
          hasProjectMd: true,
          hasUserJourneyMd: true,
          hasInitialGoalMd: true,
          hasInitialUserJourneyMd: true
        }
      })
    } as Response);
  });

  it('renders the details header', async () => {
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    expect(screen.getByText('Project Details')).toBeInTheDocument();
    expect(screen.getByText('Overview and key metrics for your project')).toBeInTheDocument();
  });

  it('displays loading state initially', async () => {
    (fetch as any).mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    expect(screen.getByText('Loading project metrics...')).toBeInTheDocument();
  });

  it('computes the metrics from project tickets (cancelled ones do not count)', async () => {
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.queryByText('Loading project metrics...')).not.toBeInTheDocument();
    });

    expect(mockListProjectTickets).toHaveBeenCalledWith('test-project-1');
    expect(screen.getByText('Project Metrics')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('shows Edit buttons when spec files exist', async () => {
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      const editButtons = screen.getAllByText('Edit');
      expect(editButtons).toHaveLength(2); // One for Goal, one for User Journey
      expect(editButtons[0]).toBeInTheDocument();
    });
  });

  it('shows Add buttons when spec files do not exist', async () => {
    // Mock API response with no spec files
    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          mdFileCount: 0,
          taskCount: 0,
          hasProjectMd: false,
          hasUserJourneyMd: false,
          hasInitialGoalMd: false,
          hasInitialUserJourneyMd: false
        }
      })
    } as Response);

    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Add Goal')).toBeInTheDocument();
      expect(screen.getByText('Add User Journey')).toBeInTheDocument();
    });
  });

  it('calls onAddGoal when Add Goal button is clicked', async () => {
    // Mock API response with no goal file
    (fetch as any).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        data: {
          mdFileCount: 0,
          taskCount: 0,
          hasProjectMd: false,
          hasUserJourneyMd: false,
          hasInitialGoalMd: false,
          hasInitialUserJourneyMd: true
        }
      })
    } as Response);

    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      const addGoalButton = screen.getByText('Add Goal');
      fireEvent.click(addGoalButton);
    });

    expect(defaultProps.onAddGoal).toHaveBeenCalledTimes(1);
  });

  it('calls onEditGoal when Edit button is clicked', async () => {
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      const editButtons = screen.getAllByText('Edit');
      // Click the first Edit button (Goal section)
      fireEvent.click(editButtons[0]);
    });

    expect(defaultProps.onEditGoal).toHaveBeenCalledTimes(1);
  });

  it('points task generation at the chat (no dead create buttons)', async () => {
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText('Generate Project Tasks')).toBeInTheDocument();
    });
    expect(screen.getByText('Open Chat to Generate Tasks')).toBeInTheDocument();
    expect(screen.queryByText('Create Specs Tasks')).not.toBeInTheDocument();
  });

  it('handles API errors gracefully', async () => {
    // Mock console.error to avoid error output in tests
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock failed API response
    (fetch as any).mockRejectedValue(new Error('API Error'));

    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.queryByText('Loading project metrics...')).not.toBeInTheDocument();
    });

    expect(consoleSpy).toHaveBeenCalledWith('Error loading project stats:', expect.any(Error));

    consoleSpy.mockRestore();
  });

  it('loads project stats on component mount', async () => {
    await act(async () => {
      render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(`/api/projects/${mockProject.id}/stats`);
    });
  });

  it('reloads project stats when project id changes', async () => {
    const { rerender } = await act(async () => {
      return render(<DetailView {...defaultProps} />);
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    const newProps = {
      ...defaultProps,
      project: { ...mockProject, id: 'new-project-id' }
    } as unknown as DetailViewProps;

    await act(async () => {
      rerender(<DetailView {...newProps} />);
    });

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenLastCalledWith('/api/projects/new-project-id/stats');
    });
  });
});
