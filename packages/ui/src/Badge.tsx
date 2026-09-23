/**
 * Badge Component
 *
 * Compact label for status, categories, or tags.
 * Supports multiple color variants for different contexts.
 *
 * @module components/UI/Badge
 */

import React from 'react';

export type BadgeVariant = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';
export type BadgeSize = 'sm' | 'md';

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Color variant of the badge */
  variant?: BadgeVariant;
  /** Size of the badge */
  size?: BadgeSize;
  /** Badge content */
  children: React.ReactNode;
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-background-dark border border-border-dark text-text-secondary-dark',
  primary: 'bg-primary/10 text-primary border border-primary/20',
  success: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20',
  warning: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20',
  error: 'bg-red-500/10 text-red-400 border border-red-500/20',
  info: 'bg-blue-500/10 text-blue-400 border border-blue-500/20',
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: 'text-xs px-2 py-0.5',
  md: 'text-sm px-2.5 py-1',
};

/**
 * Badge component for displaying labels, status, or tags
 *
 * @param variant - Color variant: 'default', 'primary', 'success', 'warning', 'error', or 'info'
 * @param size - Size: 'sm' or 'md'
 * @param children - Badge content
 * @param className - Additional CSS classes
 * @returns Badge component
 *
 * @example
 * ```tsx
 * <Badge variant="success">Active</Badge>
 * <Badge variant="warning" size="md">Pending</Badge>
 * ```
 */
export const Badge: React.FC<BadgeProps> = ({
  variant = 'default',
  size = 'sm',
  children,
  className = '',
  ...rest
}) => {
  const combinedClassName = [
    'inline-flex items-center',
    'rounded-full font-medium',
    variantClasses[variant],
    sizeClasses[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return <span className={combinedClassName} {...rest}>{children}</span>;
};

Badge.displayName = 'Badge';
