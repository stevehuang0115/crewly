import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, Plus, Check, X } from 'lucide-react';
import { FormLabel, FormInput, FormSelect, Button } from '../UI';
import { useAlert } from '../UI/Dialog';
import { useRoles } from '../../hooks/useRoles';
import { useProjects } from '../../hooks/useProjects';
import { useTeams } from '../../hooks/useTeams';
import { useSkills } from '../../hooks/useSkills';
import { rolesService } from '../../services/roles.service';
import { SUPPORTED_MODELS, type Project, type TeamMember as AppTeamMember } from '../../types';
import type { RoleWithPrompt } from '../../types/role.types';
import type { SkillSummary } from '../../types/skill.types';
import { HierarchyModeConfig } from '../Hierarchy';
import type { HierarchyConfig } from '../Hierarchy';

interface TeamRole {
  key: string;
  displayName: string;
  promptFile: string;
  description: string;
  category: string;
  hidden?: boolean;
  isDefault?: boolean;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  runtimeType: 'claude-code' | 'gemini-cli' | 'codex-cli' | 'crewly-agent';
  modelId?: string; // AI model override for crewly-agent runtime
  avatar?: string;
  skillOverrides?: string[]; // Additional skill IDs beyond what the role provides
  excludedRoleSkills?: string[]; // Role skills to exclude for this specific member
}

interface TeamModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: any) => void;
  team?: any;
}

// Will be loaded from configuration

export const TeamModal: React.FC<TeamModalProps> = ({ isOpen, onClose, onSubmit, team }) => {
  const { showWarning, AlertComponent } = useAlert();
  const { roles: fetchedRoles, isLoading: rolesLoading } = useRoles();
  const { projects, isLoading: projectsLoading } = useProjects();
  const { teams: allTeams, loading: teamsLoading } = useTeams();
  const { skills: allSkills, loading: skillsLoading } = useSkills();
  const [formData, setFormData] = useState({
    name: '',
    projectPath: '',
    parentTeamId: '',
  });
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [hierarchyConfig, setHierarchyConfig] = useState<HierarchyConfig>({
    hierarchical: false,
    leaderId: null,
    leaderIds: [],
  });
  const [loading, setLoading] = useState(false);
  // Track expanded skill sections per member
  const [expandedSkills, setExpandedSkills] = useState<Record<string, boolean>>({});
  // Cache role details including assignedSkills
  const [roleDetailsCache, setRoleDetailsCache] = useState<Record<string, RoleWithPrompt>>({});

  // Transform fetched roles into TeamRole format
  const availableRoles: TeamRole[] = (fetchedRoles || []).map(role => ({
    key: role.name,
    displayName: role.displayName,
    promptFile: `${role.name}-prompt.md`,
    description: role.description || '',
    category: role.category,
    hidden: false,
    isDefault: role.isDefault,
  }));

  /**
   * Fetch role details including assignedSkills
   */
  const fetchRoleDetails = useCallback(async (roleKey: string): Promise<RoleWithPrompt | null> => {
    if (roleDetailsCache[roleKey]) {
      return roleDetailsCache[roleKey];
    }
    try {
      const roleData = await rolesService.getRole(roleKey);
      setRoleDetailsCache(prev => ({ ...prev, [roleKey]: roleData }));
      return roleData;
    } catch (err) {
      console.error('Failed to fetch role details:', err);
      return null;
    }
  }, [roleDetailsCache]);

  /**
   * Toggle skill section expansion for a member
   */
  const toggleSkillSection = (memberId: string) => {
    setExpandedSkills(prev => ({
      ...prev,
      [memberId]: !prev[memberId]
    }));
  };

  /**
   * Toggle a skill override for a member
   */
  const toggleSkillOverride = (memberId: string, skillId: string) => {
    setMembers(prev => prev.map(member => {
      if (member.id !== memberId) return member;
      const currentOverrides = member.skillOverrides || [];
      const hasSkill = currentOverrides.includes(skillId);
      return {
        ...member,
        skillOverrides: hasSkill
          ? currentOverrides.filter(id => id !== skillId)
          : [...currentOverrides, skillId]
      };
    }));
  };

  /**
   * Toggle exclusion of a role skill for a specific member
   */
  const toggleRoleSkillExclusion = (memberId: string, skillId: string) => {
    setMembers(prev => prev.map(member => {
      if (member.id !== memberId) return member;
      const currentExcluded = member.excludedRoleSkills || [];
      const isExcluded = currentExcluded.includes(skillId);
      return {
        ...member,
        excludedRoleSkills: isExcluded
          ? currentExcluded.filter(id => id !== skillId)
          : [...currentExcluded, skillId]
      };
    }));
  };

  /**
   * Get the effective role skills for a member (excluding excluded ones)
   */
  const getEffectiveRoleSkills = (member: TeamMember): string[] => {
    const roleSkills = getRoleSkills(member.role);
    const excluded = member.excludedRoleSkills || [];
    return roleSkills.filter(skillId => !excluded.includes(skillId));
  };

  /**
   * Get skills assigned to a role
   */
  const getRoleSkills = (roleKey: string): string[] => {
    const roleDetails = roleDetailsCache[roleKey];
    return roleDetails?.assignedSkills || [];
  };

  /**
   * Get skill info by ID
   */
  const getSkillById = (skillId: string): SkillSummary | undefined => {
    return allSkills.find(s => s.id === skillId);
  };

  useEffect(() => {
    if (team) {
      setFormData({
        name: team.name || '',
        projectPath: team.projectIds?.[0] || team.projectPath || '',
        parentTeamId: team.parentTeamId || '',
      });
      setHierarchyConfig({
        hierarchical: team.hierarchical || false,
        leaderId: team.leaderId || null,
        leaderIds: team.leaderIds || (team.leaderId ? [team.leaderId] : []),
      });
      if (team.members && Array.isArray(team.members)) {
        // Ensure all members have runtimeType, avatar, skillOverrides, and excludedRoleSkills (for backward compatibility)
        const migratedMembers = team.members.map((member: TeamMember, index: number) => ({
          ...member,
          runtimeType: member.runtimeType || 'claude-code',
          avatar: member.avatar || avatarChoices[index % avatarChoices.length],
          skillOverrides: member.skillOverrides || [],
          excludedRoleSkills: member.excludedRoleSkills || []
        }));
        setMembers(migratedMembers);
        // Fetch role details for all members' roles
        migratedMembers.forEach((member: TeamMember) => {
          if (member.role) {
            fetchRoleDetails(member.role);
          }
        });
      }
    }
  }, [team, fetchRoleDetails]);

  // Initialize default members when roles are loaded and no existing team
  useEffect(() => {
    if (availableRoles.length > 0 && members.length === 0 && !team) {
      const defaultRoles = availableRoles.filter(role => role.isDefault);

      const defaultMembers: TeamMember[] = defaultRoles.map((role, index) => ({
        id: (index + 1).toString(),
        name: role.displayName,
        role: role.key,
        systemPrompt: `Load from ${role.promptFile}`,
        runtimeType: 'claude-code',
        avatar: avatarChoices[index % avatarChoices.length],
        skillOverrides: [],
        excludedRoleSkills: []
      }));

      if (defaultMembers.length > 0) {
        setMembers(defaultMembers);
        // Fetch role details for default members
        defaultMembers.forEach(member => {
          fetchRoleDetails(member.role);
        });
      }
    }
  }, [availableRoles, members.length, team, fetchRoleDetails]);


  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleMemberChange = (memberId: string, field: keyof TeamMember, value: string) => {
    setMembers(prev => prev.map(member => {
      if (member.id === memberId) {
        const updatedMember = { ...member, [field]: value };

        // Auto-update system prompt when role changes
        if (field === 'role') {
          const selectedRole = availableRoles.find(role => role.key === value);
          if (selectedRole) {
            updatedMember.systemPrompt = `Load from ${selectedRole.promptFile}`;
          }
          // Clear skill overrides and exclusions when role changes (they may not be relevant anymore)
          updatedMember.skillOverrides = [];
          updatedMember.excludedRoleSkills = [];
          // Fetch role details to know assigned skills
          fetchRoleDetails(value);
        }

        return updatedMember;
      }
      return member;
    }));
  };

  const avatarChoices = [
    'https://picsum.photos/seed/1/64',
    'https://picsum.photos/seed/2/64',
    'https://picsum.photos/seed/3/64',
    'https://picsum.photos/seed/4/64',
    'https://picsum.photos/seed/5/64',
    'https://picsum.photos/seed/6/64',
  ];

  const addMember = () => {
    const newId = (Math.max(...members.map(m => parseInt(m.id))) + 1).toString();
    const fullstackDevRole = availableRoles.find(role => role.key === 'fullstack-dev');
    const newMember: TeamMember = {
      id: newId,
      name: 'Fullstack Developer',
      role: 'fullstack-dev',
      systemPrompt: fullstackDevRole ? `Load from ${fullstackDevRole.promptFile}` : 'Default fullstack developer prompt',
      runtimeType: 'claude-code',
      avatar: avatarChoices[members.length % avatarChoices.length],
      skillOverrides: [],
      excludedRoleSkills: []
    };
    setMembers(prev => [...prev, newMember]);
    // Fetch role details for the new member
    fetchRoleDetails('fullstack-dev');
  };

  const removeMember = (memberId: string) => {
    if (members.length > 1) {
      setMembers(prev => prev.filter(member => member.id !== memberId));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name.trim() || members.length === 0) return;

    // Validate all members have required fields
    for (const member of members) {
      if (!member.name.trim()) {
        showWarning('All team members must have a name');
        return;
      }
    }

    setLoading(true);
    try {
      // Convert selected project ID to proper format
      const selectedProject = projects.find(p => p.id === formData.projectPath);
      const submitData = {
        ...formData,
        members: members.map(member => ({
          name: member.name,
          role: member.role,
          systemPrompt: member.systemPrompt,
          runtimeType: member.runtimeType,
          avatar: member.avatar,
          skillOverrides: member.skillOverrides || [],
          excludedRoleSkills: member.excludedRoleSkills || []
        })),
        projectIds: formData.projectPath ? [formData.projectPath] : [], // Send project ID, not path
        projectPath: selectedProject ? selectedProject.path : undefined, // Keep path for backend processing
        parentTeamId: formData.parentTeamId || null, // null clears parent
        hierarchical: hierarchyConfig.hierarchical,
        leaderId: hierarchyConfig.hierarchical ? hierarchyConfig.leaderId : undefined,
        leaderIds: hierarchyConfig.hierarchical ? hierarchyConfig.leaderIds : undefined,
      };
      await onSubmit(submitData);
    } catch (error) {
      console.error('Error submitting team:', error);
    } finally {
      setLoading(false);
    }
  };



  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSubmit(e);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-background-dark/80 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-surface-dark border border-border-dark rounded-xl shadow-lg w-full max-w-2xl m-4" onClick={(e) => e.stopPropagation()}>
          <div className="p-6">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-xl font-semibold text-text-primary-dark">
                  {team ? 'Edit Team' : 'Create New Team'}
                </h3>
                <p className="text-sm text-text-secondary-dark mt-1">
                  {team ? 'Modify team configuration and members' : 'Configure the details for your new AI agent team.'}
                </p>
              </div>
              <button
                onClick={onClose}
                className="w-8 h-8 -mt-1 -mr-1 rounded-lg hover:bg-background-dark flex items-center justify-center text-text-secondary-dark hover:text-text-primary-dark"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <form onSubmit={handleFormSubmit} className="mt-6 space-y-6 max-h-[60vh] overflow-y-auto pr-2">
              <div>
                <FormLabel htmlFor="team-name">Team Name</FormLabel>
                <FormInput
                  id="team-name"
                  type="text"
                  value={formData.name}
                  onChange={handleInputChange}
                  name="name"
                  placeholder="e.g., Frontend Wizards"
                  required
                />
              </div>

              <div>
                <FormLabel htmlFor="project-assignment">Assigned Project</FormLabel>
                <FormSelect
                  id="project-assignment"
                  value={formData.projectPath || ''}
                  onChange={handleInputChange}
                  name="projectPath"
                >
                  <option value="">No project assigned</option>
                  {projects.map(project => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </FormSelect>
                <p className="text-xs text-text-secondary-dark mt-1">
                  Optionally assign a project for this team to work on
                </p>
              </div>

              <div>
                <FormLabel htmlFor="parent-team">Parent Team</FormLabel>
                <FormSelect
                  id="parent-team"
                  value={formData.parentTeamId || ''}
                  onChange={handleInputChange}
                  name="parentTeamId"
                >
                  <option value="">None (Independent Team)</option>
                  {allTeams
                    .filter(t => t.id !== team?.id && t.id !== 'orchestrator')
                    .map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                </FormSelect>
                <p className="text-xs text-text-secondary-dark mt-1">
                  Optionally link this team under a parent team for organization
                </p>
              </div>

              <HierarchyModeConfig
                config={hierarchyConfig}
                onChange={setHierarchyConfig}
                members={members as unknown as AppTeamMember[]}
              />

              <div>
                <FormLabel>Team Members</FormLabel>
                <div className="space-y-4">
                  {members.map((member, index) => (
                    <div key={member.id} className="p-4 border border-border-dark rounded-lg space-y-4 bg-background-dark/50">
                      <div>
                        <FormLabel>Avatar</FormLabel>
                        <div className="flex items-center gap-4">
                          <img
                            src={member.avatar || avatarChoices[0]}
                            alt="Selected Avatar"
                            className="w-12 h-12 rounded-full ring-2 ring-primary/50"
                          />
                          <div className="flex flex-wrap gap-2 flex-1">
                            {avatarChoices.map((url) => (
                              <img
                                key={url}
                                src={url}
                                alt="Avatar option"
                                onClick={() => handleMemberChange(member.id, 'avatar', url)}
                                className={`w-9 h-9 rounded-full cursor-pointer transition-all ${member.avatar === url ? 'ring-2 ring-primary' : 'ring-2 ring-transparent hover:ring-primary/50'}`}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <FormLabel htmlFor={`member-name-${index}`}>Agent Name</FormLabel>
                          <FormInput
                            id={`member-name-${index}`}
                            type="text"
                            value={member.name}
                            onChange={(e) => handleMemberChange(member.id, 'name', e.target.value)}
                            placeholder="e.g., Agent Smith"
                            required
                          />
                        </div>
                        <div>
                          <FormLabel htmlFor={`member-role-${index}`}>Role</FormLabel>
                          <FormSelect
                            id={`member-role-${index}`}
                            value={member.role}
                            onChange={(e) => handleMemberChange(member.id, 'role', e.target.value)}
                            required
                          >
                            <option value="">Select role</option>
                            {availableRoles.filter(r => !r.hidden).map(r => (
                              <option key={r.key} value={r.key}>{r.displayName}</option>
                            ))}
                          </FormSelect>
                        </div>
                      </div>
                      <div>
                        <FormLabel htmlFor={`runtime-type-${index}`}>Runtime Type</FormLabel>
                        <FormSelect
                          id={`runtime-type-${index}`}
                          value={member.runtimeType}
                          onChange={(e) => handleMemberChange(member.id, 'runtimeType', e.target.value)}
                          required
                        >
                          <option value="claude-code">Claude CLI</option>
                          <option value="gemini-cli">Gemini CLI</option>
                          <option value="codex-cli">Codex CLI</option>
                          <option value="crewly-agent">Crewly Agent</option>
                        </FormSelect>
                      </div>

                      {/* AI Model Selection — only for crewly-agent runtime */}
                      {member.runtimeType === 'crewly-agent' && (
                        <div>
                          <FormLabel htmlFor={`model-id-${index}`}>AI Model</FormLabel>
                          <FormSelect
                            id={`model-id-${index}`}
                            value={member.modelId || ''}
                            onChange={(e) => handleMemberChange(member.id, 'modelId', e.target.value)}
                          >
                            <option value="">Default</option>
                            {SUPPORTED_MODELS.map(m => (
                              <option key={m.id} value={m.id}>{m.label}</option>
                            ))}
                          </FormSelect>
                        </div>
                      )}

                      {/* Skills Section */}
                      {member.role && (
                        <div className="border-t border-border-dark pt-3">
                          <button
                            type="button"
                            onClick={() => toggleSkillSection(member.id)}
                            className="flex items-center gap-2 text-sm font-medium text-text-primary-dark hover:text-primary w-full"
                          >
                            {expandedSkills[member.id] ? (
                              <ChevronDown className="w-4 h-4" />
                            ) : (
                              <ChevronRight className="w-4 h-4" />
                            )}
                            <span>Skills</span>
                            <span className="text-xs text-text-secondary-dark ml-1">
                              ({getEffectiveRoleSkills(member).length} from role
                              {(member.excludedRoleSkills?.length || 0) > 0 && ` - ${member.excludedRoleSkills?.length} excluded`}
                              {(member.skillOverrides?.length || 0) > 0 && ` + ${member.skillOverrides?.length} additional`})
                            </span>
                          </button>

                          {expandedSkills[member.id] && (
                            <div className="mt-3 space-y-2">
                              {/* Skills from Role (can be excluded for this member) */}
                              {getRoleSkills(member.role).length > 0 && (
                                <div className="space-y-1">
                                  <p className="text-xs text-text-secondary-dark font-medium uppercase tracking-wide">
                                    From Role <span className="font-normal">(click to exclude for this member)</span>
                                  </p>
                                  <div className="flex flex-wrap gap-1.5">
                                    {getRoleSkills(member.role).map(skillId => {
                                      const skill = getSkillById(skillId);
                                      const isExcluded = member.excludedRoleSkills?.includes(skillId);
                                      return (
                                        <button
                                          key={skillId}
                                          type="button"
                                          onClick={() => toggleRoleSkillExclusion(member.id, skillId)}
                                          className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors cursor-pointer ${
                                            isExcluded
                                              ? 'bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20'
                                              : 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                                          }`}
                                          title={isExcluded ? `Click to re-enable "${skill?.name || skillId}" for this member` : `Click to exclude "${skill?.name || skillId}" for this member`}
                                        >
                                          {isExcluded ? <X className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                                          {skill?.name || skillId}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}

                              {/* Additional Skills (can be toggled) */}
                              <div className="space-y-1">
                                <p className="text-xs text-text-secondary-dark font-medium uppercase tracking-wide">
                                  Additional Skills
                                </p>
                                {skillsLoading ? (
                                  <p className="text-xs text-text-secondary-dark">Loading skills...</p>
                                ) : (
                                  <div className="flex flex-wrap gap-1.5">
                                    {allSkills
                                      .filter(skill => !getRoleSkills(member.role).includes(skill.id))
                                      .map(skill => {
                                        const isSelected = member.skillOverrides?.includes(skill.id);
                                        return (
                                          <button
                                            key={skill.id}
                                            type="button"
                                            onClick={() => toggleSkillOverride(member.id, skill.id)}
                                            className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors ${
                                              isSelected
                                                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                                                : 'bg-background-dark border-border-dark text-text-secondary-dark hover:border-primary/50 hover:text-text-primary-dark'
                                            }`}
                                            title={skill.description}
                                          >
                                            {isSelected ? (
                                              <Check className="w-3 h-3" />
                                            ) : (
                                              <Plus className="w-3 h-3" />
                                            )}
                                            {skill.name}
                                          </button>
                                        );
                                      })}
                                    {allSkills.filter(skill => !getRoleSkills(member.role).includes(skill.id)).length === 0 && (
                                      <p className="text-xs text-text-secondary-dark">No additional skills available</p>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() => removeMember(member.id)}
                          className="text-text-secondary-dark hover:text-red-500 h-auto p-0 text-sm flex items-center gap-1"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                          Delete Member
                        </button>
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addMember}
                    className="w-full flex items-center justify-center gap-2 py-2 border-2 border-dashed border-border-dark rounded-lg text-text-secondary-dark hover:text-primary hover:border-primary transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    <span>Add Team Member</span>
                  </button>
                </div>
              </div>
            </form>
          </div>
          <div className="bg-background-dark px-6 py-4 rounded-b-xl border-t border-border-dark flex justify-end gap-3">
            <Button variant="secondary" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              onClick={handleFormSubmit}
              disabled={!formData.name.trim() || members.length === 0 || loading || rolesLoading || projectsLoading || teamsLoading}
            >
              {loading ? (
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
              ) : (
                <span className="inline-flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={team ? "M5 13l4 4L19 7" : "M12 6v6m0 0v6m0-6h6m-6 0H6"} />
                  </svg>
                  {team ? 'Save Changes' : 'Create Team'}
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>
      <AlertComponent />
    </>
  );
};
