/**
 * Solution bundle types (frontend)
 *
 * Mirrors the `/api/bundles` contract (backend `types/solution-bundle.types.ts`
 * and `services/bundle/bundle-catalog.ts`; specs/solution-bundles.md), plus
 * the small helpers the setup flow uses.
 *
 * @module types/bundle
 */

/** Input control of a deploy-time question. */
export type BundleQuestionType = 'text' | 'textarea' | 'select' | 'multiselect';

/** A question asked of the owner at deploy time. */
export interface BundleQuestion {
  id: string;
  label: string;
  help?: string;
  type: BundleQuestionType;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
  default?: string | string[];
  placeholder?: string;
}

/** Answers by question id. */
export type BundleAnswers = Record<string, string | string[]>;

/** A service the bundle wants connected. */
export interface BundleConnectorSpec {
  id: string;
  products?: string[];
  required: boolean;
  why: string;
}

/** `GET /api/bundles/:id` → `bundle`. */
export interface BundleDetail {
  id: string;
  name: string;
  label: string;
  tagline: string;
  description: string;
  status: string;
  tier: string | null;
  recommendedRuntime: string;
  serverTier: string;
  memberCount: number;
  questionCount: number;
  ownerSummary: string;
  ownerDoes: string[];
  runtime: { recommended: string; compatible?: string[]; model?: string; reason?: string };
  server: { tier: string };
  questions: BundleQuestion[];
  teams: Array<{ key: string; name: string; members: Array<{ name: string; role: string; title: string }> }>;
  skills: string[];
  connectors: BundleConnectorSpec[];
  schedules: Array<{ id: string; title: string; cron: string }>;
  firstWeek: Array<{ id: string; day: number; title: string }>;
  channels: string[];
}

/** State of one apply step. */
export type BundleStepStatus = 'queued' | 'running' | 'done' | 'failed' | 'pending' | 'skipped';

/** One apply step. */
export interface BundleStep {
  id: string;
  label: string;
  status: BundleStepStatus;
  reason?: string;
  message?: string;
  error?: string;
  items?: Array<{ id: string; label: string; status: string; message?: string }>;
}

/** A deployment (the apply job's progress). */
export interface BundleDeployment {
  templateId: string;
  jobId: string;
  status: 'running' | 'done' | 'partial' | 'failed';
  runtime: string;
  teams: Array<{ key: string; teamId: string; name: string }>;
  steps: BundleStep[];
  connectors: Array<{ id: string; products: string[]; required: boolean; why: string; status: string; connectPath: string }>;
  firstWeek: Array<{ id: string; title: string; day: number; status: string }>;
}

/** A question the owner still has to answer. */
export interface BundleAnswerProblem {
  id: string;
  label: string;
  reason: string;
}

/**
 * Whether an apply job has stopped running.
 *
 * @param deployment - Deployment
 * @returns True once the status is not `running`
 */
export function isDeploymentFinished(deployment: Pick<BundleDeployment, 'status'>): boolean {
  return deployment.status !== 'running';
}

/**
 * Initial answers: each question's default (multiselects as lists).
 *
 * @param questions - Questions
 * @returns Answers
 */
export function initialAnswers(questions: BundleQuestion[]): BundleAnswers {
  const answers: BundleAnswers = {};
  for (const q of questions) {
    if (q.type === 'multiselect') answers[q.id] = Array.isArray(q.default) ? [...q.default] : q.default ? [q.default] : [];
    else answers[q.id] = typeof q.default === 'string' ? q.default : '';
  }
  return answers;
}

/**
 * Required questions without an answer (checked before sending; the backend
 * checks again).
 *
 * @param questions - Questions
 * @param answers - Current answers
 * @returns Ids of unanswered required questions
 */
export function missingRequiredAnswers(questions: BundleQuestion[], answers: BundleAnswers): string[] {
  return questions
    .filter((q) => {
      if (!q.required) return false;
      const value = answers[q.id];
      return Array.isArray(value) ? value.length === 0 : !value || value.trim() === '';
    })
    .map((q) => q.id);
}
