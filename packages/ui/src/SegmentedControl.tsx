/**
 * SegmentedControl Component
 *
 * A row of mutually exclusive options that switch a view in place
 * (Grid / List, Day / Week / Month, Tap / Mouse). Use Tabs when each option
 * owns a panel of content; use this when it changes how one panel looks.
 *
 * @module components/UI/SegmentedControl
 */

import React from 'react';
import type { LucideIcon } from 'lucide-react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /** Stretch to the container's width, segments sharing it equally */
  fullWidth?: boolean;
  'aria-label'?: string;
  className?: string;
}

/**
 * Segmented control (radio group styled as joined buttons).
 *
 * @param props - {@link SegmentedControlProps}
 * @returns The control
 *
 * @example
 * ```tsx
 * <SegmentedControl value={mode} onChange={setMode} options={[{ value: 'tap', label: 'Tap' }, { value: 'mouse', label: 'Mouse' }]} />
 * ```
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  fullWidth = false,
  className = '',
  ...rest
}: SegmentedControlProps<T>): React.ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={rest['aria-label']}
      className={`${fullWidth ? 'flex w-full' : 'inline-flex'} items-center gap-1 rounded-2xl border border-border-dark bg-background-dark p-1 ${className}`}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            className={`${fullWidth ? 'flex-1' : ''} inline-flex items-center justify-center gap-1.5 rounded-[0.75rem] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm'
            } ${active ? 'bg-surface-dark text-text-primary-dark shadow-sm' : 'text-text-secondary-dark hover:text-text-primary-dark'}`}
          >
            {Icon && <Icon className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
