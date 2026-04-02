/**
 * Eval Framework - Task Registry
 *
 * Aggregates all task sets (L1-L4) and provides lookup helpers.
 *
 * @module eval/tasks
 */

import type { EvalLevel, EvalTask } from '../eval-types.js';
import { L1_TASKS } from './l1-tasks.js';
import { L2_TASKS } from './l2-tasks.js';
import { L3_TASKS } from './l3-tasks.js';
import { L4_TASKS } from './l4-tasks.js';

export { L1_TASKS } from './l1-tasks.js';
export { L2_TASKS } from './l2-tasks.js';
export { L3_TASKS } from './l3-tasks.js';
export { L4_TASKS } from './l4-tasks.js';

/** All available evaluation tasks across every level */
export const ALL_TASKS: EvalTask[] = [
  ...L1_TASKS,
  ...L2_TASKS,
  ...L3_TASKS,
  ...L4_TASKS,
];

/**
 * Filter tasks by complexity level.
 *
 * @param level - the level to filter on
 * @returns tasks matching the given level
 */
export function getTasksByLevel(level: EvalLevel): EvalTask[] {
  return ALL_TASKS.filter((t) => t.level === level);
}

/**
 * Look up a single task by its unique ID.
 *
 * @param id - task identifier (e.g. "L1-01", "L4-03")
 * @returns the matching task, or undefined if not found
 */
export function getTaskById(id: string): EvalTask | undefined {
  return ALL_TASKS.find((t) => t.id === id);
}

/**
 * Get a summary of available tasks grouped by level.
 *
 * @returns object with level keys and task count + titles
 */
export function getTaskSummary(): Record<string, { count: number; tasks: Array<{ id: string; title: string }> }> {
  const levels: EvalLevel[] = ['L1', 'L2', 'L3', 'L4'];
  const summary: Record<string, { count: number; tasks: Array<{ id: string; title: string }> }> = {};

  for (const level of levels) {
    const tasks = getTasksByLevel(level);
    summary[level] = {
      count: tasks.length,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title })),
    };
  }

  return summary;
}
