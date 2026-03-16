/**
 * SKILL.md Parser
 *
 * Parses SKILL.md files containing YAML frontmatter and Markdown body.
 * Used by SkillService and SkillCatalogService to load skill definitions
 * from the new SKILL.md format (replacing skill.json + instructions.md).
 *
 * @module utils/skill-md-parser
 */

import { parse as parseYAML } from 'yaml';

/**
 * Result of parsing a SKILL.md file.
 */
export interface SkillMdParseResult {
  /** Parsed YAML frontmatter as a plain object */
  frontmatter: Record<string, unknown>;
  /** Markdown body content after the frontmatter */
  body: string;
}

/**
 * Parse a SKILL.md file's content into frontmatter and body.
 *
 * Expects the format:
 * ```
 * ---
 * name: Skill Name
 * description: What it does
 * ...
 * ---
 *
 * # Markdown body here
 * ```
 *
 * @param content - Raw content of the SKILL.md file
 * @returns Parsed frontmatter object and markdown body
 * @throws Error if frontmatter delimiters are missing or YAML is invalid
 */
export function parseSkillMd(content: string): SkillMdParseResult {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith('---')) {
    throw new Error('SKILL.md missing opening frontmatter delimiter (---)');
  }

  // Find the closing --- delimiter (skip the first one)
  const closingIndex = trimmed.indexOf('\n---', 3);
  if (closingIndex === -1) {
    throw new Error('SKILL.md missing closing frontmatter delimiter (---)');
  }

  const yamlContent = trimmed.slice(4, closingIndex); // skip opening "---\n"
  const body = trimmed.slice(closingIndex + 4).trim(); // skip "\n---"

  const frontmatter = parseYAML(yamlContent) as Record<string, unknown>;

  if (!frontmatter || typeof frontmatter !== 'object') {
    throw new Error('SKILL.md frontmatter is not a valid YAML object');
  }

  return { frontmatter, body };
}
