/**
 * Trigger page helper utilities — pure functions for formatting, icons, etc.
 *
 * Extracted from Triggers.tsx for reuse and testability.
 *
 * @module components/Triggers/helpers
 */

import type { Trigger, TriggerType } from '../../types/trigger.types';

/**
 * Formats an ISO date string into a short human-readable format.
 * Returns an em-dash for null/undefined values.
 *
 * @param iso - ISO date string or null/undefined
 * @returns Formatted date string
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Returns a CSS class string for a trigger/cron task status badge.
 *
 * @param status - Status string (active, paused, exhausted, cancelled)
 * @returns Tailwind CSS class string
 */
export function statusBadgeClass(status: string): string {
  switch (status) {
    case 'active': return 'bg-green-500/15 text-green-400 border border-green-500/20';
    case 'paused': return 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/20';
    case 'exhausted': return 'bg-blue-500/15 text-blue-400 border border-blue-500/20';
    case 'cancelled': return 'bg-red-500/15 text-red-400 border border-red-500/20';
    default: return 'bg-surface-dark text-text-secondary-dark border border-border-dark';
  }
}

/**
 * Returns a short summary of a trigger's config.
 *
 * @param trigger - The trigger to summarize
 * @returns Human-readable config summary
 */
export function triggerConfigSummary(trigger: Trigger): string {
  const c = trigger.config;
  if (c.type === 'time') {
    if (c.cronExpression) return c.cronExpression;
    if (c.fireAt) return `Once at ${formatDate(c.fireAt)}`;
    if (c.delayMs) return `Delay ${Math.round(c.delayMs / 60000)}m`;
    return '—';
  }
  if (c.type === 'signal') return c.eventType;
  if (c.type === 'compound') return `${c.operator.toUpperCase()} (${c.conditions.length})`;
  return '—';
}

/**
 * Returns a short summary of a trigger's action.
 *
 * @param trigger - The trigger to summarize
 * @returns Human-readable action summary
 */
export function triggerActionSummary(trigger: Trigger): string {
  const a = trigger.action;
  if (a.sendMessage) return `→ ${a.sendMessage.target}`;
  if (a.createWorkItem) return 'Create WorkItem';
  if (a.wakeWorkItemId) return `Wake WorkItem`;
  if (a.runReconciler) return 'Run Reconciler';
  return '—';
}
