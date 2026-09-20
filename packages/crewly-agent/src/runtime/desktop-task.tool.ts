/**
 * `desktop_task` tool — the task runtime, plugged in.
 *
 * Phase 4 built the machinery that decides when a desktop subgoal is really
 * done; this is what connects it to an agent. Without it the runtime was a
 * tested library nothing called, which is the least useful state for a piece
 * of safety machinery to be in.
 *
 * Three things make it hard to bypass rather than merely available:
 *
 *   - `step` is the only way to advance. An agent cannot mark a subgoal done;
 *     it asks, and the checkpoint answers.
 *   - `summary` reports unverified subgoals as unverified. A turn that ends
 *     with work outstanding says so in the same words the owner would use.
 *   - An irreversible action goes to the approval queue that already exists,
 *     so the owner answers it wherever they already answer approvals.
 *
 * The tool holds one task per agent session. A desktop has one mouse, so an
 * agent running two desktop tasks at once is a bug rather than a use case.
 *
 * @module runtime/desktop-task.tool
 */

import { z } from 'zod';
import type { ToolDefinition } from './types.js';
import type { ApprovalQueueService } from './approval-queue.service.js';
import {
  beginTask, step as runtimeStep, summarize, activeSubgoal, chooseRoute,
  needsConfirmation, awaitConfirmation, resolveConfirmation,
  DEFAULT_TASK_BUDGET, type Subgoal, type TaskState, type Directive,
} from './desktop-task-runtime.js';
import type { Checkpoint, CheckpointDeps } from './desktop-checkpoint.js';
import type { Scene, SceneElement } from './desktop-recovery.js';

/** What the tool needs from the outside world. */
export interface DesktopTaskDeps {
  /** Run a computer-use action; used to read the scene and test checkpoints. */
  perceive?: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Where an irreversible action goes for the owner to answer. */
  approvals?: Pick<ApprovalQueueService, 'enqueue'>;
  /** Skills this install has, so the router can prefer one over the screen. */
  availableSkills?: string[];
  now?: () => number;
}

/** One task per session: a desktop has one mouse. */
const tasks = new Map<string, TaskState>();

/** Approval ids waiting on the owner, by session. */
const pendingApprovals = new Map<string, string>();

/** Drop a session's task (tests, and session teardown). */
export function resetDesktopTasks(): void {
  tasks.clear();
  pendingApprovals.clear();
}

/** The checkpoint shapes an agent may declare. Mirrors {@link Checkpoint}. */
const checkpointSchema = z.union([
  z.object({ kind: z.literal('file-exists'), path: z.string(), allowEmpty: z.boolean().optional() }),
  z.object({ kind: z.literal('file-contains'), path: z.string(), text: z.string() }),
  z.object({ kind: z.literal('file-matches'), path: z.string(), pattern: z.string() }),
  z.object({ kind: z.literal('file-absent'), path: z.string() }),
  z.object({ kind: z.literal('app-frontmost'), app: z.string() }),
  z.object({ kind: z.literal('element-present'), name: z.string(), role: z.string().optional(), app: z.string().optional() }),
  z.object({ kind: z.literal('element-absent'), name: z.string(), app: z.string().optional() }),
  z.object({ kind: z.literal('text-on-screen'), text: z.string() }),
  z.object({ kind: z.literal('shell'), command: z.string(), description: z.string().optional() }),
]);

const schema = z.object({
  operation: z.enum(['plan', 'step', 'confirm', 'summary', 'abandon'])
    .describe('plan a task, take a step, ask the owner about something irreversible, report, or give up.'),
  goal: z.string().optional().describe('The whole task, for `plan`.'),
  subgoals: z.array(z.object({
    goal: z.string().describe('What to achieve, in your own words.'),
    checkpoint: checkpointSchema.describe('How the runtime will know it happened — not your say-so.'),
    maxSteps: z.number().optional(),
  })).optional().describe('The plan, for `plan`. Three to six subgoals is usually right.'),
  action: z.string().optional().describe('For `confirm`: the irreversible thing you are about to do.'),
  reason: z.string().optional().describe('For `abandon`: why you are stopping.'),
});

/**
 * Turn a directive into something a model can act on without re-reading the
 * whole plan every step.
 *
 * @param directive - From the runtime
 * @param state - Current task
 * @returns The tool result
 */
function renderDirective(directive: Directive, state: TaskState): Record<string, unknown> {
  const base = { success: true, directive: directive.kind };
  switch (directive.kind) {
    case 'continue':
      return {
        ...base,
        subgoal: directive.subgoal.goal,
        stepsLeft: directive.stepsLeft,
        // The hint is the reason the checkpoint did not hold, or what the
        // surprise was. It is the actionable part; the goal is just context.
        ...(directive.hint ? { hint: directive.hint } : {}),
      };
    case 'advance':
      return { ...base, verified: directive.completed.goal, next: directive.next.goal };
    case 'done':
      return { ...base, summary: summarize(state), message: directive.summary };
    case 'escalate':
      return {
        ...base, success: false, reason: directive.reason, message: directive.detail,
        summary: summarize(state),
      };
    case 'await-confirmation':
      return { ...base, waitingFor: directive.action, message: directive.detail };
    case 'budget-exhausted':
      return {
        ...base, success: false, reason: 'budget_exhausted', message: directive.reason,
        completed: directive.completed, remaining: directive.remaining, summary: summarize(state),
      };
  }
}

/**
 * Read the screen into the shape the surprise detector wants.
 *
 * A failed or missing snapshot yields an empty scene rather than throwing:
 * not being able to look is itself worth continuing past, and the checkpoint
 * will fail honestly a moment later.
 *
 * @param deps - Injected IO
 * @returns The scene
 */
async function readScene(deps: DesktopTaskDeps): Promise<Scene> {
  if (!deps.perceive) return { elements: [] };
  const snap = await deps.perceive({ action: 'snapshot' }).catch(() => null);
  if (!snap || snap['success'] === false) {
    return {
      elements: [],
      ...(snap ? { lastFailure: { reason: String(snap['reason'] ?? ''), message: String(snap['message'] ?? '') } } : {}),
    };
  }
  const elements = (snap['elements'] as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    ...(snap['app'] ? { app: String(snap['app']) } : {}),
    elements: elements.map((e): SceneElement => ({
      role: String(e['role'] ?? ''),
      ...(e['name'] ? { name: String(e['name']) } : {}),
      ...(e['subrole'] ? { subrole: String(e['subrole']) } : {}),
    })),
  };
}

/** Checkpoint IO backed by the desktop, for the screen-reading kinds. */
function checkpointDeps(deps: DesktopTaskDeps): CheckpointDeps {
  if (!deps.perceive) return {};
  return {
    snapshot: async (app?: string) => {
      const snap = await deps.perceive!({ action: 'snapshot', ...(app ? { app } : {}) });
      const elements = (snap['elements'] as Array<Record<string, unknown>> | undefined) ?? [];
      return elements.map((e) => ({
        role: String(e['role'] ?? ''),
        ...(e['name'] ? { name: String(e['name']) } : {}),
      }));
    },
    screenText: async () => {
      const out = await deps.perceive!({ action: 'ocr' });
      const items = (out['items'] as Array<Record<string, unknown>> | undefined) ?? [];
      return items.map((i) => String(i['text'] ?? ''));
    },
    frontmostApp: async () => {
      const out = await deps.perceive!({ action: 'snapshot' });
      return String(out['app'] ?? '');
    },
  };
}

/**
 * Build the `desktop_task` tool.
 *
 * @param sessionName - Whose task this is
 * @param deps - Injected IO
 * @returns The tool definition
 */
export function createDesktopTaskTool(sessionName: string, deps: DesktopTaskDeps = {}): ToolDefinition {
  const now = deps.now ?? Date.now;

  return {
    description:
      'Run a multi-step desktop task so it cannot end in a false "done". ' +
      'Call `plan` once with subgoals and a checkpoint for each — a checkpoint is something outside you that ' +
      'proves the subgoal happened (a file with the right contents, a dialog that is gone, an app in front). ' +
      'Then use the `computer` tool to work, and call `step` after each action: it tells you whether the ' +
      'checkpoint held, what changed unexpectedly, and when to move on. ' +
      'Call `confirm` before anything irreversible (sending, deleting, publishing, paying) — the owner answers. ' +
      'You cannot mark a subgoal done yourself; that is the point.',
    inputSchema: schema,
    sensitivity: 'sensitive',
    execute: async (rawArgs) => {
      const args = rawArgs as z.infer<typeof schema>;
      const existing = tasks.get(sessionName);

      switch (args.operation) {
        case 'plan': {
          if (!args.goal || !args.subgoals?.length) {
            return { success: false, reason: 'validation', message: 'plan needs `goal` and at least one subgoal.' };
          }
          const subgoals: Subgoal[] = args.subgoals.map((s, i) => ({
            id: `s${i + 1}`,
            goal: s.goal,
            checkpoint: s.checkpoint as Checkpoint,
            ...(s.maxSteps ? { maxSteps: s.maxSteps } : {}),
          }));
          const state = beginTask(args.goal, subgoals, DEFAULT_TASK_BUDGET, now);
          tasks.set(sessionName, state);

          // The route is advice given once, up front, where it can still
          // change what the agent does — after it has opened an app it is
          // too late to say a skill would have been better.
          const routes = subgoals.map((s) => {
            const r = chooseRoute(s.goal, deps.availableSkills ?? []);
            return { subgoal: s.goal, route: r.route, because: r.because, ...(r.candidate ? { use: r.candidate } : {}) };
          });
          return {
            success: true,
            planned: subgoals.length,
            first: subgoals[0]!.goal,
            routes,
            budget: { steps: state.budget.maxSteps, minutes: Math.round(state.budget.maxDurationMs / 60000) },
            message: 'Work on the first subgoal, then call step. You cannot skip a checkpoint.',
          };
        }

        case 'step': {
          if (!existing) {
            return { success: false, reason: 'no_task', message: 'No task planned. Call `plan` first.' };
          }
          const scene = await readScene(deps);
          const directive = await runtimeStep(existing, scene, checkpointDeps(deps), now);
          if (directive.kind === 'done' || directive.kind === 'escalate' || directive.kind === 'budget-exhausted') {
            // The task is over either way; keep the state for `summary` but
            // stop it being stepped again.
            tasks.set(sessionName, existing);
          }
          return renderDirective(directive, existing);
        }

        case 'confirm': {
          if (!existing) {
            return { success: false, reason: 'no_task', message: 'No task planned. Call `plan` first.' };
          }
          if (!args.action) {
            return { success: false, reason: 'validation', message: 'confirm needs `action` — what you are about to do.' };
          }
          const verdict = needsConfirmation(args.action);
          if (!verdict.required) {
            // Saying so beats silently approving: an agent that asks about
            // everything learns nothing, and one told "no need" learns where
            // the line is.
            return {
              success: true, required: false,
              message: `"${args.action}" is reversible — go ahead without asking.`,
            };
          }
          awaitConfirmation(existing, args.action, now);
          const approval = deps.approvals?.enqueue(sessionName, 'desktop_task', 'destructive', {
            action: args.action,
            goal: existing.goal,
            subgoal: activeSubgoal(existing)?.subgoal.goal ?? '',
          });
          if (approval) pendingApprovals.set(sessionName, approval.id);
          return {
            success: true,
            required: true,
            trigger: verdict.trigger,
            ...(approval ? { approvalId: approval.id } : {}),
            message:
              `Waiting for the owner to approve "${args.action}". Do nothing else until they answer — ` +
              'not a workaround, not a different route to the same effect.',
          };
        }

        case 'summary': {
          if (!existing) return { success: true, message: 'No task in progress.' };
          const outstanding = existing.progress.filter((p) => p.state !== 'done');
          return {
            success: true,
            complete: outstanding.length === 0,
            // Reported as unverified, not as "probably fine". This is the
            // sentence that stops a turn ending in a confident false report.
            unverified: outstanding.map((p) => p.subgoal.goal),
            summary: summarize(existing),
          };
        }

        case 'abandon': {
          tasks.delete(sessionName);
          pendingApprovals.delete(sessionName);
          return {
            success: true,
            message: `Task dropped${args.reason ? `: ${args.reason}` : ''}. Say what was and was not done.`,
            ...(existing ? { summary: summarize(existing) } : {}),
          };
        }
      }
    },
  };
}

/**
 * Record the owner's answer to a pending confirmation.
 *
 * Called by whatever surfaces approvals (the REST endpoint, Slack), not by
 * the agent — which is the whole point of the confirmation.
 *
 * @param sessionName - Whose task
 * @param approved - The owner's decision
 * @returns What the agent will be told next, or null when nothing was waiting
 */
export function answerDesktopConfirmation(sessionName: string, approved: boolean): Record<string, unknown> | null {
  const state = tasks.get(sessionName);
  if (!state?.awaitingConfirmation) return null;
  const directive = resolveConfirmation(state, approved);
  pendingApprovals.delete(sessionName);
  return renderDirective(directive, state);
}

/**
 * Whether a session has desktop work that never passed its checkpoint.
 *
 * The runner asks this at the end of a turn: a task with unverified subgoals
 * makes the turn incomplete, which is reported to the owner in the same
 * machinery that already reports a truncated or interrupted turn.
 *
 * @param sessionName - Whose task
 * @returns The unfinished subgoals, or null when there is nothing outstanding
 */
export function unverifiedDesktopWork(sessionName: string): { goals: string[]; summary: string } | null {
  const state = tasks.get(sessionName);
  if (!state) return null;
  const outstanding = state.progress.filter((p) => p.state !== 'done' && p.state !== 'skipped');
  if (outstanding.length === 0) return null;
  return { goals: outstanding.map((p) => p.subgoal.goal), summary: summarize(state) };
}
