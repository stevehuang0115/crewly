/**
 * Template Service
 *
 * Loads, lists, and applies team templates from config/templates/.
 * Supports both the new TeamTemplate format (with verificationPipeline)
 * and legacy flat JSON format (backward compatible).
 *
 * @module services/template/template
 */

import { readFileSync, readdirSync, existsSync, statSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { LoggerService } from '../core/logger.service.js';
import { randomUUID } from 'crypto';
import type { TeamTemplate, TemplateRole } from '../../types/team-template.types.js';
import { isValidTeamTemplate } from '../../types/team-template.types.js';
import type { TeamMember, Team, TeamMemberRole } from '../../types/index.js';
import { SkillTierService, type SkillTierInfo } from '../skill/skill-tier.service.js';
import { type CloudTier, CLOUD_CONSTANTS } from '../../constants.js';

// =============================================================================
// Constants
// =============================================================================

const logger = LoggerService.getInstance().createComponentLogger('TemplateService');

/** Default path to templates directory */
const DEFAULT_TEMPLATES_DIR = resolve(process.cwd(), 'config/templates');

// =============================================================================
// Types
// =============================================================================

/** Result of creating a team from a template */
export interface CreateFromTemplateResult {
  /** The created team */
  team: Team;
  /** Template ID used */
  templateId: string;
  /** Number of members created */
  memberCount: number;
}

/** Template source — local disk */
export type TemplateSource = 'local';

/** Minimal template summary for listing */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  hierarchical: boolean;
  roleCount: number;
  version: string;
  tags?: string[];
  icon?: string;
  /** Where this template was loaded from */
  source: TemplateSource;
  /** Minimum tier required to use this template */
  requiredTier?: CloudTier;
}

// =============================================================================
// Service
// =============================================================================

/**
 * TemplateService manages team templates.
 * Loads templates from config/templates/ directory, provides
 * listing/querying, and creates teams from templates.
 *
 * Singleton pattern matching other Crewly services.
 */
export class TemplateService {
  private static instance: TemplateService | null = null;

  /** Loaded templates indexed by ID */
  private templates: Map<string, TeamTemplate> = new Map();

  /** Templates directory path */
  private templatesDir: string;

  /** Whether templates have been loaded */
  private loaded: boolean = false;

  private constructor(templatesDir?: string) {
    this.templatesDir = templatesDir ?? DEFAULT_TEMPLATES_DIR;
  }

  /**
   * Get the singleton instance.
   *
   * @param templatesDir - Optional override for templates directory
   * @returns The singleton instance
   */
  static getInstance(templatesDir?: string): TemplateService {
    if (!TemplateService.instance) {
      TemplateService.instance = new TemplateService(templatesDir);
    }
    return TemplateService.instance;
  }

  /**
   * Clear the singleton instance (for testing).
   */
  static clearInstance(): void {
    TemplateService.instance = null;
  }

  /**
   * Load all templates from the templates directory.
   * Scans for template.json files in subdirectories and
   * legacy flat JSON files at the root level.
   *
   * @returns Number of templates loaded
   */
  loadTemplates(): number {
    this.templates.clear();

    if (!existsSync(this.templatesDir)) {
      this.loaded = true;
      return 0;
    }

    const entries = readdirSync(this.templatesDir);

    for (const entry of entries) {
      const fullPath = join(this.templatesDir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        // Check for template.json in subdirectory (new format)
        const templateJsonPath = join(fullPath, 'template.json');
        if (existsSync(templateJsonPath)) {
          this.loadTemplateFile(templateJsonPath, entry);
        }
      } else if (entry.endsWith('.json') && !entry.startsWith('.')) {
        // Legacy flat JSON at root level
        this.loadLegacyTemplate(fullPath, entry);
      }
    }

    this.loaded = true;
    return this.templates.size;
  }

  /**
   * List local templates as summaries.
   *
   * @returns Array of local template summaries
   */
  listTemplates(): TemplateSummary[] {
    if (!this.loaded) this.loadTemplates();

    return Array.from(this.templates.values()).map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      hierarchical: t.hierarchical,
      roleCount: t.roles.length,
      version: t.version,
      tags: t.tags,
      icon: t.icon,
      source: 'local' as TemplateSource,
      requiredTier: t.requiredTier as CloudTier | undefined,
    }));
  }


  /**
   * Get a specific template by ID.
   *
   * @param id - Template ID
   * @returns The template, or null if not found
   */
  getTemplate(id: string): TeamTemplate | null {
    if (!this.loaded) this.loadTemplates();
    return this.templates.get(id) ?? null;
  }

  /**
   * Create a team from a template.
   * Generates TeamMember objects with IDs, session names,
   * and hierarchy fields based on the template's role definitions.
   *
   * @param templateId - ID of the template to use
   * @param teamName - Name for the new team
   * @param nameOverrides - Optional map of role to custom name
   * @returns The created team result, or null if template not found
   */
  createTeamFromTemplate(
    templateId: string,
    teamName: string,
    nameOverrides?: Record<string, string>,
    userTier?: CloudTier
  ): CreateFromTemplateResult | null {
    const template = this.getTemplate(templateId);
    if (!template) return null;

    // Check if user's tier is sufficient for this template
    const effectiveTier = userTier || (CLOUD_CONSTANTS.TIERS.FREE as CloudTier);
    if (template.requiredTier) {
      const tierService = SkillTierService.getInstance();
      if (!tierService.isTierSufficient(effectiveTier, template.requiredTier as CloudTier)) {
        throw new Error(
          `Template "${template.name}" requires ${template.requiredTier} plan. ` +
          `Current plan: ${effectiveTier}. Upgrade at https://crewlyai.com/pricing`
        );
      }
    }

    const members: TeamMember[] = [];
    const memberIdsByRole = new Map<string, string[]>();

    // Resolve skills with tier-based graceful degradation
    const tierService = SkillTierService.getInstance();

    // First pass: create all members
    for (const role of template.roles) {
      const roleMembers: string[] = [];

      // Apply skill tier filtering for this role
      let resolvedSkills = role.defaultSkills;
      if (role.defaultSkills.length > 0) {
        const skillInfos: SkillTierInfo[] = role.defaultSkills.map(id => ({
          id,
          // Skills without requiredTier are free by default
        }));
        const resolution = tierService.resolveSkills(skillInfos, effectiveTier);
        resolvedSkills = resolution.skills.map(s => s.id);

        if (resolution.degraded.length > 0) {
          logger.info('Skills degraded for role due to tier', {
            templateId,
            role: role.role,
            userTier: effectiveTier,
            degraded: resolution.degraded.map(d => d.original),
          });
        }
      }

      for (let i = 0; i < role.count; i++) {
        const memberId = randomUUID();
        const suffix = role.count > 1 ? `${i + 1}` : '';
        const name = nameOverrides?.[role.role]
          ?? `${role.defaultName}${suffix}`;

        const member: TeamMember = {
          id: memberId,
          name,
          sessionName: '',
          role: role.role as TeamMemberRole,
          systemPrompt: role.promptAdditions ?? '',
          agentStatus: 'inactive',
          workingStatus: 'idle',
          runtimeType: role.runtimeOverride ?? template.defaultRuntime,
          hierarchyLevel: role.hierarchyLevel,
          canDelegate: role.canDelegate,
          skillOverrides: resolvedSkills.length > 0 ? resolvedSkills : undefined,
          excludedRoleSkills: role.excludedSkills,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          // Organization Model fields from template role
          jobTitle: role.jobTitle,
          jobDescription: role.jobDescription,
          ownershipScope: role.ownershipScope,
          responsibilityType: role.responsibilityType,
          autonomyLevel: role.autonomyLevel,
        };

        members.push(member);
        roleMembers.push(memberId);
      }

      memberIdsByRole.set(role.role, roleMembers);
    }

    // Second pass: wire up hierarchy (parentMemberId, subordinateIds)
    for (const role of template.roles) {
      const currentIds = memberIdsByRole.get(role.role) ?? [];
      if (role.reportsTo) {
        const parentIds = memberIdsByRole.get(role.reportsTo) ?? [];
        if (parentIds.length > 0) {
          const parentId = parentIds[0]; // Each child reports to first member of parent role
          for (const childId of currentIds) {
            const child = members.find(m => m.id === childId);
            if (child) child.parentMemberId = parentId;
          }
          // Update parent's subordinateIds
          const parent = members.find(m => m.id === parentId);
          if (parent) {
            parent.subordinateIds = [...(parent.subordinateIds ?? []), ...currentIds];
          }
        }
      }
    }

    // Find leader ID
    const leaderRole = template.roles.find(r => r.canDelegate && r.hierarchyLevel === 1);
    const leaderIds = leaderRole ? memberIdsByRole.get(leaderRole.role) : undefined;
    const leaderId = leaderIds?.[0];

    const team: Team = {
      id: randomUUID(),
      name: teamName,
      description: template.description,
      members,
      projectIds: [],
      hierarchical: template.hierarchical,
      leaderId,
      templateId: template.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Organization Model fields from template
      mission: template.mission,
      ownershipScope: template.ownershipScope,
      serviceContract: template.serviceContract,
    };

    // Copy norms from template to team directory
    this.copyTeamNorms(template.id, team.id);

    return {
      team,
      templateId: template.id,
      memberCount: members.length,
    };
  }

  /**
   * Copy norms files from a template to the team's norms directory.
   *
   * Copies config/templates/{templateId}/norms/*.md to ~/.crewly/teams/{teamId}/norms/.
   * Also copies the norms config from template.json into the team's config.json.
   *
   * @param templateId - Source template ID
   * @param teamId - Target team ID
   */
  private copyTeamNorms(templateId: string, teamId: string): void {
    try {
      const normsSourceDir = join(this.templatesDir, templateId, 'norms');
      if (!existsSync(normsSourceDir)) return;

      const normsFiles = readdirSync(normsSourceDir).filter(f => f.endsWith('.md'));
      if (normsFiles.length === 0) return;

      const crewlyHome = join(homedir(), '.crewly');
      const normsTargetDir = join(crewlyHome, 'teams', teamId, 'norms');
      mkdirSync(normsTargetDir, { recursive: true });

      for (const file of normsFiles) {
        copyFileSync(join(normsSourceDir, file), join(normsTargetDir, file));
      }

      // Copy norms config from template.json into team config
      const template = this.getTemplate(templateId);
      if (template) {
        const teamConfigPath = join(crewlyHome, 'teams', teamId, 'config.json');
        if (existsSync(teamConfigPath)) {
          try {
            const config = JSON.parse(readFileSync(teamConfigPath, 'utf-8'));
            const templateJson = this.loadTemplateJson(templateId);
            if (templateJson?.norms) {
              config.norms = templateJson.norms;
              writeFileSync(teamConfigPath, JSON.stringify(config, null, 2));
            }
          } catch {
            // Best-effort — config update failure doesn't block team creation
          }
        }
      }

      logger.info('Copied team norms from template', {
        templateId,
        teamId,
        normsCount: normsFiles.length,
        files: normsFiles,
      });
    } catch (err) {
      logger.warn('Failed to copy team norms (non-fatal)', {
        templateId,
        teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Load the raw template.json for a template (including norms config).
   *
   * @param templateId - Template ID
   * @returns Parsed template.json or null
   */
  private loadTemplateJson(templateId: string): Record<string, unknown> | null {
    try {
      const jsonPath = join(this.templatesDir, templateId, 'template.json');
      if (!existsSync(jsonPath)) return null;
      return JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Get the number of loaded templates.
   *
   * @returns Template count
   */
  getTemplateCount(): number {
    return this.templates.size;
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * Load a new-format template.json file.
   *
   * @param filePath - Absolute path to the template.json file
   * @param dirName - Directory name containing the template
   */
  private loadTemplateFile(filePath: string, dirName: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Check if it's already the new format (has verificationPipeline)
      if (isValidTeamTemplate(data)) {
        this.templates.set(data.id, data);
        return;
      }

      // It might be an education-smb/insurance-smb style template.json (metadata only)
      // These don't have roles/verificationPipeline, skip them
    } catch (error) {
      logger.warn('Skipped invalid template file', { dirName, filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Load a legacy flat JSON template (e.g., web-dev-team.json).
   * Converts to TeamTemplate format with sensible defaults.
   *
   * @param filePath - Absolute path to the JSON file
   * @param fileName - File name of the template
   */
  private loadLegacyTemplate(filePath: string, fileName: string): void {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Legacy format has id, name, description, members[]
      if (!data.name || !Array.isArray(data.members)) return;

      const id = data.id ?? fileName.replace('.json', '');
      const roles: TemplateRole[] = data.members.map((m: { name: string; role: string; systemPrompt?: string }, i: number) => ({
        role: m.role ?? 'developer',
        label: m.name ?? `Member ${i + 1}`,
        defaultName: m.name ?? `Member ${i + 1}`,
        count: 1,
        hierarchyLevel: 2,
        canDelegate: false,
        defaultSkills: [],
        promptAdditions: m.systemPrompt,
      }));

      const template: TeamTemplate = {
        id,
        name: data.name,
        description: data.description ?? '',
        category: 'custom',
        version: '0.1.0',
        hierarchical: false,
        roles,
        defaultRuntime: 'claude-code',
        verificationPipeline: {
          name: 'Manual Review',
          steps: [{
            id: 'manual',
            name: 'Manual Review',
            description: 'Team leader reviews output manually',
            method: 'manual_review',
            critical: true,
            config: {},
          }],
          passPolicy: 'all',
          maxRetries: 1,
        },
      };

      this.templates.set(id, template);
    } catch (error) {
      logger.warn('Skipped invalid legacy template', { fileName, filePath, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
