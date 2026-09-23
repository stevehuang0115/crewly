import React, { useState, useEffect } from 'react';
import { Users, Check } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { Card } from '@crewly/ui/Card';
import { EmptyState } from '@crewly/ui/EmptyState';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Popup } from '@crewly/ui/Popup';
import { Team, Project } from '@/types';
import { apiService } from '@/services/api.service';

interface TeamAssignmentModalProps {
  project: Project;
  onClose: () => void;
  onAssignmentComplete: () => void;
}

/**
 * Dialog for choosing which teams are assigned to a project.
 *
 * @param props - The project, close handler and completion callback
 * @returns The assignment dialog
 */
export const TeamAssignmentModal: React.FC<TeamAssignmentModalProps> = ({
  project,
  onClose,
  onAssignmentComplete,
}) => {
  const [allTeams, setAllTeams] = useState<Team[]>([]);
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadTeams();
  }, []);

  const loadTeams = async () => {
    try {
      setLoading(true);
      const teams = await apiService.getTeams();
      setAllTeams(teams);

      // Pre-select teams that are already assigned to this project
      const assignedTeamIds = new Set(
        teams
          .filter(team => team.projectIds?.includes(project.id))
          .map(team => team.id)
      );
      setSelectedTeams(assignedTeamIds);
    } catch (err) {
      setError('Failed to load teams');
      console.error('Error loading teams:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleTeamToggle = (teamId: string) => {
    const newSelected = new Set(selectedTeams);
    if (newSelected.has(teamId)) {
      newSelected.delete(teamId);
    } else {
      newSelected.add(teamId);
    }
    setSelectedTeams(newSelected);
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Call the API to assign teams to project
      await apiService.assignTeamsToProject(project.id, Array.from(selectedTeams));

      onAssignmentComplete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign teams');
      console.error('Error assigning teams:', err);
    } finally {
      setSaving(false);
    }
  };

  /** Role → text colour class for the member-role chips. */
  const getRoleColorClass = (role: string): string => {
    const roleColors: Record<string, string> = {
      orchestrator: 'text-primary',
      pm: 'text-blue-400',
      developer: 'text-emerald-400',
      qa: 'text-amber-400',
      tester: 'text-red-400',
      designer: 'text-pink-400',
    };
    return roleColors[role] || 'text-text-secondary-dark';
  };

  const footer = (
    <>
      <Button onClick={onClose} disabled={saving} variant="secondary">
        Cancel
      </Button>
      <Button
        onClick={handleSave}
        disabled={allTeams.length === 0}
        loading={saving}
        icon={Check}
      >
        Assign {selectedTeams.size} Team{selectedTeams.size !== 1 ? 's' : ''}
      </Button>
    </>
  );

  return (
    <Popup
      isOpen
      onClose={onClose}
      title="Assign Teams"
      subtitle={`Select teams to assign to "${project.name}"`}
      size="xl"
      className="max-w-2xl"
      footer={footer}
    >
      <div className="max-h-[60vh] overflow-y-auto">
        {loading ? (
          <LoadingSpinner size="md" text="Loading teams..." className="py-8" />
        ) : error ? (
          <div className="space-y-3">
            <Alert variant="error">Error: {error}</Alert>
            <Button onClick={loadTeams} variant="outline" size="sm">
              Retry
            </Button>
          </div>
        ) : allTeams.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No Teams Available"
            description="Create some teams first before assigning them to projects."
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-text-primary-dark">Available Teams ({allTeams.length})</h3>
              <p className="text-xs text-text-secondary-dark">
                Selected: {selectedTeams.size} team{selectedTeams.size !== 1 ? 's' : ''}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {allTeams.map((team) => {
                const isSelected = selectedTeams.has(team.id);
                const isCurrentlyAssigned = team.projectIds?.includes(project.id);

                return (
                  // Whole card toggles selection.
                  <Card
                    key={team.id}
                    interactive
                    role="checkbox"
                    aria-checked={isSelected}
                    tabIndex={0}
                    className={`relative space-y-2 ${isSelected ? 'border-primary bg-primary/5' : ''}`}
                    onClick={() => handleTeamToggle(team.id)}
                    onKeyDown={(e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        handleTeamToggle(team.id);
                      }
                    }}
                  >
                    {isSelected && (
                      <div className="absolute top-3 right-3 text-primary">
                        <Check size={16} />
                      </div>
                    )}

                    <div className="flex items-start justify-between gap-2 pr-6">
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-text-primary-dark truncate">{team.name}</h4>
                        {team.description && (
                          <p className="text-xs text-text-secondary-dark line-clamp-2">{team.description}</p>
                        )}
                      </div>
                      <span className="text-[11px] text-text-secondary-dark shrink-0">
                        {new Date(team.updatedAt).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap text-xs text-text-secondary-dark">
                      <span className="inline-flex items-center gap-1">
                        <Users size={14} />
                        {team.members?.length || 0} member{(team.members?.length || 0) !== 1 ? 's' : ''}
                      </span>

                      {team.members && team.members.length > 0 && (
                        <>
                          {team.members.slice(0, 3).map((member, index) => (
                            <Badge key={index} className={getRoleColorClass(member.role)}>
                              {member.role}
                            </Badge>
                          ))}
                          {team.members.length > 3 && (
                            <span>+{team.members.length - 3} more</span>
                          )}
                        </>
                      )}
                    </div>

                    {isCurrentlyAssigned && (
                      <Badge variant="primary">Currently assigned to this project</Badge>
                    )}
                  </Card>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Popup>
  );
};
