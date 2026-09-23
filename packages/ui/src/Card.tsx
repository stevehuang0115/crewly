/**
 * Card Component
 *
 * Reusable card component with multiple variants and padding options.
 * Follows the design system's dark theme styling.
 *
 * @module components/UI/Card
 */

import React from 'react';
import { cn } from './cn';

export type CardVariant = 'default' | 'outlined' | 'elevated';
export type CardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Visual variant of the card */
  variant?: CardVariant;
  /** Padding size inside the card */
  padding?: CardPadding;
  /** Whether the card responds to hover/click interactions */
  interactive?: boolean;
  /** Card contents */
  children: React.ReactNode;
}

const variantClasses: Record<CardVariant, string> = {
  default: 'bg-surface-dark border border-border-dark',
  outlined: 'border border-border-dark bg-transparent',
  elevated: 'bg-surface-dark border border-border-dark shadow-md',
};

const paddingClasses: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-6',
};

/**
 * Card component for displaying content in a contained, styled container
 *
 * @param variant - Visual style: 'default', 'outlined', or 'elevated'
 * @param padding - Inner padding: 'none', 'sm', 'md', or 'lg'
 * @param interactive - Adds hover states for clickable cards
 * @param children - Card contents
 * @param className - Additional CSS classes
 * @returns Card component
 *
 * @example
 * ```tsx
 * <Card variant="default" padding="lg" interactive>
 *   <h3>Card Title</h3>
 *   <p>Card content</p>
 * </Card>
 * ```
 */
export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      variant = 'default',
      padding = 'md',
      interactive = false,
      className = '',
      children,
      ...props
    },
    ref
  ) => {
    const interactiveClass = interactive
      ? 'cursor-pointer hover:border-primary/50 transition-colors'
      : '';

    const combinedClassName = cn('rounded-2xl', variantClasses[variant], paddingClasses[padding], interactiveClass, className);

    return (
      <div ref={ref} className={combinedClassName} {...props}>
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';
