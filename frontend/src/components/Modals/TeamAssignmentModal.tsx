import React, { useState, useEffect } from 'react';
import { Button } from '../UI';
import { X, Users, Check } from 'lucide-react';
import { Team, Project } from '@/types';
import { apiService } from '@/services/api.service';

interface TeamAssignmentModalProps {
  project: Project;
  onClose: () => void;
  onAssignmentComplete: () => void;
}

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

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const getRoleColor = (role: string) => {
    const roleColors: Record<string, string> = {
      orchestrator: '#2a73ea',
      pm: '#3b82f6',
      developer: '#10b981',
      qa: '#f59e0b',
      tester: '#ef4444',
      designer: '#ec4899'
    };
    return roleColors[role] || '#6b7280';
  };


  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal-content team-assignment-modal">
        <div className="modal-header">
          <div className="modal-title">
            <Users className="title-icon" />
            <div>
              <h2>Assign Teams</h2>
              <p>Select teams to assign to "{project.name}"</p>
            </div>
          </div>
          <button className="close-button" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="loading-state">
              <div className="loading-spinner"></div>
              <p>Loading teams...</p>
            </div>
          ) : error ? (
            <div className="error-state">
              <p>Error: {error}</p>
              <Button onClick={loadTeams} className="retry-button" variant="outline" size="sm">
                Retry
              </Button>
            </div>
          ) : allTeams.length === 0 ? (
            <div className="empty-state">
              <Users size={48} />
              <h3>No Teams Available</h3>
              <p>Create some teams first before assigning them to projects.</p>
            </div>
          ) : (
            <div className="teams-selection">
              <div className="selection-header">
                <h3>Available Teams ({allTeams.length})</h3>
                <p>Selected: {selectedTeams.size} team{selectedTeams.size !== 1 ? 's' : ''}</p>
              </div>

              <div className="teams-grid">
                {allTeams.map((team) => {
                  const isSelected = selectedTeams.has(team.id);
                  const isCurrentlyAssigned = team.projectIds?.includes(project.id);

                  return (
                    <div
                      key={team.id}
                      className={`team-selection-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => handleTeamToggle(team.id)}
                    >
                      {isSelected && (
                        <div className="selection-indicator">
                          <Check size={16} />
                        </div>
                      )}

                      <div className="team-card-header">
                        <div className="team-info">
                          <h4 className="team-name">{team.name}</h4>
                          {team.description && (
                            <p className="team-description">{team.description}</p>
                          )}
                        </div>

                        <div className="team-meta">
                          <span className="team-meta-info">
                            {new Date(team.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>

                      <div className="team-members-summary">
                        <div className="members-count">
                          <Users size={14} />
                          <span>{team.members?.length || 0} member{(team.members?.length || 0) !== 1 ? 's' : ''}</span>
                        </div>

                        {team.members && team.members.length > 0 && (
                          <div className="member-roles">
                            {team.members.slice(0, 3).map((member, index) => (
                              <span
                                key={index}
                                className="role-badge"
                                style={{ color: getRoleColor(member.role) }}
                              >
                                {member.role}
                              </span>
                            ))}
                            {team.members.length > 3 && (
                              <span className="more-roles">+{team.members.length - 3} more</span>
                            )}
                          </div>
                        )}
                      </div>

                      {isCurrentlyAssigned && (
                        <div className="assignment-status current-project">
                          Currently assigned to this project
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <Button className="secondary-button" onClick={onClose} disabled={saving} variant="secondary">
            Cancel
          </Button>
          <Button
            className="primary-button"
            onClick={handleSave}
            disabled={saving || allTeams.length === 0}
            loading={saving}
            icon={Check}
          >
            Assign {selectedTeams.size} Team{selectedTeams.size !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </div>
  );
};
