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
  createdAt: string;
  updatedAt: string;

  constructor(data: Partial<Team>) {
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

  toJSON(): Team {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      members: this.members,
      projectIds: this.projectIds,
      ...(this.hierarchical !== undefined ? { hierarchical: this.hierarchical } : {}),
      ...(this.leaderId !== undefined ? { leaderId: this.leaderId } : {}),
      ...(this.leaderIds !== undefined ? { leaderIds: this.leaderIds } : {}),
      ...(this.templateId !== undefined ? { templateId: this.templateId } : {}),
      ...(this.parentTeamId !== undefined ? { parentTeamId: this.parentTeamId } : {}),
      ...(this.paused !== undefined ? { paused: this.paused } : {}),
      ...(this.issueRepo !== undefined ? { issueRepo: this.issueRepo } : {}),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
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
