/**
 * Teams list — the Teams tab of the Teams page
 * (specs/2026-10-02-ui-redesign.md §Teams, simplify level).
 *
 * One job: which crews exist and whether they are running. Compact rows
 * (name, project · members · last activity, status) with Start/Stop visible
 * and view / edit / chat / wiki / pin / delete in "⋯". Status and project
 * filters are one Filter button; a tree view shows parent / sub-teams. Pro
 * cloud users also see other online devices, collapsed.
 *
 * The "New team" action lives in the page header (TeamsHub), which drives
 * the create modal through `createOpen` / `onCreateOpenChange`.
 *
 * @module pages/Teams
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { List, Monitor, RefreshCw, GitBranch, Users, Plus } from 'lucide-react';
import { Button, Card, EmptyState, IconButton, StatusDot, FilterButton, ShowAll, CollapsibleSection, type FilterValue } from '@crewly/ui';
import { useAlert } from '@crewly/ui/Dialog';
import { TeamModal } from '../components/Modals/TeamModal';
import { TeamMemberModal } from '../components/Modals/TeamMemberModal';
import { Team, TeamMember, TeamMemberStatusChangeEvent } from '../types';
import { TeamsTreeView } from '@/components/Teams/TeamsTreeView';
import { TeamRow } from '@/components/Teams/TeamRow';
import { PauseTeamDialog } from '@/components/Teams/PauseTeamDialog';
import { ListSearch } from '@/components/common/ListSearch';
import { apiService } from '@/services/api.service';
import { logSilentError } from '@/utils/error-handling';
import { webSocketService } from '../services/websocket.service';
import { useDeviceHeartbeat } from '../hooks/useDeviceHeartbeat';
import { useCloudConnection } from '../hooks/useCloudConnection';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { usePinnedFavorites } from '../hooks/usePinnedFavorites';
import { useAuth } from '../contexts/AuthContext';
import { assignDefaultAvatars } from '../utils/team.utils';
import { TEAM_QUERY_PARAM } from '../utils/team-chat.utils';
import { LINKS, ROUTES } from '../constants/routes.constants';

/** Rows visible before "Show all" (simplify rule: about five per list). */
export const TEAMS_VISIBLE = 6;

export interface TeamsProps {
  /** Controlled "New team" modal (the header button lives in TeamsHub) */
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
  /** Reports the number of top-level teams (the tab's count pill) */
  onCount?: (count: number) => void;
}

/** A team has at least one active member. */
const isTeamActive = (t: Team) => t.members?.some((m) => m.agentStatus === 'active') ?? false;

export const Teams: React.FC<TeamsProps> = ({ createOpen, onCreateOpenChange, onCount }) => {
  const navigate = useNavigate();
  const { isPinned, togglePin } = usePinnedFavorites();
  const [teams, setTeams] = useState<Team[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<FilterValue>({ status: [], project: [] });
  const statusFilter = (filters.status?.[0] ?? 'all') as 'all' | 'active' | 'inactive';
  const projectFilter = filters.project?.[0] ?? 'all';
  const [ownModalOpen, setOwnModalOpen] = useState(false);
  const isModalOpen = createOpen ?? ownModalOpen;
  const setIsModalOpen = useCallback(
    (open: boolean) => {
      if (onCreateOpenChange) onCreateOpenChange(open);
      else setOwnModalOpen(open);
    },
    [onCreateOpenChange],
  );
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'list' | 'tree'>('list');
  const [projectsForFilter, setProjectsForFilter] = useState<{ id: string; name: string }[]>([]);
  const { showError, AlertComponent } = useAlert();
  const projectMap = Object.fromEntries(projectsForFilter.map(p => [p.id, p.name]));

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
          return !team.members.some(member => member.agentStatus === 'active');
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

  const handleCreateTeam = async (teamData: Omit<Team, 'id' | 'createdAt' | 'updatedAt' | 'sessionName'>) => {
    try {
      const newTeam = await apiService.createTeam(teamData);
      setTeams(prev => [...prev, newTeam]);
      setIsModalOpen(false);
    } catch (error) {
      logSilentError(error, { context: 'handleCreateTeam' });
      showError('Error creating team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  /**
   * Start all agents in a team.
   *
   * @param teamId - The team ID to start
   */
  const handleStartTeam = async (teamId: string) => {
    try {
      await apiService.startTeam(teamId);
    } catch (error) {
      logSilentError(error, { context: 'handleStartTeam' });
      showError('Failed to start team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  /**
   * Stop all agents in a team.
   *
   * @param teamId - The team ID to stop
   */
  const handleStopTeam = async (teamId: string) => {
    try {
      await apiService.stopTeam(teamId);
    } catch (error) {
      logSilentError(error, { context: 'handleStopTeam' });
      showError('Failed to stop team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  // Temporary pause (specs/2026-10-04-team-pause.md)
  const [pauseTarget, setPauseTarget] = useState<Team | null>(null);
  const [pauseBusy, setPauseBusy] = useState(false);

  /**
   * Pause the team chosen in the pause dialog.
   *
   * @param input - Reason and auto-resume time
   */
  const handlePauseTeam = async (input: { reason?: string; until?: string }) => {
    if (!pauseTarget) return;
    setPauseBusy(true);
    try {
      await apiService.pauseTeam(pauseTarget.id, input);
      setPauseTarget(null);
      await fetchTeams();
    } catch (error) {
      showError('Failed to pause team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setPauseBusy(false);
    }
  };

  /**
   * Resume a paused team.
   *
   * @param teamId - Team ID
   */
  const handleResumeTeam = async (teamId: string) => {
    try {
      await apiService.resumeTeam(teamId);
      await fetchTeams();
    } catch (error) {
      showError('Failed to resume team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const handleDeleteTeam = async (teamId: string) => {
    try {
      await apiService.deleteTeam(teamId);
      setTeams(prev => prev.filter(t => t.id !== teamId));
    } catch (error) {
      showError('Failed to delete team: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const topLevel = useMemo(() => teams.filter((t) => !t.parentTeamId), [teams]);
  useEffect(() => {
    if (!loading) onCount?.(topLevel.length);
  }, [loading, topLevel.length, onCount]);

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
        <LoadingSpinner size="xl" text="Loading teams..." />
      </div>
    );
  }

  const filtering = !!searchQuery || statusFilter !== 'all' || projectFilter !== 'all';

  return (
    <div data-testid="teams-list-page">
      {/* One Filter button + search + list/tree */}
      <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="teams-toolbar">
        <FilterButton
          value={filters}
          onChange={setFilters}
          groups={[
            {
              id: 'status',
              label: 'Status',
              single: true,
              options: [
                { value: 'active', label: 'Active', count: topLevel.filter(isTeamActive).length },
                { value: 'inactive', label: 'Idle', count: topLevel.filter((t) => !isTeamActive(t)).length },
              ],
            },
            ...(projectsForFilter.length > 0
              ? [{ id: 'project', label: 'Project', single: true, options: projectsForFilter.map((p) => ({ value: p.id, label: p.name })) }]
              : []),
          ]}
        />
        <ListSearch label="Search teams" value={searchQuery} onChange={setSearchQuery} />
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="View">
          <IconButton
            icon={List}
            size="xs"
            aria-label="List view"
            title="List view"
            aria-pressed={view === 'list'}
            className={view === 'list' ? 'text-primary-text bg-primary-soft' : 'text-text-2'}
            onClick={() => setView('list')}
          />
          <IconButton
            icon={GitBranch}
            size="xs"
            aria-label="Tree view"
            title="Tree view (parent and sub-teams)"
            aria-pressed={view === 'tree'}
            className={view === 'tree' ? 'text-primary-text bg-primary-soft' : 'text-text-2'}
            onClick={() => setView('tree')}
          />
        </div>
      </div>

      {view === 'tree' ? (
        teams.length > 0 && (
          <TeamsTreeView teams={teams} projectMap={projectMap} onTeamClick={(teamId) => navigate(LINKS.team(teamId))} />
        )
      ) : filteredTeams.length > 0 ? (
        <div className="rounded-2xl border border-border-soft" data-testid="teams-list">
          <ShowAll limit={TEAMS_VISIBLE} data-testid="teams-show-all">
            {filteredTeams.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                projectName={team.projectIds?.length > 0 ? projectMap[team.projectIds[0]] : undefined}
                subTeamCount={subTeamCountMap.get(team.id)}
                onOpen={(teamId) => navigate(LINKS.team(teamId))}
                onEdit={(teamId) => navigate(`${LINKS.team(teamId)}?edit=true`)}
                onStart={handleStartTeam}
                onStop={handleStopTeam}
                onOpenChat={(teamId) => navigate(`${ROUTES.chat}?${TEAM_QUERY_PARAM}=${teamId}`)}
                onOpenWiki={(teamId) => navigate(`${ROUTES.wiki}?${TEAM_QUERY_PARAM}=${teamId}`)}
                onDelete={handleDeleteTeam}
                isPinned={isPinned(team.id)}
                onTogglePin={() => togglePin({ id: team.id, name: team.name, type: 'team' })}
                onPause={() => setPauseTarget(team)}
                onResume={handleResumeTeam}
              />
            ))}
          </ShowAll>
        </div>
      ) : (
        <EmptyState
          icon={Users}
          title="No teams found"
          description={filtering ? 'Try adjusting your search or filters' : 'Create your first team to get started'}
          action={!filtering ? (
            <Button variant="primary" icon={Plus} onClick={() => setIsModalOpen(true)}>
              Create Team
            </Button>
          ) : undefined}
          className="py-16"
        />
      )}

      {/* Other online devices (Pro + Cloud only), collapsed */}
      {showRemoteDevices && (
        <CollapsibleSection
          title={`Online devices (${remoteDevices.length})`}
          summary="Other machines on your account and their teams"
          className="mt-8"
          data-testid="online-devices"
        >
          <div className="mb-3 flex justify-end">
            <IconButton icon={RefreshCw} size="xs" onClick={refreshDevices} title="Refresh devices" aria-label="Refresh devices" />
          </div>
          {devicesLoading ? (
            <LoadingSpinner size="sm" text="Discovering devices..." />
          ) : remoteDevices.length === 0 ? (
            <EmptyState
              compact
              icon={Monitor}
              title="No other devices online"
              description="Other Pro users will appear here when they are online"
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {remoteDevices.map((device) => (
                <Card key={device.deviceId} padding="md">
                  <div className="mb-2 flex items-center gap-2">
                    <StatusDot status="online" size="sm" pulse />
                    <span className="truncate text-sm font-semibold text-text">{device.deviceName}</span>
                  </div>
                  <p className="mb-3 truncate text-xs text-text-2">{device.email}</p>
                  {device.teams.length > 0 && (
                    <ul className="space-y-1 text-[13px]">
                      {device.teams.map((t) => (
                        <li key={t.id} className="flex items-center justify-between gap-2">
                          <span className="truncate text-text">{t.name}</span>
                          <span className="shrink-0 text-text-2">
                            {t.memberCount} member{t.memberCount !== 1 ? 's' : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              ))}
            </div>
          )}
        </CollapsibleSection>
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
      <PauseTeamDialog
        isOpen={!!pauseTarget}
        teamName={pauseTarget?.name ?? ''}
        issueRepo={pauseTarget?.issueRepo}
        busy={pauseBusy}
        onCancel={() => setPauseTarget(null)}
        onConfirm={handlePauseTeam}
      />
      <AlertComponent />
    </div>
  );
};
