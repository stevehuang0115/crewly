import React from 'react';

export interface ToggleProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'success' | 'warning' | 'danger';
  labelPosition?: 'left' | 'right';
}

// Styled inline so the switch renders the same in every host; the toggle-*
// names stay as hooks for tests and overrides.
const TRACK_SIZES = {
  sm: 'w-8 h-4 after:h-3 after:w-3 peer-checked:after:translate-x-4',
  md: 'w-10 h-5 after:h-4 after:w-4 peer-checked:after:translate-x-5',
  lg: 'w-12 h-6 after:h-5 after:w-5 peer-checked:after:translate-x-6',
} as const;

const TRACK_ON = {
  default: 'peer-checked:bg-primary',
  success: 'peer-checked:bg-emerald-500',
  warning: 'peer-checked:bg-yellow-500',
  danger: 'peer-checked:bg-rose-600',
} as const;

export const Toggle: React.FC<ToggleProps> = ({
  label,
  description,
  size = 'md',
  variant = 'default',
  labelPosition = 'right',
  className = '',
  id,
  disabled = false,
  ...props
}) => {
  const toggleId = id || `toggle-${Math.random().toString(36).substr(2, 9)}`;

  const toggleContent = (
    <div className={`toggle-container inline-flex items-center gap-3 ${className}`}>
      {label && labelPosition === 'left' && (
        <label htmlFor={toggleId} className={`toggle-label toggle-label--left text-sm text-text-primary-dark ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
          {label}
        </label>
      )}
      
      <label htmlFor={toggleId} className={`toggle-wrapper toggle-wrapper--${size} toggle-wrapper--${variant} relative inline-flex shrink-0 ${disabled ? 'toggle-wrapper--disabled opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
        <input
          type="checkbox"
          id={toggleId}
          className="toggle-input peer sr-only"
          disabled={disabled}
          {...props}
        />
        <span
          aria-hidden="true"
          className={`toggle-slider block rounded-full bg-border-dark transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary after:absolute after:left-0.5 after:top-0.5 after:rounded-full after:bg-white after:transition-transform ${TRACK_SIZES[size]} ${TRACK_ON[variant]}`}
        />
      </label>
      
      {label && labelPosition === 'right' && (
        <label htmlFor={toggleId} className={`toggle-label toggle-label--right text-sm text-text-primary-dark ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
          {label}
        </label>
      )}
    </div>
  );

  if (description) {
    return (
      <div className="toggle-group">
        {toggleContent}
        <p className="toggle-description text-xs text-text-secondary-dark mt-1">{description}</p>
      </div>
    );
  }

  return toggleContent;
};