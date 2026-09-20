/**
 * The desktop task runtime — subgoals, checkpoints, budgets, escalation.
 *
 * Phase 4 of docs/research/computer-use-capability-assessment.md, and the one
 * the document calls the dividing line for unattended work. Phases 1–3 gave
 * an agent safe, precise, one-call access to the desktop. None of that stops
 * a forty-step task from going wrong in the four ways §5.1 lists, because
 * every one of them is about the *shape* of the attempt rather than any
 * single action:
 *
 *   - taking the GUI route when a skill would have done it  → the router
 *   - drifting onto a state that changed at step 15         → checkpoints
 *   - reporting success that never happened                 → checkpoints
 *   - doing something irreversible unasked                  → confirmation
 *
 * A subgoal is not finished when the agent says so. It is finished when its
 * checkpoint holds, and the runtime is what refuses to move on until it does.
 *
 * @module runtime/desktop-task-runtime
 */

import { evaluateCheckpoint, describeCheckpoint, type Checkpoint, type CheckpointDeps, type CheckpointResult } from './desktop-checkpoint.js';
import { detectSurprise, shouldRetryAfter, type Scene, type Surprise } from './desktop-recovery.js';

/** One step of the plan. */
export interface Subgoal {
  id: string;
  /** What to achieve, in the agent's own words. */
  goal: string;
  /** How the runtime will know it happened. */
  checkpoint: Checkpoint;
  /** Steps this subgoal may take before it is declared stuck. */
  maxSteps?: number;
}

/** Where a subgoal stands. */
export type SubgoalState = 'pending' | 'active' | 'done' | 'stuck' | 'skipped';

/** A subgoal plus its progress. */
export interface SubgoalProgress {
  subgoal: Subgoal;
  state: SubgoalState;
  stepsUsed: number;
  /** Surprises handled while working on it, by kind. */
  recoveries: Record<string, number>;
  /** Why it is stuck, when it is. */
  blockedBy?: string;
  lastCheck?: CheckpointResult;
}

/** Caps for a whole task. */
export interface TaskBudget {
  /** Total steps across every subgoal. */
  maxSteps: number;
  /** Wall-clock milliseconds. */
  maxDurationMs: number;
  /** Steps any one subgoal may take when it does not say. */
  defaultSubgoalSteps: number;
}

/** Sensible caps. A desktop task that needs more than this has gone wrong. */
export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxSteps: 120,
  maxDurationMs: 15 * 60 * 1000,
  defaultSubgoalSteps: 20,
};

/** The layers an action can be taken at, cheapest and most reliable first. */
export type Route = 'skill' | 'browser' | 'element' | 'pixel' | 'human';

/** What the runtime says to do next. */
export type Directive =
  /** Keep working on this subgoal. */
  | { kind: 'continue'; subgoal: Subgoal; stepsLeft: number; hint?: string }
  /** The checkpoint held; here is the next subgoal. */
  | { kind: 'advance'; completed: Subgoal; next: Subgoal }
  /** Everything's checkpoint held. */
  | { kind: 'done'; summary: string }
  /** Something needs a person. */
  | { kind: 'escalate'; reason: string; detail: string }
  /** An irreversible action is waiting on the owner. */
  | { kind: 'await-confirmation'; action: string; detail: string }
  /** The budget ran out. */
  | { kind: 'budget-exhausted'; reason: string; completed: string[]; remaining: string[] };

/**
 * Pick the cheapest layer that can do a thing.
 *
 * The first failure in §5.1 is an agent opening Mail.app to send an email
 * Crewly already has a skill for. Thirty clicks that can each go wrong, in
 * place of one call that cannot. The router exists to make the cheap answer
 * the obvious one.
 *
 * @param goal - The subgoal text
 * @param available - What this install can do (skill ids, connector names)
 * @returns The layer to prefer, and why
 *
 * @example
 * chooseRoute('send the summary by email', ['gmail-send'])
 * // → { route: 'skill', because: 'gmail-send does this without touching the screen' }
 */
export function chooseRoute(
  goal: string,
  available: string[] = [],
): { route: Route; because: string; candidate?: string } {
  const text = goal.toLowerCase();

  // A named skill beats everything. Matching is on the words a person would
  // use, not on the skill id, because the plan is written in prose.
  const skillHints: Array<{ words: string[]; skill: string }> = [
    { words: ['email', 'mail', '邮件'], skill: 'gmail-send' },
    { words: ['calendar', 'meeting', 'event', '日历'], skill: 'calendar-create' },
    { words: ['drive', 'upload', '上传'], skill: 'drive-upload' },
    { words: ['slack', 'channel', '频道'], skill: 'reply-channel' },
    { words: ['spreadsheet', 'sheet', '表格'], skill: 'sheets-write' },
    { words: ['doc', 'document', '文档'], skill: 'docs-write' },
  ];
  for (const hint of skillHints) {
    if (!hint.words.some((w) => text.includes(w))) continue;
    if (available.includes(hint.skill)) {
      return {
        route: 'skill',
        candidate: hint.skill,
        because: `${hint.skill} does this without touching the screen — no clicks to misfire.`,
      };
    }
  }

  // No trailing \b on the scheme: ':' and '/' are both non-word characters,
  // so \b between them never matches and every URL fell through to `element`.
  if (/\b(web ?page|website|browser|url)\b|https?:\/\//.test(text)) {
    return { route: 'browser', because: 'A page is DOM, so the browser tools are exact where coordinates are not.' };
  }

  if (/\b(draw|canvas|game|sketch|paint)\b/.test(text)) {
    return { route: 'pixel', because: 'Nothing here exposes elements, so coordinates are the only option.' };
  }

  if (/\b(sign in|log ?in|password|2fa|captcha|credential)\b/.test(text)) {
    return { route: 'human', because: 'Credentials are never entered by an agent.' };
  }

  return {
    route: 'element',
    because: 'Take a snapshot and act on refs — naming an element cannot miss the way a coordinate can.',
  };
}

/** Phrases that mean an action cannot be taken back. */
const IRREVERSIBLE = [
  'send', 'submit', 'publish', 'post', 'delete', 'remove', 'erase', 'empty trash',
  'pay', 'purchase', 'buy', 'transfer', 'confirm order', 'deploy', 'merge',
  '发送', '提交', '发布', '删除', '付款', '购买',
];

/**
 * Whether an action needs the owner's word before it happens.
 *
 * Deliberately generous: a false positive costs one notification, a false
 * negative sends an email that cannot be unsent. §5.8 makes the confirmation
 * asynchronous precisely so that being generous here is cheap — the owner
 * answers from their phone and the machine is not blocked meanwhile.
 *
 * @param action - What the agent is about to do, in words
 * @returns Whether to ask first, and the phrase that triggered it
 *
 * @example
 * needsConfirmation('click the Send button') // → { required: true, trigger: 'send' }
 */
export function needsConfirmation(action: string): { required: boolean; trigger?: string } {
  const text = action.toLowerCase();
  for (const phrase of IRREVERSIBLE) {
    // Word boundaries for Latin phrases; CJK has none, so substring is right.
    const pattern = /[a-z]/.test(phrase) ? new RegExp(`\\b${phrase}\\b`) : null;
    if (pattern ? pattern.test(text) : text.includes(phrase)) {
      return { required: true, trigger: phrase };
    }
  }
  return { required: false };
}

/** Everything the runtime remembers about one task. */
export interface TaskState {
  goal: string;
  progress: SubgoalProgress[];
  budget: TaskBudget;
  startedAt: number;
  stepsUsed: number;
  /** Set while an irreversible action waits on the owner. */
  awaitingConfirmation?: { action: string; since: number };
}

/**
 * Start a task.
 *
 * @param goal - The whole task, in words
 * @param subgoals - The plan
 * @param budget - Caps; defaults are usually right
 * @param now - Clock, injectable for tests
 * @returns Fresh state
 */
export function beginTask(
  goal: string,
  subgoals: Subgoal[],
  budget: TaskBudget = DEFAULT_TASK_BUDGET,
  now: () => number = Date.now,
): TaskState {
  return {
    goal,
    budget,
    startedAt: now(),
    stepsUsed: 0,
    progress: subgoals.map((subgoal, index) => ({
      subgoal,
      state: index === 0 ? 'active' : 'pending',
      stepsUsed: 0,
      recoveries: {},
    })),
  };
}

/** The subgoal being worked on, if any. */
export function activeSubgoal(state: TaskState): SubgoalProgress | undefined {
  return state.progress.find((p) => p.state === 'active');
}

/**
 * Advance the task by one step's worth of thinking.
 *
 * Called after each action the agent takes. It checks the budget, looks for a
 * surprise, tests the checkpoint, and says what to do next — which is the
 * whole point: the decision to move on is the runtime's, not the agent's.
 *
 * @param state - Mutated in place with progress
 * @param scene - What is on screen now, for surprise detection
 * @param deps - IO for checkpoint evaluation
 * @param now - Clock
 * @returns What the agent should do next
 */
export async function step(
  state: TaskState,
  scene: Scene,
  deps: CheckpointDeps = {},
  now: () => number = Date.now,
): Promise<Directive> {
  const completed = () => state.progress.filter((p) => p.state === 'done').map((p) => p.subgoal.goal);
  const remaining = () => state.progress.filter((p) => p.state !== 'done').map((p) => p.subgoal.goal);

  if (state.awaitingConfirmation) {
    return {
      kind: 'await-confirmation',
      action: state.awaitingConfirmation.action,
      detail: 'Waiting for the owner to approve. Do nothing else until they answer.',
    };
  }

  state.stepsUsed += 1;
  const current = activeSubgoal(state);
  if (!current) {
    return { kind: 'done', summary: `All ${state.progress.length} subgoals verified.` };
  }
  current.stepsUsed += 1;

  // Budget before anything else: an exhausted task should stop, not spend its
  // last step discovering a surprise it has no budget to handle.
  if (state.stepsUsed > state.budget.maxSteps) {
    return {
      kind: 'budget-exhausted',
      reason: `Used ${state.stepsUsed} steps of ${state.budget.maxSteps}.`,
      completed: completed(),
      remaining: remaining(),
    };
  }
  if (now() - state.startedAt > state.budget.maxDurationMs) {
    return {
      kind: 'budget-exhausted',
      reason: `Ran for longer than ${Math.round(state.budget.maxDurationMs / 60000)} minutes.`,
      completed: completed(),
      remaining: remaining(),
    };
  }

  // A surprise means the screen is not what the plan assumed. Checking the
  // checkpoint now would test the wrong world.
  const surprise = detectSurprise(scene, sceneAppFor(current));
  if (surprise) {
    const kind = surprise.kind;
    current.recoveries[kind] = (current.recoveries[kind] ?? 0) + 1;
    const verdict = shouldRetryAfter(kind, current.recoveries[kind] - 1, surprise.selfRecoverable);
    if (!verdict.retry) {
      current.state = 'stuck';
      current.blockedBy = surprise.detail;
      // The surprise's own instruction is the actionable half ("this is the
      // owner's decision, tell them what is being asked"); dropping it for
      // the generic escalation line would lose exactly the useful part.
      return {
        kind: 'escalate',
        reason: surprise.kind,
        detail: [surprise.detail, surprise.instruction, verdict.escalation].filter(Boolean).join(' '),
      };
    }
    return { kind: 'continue', subgoal: current.subgoal, stepsLeft: stepsLeftFor(current, state), hint: surprise.instruction };
  }

  // The only thing that completes a subgoal.
  const check = await evaluateCheckpoint(current.subgoal.checkpoint, deps);
  current.lastCheck = check;

  if (check.passed) {
    current.state = 'done';
    const next = state.progress.find((p) => p.state === 'pending');
    if (!next) {
      return { kind: 'done', summary: `All ${state.progress.length} subgoals verified.` };
    }
    next.state = 'active';
    return { kind: 'advance', completed: current.subgoal, next: next.subgoal };
  }

  const left = stepsLeftFor(current, state);
  if (left <= 0) {
    current.state = 'stuck';
    current.blockedBy = check.reason ?? 'The checkpoint never held.';
    return {
      kind: 'escalate',
      reason: 'subgoal-stuck',
      detail:
        `"${current.subgoal.goal}" used its whole budget and ${describeCheckpoint(current.subgoal.checkpoint)} is still false. ` +
        `${check.reason ?? ''} Report what you tried rather than continuing — the later subgoals assume this one worked.`.trim(),
    };
  }

  return {
    kind: 'continue',
    subgoal: current.subgoal,
    stepsLeft: left,
    // The reason is the useful part: "the file is empty" tells the agent the
    // save dialog is still open, where "not done" tells it nothing.
    hint: check.reason,
  };
}

/** Steps this subgoal has left. */
function stepsLeftFor(progress: SubgoalProgress, state: TaskState): number {
  const cap = progress.subgoal.maxSteps ?? state.budget.defaultSubgoalSteps;
  return cap - progress.stepsUsed;
}

/** The app a subgoal implies, for focus-loss detection. */
function sceneAppFor(progress: SubgoalProgress): string | undefined {
  const cp = progress.subgoal.checkpoint;
  if (cp.kind === 'app-frontmost') return cp.app;
  if ((cp.kind === 'element-present' || cp.kind === 'element-absent') && cp.app) return cp.app;
  return undefined;
}

/**
 * Hold the task while the owner approves something irreversible.
 *
 * The machine is not blocked — nothing else is running — but the agent is,
 * which is the point: the owner answers from wherever they are and the task
 * picks up where it stopped.
 *
 * @param state - Mutated
 * @param action - What is waiting
 * @param now - Clock
 */
export function awaitConfirmation(state: TaskState, action: string, now: () => number = Date.now): void {
  state.awaitingConfirmation = { action, since: now() };
}

/**
 * Record the owner's answer.
 *
 * @param state - Mutated
 * @param approved - Their decision
 * @returns What to do next
 */
export function resolveConfirmation(state: TaskState, approved: boolean): Directive {
  const pending = state.awaitingConfirmation;
  state.awaitingConfirmation = undefined as TaskState['awaitingConfirmation'];
  if (!pending) {
    return { kind: 'escalate', reason: 'no-pending-confirmation', detail: 'Nothing was waiting for approval.' };
  }
  if (approved) {
    const current = activeSubgoal(state);
    return current
      ? { kind: 'continue', subgoal: current.subgoal, stepsLeft: stepsLeftFor(current, state), hint: `Approved: ${pending.action}. Go ahead.` }
      : { kind: 'done', summary: 'Approved, and nothing left to do.' };
  }
  const current = activeSubgoal(state);
  if (current) {
    current.state = 'skipped';
    current.blockedBy = `The owner declined: ${pending.action}`;
  }
  return {
    kind: 'escalate',
    reason: 'declined',
    detail: `The owner declined "${pending.action}". Do not look for another way to do it — stop and report.`,
  };
}

/**
 * A plain-language account of where the task stands.
 *
 * This is what gets reported when the task ends, for whatever reason, so it
 * has to be true rather than encouraging: a stuck subgoal is named as stuck.
 *
 * @param state - The task
 * @returns Lines for the owner
 */
export function summarize(state: TaskState): string {
  const mark: Record<SubgoalState, string> = {
    done: '✓', stuck: '✗', skipped: '—', active: '→', pending: '·',
  };
  const lines = state.progress.map((p) => {
    const base = `${mark[p.state]} ${p.subgoal.goal}`;
    if (p.state === 'done') return `${base}  (verified: ${describeCheckpoint(p.subgoal.checkpoint)})`;
    if (p.blockedBy) return `${base}  — ${p.blockedBy}`;
    return base;
  });
  const done = state.progress.filter((p) => p.state === 'done').length;
  return [`${done}/${state.progress.length} verified · ${state.stepsUsed} steps`, ...lines].join('\n');
}
