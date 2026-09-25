/**
 * Solution Bundle Types
 *
 * A solution bundle is a team template (`config/templates/*.json` or
 * `<dir>/template.json`, same format as {@link TeamTemplate}) with an extra
 * `bundle` section that turns it into a complete, sellable setup: the team,
 * its norms/SOPs and review points, skills, connectors, Slack layout,
 * recurring schedules, deploy-time questions, first-week tasks and the
 * recommended runtime and server tier. The apply engine
 * (`services/bundle/bundle-apply.service.ts`) deploys it in one step.
 *
 * Templates without `bundle` are unaffected. See specs/solution-bundles.md.
 *
 * @module types/solution-bundle
 */

import type { TemplateRole } from './team-template.types.js';

// =============================================================================
// Manifest (the `bundle` section of a template)
// =============================================================================

/** Runtimes a bundle may recommend (equal to RUNTIME_TYPES values). */
export type BundleRuntimeId = 'claude-code' | 'gemini-cli' | 'codex-cli' | 'opencode-cli' | 'crewly-agent';

/** Hosted server tier (entry 2 vCPU / 4 GB, standard 4 / 8, advanced 8 / 16). */
export type BundleServerTier = 'entry' | 'standard' | 'advanced';

/** `ready` bundles are offered to owners; `draft` ones need `allowDraft`. */
export type BundleStatus = 'ready' | 'draft';

/** Input control of a deploy-time question. */
export type BundleQuestionType = 'text' | 'textarea' | 'select' | 'multiselect';

/** One option of a select / multiselect question. */
export interface BundleQuestionOption {
  /** Stored value (what fills the placeholder) */
  value: string;
  /** Owner-facing label (defaults to the value) */
  label?: string;
}

/**
 * A question asked of the owner at deploy time. Its answer fills
 * `{{<id>}}` placeholders in prompts, norms, SOPs, schedules and tasks.
 */
export interface BundleQuestion {
  /** Placeholder name: lower snake case, e.g. `business_name` */
  id: string;
  /** Owner-facing question, e.g. 公司/品牌叫什么？ */
  label: string;
  /** One-line hint under the field */
  help?: string;
  /** Input control */
  type: BundleQuestionType;
  /** Required questions have no default; optional ones must declare one */
  required: boolean;
  /** Choices for select / multiselect */
  options?: BundleQuestionOption[];
  /** Value used when an optional question is left empty */
  default?: string | string[];
  /** Example shown inside an empty field */
  placeholder?: string;
}

/** Recommended runtime (model harness) for the bundle's agents. */
export interface BundleRuntime {
  /** The runtime this bundle is designed and priced for */
  recommended: BundleRuntimeId;
  /** Other runtimes it works on */
  compatible?: BundleRuntimeId[];
  /** Model hint shown to the owner, e.g. `deepseek-chat` */
  model?: string;
  /** Why this runtime (owner-facing, short) */
  reason?: string;
}

/** Recommended hosted server. Absorbs the old `cloud-deploy.json` `deployConfig`. */
export interface BundleServer {
  /** Tier the bundle fits on */
  tier: BundleServerTier;
  /** Minimum vCPUs */
  minVcpu?: number;
  /** Minimum memory in GB */
  minMemoryGb?: number;
  /** Needs a real browser (Chrome) on the server */
  requiresBrowser?: boolean;
  /** Needs git on the server */
  requiresGit?: boolean;
}

/** Usage estimate (for pricing the hosted monthly fee). */
export interface BundleUsage {
  /** Agent runs per day, all members together */
  runsPerDay?: number;
  /** Average prompt tokens per run */
  tokensPerRun?: number;
  /** Free-text note, e.g. how the estimate was measured */
  note?: string;
}

/** A team norm (operating agreement) written to `teams/<id>/norms/<id>.md`. */
export interface BundleNorm {
  /** File name without `.md` (kebab case) */
  id: string;
  /** Title (frontmatter) */
  title: string;
  /** Comma-separated triggers, e.g. `before_publish,content_review` */
  trigger?: string;
  /** Markdown body (placeholders allowed) — or `file` */
  content?: string;
  /** Path of the body, relative to the template directory */
  file?: string;
  /** Team key (defaults to the main team) */
  team?: string;
}

/** A team SOP written to `teams/<id>/sops/<category>/<id>.md`. */
export interface BundleSop {
  /** File name without `.md` (kebab case) */
  id: string;
  /** Title (frontmatter) */
  title: string;
  /** Category folder (defaults to `team`) */
  category?: string;
  /** Markdown body (placeholders allowed) — or `file` */
  content?: string;
  /** Path of the body, relative to the template directory */
  file?: string;
  /** Team key (defaults to the main team) */
  team?: string;
}

/** Something the team must get the owner's (or the lead's) OK for. */
export interface BundleReviewPoint {
  /** Stable id */
  id: string;
  /** What needs approval, e.g. 任何要对外发布的内容 */
  what: string;
  /** Who approves */
  approver: 'owner' | 'lead';
  /** How to ask, e.g. 在 Slack 私信里发预览，老板回「可以」才发 */
  how?: string;
  /** Team key (defaults to the main team) */
  team?: string;
}

/** Skills the bundle needs installed. */
export interface BundleSkills {
  /** Installed at deploy (bundled ones are already there) */
  required: string[];
  /** Nice to have; failures are reported, not fatal */
  optional?: string[];
}

/** A service the owner connects (the /connections cards). */
export interface BundleConnector {
  /** Connector id, e.g. `google-workspace`, `canva`, `whatsapp` */
  id: string;
  /** Google products for `google-workspace`: gmail, calendar, drive */
  products?: string[];
  /** Whether the team cannot do its core job without it */
  required: boolean;
  /** Owner-facing reason, e.g. 用来读客户来信、起草回复 */
  why: string;
}

/** An extra Slack channel (every team also gets its own team channel). */
export interface BundleSlackChannel {
  /** Stable key */
  key: string;
  /** Channel name (placeholders allowed; made Slack-legal) */
  name: string;
  /** Channel purpose */
  purpose?: string;
  /** Member refs (`role`, `team/role`) or `*` for every member of every team */
  members: string[];
}

/** Slack layout. */
export interface BundleSlack {
  /** Give every team its own channel (default true) */
  teamChannels?: boolean;
  /** Extra channels */
  channels?: BundleSlackChannel[];
}

/** A recurring task (created through the cron-task scheduler). */
export interface BundleSchedule {
  /** Stable id */
  id: string;
  /** Owner-facing name, e.g. 每日简报 */
  title: string;
  /** Five-field cron expression, e.g. `0 9 * * 1-5` */
  cron: string;
  /** IANA timezone (placeholders allowed); defaults to the bundle timezone */
  timezone?: string;
  /** Member ref that receives it (`role` or `team/role`); defaults to the main lead */
  target?: string;
  /** What the agent is asked to do (placeholders allowed) */
  task: string;
}

/** A task for the first week, so the owner sees output right away. */
export interface BundleFirstWeekTask {
  /** Stable id */
  id: string;
  /** 0 = right after deploy, 1 = the next day, … up to 6 */
  day: number;
  /** `HH:MM` for days ≥ 1 (bundle timezone); defaults to 09:00 */
  time?: string;
  /** Member ref it is meant for; defaults to the main lead */
  target?: string;
  /** Owner-facing name */
  title: string;
  /** The task (placeholders allowed) */
  task: string;
}

/** An extra team (the template's own `roles` form the main team). */
export interface BundleTeamSpec {
  /** Stable key used in refs (`key/role`) */
  key: string;
  /** Team name (placeholders allowed) */
  name: string;
  /** Team description (placeholders allowed) */
  description?: string;
  /** Roles, same shape as a template's `roles` */
  roles: TemplateRole[];
}

/**
 * The `bundle` section of a team template.
 */
export interface SolutionBundle {
  /** Must equal BUNDLE_CONSTANTS.SCHEMA_VERSION */
  schemaVersion: number;
  /** `ready` (default) or `draft` */
  status?: BundleStatus;
  /** Short owner-facing name, e.g. 小老板营销团队 */
  label: string;
  /** One-line pitch */
  tagline: string;
  /** What the team does for the owner each day/week (owner-facing, a few lines) */
  ownerSummary: string;
  /** What the owner has to do, e.g. 在手机上点头 */
  ownerDoes?: string[];
  /** Recommended runtime */
  runtime: BundleRuntime;
  /** Recommended hosted server */
  server: BundleServer;
  /** Usage estimate */
  usage?: BundleUsage;
  /** Default timezone of schedules and first-week tasks (placeholders allowed) */
  timezone?: string;
  /** Main team name (placeholders allowed); defaults to the template name */
  teamName?: string;
  /** Extra teams */
  teams?: BundleTeamSpec[];
  /** Deploy-time questions */
  questions?: BundleQuestion[];
  /** Team norms */
  norms?: BundleNorm[];
  /** Team SOPs */
  sops?: BundleSop[];
  /** What needs the owner's OK */
  reviewPoints?: BundleReviewPoint[];
  /** Skills to install */
  skills?: BundleSkills;
  /** Services to connect */
  connectors?: BundleConnector[];
  /** Slack layout */
  slack?: BundleSlack;
  /** Recurring tasks */
  schedules?: BundleSchedule[];
  /** First-week tasks */
  firstWeek?: BundleFirstWeekTask[];
  /** Open items for the template's authors (drafts) */
  todo?: string[];
}

/**
 * The template fields the engine reads, plus `bundle`. Any template JSON
 * (flat file or `<dir>/template.json`) that carries a `bundle` section.
 */
export interface BundleTemplate {
  id: string;
  name: string;
  description: string;
  version?: string;
  category?: string;
  /** Minimum Cloud tier (free when omitted) */
  requiredTier?: string;
  /** Crewly Pro license tier (`pro` / `enterprise`) */
  tier?: string;
  hierarchical?: boolean;
  mission?: string;
  roles: TemplateRole[];
  bundle: SolutionBundle;
}

/** A bundle template and the directory its relative files resolve against. */
export interface LoadedBundle {
  template: BundleTemplate;
  /** Directory of `template.json`, or the directory of a flat template file */
  dir: string;
  /** Absolute path of the JSON file */
  file: string;
}

// =============================================================================
// Deployment state (apply engine)
// =============================================================================

/** State of one apply step. */
export type BundleStepStatus = 'queued' | 'running' | 'done' | 'failed' | 'pending' | 'skipped';

/** State of one item inside a step (a skill, a channel, a schedule…). */
export interface BundleStepItem {
  id: string;
  label: string;
  status: 'done' | 'failed' | 'pending' | 'skipped';
  message?: string;
}

/** One apply step. */
export interface BundleStepState {
  id: string;
  /** Owner-facing label */
  label: string;
  status: BundleStepStatus;
  /** Why the step is pending / skipped (a BUNDLE_CONSTANTS reason) */
  reason?: string;
  /** Owner-facing summary */
  message?: string;
  /** Error text when failed */
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  items?: BundleStepItem[];
}

/** A team the deployment created. */
export interface BundleDeployedTeam {
  key: string;
  teamId: string;
  name: string;
}

/** A connector's state at the last check. */
export interface BundleConnectorState {
  id: string;
  products: string[];
  required: boolean;
  why: string;
  status: 'connected' | 'not_connected' | 'unknown';
  /** Relative link to connect it, e.g. `/connections?platform=canva` */
  connectPath: string;
}

/** A first-week task's delivery state. */
export interface BundleFirstWeekState {
  id: string;
  title: string;
  day: number;
  /** When it is (or was) due */
  dueAt: string;
  teamId: string;
  /** Session of the member it is meant for */
  target: string;
  status: 'scheduled' | 'sent' | 'failed';
  sentAt?: string;
  conversationId?: string | null;
  error?: string;
}

/** Overall deployment status. */
export type BundleDeploymentStatus = 'running' | 'done' | 'partial' | 'failed';

/**
 * What a deployment of one template on this machine looks like. Persisted at
 * `<crewlyHome>/bundles/<templateId>.json` after every step, so a re-run
 * resumes where the last one stopped.
 */
export interface BundleDeployment {
  templateId: string;
  templateVersion: string;
  /** Last apply job */
  jobId: string;
  status: BundleDeploymentStatus;
  runtime: string;
  /** Answers after defaults were applied */
  answers: Record<string, string | string[]>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  teams: BundleDeployedTeam[];
  steps: BundleStepState[];
  connectors: BundleConnectorState[];
  firstWeek: BundleFirstWeekState[];
  /** Schedule id → cron task id */
  schedules: Record<string, string>;
  /** Channel key → Slack channel id */
  channels: Record<string, string>;
}
