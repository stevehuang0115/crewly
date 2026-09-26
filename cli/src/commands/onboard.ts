/**
 * CLI Onboard Command
 *
 * Setup wizard for new Crewly users. It can hand off to the web app (for
 * non-technical users) or run fully in the terminal; both call the same
 * harness engine (backend/src/services/harness):
 *
 * 1. AI harness — detect Claude Code / Codex / Antigravity CLI (Gemini CLI is
 *    retired for new users and only listed when already in use), choose the
 *    one the orchestrator uses (default Claude Code), install only that one
 *    when it is missing or outdated, and record the choice.
 * 2. Login — the harness's own login command runs in Crewly's login broker;
 *    the sign-in link (and code) is printed so it can be opened on a phone,
 *    and Claude's code is read back from this terminal. Antigravity CLI takes
 *    a Gemini API key only.
 * 3. Agent skills.
 * 4. First team: a starter (Personal Assistant by default, Marketing) or
 *    Blank (the orchestrator only).
 * 5. First task ("派第一件事"), optional: sent to the orchestrator through the
 *    running backend, or kept for it until Crewly starts.
 * 6. Crewly Cloud and Slack: phone links only, never waits.
 * 7. Summary.
 *
 * The owner is assumed not to be at the machine: nothing opens a local
 * browser for login, and `--yes` never prompts. With `--yes`, a login that
 * needs a reply is started in the running backend (so the web app / phone
 * can finish it) or skipped with a note.
 *
 * Used directly via `crewly onboard`, by the curl install script, and by the
 * desktop app. Flags: `--yes`, `--template <id>`, `--harness <id>`, `--task <text>`,
 * `--web`, `--cli`, and for a solution bundle (`--template <bundle id>`)
 * `--answers <file>` / `--runtime <id>`: the bundle's questions are asked
 * (or read from the file) and it is deployed in one step
 * (specs/solution-bundles.md).
 *
 * @module cli/commands/onboard
 */

import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
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
  listOnboardingStarters,
  getDefaultStarterTemplate,
  type TeamTemplate,
} from '../utils/templates.js';
import { CLI_CONSTANTS } from '../constants.js';
import { HARNESS_CONSTANTS } from '../../../backend/src/constants.js';
import type { HarnessService } from '../../../backend/src/services/harness/harness.service.js';
import {
  createCliHarnessService,
  getBackendPort,
  isBackendRunning,
  localBackendUrl,
  pickLoginDriver,
  type LoginDriver,
} from '../utils/harness-engine.js';
import { createReadlineIO } from '../utils/prompt-io.js';
import { runHarnessSetup, type HarnessSetupResult, type SetupIO } from './harness-setup.js';
import { askBundleQuestions, cliPackageRoot, deployBundle, loadAnswersFile } from './deploy-bundle.js';
import { BundleCatalog, bundleTemplateDirs } from '../../../backend/src/services/bundle/bundle-catalog.js';
import type { BundleTemplate } from '../../../backend/src/types/solution-bundle.types.js';
import { getCrewlyHomePath } from '../../../backend/src/services/core/crewly-home.utils.js';
import { resolveApiToken } from '../../../backend/src/services/core/api-token.service.js';
import { pickAdvertisedHost } from './token.js';
import {
  askFirstTask,
  buildConnectLinks,
  chooseStarter,
  deliverFirstTask,
  printConnectSteps,
  readConnectState,
  recordBlankChoice,
  reportFirstTask,
  starterSuggestions,
  stepHeader,
  type ConnectLinks,
  type ConnectState,
  type FirstTaskOutcome,
  type StarterChoice,
} from './onboard-checklist.js';

/** Process exit codes used by the wizard. */
const CLI_EXIT_CODES = CLI_CONSTANTS.EXIT_CODES;

/** Options passed from Commander.js for the onboard command */
export interface OnboardOptions {
  /** Skip all interactive prompts and use defaults */
  yes?: boolean;
  /** Select a team template by ID (e.g. "web-dev-team") */
  template?: string;
  /** Harness for the orchestrator (claude | codex | antigravity, or a full id; gemini still accepted) */
  harness?: string;
  /** Continue setup in the web app */
  web?: boolean;
  /** Continue setup in this terminal */
  cli?: boolean;
  /** First task for the new team (with --yes; otherwise it is asked) */
  task?: string;
  /** Answers file (JSON) for a solution bundle's questions */
  answers?: string;
  /** Runtime for a solution bundle's members */
  runtime?: string;
}

/** Where the rest of setup happens. */
export type SetupMode = 'web' | 'cli';

/** Injectable dependencies (tests). */
export interface OnboardDeps {
  /** Harness engine (defaults to an in-process one) */
  service?: HarnessService;
  /** Login driver resolver (defaults to backend when running, else in-process) */
  getDriver?: () => Promise<LoginDriver>;
  /** Whether a local desktop session is available */
  hasDesktop?: boolean;
  /** Hand-off to the web app */
  continueInWeb?: () => Promise<void>;
  /** Send / keep the first task */
  deliverFirstTask?: (text: string, teamId: string | null) => Promise<FirstTaskOutcome>;
  /** Record the Blank choice */
  recordBlank?: () => Promise<void>;
  /** Phone links for Cloud and Slack */
  connectLinks?: () => ConnectLinks;
  /** Cloud / Slack state from the running backend (null when unknown) */
  readConnectState?: () => Promise<ConnectState | null>;
  /** Find a solution bundle by template id (null when the id is not a bundle) */
  findBundle?: (templateId: string) => BundleTemplate | null;
  /** Deploy a solution bundle; returns the exit code */
  deployBundle?: (templateId: string, answers: Record<string, unknown>, runtime: string | undefined) => Promise<number>;
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

// ========================= Setup mode (web or here) =========================

/**
 * Whether a person is likely sitting at a local desktop session.
 *
 * False over SSH and inside a Crewly agent shell; on Linux a display
 * (`DISPLAY` / `WAYLAND_DISPLAY`) is required.
 *
 * @param env - Environment
 * @param platform - OS platform
 * @returns True when a local browser would reach the user
 */
export function hasLocalDesktop(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.CREWLY_SESSION_NAME) return false;
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/**
 * Decide whether setup continues in the web app or in this terminal.
 *
 * `--web` / `--cli` win; `--yes` means the terminal; otherwise the user is
 * asked, with the web app as the default when a desktop is available.
 *
 * @param ask - Prompt function
 * @param options - Command options
 * @param desktop - Whether a local desktop session is available
 * @returns Setup mode
 */
export async function chooseSetupMode(
  ask: (question: string) => Promise<string>,
  options: OnboardOptions,
  desktop: boolean,
): Promise<SetupMode> {
  if (options.web) return 'web';
  if (options.cli || options.yes) return 'cli';
  const defaultMode: SetupMode = desktop ? 'web' : 'cli';
  console.log(chalk.bold('  Continue setup in the web app or here?'));
  console.log(`    1. Web app${desktop ? chalk.green(' (recommended)') : ''} — point and click, works from your phone too`);
  console.log(`    2. Here in the terminal${desktop ? '' : chalk.green(' (recommended)')}\n`);
  for (;;) {
    const answer = (await ask(`  Enter choice (1-2) [${defaultMode === 'web' ? 1 : 2}]: `)).toLowerCase();
    if (answer === '') return defaultMode;
    if (answer === '1' || answer === 'w' || answer === 'web') return 'web';
    if (answer === '2' || answer === 'c' || answer === 'cli' || answer === 'here') return 'cli';
    console.log(chalk.yellow('  Please enter 1 or 2.'));
  }
}

/**
 * Hand setup over to the web app.
 *
 * Opens the setup page when Crewly is already running; otherwise starts
 * Crewly in this terminal (like `crewly start`) and opens the page once it
 * answers. The URL is always printed, so it also works from another device.
 * Loopback needs no API token.
 *
 * @param deps - Browser opener, backend probe, starter (tests)
 */
export async function continueInWebApp(
  deps: {
    openUrl?: (url: string) => Promise<unknown>;
    isRunning?: () => Promise<boolean>;
    start?: () => Promise<void>;
    port?: number;
  } = {},
): Promise<void> {
  const port = deps.port ?? getBackendPort();
  const url = `${localBackendUrl(port)}${HARNESS_CONSTANTS.WEB_SETUP_PATH}`;
  // Loaded lazily: `open` is ESM-only and `start` pulls in the server
  // launcher; neither is needed by the modules that import this file for
  // REQUIRED_SYSTEM_TOOLS (crewly doctor).
  const openUrl = deps.openUrl ?? (async (target: string) => (await import('open')).default(target));
  const isRunning = deps.isRunning ?? (() => isBackendRunning(port));
  const tryOpen = async (): Promise<void> => {
    try {
      await openUrl(url);
    } catch {
      // No browser here — the printed URL is enough.
    }
  };

  if (await isRunning()) {
    console.log(chalk.green(`  ✓ Crewly is running. Setup continues at ${chalk.cyan(url)}\n`));
    await tryOpen();
    return;
  }
  console.log(chalk.blue('  Starting Crewly; setup continues in the web app at'));
  console.log(chalk.cyan(`    ${url}\n`));
  const start = deps.start ?? (async () => (await import('./start.js')).startCommand({ port: String(port), browser: false }));
  const opener = (async () => {
    for (let attempt = 0; attempt < CLI_CONSTANTS.ONBOARD.WEB_WAIT_ATTEMPTS; attempt++) {
      if (await isRunning()) {
        await tryOpen();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, CLI_CONSTANTS.ONBOARD.WEB_WAIT_INTERVAL_MS));
    }
  })();
  await Promise.all([start(), opener]);
}

// ========================= Step 1: System tools & harness =========================

/**
 * Checks whether a CLI tool is installed by running `which <command>`.
 *
 * @param command - The command name to look for (e.g. "jq")
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
    install: { macos: HARNESS_CONSTANTS.SYSTEM_TOOLS.JQ.INSTALL_HINT_MACOS, linux: HARNESS_CONSTANTS.SYSTEM_TOOLS.JQ.INSTALL_HINT_LINUX },
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

/**
 * Steps 1 and 2: system tools, then the harness engine's setup (detect →
 * choose → install the orc's harness only → record → log in).
 *
 * @param io - Prompting and output
 * @param service - Harness engine
 * @param getDriver - Login driver resolver
 * @param options - `interactive`, `harness` preset
 * @returns What was set up
 */
export async function runHarnessStep(
  io: SetupIO,
  service: HarnessService,
  getDriver: () => Promise<LoginDriver>,
  options: { interactive: boolean; harness?: string },
): Promise<HarnessSetupResult> {
  console.log(stepHeader(1, 'AI Harness'));
  ensureSystemTools();
  const result = await runHarnessSetup(io, service, getDriver, {
    interactive: options.interactive,
    preset: options.harness,
    loginHeader: stepHeader(2, 'Log in'),
  });
  console.log('');
  return result;
}

// ========================= Step 3: Skills =========================

/**
 * Checks for and installs agent skills from the marketplace.
 *
 * If skills are already installed, reports the count. Otherwise, downloads
 * and installs all skills with progress feedback.
 */
export async function ensureSkills(): Promise<void> {
  console.log(stepHeader(3, 'Agent Skills'));
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
  console.log(stepHeader(4, 'Team Template'));
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

  for (;;) {
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

/**
 * Step 4: choose the first team. With starter templates present (the normal
 * case) this is Personal Assistant (default) / Marketing / Blank; without
 * them it falls back to the full template list.
 *
 * @param rl - Readline interface
 * @returns The choice, or null when skipped
 */
export async function selectFirstTeam(rl: ReadlineInterface): Promise<StarterChoice | null> {
  const starters = listOnboardingStarters(listTemplates());
  if (starters.length === 0) {
    const template = await selectTemplate(rl);
    return template ? { kind: 'template', template } : null;
  }
  console.log(stepHeader(4, 'First team'));
  return chooseStarter((question) => ask(rl, question), starters);
}

// ========================= Team Creation =========================

/**
 * The id of an existing team created from a template: the CLI's own
 * `teams/<template-id>/` or a team the web app created (UUID directory) that
 * records the same `templateId`.
 *
 * @param templateId - Template id
 * @returns Team id, or null when there is none
 */
export function findTeamIdForTemplate(templateId: string): string | null {
  const teamsDir = join(getCrewlyHomePath(), 'teams');
  try {
    if (existsSync(join(teamsDir, templateId, 'config.json'))) return templateId;
    for (const entry of readdirSync(teamsDir)) {
      try {
        const config = JSON.parse(String(readFileSync(join(teamsDir, entry, 'config.json'), 'utf-8'))) as { id?: unknown; templateId?: unknown };
        if (config.templateId === templateId) return typeof config.id === 'string' ? config.id : entry;
      } catch {
        // Not a team directory.
      }
    }
  } catch {
    // No teams yet.
  }
  return null;
}

/**
 * Creates a team from a template by writing it to <crewlyHome>/teams/{template-id}/config.json
 * (`CREWLY_HOME`, else ~/.crewly).
 *
 * Converts template members into full TeamMember objects with UUIDs, session names,
 * and default status fields. The team is immediately available when `crewly start` runs.
 * An existing team from the same template is kept as it is (running onboard
 * twice must not replace a team the owner already uses).
 *
 * @param template - The team template to create from
 * @param runtimeType - Harness the members run on (the orchestrator's harness,
 *   the only one first-time setup installs)
 * @returns True if the team was created successfully
 */
export function createTeamFromTemplate(template: TeamTemplate, runtimeType: string = HARNESS_CONSTANTS.DEFAULT_ORC_HARNESS): boolean {
  const now = new Date().toISOString();
  const teamsDir = join(getCrewlyHomePath(), 'teams', template.id);

  try {
    if (findTeamIdForTemplate(template.id)) {
      console.log(chalk.gray(`  Team "${template.name}" already exists; keeping it.`));
      return true;
    }
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
      templateId: template.id,
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

// ========================= Steps 5-6: First task, Cloud & Slack =========================

/**
 * The team a first task goes to: the team from the template (the CLI names
 * it after the template id; a web-created one has its own id), or null for
 * Blank / no team.
 *
 * @param choice - First-team choice
 * @param created - Whether the team exists
 * @returns Team id, or null
 */
export function firstTaskTeamId(choice: StarterChoice | null, created: boolean): string | null {
  if (choice?.kind !== 'template' || !created) return null;
  return findTeamIdForTemplate(choice.template.id) ?? choice.template.id;
}

/**
 * Step 5: the first task. Interactive mode asks (Enter skips); `--yes` uses
 * `--task` and never asks.
 *
 * @param choice - First-team choice (for the suggestions)
 * @param teamId - Team the task is for, or null for the orchestrator
 * @param options - `ask` (interactive) or `task` (preset)
 * @param deliver - Sends / keeps the task
 * @returns The outcome, or null when skipped
 */
export async function runFirstTaskStep(
  choice: StarterChoice | null,
  teamId: string | null,
  options: { ask?: (question: string) => Promise<string>; task?: string },
  deliver: (text: string, teamId: string | null) => Promise<FirstTaskOutcome>,
): Promise<FirstTaskOutcome | null> {
  console.log(stepHeader(5, 'First task (派第一件事)'));
  let text: string | null = options.task?.trim() || null;
  if (!text && options.ask) {
    text = await askFirstTask(options.ask, starterSuggestions(choice?.kind === 'template' ? choice.template : null));
  }
  if (!text) {
    if (!options.ask) console.log(chalk.gray('  Skipped (pass --task "<text>" to send one). Send it any time from the dashboard or Slack.\n'));
    return null;
  }
  const outcome = await deliver(text, teamId);
  reportFirstTask(outcome);
  return outcome;
}

/**
 * The phone links for Cloud and Slack on this machine: LAN address, backend
 * port and the API token a non-loopback browser needs.
 *
 * @returns Links
 */
export function defaultConnectLinks(): ConnectLinks {
  let token: string | null = null;
  try {
    token = resolveApiToken().token;
  } catch {
    token = null;
  }
  return buildConnectLinks(pickAdvertisedHost(), getBackendPort(), token);
}

/**
 * Step 6: Crewly Cloud and Slack. Prints phone links (or done marks when the
 * running backend says so) and moves on.
 *
 * @param links - Phone links
 * @param readState - Cloud / Slack state from the running backend
 */
export async function runConnectStep(links: () => ConnectLinks, readState: () => Promise<ConnectState | null>): Promise<void> {
  console.log(stepHeader(6, 'Crewly Cloud & Slack'));
  printConnectSteps(links(), await readState());
}

// ========================= Step 7: Summary =========================

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
  console.log(stepHeader(CLI_CONSTANTS.ONBOARD.TOTAL_STEPS, 'Done!'));
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

// ========================= Solution bundles =========================

/**
 * A solution bundle by template id, from the OSS templates and
 * CREWLY_TEMPLATE_DIRS (e.g. Crewly Pro's templates).
 *
 * @param templateId - Template id
 * @returns The bundle, or null when the id is not a bundle
 */
export function findBundleTemplate(templateId: string): BundleTemplate | null {
  try {
    return new BundleCatalog(() => bundleTemplateDirs(cliPackageRoot())).get(templateId)?.template ?? null;
  } catch {
    return null;
  }
}

/**
 * Step 4 for a solution bundle: its questions (unless `--answers` covers
 * them, or `--yes` forbids asking), then the one-step deploy.
 *
 * @param bundle - Bundle template
 * @param options - `--answers`, `--runtime`
 * @param ask - Prompt function, or null in non-interactive mode
 * @param deploy - Deploy function (exit code)
 * @returns Whether the bundle deployed (possibly with pending steps)
 */
export async function runBundleStep(
  bundle: BundleTemplate,
  options: Pick<OnboardOptions, 'answers' | 'runtime'>,
  ask: ((question: string) => Promise<string>) | null,
  deploy: (templateId: string, answers: Record<string, unknown>, runtime: string | undefined) => Promise<number>,
): Promise<boolean> {
  console.log(stepHeader(4, `First team: ${bundle.bundle.label}`));
  console.log(chalk.gray(`  ${bundle.bundle.tagline}\n`));
  let answers: Record<string, unknown> = {};
  if (options.answers) {
    try {
      answers = loadAnswersFile(options.answers);
    } catch (error) {
      console.log(chalk.red(`  ✗ ${error instanceof Error ? error.message : String(error)}`));
      return false;
    }
  }
  if (ask) {
    console.log(chalk.bold('  先回答几个问题，团队会按你的情况来做事：\n'));
    answers = await askBundleQuestions(ask, bundle.bundle.questions ?? [], answers);
  }
  const code = await deploy(bundle.id, answers, options.runtime);
  console.log('');
  return code === CLI_EXIT_CODES.SUCCESS;
}

// ========================= Main command =========================

/**
 * Runs the onboarding wizard.
 *
 * First asks whether to continue in the web app or here (`--web` / `--cli`
 * skip the question; the web app is the default when a desktop is
 * available). In the terminal it walks through:
 * 1. AI harness: jq check, detect harnesses, choose the orchestrator's
 *    (default Claude Code), install only that one, record the choice
 * 2. Log in through the login broker (link + code printed for a phone)
 * 3. Agent skills
 * 4. First team: Personal Assistant (default), Marketing or Blank
 * 5. First task, optional (`--task` with `--yes`)
 * 6. Crewly Cloud & Slack: phone links, never waits
 * 7. Summary
 *
 * `--yes` uses the defaults and never prompts: the default harness (or
 * `--harness`), auto-install, the recommended starter team (or `--template`),
 * and a login that is either handed to the
 * running backend (web app / phone finish it), a device-code login that
 * needs no reply, or skipped with a note.
 *
 * Interactive mode requires stdin to be a terminal. When it is not (a pipe,
 * as under `curl ... | bash` without `< /dev/tty`), or when the input closes
 * mid-wizard, it prints the command to run next and sets exit code 1 instead
 * of finishing with nothing set up (#772).
 *
 * @param options - Command options from Commander.js
 * @param deps - Injectable dependencies (tests)
 */
export async function onboardCommand(options: OnboardOptions = {}, deps: OnboardDeps = {}): Promise<void> {
  printBanner();

  const autoYes = options.yes === true;

  // Handle --template flag: a solution bundle, else a template by ID
  let preselectedTemplate: TeamTemplate | null = null;
  const findBundle = deps.findBundle ?? findBundleTemplate;
  const preselectedBundle: BundleTemplate | null = options.template ? findBundle(options.template) : null;
  const runBundleDeploy = deps.deployBundle ?? ((templateId: string, answers: Record<string, unknown>, runtime: string | undefined) =>
    deployBundle(templateId, { answers, ...(runtime ? { runtime } : {}) }));
  if (options.template && !preselectedBundle) {
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
  if (!autoYes && !options.web && !isInteractiveInput()) {
    reportNonInteractiveInput('The setup wizard needs a terminal, but its input is not one.');
    return;
  }

  const continueInWeb = deps.continueInWeb ?? (() => continueInWebApp());
  const desktop = deps.hasDesktop ?? hasLocalDesktop();
  let service: HarnessService | null = null;
  const getService = (): HarnessService => {
    service = service ?? deps.service ?? createCliHarnessService();
    return service;
  };
  const getDriver = deps.getDriver ?? (() => pickLoginDriver(getService()));
  const deliver = deps.deliverFirstTask ?? ((text: string, teamId: string | null) => deliverFirstTask(text, teamId));
  const recordBlank = deps.recordBlank ?? (() => recordBlankChoice());
  const links = deps.connectLinks ?? defaultConnectLinks;
  const readState = deps.readConnectState ?? (() => readConnectState());

  /**
   * Create the chosen team (or record Blank).
   *
   * @param choice - First-team choice
   * @param harnessId - Runtime for the members
   * @returns Whether a team now exists for the choice
   */
  const applyChoice = async (choice: StarterChoice | null, harnessId: string): Promise<boolean> => {
    if (!choice) return false;
    if (choice.kind === 'blank') {
      try {
        await recordBlank();
      } catch (error) {
        console.log(chalk.yellow(`  ⚠ Could not record the choice: ${error instanceof Error ? error.message : String(error)}`));
      }
      return false;
    }
    const created = createTeamFromTemplate(choice.template, harnessId);
    if (created) {
      console.log(chalk.green(`  ✓ Team "${choice.template.name}" created\n`));
    }
    return created;
  };

  if (autoYes) {
    // Non-interactive mode: use defaults, never prompt.
    console.log(chalk.gray('  Running in non-interactive mode (--yes)\n'));
    if (options.web) {
      await continueInWeb();
      return;
    }
    const noPrompt: SetupIO = {
      ask: async () => '',
      log: (line) => console.log(line),
    };
    try {
      const harness = await runHarnessStep(noPrompt, getService(), getDriver, { interactive: false, harness: options.harness });

      // Step 3: Skills
      await ensureSkills();

      // Step 4 for a solution bundle: deploy it with --answers; its
      // first-week tasks replace the first-task step.
      if (preselectedBundle) {
        await runBundleStep(preselectedBundle, options, null, runBundleDeploy);
        scaffoldCrewlyDirectory(process.cwd(), null);
        if (options.task) await runFirstTaskStep(null, preselectedBundle.id, { task: options.task }, deliver);
        await runConnectStep(links, readState);
        printSummary(null);
        return;
      }

      // Step 4: First team — --template, else the recommended starter
      // (Personal Assistant), never simply the first template by name.
      console.log(stepHeader(4, 'First team'));
      const selectedTemplate = preselectedTemplate ?? getDefaultStarterTemplate(listTemplates());
      let choice: StarterChoice | null = null;
      if (selectedTemplate) {
        console.log(chalk.green(`  ✓ Using template: ${selectedTemplate.name}\n`));
        choice = { kind: 'template', template: selectedTemplate };
      } else {
        console.log(chalk.gray('  No templates available.\n'));
      }
      const created = await applyChoice(choice, harness.harnessId);

      // Scaffold .crewly/ directory (with template project files)
      scaffoldCrewlyDirectory(process.cwd(), selectedTemplate);

      // Step 5: First task (only with --task)
      await runFirstTaskStep(choice, firstTaskTeamId(choice, created), { task: options.task }, deliver);

      // Step 6: Cloud & Slack (links only)
      await runConnectStep(links, readState);

      // Step 7: Summary
      printSummary(selectedTemplate);
    } finally {
      (service as HarnessService | null)?.broker.shutdown();
    }
    return;
  }

  // Interactive mode
  const rl = createReadlineInterface();
  const io = createReadlineIO(rl, () => new WizardInputClosedError());

  try {
    const mode = await chooseSetupMode(io.ask, options, desktop);
    if (mode === 'web') {
      rl.close();
      await continueInWeb();
      return;
    }
    console.log('');

    // Steps 1-2: harness + login
    const harness = await runHarnessStep(io, getService(), getDriver, { interactive: true, harness: options.harness });

    // Step 3: Skills
    await ensureSkills();

    // Step 4 for a solution bundle: ask its questions and deploy it; its
    // first-week tasks replace the first-task step.
    if (preselectedBundle) {
      await runBundleStep(preselectedBundle, options, io.ask, runBundleDeploy);
      scaffoldCrewlyDirectory(process.cwd(), null);
      if (options.task) await runFirstTaskStep(null, preselectedBundle.id, { task: options.task }, deliver);
      await runConnectStep(links, readState);
      printSummary(null);
      return;
    }

    // Step 4: First team — preselected or chosen (Enter = Personal Assistant)
    let choice: StarterChoice | null;
    if (preselectedTemplate) {
      console.log(stepHeader(4, 'First team'));
      console.log(chalk.green(`  ✓ Using template: ${preselectedTemplate.name}\n`));
      choice = { kind: 'template', template: preselectedTemplate };
    } else {
      choice = await selectFirstTeam(rl);
    }
    const created = await applyChoice(choice, harness.harnessId);
    const selectedTemplate = choice?.kind === 'template' ? choice.template : null;

    // Scaffold .crewly/ directory (with template project files)
    scaffoldCrewlyDirectory(process.cwd(), selectedTemplate);

    // Step 5: First task (optional)
    await runFirstTaskStep(choice, firstTaskTeamId(choice, created), { ask: io.ask, task: options.task }, deliver);

    // Step 6: Cloud & Slack (links only)
    await runConnectStep(links, readState);

    // Step 7: Summary
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
    (service as HarnessService | null)?.broker.shutdown();
  }
}
