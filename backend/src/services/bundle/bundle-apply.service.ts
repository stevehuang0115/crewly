/**
 * Solution bundle apply engine.
 *
 * Deploys a bundle template in one step, with progress:
 *
 * 1. `team`       — create the team(s) with filled prompts (StorageService)
 * 2. `norms`      — write norms, review points and SOPs where the team's
 *                   norms and SOPs live (`teams/<id>/norms`, `teams/<id>/sops`)
 * 3. `skills`     — install missing skills (marketplace, behind an interface)
 * 4. `connectors` — report services not yet connected, with /connections links
 * 5. `slack`      — team channels + extra channels (SlackTeamChannelService),
 *                   only when Slack is connected; otherwise pending
 * 6. `schedules`  — recurring tasks (CronTaskService)
 * 7. `first_week` — day-0 tasks go to the orchestrator now (the chat path the
 *                   onboarding first task uses); later days are delivered by
 *                   {@link BundleApplyService.deliverDue}
 *
 * Idempotent and resumable: the deployment is persisted after every step;
 * a re-run skips steps that are done, and each step skips items it already
 * did (existing teams are kept, sent tasks are not re-sent, schedules and
 * channels are recorded). One failing step never stops the others, except
 * that everything needs the team.
 *
 * All collaborators are injected (`bundle-apply.factory.ts` wires the
 * backend's; the CLI wires an offline set), so the engine is testable with
 * plain fakes and works with or without a running backend.
 *
 * @module services/bundle/bundle-apply.service
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { BUNDLE_CONSTANTS, RUNTIME_TYPES } from '../../constants.js';
import type { Team } from '../../types/index.js';
import type { CreateCronTaskRequest } from '../../types/cron-task.types.js';
import type {
  BundleConnector,
  BundleConnectorState,
  BundleDeployment,
  BundleFirstWeekState,
  BundleStepItem,
  BundleStepState,
  BundleTemplate,
  LoadedBundle,
} from '../../types/solution-bundle.types.js';
import { atomicWriteFile } from '../../utils/file-io.utils.js';
import { bundleTeams, parseMemberRef, type NormalizedBundleTeam } from './bundle-manifest.js';
import {
  BundleAnswersError,
  fillPlaceholders,
  resolveAnswers,
  type BundleAnswerProblem,
  type BundleAnswers,
} from './bundle-placeholders.js';
import type { BundleDeploymentStore } from './bundle-state.store.js';
import { buildBundleTeam, bundleTeamId, memberForRole, memberSession, teamPlaceholderValues } from './bundle-team.builder.js';
import { firstWeekDueAt, isValidTimezone } from './bundle-time.js';

// =============================================================================
// Collaborator contracts
// =============================================================================

/** Installs skills. Switches to the skill-autoinstall runner when it lands. */
export interface BundleSkillInstaller {
  /** Whether the skill is already usable (bundled or installed) */
  isAvailable(skillId: string): Promise<boolean>;
  /** Install it */
  install(skillId: string): Promise<{ ok: boolean; message: string }>;
}

/** The Slack operations the engine needs. */
export interface BundleSlackApi {
  isConnected(): boolean;
  /** The team's own channel (SlackTeamChannelService.ensureTeamChannel) */
  ensureTeamChannel(team: Team): Promise<{ slackChannelId: string; slackChannelName: string }>;
  /** An extra channel for some agents */
  ensureAgentChannel(input: {
    name: string;
    purpose: string;
    memberSessions: string[];
    existingChannelId?: string;
  }): Promise<{ slackChannelId: string; slackChannelName: string }>;
}

/** Creates recurring tasks (CronTaskService.create; idempotent). */
export interface BundleScheduleApi {
  create(request: CreateCronTaskRequest): Promise<{ id: string }>;
}

/** Hands an owner message to the orchestrator (the chat path). */
export interface BundleOrchestratorApi {
  send(content: string, metadata: Record<string, unknown>): Promise<{
    conversationId: string | null;
    forwarded: boolean;
    queued: boolean;
    error: string | null;
  }>;
}

/** Reads whether a connector is connected. */
export interface BundleConnectorApi {
  check(connector: BundleConnector): Promise<BundleConnectorState['status']>;
}

/** Everything the engine uses. `null` collaborators mean "not available here" (e.g. the CLI without a backend). */
export interface BundleApplyDeps {
  catalog: { get(templateId: string): LoadedBundle | null };
  store: BundleDeploymentStore;
  /** Crewly home (norms and SOPs are written under `teams/<id>/`) */
  crewlyHome: string;
  teams: { get(teamId: string): Promise<Team | null>; save(team: Team): Promise<void> };
  skills: BundleSkillInstaller;
  slack: BundleSlackApi | null;
  schedules: BundleScheduleApi | null;
  orchestrator: BundleOrchestratorApi | null;
  connectors: BundleConnectorApi | null;
  /** Pick the runtime: the requested one, else a sensible default for this machine */
  resolveRuntime(recommended: string, requested: string | undefined): Promise<string>;
  now(): Date;
  /** Job id factory (tests) */
  newJobId?(): string;
}

/** What `POST /api/bundles/apply` sends. */
export interface BundleApplyRequest {
  templateId: string;
  /** Answers by question id; omitted on a re-run to reuse the stored ones */
  answers?: unknown;
  runtime?: string;
  /** Deploy a `draft` bundle */
  allowDraft?: boolean;
}

/** Error codes of the engine. */
export type BundleErrorCode = 'unknown_bundle' | 'bundle_not_ready' | 'invalid_runtime' | 'invalid_answers' | 'job_not_found';

/** A request the engine refuses before anything is written. */
export class BundleError extends Error {
  /**
   * @param code - Machine-readable code (mapped to an HTTP status by the controller)
   * @param message - Owner-facing message
   * @param details - Missing / invalid answers for `invalid_answers`
   */
  constructor(
    readonly code: BundleErrorCode,
    message: string,
    readonly details?: { missing: BundleAnswerProblem[]; invalid: BundleAnswerProblem[] },
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

/** Outcome of one step body. */
type StepOutcome = Pick<BundleStepState, 'status' | 'reason' | 'message' | 'error' | 'items'>;

/** Context the step bodies share. */
interface RunContext {
  entry: LoadedBundle;
  template: BundleTemplate;
  teams: NormalizedBundleTeam[];
  deployment: BundleDeployment;
  answers: BundleAnswers;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Error text.
 *
 * @param error - Thrown value
 * @returns Message
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A fresh step list (all queued).
 *
 * @returns Steps in run order
 */
export function initialSteps(): BundleStepState[] {
  return BUNDLE_CONSTANTS.STEP_ORDER.map((id) => ({
    id,
    label: BUNDLE_CONSTANTS.STEP_LABELS[id] ?? id,
    status: 'queued' as const,
  }));
}

/**
 * The overall status from the steps.
 *
 * @param steps - Steps
 * @returns `done` when everything is done (or had nothing to do), `failed`
 *   when the team could not be created, else `partial`
 */
export function overallStatus(steps: BundleStepState[]): BundleDeployment['status'] {
  const team = steps.find((s) => s.id === BUNDLE_CONSTANTS.STEP_IDS.TEAM);
  if (team?.status === 'failed') return 'failed';
  const finished = steps.every((s) => s.status === 'done' || (s.status === 'skipped' && s.reason === BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO));
  return finished ? 'done' : 'partial';
}

/**
 * Markdown with YAML frontmatter, the shape get-team-norms / get-sops read.
 *
 * @param fields - Frontmatter fields (undefined values are dropped)
 * @param body - Markdown body
 * @returns File content
 */
export function withFrontmatter(fields: Record<string, string | undefined>, body: string): string {
  const lines = Object.entries(fields)
    .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
    .map(([k, v]) => `${k}: ${v.replace(/\r?\n/g, ' ')}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

/**
 * The message a first-week task reaches the orchestrator as.
 *
 * @param task - Task state
 * @param team - Team it is for
 * @param memberName - Member it is for
 * @param body - Filled task text
 * @returns Message content
 */
export function buildFirstWeekMessage(task: BundleFirstWeekState, team: Pick<Team, 'id' | 'name'>, memberName: string, body: string): string {
  return [
    `${BUNDLE_CONSTANTS.FIRST_WEEK_HEADER} 第 ${task.day + 1} 天 · ${task.title}`,
    `请交给团队「${team.name}」(team id: ${team.id}) 的 ${memberName} 来做；团队还没启动的话先启动它。`,
    '',
    body.trim(),
  ].join('\n');
}

// =============================================================================
// Service
// =============================================================================

/**
 * The apply engine. See the module docs.
 */
export class BundleApplyService {
  /** Deployments being applied right now, by template id */
  private readonly running = new Map<string, { deployment: BundleDeployment; done: Promise<BundleDeployment> }>();
  /** Starts still validating / preparing, by template id (so a double tap joins them) */
  private readonly starting = new Map<string, Promise<{ deployment: BundleDeployment; done: Promise<BundleDeployment> }>>();
  /** Serialises writes per template */
  private readonly writes = new Map<string, Promise<void>>();

  /**
   * @param deps - Collaborators
   */
  constructor(private readonly deps: BundleApplyDeps) {}

  /**
   * Validate a request and start applying it in the background.
   *
   * A second call while the same template is being applied returns that job
   * (a double tap on a phone must not deploy twice). Answers left out reuse
   * the ones stored by an earlier run.
   *
   * @param request - Template id, answers, runtime
   * @returns The deployment snapshot with its `jobId`
   * @throws BundleError `unknown_bundle` | `bundle_not_ready` | `invalid_runtime` | `invalid_answers`
   */
  async start(request: BundleApplyRequest): Promise<BundleDeployment> {
    return (await this.begin(request)).deployment;
  }

  /**
   * Apply and wait for the result (CLI, tests).
   *
   * @param request - Template id, answers, runtime
   * @returns The finished deployment
   * @throws BundleError like {@link start}
   */
  async applyAndWait(request: BundleApplyRequest): Promise<BundleDeployment> {
    return (await this.begin(request)).done;
  }

  /**
   * Progress of a job: the live deployment while it runs, else the stored one.
   *
   * @param jobId - Job id from {@link start}
   * @returns The deployment
   * @throws BundleError `job_not_found`
   */
  async getJob(jobId: string): Promise<BundleDeployment> {
    for (const run of this.running.values()) {
      if (run.deployment.jobId === jobId) return run.deployment;
    }
    const stored = (await this.deps.store.list()).find((d) => d.jobId === jobId);
    if (!stored) throw new BundleError('job_not_found', `Job "${jobId}" not found`);
    return stored;
  }

  /**
   * The deployment of a template on this machine.
   *
   * @param templateId - Template id
   * @returns The deployment, or null when it was never applied
   */
  async getDeployment(templateId: string): Promise<BundleDeployment | null> {
    return this.running.get(templateId)?.deployment ?? (await this.deps.store.read(templateId));
  }

  /**
   * Deliver first-week tasks that are due (the backend calls this on a timer).
   *
   * @returns Number of tasks sent
   */
  async deliverDue(): Promise<number> {
    const orchestrator = this.deps.orchestrator;
    if (!orchestrator) return 0;
    let sent = 0;
    for (const stored of await this.deps.store.list()) {
      if (this.running.has(stored.templateId)) continue;
      const now = this.deps.now();
      const due = stored.firstWeek.filter((t) => t.status === 'scheduled' && Date.parse(t.dueAt) <= now.getTime());
      if (due.length === 0) continue;
      const entry = this.deps.catalog.get(stored.templateId);
      if (!entry) continue;
      const ctx = this.contextFor(entry, stored, stored.answers);
      for (const task of due) {
        if (await this.sendFirstWeekTask(ctx, task)) sent += 1;
      }
      const step = stored.steps.find((s) => s.id === BUNDLE_CONSTANTS.STEP_IDS.FIRST_WEEK);
      if (step) Object.assign(step, this.firstWeekOutcome(stored));
      stored.status = overallStatus(stored.steps);
      stored.updatedAt = this.deps.now().toISOString();
      await this.persist(stored);
    }
    return sent;
  }

  /**
   * Re-run deployments that were waiting on something that is now there:
   * the backend (after a CLI deploy without one) or Slack.
   *
   * @returns Template ids that were restarted
   */
  async resumeWaiting(): Promise<string[]> {
    const restarted: string[] = [];
    for (const stored of await this.deps.store.list()) {
      if (stored.status === 'done' || this.running.has(stored.templateId)) continue;
      const resumable = stored.steps.some(
        (s) =>
          s.status === 'pending' &&
          (s.reason === BUNDLE_CONSTANTS.PENDING_REASONS.BACKEND_NOT_RUNNING ||
            (s.reason === BUNDLE_CONSTANTS.PENDING_REASONS.SLACK_NOT_CONNECTED && !!this.deps.slack?.isConnected())),
      );
      if (!resumable || !this.deps.catalog.get(stored.templateId)) continue;
      try {
        await this.start({ templateId: stored.templateId, allowDraft: true });
        restarted.push(stored.templateId);
      } catch {
        // A template that no longer validates stays as it is.
      }
    }
    return restarted;
  }

  // ---------------------------------------------------------------------------
  // Run
  // ---------------------------------------------------------------------------

  /**
   * Validate, prepare the deployment and start the run.
   *
   * @param request - Request
   * @returns The deployment and a promise of the finished one
   */
  private async begin(request: BundleApplyRequest): Promise<{ deployment: BundleDeployment; done: Promise<BundleDeployment> }> {
    const inflight = this.running.get(request.templateId);
    if (inflight) return inflight;
    const pending = this.starting.get(request.templateId);
    if (pending) return pending;
    const prepared = this.prepare(request).finally(() => {
      this.starting.delete(request.templateId);
    });
    this.starting.set(request.templateId, prepared);
    return prepared;
  }

  /**
   * Validate the request, build and persist the deployment, start the run.
   *
   * @param request - Request
   * @returns The deployment and a promise of the finished one
   * @throws BundleError for a refused request
   */
  private async prepare(request: BundleApplyRequest): Promise<{ deployment: BundleDeployment; done: Promise<BundleDeployment> }> {
    const entry = this.deps.catalog.get(request.templateId);
    if (!entry) throw new BundleError('unknown_bundle', `没有找到方案「${request.templateId}」`);
    const { template } = entry;
    const draft = (template.bundle.status ?? BUNDLE_CONSTANTS.STATUS.READY) !== BUNDLE_CONSTANTS.STATUS.READY;
    if (draft && !request.allowDraft) {
      throw new BundleError('bundle_not_ready', `方案「${template.bundle.label}」还在准备中，暂时不能部署`);
    }
    const runtimes = Object.values(RUNTIME_TYPES) as string[];
    if (request.runtime !== undefined && !runtimes.includes(request.runtime)) {
      throw new BundleError('invalid_runtime', `Unknown runtime "${request.runtime}" (use ${runtimes.join(', ')})`);
    }

    const previous = await this.deps.store.read(template.id);
    const rawAnswers = request.answers ?? previous?.answers ?? {};
    let answers: BundleAnswers;
    try {
      answers = resolveAnswers(template.bundle.questions ?? [], rawAnswers);
    } catch (error) {
      if (error instanceof BundleAnswersError) {
        throw new BundleError('invalid_answers', error.message, { missing: error.missing, invalid: error.invalid });
      }
      throw error;
    }

    const now = this.deps.now().toISOString();
    const teamDone = previous?.steps.some((s) => s.id === BUNDLE_CONSTANTS.STEP_IDS.TEAM && s.status === 'done') ?? false;
    const runtime = teamDone && previous
      ? previous.runtime
      : await this.deps.resolveRuntime(template.bundle.runtime.recommended, request.runtime);
    const jobId = this.deps.newJobId?.() ?? `bundle-${randomUUID()}`;

    const steps = initialSteps().map((fresh) => {
      const old = previous?.steps.find((s) => s.id === fresh.id);
      return old && old.status === 'done' ? old : fresh;
    });
    const deployment: BundleDeployment = {
      templateId: template.id,
      templateVersion: template.version ?? '0.0.0',
      jobId,
      status: 'running',
      runtime,
      answers: teamDone && previous ? previous.answers : answers,
      startedAt: now,
      updatedAt: now,
      teams: previous?.teams ?? [],
      steps,
      connectors: previous?.connectors ?? [],
      firstWeek: previous?.firstWeek ?? [],
      schedules: previous?.schedules ?? {},
      channels: previous?.channels ?? {},
    };
    await this.persist(deployment);

    const ctx = this.contextFor(entry, deployment, deployment.answers);
    const done = this.run(ctx).finally(() => {
      this.running.delete(template.id);
    });
    const handle = { deployment, done };
    this.running.set(template.id, handle);
    return handle;
  }

  /**
   * Shared context for a deployment.
   *
   * @param entry - Loaded bundle
   * @param deployment - Deployment
   * @param answers - Answers
   * @returns Context
   */
  private contextFor(entry: LoadedBundle, deployment: BundleDeployment, answers: BundleAnswers): RunContext {
    return { entry, template: entry.template, teams: bundleTeams(entry.template), deployment, answers };
  }

  /**
   * Run every step that is not done, persisting after each.
   *
   * @param ctx - Context
   * @returns The finished deployment
   */
  private async run(ctx: RunContext): Promise<BundleDeployment> {
    const { deployment } = ctx;
    const bodies: Record<string, (c: RunContext) => Promise<StepOutcome>> = {
      [BUNDLE_CONSTANTS.STEP_IDS.TEAM]: (c) => this.stepTeam(c),
      [BUNDLE_CONSTANTS.STEP_IDS.NORMS]: (c) => this.stepNorms(c),
      [BUNDLE_CONSTANTS.STEP_IDS.SKILLS]: (c) => this.stepSkills(c),
      [BUNDLE_CONSTANTS.STEP_IDS.CONNECTORS]: (c) => this.stepConnectors(c),
      [BUNDLE_CONSTANTS.STEP_IDS.SLACK]: (c) => this.stepSlack(c),
      [BUNDLE_CONSTANTS.STEP_IDS.SCHEDULES]: (c) => this.stepSchedules(c),
      [BUNDLE_CONSTANTS.STEP_IDS.FIRST_WEEK]: (c) => this.stepFirstWeek(c),
    };
    const needsTeam = new Set<string>([
      BUNDLE_CONSTANTS.STEP_IDS.NORMS,
      BUNDLE_CONSTANTS.STEP_IDS.SLACK,
      BUNDLE_CONSTANTS.STEP_IDS.SCHEDULES,
      BUNDLE_CONSTANTS.STEP_IDS.FIRST_WEEK,
    ]);

    for (const step of deployment.steps) {
      if (step.status === 'done') continue;
      const teamStep = deployment.steps.find((s) => s.id === BUNDLE_CONSTANTS.STEP_IDS.TEAM);
      if (needsTeam.has(step.id) && teamStep?.status !== 'done') {
        this.finishStep(step, { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.TEAM_FAILED, message: '团队没建好，这一步先跳过' });
        await this.touch(deployment);
        continue;
      }
      step.status = 'running';
      step.startedAt = this.deps.now().toISOString();
      delete step.error;
      delete step.reason;
      await this.touch(deployment);
      let outcome: StepOutcome;
      try {
        outcome = await bodies[step.id](ctx);
      } catch (error) {
        outcome = { status: 'failed', error: errorText(error), message: '这一步出错了，重新部署会从这里接着做' };
      }
      this.finishStep(step, outcome);
      await this.touch(deployment);
    }

    deployment.status = overallStatus(deployment.steps);
    deployment.finishedAt = this.deps.now().toISOString();
    await this.touch(deployment);
    return deployment;
  }

  /**
   * Apply an outcome to a step.
   *
   * @param step - Step
   * @param outcome - Outcome
   */
  private finishStep(step: BundleStepState, outcome: StepOutcome): void {
    step.status = outcome.status;
    step.finishedAt = this.deps.now().toISOString();
    if (outcome.reason) step.reason = outcome.reason;
    else delete step.reason;
    if (outcome.message) step.message = outcome.message;
    else delete step.message;
    if (outcome.error) step.error = outcome.error;
    else delete step.error;
    if (outcome.items) step.items = outcome.items;
  }

  /**
   * Stamp and persist.
   *
   * @param deployment - Deployment
   */
  private async touch(deployment: BundleDeployment): Promise<void> {
    deployment.updatedAt = this.deps.now().toISOString();
    await this.persist(deployment);
  }

  /**
   * Persist a deployment; writes of one template never overlap.
   *
   * @param deployment - Deployment
   */
  private async persist(deployment: BundleDeployment): Promise<void> {
    const prev = this.writes.get(deployment.templateId) ?? Promise.resolve();
    const snapshot = JSON.parse(JSON.stringify(deployment)) as BundleDeployment;
    const next = prev.catch(() => undefined).then(() => this.deps.store.write(snapshot));
    this.writes.set(deployment.templateId, next);
    await next;
  }

  // ---------------------------------------------------------------------------
  // Team lookups shared by the steps
  // ---------------------------------------------------------------------------

  /**
   * The saved team for a bundle team key.
   *
   * @param ctx - Context
   * @param key - Team key
   * @returns The team
   * @throws Error when it is missing (deleted since the team step)
   */
  private async savedTeam(ctx: RunContext, key: string): Promise<Team> {
    const id = ctx.deployment.teams.find((t) => t.key === key)?.teamId ?? bundleTeamId(ctx.template.id, key);
    const team = await this.deps.teams.get(id);
    if (!team) throw new Error(`Team "${id}" no longer exists; delete ${this.deps.store.fileFor(ctx.template.id)} to deploy again`);
    return team;
  }

  /**
   * Placeholder values of a saved team.
   *
   * @param ctx - Context
   * @param team - Saved team
   * @returns Values (answers + team_name + lead_name)
   */
  private valuesFor(ctx: RunContext, team: Team): BundleAnswers {
    const lead = team.members.find((m) => m.id === team.leaderId) ?? team.members[0];
    return teamPlaceholderValues(ctx.answers, team.name, lead?.name ?? '');
  }

  /**
   * Resolve a member ref (default: the main team's lead).
   *
   * @param ctx - Context
   * @param ref - `role` / `team/role`, or undefined
   * @returns Team and member session / name
   */
  private async resolveRef(ctx: RunContext, ref: string | undefined): Promise<{ team: Team; session: string; memberName: string }> {
    const main = ctx.teams[0];
    const parsed = ref ? parseMemberRef(ref) : { teamKey: main.key, role: main.leadRole };
    const team = await this.savedTeam(ctx, parsed.teamKey);
    const member = memberForRole(team, parsed.role);
    if (!member) throw new Error(`No member with role "${parsed.role}" in team "${team.name}"`);
    return { team, session: memberSession(member), memberName: member.name };
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /** Step `team`: create every team that does not exist yet. */
  private async stepTeam(ctx: RunContext): Promise<StepOutcome> {
    const items: BundleStepItem[] = [];
    const deployed = [];
    for (const spec of ctx.teams) {
      const id = bundleTeamId(ctx.template.id, spec.key);
      const existing = await this.deps.teams.get(id);
      if (existing) {
        deployed.push({ key: spec.key, teamId: id, name: existing.name });
        items.push({ id: spec.key, label: existing.name, status: 'done', message: '已存在，保留原样' });
        continue;
      }
      const team = buildBundleTeam({ template: ctx.template, team: spec, answers: ctx.answers, runtime: ctx.deployment.runtime, now: this.deps.now() });
      await this.deps.teams.save(team);
      deployed.push({ key: spec.key, teamId: team.id, name: team.name });
      items.push({ id: spec.key, label: team.name, status: 'done', message: `${team.members.length} 位成员` });
    }
    ctx.deployment.teams = deployed;
    const names = deployed.map((t) => `「${t.name}」`).join('、');
    return { status: 'done', items, message: `团队 ${names} 已就绪` };
  }

  /** Step `norms`: norms, review points and SOPs into the teams' folders. */
  private async stepNorms(ctx: RunContext): Promise<StepOutcome> {
    const b = ctx.template.bundle;
    const norms = b.norms ?? [];
    const sops = b.sops ?? [];
    const reviews = b.reviewPoints ?? [];
    if (norms.length + sops.length + reviews.length === 0) {
      return { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO, message: '这个方案没有额外规范' };
    }
    const items: BundleStepItem[] = [];
    const main = BUNDLE_CONSTANTS.MAIN_TEAM_KEY;
    const updatedBy = `bundle:${ctx.template.id}`;
    const updatedAt = this.deps.now().toISOString();

    for (const spec of ctx.teams) {
      const team = await this.savedTeam(ctx, spec.key);
      const values = this.valuesFor(ctx, team);
      const teamDir = path.join(this.deps.crewlyHome, 'teams', team.id);

      for (const norm of norms.filter((n) => (n.team ?? main) === spec.key)) {
        const body = fillPlaceholders(await this.docBody(ctx, norm), values, `norm ${norm.id}`);
        const file = path.join(teamDir, BUNDLE_CONSTANTS.NORMS_DIR, `${norm.id}.md`);
        await this.writeDoc(file, withFrontmatter({ title: fillPlaceholders(norm.title, values, `norm ${norm.id} title`), trigger: norm.trigger, updatedBy, updatedAt }, body));
        items.push({ id: `norm:${spec.key}/${norm.id}`, label: norm.title, status: 'done' });
      }

      const teamReviews = reviews.filter((r) => (r.team ?? main) === spec.key);
      if (teamReviews.length > 0) {
        const rows = teamReviews.map((r) => {
          const who = r.approver === 'owner' ? '老板' : `负责人 ${values.lead_name}`;
          const how = r.how ? `：${fillPlaceholders(r.how, values, `review ${r.id}`)}` : '';
          return `- **${fillPlaceholders(r.what, values, `review ${r.id}`)}** → 先拿到${who}的同意${how}`;
        });
        const body = [
          '这些事必须先拿到同意才能做。没得到明确的「可以」之前，只准备、不执行。',
          '',
          ...rows,
          '',
          '拿不准算不算的时候，按「需要同意」处理。',
        ].join('\n');
        const file = path.join(teamDir, BUNDLE_CONSTANTS.NORMS_DIR, `${BUNDLE_CONSTANTS.REVIEW_POINTS_NORM_ID}.md`);
        await this.writeDoc(file, withFrontmatter({ title: '需要老板点头的事', trigger: 'before_publish,approval,owner_review,external', updatedBy, updatedAt }, body));
        items.push({ id: `norm:${spec.key}/${BUNDLE_CONSTANTS.REVIEW_POINTS_NORM_ID}`, label: '需要老板点头的事', status: 'done' });
      }

      for (const sop of sops.filter((s) => (s.team ?? main) === spec.key)) {
        const category = sop.category ?? BUNDLE_CONSTANTS.DEFAULT_SOP_CATEGORY;
        const body = fillPlaceholders(await this.docBody(ctx, sop), values, `sop ${sop.id}`);
        const file = path.join(teamDir, BUNDLE_CONSTANTS.SOPS_DIR, category, `${sop.id}.md`);
        await this.writeDoc(file, withFrontmatter({ title: fillPlaceholders(sop.title, values, `sop ${sop.id} title`), category, updatedBy, updatedAt }, body));
        items.push({ id: `sop:${spec.key}/${sop.id}`, label: sop.title, status: 'done' });
      }
    }
    return { status: 'done', items, message: `写好 ${items.length} 份规范和 SOP` };
  }

  /**
   * The body of a norm / SOP: inline content or the referenced file.
   *
   * @param ctx - Context
   * @param doc - Norm or SOP
   * @returns Markdown body (unfilled)
   */
  private async docBody(ctx: RunContext, doc: { content?: string; file?: string }): Promise<string> {
    if (doc.content !== undefined) return doc.content;
    return fs.readFile(path.join(ctx.entry.dir, doc.file as string), 'utf-8');
  }

  /**
   * Write a file atomically, creating its folder.
   *
   * @param file - Absolute path
   * @param content - Content
   */
  private async writeDoc(file: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteFile(file, content);
  }

  /** Step `skills`: install what is missing. */
  private async stepSkills(ctx: RunContext): Promise<StepOutcome> {
    const required = ctx.template.bundle.skills?.required ?? [];
    const optional = ctx.template.bundle.skills?.optional ?? [];
    if (required.length + optional.length === 0) {
      return { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO, message: '不需要额外技能' };
    }
    const items: BundleStepItem[] = [];
    let requiredFailed = 0;
    for (const [skillId, isRequired] of [...required.map((s) => [s, true] as const), ...optional.map((s) => [s, false] as const)]) {
      try {
        if (await this.deps.skills.isAvailable(skillId)) {
          items.push({ id: skillId, label: skillId, status: 'done', message: '已有' });
          continue;
        }
        const result = await this.deps.skills.install(skillId);
        if (result.ok) items.push({ id: skillId, label: skillId, status: 'done', message: result.message });
        else {
          items.push({ id: skillId, label: skillId, status: 'failed', message: result.message });
          if (isRequired) requiredFailed += 1;
        }
      } catch (error) {
        items.push({ id: skillId, label: skillId, status: 'failed', message: errorText(error) });
        if (isRequired) requiredFailed += 1;
      }
    }
    if (requiredFailed > 0) {
      return { status: 'failed', items, error: `${requiredFailed} 个必需技能没装上`, message: '有技能没装上，重新部署会再试' };
    }
    const optionalFailed = items.filter((i) => i.status === 'failed').length;
    return { status: 'done', items, message: optionalFailed > 0 ? `技能已就绪（${optionalFailed} 个可选技能没装上）` : '技能已就绪' };
  }

  /** Step `connectors`: which services still need connecting. */
  private async stepConnectors(ctx: RunContext): Promise<StepOutcome> {
    const specs = ctx.template.bundle.connectors ?? [];
    if (specs.length === 0) {
      return { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO, message: '不需要接别的服务' };
    }
    const states: BundleConnectorState[] = [];
    for (const spec of specs) {
      let status: BundleConnectorState['status'] = 'unknown';
      if (this.deps.connectors) {
        try {
          status = await this.deps.connectors.check(spec);
        } catch {
          status = 'unknown';
        }
      }
      states.push({
        id: spec.id,
        products: spec.products ?? [],
        required: spec.required,
        why: spec.why,
        status,
        connectPath: `${BUNDLE_CONSTANTS.CONNECTIONS_PATH}?platform=${encodeURIComponent(spec.id)}`,
      });
    }
    ctx.deployment.connectors = states;
    const items: BundleStepItem[] = states.map((s) => ({
      id: s.id,
      label: s.products.length > 0 ? `${s.id} (${s.products.join(', ')})` : s.id,
      status: s.status === 'connected' ? 'done' : 'pending',
      message: s.status === 'connected' ? '已连接' : `${s.required ? '需要连接' : '建议连接'}：${s.why} → ${s.connectPath}`,
    }));
    if (!this.deps.connectors) {
      return { status: 'pending', reason: BUNDLE_CONSTANTS.PENDING_REASONS.BACKEND_NOT_RUNNING, items, message: 'Crewly 启动后再检查；先在 /connections 连好这些服务' };
    }
    const missing = states.filter((s) => s.required && s.status !== 'connected');
    if (missing.length > 0) {
      return {
        status: 'pending',
        reason: BUNDLE_CONSTANTS.PENDING_REASONS.CONNECTORS_MISSING,
        items,
        message: `还要连接：${missing.map((m) => m.id).join('、')}（在「连接」页面，手机上也能点）`,
      };
    }
    return { status: 'done', items, message: '要用的服务都连好了' };
  }

  /** Step `slack`: team channels and extra channels. */
  private async stepSlack(ctx: RunContext): Promise<StepOutcome> {
    const layout = ctx.template.bundle.slack ?? {};
    const teamChannels = layout.teamChannels !== false;
    const extra = layout.channels ?? [];
    if (!teamChannels && extra.length === 0) {
      return { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO, message: '这个方案不用 Slack 频道' };
    }
    const slack = this.deps.slack;
    if (!slack) {
      return { status: 'pending', reason: BUNDLE_CONSTANTS.PENDING_REASONS.BACKEND_NOT_RUNNING, message: 'Crewly 启动并连上 Slack 后自动建频道' };
    }
    if (!slack.isConnected()) {
      return { status: 'pending', reason: BUNDLE_CONSTANTS.PENDING_REASONS.SLACK_NOT_CONNECTED, message: '还没连 Slack；连上后会自动建频道、拉成员进来' };
    }
    const items: BundleStepItem[] = [];
    let failed = 0;
    const allTeams: Team[] = [];
    for (const spec of ctx.teams) allTeams.push(await this.savedTeam(ctx, spec.key));

    if (teamChannels) {
      for (const team of allTeams) {
        try {
          const ch = await slack.ensureTeamChannel(team);
          items.push({ id: `team:${team.id}`, label: `#${ch.slackChannelName}`, status: 'done', message: `团队「${team.name}」的频道` });
        } catch (error) {
          failed += 1;
          items.push({ id: `team:${team.id}`, label: team.name, status: 'failed', message: errorText(error) });
        }
      }
    }
    const mainValues = this.valuesFor(ctx, allTeams[0]);
    for (const channel of extra) {
      try {
        const sessions = new Set<string>();
        for (const ref of channel.members) {
          if (ref === '*') {
            allTeams.forEach((t) => t.members.forEach((m) => sessions.add(memberSession(m))));
          } else {
            sessions.add((await this.resolveRef(ctx, ref)).session);
          }
        }
        const ch = await slack.ensureAgentChannel({
          name: fillPlaceholders(channel.name, mainValues, `channel ${channel.key}`),
          purpose: channel.purpose ? fillPlaceholders(channel.purpose, mainValues, `channel ${channel.key} purpose`) : '',
          memberSessions: [...sessions],
          ...(ctx.deployment.channels[channel.key] ? { existingChannelId: ctx.deployment.channels[channel.key] } : {}),
        });
        ctx.deployment.channels[channel.key] = ch.slackChannelId;
        items.push({ id: `channel:${channel.key}`, label: `#${ch.slackChannelName}`, status: 'done', message: `${sessions.size} 位成员` });
      } catch (error) {
        failed += 1;
        items.push({ id: `channel:${channel.key}`, label: channel.name, status: 'failed', message: errorText(error) });
      }
    }
    if (failed > 0) return { status: 'failed', items, error: `${failed} 个频道没建好`, message: '有频道没建好，重新部署会再试' };
    return { status: 'done', items, message: `建好 ${items.length} 个 Slack 频道` };
  }

  /** Step `schedules`: recurring tasks through the cron-task scheduler. */
  private async stepSchedules(ctx: RunContext): Promise<StepOutcome> {
    const schedules = ctx.template.bundle.schedules ?? [];
    if (schedules.length === 0) {
      return { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO, message: '这个方案没有定时任务' };
    }
    const api = this.deps.schedules;
    if (!api) {
      return { status: 'pending', reason: BUNDLE_CONSTANTS.PENDING_REASONS.BACKEND_NOT_RUNNING, message: 'Crewly 启动后自动排定时任务' };
    }
    const items: BundleStepItem[] = [];
    let failed = 0;
    for (const schedule of schedules) {
      if (ctx.deployment.schedules[schedule.id]) {
        items.push({ id: schedule.id, label: schedule.title, status: 'done', message: '已排好' });
        continue;
      }
      try {
        const { team, session, memberName } = await this.resolveRef(ctx, schedule.target);
        const values = this.valuesFor(ctx, team);
        const timezone = this.timezoneFor(ctx, values, schedule.timezone);
        const task = await api.create({
          cronExpression: schedule.cron,
          timezone,
          targetAgent: session,
          targetTeamId: team.id,
          taskDescription: `【${schedule.title}】\n${fillPlaceholders(schedule.task, values, `schedule ${schedule.id}`)}`,
          createdBy: 'user',
        });
        ctx.deployment.schedules[schedule.id] = task.id;
        items.push({ id: schedule.id, label: schedule.title, status: 'done', message: `${schedule.cron}（${timezone}）→ ${memberName}` });
      } catch (error) {
        failed += 1;
        items.push({ id: schedule.id, label: schedule.title, status: 'failed', message: errorText(error) });
      }
    }
    if (failed > 0) return { status: 'failed', items, error: `${failed} 个定时任务没排上`, message: '有定时任务没排上，重新部署会再试' };
    return { status: 'done', items, message: `排好 ${items.length} 个定时任务` };
  }

  /**
   * A valid timezone from a (placeholder) value, the bundle's, or the default.
   *
   * @param ctx - Context
   * @param values - Placeholder values
   * @param override - Schedule's own timezone
   * @returns IANA timezone
   * @throws Error when the filled timezone is not valid
   */
  private timezoneFor(ctx: RunContext, values: BundleAnswers, override?: string): string {
    const raw = override ?? ctx.template.bundle.timezone ?? BUNDLE_CONSTANTS.DEFAULT_TIMEZONE;
    const tz = fillPlaceholders(raw, values, 'timezone').trim() || BUNDLE_CONSTANTS.DEFAULT_TIMEZONE;
    if (!isValidTimezone(tz)) throw new Error(`Unknown timezone "${tz}"`);
    return tz;
  }

  /** Step `first_week`: send today's tasks, schedule the rest. */
  private async stepFirstWeek(ctx: RunContext): Promise<StepOutcome> {
    const tasks = ctx.template.bundle.firstWeek ?? [];
    if (tasks.length === 0) {
      return { status: 'skipped', reason: BUNDLE_CONSTANTS.SKIP_REASONS.NOTHING_TO_DO, message: '这个方案没有第一周任务' };
    }
    const deployedAt = new Date(ctx.deployment.startedAt);
    for (const task of tasks) {
      if (ctx.deployment.firstWeek.some((t) => t.id === task.id)) continue;
      const { team, session } = await this.resolveRef(ctx, task.target);
      const tz = this.timezoneFor(ctx, this.valuesFor(ctx, team));
      ctx.deployment.firstWeek.push({
        id: task.id,
        title: task.title,
        day: task.day,
        dueAt: firstWeekDueAt(deployedAt, task.day, task.time, tz),
        teamId: team.id,
        target: session,
        status: 'scheduled',
      });
    }
    const now = this.deps.now().getTime();
    for (const state of ctx.deployment.firstWeek) {
      if ((state.status === 'scheduled' || state.status === 'failed') && Date.parse(state.dueAt) <= now && this.deps.orchestrator) {
        await this.sendFirstWeekTask(ctx, state);
      }
    }
    return this.firstWeekOutcome(ctx.deployment);
  }

  /**
   * Send one first-week task through the orchestrator and record the result.
   *
   * @param ctx - Context
   * @param state - Task state (updated in place)
   * @returns True when it was handed over
   */
  private async sendFirstWeekTask(ctx: RunContext, state: BundleFirstWeekState): Promise<boolean> {
    const orchestrator = this.deps.orchestrator;
    const spec = ctx.template.bundle.firstWeek?.find((t) => t.id === state.id);
    if (!orchestrator || !spec) return false;
    try {
      const team = await this.deps.teams.get(state.teamId);
      if (!team) throw new Error(`Team "${state.teamId}" no longer exists`);
      const member = team.members.find((m) => memberSession(m) === state.target);
      const body = fillPlaceholders(spec.task, this.valuesFor(ctx, team), `first-week ${spec.id}`);
      const result = await orchestrator.send(buildFirstWeekMessage(state, team, member?.name ?? state.target, body), {
        source: BUNDLE_CONSTANTS.FIRST_WEEK_SOURCE,
        templateId: ctx.template.id,
        teamId: team.id,
        taskId: state.id,
      });
      if (!result.forwarded) throw new Error(result.error ?? 'The orchestrator did not take it');
      state.status = 'sent';
      state.sentAt = this.deps.now().toISOString();
      state.conversationId = result.conversationId;
      delete state.error;
      return true;
    } catch (error) {
      state.status = 'failed';
      state.error = errorText(error);
      return false;
    }
  }

  /**
   * The first-week step's state from its tasks.
   *
   * @param deployment - Deployment
   * @returns Outcome
   */
  private firstWeekOutcome(deployment: BundleDeployment): StepOutcome {
    const items: BundleStepItem[] = deployment.firstWeek.map((t) => ({
      id: t.id,
      label: `第 ${t.day + 1} 天 · ${t.title}`,
      status: t.status === 'sent' ? 'done' : t.status === 'failed' ? 'failed' : 'pending',
      message: t.status === 'sent' ? '已交给团队' : t.status === 'failed' ? t.error : `排在 ${t.dueAt}`,
    }));
    const failed = deployment.firstWeek.filter((t) => t.status === 'failed').length;
    const now = this.deps.now().getTime();
    const overdue = deployment.firstWeek.filter((t) => t.status === 'scheduled' && Date.parse(t.dueAt) <= now).length;
    const sent = deployment.firstWeek.filter((t) => t.status === 'sent').length;
    const later = deployment.firstWeek.length - sent - failed - overdue;
    if (failed > 0) return { status: 'failed', items, error: `${failed} 件没交出去`, message: '有任务没交给团队，重新部署会再试' };
    if (overdue > 0) {
      return { status: 'pending', reason: BUNDLE_CONSTANTS.PENDING_REASONS.BACKEND_NOT_RUNNING, items, message: 'Crewly 启动后马上把今天的任务交给团队' };
    }
    return { status: 'done', items, message: `已交给团队 ${sent} 件${later > 0 ? `，另外 ${later} 件按天排好` : ''}` };
  }
}
