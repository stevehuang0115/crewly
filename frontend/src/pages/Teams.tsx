import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Grid, List, Monitor, RefreshCw } from 'lucide-react';
import { useAlert } from '../components/UI/Dialog';
import TeamsGridCard from '@/components/Teams/TeamsGridCard';
import { TeamModal } from '../components/Modals/TeamModal';
import { TeamMemberModal } from '../components/Modals/TeamMemberModal';
import { Team, TeamMember, TeamMemberStatusChangeEvent } from '../types';
import TeamListItem from '@/components/Teams/TeamListItem';
import { apiService } from '@/services/api.service';
import { logSilentError } from '@/utils/error-handling';
import { webSocketService } from '../services/websocket.service';
import { useDeviceHeartbeat } from '../hooks/useDeviceHeartbeat';
import { useCloudConnection } from '../hooks/useCloudConnection';
import { useAuth } from '../contexts/AuthContext';
import { assignDefaultAvatars } from '../utils/team.utils';

export const Teams: React.FC = () => {
  const navigate = useNavigate();
  const [teams, setTeams] = useState<Team[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [projectsForFilter, setProjectsForFilter] = useState<{ id: string; name: string }[]>([]);
  const { showError, AlertComponent } = useAlert();
  const projectMap = Object.fromEntries(projectsForFilter.map(p => [p.id, p.name]));
  const [projectFilter, setProjectFilter] = useState<string>('all');

  // Cloud connection and device heartbeat for dual-machine feature
  const { isConnected: cloudConnected, tier } = useCloudConnection();
  const { getAccessToken } = useAuth();
  const accessToken = cloudConnected && tier === 'pro' ? getAccessToken() : null;

  const heartbeatTeams = useMemo(() =>
    teams.map(t => ({ id: t.id, name: t.name, memberCount: t.members.length })),
    [teams],
  );

  const showRemoteDevices = cloudConnected && tier === 'pro';
  const { devices: remoteDevices, isLoading: devicesLoading, refresh: refreshDevices } = useDeviceHeartbeat(
    accessToken,
    showRemoteDevices,
    heartbeatTeams,
    typeof window !== 'undefined' ? (window.location.hostname || 'My Device') : 'My Device',
  );

  const filteredTeams = useMemo(() => {
    let filtered = teams;

    if (searchQuery) {
      filtered = filtered.filter(team =>
        team.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (team.description && team.description.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (team.projectIds?.length > 0 && team.projectIds.some(pid => pid.toLowerCase().includes(searchQuery.toLowerCase()))) ||
        team.members.some(member =>
          member.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          member.role.toLowerCase().includes(searchQuery.toLowerCase())
        )
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(team => {
        if (statusFilter === 'active') {
          return team.members.some(member => member.agentStatus === 'active');
        } else if (statusFilter === 'inactive') {
          return team.members.every(member => member.agentStatus === 'inactive');
        }
        return true;
      });
    }

    if (projectFilter !== 'all') {
      filtered = filtered.filter(team => team.projectIds?.includes(projectFilter));
    }

    // Hide sub-teams from top-level grid — they appear under their parent team
    filtered = filtered.filter(team => !team.parentTeamId);

    return filtered;
  }, [teams, searchQuery, statusFilter, projectFilter]);

  /**
   * Compute sub-team counts for parent teams.
   * All teams are shown in a flat grid (no special treatment for orchestrator).
   */
  const subTeamCountMap = useMemo(() => {
    const childCountMap = new Map<string, number>();
    for (const t of teams) {
      if (t.parentTeamId) {
        childCountMap.set(t.parentTeamId, (childCountMap.get(t.parentTeamId) || 0) + 1);
      }
    }
    return childCountMap;
  }, [teams]);

  /**
   * Handle team member status change event from WebSocket.
   * Updates the team member's agentStatus in the teams list.
   */
  const handleTeamMemberStatusChange = useCallback((data: TeamMemberStatusChangeEvent) => {
    setTeams(prevTeams =>
      prevTeams.map(team => {
        if (team.id === data.teamId) {
          return {
            ...team,
            members: team.members.map(member => {
              if (member.id === data.memberId || member.sessionName === data.sessionName) {
                return { ...member, agentStatus: data.agentStatus };
              }
              return member;
            }),
          };
        }
        return team;
      })
    );
  }, []);

  useEffect(() => {
    fetchTeams();
    loadProjectsForFilter();
  }, []);

  /**
   * Subscribe to WebSocket events for real-time status updates.
   */
  useEffect(() => {
    webSocketService.on('team_member_status_changed', handleTeamMemberStatusChange);

    return () => {
      webSocketService.off('team_member_status_changed', handleTeamMemberStatusChange);
    };
  }, [handleTeamMemberStatusChange]);

  const loadProjectsForFilter = async () => {
    try {
      const projects = await apiService.getProjects();
      setProjectsForFilter(projects.map(p => ({ id: p.id, name: p.name })));
    } catch (e) {
      logSilentError(e, { context: 'Loading projects for filter' });
    }
  };

  const fetchTeams = async () => {
    try {
      // Use cached apiService.getTeams() to reduce redundant API calls
      const teamsData = await apiService.getTeams();

      // Migrate teams without avatars for backward compatibility
      const migratedTeams = teamsData.map(team => ({
        ...team,
        members: assignDefaultAvatars(team.members),
      }));

      setTeams(migratedTeams);
    } catch (error) {
      logSilentError(error, { context: 'fetchTeams' });
      setTeams([]); // Set empty array on error
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTeam = async (teamData: any) => {
    try {
      const response = await fetch('/api/teams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(teamData),
      });

      if (response.ok) {
        const result = await response.json();
        const newTeam = result.success ? result.data : result;
        if (newTeam) {
          setTeams(prev => [...prev, newTeam]);
          setIsModalOpen(false);
        }
      } else {
        const errorResult = await response.json();
        showError('Error creating team: ' + (errorResult.error || 'Unknown error'));
      }
    } catch (error) {
      logSilentError(error, { context: 'handleCreateTeam' });
      showError('Error creating team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const handleTeamClick = (team: Team) => {
    navigate(`/teams/${team.id}`);
  };

  const handleMemberClick = (member: TeamMember, teamId: string) => {
    setSelectedMember(member);
    setSelectedTeamId(teamId);
  };

  const closeMemberModal = () => {
    setSelectedMember(null);
    setSelectedTeamId('');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-primary/20 border-t-primary rounded-full animate-spin mb-4 mx-auto"></div>
          <p className="text-text-secondary-dark">Loading teams...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-8">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Teams</h2>
          <p className="text-sm text-text-secondary-dark mt-1">Manage and organize your development teams</p>
        </div>

        <button
          className="bg-primary text-white px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors flex items-center gap-2"
          onClick={() => setIsModalOpen(true)}
        >
          <Plus className="w-5 h-5" />
          New Team
        </button>
      </div>

      {/* Search */}
      <div className="flex flex-col md:flex-row items-center gap-4 mb-3">
        <div className="relative flex-grow w-full md:w-auto">
          <input
            type="text"
            placeholder="Search teams..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-surface-dark border border-border-dark rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-colors"
          />
        </div>
      </div>

      {/* Filter + view controls */}
      <div className="flex flex-col md:flex-row items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-text-secondary-dark">Status:</span>
          <button className={`chip ${statusFilter === 'all' ? 'chip--active' : ''}`} onClick={() => setStatusFilter('all')}>All</button>
          <button className={`chip ${statusFilter === 'active' ? 'chip--active' : ''}`} onClick={() => setStatusFilter('active')}>Active</button>
          <button className={`chip ${statusFilter === 'inactive' ? 'chip--active' : ''}`} onClick={() => setStatusFilter('inactive')}>Inactive</button>
          <span className="ml-2 text-sm text-text-secondary-dark">Project:</span>
          <select
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
            className="bg-surface-dark border border-border-dark rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary"
          >
            <option value="all">All</option>
            {projectsForFilter.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setView('grid')}
            className={`inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border-dark ${view === 'grid' ? 'bg-primary/10 text-primary' : 'text-text-secondary-dark hover:text-text-primary-dark hover:border-primary/50'}`}
            title="Grid view"
          >
            <Grid className="w-4 h-4" />
          </button>
          <button
            onClick={() => setView('list')}
            className={`inline-flex items-center justify-center w-9 h-9 rounded-lg border border-border-dark ${view === 'list' ? 'bg-primary/10 text-primary' : 'text-text-secondary-dark hover:text-text-primary-dark hover:border-primary/50'}`}
            title="List view"
          >
            <List className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Remote Devices (Pro + Cloud only) */}
      {showRemoteDevices && (
        <div className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Monitor className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-text-secondary-dark uppercase tracking-wide">
                Online Devices ({remoteDevices.length})
              </h3>
            </div>
            <button
              onClick={refreshDevices}
              className="p-1.5 text-text-secondary-dark hover:text-text-primary-dark rounded-lg hover:bg-surface-dark transition-colors"
              title="Refresh devices"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>

          {devicesLoading ? (
            <div className="bg-surface-dark border border-border-dark rounded-lg p-6 text-center">
              <div className="w-5 h-5 border-2 border-primary/20 border-t-primary rounded-full animate-spin mx-auto mb-2" />
              <p className="text-xs text-text-secondary-dark">Discovering devices...</p>
            </div>
          ) : remoteDevices.length === 0 ? (
            <div className="bg-surface-dark border border-border-dark rounded-lg p-6 text-center">
              <p className="text-sm text-text-secondary-dark">No other devices online</p>
              <p className="text-xs text-text-secondary-dark/70 mt-1">
                Other Pro users will appear here when they are online
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {remoteDevices.map(device => (
                <div
                  key={device.deviceId}
                  className="bg-surface-dark border border-border-dark rounded-lg p-4"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                    <span className="text-sm font-medium text-text-primary-dark truncate">
                      {device.deviceName}
                    </span>
                  </div>
                  <p className="text-xs text-text-secondary-dark mb-3 font-mono truncate">
                    {device.email}
                  </p>
                  {device.teams.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-xs text-text-secondary-dark/70 uppercase tracking-wide">
                        Teams ({device.teams.length})
                      </p>
                      {device.teams.map(t => (
                        <div
                          key={t.id}
                          className="flex items-center justify-between text-xs bg-background-dark rounded px-2 py-1.5"
                        >
                          <span className="text-text-primary-dark truncate">{t.name}</span>
                          <span className="text-text-secondary-dark ml-2 shrink-0">
                            {t.memberCount} member{t.memberCount !== 1 ? 's' : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* All teams in a flat grid */}
      {filteredTeams.length > 0 && (
        <>
          {view === 'grid' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredTeams.map(team => (
                <TeamsGridCard
                  key={team.id}
                  team={team}
                  projectName={team.projectIds?.length > 0 ? projectMap[team.projectIds[0]] : undefined}
                  subTeamCount={subTeamCountMap.get(team.id)}
                  onClick={() => handleTeamClick(team)}
                  onViewTeam={(teamId) => navigate(`/teams/${teamId}`)}
                  onEditTeam={(teamId) => navigate(`/teams/${teamId}?edit=true`)}
                />
              ))}
              <div
                onClick={() => setIsModalOpen(true)}
                className="flex items-center justify-center p-5 rounded-xl border-2 border-dashed border-border-dark hover:border-primary transition-colors cursor-pointer text-text-secondary-dark hover:text-primary"
              >
                <Plus className="mr-2 w-4 h-4" />
                <span>Create New Team</span>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {filteredTeams.map(team => (
                <TeamListItem
                  key={team.id}
                  team={team}
                  projectName={team.projectIds?.length > 0 ? projectMap[team.projectIds[0]] : undefined}
                  onClick={() => handleTeamClick(team)}
                  onViewTeam={(teamId) => navigate(`/teams/${teamId}`)}
                  onEditTeam={(teamId) => navigate(`/teams/${teamId}?edit=true`)}
                  onDeleteTeam={async (teamId) => {
                    if (window.confirm('Are you sure you want to delete this team?')) {
                      try {
                        await apiService.deleteTeam(teamId);
                        setTeams(prev => prev.filter(t => t.id !== teamId));
                      } catch (error) {
                        showError('Failed to delete team: ' + (error instanceof Error ? error.message : 'Unknown error'));
                      }
                    }
                  }}
                />
              ))}
              <div
                onClick={() => setIsModalOpen(true)}
                className="flex items-center justify-center p-4 rounded-lg border-2 border-dashed border-border-dark hover:border-primary transition-colors cursor-pointer text-text-secondary-dark hover:text-primary"
              >
                <Plus className="mr-2 w-4 h-4" />
                <span>Create New Team</span>
              </div>
            </div>
          )}
        </>
      )}

      {filteredTeams.length === 0 && !loading && (
        <div className="text-center py-16">
          <h3 className="text-lg font-semibold mb-2">No teams found</h3>
          <p className="text-sm text-text-secondary-dark mb-6">
            {searchQuery || statusFilter !== 'all'
              ? 'Try adjusting your search or filters'
              : 'Create your first team to get started'}
          </p>
          {!searchQuery && statusFilter === 'all' && (
            <button
              className="bg-primary text-white px-6 py-3 rounded-lg hover:bg-primary/90 transition-colors inline-flex items-center gap-2"
              onClick={() => setIsModalOpen(true)}
            >
              <Plus className="w-5 h-5" />
              Create Team
            </button>
          )}
        </div>
      )}

      <TeamModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleCreateTeam}
      />

      {selectedMember && selectedTeamId && (
        <TeamMemberModal
          member={selectedMember}
          teamId={selectedTeamId}
          onClose={closeMemberModal}
        />
      )}
      <AlertComponent />
    </div>
  );
};
