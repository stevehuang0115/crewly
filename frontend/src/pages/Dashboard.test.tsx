// Layout standardization
/**
 * Dashboard Page Tests
 *
 * Tests for the Dashboard page with ScoreCard stats and project/team grids.
 *
 * @module pages/Dashboard.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard, SAFETY_TIMEOUT_MS } from './Dashboard';
import { apiService } from '../services/api.service';

// Mock the navigate hook
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the API service
vi.mock('../services/api.service', () => ({
  apiService: {
    getProjects: vi.fn(),
    getTeams: vi.fn(),
    getAllTasks: vi.fn(),
    getIntentTaskStatistics: vi.fn(),
  },
}));

// Mock the TerminalContext
vi.mock('../contexts/TerminalContext', () => ({
  useTerminal: () => ({
    openTerminalWithSession: vi.fn(),
  }),
}));

// Mock AgentStreamPanel — renders a stub with the sessionName it receives
vi.mock('../components/ExecutionFeed/AgentStreamPanel', () => ({
  AgentStreamPanel: ({ sessionName }: { sessionName: string | null }) => (
    <div data-testid="agent-stream-panel">Streaming: {sessionName}</div>
  ),
}));

const mockProjects = [
  {
    id: 'project-1',
    name: 'Test Project 1',
    path: '/path/to/project1',
    status: 'active',
    updatedAt: new Date().toISOString(),
    teams: {},
  },
  {
    id: 'project-2',
    name: 'Test Project 2',
    path: '/path/to/project2',
    status: 'paused',
    updatedAt: new Date().toISOString(),
    teams: {},
  },
];

const mockTeams = [
  {
    id: 'team-1',
    name: 'Test Team 1',
    description: 'Team 1 description',
    members: [],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'team-2',
    name: 'Test Team 2',
    description: 'Team 2 description',
    members: [],
    updatedAt: new Date().toISOString(),
  },
];

/** Teams fixture with one active agent — used for Agent Activity section tests */
const mockTeamsWithActiveAgent = [
  {
    id: 'team-1',
    name: 'Test Team 1',
    description: 'Team 1 description',
    projectIds: ['project-1'],
    members: [
      {
        id: 'member-1',
        name: 'Agent Leo',
        role: 'developer',
        sessionName: 'crewly-product-leo',
        systemPrompt: '',
        agentStatus: 'active' as const,
        workingStatus: 'in_progress' as const,
        runtimeType: 'claude-code' as const,
      },
    ],
    updatedAt: new Date().toISOString(),
  },
];

/** Teams fixture with active agent assigned to project — used for Active Projects metric tests */
const mockTeamsWithActiveAgentAssigned = [
  {
    id: 'team-1',
    name: 'Team Alpha',
    description: 'Alpha team',
    projectIds: ['project-1'],
    members: [
      {
        id: 'member-1',
        name: 'Agent Leo',
        role: 'developer',
        sessionName: 'crewly-product-leo',
        systemPrompt: '',
        agentStatus: 'active' as const,
        workingStatus: 'in_progress' as const,
        runtimeType: 'claude-code' as const,
      },
    ],
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'team-2',
    name: 'Team Beta',
    description: 'Beta team',
    projectIds: ['project-2'],
    members: [
      {
        id: 'member-2',
        name: 'Agent Max',
        role: 'developer',
        sessionName: 'crewly-product-max',
        systemPrompt: '',
        agentStatus: 'inactive' as const,
        workingStatus: 'idle' as const,
        runtimeType: 'claude-code' as const,
      },
    ],
    updatedAt: new Date().toISOString(),
  },
];

const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>{children}</MemoryRouter>
);

describe('Dashboard Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiService.getProjects).mockResolvedValue(mockProjects);
    vi.mocked(apiService.getTeams).mockResolvedValue(mockTeams);
    vi.mocked(apiService.getAllTasks).mockResolvedValue([]);
    vi.mocked(apiService.getIntentTaskStatistics).mockResolvedValue({
      totalTasks: 0,
      byStatus: {},
      byLevel: {},
      totalTokens: 0,
      totalCost: 0,
      llmCost: 0,
      skillCost: 0,
      totalMessages: 0,
    });
  });

  describe('Layout', () => {
    it('should render the dashboard header', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
      });
    });

    it('should render projects section header', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        const headings = screen.getAllByText('Projects');
        expect(headings.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('should render teams section header', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        const headings = screen.getAllByText('Teams');
        expect(headings.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Loading State', () => {
    it('should show loading state initially', () => {
      // Make the API never resolve to see loading state
      vi.mocked(apiService.getProjects).mockImplementation(() => new Promise(() => {}));
      vi.mocked(apiService.getTeams).mockImplementation(() => new Promise(() => {}));

      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      expect(screen.getByText('Loading dashboard...')).toBeInTheDocument();
    });
  });

  describe('Projects Section', () => {
    it('should render project cards', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project 1')).toBeInTheDocument();
        expect(screen.getByText('Test Project 2')).toBeInTheDocument();
      });
    });

    it('should render View All link for projects', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        const viewAllLinks = screen.getAllByText('View All');
        expect(viewAllLinks.length).toBeGreaterThan(0);
      });
    });

    it('should render Create New Project card', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument();
      });
    });
  });

  describe('Teams Section', () => {
    it('should render team cards', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Team 1')).toBeInTheDocument();
        expect(screen.getByText('Test Team 2')).toBeInTheDocument();
      });
    });

    it('should render Create New Team card', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Create New Team')).toBeInTheDocument();
      });
    });
  });

  describe('Stat Cards', () => {
    it('should display stat cards with correct counts', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Active Projects')).toBeInTheDocument();
        expect(screen.getByText('Running Agents')).toBeInTheDocument();
      });
    });

    it('should render Factory button in HealthBar', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('health-factory-btn')).toBeInTheDocument();
      });
    });

    it('should count active projects based on running agents, not project.status', async () => {
      // project-1 has status 'active' but project-2 has status 'paused'
      // With team-based counting, only project-1 should be active (team-1 has active agent assigned to it)
      vi.mocked(apiService.getTeams).mockResolvedValue(mockTeamsWithActiveAgentAssigned);

      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Active Projects')).toBeInTheDocument();
      });

      // Find the Active Projects ScoreCard value — should be 1 (only project-1 has active agents)
      const activeProjectsLabel = screen.getByText('Active Projects');
      const scoreCard = activeProjectsLabel.closest('.score-card');
      expect(scoreCard).toBeInTheDocument();
      const valueEl = scoreCard?.querySelector('.score-card__value');
      expect(valueEl?.textContent).toBe('1');
    });

    it('should show 0 active projects when no agents are running', async () => {
      // Default mockTeams has no members, so no active agents
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Active Projects')).toBeInTheDocument();
      });

      const activeProjectsLabel = screen.getByText('Active Projects');
      const scoreCard = activeProjectsLabel.closest('.score-card');
      const valueEl = scoreCard?.querySelector('.score-card__value');
      expect(valueEl?.textContent).toBe('0');
    });

    it('should not render Connect to Cloud card', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
      });

      expect(screen.queryByText('Connect to Cloud')).not.toBeInTheDocument();
    });
  });

  describe('Agent Activity Section', () => {
    it('should NOT render agent activity section when no agents are active', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
      });

      expect(screen.queryByTestId('agent-activity-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('agent-stream-panel')).not.toBeInTheDocument();
    });

    it('should render agent activity section when an agent is active', async () => {
      vi.mocked(apiService.getTeams).mockResolvedValue(mockTeamsWithActiveAgent);

      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('agent-activity-section')).toBeInTheDocument();
      });

      expect(screen.getByText('Agent Activity')).toBeInTheDocument();
      expect(screen.getByTestId('agent-stream-panel')).toBeInTheDocument();
      expect(screen.getByText('Streaming: crewly-product-leo')).toBeInTheDocument();
    });

    it('should render green pulsing dot in agent activity header', async () => {
      vi.mocked(apiService.getTeams).mockResolvedValue(mockTeamsWithActiveAgent);

      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('agent-activity-section')).toBeInTheDocument();
      });

      const section = screen.getByTestId('agent-activity-section');
      const dot = section.querySelector('.animate-pulse.bg-emerald-400');
      expect(dot).toBeInTheDocument();
    });
  });

  describe('Navigation', () => {
    it('should navigate to factory when HealthBar Factory button is clicked', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        const factoryButton = screen.getByTestId('health-factory-btn');
        if (factoryButton) {
          fireEvent.click(factoryButton);
        }
      });

      expect(mockNavigate).toHaveBeenCalledWith('/factory');
    });

    it('should navigate to create project when Create New Project is clicked', async () => {
      render(
        <TestWrapper>
          <Dashboard />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Create New Project')).toBeInTheDocument();
      });

      const createCard = screen.getByText('Create New Project').closest('div');
      if (createCard) {
        fireEvent.click(createCard);
      }

      expect(mockNavigate).toHaveBeenCalledWith('/projects?create=true');
    });
  });

  /**
   * Safety timeout: if the initial data load exceeds 15s (e.g. the API is
   * frozen), the Dashboard bails out of the loading skeleton and shows an
   * error instead of leaving the user staring at a hung loader.
   *
   * Placed in its own describe so `vi.useFakeTimers` / `vi.useRealTimers`
   * are fully isolated — earlier siblings that rely on `waitFor`'s real
   * timer stay unaffected.
   */
  describe('Safety timeout', () => {
    it('exports SAFETY_TIMEOUT_MS as a positive millisecond duration', () => {
      expect(typeof SAFETY_TIMEOUT_MS).toBe('number');
      expect(SAFETY_TIMEOUT_MS).toBeGreaterThan(0);
    });

    it('surfaces an error after the deadline if loading never resolves', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(apiService.getProjects).mockImplementation(
          () => new Promise(() => {}),
        );
        vi.mocked(apiService.getTeams).mockImplementation(
          () => new Promise(() => {}),
        );

        render(
          <TestWrapper>
            <Dashboard />
          </TestWrapper>,
        );

        expect(screen.getByText('Loading dashboard...')).toBeInTheDocument();

        // Jump past the safety deadline (+1ms headroom)
        await vi.advanceTimersByTimeAsync(SAFETY_TIMEOUT_MS + 1);

        expect(
          screen.getByText(/took too long to load/i),
        ).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * Edge case introduced by the safety-timeout feature: if the
     * real API eventually completes AFTER the deadline fired, the
     * success path must clear the stale "took too long" error so
     * the user doesn't see fresh data sitting under an error banner.
     */
    it('clears the stale safety-timeout error if the real load later succeeds', async () => {
      vi.useFakeTimers();
      try {
        let resolveProjects!: (v: typeof mockProjects) => void;
        vi.mocked(apiService.getProjects).mockImplementation(
          () =>
            new Promise((r) => {
              resolveProjects = r;
            }),
        );
        vi.mocked(apiService.getTeams).mockResolvedValue(mockTeams);

        render(
          <TestWrapper>
            <Dashboard />
          </TestWrapper>,
        );

        // Deadline fires first → error is shown
        await vi.advanceTimersByTimeAsync(SAFETY_TIMEOUT_MS + 1);
        expect(screen.getByText(/took too long to load/i)).toBeInTheDocument();

        // Now the real request completes. Switch to real timers so
        // waitFor can poll, then resolve the pending projects promise.
        vi.useRealTimers();
        resolveProjects(mockProjects);

        await waitFor(() => {
          expect(
            screen.queryByText(/took too long to load/i),
          ).not.toBeInTheDocument();
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
