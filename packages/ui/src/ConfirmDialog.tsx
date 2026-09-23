/**
 * ConfirmDialog Component
 *
 * A reusable confirmation modal for destructive or irreversible actions.
 * Wraps the existing Modal component with a standard two-button footer.
 *
 * @module components/UI/ConfirmDialog
 */

import React from 'react';
import { Modal, ModalFooter } from './Modal';
import { Button } from './Button';

export interface ConfirmDialogProps {
  /** Whether the dialog is visible. */
  isOpen: boolean;
  /** Called when the user cancels or closes the dialog. */
  onCancel: () => void;
  /** Called when the user confirms the action. */
  onConfirm: () => void;
  /** Dialog title. */
  title?: string;
  /** Body message describing the action. */
  message: string;
  /** Label for the confirm button. @default 'Confirm' */
  confirmLabel?: string;
  /** Visual variant for the confirm button. @default 'danger' */
  confirmVariant?: 'danger' | 'primary' | 'warning';
  /** Label for the cancel button. @default 'Cancel' */
  cancelLabel?: string;
  /** Disables the confirm button (e.g. during async operation). */
  loading?: boolean;
}

/**
 * Generic confirmation dialog built on top of the Modal component.
 *
 * @param props - {@link ConfirmDialogProps}
 * @returns ConfirmDialog JSX element, or null when closed
 *
 * @example
 * ```tsx
 * <ConfirmDialog
 *   isOpen={showConfirm}
 *   onCancel={() => setShowConfirm(false)}
 *   onConfirm={handleDelete}
 *   title="Delete Item"
 *   message="Are you sure? This cannot be undone."
 *   confirmLabel="Delete"
 * />
 * ```
 */
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onCancel,
  onConfirm,
  title = 'Confirm',
  message,
  confirmLabel = 'Confirm',
  confirmVariant = 'danger',
  cancelLabel = 'Cancel',
  loading = false,
}) => (
  <Modal isOpen={isOpen} onClose={onCancel} title={title} size="sm">
    <p className="text-sm text-text-secondary-dark" data-testid="confirm-dialog-message">
      {message}
    </p>
    <ModalFooter>
      <Button
        variant="secondary"
        size="sm"
        onClick={onCancel}
        disabled={loading}
        data-testid="confirm-dialog-cancel"
      >
        {cancelLabel}
      </Button>
      <Button
        variant={confirmVariant}
        size="sm"
        onClick={onConfirm}
        loading={loading}
        data-testid="confirm-dialog-confirm"
      >
        {confirmLabel}
      </Button>
    </ModalFooter>
  </Modal>
);

export default ConfirmDialog;
