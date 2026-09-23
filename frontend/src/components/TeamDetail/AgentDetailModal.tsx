/**
 * AgentDetailModal Component
 *
 * Modal dialog for viewing agent details including role and skills.
 *
 * @module components/TeamDetail/AgentDetailModal
 */

import React, { useState, useEffect } from 'react';
import { Briefcase, Wrench, Check } from 'lucide-react';
import { Badge } from '@crewly/ui/Badge';
import { Button } from '@crewly/ui/Button';
import { FormInput, FormSelect } from '@crewly/ui/Form';
import { Popup } from '@crewly/ui/Popup';
import { TeamMember, SUPPORTED_MODELS, RUNTIME_MODEL_PRESETS, RUNTIME_EFFORT_LEVELS, RUNTIME_MODEL_HINTS } from '../../types';
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
  const [editedEffort, setEditedEffort] = useState<string>(member.reasoningEffort || '');
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
   * Render a skill badge
   */
  const renderSkillBadge = (skillId: string, variant: 'role' | 'additional') => {
    const skillInfo = getSkillInfo(skillId);
    const name = skillInfo?.name || skillId;

    return (
      <div key={skillId}>
        <Badge variant={variant === 'role' ? 'primary' : 'success'} size="md" className="gap-1.5">
          <Check className="w-3 h-3" />
          {name}
        </Badge>
      </div>
    );
  };

  /** Persist the edited runtime/model/expert, then close. */
  const handleSave = async (): Promise<void> => {
    if (onSave) {
      const updates: Partial<TeamMember> = {
        runtimeType: editedRuntime as TeamMember['runtimeType'],
        expertId: editedExpertId,
      };
      // '' clears the override server-side (PUT /members/:id treats '' as "unset").
      updates.modelId = editedModelId || '';
      updates.reasoningEffort = editedRuntime === 'crewly-agent' ? '' : (editedEffort || '');
      await onSave(member.id, updates);
    }
    onClose();
  };

  const footer = isEditable ? (
    <>
      <Button variant="secondary" className="flex-1" onClick={onClose}>
        Cancel
      </Button>
      <Button className="flex-1" onClick={handleSave}>
        Save
      </Button>
    </>
  ) : (
    <Button fullWidth onClick={onClose}>
      Close
    </Button>
  );

  return (
    <Popup
      isOpen
      onClose={onClose}
      title={member.name}
      subtitle={isEditable ? 'Edit Agent' : 'Agent Details'}
      size="lg"
      footer={footer}
    >
      {/* Content */}
      <div className="space-y-6 max-h-[65vh] overflow-y-auto">
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
                <Badge variant="primary">
                  {ROLE_CATEGORY_DISPLAY_NAMES[roleDetails.category] || roleDetails.category}
                </Badge>
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
            <FormSelect
              aria-label="Runtime"
              value={editedRuntime}
              onChange={(e) => setEditedRuntime(e.target.value)}
            >
              <option value="claude-code">Claude CLI</option>
              <option value="gemini-cli">Gemini CLI</option>
              <option value="codex-cli">Codex CLI</option>
              <option value="opencode-cli">OpenCode CLI</option>
              <option value="crewly-agent">Crewly Agent</option>
            </FormSelect>
          ) : (
            <div className="bg-background-dark/50 rounded-lg px-4 py-2">
              <span className="text-sm text-text-primary-dark">
                {member.runtimeType === 'claude-code' ? 'Claude CLI' :
                 member.runtimeType === 'gemini-cli' ? 'Gemini CLI' :
                 member.runtimeType === 'codex-cli' ? 'Codex CLI' :
                 member.runtimeType === 'opencode-cli' ? 'OpenCode CLI' :
                 member.runtimeType === 'crewly-agent' ? 'Crewly Agent' :
                 member.runtimeType || 'Claude CLI'}
              </span>
            </div>
          )}
        </div>

        {/* AI Model — PTY runtimes take the harness's own model name (+ optional effort) */}
        {editedRuntime !== 'crewly-agent' && (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
                Model
              </div>
              {isEditable ? (
                <>
                  <FormInput
                    aria-label="Model"
                    list="agent-model-presets"
                    value={editedModelId}
                    placeholder="Runtime default"
                    onChange={(e) => setEditedModelId(e.target.value.trim())}
                  />
                  <datalist id="agent-model-presets">
                    {(RUNTIME_MODEL_PRESETS[editedRuntime] || []).map(m => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </datalist>
                  <p className="mt-1 text-xs text-text-secondary-dark">{RUNTIME_MODEL_HINTS[editedRuntime]}</p>
                </>
              ) : (
                <div className="bg-background-dark/50 rounded-lg px-4 py-2">
                  <span className="text-sm text-text-primary-dark">{member.modelId || 'Runtime default'}</span>
                </div>
              )}
            </div>
            {(RUNTIME_EFFORT_LEVELS[editedRuntime] || []).length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
                  Reasoning effort
                </div>
                {isEditable ? (
                  <FormSelect
                    aria-label="Reasoning effort"
                    value={editedEffort}
                    onChange={(e) => setEditedEffort(e.target.value)}
                  >
                    <option value="">Default</option>
                    {RUNTIME_EFFORT_LEVELS[editedRuntime].map(level => (
                      <option key={level} value={level}>{level}</option>
                    ))}
                  </FormSelect>
                ) : (
                  <div className="bg-background-dark/50 rounded-lg px-4 py-2">
                    <span className="text-sm text-text-primary-dark">{member.reasoningEffort || 'Default'}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* AI Model — crewly-agent picks provider/model */}
        {editedRuntime === 'crewly-agent' && (
          <div className="mt-4">
            <div className="flex items-center gap-2 text-sm font-medium text-text-secondary-dark uppercase tracking-wide mb-3">
              AI Model
            </div>
            {isEditable ? (
              <FormSelect
                aria-label="AI Model"
                value={editedModelId}
                onChange={(e) => setEditedModelId(e.target.value)}
              >
                <option value="">Default</option>
                {SUPPORTED_MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </FormSelect>
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
    </Popup>
  );
};

export default AgentDetailModal;
