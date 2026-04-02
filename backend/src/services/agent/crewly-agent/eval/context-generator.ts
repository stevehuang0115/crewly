/**
 * Eval Context Generator
 *
 * Generates a CONTEXT.md file and the `.crewly/` directory structure
 * that provides runtime-agnostic context for L4 eval tasks. Every
 * runtime (Crewly Agent, Claude Code, Codex CLI, Gemini CLI) receives
 * the same context package — no Crewly-specific API calls required.
 *
 * @module eval/context-generator
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A team member definition used to generate eval context.
 */
export interface EvalTeamMember {
  /** Member display name */
  name: string;
  /** Role (e.g. "Team Lead", "Developer") */
  role: string;
  /** Session identifier for skill scripts */
  sessionName: string;
  /** Whether the agent is active/inactive */
  agentStatus: 'active' | 'inactive';
  /** Current workload status */
  workingStatus: 'idle' | 'in_progress' | 'overloaded';
}

/**
 * Configuration for generating an eval context package.
 */
export interface EvalContextConfig {
  /** The agent identity (who reads CONTEXT.md) */
  agentName: string;
  /** The agent's role */
  agentRole: string;
  /** Team name */
  teamName: string;
  /** Team ID */
  teamId: string;
  /** Team members (including the agent itself) */
  members: EvalTeamMember[];
  /** Optional extra instructions appended to CONTEXT.md */
  extraInstructions?: string;
}

/**
 * Default eval team configuration used by L4 tasks.
 */
export const DEFAULT_EVAL_TEAM: EvalContextConfig = {
  agentName: 'Sam',
  agentRole: 'Team Lead',
  teamName: 'Eval Product Team',
  teamId: 'eval-team-001',
  members: [
    {
      name: 'Sam',
      role: 'Team Lead',
      sessionName: 'eval-tl-sam',
      agentStatus: 'active',
      workingStatus: 'idle',
    },
    {
      name: 'Leo',
      role: 'Developer',
      sessionName: 'eval-dev-leo',
      agentStatus: 'active',
      workingStatus: 'idle',
    },
    {
      name: 'Max',
      role: 'Developer',
      sessionName: 'eval-dev-max',
      agentStatus: 'inactive',
      workingStatus: 'idle',
    },
  ],
};

// ---------------------------------------------------------------------------
// CONTEXT.md generation
// ---------------------------------------------------------------------------

/**
 * Generate the CONTEXT.md content from a team configuration.
 *
 * The generated document tells the agent who it is, who its team members
 * are, and which bash skill scripts are available. It is intentionally
 * runtime-agnostic — any agent that can read markdown and run bash can
 * use it.
 *
 * @param config - team and agent configuration
 * @returns the full CONTEXT.md string
 */
export function generateContextMarkdown(config: EvalContextConfig): string {
  const memberRows = config.members
    .map((m) => {
      const workload = m.agentStatus === 'inactive' ? '—' : m.workingStatus;
      return `| ${m.name} | ${m.role} | ${m.sessionName} | ${m.agentStatus} | ${workload} |`;
    })
    .join('\n');

  const extraSection = config.extraInstructions
    ? `\n## Additional Instructions\n\n${config.extraInstructions}\n`
    : '';

  return `# Team Collaboration Context

## Your Identity
You are **${config.agentName}**, ${config.agentRole} of the ${config.teamName}.

## Your Team
| Name | Role | Session | Status | Workload |
|------|------|---------|--------|----------|
${memberRows}

## Available Skills
You can run these bash scripts to coordinate with your team:

- \`bash skills/delegate-task.sh '{"to":"<session>","task":"...","priority":"high"}'\`
- \`bash skills/send-message.sh '{"to":"<session>","message":"..."}'\`
- \`bash skills/get-team-status.sh '{}'\`
- \`bash skills/verify-output.sh '{"checks":[{"name":"build","command":"npm run build"}]}'\`
- \`bash skills/report-status.sh '{"status":"complete","summary":"..."}'\`
- \`bash skills/handle-failure.sh '{"worker":"<session>","error":"...","action":"reassign"}'\`

## Rules
1. Always read CONTEXT.md and relevant files before taking action.
2. Delegate to **active** workers only. Never assign work to inactive agents.
3. Use the skill scripts above for all team coordination — do not hard-code API calls.
4. Report your status via report-status when done.

## Project Layout
- Source code: \`src/\`
- Tasks: \`.crewly/tasks/\`
- Knowledge base: \`.crewly/knowledge/\`
- Team config: \`.crewly/teams/team-config.json\`
- Reports output: \`.crewly/reports/\`
- Messages output: \`.crewly/messages/\`
${extraSection}`;
}

// ---------------------------------------------------------------------------
// Team config JSON generation
// ---------------------------------------------------------------------------

/**
 * Generate the team-config.json content from a context configuration.
 *
 * @param config - team and agent configuration
 * @returns serialized JSON string for team-config.json
 */
export function generateTeamConfig(config: EvalContextConfig): string {
  const teamConfig = {
    id: config.teamId,
    name: config.teamName,
    members: config.members.map((m, idx) => ({
      id: `member-${String(idx + 1).padStart(3, '0')}`,
      name: m.name,
      role: m.role.toLowerCase().replace(/\s+/g, '-'),
      sessionName: m.sessionName,
      agentStatus: m.agentStatus,
      workingStatus: m.workingStatus,
    })),
  };
  return JSON.stringify(teamConfig, null, 2);
}

// ---------------------------------------------------------------------------
// Full workspace setup
// ---------------------------------------------------------------------------

/**
 * Set up a complete eval workspace with CONTEXT.md, skill scripts,
 * and the `.crewly/` directory structure.
 *
 * This is the main entry point for task setup functions. It creates
 * a self-contained directory that any runtime can work in.
 *
 * @param workDir - target directory to populate
 * @param config  - team/agent configuration (defaults to DEFAULT_EVAL_TEAM)
 * @param options - additional setup options
 */
export async function setupEvalWorkspace(
  workDir: string,
  config: EvalContextConfig = DEFAULT_EVAL_TEAM,
  options: SetupOptions = {},
): Promise<void> {
  // Create directory structure
  const dirs = [
    '.crewly/tasks',
    '.crewly/knowledge',
    '.crewly/teams',
    '.crewly/messages',
    '.crewly/reports',
    'skills',
    'src/services',
    'src/controllers',
    'src/utils',
  ];
  for (const d of dirs) {
    fs.mkdirSync(path.join(workDir, d), { recursive: true });
  }

  // Write CONTEXT.md
  fs.writeFileSync(
    path.join(workDir, 'CONTEXT.md'),
    generateContextMarkdown(config),
  );

  // Write team config
  fs.writeFileSync(
    path.join(workDir, '.crewly', 'teams', 'team-config.json'),
    generateTeamConfig(config),
  );

  // Copy skill shims
  copySkillShims(workDir);

  // Write default project files unless skipProjectFiles is set
  if (!options.skipProjectFiles) {
    writeDefaultProjectFiles(workDir);
  }

  // Write knowledge base files unless skipKnowledge is set
  if (!options.skipKnowledge) {
    writeDefaultKnowledge(workDir);
  }
}

/**
 * Options for workspace setup.
 */
export interface SetupOptions {
  /** Skip writing package.json, tsconfig.json, and example source files */
  skipProjectFiles?: boolean;
  /** Skip writing default knowledge base files */
  skipKnowledge?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Copy skill shim scripts from the fixtures directory to the workspace.
 *
 * @param workDir - target workspace directory
 */
function copySkillShims(workDir: string): void {
  const fixturesSkillsDir = path.join(__dirname, 'fixtures', 'skills');
  const targetSkillsDir = path.join(workDir, 'skills');

  // List of skill scripts to copy
  const scripts = [
    '_log.sh',
    'delegate-task.sh',
    'send-message.sh',
    'get-team-status.sh',
    'verify-output.sh',
    'report-status.sh',
    'handle-failure.sh',
  ];

  for (const script of scripts) {
    const src = path.join(fixturesSkillsDir, script);
    const dst = path.join(targetSkillsDir, script);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, 0o755);
    }
  }
}

/**
 * Write default project files (package.json, tsconfig.json, sample source).
 *
 * @param workDir - target workspace directory
 */
function writeDefaultProjectFiles(workDir: string): void {
  fs.writeFileSync(
    path.join(workDir, 'package.json'),
    JSON.stringify(
      {
        name: 'eval-project',
        version: '1.0.0',
        type: 'module',
        scripts: {
          build: 'tsc --noEmit',
          test: 'echo "4 passing" && exit 0',
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(workDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          outDir: './dist',
          rootDir: './src',
          declaration: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    ),
  );

  // Sample existing service for pattern reference
  fs.writeFileSync(
    path.join(workDir, 'src', 'services', 'data.service.ts'),
    `/**
 * Data service for CRUD operations.
 */
export interface DataRecord {
  id: string;
  value: string;
  createdAt: number;
}

/**
 * Create a new data record.
 *
 * @param id    - unique identifier
 * @param value - record value
 * @returns the created record
 */
export function createRecord(id: string, value: string): DataRecord {
  return { id, value, createdAt: Date.now() };
}

/**
 * Validate a data record.
 *
 * @param record - the record to validate
 * @returns true if all fields are valid
 */
export function validateRecord(record: DataRecord): boolean {
  return record.id.length > 0 && record.value.length > 0 && record.createdAt > 0;
}
`,
  );
}

/**
 * Write default knowledge base files.
 *
 * @param workDir - target workspace directory
 */
function writeDefaultKnowledge(workDir: string): void {
  fs.writeFileSync(
    path.join(workDir, '.crewly', 'knowledge', 'project-patterns.md'),
    `# Project Patterns

## Controller Pattern
All controllers should:
1. Export named functions (not classes)
2. Accept (req, res) parameters
3. Use try/catch for error handling
4. Return JSON responses

## Service Pattern
All services should:
1. Export interfaces for data types
2. Export named functions for operations
3. Include JSDoc comments on all exports
4. Use TypeScript strict types (no \`any\`)

## Naming Convention
- Controllers: kebab-case with .controller.ts suffix
- Services: kebab-case with .service.ts suffix
- Tests: co-located as .test.ts in the same directory

## Error Handling
- Always wrap async operations in try/catch
- Return structured error responses: { error: string, code: number }
- Log errors before returning them
`,
  );
}
