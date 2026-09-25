/**
 * Team Template Utilities
 *
 * Loads pre-built team templates from config/templates/ so users can
 * quickly bootstrap a working multi-agent team during onboarding.
 *
 * @module cli/utils/templates
 */

import path from 'path';
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { packageRootCandidates } from './package-root.js';

// ========================= Types =========================

/** Member definition within a team template */
export interface TemplateMember {
  /** Display name for this agent (e.g. "Frontend Dev") */
  name: string;
  /** Role identifier matching a config/roles/ directory */
  role: string;
  /** System prompt that defines the agent's behavior */
  systemPrompt: string;
  /** Optional additional skill IDs beyond the role default */
  skillOverrides?: string[];
  /** Optional role skills to exclude for this member */
  excludedRoleSkills?: string[];
}

/** A pre-built team template that users can deploy instantly */
export interface TeamTemplate {
  /** Unique identifier (e.g. "web-dev-team") */
  id: string;
  /** Human-readable team name */
  name: string;
  /** Short description of the team's purpose */
  description: string;
  /** Agent definitions */
  members: TemplateMember[];
}

// ========================= Internals =========================

/**
 * Resolves the absolute path to the config/templates/ directory.
 *
 * Walks up from the CLI's real location (see `packageRootCandidates`: the
 * registered module dir, the realpath of process.argv[1], then the cwd) to find the project root
 * containing config/templates/. Falls back to process.cwd() if not found
 * (e.g. in test environments).
 *
 * @returns Absolute path to templates directory
 */
export function getTemplatesDir(): string {
  // Anchor on the CLI's real location: a global install runs through a `bin`
  // symlink (e.g. ~/.crewly/npm-global/bin/crewly), whose own directory has no
  // config/ above it — only its realpath inside the package does.
  for (const start of packageRootCandidates()) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, 'config', 'templates');
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // Fallback: relative to CWD (for development and tests)
  return path.join(process.cwd(), 'config', 'templates');
}

// ========================= Public API =========================

/**
 * Lists all available team templates.
 *
 * Reads templates from config/templates/ in both formats:
 * - New format: subdirectory/template.json with roles[] and verificationPipeline
 * - Legacy format: flat JSON files with members[] at root level
 *
 * New-format templates are converted to the CLI TeamTemplate interface
 * by mapping roles to members.
 *
 * @returns Array of team templates sorted by name
 *
 * @example
 * ```typescript
 * const templates = listTemplates();
 * templates.forEach(t => console.log(`${t.name}: ${t.description}`));
 * ```
 */
export function listTemplates(): TeamTemplate[] {
  const templatesDir = getTemplatesDir();

  let entries: string[];
  try {
    entries = readdirSync(templatesDir);
  } catch {
    return [];
  }

  const templates: TeamTemplate[] = [];
  const seenIds = new Set<string>();

  // First pass: load new-format templates from subdirectories
  for (const entry of entries) {
    const fullPath = path.join(templatesDir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        const templateJsonPath = path.join(fullPath, 'template.json');
        if (existsSync(templateJsonPath)) {
          const content = readFileSync(templateJsonPath, 'utf-8');
          const parsed = JSON.parse(content);
          // New format: has roles[] array and verificationPipeline
          if (parsed.id && parsed.name && Array.isArray(parsed.roles) && parsed.roles.length > 0) {
            const converted = convertNewFormatTemplate(parsed);
            if (converted) {
              templates.push(converted);
              seenIds.add(converted.id);
            }
          }
        }
      }
    } catch {
      // Skip invalid directories
    }
  }

  // Second pass: load legacy flat JSON templates (skip if ID already seen)
  const jsonFiles = entries.filter(f => f.endsWith('.json') && !f.startsWith('.'));
  for (const file of jsonFiles) {
    try {
      const content = readFileSync(path.join(templatesDir, file), 'utf-8');
      const parsed = JSON.parse(content) as TeamTemplate;
      if (parsed.id && parsed.name && Array.isArray(parsed.members) && !seenIds.has(parsed.id)) {
        templates.push(parsed);
        seenIds.add(parsed.id);
      }
    } catch {
      // Skip malformed template files
    }
  }

  return templates.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Converts a new-format template (with roles[]) to CLI TeamTemplate (with members[]).
 *
 * Maps each role to one or more TemplateMember entries based on the role's count.
 *
 * @param data - Raw parsed template.json data
 * @returns Converted TeamTemplate, or null if conversion fails
 */
function convertNewFormatTemplate(data: Record<string, unknown>): TeamTemplate | null {
  try {
    const roles = data.roles as Array<{
      role: string;
      label: string;
      defaultName: string;
      count: number;
      defaultSkills?: string[];
      excludedSkills?: string[];
      promptAdditions?: string;
    }>;

    const members: TemplateMember[] = [];
    for (const role of roles) {
      for (let i = 0; i < (role.count || 1); i++) {
        const suffix = role.count > 1 ? ` ${i + 1}` : '';
        members.push({
          name: `${role.defaultName}${suffix}`,
          role: role.role,
          systemPrompt: role.promptAdditions ?? `You are a ${role.label}.`,
          skillOverrides: role.defaultSkills,
          excludedRoleSkills: role.excludedSkills,
        });
      }
    }

    return {
      id: data.id as string,
      name: data.name as string,
      description: (data.description as string) ?? '',
      members,
    };
  } catch {
    return null;
  }
}

/**
 * Gets a specific team template by ID.
 *
 * @param id - The template identifier (e.g. "web-dev-team")
 * @returns The matching template, or undefined if not found
 *
 * @example
 * ```typescript
 * const template = getTemplate('startup-team');
 * if (template) {
 *   console.log(`Found: ${template.name} with ${template.members.length} members`);
 * }
 * ```
 */
export function getTemplate(id: string): TeamTemplate | undefined {
  return listTemplates().find(t => t.id === id);
}
