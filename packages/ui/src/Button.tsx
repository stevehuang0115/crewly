import React from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'danger-ghost' | 'success' | 'warning' | 'outline' | 'link';
export type ButtonSize = 'default' | 'sm' | 'xs' | 'icon';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  fullWidth?: boolean;
  children?: React.ReactNode;
}

const baseClasses = "font-semibold inline-flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary/90",
  secondary: "bg-surface-dark border border-border-dark hover:bg-background-dark",
  danger: "bg-rose-600 text-white hover:bg-rose-500",
  ghost: "text-text-secondary-dark hover:bg-background-dark hover:text-text-primary-dark",
  'danger-ghost': "text-text-secondary-dark hover:text-rose-400",
  success: "bg-emerald-600 text-white hover:bg-emerald-500",
  warning: "bg-yellow-500 text-black hover:bg-yellow-400",
  outline: "border border-border-dark text-text-secondary-dark hover:bg-surface-dark hover:text-text-primary-dark",
  // Inline text action ("Clear", "Switch", "3 replies"): no box, just the accent
  link: "text-primary hover:underline underline-offset-2",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "h-10 px-4 rounded-2xl text-sm",
  sm: "h-9 px-3 rounded-2xl text-sm",
  xs: "h-7 px-2 rounded-[0.75rem] text-xs",
  icon: "h-10 w-10 rounded-2xl",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({
    variant = 'primary',
    size = 'default',
    icon: Icon,
    iconPosition = 'left',
    loading = false,
    fullWidth = false,
    disabled,
    className = '',
    children,
    ...props
  }, ref) => {
    const isDisabled = disabled || loading;
    // A link is inline text: no height or padding, just the text size.
    const sizeClass = variant === 'link' ? (size === 'xs' ? 'text-xs' : 'text-sm') : sizeClasses[size];
    const finalClassName = cn(
      baseClasses,
      variantClasses[variant],
      sizeClass,
      fullWidth && 'w-full',
      className
    );

    return (
      <button
        ref={ref}
        className={finalClassName}
        disabled={isDisabled}
        {...props}
      >
        {loading && (
          <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
        )}

        {!loading && Icon && iconPosition === 'left' && (
          <Icon className="h-4 w-4" />
        )}

        {children && (
          <span>{children}</span>
        )}

        {!loading && Icon && iconPosition === 'right' && (
          <Icon className="h-4 w-4" />
        )}
      </button>
    );
  }
);

Button.displayName = 'Button';

// Icon-only button variant
export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconPosition'> {
  icon: LucideIcon;
  'aria-label': string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon: Icon, variant = 'ghost', size = 'icon', className = '', ...props }, ref) => {
    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        icon={Icon}
        className={className}
        {...props}
      />
    );
  }
);

IconButton.displayName = 'IconButton';
