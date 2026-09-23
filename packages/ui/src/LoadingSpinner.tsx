/**
 * LoadingSpinner — Shared loading indicator component.
 *
 * Replaces 20+ hardcoded inline spinners across the frontend with a single,
 * consistent component supporting multiple sizes and an optional text label.
 *
 * @module components/UI/LoadingSpinner
 */

import React from 'react';

/** Available spinner sizes mapped to Tailwind dimension + border-width classes. */
const SPINNER_SIZES = {
  xs: 'w-3 h-3 border-2',
  sm: 'w-5 h-5 border-2',
  md: 'w-8 h-8 border-[3px]',
  lg: 'w-10 h-10 border-4',
  xl: 'w-12 h-12 border-4',
} as const;

/** Props for the LoadingSpinner component. */
export interface LoadingSpinnerProps {
  /** Spinner diameter. @default 'lg' */
  size?: keyof typeof SPINNER_SIZES;
  /** Optional text displayed below the spinner. */
  text?: string;
  /** Additional CSS classes on the wrapper div. */
  className?: string;
  /** Center the spinner horizontally (adds mx-auto). @default true */
  centered?: boolean;
}

/**
 * A reusable loading spinner with configurable size and optional label.
 *
 * @param props - Component props
 * @returns LoadingSpinner element
 *
 * @example
 * ```tsx
 * <LoadingSpinner />
 * <LoadingSpinner size="sm" />
 * <LoadingSpinner size="xl" text="Loading teams..." />
 * <LoadingSpinner size="xs" centered={false} />
 * ```
 */
export const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
  size = 'lg',
  text,
  className = '',
  centered = true,
}) => {
  const sizeClasses = SPINNER_SIZES[size];

  return (
    <div
      className={`${centered ? 'flex flex-col items-center' : 'inline-flex flex-col items-center'} ${className}`}
      role="status"
      aria-label={text || 'Loading'}
    >
      <div
        className={`${sizeClasses} border-primary/20 border-t-primary rounded-full animate-spin`}
        data-testid="loading-spinner"
      />
      {text && (
        <p className="mt-3 text-sm text-text-secondary-dark">{text}</p>
      )}
    </div>
  );
};

export default LoadingSpinner;
