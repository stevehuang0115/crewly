/**
 * Project Scaffolding Utilities
 *
 * Detects project type, generates project-specific team.json and goals.md,
 * and provides preset team templates for common verticals (Dev Team,
 * Content Agency, Support Team).
 *
 * Used by `crewly init` to create a fully configured .crewly/ directory
 * tailored to the user's project.
 *
 * @module cli/utils/project-scaffold
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';

// ========================= Types =========================

/** Detected project type */
export type ProjectType = 'node' | 'python' | 'generic';

/** Result of project type detection */
export interface ProjectDetection {
  /** The detected project type */
  type: ProjectType;
  /** Human-readable label for the project type */
  label: string;
  /** Name of the project (from package.json, setup.py, or directory name) */
  projectName: string;
  /** Signals that helped identify the project type */
  signals: string[];
}

/** A preset team configuration for a specific vertical */
export interface PresetTeam {
  /** Unique preset identifier */
  id: string;
  /** Human-readable name shown during selection */
  name: string;
  /** Short description of the team's purpose */
  description: string;
  /** Agent definitions */
  members: PresetMember[];
  /** Suggested goals for this team type */
  suggestedGoals: string[];
}

/** A member within a preset team */
export interface PresetMember {
  /** Display name */
  name: string;
  /** Role identifier matching config/roles/ */
  role: string;
  /** System prompt */
  systemPrompt: string;
}

// ========================= Project Detection =========================

/**
 * Detects the project type by examining files in the given directory.
 *
 * Checks for common project markers:
 * - Node.js: package.json, tsconfig.json, node_modules/
 * - Python: requirements.txt, setup.py, pyproject.toml, Pipfile
 * - Generic: everything else
 *
 * @param projectDir - The directory to inspect (defaults to cwd)
 * @returns Detection result with type, label, project name, and signals
 */
export function detectProjectType(projectDir: string = process.cwd()): ProjectDetection {
  const signals: string[] = [];
  let projectName = basename(projectDir);

  // Check Node.js signals
  const hasPackageJson = existsSync(join(projectDir, 'package.json'));
  const hasTsconfig = existsSync(join(projectDir, 'tsconfig.json'));
  const hasNodeModules = existsSync(join(projectDir, 'node_modules'));
  const hasYarnLock = existsSync(join(projectDir, 'yarn.lock'));
  const hasPnpmLock = existsSync(join(projectDir, 'pnpm-lock.yaml'));
  const hasPackageLock = existsSync(join(projectDir, 'package-lock.json'));

  if (hasPackageJson) signals.push('package.json');
  if (hasTsconfig) signals.push('tsconfig.json');
  if (hasNodeModules) signals.push('node_modules/');
  if (hasYarnLock) signals.push('yarn.lock');
  if (hasPnpmLock) signals.push('pnpm-lock.yaml');
  if (hasPackageLock) signals.push('package-lock.json');

  // Check Python signals
  const hasRequirements = existsSync(join(projectDir, 'requirements.txt'));
  const hasSetupPy = existsSync(join(projectDir, 'setup.py'));
  const hasPyproject = existsSync(join(projectDir, 'pyproject.toml'));
  const hasPipfile = existsSync(join(projectDir, 'Pipfile'));
  const hasSetupCfg = existsSync(join(projectDir, 'setup.cfg'));

  if (hasRequirements) signals.push('requirements.txt');
  if (hasSetupPy) signals.push('setup.py');
  if (hasPyproject) signals.push('pyproject.toml');
  if (hasPipfile) signals.push('Pipfile');
  if (hasSetupCfg) signals.push('setup.cfg');

  // Try to extract project name from config files
  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
      if (pkg.name && typeof pkg.name === 'string') {
        projectName = pkg.name;
      }
    } catch {
      // Fall through to directory name
    }
  } else if (hasSetupPy) {
    try {
      const content = readFileSync(join(projectDir, 'setup.py'), 'utf-8');
      const match = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
      if (match) {
        projectName = match[1];
      }
    } catch {
      // Fall through to directory name
    }
  } else if (hasPyproject) {
    try {
      const content = readFileSync(join(projectDir, 'pyproject.toml'), 'utf-8');
      const match = content.match(/name\s*=\s*"([^"]+)"/);
      if (match) {
        projectName = match[1];
      }
    } catch {
      // Fall through to directory name
    }
  }

  // Determine type based on signal count
  const nodeSignals = [hasPackageJson, hasTsconfig, hasNodeModules, hasYarnLock, hasPnpmLock, hasPackageLock].filter(Boolean).length;
  const pythonSignals = [hasRequirements, hasSetupPy, hasPyproject, hasPipfile, hasSetupCfg].filter(Boolean).length;

  if (nodeSignals > pythonSignals && nodeSignals > 0) {
    return { type: 'node', label: 'Node.js / TypeScript', projectName, signals };
  }

  if (pythonSignals > 0) {
    return { type: 'python', label: 'Python', projectName, signals };
  }

  return { type: 'generic', label: 'General', projectName, signals };
}

// ========================= Preset Teams =========================

/** Dev Team preset — optimized for software development projects */
const DEV_TEAM_PRESET: PresetTeam = {
  id: 'dev-team',
  name: 'Dev Team',
  description: 'Developer + Code Reviewer + QA for building and shipping software. Ideal for Node.js, Python, or any codebase.',
  members: [
    {
      name: 'Developer',
      role: 'developer',
      systemPrompt: 'You are the lead developer. Implement features, fix bugs, and write clean, tested code. Follow project conventions and maintain high code quality. Coordinate with the reviewer for code reviews and QA for testing.',
    },
    {
      name: 'Code Reviewer',
      role: 'developer',
      systemPrompt: 'You are the code reviewer. Review all code changes for correctness, performance, security, and adherence to project standards. Provide constructive feedback and approve changes when they meet quality bar. Help maintain consistent architecture.',
    },
    {
      name: 'QA Engineer',
      role: 'qa',
      systemPrompt: 'You are the QA engineer. Write and run tests, identify edge cases, and verify features work as expected. Report bugs with clear reproduction steps. Maintain test coverage and help improve the testing strategy.',
    },
  ],
  suggestedGoals: [
    'Ship features with high code quality and test coverage',
    'Maintain clean architecture and follow project conventions',
    'Catch and fix bugs before they reach production',
  ],
};

/** Content Agency preset — optimized for content creation and marketing */
const CONTENT_AGENCY_PRESET: PresetTeam = {
  id: 'content-agency',
  name: 'Content Agency',
  description: 'Content Strategist + Writer + Editor for producing blog posts, social media content, and marketing materials.',
  members: [
    {
      name: 'Content Strategist',
      role: 'content-strategist',
      systemPrompt: 'You are the content strategist. Research topics, identify keywords, and create content briefs. Define the content calendar and quality standards. Review all output before publication.',
    },
    {
      name: 'Writer',
      role: 'generalist',
      systemPrompt: 'You are the writer. Take content briefs and produce full-length blog posts, social media copy, and marketing materials. Focus on engaging, accurate, on-brand content that follows the brief guidelines.',
    },
    {
      name: 'Editor',
      role: 'qa',
      systemPrompt: 'You are the editor. Review all content for accuracy, tone consistency, SEO compliance, and brand voice. Approve content for publication or return with specific revision notes.',
    },
  ],
  suggestedGoals: [
    'Produce consistent, high-quality content on schedule',
    'Build audience engagement and grow traffic',
    'Maintain brand voice across all channels',
  ],
};

/** Support Team preset — optimized for customer support and documentation */
const SUPPORT_TEAM_PRESET: PresetTeam = {
  id: 'support-team',
  name: 'Support Team',
  description: 'Support Lead + Technical Writer + Triage Agent for handling customer inquiries, writing docs, and managing issues.',
  members: [
    {
      name: 'Support Lead',
      role: 'support',
      systemPrompt: 'You are the support lead. Manage incoming support requests, prioritize issues, and coordinate the team response. Escalate technical issues to the appropriate team. Track resolution times and customer satisfaction.',
    },
    {
      name: 'Technical Writer',
      role: 'generalist',
      systemPrompt: 'You are the technical writer. Create and maintain documentation, FAQs, troubleshooting guides, and knowledge base articles. Turn common support questions into self-service resources to reduce ticket volume.',
    },
    {
      name: 'Triage Agent',
      role: 'generalist',
      systemPrompt: 'You are the triage agent. Categorize and prioritize incoming issues. Gather reproduction steps and relevant context. Route issues to the right team member. Handle simple requests directly when possible.',
    },
  ],
  suggestedGoals: [
    'Respond to all inquiries within 24 hours',
    'Build comprehensive documentation and FAQs',
    'Reduce repeat questions through better self-service resources',
  ],
};

/** All available preset teams */
export const PRESET_TEAMS: PresetTeam[] = [
  DEV_TEAM_PRESET,
  CONTENT_AGENCY_PRESET,
  SUPPORT_TEAM_PRESET,
];

/**
 * Gets a preset team by ID.
 *
 * @param id - The preset identifier (e.g. "dev-team")
 * @returns The matching preset, or undefined if not found
 */
export function getPresetTeam(id: string): PresetTeam | undefined {
  return PRESET_TEAMS.find(p => p.id === id);
}

// ========================= Scaffolding =========================

/**
 * Generates a goals.md file content based on the project name, type, and selected team.
 *
 * @param projectName - The project's name
 * @param projectType - The detected project type
 * @param preset - The selected preset team (optional)
 * @returns The goals.md content as a string
 */
export function generateGoalsContent(
  projectName: string,
  projectType: ProjectType,
  preset?: PresetTeam,
): string {
  const lines: string[] = [
    `# ${projectName} - Project Goals`,
    '',
    `> Generated by \`crewly init\` on ${new Date().toISOString().split('T')[0]}`,
    `> Project type: ${projectType}`,
    '',
  ];

  if (preset) {
    lines.push(`## Team: ${preset.name}`);
    lines.push('');
    lines.push('### Goals');
    lines.push('');
    for (const goal of preset.suggestedGoals) {
      lines.push(`- [ ] ${goal}`);
    }
    lines.push('');
  }

  lines.push('## Milestones');
  lines.push('');
  lines.push('### Phase 1: Setup');
  lines.push('- [ ] Configure team and project settings');
  lines.push('- [ ] Define initial task backlog');
  lines.push('- [ ] Establish working conventions');
  lines.push('');
  lines.push('### Phase 2: Execution');
  lines.push('- [ ] Complete first deliverable');
  lines.push('- [ ] Review and iterate');
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('Add project-specific notes, decisions, and context here.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generates a team.json object for the .crewly/ directory from a preset team.
 *
 * Creates full member objects with UUIDs, session names, and status fields.
 *
 * @param preset - The preset team to generate from
 * @param projectName - The project name for session name generation
 * @returns The team config object ready to be serialized to JSON
 */
export function generateTeamConfig(
  preset: PresetTeam,
  projectName: string,
  runtimeType: string = 'claude-code',
): Record<string, unknown> {
  const now = new Date().toISOString();
  const safeProjectName = projectName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

  const members = preset.members.map((m) => {
    const memberId = randomUUID().split('-')[0];
    const safeName = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const sessionName = `${safeProjectName}-${safeName}-${memberId}`;
    return {
      id: randomUUID(),
      name: m.name,
      role: m.role,
      sessionName,
      systemPrompt: m.systemPrompt,
      runtimeType,
      agentStatus: 'inactive',
      workingStatus: 'idle',
      skillOverrides: [],
      excludedRoleSkills: [],
      createdAt: now,
      updatedAt: now,
    };
  });

  return {
    id: `${safeProjectName}-${preset.id}`,
    name: `${projectName} ${preset.name}`,
    description: preset.description,
    members,
    projectIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Writes the enhanced project scaffold to the .crewly/ directory.
 *
 * Creates:
 * - .crewly/team.json — project-specific team configuration
 * - .crewly/goals.md — project goals and milestones
 * - .crewly/docs/, memory/, tasks/ directories
 * - .crewly/config.env — environment configuration stub
 *
 * Skips files that already exist to avoid overwriting user changes.
 *
 * @param projectDir - The project root directory
 * @param preset - The selected preset team
 * @param detection - The project detection result
 * @returns Object indicating which files were created
 */
export function writeProjectScaffold(
  projectDir: string,
  preset: PresetTeam,
  detection: ProjectDetection,
): { teamJsonCreated: boolean; goalsCreated: boolean; dirsCreated: boolean } {
  const crewlyDir = join(projectDir, '.crewly');
  let teamJsonCreated = false;
  let goalsCreated = false;
  let dirsCreated = false;

  // Create directory structure
  const subdirs = ['docs', 'memory', 'tasks', 'teams'];
  for (const subdir of subdirs) {
    mkdirSync(join(crewlyDir, subdir), { recursive: true });
  }
  dirsCreated = true;

  // Write config.env if not present
  const configEnvPath = join(crewlyDir, 'config.env');
  if (!existsSync(configEnvPath)) {
    writeFileSync(configEnvPath, '# Crewly configuration\n# Add API keys and settings here\n');
  }

  // Write team.json if not present
  const teamJsonPath = join(crewlyDir, 'team.json');
  if (!existsSync(teamJsonPath)) {
    const teamConfig = generateTeamConfig(preset, detection.projectName);
    writeFileSync(teamJsonPath, JSON.stringify(teamConfig, null, 2) + '\n');
    teamJsonCreated = true;
  }

  // Write goals.md if not present
  const goalsPath = join(crewlyDir, 'goals.md');
  if (!existsSync(goalsPath)) {
    const goalsContent = generateGoalsContent(detection.projectName, detection.type, preset);
    writeFileSync(goalsPath, goalsContent);
    goalsCreated = true;
  }

  return { teamJsonCreated, goalsCreated, dirsCreated };
}
