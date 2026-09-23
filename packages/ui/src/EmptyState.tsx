/**
 * EmptyState Component
 *
 * What a list, table or panel shows when there is nothing in it yet: an
 * icon, a line saying what is missing, and optionally the action that fixes
 * it.
 *
 * @module components/UI/EmptyState
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  /** Icon shown above the title */
  icon?: LucideIcon;
  /** What is missing, e.g. "No teams yet" */
  title: string;
  /** One or two sentences on why, or what to do */
  description?: React.ReactNode;
  /** The action that fills the empty space (usually a Button) */
  action?: React.ReactNode;
  /** Tighter spacing, for use inside cards and side panels */
  compact?: boolean;
  className?: string;
}

/**
 * Empty-state block for lists, tables and panels.
 *
 * @param props - {@link EmptyStateProps}
 * @returns The empty state
 *
 * @example
 * ```tsx
 * <EmptyState icon={Users} title="No teams yet" description="Create a team to start." action={<Button>New team</Button>} />
 * ```
 */
export const EmptyState: React.FC<EmptyStateProps> = ({ icon: Icon, title, description, action, compact = false, className = '' }) => (
  <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6 px-4' : 'py-12 px-6'} ${className}`}>
    {Icon && (
      <div className={`flex items-center justify-center rounded-full bg-surface-dark border border-border-dark text-text-secondary-dark ${compact ? 'w-10 h-10 mb-3' : 'w-12 h-12 mb-4'}`}>
        <Icon className={compact ? 'w-5 h-5' : 'w-6 h-6'} />
      </div>
    )}
    <h3 className={`font-semibold text-text-primary-dark ${compact ? 'text-sm' : 'text-base'}`}>{title}</h3>
    {description && <p className="mt-1 text-sm text-text-secondary-dark max-w-md">{description}</p>}
    {action && <div className="mt-4">{action}</div>}
  </div>
);
