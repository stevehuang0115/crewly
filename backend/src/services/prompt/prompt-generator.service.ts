/**
 * Prompt Generator Service
 *
 * Generates and manages system prompts for team members by composing:
 * - Role base prompts (from role definitions)
 * - Skill instructions (from assigned skills)
 *
 * Also adds context prefixes to help agents re-read their prompts
 * when context window is compressed.
 *
 * @module services/prompt/prompt-generator.service
 */

import * as path from 'path';
import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import { StorageService } from '../core/storage.service.js';
import { LoggerService, ComponentLogger } from '../core/logger.service.js';
import type { TeamMember, Team } from '../../types/index.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';

/**
 * Service for generating and managing team member prompts.
 */
export class PromptGeneratorService {
  private static instance: PromptGeneratorService | null = null;
  private storageService: StorageService;
  private logger: ComponentLogger;
  private configDir: string;
  private crewlyHome: string;

  constructor() {
    this.storageService = StorageService.getInstance();
    this.logger = LoggerService.getInstance().createComponentLogger('PromptGeneratorService');
    this.configDir = path.resolve(process.cwd(), 'config');
    this.crewlyHome = getCrewlyHomePath();
  }

  /**
   * Get singleton instance of PromptGeneratorService.
   *
   * @returns The singleton instance
   */
  static getInstance(): PromptGeneratorService {
    if (!PromptGeneratorService.instance) {
      PromptGeneratorService.instance = new PromptGeneratorService();
    }
    return PromptGeneratorService.instance;
  }

  /**
   * Reset singleton instance (for testing).
   */
  static resetInstance(): void {
    PromptGeneratorService.instance = null;
  }

  /**
   * Generate a full prompt for a team member by composing:
   * 1. Role base prompt
   * 2. Skill instructions for each assigned skill
   *
   * @param member - The team member
   * @param teamId - The team ID
   * @returns The composed prompt content
   */
  async generateMemberPrompt(member: TeamMember, teamId: string): Promise<string> {
    const sections: string[] = [];

    // Header with member identity
    sections.push(`# ${member.name}`);
    sections.push(`Role: ${member.role}`);
    sections.push('');

    // Get role base prompt
    const rolePrompt = await this.getRoleBasePrompt(member.role);
    if (rolePrompt) {
      sections.push('## Role Instructions');
      sections.push('');
      sections.push(rolePrompt);
      sections.push('');
    }

    // Get skill instructions for member's skills
    // Skills come from: role's assignedSkills + member's skillOverrides - member's excludedRoleSkills
    const memberSkills = await this.getMemberSkills(member);
    if (memberSkills.length > 0) {
      sections.push('## Assigned Skills');
      sections.push('');

      for (const skillId of memberSkills) {
        const skillInstructions = await this.getSkillInstructions(skillId);
        if (skillInstructions) {
          sections.push(`### Skill: ${skillId}`);
          sections.push('');
          sections.push(skillInstructions);
          sections.push('');
        }
      }
    }

    // Add context reminder footer
    const promptPath = this.storageService.getMemberPromptPath(teamId, member.id);
    sections.push('---');
    sections.push('');
    sections.push('## Context Reminder');
    sections.push('');
    sections.push(`If you lose context about who you are, read this file: \`${promptPath}\``);
    sections.push('');

    const prompt = sections.join('\n');

    this.logger.info('Generated member prompt', {
      memberId: member.id,
      memberName: member.name,
      role: member.role,
      skillCount: memberSkills.length,
      promptLength: prompt.length,
    });

    return prompt;
  }

  /**
   * Generate and save a prompt for a team member.
   *
   * @param member - The team member
   * @param teamId - The team ID
   * @returns The generated prompt content
   */
  async generateAndSaveMemberPrompt(member: TeamMember, teamId: string): Promise<string> {
    const prompt = await this.generateMemberPrompt(member, teamId);
    await this.storageService.saveMemberPrompt(teamId, member.id, prompt);
    return prompt;
  }

  /**
   * Regenerate prompts for all members of a team.
   *
   * @param team - The team
   */
  async regenerateTeamPrompts(team: Team): Promise<void> {
    this.logger.info('Regenerating prompts for team', {
      teamId: team.id,
      teamName: team.name,
      memberCount: team.members?.length || 0,
    });

    for (const member of team.members || []) {
      await this.generateAndSaveMemberPrompt(member, team.id);
    }
  }

  /**
   * Get the effective skills for a team member.
   * Combines role's assigned skills with member's skillOverrides,
   * minus any excludedRoleSkills.
   *
   * @param member - The team member
   * @returns Array of skill IDs
   */
  async getMemberSkills(member: TeamMember): Promise<string[]> {
    const roleSkills = await this.getRoleAssignedSkills(member.role);
    const skillOverrides = member.skillOverrides || [];
    const excludedSkills = member.excludedRoleSkills || [];

    // Combine role skills and overrides, then remove excluded
    const allSkills = new Set([...roleSkills, ...skillOverrides]);
    for (const excluded of excludedSkills) {
      allSkills.delete(excluded);
    }

    return Array.from(allSkills);
  }

  /**
   * Get the assigned skills for a role from config/roles/{role}/role.json
   *
   * @param role - The role name
   * @returns Array of skill IDs assigned to the role
   */
  async getRoleAssignedSkills(role: string): Promise<string[]> {
    // Try config/roles/{role}/role.json
    const rolePath = path.join(this.configDir, 'roles', role, 'role.json');
    if (existsSync(rolePath)) {
      try {
        const content = await fs.readFile(rolePath, 'utf-8');
        const roleConfig = JSON.parse(content);
        return roleConfig.assignedSkills || [];
      } catch (error) {
        this.logger.warn('Error reading role config', { role, error });
      }
    }

    // Fallback: try user override in ~/.crewly/roles/{role}/role.json
    const userRolePath = path.join(this.crewlyHome, 'roles', role, 'role.json');
    if (existsSync(userRolePath)) {
      try {
        const content = await fs.readFile(userRolePath, 'utf-8');
        const roleConfig = JSON.parse(content);
        return roleConfig.assignedSkills || [];
      } catch (error) {
        this.logger.warn('Error reading user role config', { role, error });
      }
    }

    return [];
  }

  /**
   * Get the base prompt for a role from config/roles/{role}/prompt.md
   *
   * @param role - The role name
   * @returns The role prompt content or null if not found
   */
  async getRoleBasePrompt(role: string): Promise<string | null> {
    // Try config/roles/{role}/prompt.md
    const rolePath = path.join(this.configDir, 'roles', role, 'prompt.md');
    if (existsSync(rolePath)) {
      try {
        return await fs.readFile(rolePath, 'utf-8');
      } catch (error) {
        this.logger.warn('Error reading role prompt', { role, error });
      }
    }

    // Fallback: try user override in ~/.crewly/roles/{role}/prompt.md
    const userRolePath = path.join(this.crewlyHome, 'roles', role, 'prompt.md');
    if (existsSync(userRolePath)) {
      try {
        return await fs.readFile(userRolePath, 'utf-8');
      } catch (error) {
        this.logger.warn('Error reading user role prompt', { role, error });
      }
    }

    this.logger.debug('No role prompt found', { role });
    return null;
  }

  /**
   * Get the instructions for a skill from config/skills/{skill}/instructions.md
   *
   * @param skillId - The skill ID (can include category, e.g., "mcp/chrome-browser")
   * @returns The skill instructions content or null if not found
   */
  async getSkillInstructions(skillId: string): Promise<string | null> {
    // Try config/skills/{skillId}/instructions.md
    const skillPath = path.join(this.configDir, 'skills', skillId, 'instructions.md');
    if (existsSync(skillPath)) {
      try {
        return await fs.readFile(skillPath, 'utf-8');
      } catch (error) {
        this.logger.warn('Error reading skill instructions', { skillId, error });
      }
    }

    // Fallback: try user override in ~/.crewly/skills/{skillId}/instructions.md
    const userSkillPath = path.join(this.crewlyHome, 'skills', skillId, 'instructions.md');
    if (existsSync(userSkillPath)) {
      try {
        return await fs.readFile(userSkillPath, 'utf-8');
      } catch (error) {
        this.logger.warn('Error reading user skill instructions', { skillId, error });
      }
    }

    this.logger.debug('No skill instructions found', { skillId });
    return null;
  }

  /**
   * Build a context prefix to prepend to messages sent to agents.
   * This helps agents remember their identity when context is compressed.
   *
   * @param member - The team member
   * @param teamId - The team ID
   * @param teamName - The team name
   * @returns The context prefix string
   */
  buildContextPrefix(member: TeamMember, teamId: string, teamName: string): string {
    const promptPath = this.storageService.getMemberPromptPath(teamId, member.id);

    return `## Session Context
- **Agent:** ${member.name} (${member.role})
- **Team:** ${teamName}
- **Prompt file:** ${promptPath}
- Read this file if you need to remember your instructions.

`;
  }

  /**
   * Build a context prefix for the orchestrator.
   *
   * @returns The context prefix string
   */
  buildOrchestratorContextPrefix(): string {
    const promptPath = this.storageService.getOrchestratorPromptPath();

    return `## Session Context
- **Agent:** Crewly Orchestrator
- **Prompt file:** ${promptPath}
- Read this file if you need to remember your instructions.

`;
  }
}

// Export singleton getter
export const getPromptGeneratorService = (): PromptGeneratorService => {
  return PromptGeneratorService.getInstance();
};
