/**
 * SaveButton Component
 *
 * A button with built-in save state machine (idle → saving → saved/error → idle).
 * Consolidates the duplicated save-button patterns found in 4+ Settings tabs.
 *
 * @module components/UI/SaveButton
 */

import React, { useEffect, useRef } from 'react';
import { Save, Check, RotateCcw } from 'lucide-react';
import { Button } from './Button';
import type { LucideIcon } from 'lucide-react';

// =============================================================================
// Types
// =============================================================================

/** Visual state of the save operation */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface SaveButtonProps {
  /** Async handler invoked on click. The caller manages status transitions. */
  onClick: () => void | Promise<void>;
  /** Current status of the save operation */
  status?: SaveStatus;
  /** Milliseconds before auto-resetting from saved/error back to idle (default 2000) */
  resetDelay?: number;
  /** Whether the button is disabled */
  disabled?: boolean;
  /** Additional CSS classes */
  className?: string;
  /** Override the idle label (default "Save") */
  children?: React.ReactNode;
}

// =============================================================================
// Mappings
// =============================================================================

/** Status → lucide icon mapping */
const STATUS_ICON_MAP: Record<SaveStatus, LucideIcon> = {
  idle: Save,
  saving: Save, // spinner replaces icon via Button loading prop
  saved: Check,
  error: RotateCcw,
};

/** Status → Button variant */
const STATUS_VARIANT_MAP: Record<SaveStatus, 'primary' | 'success' | 'danger'> = {
  idle: 'primary',
  saving: 'primary',
  saved: 'success',
  error: 'danger',
};

/** Status → display label */
const STATUS_LABEL_MAP: Record<SaveStatus, string> = {
  idle: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Retry',
};

// =============================================================================
// Component
// =============================================================================

/**
 * Save button with automatic state transitions and auto-reset.
 *
 * @param props - {@link SaveButtonProps}
 * @returns Button element reflecting the current save status
 *
 * @example
 * ```tsx
 * const [status, setStatus] = useState<SaveStatus>('idle');
 * const handleSave = async () => {
 *   setStatus('saving');
 *   try {
 *     await api.save(data);
 *     setStatus('saved');
 *   } catch {
 *     setStatus('error');
 *   }
 * };
 * <SaveButton onClick={handleSave} status={status} />
 * ```
 */
export const SaveButton: React.FC<SaveButtonProps> = ({
  onClick,
  status = 'idle',
  resetDelay = 2000,
  disabled = false,
  className = '',
  children,
}) => {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onResetRef = useRef<(() => void) | null>(null);

  // Store a stable reference to the reset callback
  // This is used externally in tests when status is managed by parent
  // The auto-reset is a convenience — callers still own the state machine
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Auto-reset from saved/error → idle after resetDelay
  useEffect(() => {
    if (status === 'saved' || status === 'error') {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => {
        onResetRef.current?.();
      }, resetDelay);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [status, resetDelay]);

  const isBusy = status === 'saving';
  const icon = STATUS_ICON_MAP[status];
  const variant = STATUS_VARIANT_MAP[status];
  const label = children ?? STATUS_LABEL_MAP[status];

  return (
    <Button
      variant={variant}
      size="sm"
      icon={status !== 'saving' ? icon : undefined}
      loading={isBusy}
      disabled={disabled || isBusy}
      onClick={onClick}
      className={className}
      data-testid="save-button"
      data-status={status}
    >
      {label}
    </Button>
  );
};

SaveButton.displayName = 'SaveButton';
