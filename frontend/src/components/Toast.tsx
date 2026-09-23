/**
 * Toast Notification Component
 *
 * Renders a stack of ephemeral toast notifications in the bottom-right corner.
 * Each toast shows a message with a colored indicator based on type (success,
 * error, info) and a dismiss button.
 *
 * @module components/Toast
 */

import { X } from 'lucide-react';
import { IconButton } from '@crewly/ui/Button';
import type { Toast as ToastItem } from '../hooks/useToast';

/** Props for the ToastContainer component */
interface ToastContainerProps {
  /** Array of active toast notifications */
  toasts: ToastItem[];
  /** Callback to dismiss a toast by ID */
  onDismiss: (id: string) => void;
}

/** CSS classes for toast type indicators */
const typeStyles: Record<ToastItem['type'], string> = {
  success: 'border-green-500 bg-green-500/10 text-green-300',
  error: 'border-red-500 bg-red-500/10 text-red-300',
  info: 'border-blue-500 bg-blue-500/10 text-blue-300',
};

/**
 * Renders a fixed-position container of toast notifications.
 *
 * Toasts stack vertically in the bottom-right corner of the viewport.
 * Each toast includes a dismiss button and automatically inherits the
 * auto-dismiss behavior from the useToast hook.
 *
 * @param props - The toasts array and dismiss callback
 * @returns The toast container JSX, or null if no toasts are active
 */
export default function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm" role="log" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid={`toast-${toast.type}`}
          className={`flex items-center gap-3 px-4 py-3 rounded-2xl border text-sm shadow-lg backdrop-blur-sm ${typeStyles[toast.type]}`}
        >
          <span className="flex-1">{toast.message}</span>
          <IconButton
            icon={X}
            size="xs"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0"
            aria-label="Dismiss notification"
          />
        </div>
      ))}
    </div>
  );
}
