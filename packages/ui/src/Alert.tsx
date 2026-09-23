/**
 * Alert Component
 *
 * Alert/notification component for displaying messages to users.
 * Supports multiple variants for different message types.
 *
 * @module components/UI/Alert
 */

import React from 'react';
import { AlertCircle, CheckCircle, Info, AlertTriangle, X, LucideIcon } from 'lucide-react';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title' | 'children'> {
  /** Alert type/color variant */
  variant?: AlertVariant;
  /** Optional title displayed above the message */
  title?: string;
  /** Alert message content */
  children: React.ReactNode;
  /** Callback when close button is clicked (omit to hide close button) */
  onClose?: () => void;
  /** Additional CSS classes */
  className?: string;
  /** Replace the variant's icon (e.g. a lucide icon) */
  icon?: React.ComponentType<{ className?: string }>;
  /** Tighter padding for inline notices */
  size?: 'md' | 'sm';
}

interface VariantConfig {
  classes: string;
  icon: LucideIcon;
}

const variantConfig: Record<AlertVariant, VariantConfig> = {
  info: {
    classes: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    icon: Info,
  },
  success: {
    classes: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    icon: CheckCircle,
  },
  warning: {
    classes: 'bg-yellow-500/10 border-yellow-500/20 text-yellow-400',
    icon: AlertTriangle,
  },
  error: {
    classes: 'bg-red-500/10 border-red-500/20 text-red-400',
    icon: AlertCircle,
  },
};

/**
 * Alert component for displaying informational messages
 *
 * @param variant - Type of alert: 'info', 'success', 'warning', or 'error'
 * @param title - Optional bold title
 * @param children - Message content
 * @param onClose - Close button callback (omit to hide button)
 * @param className - Additional CSS classes
 * @returns Alert component
 *
 * @example
 * ```tsx
 * <Alert variant="success" title="Success!">
 *   Your changes have been saved.
 * </Alert>
 *
 * <Alert variant="error" onClose={() => setError(null)}>
 *   Something went wrong. Please try again.
 * </Alert>
 * ```
 */
export const Alert: React.FC<AlertProps> = ({
  variant = 'info',
  title,
  children,
  onClose,
  className = '',
  icon,
  size = 'md',
  ...rest
}) => {
  const { classes, icon: VariantIcon } = variantConfig[variant];
  const Icon = icon ?? VariantIcon;

  const combinedClassName = [
    'flex items-start gap-3',
    size === 'sm' ? 'px-3 py-2 rounded-2xl border' : 'p-4 rounded-2xl border',
    classes,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div {...rest} className={combinedClassName} role="alert">
      <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        {title && <h4 className="font-medium mb-1">{title}</h4>}
        <div className="text-sm">{children}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="flex-shrink-0 p-1 -m-1 hover:opacity-70 transition-opacity focus:outline-none focus:ring-2 focus:ring-current focus:ring-offset-2 focus:ring-offset-background-dark rounded-[0.5rem]"
          aria-label="Dismiss alert"
        >
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};

Alert.displayName = 'Alert';
