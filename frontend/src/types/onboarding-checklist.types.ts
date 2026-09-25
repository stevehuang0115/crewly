/**
 * First-run checklist types — mirror `/api/onboarding/*`
 * (backend `services/onboarding/onboarding-checklist.service.ts`,
 * specs/onboarding-harness-login.md Phase 3).
 *
 * @module types/onboarding-checklist
 */

/** Checklist step ids, in display order. */
export type ChecklistStepId = 'harness' | 'team' | 'first_task' | 'cloud' | 'slack';

/** Harness step detail. */
export interface HarnessStepDetail {
  orcHarness: string | null;
  installed: boolean;
  loginState: 'logged_in' | 'logged_out' | 'unknown' | null;
  error?: string;
}

/** Team step detail. */
export interface TeamStepDetail {
  teams: Array<{ id: string; name: string; templateId: string | null }>;
  /** The owner chose Blank (the orchestrator only) */
  blank: boolean;
  error?: string;
}

/** First-task step detail. */
export interface FirstTaskStepDetail {
  sentAt: string | null;
  ownerMessageSeen: boolean;
  pending: boolean;
  error?: string;
}

/** Cloud step detail. */
export interface CloudStepDetail {
  connected: boolean;
  tier: string | null;
  /** Google sign-in on Crewly Cloud that ends on the portal's token page */
  tokenPageSignInUrl: string;
  error?: string;
}

/** Slack step detail. */
export interface SlackStepDetail {
  connected: boolean;
  cloudConnected: boolean;
  error?: string;
}

/** One checklist step. */
export type ChecklistStep =
  | { id: 'harness'; done: boolean; detail: HarnessStepDetail }
  | { id: 'team'; done: boolean; detail: TeamStepDetail }
  | { id: 'first_task'; done: boolean; detail: FirstTaskStepDetail }
  | { id: 'cloud'; done: boolean; detail: CloudStepDetail }
  | { id: 'slack'; done: boolean; detail: SlackStepDetail };

/** `GET /api/onboarding/checklist` payload. */
export interface OnboardingChecklist {
  steps: ChecklistStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
  dismissed: boolean;
  dismissedAt: string | null;
}

/** A starter team (template or Blank). */
export interface OnboardingStarter {
  id: string;
  /**
   * How picking it works: `template` creates the team, `bundle` asks the
   * solution bundle's questions and deploys it, `blank` is the orchestrator
   * only. Older backends omit it (treated as template / blank).
   */
  kind?: 'template' | 'bundle' | 'blank';
  name: string;
  label: string;
  tagline: string;
  description: string;
  recommended: boolean;
  members: Array<{ name: string; role: string }>;
  suggestions: string[];
}

/** A team as returned when a starter team is created. */
export interface StarterTeam {
  id: string;
  name: string;
  members: Array<{ id: string; name: string; role: string }>;
}

/** `POST /api/onboarding/starter-team` payload. */
export interface StarterTeamResult {
  starterId: string;
  team: StarterTeam | null;
  created: boolean;
}

/** `POST /api/onboarding/first-task` payload. */
export interface FirstTaskResult {
  forwarded: boolean;
  queued: boolean;
  conversationId: string | null;
  teamId: string | null;
  sentAt: string | null;
  message: string | null;
}

/** Every step id, in display order. */
export const CHECKLIST_STEP_IDS: readonly ChecklistStepId[] = ['harness', 'team', 'first_task', 'cloud', 'slack'];

/**
 * Whether a value is a checklist step id (e.g. from `?step=`).
 *
 * @param value - Candidate
 * @returns True for a known step id
 */
export function isChecklistStepId(value: unknown): value is ChecklistStepId {
  return typeof value === 'string' && (CHECKLIST_STEP_IDS as readonly string[]).includes(value);
}

/**
 * Find a step in a checklist.
 *
 * @param checklist - Checklist (or null)
 * @param id - Step id
 * @returns The step, or undefined
 */
export function findStep<T extends ChecklistStepId>(
  checklist: OnboardingChecklist | null,
  id: T,
): Extract<ChecklistStep, { id: T }> | undefined {
  return checklist?.steps.find((s): s is Extract<ChecklistStep, { id: T }> => s.id === id);
}
