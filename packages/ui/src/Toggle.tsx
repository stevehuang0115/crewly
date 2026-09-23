import React from 'react';

export interface ToggleProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label?: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'success' | 'warning' | 'danger';
  labelPosition?: 'left' | 'right';
}

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
    <div className={`toggle-container ${className}`}>
      {label && labelPosition === 'left' && (
        <label htmlFor={toggleId} className="toggle-label toggle-label--left">
          {label}
        </label>
      )}
      
      <div className={`toggle-wrapper toggle-wrapper--${size} toggle-wrapper--${variant} ${disabled ? 'toggle-wrapper--disabled' : ''}`}>
        <input
          type="checkbox"
          id={toggleId}
          className="toggle-input"
          disabled={disabled}
          {...props}
        />
        <span className="toggle-slider" />
      </div>
      
      {label && labelPosition === 'right' && (
        <label htmlFor={toggleId} className="toggle-label toggle-label--right">
          {label}
        </label>
      )}
    </div>
  );

  if (description) {
    return (
      <div className="toggle-group">
        {toggleContent}
        <p className="toggle-description">{description}</p>
      </div>
    );
  }

  return toggleContent;
};