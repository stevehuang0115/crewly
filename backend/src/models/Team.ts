import { Team, TeamMember, TeamPauseState } from '../types/index.js';
import { RUNTIME_TYPES } from '../constants.js';
import { normalizeTeamLeaderIds } from '../utils/team.utils.js';

export class TeamModel implements Team {
  id: string;
  name: string;
  description?: string;
  members: TeamMember[];
  projectIds: string[];
  hierarchical?: boolean;
  leaderId?: string;
  leaderIds?: string[];
  templateId?: string;
  parentTeamId?: string;
  /** Owner pause (specs/2026-10-04-team-pause.md) */
  paused?: TeamPauseState;
  /** Where other agents file work while the team is paused */
  issueRepo?: string;
  worktrees?: Team['worktrees'];
  archived?: boolean;
  archivedAt?: string;
  mission?: string;
  budget?: Team['budget'];
  qualityGate?: Team['qualityGate'];
  recoveryPolicy?: Team['recoveryPolicy'];
  ownerUserId?: string;
  ownershipScope?: Team['ownershipScope'];
  serviceContract?: Team['serviceContract'];
  triggers?: Team['triggers'];
  /** Fields this class does not know about (a newer version, a plugin): kept as stored, never dropped. */
  [extra: string]: unknown;
  createdAt: string;
  updatedAt: string;

  constructor(data: Partial<Team>) {
    // Keep every stored field (known or not) so a read -> save round trip never
    // drops one (#1071); the named assignments below add the defaults.
    Object.assign(this, data);
    this.id = data.id || '';
    this.name = data.name || '';
    this.description = data.description;
    this.members = data.members || [];
    this.projectIds = data.projectIds || [];
    this.hierarchical = data.hierarchical;
    this.leaderIds = data.leaderIds;
    this.leaderId = data.leaderId;
    this.templateId = data.templateId;
    this.parentTeamId = data.parentTeamId;
    this.paused = data.paused;
    this.issueRepo = data.issueRepo;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  assignToProject(projectId: string): void {
    if (!this.projectIds.includes(projectId)) {
      this.projectIds.push(projectId);
    }
    this.updatedAt = new Date().toISOString();
  }

  unassignFromProject(projectId: string): void {
    this.projectIds = this.projectIds.filter(id => id !== projectId);
    this.updatedAt = new Date().toISOString();
  }

  addMember(member: TeamMember): void {
    this.members.push(member);
    this.updatedAt = new Date().toISOString();
  }

  removeMember(memberId: string): void {
    this.members = this.members.filter(member => member.id !== memberId);
    this.updatedAt = new Date().toISOString();
  }

  updateMember(memberId: string, updates: Partial<TeamMember>): void {
    const memberIndex = this.members.findIndex(member => member.id === memberId);
    if (memberIndex !== -1) {
      this.members[memberIndex] = {
        ...this.members[memberIndex],
        ...updates,
        updatedAt: new Date().toISOString()
      };
      this.updatedAt = new Date().toISOString();
    }
  }

  assignTicketsToMember(memberId: string, ticketIds: string[]): void {
    const memberIndex = this.members.findIndex(member => member.id === memberId);
    if (memberIndex !== -1) {
      this.members[memberIndex].currentTickets = ticketIds;
      this.members[memberIndex].updatedAt = new Date().toISOString();
      this.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Serialise every own field (declared or not), core fields first. Fields
   * left undefined are omitted, as JSON.stringify would drop them anyway.
   */
  toJSON(): Team {
    const out: Record<string, unknown> = {
      id: this.id,
      name: this.name,
      description: this.description,
      members: this.members,
      projectIds: this.projectIds,
    };
    for (const [key, value] of Object.entries(this)) {
      if (value !== undefined && !(key in out)) out[key] = value;
    }
    out.createdAt = this.createdAt;
    out.updatedAt = this.updatedAt;
    return out as unknown as Team;
  }

  static fromJSON(data: Team): TeamModel {
    // Handle data migration from legacy format
    const migratedData: any = { ...data };

    // Migration: convert legacy currentProject to projectIds
    if ((data as any).currentProject && !data.projectIds) {
      migratedData.projectIds = [(data as any).currentProject];
    } else {
      migratedData.projectIds = data.projectIds || [];
    }
    // The legacy field is migrated away (it is not carried through now that unknown fields are kept).
    delete migratedData.currentProject;

    // Migration: store the team-lead rule's answer (utils/team.utils) —
    // explicit leaderIds (or legacy leaderId), else the team-leader /
    // tech-lead members — and keep leaderId = leaderIds[0]. Idempotent.
    normalizeTeamLeaderIds(migratedData);

    // Migrate legacy status fields for team members
    if (migratedData.members) {
      migratedData.members = migratedData.members.map((member: any) => {
        const migratedMember = { ...member };
        // Migrate legacy 'status' field to 'agentStatus'
        if (member.status && !member.agentStatus) {
          // Map legacy status values to new agentStatus values
          switch (member.status) {
            case 'active':
              migratedMember.agentStatus = 'active';
              break;
            case 'idle':
            case 'inactive':
              migratedMember.agentStatus = 'inactive';
              break;
            case 'activating':
              migratedMember.agentStatus = 'activating';
              break;
            default:
              migratedMember.agentStatus = 'inactive';
          }

          // Remove legacy field
          delete migratedMember.status;
        }

        // Ensure workingStatus exists (default to 'idle')
        if (!migratedMember.workingStatus) {
          migratedMember.workingStatus = 'idle';
        }

        // Ensure agentStatus exists (default to 'inactive')
        // CRITICAL: Only set default for truly missing fields, preserve 'activating'/'active' states
        if (migratedMember.agentStatus === undefined || migratedMember.agentStatus === null) {
          migratedMember.agentStatus = 'inactive';
        }

        // Ensure runtimeType exists (default to 'claude-code')
        if (!migratedMember.runtimeType) {
          migratedMember.runtimeType = RUNTIME_TYPES.CLAUDE_CODE;
        }
        return migratedMember;
      });
    }

    return new TeamModel(migratedData);
  }
}
