/**
 * Input Component
 *
 * Standalone input component with label, error, and helper text support.
 * Follows the design system's dark theme styling.
 *
 * @module components/UI/Input
 */

import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Label text displayed above the input */
  label?: string;
  /** Error message displayed below the input */
  error?: string;
  /** Helper text displayed below the input (hidden when error is present) */
  helperText?: string;
  /** Whether the input should take full width of its container */
  fullWidth?: boolean;
}

/**
 * Input component for text entry with label and error support
 *
 * @param label - Text label displayed above the input
 * @param error - Error message (makes input border red)
 * @param helperText - Helper text (hidden when error is present)
 * @param fullWidth - Whether input takes full container width
 * @returns Input component
 *
 * @example
 * ```tsx
 * <Input
 *   label="Email"
 *   type="email"
 *   placeholder="Enter your email"
 *   error={errors.email}
 *   fullWidth
 * />
 * ```
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    { label, error, helperText, fullWidth = false, className = '', id, name, ...props },
    ref
  ) => {
    // Generate a stable ID if neither id nor name provided
    const generatedId = React.useId();
    const inputId = id || name || generatedId;

    const inputClassName = [
      'w-full px-3 py-2',
      'bg-background-dark',
      'border rounded-2xl',
      'text-text-primary-dark text-sm',
      'placeholder:text-text-secondary-dark/50',
      'focus:outline-none focus:ring-1',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      'transition-colors',
      error
        ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
        : 'border-border-dark focus:border-primary focus:ring-primary',
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <div className={fullWidth ? 'w-full' : ''}>
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm text-text-secondary-dark mb-2"
          >
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          name={name}
          className={inputClassName}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={
            error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined
          }
          {...props}
        />
        {error && (
          <p id={`${inputId}-error`} className="mt-1 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
        {helperText && !error && (
          <p id={`${inputId}-helper`} className="mt-1 text-xs text-text-secondary-dark">
            {helperText}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
