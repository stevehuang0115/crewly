import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TeamDetail } from './TeamDetail';

// Mock the useNavigate and useParams hooks
const mockNavigate = vi.fn();
let mockTeamId = 'team-1';
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ id: mockTeamId })
  };
});

// Mock the TerminalContext
const mockOpenTerminalWithSession = vi.fn();
vi.mock('../contexts/TerminalContext', () => ({
  useTerminal: () => ({
    openTerminalWithSession: mockOpenTerminalWithSession
  })
}));

// Mock the websocket service
vi.mock('../services/websocket.service', () => ({
  webSocketService: {
    on: vi.fn(),
    off: vi.fn(),
  }
}));

// Mock useAlert and useConfirm hooks
const mockShowSuccess = vi.fn();
const mockShowError = vi.fn();
const mockShowWarning = vi.fn();
const mockShowConfirm = vi.fn();
vi.mock('@crewly/ui/Dialog', () => ({
  useAlert: () => ({
    showSuccess: mockShowSuccess,
    showError: mockShowError,
    showWarning: mockShowWarning,
    AlertComponent: () => null,
  }),
  useConfirm: () => ({
    showConfirm: mockShowConfirm,
    ConfirmComponent: () => null,
  }),
}));

// Mock TeamHeader to render testable controls
vi.mock('../components/TeamDetail', () => ({
  TeamHeader: ({ team, teamStatus, onStartTeam, onStopTeam, onViewTerminal, onDeleteTeam, onEditTeam, isStoppingTeam, isStartingTeam }: any) => {
    const isOrchestratorTeam = team?.id === 'orchestrator' || team?.name === 'Orchestrator Team';
    return (
      <div data-testid="team-header">
        <h1 className="page-title">{team.name}</h1>
        <span data-testid="team-status">{teamStatus === 'active' ? 'ACTIVE' : 'IDLE'}</span>
        {teamStatus === 'idle' && !isStartingTeam ? (
          <button onClick={onStartTeam}>
            {isOrchestratorTeam ? 'Start Orchestrator' : 'Start Team'}
          </button>
        ) : isStartingTeam ? (
          <button disabled>Starting...</button>
        ) : (
          <button onClick={onStopTeam}>
            {isStoppingTeam ? 'Stopping...' : isOrchestratorTeam ? 'Stop Orchestrator' : 'Stop Team'}
          </button>
        )}
        {isOrchestratorTeam && teamStatus === 'active' && (
          <button onClick={onViewTerminal}>View Terminal</button>
        )}
        {!isOrchestratorTeam && (
          <>
            <button onClick={onEditTeam}>Edit Team</button>
            <button onClick={onDeleteTeam}>Delete Team</button>
          </>
        )}
      </div>
    );
  },
  TeamOverview: ({ team, teamId, projectName, onUpdateMember, onDeleteMember, onStartMember, onStopMember, onViewTerminal, onViewAgent }: any) => {
    const members = team?.members || [];
    const activeCount = members.filter((m: any) => m.agentStatus === 'active' || m.sessionName).length;
    return (
      <div data-testid="team-overview">
        <span>{activeCount} / {members.length}</span>
        {projectName && <span>{projectName}</span>}
        {members.map((member: any) => (
          <div key={member.id} data-testid={`member-card-${member.id}`}>
            <span>{member.name}</span>
            <span>{member.role}</span>
            <button onClick={() => onUpdateMember(member.id, { name: 'Updated Name' })}>Update</button>
            <button onClick={() => onDeleteMember(member.id)}>Delete</button>
            <button onClick={() => onStartMember(member.id)}>Start</button>
            <button onClick={() => onStopMember(member.id)}>Stop</button>
          </div>
        ))}
        {members.length === 0 && <p>No team members yet. Add members to get started.</p>}
      </div>
    );
  },
  AgentDetailModal: () => null,
}));

// Mock HierarchyDashboard
vi.mock('../components/Hierarchy', () => ({
  HierarchyDashboard: () => <div data-testid="hierarchy-dashboard" />,
}));

vi.mock('../components/StartTeamModal', () => ({
  StartTeamModal: ({ isOpen, onClose, onStartTeam, team, loading }: any) => (
    isOpen ? (
      <div data-testid="start-team-modal">
        <h2>Start Team: {team?.name}</h2>
        <button
          onClick={() => onStartTeam('project-1', true)}
          disabled={loading}
        >
          {loading ? 'Starting...' : 'Confirm Start'}
        </button>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
  )
}));

vi.mock('../components/Modals/TeamModal', () => ({
  TeamModal: ({ isOpen, onClose, onSubmit, team }: any) => (
    isOpen ? (
      <div data-testid="edit-team-modal">
        <h2>Edit Team: {team?.name}</h2>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
  )
}));

vi.mock('../utils/api', () => ({
  safeParseJSON: vi.fn().mockImplementation(async (response) => {
    return await response.json();
  })
}));

// Mock apiService for sub-teams fetching
vi.mock('../services/api.service', () => ({
  apiService: {
    getTeams: vi.fn(),
  },
}));

import { apiService } from '../services/api.service';
const mockApiGetTeams = apiService.getTeams as ReturnType<typeof vi.fn>;

// Mock fetch globally
global.fetch = vi.fn();

// Test data
const mockTeam = {
  id: 'team-1',
  name: 'Development Team',
  description: 'Frontend development team',
  projectIds: ['project-1'],
  status: 'active',
  members: [
    {
      id: 'member-1',
      name: 'John Doe',
      role: 'Developer',
      sessionName: 'john_doe',
      agentStatus: 'active'
    },
    {
      id: 'member-2',
      name: 'Jane Smith',
      role: 'Designer',
      sessionName: null,
      agentStatus: 'inactive'
    }
  ],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-02'
};

const mockOrchestratorTeam = {
  id: 'orchestrator',
  name: 'Orchestrator Team',
  description: 'System orchestrator team',
  projectIds: [],
  status: 'active',
  members: [
    {
      id: 'orc-1',
      name: 'Orchestrator',
      role: 'Orchestrator',
      sessionName: 'crewly-orc',
      agentStatus: 'active'
    }
  ],
  createdAt: '2024-01-01',
  updatedAt: '2024-01-02'
};

const mockProjects = [
  {
    id: 'project-1',
    name: 'Test Project',
    path: '/path/to/project',
    status: 'active'
  }
];

const TestWrapper: React.FC<{ children: React.ReactNode; teamId?: string }> = ({
  children,
  teamId = 'team-1'
}) => {
  return (
    <MemoryRouter initialEntries={[`/teams/${teamId}`]}>
      {children}
    </MemoryRouter>
  );
};

describe('TeamDetail Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTeamId = 'team-1';

    // Default: apiService.getTeams returns empty (no sub-teams)
    mockApiGetTeams.mockResolvedValue([]);

    // Setup default fetch mocks
    (global.fetch as any).mockImplementation((url: string) => {
      if (url.includes('/api/teams/team-1')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: mockTeam
          })
        });
      }
      if (url.includes('/api/projects')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: mockProjects
          })
        });
      }
      if (url.includes('/api/terminal/sessions')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            success: true,
            data: []
          })
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Loading State', () => {
    it('should render loading state initially', () => {
      // Make fetch hang to test loading state
      (global.fetch as any).mockImplementation(() => new Promise(() => {}));

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      expect(screen.getByText('Loading team details...')).toBeInTheDocument();
    });
  });

  describe('Error State', () => {
    it('should render error state when team is not found', async () => {
      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: false,
            status: 404
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Team not found')).toBeInTheDocument();
        expect(screen.getByText('The requested team could not be found.')).toBeInTheDocument();
      });
    });
  });

  describe('Successful Render', () => {
    it('should render team details correctly', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        // Team name appears in breadcrumb and TeamHeader mock
        expect(screen.getAllByText('Development Team').length).toBeGreaterThanOrEqual(1);
      });

      // Team header renders status from mock; TeamOverview renders active count
      expect(screen.getByTestId('team-header')).toBeInTheDocument();
      expect(screen.getByTestId('team-overview')).toBeInTheDocument();
      expect(screen.getByText('1 / 2')).toBeInTheDocument(); // Active members
      expect(screen.getByText('Test Project')).toBeInTheDocument();
    });

    it('should render team members correctly', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('member-card-member-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('member-card-member-2')).toBeInTheDocument();
      expect(screen.getByText('John Doe')).toBeInTheDocument();
      expect(screen.getByText('Jane Smith')).toBeInTheDocument();
      expect(screen.getByText('Developer')).toBeInTheDocument();
      expect(screen.getByText('Designer')).toBeInTheDocument();
    });

    it('should show correct team status based on active members', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('ACTIVE')).toBeInTheDocument();
      });
    });

    it('should show project name when team is assigned to project', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Test Project')).toBeInTheDocument();
      });
    });
  });

  describe('Team Controls', () => {
    it('should show Start Team button when team is idle', async () => {
      // Mock team with no active members
      const idleTeam = {
        ...mockTeam,
        members: [
          { ...mockTeam.members[0], sessionName: null },
          { ...mockTeam.members[1], sessionName: null }
        ]
      };

      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: idleTeam
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Start Team')).toBeInTheDocument();
      });
    });

    it('should show Stop Team button when team is active', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Stop Team')).toBeInTheDocument();
      });
    });

    it('should handle start team button click', async () => {
      // Mock idle team first
      const idleTeam = {
        ...mockTeam,
        members: [
          { ...mockTeam.members[0], sessionName: null },
          { ...mockTeam.members[1], sessionName: null }
        ]
      };

      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: idleTeam
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Start Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Start Team'));

      await waitFor(() => {
        expect(screen.getByTestId('start-team-modal')).toBeInTheDocument();
      });
    });

    it('should handle stop team button click', async () => {
      (global.fetch as any).mockImplementation((url: string, options?: any) => {
        if (url.includes('/api/teams/team-1/stop') && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true })
          });
        }
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: mockTeam
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Stop Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Stop Team'));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/teams/team-1/stop', {
          method: 'POST'
        });
      });
    });
  });

  describe('Member Management', () => {
    it('should render member cards for team members', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('member-card-member-1')).toBeInTheDocument();
      });

      expect(screen.getByTestId('member-card-member-2')).toBeInTheDocument();
    });

    it('should handle member actions', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('member-card-member-1')).toBeInTheDocument();
      });

      // Test member update
      fireEvent.click(screen.getAllByText('Update')[0]);

      // Test member start
      fireEvent.click(screen.getAllByText('Start')[0]);

      // Test member stop
      fireEvent.click(screen.getAllByText('Stop')[0]);

      // Test member delete
      fireEvent.click(screen.getAllByText('Delete')[0]);
    });
  });

  describe('Orchestrator Team Special Handling', () => {
    beforeEach(() => {
      mockTeamId = 'orchestrator';

      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/teams/orchestrator')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: mockOrchestratorTeam
            })
          });
        }
        if (url.includes('/api/terminal/sessions')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: [{ sessionName: 'crewly-orc' }]
            })
          });
        }
        return Promise.resolve({ ok: false });
      });
    });

    it('should show View Terminal button for orchestrator team', async () => {
      render(
        <TestWrapper teamId="orchestrator">
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('View Terminal')).toBeInTheDocument();
      });
    });

    it('should hide Delete Team button for orchestrator team', async () => {
      render(
        <TestWrapper teamId="orchestrator">
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('Orchestrator Team').length).toBeGreaterThanOrEqual(1);
      });

      expect(screen.queryByText('Delete Team')).not.toBeInTheDocument();
    });

    it('should handle View Terminal click for orchestrator team', async () => {
      render(
        <TestWrapper teamId="orchestrator">
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('View Terminal')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('View Terminal'));

      expect(mockOpenTerminalWithSession).toHaveBeenCalledWith('crewly-orc');
    });
  });

  describe('Team Deletion', () => {
    it('should handle delete team button click', async () => {
      (global.fetch as any).mockImplementation((url: string, options?: any) => {
        if (url.includes('/api/teams/team-1/stop') && options?.method === 'POST') {
          return Promise.resolve({ ok: true });
        }
        if (url.includes('/api/teams/team-1') && options?.method === 'DELETE') {
          return Promise.resolve({ ok: true });
        }
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: mockTeam
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Delete Team')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Delete Team'));

      // The component now uses useConfirm instead of window.confirm
      await waitFor(() => {
        expect(mockShowConfirm).toHaveBeenCalled();
      });

      // Verify the confirm callback was passed correctly
      const confirmCall = mockShowConfirm.mock.calls[0];
      expect(confirmCall[0]).toContain('Are you sure you want to delete team');
    });

    it('should prevent deletion of orchestrator team', async () => {
      mockTeamId = 'orchestrator';

      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/teams/orchestrator')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: mockOrchestratorTeam
            })
          });
        }
        if (url.includes('/api/terminal/sessions')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: [{ sessionName: 'crewly-orc' }]
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper teamId="orchestrator">
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('Orchestrator Team').length).toBeGreaterThanOrEqual(1);
      });

      // Verify delete button is not shown for orchestrator team
      expect(screen.queryByText('Delete Team')).not.toBeInTheDocument();
    });
  });

  describe('Start Team Modal', () => {
    it('should handle start team modal submission', async () => {
      (global.fetch as any).mockImplementation((url: string, options?: any) => {
        if (url.includes('/api/teams/team-1/start') && options?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              message: 'Team started successfully'
            })
          });
        }
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: { ...mockTeam, members: mockTeam.members.map(m => ({ ...m, sessionName: null })) }
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Start Team')).toBeInTheDocument();
      });

      // Click Start Team to open the modal
      fireEvent.click(screen.getByText('Start Team'));

      await waitFor(() => {
        expect(screen.getByTestId('start-team-modal')).toBeInTheDocument();
      });

      // Click the confirm button inside the modal (renamed to "Confirm Start" to avoid ambiguity)
      fireEvent.click(screen.getByText('Confirm Start'));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/teams/team-1/start', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            projectId: 'project-1',
          })
        });
      });
    });
  });

  describe('Sub-Teams Section', () => {
    it('should display sub-teams when parent team has children', async () => {
      const childTeams = [
        {
          id: 'child-1',
          name: 'Core Team',
          description: 'Core development',
          projectIds: [],
          parentTeamId: 'team-1',
          members: [
            { id: 'c1', name: 'Alice', role: 'developer', agentStatus: 'active' },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
        {
          id: 'child-2',
          name: 'Marketing Team',
          description: 'Marketing',
          projectIds: [],
          parentTeamId: 'team-1',
          members: [
            { id: 'c2', name: 'Bob', role: 'marketer', agentStatus: 'inactive' },
          ],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
        {
          id: 'other-team',
          name: 'Other Team',
          description: 'Unrelated',
          projectIds: [],
          parentTeamId: 'team-999',
          members: [],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
      ];

      mockApiGetTeams.mockResolvedValue(childTeams);

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('Sub-Teams (2)')).toBeInTheDocument();
      });

      expect(screen.getByTestId('sub-team-child-1')).toBeInTheDocument();
      expect(screen.getByTestId('sub-team-child-2')).toBeInTheDocument();
      expect(screen.getByText('Core Team')).toBeInTheDocument();
      expect(screen.getByText('Marketing Team')).toBeInTheDocument();
      // Should not show unrelated team
      expect(screen.queryByTestId('sub-team-other-team')).not.toBeInTheDocument();
    });

    it('should not show sub-teams section when no children exist', async () => {

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getAllByText('Development Team').length).toBeGreaterThan(0);
      });

      expect(screen.queryByText(/Sub-Teams/)).not.toBeInTheDocument();
    });

    it('should navigate to sub-team on click', async () => {
      mockApiGetTeams.mockResolvedValue([
        {
          id: 'child-1',
          name: 'Core Team',
          description: 'Core development',
          projectIds: [],
          parentTeamId: 'team-1',
          members: [{ id: 'c1', name: 'Alice', role: 'developer', agentStatus: 'active' }],
          createdAt: '2024-01-01',
          updatedAt: '2024-01-02',
        },
      ]);

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByTestId('sub-team-child-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('sub-team-child-1'));

      expect(mockNavigate).toHaveBeenCalledWith('/teams/child-1');
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no members exist', async () => {
      const emptyTeam = { ...mockTeam, members: [] };

      (global.fetch as any).mockImplementation((url: string) => {
        if (url.includes('/api/teams/team-1')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              success: true,
              data: emptyTeam
            })
          });
        }
        return Promise.resolve({ ok: false });
      });

      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        expect(screen.getByText('No team members yet. Add members to get started.')).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        const headings = screen.getAllByText('Development Team');
        // Find the h1 element among the matches
        const h1 = headings.find(el => el.tagName === 'H1');
        expect(h1).toBeDefined();
        expect(h1).toHaveClass('page-title');
      });
    });

    it('should support keyboard navigation', async () => {
      render(
        <TestWrapper>
          <TeamDetail />
        </TestWrapper>
      );

      await waitFor(() => {
        const stopButton = screen.getByText('Stop Team');
        expect(stopButton).toBeInTheDocument();
      });

      const stopButton = screen.getByText('Stop Team');
      stopButton.focus();
      expect(document.activeElement).toBe(stopButton);
    });
  });
});
