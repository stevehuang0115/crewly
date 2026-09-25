/**
 * CLI Onboard Command
 *
 * Interactive setup wizard that walks new users through configuring Crewly.
 * Detects AI providers, installs missing tools, and installs agent skills
 * from the marketplace.
 *
 * Used directly via `crewly onboard`, by the curl install script, and
 * by the Electron desktop app.
 *
 * Supports non-interactive mode via `--yes` flag and direct template
 * selection via `--template <id>`.
 *
 * @module cli/commands/onboard
 */

import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import {
  checkSkillsInstalled,
  installAllSkills,
  countBundledSkills,
} from '../utils/marketplace.js';
import {
  listTemplates,
  getTemplate,
  getTemplatesDir,
  type TeamTemplate,
} from '../utils/templates.js';
import { CLI_CONSTANTS, CREWLY_HOME_DIR, CREWLY_CONSTANTS } from '../constants.js';

/** Process exit codes used by the wizard. */
const CLI_EXIT_CODES = CLI_CONSTANTS.EXIT_CODES;

/** Provider choice returned by the selection step */
export type ProviderChoice = 'claude' | 'gemini' | 'codex' | 'opencode' | 'both' | 'skip';

/** Options passed from Commander.js for the onboard command */
export interface OnboardOptions {
  /** Skip all interactive prompts and use defaults */
  yes?: boolean;
  /** Select a team template by ID (e.g. "web-dev-team") */
  template?: string;
}

// ========================= Banner =========================

/**
 * Prints the Crewly ASCII art banner to stdout.
 */
export function printBanner(): void {
  console.log(chalk.cyan(`
   ____                    _
  / ___|_ __ _____      _| |_   _
 | |   | '__/ _ \\ \\ /\\ / / | | | |
 | |___| | |  __/\\ V  V /| | |_| |
  \\____|_|  \\___| \\_/\\_/ |_|\\__, |
                              |___/
`));
  console.log(chalk.bold('  Welcome to Crewly! Let\'s get you set up.\n'));
}

// ========================= Readline helpers =========================

/**
 * Creates a readline interface attached to stdin/stdout.
 *
 * @returns A readline interface
 */
export function createReadlineInterface(): ReadlineInterface {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

/**
 * Thrown when the wizard's input closes before a question was answered
 * (EOF, e.g. stdin is an exhausted pipe or the user pressed Ctrl+D).
 *
 * Without this, a closed input left the pending question unresolved, the
 * event loop drained and the process exited 0 with nothing set up (#772).
 */
export class WizardInputClosedError extends Error {
  constructor() {
    super('The setup wizard\'s input closed before the question was answered');
    this.name = 'WizardInputClosedError';
  }
}

/**
 * Prompts the user with a question and returns their answer.
 *
 * @param rl - Readline interface
 * @param question - The prompt text
 * @returns The user's response string
 * @throws {WizardInputClosedError} When the input closes before an answer arrives
 */
function ask(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = (): void => reject(new WizardInputClosedError());
    rl.on('close', onClose);
    rl.question(question, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer.trim());
    });
  });
}

/**
 * Whether the wizard can prompt: stdin must be a terminal.
 *
 * `curl ... | bash` hands the wizard the script's pipe as stdin, so every
 * prompt would read EOF (#772). The installer redirects from /dev/tty when a
 * terminal exists; otherwise the wizard must refuse instead of "finishing".
 *
 * @param stdin - Input stream to check (defaults to process.stdin)
 * @returns True when stdin is a TTY
 */
export function isInteractiveInput(stdin: { isTTY?: boolean } = process.stdin): boolean {
  return stdin.isTTY === true;
}

/**
 * Explain that the wizard cannot run without a terminal and name the exact
 * command to run next. Sets a non-zero exit code; never reports success.
 *
 * @param reason - What went wrong (printed first)
 * @param startedSetup - True when the input closed mid-wizard (some steps may have run)
 */
export function reportNonInteractiveInput(reason: string, startedSetup = false): void {
  console.log(chalk.red(`  ✖ ${reason}`));
  if (startedSetup) {
    console.log(chalk.yellow('    Setup did not finish.\n'));
  } else {
    console.log(chalk.yellow('    Nothing was set up. This happens when the wizard\'s input is a pipe or a file,'));
    console.log(chalk.yellow('    for example `curl -fsSL https://crewlyai.com/install.sh | bash` without a terminal.\n'));
  }
  console.log('    Run the wizard from a terminal:');
  console.log(chalk.cyan('      crewly onboard\n'));
  console.log('    Or set up with the defaults, no prompts (CI, scripts):');
  console.log(chalk.cyan('      crewly init --yes\n'));
  process.exitCode = CLI_EXIT_CODES.ERROR;
}

// ========================= Step 1: Provider selection =========================

/**
 * Asks the user which AI coding assistant they use.
 *
 * Displays a numbered menu and returns the user's choice.
 *
 * @param rl - Readline interface
 * @returns The selected provider choice
 */
export async function selectProvider(rl: ReadlineInterface): Promise<ProviderChoice> {
  console.log(chalk.bold('  Step 1/5: AI Provider'));
  console.log('  Which AI coding assistant do you use?\n');
  console.log('    1. Claude Code (Anthropic) ' + chalk.green('(recommended)'));
  console.log(chalk.gray('       Best code quality, strong reasoning'));
  console.log('    2. Gemini CLI (Google)');
  console.log(chalk.gray('       Free tier available, fast responses'));
  console.log('    3. Codex CLI (OpenAI)');
  console.log(chalk.gray('       GPT-powered coding assistant'));
  console.log('    4. OpenCode (open source)');
  console.log(chalk.gray('       Bring any provider/model; install: npm install -g opencode-ai, then opencode auth login'));
  console.log('    5. All providers');
  console.log('    6. Skip\n');

  const choices: Record<string, ProviderChoice> = {
    '1': 'claude',
    '2': 'gemini',
    '3': 'codex',
    '4': 'opencode',
    '5': 'both',
    '6': 'skip',
  };

  while (true) {
    const answer = await ask(rl, '  Enter choice (1-6): ');
    const choice = choices[answer];
    if (choice) {
      console.log('');
      return choice;
    }
    console.log(chalk.yellow('  Please enter 1, 2, 3, 4, 5, or 6.'));
  }
}

// ========================= Step 2: Tool detection & install =========================

/**
 * Checks whether a CLI tool is installed by running `which <command>`.
 *
 * @param command - The command name to look for (e.g. "claude")
 * @returns True if the command is found on the PATH
 */
export function checkToolInstalled(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the version of an installed CLI tool.
 *
 * @param command - The command name
 * @param versionFlag - The flag to get version (default: "--version")
 * @returns The version string or null if not determinable
 */
export function getToolVersion(command: string, versionFlag = '--version'): string | null {
  try {
    const output = execSync(`${command} ${versionFlag} 2>/dev/null`, {
      stdio: 'pipe',
      timeout: 10000,
    }).toString().trim();
    // Extract first version-like pattern
    const match = output.match(/\d+\.\d+[\w.-]*/);
    return match ? match[0] : output.split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * Installs a tool via npm globally.
 *
 * @param displayName - Human-readable tool name for output
 * @param npmPackage - The npm package name to install
 * @returns True if installation succeeded
 */
export function installTool(displayName: string, npmPackage: string): boolean {
  try {
    console.log(chalk.blue(`  Installing ${displayName}...`));
    execSync(`npm install -g ${npmPackage}`, {
      stdio: 'pipe',
      timeout: 120000,
    });
    console.log(chalk.green(`  ✓ ${displayName} installed`));
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Failed to install ${displayName}: ${msg}`));
    console.log(chalk.gray(`  Try: sudo npm install -g ${npmPackage}`));
    return false;
  }
}

/** Tool descriptor for detection and installation */
interface ToolInfo {
  displayName: string;
  command: string;
  npmPackage: string;
}

/** A system (non-npm) tool the Crewly agent runtime cannot work without. */
export interface SystemToolInfo {
  displayName: string;
  command: string;
  /** Flag that prints the version */
  versionFlag: string;
  /** Why Crewly needs it, shown when it is missing */
  reason: string;
  /** Install command per platform */
  install: { macos: string; linux: string };
}

/**
 * System tools required before setup can continue.
 *
 * tmux is deliberately NOT here: agent sessions run on the built-in node-pty
 * backend (session-backend.factory.ts), and a clean-machine run reached an
 * active agent with no tmux installed. jq IS here: the agent skills parse JSON
 * with jq (188 of 203 skill scripts), and register-self fails with
 * "jq: not found" (exit 127) without it.
 */
export const REQUIRED_SYSTEM_TOOLS: readonly SystemToolInfo[] = [
  {
    displayName: 'jq',
    command: 'jq',
    versionFlag: '--version',
    reason: 'Agent skills use jq to read and write JSON; agents cannot register without it.',
    install: { macos: 'brew install jq', linux: 'sudo apt-get install -y jq   (Fedora: sudo dnf install -y jq)' },
  },
];

/**
 * Check the required system tools. Missing tools are listed with install
 * commands, and setup stops: continuing would only fail later, when the
 * first agent tries to register.
 *
 * @returns Number of system tools checked
 */
export function ensureSystemTools(): number {
  let checked = 0;
  const missing: SystemToolInfo[] = [];
  for (const tool of REQUIRED_SYSTEM_TOOLS) {
    checked += 1;
    if (checkToolInstalled(tool.command)) {
      const version = getToolVersion(tool.command, tool.versionFlag);
      console.log(chalk.green(`  ✓ ${tool.displayName} detected${version ? ` (${version})` : ''}`));
    } else {
      missing.push(tool);
    }
  }
  if (missing.length > 0) {
    for (const tool of missing) {
      console.log(chalk.red(`  ✖ ${tool.displayName} not found.`));
      console.log(chalk.yellow(`    ${tool.reason}`));
      console.log(chalk.gray(`    macOS: ${tool.install.macos}`));
      console.log(chalk.gray(`    Linux: ${tool.install.linux}`));
    }
    console.log(chalk.gray('    Install the tool(s) above, then run `crewly onboard` again.\n'));
    process.exit(1);
  }
  console.log(chalk.gray(`  ${checked} system tool(s) checked.`));
  return checked;
}

/** Map of provider choices to the tools they require */
const PROVIDER_TOOLS: Record<string, ToolInfo[]> = {
  claude: [
    { displayName: 'Claude Code', command: 'claude', npmPackage: '@anthropic-ai/claude-code' },
  ],
  gemini: [
    { displayName: 'Gemini CLI', command: 'gemini', npmPackage: '@google/gemini-cli' },
  ],
  codex: [
    { displayName: 'Codex CLI', command: 'codex', npmPackage: '@openai/codex' },
  ],
  opencode: [
    { displayName: 'OpenCode', command: 'opencode', npmPackage: 'opencode-ai' },
  ],
  both: [
    { displayName: 'Claude Code', command: 'claude', npmPackage: '@anthropic-ai/claude-code' },
    { displayName: 'Gemini CLI', command: 'gemini', npmPackage: '@google/gemini-cli' },
    { displayName: 'Codex CLI', command: 'codex', npmPackage: '@openai/codex' },
    { displayName: 'OpenCode', command: 'opencode', npmPackage: 'opencode-ai' },
  ],
  skip: [],
};

/**
 * Checks for and optionally installs the tools needed for the selected provider.
 *
 * For each required tool, checks if it's on the PATH. If missing, asks the user
 * whether to install it via npm. In non-interactive (--yes) mode, automatically
 * installs missing tools.
 *
 * @param rl - Readline interface
 * @param provider - The chosen provider
 * @param autoYes - When true, skip prompts and install missing tools automatically
 */
export async function ensureTools(rl: ReadlineInterface, provider: ProviderChoice, autoYes = false): Promise<void> {
  console.log(chalk.bold('  Step 2/5: Tool Installation'));

  // Required system tools (jq). tmux is not required: sessions use node-pty.
  ensureSystemTools();

  const tools = PROVIDER_TOOLS[provider] || [];

  if (tools.length === 0) {
    console.log(chalk.gray('  Skipped AI provider installation.\n'));
    return;
  }

  for (const tool of tools) {
    if (checkToolInstalled(tool.command)) {
      const version = getToolVersion(tool.command);
      const versionStr = version ? ` (v${version})` : '';
      console.log(chalk.green(`  ✓ ${tool.displayName} detected${versionStr}`));
    } else {
      console.log(chalk.yellow(`  ⚠ ${tool.displayName} not found.`));
      if (autoYes) {
        installTool(tool.displayName, tool.npmPackage);
      } else {
        const answer = await ask(rl, `  Install ${tool.displayName} now? [Y/n] `);
        if (answer === '' || answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
          installTool(tool.displayName, tool.npmPackage);
        } else {
          console.log(chalk.gray(`  Skipped ${tool.displayName} installation.`));
        }
      }
    }
  }

  console.log('');
}

// ========================= Step 3: Skills =========================

/**
 * Checks for and installs agent skills from the marketplace.
 *
 * If skills are already installed, reports the count. Otherwise, downloads
 * and installs all skills with progress feedback.
 */
export async function ensureSkills(): Promise<void> {
  console.log(chalk.bold('  Step 3/5: Agent Skills'));
  console.log(chalk.gray('  Skills let agents communicate, manage memory, and coordinate tasks.\n'));

  try {
    const { installed, total } = await checkSkillsInstalled();

    if (installed >= total && total > 0) {
      console.log(chalk.green(`  ✓ ${installed} agent skills already installed\n`));
      return;
    }

    if (total === 0) {
      // Check for bundled skills as fallback
      const bundled = countBundledSkills();
      if (bundled > 0) {
        console.log(chalk.green(`  ✓ ${bundled} bundled skills available\n`));
      } else {
        console.log(chalk.yellow('  No skills available in the marketplace.\n'));
      }
      return;
    }

    console.log(chalk.blue(`  Installing ${total} agent skills from marketplace...`));

    const result = await installAllSkills((name, index, skillTotal) => {
      console.log(chalk.gray(`  [${index}/${skillTotal}] ${name}`));
    });

    // Report failures by name. Printing only the success count hid 29 of 31
    // skills failing ("✓ 2 skills installed" after "Installing 31...").
    if (result.failed.length === 0) {
      console.log(chalk.green(`  ✓ ${result.installed} skills installed\n`));
    } else {
      for (const f of result.failed) {
        console.log(chalk.red(`  ✗ ${f.name}: ${f.message}`));
      }
      console.log(chalk.yellow(`  ⚠ ${result.installed} of ${result.total} skills installed, ${result.failed.length} failed.`));
      console.log(chalk.gray('  Setup continues; retry with \'crewly install --all\' and report persistent failures.\n'));
    }
  } catch (error) {
    // Offline fallback: count bundled skills
    const bundled = countBundledSkills();
    if (bundled > 0) {
      console.log(chalk.green(`  ✓ ${bundled} bundled skills available (marketplace offline)`));
      console.log(chalk.gray('  Run \'crewly install --all\' later for additional marketplace skills.\n'));
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(chalk.yellow(`  ⚠ Could not install skills: ${msg}`));
      console.log(chalk.gray('  Run \'crewly install --all\' later to install skills.\n'));
    }
  }
}

// ========================= Step 4: Team Template =========================

/**
 * Asks the user to pick a pre-built team template.
 *
 * Displays available templates with descriptions. The user can pick one
 * or skip to configure their team later through the dashboard.
 *
 * @param rl - Readline interface
 * @returns The selected template, or null if skipped
 */
export async function selectTemplate(rl: ReadlineInterface): Promise<TeamTemplate | null> {
  console.log(chalk.bold('  Step 4/5: Team Template'));
  console.log('  Choose a pre-built team to get started quickly:\n');

  const templates = listTemplates();

  if (templates.length === 0) {
    console.log(chalk.gray('  No templates available.\n'));
    return null;
  }

  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const members = t.members.map(m => m.name).join(', ');
    console.log(`    ${i + 1}. ${chalk.bold(t.name)}`);
    console.log(chalk.gray(`       ${t.description}`));
    console.log(chalk.gray(`       Members: ${members}\n`));
  }
  console.log(`    ${templates.length + 1}. Skip (configure later in dashboard)\n`);

  const maxChoice = templates.length + 1;

  while (true) {
    const answer = await ask(rl, `  Enter choice (1-${maxChoice}): `);
    const num = parseInt(answer, 10);
    if (num >= 1 && num <= templates.length) {
      const selected = templates[num - 1];
      console.log(chalk.green(`  ✓ Selected: ${selected.name}\n`));
      return selected;
    }
    if (num === maxChoice || answer === '') {
      console.log(chalk.gray('  Skipped team template.\n'));
      return null;
    }
    console.log(chalk.yellow(`  Please enter 1-${maxChoice}.`));
  }
}

// ========================= Team Creation =========================

/**
 * Creates a team from a template by writing it to ~/.crewly/teams/{team-id}/config.json.
 *
 * Converts template members into full TeamMember objects with UUIDs, session names,
 * and default status fields. The team is immediately available when `crewly start` runs.
 *
 * @param template - The team template to create from
 * @param provider - The chosen AI provider to set as default runtime for members
 * @returns True if the team was created successfully
 */
export function createTeamFromTemplate(template: TeamTemplate, provider: ProviderChoice = 'claude'): boolean {
  const now = new Date().toISOString();
  const teamsDir = join(homedir(), '.crewly', 'teams', template.id);

  // Map ProviderChoice to RuntimeType
  const runtimeTypeMap: Record<string, string> = {
    'claude': 'claude-code',
    'gemini': 'gemini-cli',
    'codex': 'codex-cli',
    'opencode': 'opencode-cli',
    'both': 'claude-code', // Default to Claude if both are selected
    'skip': 'claude-code',
  };

  const runtimeType = runtimeTypeMap[provider] || 'claude-code';

  try {
    mkdirSync(teamsDir, { recursive: true });

    const members = template.members.map((m) => {
      const memberId = randomUUID().split('-')[0]; // short id
      const sessionName = `${template.id}-${m.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${memberId}`;
      return {
        id: randomUUID(),
        name: m.name,
        role: m.role,
        sessionName,
        systemPrompt: m.systemPrompt,
        runtimeType,
        skillOverrides: m.skillOverrides || [],
        excludedRoleSkills: m.excludedRoleSkills || [],
        createdAt: now,
        updatedAt: now,
        agentStatus: 'inactive',
        workingStatus: 'idle',
      };
    });

    const teamConfig = {
      id: template.id,
      name: template.name,
      description: template.description,
      members,
      projectIds: [],
      createdAt: now,
      updatedAt: now,
    };

    writeFileSync(join(teamsDir, 'config.json'), JSON.stringify(teamConfig, null, 2) + '\n');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Failed to create team: ${msg}`));
    return false;
  }
}

// ========================= Directory Scaffolding =========================

/**
 * Scaffolds the .crewly/ directory in the current working directory.
 *
 * Creates the minimum directory structure needed for `crewly start` to work:
 * - .crewly/
 * - .crewly/docs/
 * - .crewly/memory/
 * - .crewly/tasks/
 * - .crewly/teams/
 *
 * If a template is provided, copies goals.md and team.json from the
 * template directory into .crewly/ (only if they exist in the template
 * and don't already exist in the target).
 *
 * If the directory already exists, reports it and moves on but still
 * copies any missing template files.
 *
 * @param projectDir - The project root directory (defaults to process.cwd())
 * @param template - Optional template to copy project files from
 * @returns True if the directory was created or already existed
 */
export function scaffoldCrewlyDirectory(projectDir: string = process.cwd(), template?: TeamTemplate | null): boolean {
  const crewlyDir = join(projectDir, '.crewly');
  let alreadyExisted = false;

  if (existsSync(crewlyDir)) {
    console.log(chalk.green('  ✓ .crewly/ directory already exists'));
    alreadyExisted = true;
  }

  try {
    if (!alreadyExisted) {
      const subdirs = ['docs', 'memory', 'tasks', 'teams'];
      for (const subdir of subdirs) {
        mkdirSync(join(crewlyDir, subdir), { recursive: true });
      }

      // Write minimal config.env
      writeFileSync(
        join(crewlyDir, 'config.env'),
        '# Crewly configuration\n# Add API keys and settings here\n',
      );

      console.log(chalk.green('  ✓ .crewly/ directory created'));
    }

    // Copy template project files (goals.md, team.json) if available
    if (template) {
      copyTemplateProjectFiles(crewlyDir, template);
    }

    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`  ✗ Failed to create .crewly/ directory: ${msg}`));
    return false;
  }
}

/**
 * Copies project-level files (goals.md, team.json) from a template
 * directory into the .crewly/ scaffold directory.
 *
 * Only copies files that exist in the template and don't already
 * exist in the target directory (avoids overwriting user edits).
 *
 * @param crewlyDir - The .crewly/ directory to copy files into
 * @param template - The template whose directory to copy from
 */
export function copyTemplateProjectFiles(crewlyDir: string, template: TeamTemplate): void {
  const templatesDir = getTemplatesDir();
  const templateDir = join(templatesDir, template.id);

  if (!existsSync(templateDir)) {
    return;
  }

  const filesToCopy = ['goals.md', 'team.json'];
  let copiedCount = 0;

  for (const fileName of filesToCopy) {
    const src = join(templateDir, fileName);
    const dest = join(crewlyDir, fileName);

    if (existsSync(src) && !existsSync(dest)) {
      copyFileSync(src, dest);
      copiedCount++;
    }
  }

  if (copiedCount > 0) {
    console.log(chalk.green(`  ✓ Copied ${copiedCount} template file(s) to .crewly/`));
  }
}

// ========================= Step 5: Summary =========================

/**
 * Prints the setup-complete summary with next-step instructions.
 *
 * If a team template was selected, includes instructions on how to
 * create the team from the dashboard.
 *
 * @param selectedTemplate - The template chosen during onboarding, or null
 * @param projectDir - The project directory path for next-steps output
 */
export function printSummary(selectedTemplate: TeamTemplate | null = null, projectDir?: string): void {
  console.log(chalk.bold('  Step 5/5: Done!'));
  console.log(chalk.green('  ✓ Setup complete!\n'));

  if (selectedTemplate) {
    console.log(`  Team: ${chalk.bold(selectedTemplate.name)}`);
    console.log(`  Members: ${selectedTemplate.members.map(m => m.name).join(', ')}\n`);
  }

  console.log(chalk.bold('  Next steps:\n'));

  if (projectDir && projectDir !== process.cwd()) {
    console.log(chalk.cyan(`    cd ${projectDir}`));
  }
  console.log(chalk.cyan('    crewly start\n'));

  if (selectedTemplate) {
    console.log('  Your team is ready. Open the dashboard to assign a project');
    console.log('  and start your agents.\n');
  }
}

// ========================= Orchestrator runtime =========================

/** Runtime the orchestrator uses for each single-provider choice. */
const ORCHESTRATOR_RUNTIME_BY_PROVIDER: Partial<Record<ProviderChoice, string>> = {
  claude: 'claude-code',
  gemini: 'gemini-cli',
  codex: 'codex-cli',
  opencode: 'opencode-cli',
};

/**
 * Save the chosen provider as the orchestrator's runtime, in the file the
 * backend reads it from (`<CREWLY_HOME>/teams/orchestrator/config.json`,
 * field `runtimeType`). Other fields in the file are kept.
 *
 * Before this, the choice was used only for a template team, so a Gemini-only
 * user's orchestrator still started Claude Code and looped on
 * `claude: command not found` (B8 D1).
 *
 * "All providers" and "Skip" name no single runtime and change nothing.
 *
 * @param provider - The provider chosen in step 1
 * @returns The runtime saved, or null when nothing was saved
 *
 * @example
 * persistOrchestratorRuntime('gemini'); // → 'gemini-cli'
 */
export function persistOrchestratorRuntime(provider: ProviderChoice): string | null {
  const runtimeType = ORCHESTRATOR_RUNTIME_BY_PROVIDER[provider];
  if (!runtimeType) return null;

  const crewlyHome = process.env.CREWLY_HOME || join(homedir(), CREWLY_HOME_DIR);
  const dir = join(crewlyHome, 'teams', CREWLY_CONSTANTS.AGENT_IDS.ORCHESTRATOR_ID);
  const file = join(dir, 'config.json');
  const now = new Date().toISOString();

  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    } catch {
      console.log(chalk.yellow(`  ⚠ ${file} is not valid JSON; the orchestrator runtime was not saved.\n`));
      return null;
    }
  }

  const config = {
    sessionName: CREWLY_CONSTANTS.SESSIONS.ORCHESTRATOR_NAME,
    agentStatus: CREWLY_CONSTANTS.AGENT_STATUSES.INACTIVE,
    workingStatus: CREWLY_CONSTANTS.WORKING_STATUSES.IDLE,
    createdAt: now,
    ...existing,
    runtimeType,
    updatedAt: now,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  } catch (error) {
    console.log(chalk.yellow(`  ⚠ Could not save the orchestrator runtime: ${error instanceof Error ? error.message : String(error)}\n`));
    return null;
  }
  return runtimeType;
}

// ========================= Main command =========================

/**
 * Runs the onboarding wizard.
 *
 * In interactive mode (default), walks the user through 5 steps:
 * 1. Choose an AI provider (Claude Code, Gemini CLI, Codex, OpenCode, all, or skip)
 * 2. Detect / install the chosen tool(s)
 * 3. Install agent skills from the marketplace
 * 4. Pick a team template (or skip)
 * 5. Print a success summary
 *
 * In non-interactive mode (--yes), uses defaults:
 * - Provider: claude
 * - Auto-install missing tools
 * - First available template (or --template flag)
 * - Scaffold .crewly/ directory
 *
 * Interactive mode requires stdin to be a terminal. When it is not (a pipe,
 * as under `curl ... | bash` without `< /dev/tty`), or when the input closes
 * mid-wizard, it prints the command to run next and sets exit code 1 instead
 * of finishing with nothing set up (#772).
 *
 * @param options - Command options from Commander.js
 */
export async function onboardCommand(options: OnboardOptions = {}): Promise<void> {
  printBanner();

  const autoYes = options.yes === true;

  // Handle --template flag: look up template by ID
  let preselectedTemplate: TeamTemplate | null = null;
  if (options.template) {
    const found = getTemplate(options.template);
    if (found) {
      preselectedTemplate = found;
    } else {
      console.log(chalk.yellow(`  ⚠ Template "${options.template}" not found.`));
      const available = listTemplates();
      if (available.length > 0) {
        console.log(chalk.gray(`  Available templates: ${available.map(t => t.id).join(', ')}\n`));
      }
    }
  }

  // Interactive mode needs a terminal to read answers from (#772).
  if (!autoYes && !isInteractiveInput()) {
    reportNonInteractiveInput('The setup wizard needs a terminal, but its input is not one.');
    return;
  }

  if (autoYes) {
    // Non-interactive mode: use defaults
    const provider: ProviderChoice = 'claude';
    console.log(chalk.gray('  Running in non-interactive mode (--yes)\n'));

    // Step 1: Default provider
    console.log(chalk.bold('  Step 1/5: AI Provider'));
    console.log(chalk.green(`  ✓ Using default: Claude Code\n`));

    // Step 2: Auto-install tools (autoYes never prompts; close the interface
    // so an open stdin cannot keep the process alive)
    const autoRl = createReadlineInterface();
    try {
      await ensureTools(autoRl, provider, true);
    } finally {
      autoRl.close();
    }

    // Step 3: Skills
    await ensureSkills();

    // Step 4: Template — use preselected or first available
    console.log(chalk.bold('  Step 4/5: Team Template'));
    const selectedTemplate = preselectedTemplate ?? listTemplates()[0] ?? null;
    if (selectedTemplate) {
      console.log(chalk.green(`  ✓ Using template: ${selectedTemplate.name}\n`));
      const created = createTeamFromTemplate(selectedTemplate, provider);
      if (created) {
        console.log(chalk.green(`  ✓ Team "${selectedTemplate.name}" created\n`));
      }
    } else {
      console.log(chalk.gray('  No templates available.\n'));
    }

    // Scaffold .crewly/ directory (with template project files)
    scaffoldCrewlyDirectory(process.cwd(), selectedTemplate);

    // Step 5: Summary
    printSummary(selectedTemplate);
    return;
  }

  // Interactive mode
  const rl = createReadlineInterface();

  try {
    // Step 1: Provider selection
    const provider = await selectProvider(rl);

    // Step 2: Tool installation
    await ensureTools(rl, provider);

    // The orchestrator runs on the chosen provider (B8 D1)
    const orchestratorRuntime = persistOrchestratorRuntime(provider);
    if (orchestratorRuntime) {
      console.log(chalk.green(`  ✓ Orchestrator runtime set to ${orchestratorRuntime}\n`));
    }

    // Step 3: Skills
    await ensureSkills();

    // Step 4: Team template — preselected or interactive
    let selectedTemplate: TeamTemplate | null;
    if (preselectedTemplate) {
      console.log(chalk.bold('  Step 4/5: Team Template'));
      console.log(chalk.green(`  ✓ Using template: ${preselectedTemplate.name}\n`));
      selectedTemplate = preselectedTemplate;
    } else {
      selectedTemplate = await selectTemplate(rl);
    }

    // Create team from selected template
    if (selectedTemplate) {
      const created = createTeamFromTemplate(selectedTemplate, provider);
      if (created) {
        console.log(chalk.green(`  ✓ Team "${selectedTemplate.name}" created\n`));
      }
    }

    // Scaffold .crewly/ directory (with template project files)
    scaffoldCrewlyDirectory(process.cwd(), selectedTemplate);

    // Step 5: Summary
    printSummary(selectedTemplate);
  } catch (error) {
    if (error instanceof WizardInputClosedError) {
      console.log('');
      reportNonInteractiveInput('The setup wizard\'s input closed before setup finished.', true);
      return;
    }
    throw error;
  } finally {
    rl.close();
  }
}
