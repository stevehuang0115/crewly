// Layout standardization
// Dropdown update
// Updated: custom Dropdown component
// Updated: PageToolbar adoption
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Teams } from './Teams';

// Mock the useNavigate hook
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Mock the API service (component uses apiService, not fetch)
vi.mock('../services/api.service', () => ({
  apiService: {
    getTeams: vi.fn(),
    getProjects: vi.fn(),
    deleteTeam: vi.fn(),
  },
}));

// Mock websocket service
vi.mock('../services/websocket.service', () => ({
  webSocketService: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

// Mock useAlert
vi.mock('../components/UI/Dialog', () => ({
  useAlert: () => ({
    showError: vi.fn(),
    AlertComponent: () => null,
  }),
}));

// Mock error utility
vi.mock('@/utils/error-handling', () => ({
  logSilentError: vi.fn(),
}));

// Mock useAuth context
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    getAccessToken: () => null,
  }),
}));

// Mock useCloudConnection hook
vi.mock('../hooks/useCloudConnection', () => ({
  useCloudConnection: () => ({
    isConnected: false,
    tier: null,
  }),
}));

// Mock useDeviceHeartbeat hook
vi.mock('../hooks/useDeviceHeartbeat', () => ({
  useDeviceHeartbeat: () => ({
    devices: [],
    isLoading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// Mock child components
vi.mock('@/components/Teams/TeamsGridCard', () => ({
  __esModule: true,
  default: ({ team, onClick }: any) => (
    <div data-testid={`grid-card-${team.id}`} onClick={onClick}>
      <span>{team.name}</span>
      <span>{team.description}</span>
      {team.members?.map((m: any) => (
        <span key={m.id} data-testid={`member-${m.id}`}>{m.name} - {m.role}</span>
      ))}
    </div>
  ),
}));

vi.mock('@/components/Teams/TeamListItem', () => ({
  __esModule: true,
  default: ({ team, onClick }: any) => (
    <div data-testid={`list-item-${team.id}`} onClick={onClick}>
      <span>{team.name}</span>
    </div>
  ),
}));

vi.mock('../components/Modals/TeamModal', () => ({
  TeamModal: ({ isOpen, onClose, onSubmit }: any) =>
    isOpen ? (
      <div data-testid="team-modal">
        <h2>Create New Team</h2>
        <button
          onClick={() => onSubmit({
            name: 'New Team',
            description: 'Test team',
            members: [],
          })}
        >
          Create Team
        </button>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

vi.mock('../components/Modals/TeamMemberModal', () => ({
  TeamMemberModal: ({ member, teamId, onClose }: any) => (
    <div data-testid="team-member-modal">
      <h2>Team Member: {member.name}</h2>
      <p>Role: {member.role}</p>
      <p>Team ID: {teamId}</p>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}));

// Import mocked module for direct manipulation
import { apiService } from '../services/api.service';

const mockGetTeams = apiService.getTeams as ReturnType<typeof vi.fn>;
const mockGetProjects = apiService.getProjects as ReturnType<typeof vi.fn>;

// Test data
const mockTeams = [
  {
    id: 'team-1',
    name: 'Frontend Team',
    description: 'Frontend development team',
    projectIds: ['project-1'],
    members: [
      { id: 'member-1', name: 'John Doe', role: 'developer', agentStatus: 'active' },
      { id: 'member-2', name: 'Jane Smith', role: 'designer', agentStatus: 'inactive' },
    ],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02',
  },
  {
    id: 'team-2',
    name: 'Backend Team',
    description: 'Backend development team',
    projectIds: [],
    members: [
      { id: 'member-3', name: 'Bob Wilson', role: 'developer', agentStatus: 'inactive' },
    ],
    createdAt: '2024-01-01',
    updatedAt: '2024-01-02',
  },
];

const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <MemoryRouter>
    {children}
  </MemoryRouter>
);

describe('Teams Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: apiService returns mock teams and empty projects
    mockGetTeams.mockResolvedValue(mockTeams);
    mockGetProjects.mockResolvedValue([]);
    // Mock global.fetch for handleCreateTeam (still uses fetch)
    global.fetch = vi.fn() as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should render loading state initially', () => {
      // Make getTeams hang to test loading state
      mockGetTeams.mockImplementation(() => new Promise(() => {}));

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      expect(screen.getByText('Loading teams...')).toBeInTheDocument();
    });
  });

  describe('Successful Render', () => {
    it('should render teams page with header and controls', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Teams')).toBeInTheDocument();
      });

      expect(screen.getByText('Manage and organize your development teams')).toBeInTheDocument();
      expect(screen.getByText('New Team')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Search teams...')).toBeInTheDocument();
    });

    it('should render team cards correctly', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend Team')).toBeInTheDocument();
      });

      expect(screen.getByText('Backend Team')).toBeInTheDocument();
    });
  });

  describe('Search and Filter Functionality', () => {
    it('should filter teams by search query', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend Team')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search teams...');
      fireEvent.change(searchInput, { target: { value: 'frontend' } });

      await waitFor(() => {
        expect(screen.getByText('Frontend Team')).toBeInTheDocument();
        expect(screen.queryByText('Backend Team')).not.toBeInTheDocument();
      });
    });

    it('should filter teams by member name', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend Team')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search teams...');
      fireEvent.change(searchInput, { target: { value: 'john doe' } });

      await waitFor(() => {
        expect(screen.getByText('Frontend Team')).toBeInTheDocument();
        expect(screen.queryByText('Backend Team')).not.toBeInTheDocument();
      });
    });

    it('should show empty state when no teams match filters', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Frontend Team')).toBeInTheDocument();
      });

      const searchInput = screen.getByPlaceholderText('Search teams...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent team' } });

      await waitFor(() => {
        expect(screen.getByText('No teams found')).toBeInTheDocument();
        expect(screen.getByText('Try adjusting your search or filters')).toBeInTheDocument();
      });
    });
  });

  describe('Team Interactions', () => {
    it('should navigate to team detail on team click', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('grid-card-team-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('grid-card-team-1'));

      expect(mockNavigate).toHaveBeenCalledWith('/teams/team-1');
    });
  });

  describe('Team Creation', () => {
    it('should open team creation modal', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Team'));

      await waitFor(() => {
        expect(screen.getByTestId('team-modal')).toBeInTheDocument();
      });
    });

    it('should create new team successfully via fetch', async () => {
      const newTeam = {
        id: 'team-3',
        name: 'New Team',
        description: 'Test team',
        members: [],
        createdAt: '2024-01-03',
        updatedAt: '2024-01-03',
      };

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true, data: newTeam }),
      });

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Team'));

      await waitFor(() => {
        expect(screen.getByTestId('team-modal')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Create Team'));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/teams', expect.objectContaining({
          method: 'POST',
        }));
      });
    });

    it('should close team creation modal', async () => {
      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('New Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('New Team'));

      await waitFor(() => {
        expect(screen.getByTestId('team-modal')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Close'));

      await waitFor(() => {
        expect(screen.queryByTestId('team-modal')).not.toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle API fetch error gracefully', async () => {
      mockGetTeams.mockRejectedValue(new Error('Network error'));

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No teams found')).toBeInTheDocument();
        expect(screen.getByText('Create your first team to get started')).toBeInTheDocument();
      });
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no teams exist', async () => {
      mockGetTeams.mockResolvedValue([]);

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No teams found')).toBeInTheDocument();
        expect(screen.getByText('Create your first team to get started')).toBeInTheDocument();
      });
    });
  });

  describe('Flat Team Layout (parentTeamId)', () => {
    const orgTeams = [
      {
        id: 'org-crewly',
        name: 'Crewly Team',
        description: 'Top-level organization',
        projectIds: [],
        members: [],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
      {
        id: 'child-core',
        name: 'Crewly Core',
        description: 'Core development',
        projectIds: [],
        parentTeamId: 'org-crewly',
        members: [
          { id: 'm1', name: 'Sam', role: 'developer', agentStatus: 'active' as const },
        ],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
      {
        id: 'child-marketing',
        name: 'Crewly Marketing',
        description: 'Marketing team',
        projectIds: [],
        parentTeamId: 'org-crewly',
        members: [
          { id: 'm2', name: 'Mia', role: 'designer', agentStatus: 'inactive' as const },
        ],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
      {
        id: 'standalone-steamfun',
        name: 'SteamFun',
        description: 'Independent team',
        projectIds: [],
        members: [
          { id: 'm3', name: 'Joe', role: 'developer', agentStatus: 'inactive' as const },
        ],
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
    ];

    it('should hide sub-teams and only show top-level teams in grid', async () => {
      mockGetTeams.mockResolvedValue(orgTeams);

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        // Top-level teams should appear
        expect(screen.getByTestId('grid-card-org-crewly')).toBeInTheDocument();
        expect(screen.getByTestId('grid-card-standalone-steamfun')).toBeInTheDocument();
      });

      // Sub-teams (with parentTeamId) should NOT appear in top-level grid
      expect(screen.queryByTestId('grid-card-child-core')).not.toBeInTheDocument();
      expect(screen.queryByTestId('grid-card-child-marketing')).not.toBeInTheDocument();
    });

    it('should not show organization group headers or Independent Teams label', async () => {
      mockGetTeams.mockResolvedValue(orgTeams);

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Crewly Team')).toBeInTheDocument();
      });

      // No org grouping headers or separators
      expect(screen.queryByText('Independent Teams')).not.toBeInTheDocument();
    });

    it('should render parent teams with their members, hiding sub-teams', async () => {
      const orgTeamsWithParentMembers = [
        {
          id: 'org-crewly',
          name: 'Crewly Team',
          description: 'Top-level organization',
          projectIds: [],
          members: [
            { id: 'coord-1', name: 'Coordinator', role: 'coordinator', agentStatus: 'active' as const },
            { id: 'assist-1', name: 'Assistant', role: 'assistant', agentStatus: 'inactive' as const },
            { id: 'audit-1', name: 'Auditor', role: 'auditor', agentStatus: 'inactive' as const },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
        {
          id: 'child-core',
          name: 'Crewly Core',
          description: 'Core development',
          projectIds: [],
          parentTeamId: 'org-crewly',
          members: [
            { id: 'm1', name: 'Sam', role: 'developer', agentStatus: 'active' as const },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
      ];

      mockGetTeams.mockResolvedValue(orgTeamsWithParentMembers);

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        // Parent team rendered as a regular grid card
        expect(screen.getByTestId('grid-card-org-crewly')).toBeInTheDocument();
      });

      // Sub-team should NOT appear in top-level grid
      expect(screen.queryByTestId('grid-card-child-core')).not.toBeInTheDocument();

      // Parent team members visible in the card
      expect(screen.getByText('Coordinator - coordinator')).toBeInTheDocument();
      expect(screen.getByText('Assistant - assistant')).toBeInTheDocument();
      expect(screen.getByText('Auditor - auditor')).toBeInTheDocument();
    });

    it('should render parent team even when it has no members, hiding sub-teams', async () => {
      mockGetTeams.mockResolvedValue(orgTeams);

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        // Parent team with no members should still appear as a card
        expect(screen.getByTestId('grid-card-org-crewly')).toBeInTheDocument();
      });

      // Sub-teams should NOT appear in top-level grid
      expect(screen.queryByTestId('grid-card-child-core')).not.toBeInTheDocument();
      expect(screen.queryByTestId('grid-card-child-marketing')).not.toBeInTheDocument();
    });

    it('should hide sub-teams in list view too', async () => {
      const orgTeamsWithParentMembers = [
        {
          id: 'org-crewly',
          name: 'Crewly Team',
          description: 'Top-level organization',
          projectIds: [],
          members: [
            { id: 'coord-1', name: 'Coordinator', role: 'coordinator', agentStatus: 'active' as const },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
        {
          id: 'child-core',
          name: 'Crewly Core',
          description: 'Core development',
          projectIds: [],
          parentTeamId: 'org-crewly',
          members: [
            { id: 'm1', name: 'Sam', role: 'developer', agentStatus: 'active' as const },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
      ];

      mockGetTeams.mockResolvedValue(orgTeamsWithParentMembers);

      render(
        <TestWrapper>
          <Teams />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('grid-card-org-crewly')).toBeInTheDocument();
      });

      // Switch to list view
      const listViewButton = screen.getByTitle('List view');
      fireEvent.click(listViewButton);

      await waitFor(() => {
        expect(screen.getByTestId('list-item-org-crewly')).toBeInTheDocument();
      });

      // Sub-team should NOT appear in list view either
      expect(screen.queryByTestId('list-item-child-core')).not.toBeInTheDocument();
    });
  });
});
