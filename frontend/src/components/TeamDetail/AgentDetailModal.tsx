/**
 * AgentDetailModal Component
 *
 * Modal dialog for viewing agent details including role and skills.
 *
 * @module components/TeamDetail/AgentDetailModal
 */

import React, { useState, useEffect } from 'react';
import { X, User, Briefcase, Wrench, Check } from 'lucide-react';
import { TeamMember, SUPPORTED_MODELS } from '../../types';
import { rolesService } from '../../services/roles.service';
import { RoleWithPrompt, ROLE_CATEGORY_DISPLAY_NAMES } from '../../types/role.types';
import { useSkills } from '../../hooks/useSkills';
import { ExpertSelector } from '../TeamBuilder/ExpertSelector';

interface AgentDetailModalProps {
  /** The team member to display details for */
  member: TeamMember;
  /** Called when the modal should close */
  onClose: () => void;
  /** When true, allows editing agent configuration (runtime type) */
  isEditable?: boolean;
  /** Called when the user saves edits. Receives the member ID and partial updates. */
  onSave?: (memberId: string, updates: Partial<TeamMember>) => void;
}

/**
 * Skill with basic display information
 */
interface SkillDisplayInfo {
  id: string;
  name: string;
}

/**
 * Modal for displaying agent details (role, skills, etc.)
 *
 * @param props - Component props
 * @returns AgentDetailModal component
 */
export const AgentDetailModal: React.FC<AgentDetailModalProps> = ({ member, onClose, isEditable = false, onSave }) => {
  const [roleDetails, setRoleDetails] = useState<RoleWithPrompt | null>(null);
  const [loadingRole, setLoadingRole] = useState(true);
  const [skillDisplayInfos, setSkillDisplayInfos] = useState<SkillDisplayInfo[]>([]);
  const [editedRuntime, setEditedRuntime] = useState<string>(member.runtimeType || 'claude-code');
  const [editedModelId, setEditedModelId] = useState<string>(member.modelId || '');
  const [editedExpertId, setEditedExpertId] = useState<string | undefined>(member.expertId);
  const { skills: allSkills } = useSkills();

  useEffect(() => {
    const fetchRoleDetails = async () => {
      if (member.role) {
        try {
          const role = await rolesService.getRole(member.role);
          setRoleDetails(role);
        } catch (error) {
          console.error('Failed to fetch role details:', error);
        } finally {
          setLoadingRole(false);
        }
      } else {
        setLoadingRole(false);
      }
    };

    fetchRoleDetails();
  }, [member.role]);

  /**
   * Resolve skill display info from the already-loaded allSkills array
   * instead of making individual API calls per skill (N+1 problem).
   */
  useEffect(() => {
    if (!roleDetails && !member.skillOverrides?.length) return;

    const roleSkills = (roleDetails?.assignedSkills || [])
      .filter(skillId => !member.excludedRoleSkills?.includes(skillId));
    const allSkillIds = [
      ...roleSkills,
      ...(member.skillOverrides || [])
    ];

    if (allSkillIds.length === 0) return;

    const skillDetails = allSkillIds.map((skillId) => {
      const existing = allSkills.find(s => s.id === skillId);
      return {
        id: skillId,
        name: existing?.name || skillId,
      };
    });

    setSkillDisplayInfos(skillDetails);
  }, [roleDetails, member.skillOverrides, member.excludedRoleSkills, loadingRole, allSkills]);

  /**
   * Get skill info by ID
   */
  const getSkillInfo = (skillId: string): SkillDisplayInfo | undefined => {
    return skillDisplayInfos.find(s => s.id === skillId);
  };

  /**
   * Get all skills for this agent (from role + overrides, minus excluded)
   */
  const getAllSkillIds = (): string[] => {
    const roleSkills = (roleDetails?.assignedSkills || [])
      .filter(skillId => !member.excludedRoleSkills?.includes(skillId));
    const overrideSkills = member.skillOverrides || [];
    return [...new Set([...roleSkills, ...overrideSkills])];
  };

  /**
   * Handle overlay click to close
   */
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  /**
   * Render a skill badge
   */
  const renderSkillBadge = (skillId: string, variant: 'role' | 'additional') => {
    const skillInfo = getSkillInfo(skillId);
    const name = skillInfo?.name || skillId;

    const baseClasses = 'inline-flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-md';
    const variantClasses = variant === 'role'
      ? 'bg-primary/10 text-primary'
      : 'bg-emerald-500/10 text-emerald-400';

    return (
      <div key={skillId}>
        <span className={`${baseClasses} ${variantClasses}`}>
          <Check className="w-3 h-3" />
          {name}
        </span>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={handleOverlayClick}
    >
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-lg w-full max-w-lg m-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border-dark">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-background-dark border border-border-dark flex items-center justify-center overflow-hidden">
              {member.avatar ? (
                member.avatar.startsWith('http') || member.avatar.startsWith('data:') ? (
                  <img src={member.avatar} alt={member.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-lg">{member.avatar}</span>
                )
              ) : (
                <User className="w-6 h-6 text-text-secondary-dark" />
              )}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-text-primary-dark">{member.name}</h2>
              <p className="text-sm text-text-secondary-dark">{isEditable ? 'Edit Agent' : 'Agent Details'}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-background-dark flex items-center justify-center text-text-secondary-dark hover:text-text-primary-dark"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Role Section */}
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
              <Briefcase className="w-4 h-4" />
              Role
            </div>
            {loadingRole ? (
              <div className="animate-pulse">
                <div className="h-6 bg-background-dark rounded w-32 mb-2"></div>
                <div className="h-4 bg-background-dark rounded w-full"></div>
              </div>
            ) : roleDetails ? (
              <div className="bg-background-dark/50 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-semibold text-text-primary-dark">{roleDetails.displayName}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                    {ROLE_CATEGORY_DISPLAY_NAMES[roleDetails.category] || roleDetails.category}
                  </span>
                </div>
                <p className="text-sm text-text-secondary-dark">{roleDetails.description}</p>
              </div>
            ) : (
              <p className="text-sm text-text-secondary-dark italic">No role assigned</p>
            )}
          </div>

          {/* Skills Section */}
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
              <Wrench className="w-4 h-4" />
              Skills
            </div>
            {loadingRole ? (
              <div className="animate-pulse flex flex-wrap gap-2">
                <div className="h-7 bg-background-dark rounded-md w-24"></div>
                <div className="h-7 bg-background-dark rounded-md w-32"></div>
                <div className="h-7 bg-background-dark rounded-md w-28"></div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Skills from Role (excluding member-specific exclusions) */}
                {roleDetails?.assignedSkills && roleDetails.assignedSkills.length > 0 && (
                  <div>
                    <p className="text-xs text-text-secondary-dark mb-2">From Role</p>
                    <div className="flex flex-wrap gap-2">
                      {roleDetails.assignedSkills
                        .filter(skillId => !member.excludedRoleSkills?.includes(skillId))
                        .map(skillId =>
                          renderSkillBadge(skillId, 'role')
                        )}
                    </div>
                  </div>
                )}

                {/* Additional Skills (Overrides) */}
                {member.skillOverrides && member.skillOverrides.length > 0 && (
                  <div>
                    <p className="text-xs text-text-secondary-dark mb-2">Additional Skills</p>
                    <div className="flex flex-wrap gap-2">
                      {member.skillOverrides.map(skillId =>
                        renderSkillBadge(skillId, 'additional')
                      )}
                    </div>
                  </div>
                )}

                {/* No skills */}
                {getAllSkillIds().length === 0 && (
                  <p className="text-sm text-text-secondary-dark italic">No skills assigned</p>
                )}
              </div>
            )}
          </div>

          {/* Expert Profile Section */}
          <div>
            <ExpertSelector
              value={editedExpertId}
              onChange={(id) => {
                if (isEditable) {
                  setEditedExpertId(id);
                }
              }}
              memberRole={member.role}
              disabled={!isEditable}
            />
          </div>

          {/* Runtime Section */}
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
              Runtime
            </div>
            {isEditable ? (
              <select
                value={editedRuntime}
                onChange={(e) => setEditedRuntime(e.target.value)}
                className="w-full bg-background-dark border border-border-dark rounded-lg px-4 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-primary"
              >
                <option value="claude-code">Claude CLI</option>
                <option value="gemini-cli">Gemini CLI</option>
                <option value="codex-cli">Codex CLI</option>
                <option value="crewly-agent">Crewly Agent</option>
              </select>
            ) : (
              <div className="bg-background-dark/50 rounded-lg px-4 py-2">
                <span className="text-sm text-text-primary-dark">
                  {member.runtimeType === 'claude-code' ? 'Claude CLI' :
                   member.runtimeType === 'gemini-cli' ? 'Gemini CLI' :
                   member.runtimeType === 'codex-cli' ? 'Codex CLI' :
                   member.runtimeType === 'crewly-agent' ? 'Crewly Agent' :
                   member.runtimeType || 'Claude CLI'}
                </span>
              </div>
            )}
          </div>

          {/* AI Model — only for crewly-agent runtime */}
          {editedRuntime === 'crewly-agent' && (
            <div className="mt-4">
              <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
                AI Model
              </div>
              {isEditable ? (
                <select
                  value={editedModelId}
                  onChange={(e) => setEditedModelId(e.target.value)}
                  className="w-full bg-background-dark border border-border-dark rounded-lg px-4 py-2 text-sm text-text-primary-dark focus:outline-none focus:border-primary"
                >
                  <option value="">Default</option>
                  {SUPPORTED_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              ) : (
                <div className="bg-background-dark/50 rounded-lg px-4 py-2">
                  <span className="text-sm text-text-primary-dark">
                    {member.modelId
                      ? SUPPORTED_MODELS.find(m => m.id === member.modelId)?.label || member.modelId
                      : 'Default'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border-dark bg-background-dark rounded-b-xl">
          {isEditable ? (
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-border-dark text-text-secondary-dark rounded-lg hover:bg-surface-dark transition-colors font-medium"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  if (onSave) {
                    const updates: Partial<TeamMember> = {
                      runtimeType: editedRuntime as TeamMember['runtimeType'],
                      expertId: editedExpertId,
                    };
                    if (editedRuntime === 'crewly-agent') {
                      updates.modelId = editedModelId || undefined;
                    }
                    await onSave(member.id, updates);
                  }
                  onClose();
                }}
                className="flex-1 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium"
              >
                Save
              </button>
            </div>
          ) : (
            <button
              onClick={onClose}
              className="w-full px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors font-medium"
            >
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default AgentDetailModal;
