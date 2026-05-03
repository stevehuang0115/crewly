import { Project } from '../types/index.js';

export class ProjectModel implements Project {
  id: string;
  name: string;
  path: string;
  teams: Record<string, string[]>;
  status: 'active' | 'paused' | 'completed' | 'stopped';
  /** Onboarding v3 (B1) — see `Project.firstLaunchedAt` for semantics. */
  firstLaunchedAt?: string;
  createdAt: string;
  updatedAt: string;

  constructor(data: Partial<Project>) {
    this.id = data.id || '';
    this.name = data.name || '';
    this.path = data.path || '';
    this.teams = data.teams || {};
    this.status = data.status || 'stopped';
    this.firstLaunchedAt = data.firstLaunchedAt;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  updateStatus(status: Project['status']): void {
    this.status = status;
    this.updatedAt = new Date().toISOString();
  }

  assignTeam(teamId: string, role: string): void {
    if (!this.teams[role]) {
      this.teams[role] = [];
    }
    if (!this.teams[role].includes(teamId)) {
      this.teams[role].push(teamId);
    }
    this.updatedAt = new Date().toISOString();
  }

  unassignTeam(teamId: string, role?: string): void {
    if (role) {
      // Unassign from specific role
      if (this.teams[role]) {
        this.teams[role] = this.teams[role].filter(id => id !== teamId);
        if (this.teams[role].length === 0) {
          delete this.teams[role];
        }
      }
    } else {
      // Unassign from all roles
      for (const [currentRole, teamIds] of Object.entries(this.teams)) {
        this.teams[currentRole] = teamIds.filter(id => id !== teamId);
        if (this.teams[currentRole].length === 0) {
          delete this.teams[currentRole];
        }
      }
    }
    this.updatedAt = new Date().toISOString();
  }

  getAssignedTeams(): string[] {
    return Object.values(this.teams).flat();
  }

  toJSON(): Project {
    const json: Project = {
      id: this.id,
      name: this.name,
      path: this.path,
      teams: this.teams,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    // Onboarding v3 (B1) — only emit `firstLaunchedAt` when set, so legacy
    // project records round-trip without acquiring an `undefined` field.
    if (this.firstLaunchedAt !== undefined) {
      json.firstLaunchedAt = this.firstLaunchedAt;
    }
    return json;
  }

  static fromJSON(data: Project): ProjectModel {
    return new ProjectModel(data);
  }
}