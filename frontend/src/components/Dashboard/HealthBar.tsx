/**
 * HealthBar Component
 *
 * Compact single-row summary bar for the Dashboard showing:
 * - Running agents count
 * - Projects count
 * - Teams count
 * - Tasks in-progress / completed
 * - Security shield indicator
 *
 * Replaces the previous multi-row stat summary at the top of the dashboard.
 *
 * @module components/Dashboard/HealthBar
 */

import React from 'react';
import {
  Activity,
  FolderOpen,
  Users,
  ListChecks,
  Shield,
  Factory,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for a single stat item inside the health bar. */
interface StatItemProps {
  /** Lucide icon component to render. */
  icon: React.FC<React.SVGProps<SVGSVGElement>>;
  /** Numeric or string value for the stat. */
  value: string | number;
  /** Short label displayed beside the value. */
  label: string;
  /** Optional accent color class for the value text. */
  valueColor?: string;
  /** Optional subtitle shown below label (e.g. "3 completed"). */
  subtitle?: string;
}

export interface HealthBarProps {
  /** Number of currently running (active) agents. */
  runningAgents: number;
  /** Total number of projects. */
  projectCount: number;
  /** Total number of teams. */
  teamCount: number;
  /** Number of tasks currently in progress. */
  tasksInProgress: number;
  /** Number of tasks completed today. */
  tasksCompleted: number;
  /** Navigate to 3D Factory view. */
  onFactoryClick: () => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Individual stat item rendered as icon + value + label.
 *
 * @param props - {@link StatItemProps}
 * @returns Compact stat display
 */
const StatItem: React.FC<StatItemProps> = ({
  icon: Icon,
  value,
  label,
  valueColor = '',
  subtitle,
}) => (
  <div className="flex items-center gap-1.5 px-3 py-1" data-testid={`health-stat-${label.toLowerCase().replace(/\s+/g, '-')}`}>
    <Icon className="w-4 h-4 text-text-secondary-dark flex-shrink-0" />
    <span className={`text-sm font-bold ${valueColor}`}>{value}</span>
    <span className="text-xs text-text-secondary-dark">{label}</span>
    {subtitle && (
      <span className="text-[10px] text-text-secondary-dark/70 ml-0.5">({subtitle})</span>
    )}
  </div>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

/**
 * Compact health bar displayed at the top of the Dashboard.
 *
 * Shows all key metrics in a single row (~10% of viewport height).
 * On mobile screens the stats wrap to two rows for readability.
 *
 * @param props - {@link HealthBarProps}
 * @returns HealthBar JSX element
 */
export const HealthBar: React.FC<HealthBarProps> = ({
  runningAgents,
  projectCount,
  teamCount,
  tasksInProgress,
  tasksCompleted,
  onFactoryClick,
}) => {
  return (
    <div
      data-testid="health-bar"
      className="flex flex-wrap items-center gap-2 px-4 py-2.5 rounded-lg border bg-surface-dark border-border-dark"
    >
      {/* Running Agents — hero stat */}
      <div className="flex items-center gap-1.5 px-3 py-1" data-testid="health-stat-agents">
        <Activity className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        <span className="text-sm font-bold text-emerald-400">{runningAgents}</span>
        <span className="text-xs text-text-secondary-dark">Agents</span>
      </div>

      <div className="w-px h-5 bg-border-dark hidden sm:block" />

      <StatItem icon={FolderOpen} value={projectCount} label="Projects" />
      <StatItem icon={Users} value={teamCount} label="Teams" />
      <StatItem
        icon={ListChecks}
        value={tasksInProgress}
        label="In Progress"
        subtitle={`${tasksCompleted} done`}
      />

      <div className="w-px h-5 bg-border-dark hidden sm:block" />

      {/* Security shield (static green for now) */}
      <div className="flex items-center gap-1 px-2 py-1" data-testid="health-security">
        <Shield className="w-4 h-4 text-emerald-400 flex-shrink-0" />
        <span className="text-xs font-medium text-emerald-400">Secure</span>
      </div>

      {/* 3D Factory quick-access button pushed to the right */}
      <button
        type="button"
        onClick={onFactoryClick}
        className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold transition-colors"
        data-testid="health-factory-btn"
      >
        <Factory className="w-4 h-4" />
        Factory
      </button>
    </div>
  );
};

export default HealthBar;
