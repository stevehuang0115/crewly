/**
 * CLI Migrate Command
 *
 * Imports skills from other agent orchestration platforms (e.g. OpenClaw)
 * into Crewly format, with automatic security scanning.
 *
 * @module cli/commands/migrate
 */

import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

// ========================= Types =========================

/** Supported source platforms for migration */
export type MigrationSource = 'openclaw';

/** Options for the migrate command */
export interface MigrateOptions {
  from: MigrationSource;
  dir?: string;
  output?: string;
}

/** Security severity levels */
export type SecurityRating = 'safe' | 'warning' | 'danger';

/** A single security finding in a skill file */
export interface SecurityFinding {
  pattern: string;
  description: string;
  rating: SecurityRating;
  line: number;
  content: string;
}

/** Security scan result for a single skill */
export interface SkillScanResult {
  name: string;
  sourcePath: string;
  findings: SecurityFinding[];
  overallRating: SecurityRating;
}

/** Result of a full migration */
export interface MigrationResult {
  imported: number;
  skipped: number;
  scanResults: SkillScanResult[];
}

// ========================= Security Patterns =========================

/**
 * Dangerous patterns to scan for in imported skill files.
 * Each pattern includes a regex, description, and severity.
 */
export const SECURITY_PATTERNS: Array<{
  regex: RegExp;
  description: string;
  rating: SecurityRating;
}> = [
  {
    regex: /rm\s+-rf\s+/,
    description: 'Recursive forced deletion (rm -rf)',
    rating: 'danger',
  },
  {
    regex: /\beval\s*\(/,
    description: 'Dynamic code execution via eval()',
    rating: 'danger',
  },
  {
    regex: /\bexec\s*\(/,
    description: 'Shell command execution via exec()',
    rating: 'danger',
  },
  {
    regex: /curl\s+[^|]*\|\s*(ba)?sh/,
    description: 'Remote script execution (curl | sh)',
    rating: 'danger',
  },
  {
    regex: /wget\s+[^|]*\|\s*(ba)?sh/,
    description: 'Remote script execution (wget | sh)',
    rating: 'danger',
  },
  {
    regex: /curl\s+.*https?:\/\//,
    description: 'Network request to external host',
    rating: 'warning',
  },
  {
    regex: /wget\s+.*https?:\/\//,
    description: 'Network request via wget',
    rating: 'warning',
  },
  {
    regex: /\bchmod\s+[0-7]*7[0-7]*\s/,
    description: 'Setting world-executable permissions',
    rating: 'warning',
  },
  {
    regex: /\bsudo\s+/,
    description: 'Elevated privilege execution (sudo)',
    rating: 'danger',
  },
  {
    regex: />\s*\/dev\/sd[a-z]/,
    description: 'Direct write to block device',
    rating: 'danger',
  },
  {
    regex: /\bdd\s+.*of=\/dev\//,
    description: 'Direct disk write via dd',
    rating: 'danger',
  },
  {
    regex: /\b(process\.env|\\$[A-Z_]+).*password/i,
    description: 'Potential credential access',
    rating: 'warning',
  },
  {
    regex: /base64\s+(-d|--decode)/,
    description: 'Base64 decoding (possible obfuscation)',
    rating: 'warning',
  },
  {
    regex: /\bnc\s+-[el]/,
    description: 'Netcat listener (possible reverse shell)',
    rating: 'danger',
  },
  {
    regex: /\/etc\/passwd|\/etc\/shadow/,
    description: 'Access to system credential files',
    rating: 'danger',
  },
];

// ========================= Core Functions =========================

/**
 * Scans a single file's content for dangerous security patterns.
 *
 * @param name - Skill name for reporting
 * @param sourcePath - Original file path
 * @param content - File content to scan
 * @returns Scan result with all findings and overall rating
 */
export function scanFileContent(
  name: string,
  sourcePath: string,
  content: string,
): SkillScanResult {
  const findings: SecurityFinding[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of SECURITY_PATTERNS) {
      if (pattern.regex.test(line)) {
        findings.push({
          pattern: pattern.regex.source,
          description: pattern.description,
          rating: pattern.rating,
          line: i + 1,
          content: line.trim(),
        });
      }
    }
  }

  let overallRating: SecurityRating = 'safe';
  if (findings.some((f) => f.rating === 'danger')) {
    overallRating = 'danger';
  } else if (findings.some((f) => f.rating === 'warning')) {
    overallRating = 'warning';
  }

  return { name, sourcePath, findings, overallRating };
}

/**
 * Discovers OpenClaw skill files in the given directory.
 * Looks for a skills/ subdirectory and finds all .sh, .py, .ts, .js files.
 *
 * @param sourceDir - Root directory of the OpenClaw project
 * @returns Array of { name, filePath } for each discovered skill
 */
export function discoverOpenClawSkills(
  sourceDir: string,
): Array<{ name: string; filePath: string }> {
  const skillsDir = path.join(sourceDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    return [];
  }

  const skills: Array<{ name: string; filePath: string }> = [];
  const extensions = new Set(['.sh', '.py', '.ts', '.js', '.yaml', '.yml']);

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(skillsDir, entry.name);
    if (entry.isDirectory()) {
      // Skill directory — look for execute.* or main.*
      const subEntries = fs.readdirSync(entryPath);
      for (const sub of subEntries) {
        const ext = path.extname(sub);
        if (extensions.has(ext)) {
          skills.push({
            name: entry.name,
            filePath: path.join(entryPath, sub),
          });
        }
      }
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      // Standalone skill file
      skills.push({
        name: path.basename(entry.name, path.extname(entry.name)),
        filePath: entryPath,
      });
    }
  }

  return skills;
}

/**
 * Generates a Crewly SKILL.md metadata file for an imported skill.
 *
 * @param name - Skill name
 * @param originalSource - Original platform name
 * @returns SKILL.md content string
 */
export function generateSkillMetadata(name: string, originalSource: string): string {
  return `---
name: ${name}
description: Imported from ${originalSource}
version: 1.0.0
category: imported
skillType: claude-skill
assignableRoles:
  - developer
  - generalist
triggers:
  - ${name}
tags:
  - imported
  - ${originalSource}
execution:
  type: script
  script:
    file: execute.sh
    interpreter: bash
    timeoutMs: 30000
---

# ${name}

Skill imported from ${originalSource} via \`crewly migrate\`.

> **Note:** This skill was automatically imported. Review the security scan report before use.
`;
}

/**
 * Imports a single OpenClaw skill into Crewly format.
 *
 * @param skill - Discovered skill info
 * @param outputDir - Target directory for Crewly skills
 * @returns Scan result for the imported skill
 */
export function importSkill(
  skill: { name: string; filePath: string },
  outputDir: string,
): SkillScanResult {
  const content = fs.readFileSync(skill.filePath, 'utf-8');
  const scanResult = scanFileContent(skill.name, skill.filePath, content);

  const skillDir = path.join(outputDir, skill.name);
  fs.mkdirSync(skillDir, { recursive: true });

  // Copy the skill file as execute.sh (or preserve extension for non-sh)
  const ext = path.extname(skill.filePath);
  const targetFile = ext === '.sh' ? 'execute.sh' : `execute${ext}`;
  fs.writeFileSync(path.join(skillDir, targetFile), content, 'utf-8');

  // Generate SKILL.md metadata
  const metadata = generateSkillMetadata(skill.name, 'openclaw');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), metadata, 'utf-8');

  return scanResult;
}

/**
 * Prints the security scan report to the console.
 *
 * @param results - Array of scan results from all imported skills
 */
export function printSecurityReport(results: SkillScanResult[]): void {
  console.log(chalk.bold('\n📋 Security Scan Report'));
  console.log(chalk.gray('─'.repeat(60)));

  const ratingIcon: Record<SecurityRating, string> = {
    safe: '✅',
    warning: '⚠️',
    danger: '🚫',
  };

  const ratingColor: Record<SecurityRating, typeof chalk.green> = {
    safe: chalk.green,
    warning: chalk.yellow,
    danger: chalk.red,
  };

  for (const result of results) {
    const icon = ratingIcon[result.overallRating];
    const colorFn = ratingColor[result.overallRating];
    console.log(`\n${icon} ${chalk.bold(result.name)} — ${colorFn(result.overallRating.toUpperCase())}`);

    if (result.findings.length === 0) {
      console.log(chalk.gray('   No security issues found.'));
    } else {
      for (const finding of result.findings) {
        const fColor = ratingColor[finding.rating];
        console.log(fColor(`   Line ${finding.line}: ${finding.description}`));
        console.log(chalk.gray(`     ${finding.content}`));
      }
    }
  }

  console.log(chalk.gray('\n' + '─'.repeat(60)));

  const dangerCount = results.filter((r) => r.overallRating === 'danger').length;
  const warningCount = results.filter((r) => r.overallRating === 'warning').length;
  const safeCount = results.filter((r) => r.overallRating === 'safe').length;

  console.log(
    `Total: ${chalk.green(`${safeCount} safe`)}, ` +
    `${chalk.yellow(`${warningCount} warning`)}, ` +
    `${chalk.red(`${dangerCount} danger`)}`,
  );

  if (dangerCount > 0) {
    console.log(
      chalk.red('\n⚠ Dangerous skills were imported. Review them carefully before use.'),
    );
  }
}

// ========================= Command Entry Point =========================

/**
 * Main entry point for the `crewly migrate` command.
 * Imports skills from a source platform and runs security analysis.
 *
 * @param options - Command options including --from and optional --dir / --output
 */
export async function migrateCommand(options: MigrateOptions): Promise<void> {
  const { from, dir, output } = options;

  if (!from) {
    console.log(chalk.red('Please specify a source platform with --from.'));
    console.log(chalk.gray('Example: crewly migrate --from openclaw'));
    console.log(chalk.gray('Supported sources: openclaw'));
    process.exit(1);
  }

  const supportedSources: MigrationSource[] = ['openclaw'];
  if (!supportedSources.includes(from)) {
    console.log(chalk.red(`Unsupported source: "${from}"`));
    console.log(chalk.gray(`Supported sources: ${supportedSources.join(', ')}`));
    process.exit(1);
  }

  const sourceDir = dir || process.cwd();
  const outputDir = output || path.join(process.cwd(), 'config', 'skills', 'imported');

  console.log(chalk.blue(`\nMigrating skills from ${chalk.bold(from)}...`));
  console.log(chalk.gray(`Source:  ${sourceDir}`));
  console.log(chalk.gray(`Output:  ${outputDir}`));

  // Discover skills
  const skills = discoverOpenClawSkills(sourceDir);
  if (skills.length === 0) {
    console.log(chalk.yellow('\nNo skills found in the source directory.'));
    console.log(chalk.gray(`Expected skills/ directory at: ${path.join(sourceDir, 'skills')}`));
    process.exit(0);
  }

  console.log(chalk.blue(`\nFound ${skills.length} skill file(s). Importing...\n`));

  // Import and scan each skill
  const scanResults: SkillScanResult[] = [];
  let imported = 0;
  let failed = 0;

  for (const skill of skills) {
    try {
      const result = importSkill(skill, outputDir);
      scanResults.push(result);
      console.log(chalk.green(`  ✓ ${skill.name} (${path.basename(skill.filePath)})`));
      imported++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`  ✗ ${skill.name}: ${msg}`));
      failed++;
    }
  }

  // Print security report
  if (scanResults.length > 0) {
    printSecurityReport(scanResults);
  }

  // Summary
  console.log('');
  if (failed === 0) {
    console.log(chalk.green(`Done! ${imported} skill(s) imported to ${outputDir}`));
  } else {
    console.log(chalk.yellow(`Done! ${imported} imported, ${failed} failed.`));
  }
}
