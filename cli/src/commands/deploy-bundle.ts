/**
 * CLI: deploy a solution bundle (specs/solution-bundles.md).
 *
 *   crewly deploy-bundle <template-id> --answers answers.json [--runtime crewly-agent]
 *                        [--templates-dir <dir>] [--dry-run] [--allow-draft] [--json]
 *
 * Scripted deploys (hosted servers run it from cloud-init) and
 * `crewly onboard --template <bundle>` both come here. When this user's
 * backend is running, the deploy goes through `POST /api/bundles/apply` and
 * the job is followed until it finishes, so Slack, connector checks and the
 * first-week hand-offs happen right away. Otherwise the same engine runs
 * in-process: the team, norms, SOPs, skills and schedules are written, and
 * the steps that need a running Crewly are left pending — the backend
 * finishes them when it starts.
 *
 * @module cli/commands/deploy-bundle
 */

import { readFileSync } from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { BUNDLE_CONSTANTS } from '../../../backend/src/constants.js';
import { getCrewlyHomePath } from '../../../backend/src/services/core/crewly-home.utils.js';
import { BundleApplyService, BundleError } from '../../../backend/src/services/bundle/bundle-apply.service.js';
import { BundleCatalog, bundleTemplateDirs, toBundleDetail } from '../../../backend/src/services/bundle/bundle-catalog.js';
import { BundleAnswersError, resolveAnswers } from '../../../backend/src/services/bundle/bundle-placeholders.js';
import type { BundleDeployment, BundleQuestion, BundleTemplate } from '../../../backend/src/types/solution-bundle.types.js';
import { CLI_CONSTANTS } from '../constants.js';
import { defaultHttpJson, isBackendRunning, localBackendUrl, type HttpJson } from '../utils/harness-engine.js';
import { getTemplatesDir } from '../utils/templates.js';

/** Output function. */
type Log = (line: string) => void;

/** Command options (Commander). */
export interface DeployBundleOptions {
  /** JSON file with `{ "<question id>": "<answer>" }` */
  answers?: string;
  /** Runtime for every member (default: recommended if this machine can run it, else the orchestrator's) */
  runtime?: string;
  /** Extra template directories (repeatable), e.g. crewly-pro/config/templates */
  templatesDir?: string[];
  /** Validate and print the plan without deploying */
  dryRun?: boolean;
  /** Deploy a bundle marked `draft` */
  allowDraft?: boolean;
  /** Print the final deployment as JSON */
  json?: boolean;
}

/** A deploy target: the running backend or the in-process engine. */
export interface BundleDeployTarget {
  readonly where: 'backend' | 'in-process';
  start(request: { templateId: string; answers?: unknown; runtime?: string; allowDraft?: boolean }): Promise<BundleDeployment>;
  getJob(jobId: string): Promise<BundleDeployment>;
  /** In-process only: wait for the run started by `start` */
  wait?(request: { templateId: string; answers?: unknown; runtime?: string; allowDraft?: boolean }): Promise<BundleDeployment>;
}

/** Injectable pieces (tests). */
export interface DeployBundleDeps {
  log?: Log;
  readFile?: (file: string) => string;
  /** Catalog used to validate before deploying */
  catalog?: Pick<BundleCatalog, 'get'>;
  /** Whether this user's backend is running */
  isRunning?: () => Promise<boolean>;
  /** Target when the backend is running */
  remote?: () => BundleDeployTarget;
  /** Target when it is not */
  local?: (templateDirs: string[]) => BundleDeployTarget | Promise<BundleDeployTarget>;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the poll timeout */
  now?: () => number;
}

/**
 * The Crewly package root the CLI runs from.
 *
 * @returns Absolute path (parent of `config/templates`)
 */
export function cliPackageRoot(): string {
  return path.dirname(path.dirname(getTemplatesDir()));
}

/**
 * Read a JSON answers file.
 *
 * @param file - Path
 * @param readFile - File reader
 * @returns Answers object
 * @throws Error with an owner-readable message when missing or not a JSON object
 */
export function loadAnswersFile(file: string, readFile: (f: string) => string = (f) => readFileSync(f, 'utf-8')): Record<string, unknown> {
  let text: string;
  try {
    text = readFile(file);
  } catch {
    throw new Error(`Cannot read the answers file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`The answers file is not valid JSON (${file}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`The answers file must be a JSON object like {"business_name": "…"} (${file})`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * An answers-file skeleton for a bundle (printed when answers are missing).
 *
 * @param questions - Bundle questions
 * @returns Pretty JSON with every question id
 */
export function answersSkeleton(questions: BundleQuestion[]): string {
  const skeleton: Record<string, string | string[]> = {};
  for (const q of questions) {
    skeleton[q.id] = q.type === 'multiselect' ? (Array.isArray(q.default) ? q.default : []) : typeof q.default === 'string' ? q.default : '';
  }
  return JSON.stringify(skeleton, null, 2);
}

/**
 * The running backend as a deploy target.
 *
 * @param baseUrl - Loopback URL
 * @param http - HTTP helper
 * @returns Target
 */
export function createRemoteTarget(baseUrl: string = localBackendUrl(), http: HttpJson = defaultHttpJson): BundleDeployTarget {
  /** Unwrap `{ success, data }`, turning errors into BundleError-like errors. */
  const unwrap = <T>(status: number, body: unknown): T => {
    const b = body as { success?: boolean; data?: T; error?: string; code?: string; missing?: unknown; invalid?: unknown } | null;
    if (status < 300 && b?.success && b.data !== undefined) return b.data;
    const code = (b?.code ?? 'unknown_bundle') as ConstructorParameters<typeof BundleError>[0];
    const details = Array.isArray(b?.missing) || Array.isArray(b?.invalid)
      ? { missing: (b?.missing ?? []) as never[], invalid: (b?.invalid ?? []) as never[] }
      : undefined;
    throw new BundleError(code, b?.error ?? `HTTP ${status}`, details);
  };
  return {
    where: 'backend',
    async start(request) {
      const { status, body } = await http('POST', `${baseUrl}${CLI_CONSTANTS.BUNDLE.APPLY_ENDPOINT}`, request);
      return unwrap<{ deployment: BundleDeployment }>(status, body).deployment;
    },
    async getJob(jobId) {
      const { status, body } = await http('GET', `${baseUrl}${CLI_CONSTANTS.BUNDLE.APPLY_ENDPOINT}/${encodeURIComponent(jobId)}`);
      return unwrap<BundleDeployment>(status, body);
    },
  };
}

/**
 * The in-process engine as a deploy target (no Slack, connector checks or
 * orchestrator: those steps stay pending until the backend starts).
 *
 * Loaded lazily: the engine's collaborators pull in the marketplace
 * installer and the harness store, which `crewly onboard` / `crewly doctor`
 * should not load unless a bundle is actually deployed.
 *
 * @param templateDirs - Extra template directories
 * @returns Target
 */
export async function createLocalTarget(templateDirs: string[]): Promise<BundleDeployTarget> {
  const [{ createBaseBundleDeps }, { OrcHarnessStore }] = await Promise.all([
    import('../../../backend/src/services/bundle/bundle-deps.js'),
    import('../../../backend/src/services/harness/orc-harness.store.js'),
  ]);
  const store = new OrcHarnessStore();
  const service = new BundleApplyService(
    createBaseBundleDeps({
      crewlyHome: getCrewlyHomePath(),
      packageRoot: cliPackageRoot(),
      extraTemplateDirs: templateDirs,
      getOrcHarness: () => store.get(),
    }),
  );
  return {
    where: 'in-process',
    start: (request) => service.start(request),
    getJob: (jobId) => service.getJob(jobId),
    wait: (request) => service.applyAndWait(request),
  };
}

/** Status marks for the step list. */
const STEP_MARKS: Record<string, string> = {
  done: chalk.green('✓'),
  skipped: chalk.gray('–'),
  pending: chalk.yellow('…'),
  failed: chalk.red('✗'),
  running: chalk.cyan('→'),
  queued: chalk.gray('·'),
};

/**
 * Human-readable lines for a deployment.
 *
 * @param deployment - Deployment
 * @returns Lines (no trailing newline)
 */
export function formatDeployment(deployment: BundleDeployment): string[] {
  const lines: string[] = [];
  for (const step of deployment.steps) {
    const detail = step.error ?? step.message ?? '';
    lines.push(`  ${STEP_MARKS[step.status] ?? '·'} ${step.label}${detail ? chalk.gray(` — ${detail}`) : ''}`);
    for (const item of step.items ?? []) {
      if (item.status === 'done' && step.status === 'done') continue;
      lines.push(chalk.gray(`      ${STEP_MARKS[item.status] ?? '·'} ${item.label}${item.message ? `: ${item.message}` : ''}`));
    }
  }
  const missing = deployment.connectors.filter((c) => c.status !== 'connected');
  if (missing.length > 0) {
    lines.push('');
    lines.push(chalk.bold('  Connect these (on the Connections page, works from a phone):'));
    for (const c of missing) {
      lines.push(`    ${c.required ? '•' : '◦'} ${c.id}${c.products.length ? ` (${c.products.join(', ')})` : ''} — ${c.why} → ${c.connectPath}`);
    }
  }
  return lines;
}

/**
 * Whether a finished deployment should fail the command.
 *
 * @param deployment - Deployment
 * @returns True when the team failed or any step failed
 */
export function deploymentFailed(deployment: BundleDeployment): boolean {
  return deployment.status === 'failed' || deployment.steps.some((s) => s.status === 'failed');
}

/**
 * Explain a refused deploy.
 *
 * @param error - BundleError
 * @param template - The bundle (for the answers skeleton), if known
 * @param log - Output
 */
function reportBundleError(error: BundleError, template: BundleTemplate | null, log: Log): void {
  log(chalk.red(`  ✗ ${error.message}`));
  if (error.code === 'invalid_answers' && template) {
    log(chalk.gray('    Answers file template (fill in and pass with --answers):'));
    for (const line of answersSkeleton(template.bundle.questions ?? []).split('\n')) log(chalk.gray(`    ${line}`));
  }
}

/**
 * Deploy a bundle (shared by `crewly deploy-bundle` and `crewly onboard`).
 *
 * @param templateId - Bundle template id
 * @param options - Answers (object or file), runtime, flags
 * @param deps - Injectable pieces
 * @returns Process exit code (0 = deployed, possibly with pending steps; 1 = refused or failed)
 */
export async function deployBundle(
  templateId: string,
  options: Omit<DeployBundleOptions, 'answers'> & { answers?: Record<string, unknown> },
  deps: DeployBundleDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const templateDirs = (options.templatesDir ?? []).map((d) => path.resolve(d));
  const catalog = deps.catalog ?? new BundleCatalog(() => bundleTemplateDirs(cliPackageRoot(), templateDirs));
  const entry = catalog.get(templateId);
  const template = entry?.template ?? null;

  // Validate locally first for a clear message (the backend checks again).
  // A dry run without answers only validates the template itself.
  if (template && !(options.dryRun && !options.answers)) {
    try {
      resolveAnswers(template.bundle.questions ?? [], options.answers ?? {});
    } catch (error) {
      if (error instanceof BundleAnswersError) {
        reportBundleError(new BundleError('invalid_answers', error.message), template, log);
        return CLI_CONSTANTS.EXIT_CODES.ERROR;
      }
      throw error;
    }
  }

  if (options.dryRun) {
    if (!template) {
      log(chalk.red(`  ✗ No bundle "${templateId}" in ${bundleTemplateDirs(cliPackageRoot(), templateDirs).join(', ')}`));
      return CLI_CONSTANTS.EXIT_CODES.ERROR;
    }
    const detail = toBundleDetail(template);
    log(chalk.bold(`  ${detail.label} (${detail.id}) — ${detail.status}`));
    log(`  ${detail.tagline}`);
    for (const team of detail.teams) log(`  Team ${team.name}: ${team.members.map((m) => `${m.name} (${m.title})`).join(', ')}`);
    log(`  Runtime: ${detail.recommendedRuntime} · Server: ${detail.serverTier}`);
    log(`  Skills: ${detail.skills.join(', ') || '—'}`);
    log(`  Connectors: ${detail.connectors.map((c) => c.id).join(', ') || '—'}`);
    log(`  Schedules: ${detail.schedules.map((s) => `${s.title} (${s.cron})`).join(', ') || '—'}`);
    log(`  First week: ${detail.firstWeek.map((t) => `day ${t.day + 1} ${t.title}`).join(', ') || '—'}`);
    log(chalk.green('  ✓ Valid. Nothing was deployed (--dry-run).'));
    return CLI_CONSTANTS.EXIT_CODES.SUCCESS;
  }

  const running = await (deps.isRunning ?? (() => isBackendRunning()))();
  const target = running ? (deps.remote ?? (() => createRemoteTarget()))() : await (deps.local ?? createLocalTarget)(templateDirs);
  if (running && templateDirs.length > 0) {
    log(chalk.yellow('  ⚠ Crewly is running: --templates-dir is not seen by it. Start it with CREWLY_TEMPLATE_DIRS set instead.'));
  }
  const request = {
    templateId,
    ...(options.answers ? { answers: options.answers } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.allowDraft ? { allowDraft: true } : {}),
  };
  log(chalk.blue(`  Deploying ${template?.bundle.label ?? templateId} ${running ? 'through the running Crewly' : '(Crewly is not running; finishing the rest when it starts)'}…`));

  let final: BundleDeployment;
  try {
    if (target.wait) {
      final = await target.wait(request);
    } else {
      const started = await target.start(request);
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const now = deps.now ?? (() => Date.now());
      const deadline = now() + BUNDLE_CONSTANTS.CLI_JOB_TIMEOUT_MS;
      final = started;
      while (final.status === 'running' && now() < deadline) {
        await sleep(BUNDLE_CONSTANTS.CLI_POLL_INTERVAL_MS);
        final = await target.getJob(started.jobId);
      }
      if (final.status === 'running') {
        log(chalk.yellow(`  ⚠ Still running after ${BUNDLE_CONSTANTS.CLI_JOB_TIMEOUT_MS / 60000} min; follow it at /api/bundles/apply/${started.jobId}`));
      }
    }
  } catch (error) {
    if (error instanceof BundleError) {
      reportBundleError(error, template, log);
      return CLI_CONSTANTS.EXIT_CODES.ERROR;
    }
    log(chalk.red(`  ✗ ${error instanceof Error ? error.message : String(error)}`));
    return CLI_CONSTANTS.EXIT_CODES.ERROR;
  }

  if (options.json) {
    log(JSON.stringify(final, null, 2));
  } else {
    for (const line of formatDeployment(final)) log(line);
    log('');
    if (final.status === 'done') log(chalk.green('  ✓ Deployed.'));
    else if (!deploymentFailed(final)) log(chalk.green('  ✓ Deployed; the steps marked … finish by themselves once they can.'));
    else log(chalk.red('  ✗ Some steps failed. Run the same command again to retry them; finished steps are kept.'));
  }
  return deploymentFailed(final) ? CLI_CONSTANTS.EXIT_CODES.ERROR : CLI_CONSTANTS.EXIT_CODES.SUCCESS;
}

/**
 * `crewly deploy-bundle <id>` action.
 *
 * @param templateId - Bundle template id
 * @param options - Commander options
 * @param deps - Injectable pieces
 */
export async function deployBundleCommand(templateId: string, options: DeployBundleOptions = {}, deps: DeployBundleDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let answers: Record<string, unknown> | undefined;
  if (options.answers) {
    try {
      answers = loadAnswersFile(options.answers, deps.readFile);
    } catch (error) {
      log(chalk.red(`  ✗ ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = CLI_CONSTANTS.EXIT_CODES.ERROR;
      return;
    }
  }
  const code = await deployBundle(templateId, { ...options, answers }, deps);
  if (code !== CLI_CONSTANTS.EXIT_CODES.SUCCESS) process.exitCode = code;
}

/**
 * Ask a bundle's questions in the terminal. An answer from `preset` is
 * kept; Enter takes the default; a select takes a number or a value; a
 * multiselect takes comma-separated numbers or values.
 *
 * @param ask - Prompt function
 * @param questions - Bundle questions
 * @param preset - Answers already given (e.g. from --answers)
 * @param log - Output
 * @returns Answers
 */
export async function askBundleQuestions(
  ask: (question: string) => Promise<string>,
  questions: BundleQuestion[],
  preset: Record<string, unknown> = {},
  log: Log = (line) => console.log(line),
): Promise<Record<string, unknown>> {
  const answers: Record<string, unknown> = { ...preset };
  for (const q of questions) {
    if (answers[q.id] !== undefined && answers[q.id] !== '') continue;
    const options = q.options ?? [];
    for (;;) {
      log(chalk.bold(`  ${q.label}${q.required ? '' : chalk.gray('（可选）')}`));
      if (q.help) log(chalk.gray(`    ${q.help}`));
      options.forEach((o, i) => log(`    ${i + 1}. ${o.label ?? o.value}`));
      const fallback = Array.isArray(q.default) ? q.default.join(', ') : q.default ?? '';
      const raw = (await ask(`  > ${fallback ? chalk.gray(`[${fallback}] `) : ''}`)).trim();
      if (raw === '') {
        if (q.required) {
          log(chalk.yellow('    这一项必填。'));
          continue;
        }
        break; // default applies
      }
      const pick = (token: string): string | null => {
        const n = Number.parseInt(token, 10);
        if (String(n) === token && n >= 1 && n <= options.length) return options[n - 1].value;
        return options.some((o) => o.value === token) ? token : null;
      };
      if (q.type === 'select') {
        const value = pick(raw);
        if (!value) {
          log(chalk.yellow(`    请输入 1-${options.length}。`));
          continue;
        }
        answers[q.id] = value;
      } else if (q.type === 'multiselect') {
        const values = raw.split(/[,，、\s]+/).filter(Boolean).map(pick);
        if (values.some((v) => v === null)) {
          log(chalk.yellow(`    用逗号分开，比如 1,3。`));
          continue;
        }
        answers[q.id] = values as string[];
      } else {
        answers[q.id] = raw;
      }
      break;
    }
  }
  return answers;
}
