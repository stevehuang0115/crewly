import React, { useState } from 'react';
import { CheckCircle, XCircle, AlertTriangle, Info } from 'lucide-react';
import { Modal, ModalFooter } from './Modal';
import { Button } from './Button';

export type AlertType = 'success' | 'error' | 'warning' | 'info';

export interface AlertDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  message: string;
  type?: AlertType;
  confirmText?: string;
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  title?: string;
  message: string;
  type?: AlertType;
  confirmText?: string;
  cancelText?: string;
  loading?: boolean;
}

const IconForType = ({ type }: { type: AlertType }) => {
  const map = {
    success: CheckCircle,
    error: XCircle,
    warning: AlertTriangle,
    info: Info,
  } as const;
  const Icon = map[type] ?? Info;
  return (
    <div className={`mx-auto mb-3 w-12 h-12 rounded-full flex items-center justify-center ` +
      (type === 'success' ? 'bg-green-500/10 text-green-400' :
       type === 'error' ? 'bg-rose-500/10 text-rose-400' :
       type === 'warning' ? 'bg-yellow-500/10 text-yellow-400' :
       'bg-blue-500/10 text-blue-300')
    }>
      <Icon className="w-6 h-6" />
    </div>
  );
};

// Alert Dialog Component (uses shared Modal)
export const AlertDialog: React.FC<AlertDialogProps> = ({
  isOpen,
  onClose,
  title,
  message,
  type = 'info',
  confirmText = 'OK'
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      closable={true}
    >
      <div className="text-center">
        <IconForType type={type} />
        <div className="whitespace-pre-line text-sm text-text-primary-dark">
          {message}
        </div>
      </div>
      <ModalFooter align="center">
        <Button variant="primary" onClick={onClose} fullWidth>
          {confirmText}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// Confirm Dialog Component (uses shared Modal)
export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  type = 'warning',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  loading = false
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      size="sm"
      closable={!loading}
    >
      <div className="text-center">
        <IconForType type={type} />
        <div className="whitespace-pre-line text-sm text-text-primary-dark">
          {message}
        </div>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          {cancelText}
        </Button>
        <Button variant={type === 'error' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
          {confirmText}
        </Button>
      </ModalFooter>
    </Modal>
  );
};

// Hook for programmatic alerts
export const useAlert = () => {
  const [alertState, setAlertState] = useState<{
    isOpen: boolean;
    title?: string;
    message: string;
    type: AlertType;
    confirmText?: string;
  }>({
    isOpen: false,
    message: '',
    type: 'info'
  });

  const showAlert = (
    message: string,
    type: AlertType = 'info',
    title?: string,
    confirmText?: string
  ) => {
    setAlertState({
      isOpen: true,
      message,
      type,
      title,
      confirmText
    });
  };

  const closeAlert = () => {
    setAlertState(prev => ({ ...prev, isOpen: false }));
  };

  const AlertComponent = () => (
    <AlertDialog
      isOpen={alertState.isOpen}
      onClose={closeAlert}
      title={alertState.title}
      message={alertState.message}
      type={alertState.type}
      confirmText={alertState.confirmText}
    />
  );

  return {
    showAlert,
    AlertComponent,
    showSuccess: (message: string, title?: string) => showAlert(message, 'success', title),
    showError: (message: string, title?: string) => showAlert(message, 'error', title),
    showWarning: (message: string, title?: string) => showAlert(message, 'warning', title),
    showInfo: (message: string, title?: string) => showAlert(message, 'info', title),
  };
};

// Hook for programmatic confirms
export const useConfirm = () => {
  const [confirmState, setConfirmState] = useState<{
    isOpen: boolean;
    title?: string;
    message: string;
    type: AlertType;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void | Promise<void>;
    loading: boolean;
  }>({
    isOpen: false,
    message: '',
    type: 'warning',
    onConfirm: () => {},
    loading: false
  });

  const showConfirm = (
    message: string,
    onConfirm: () => void | Promise<void>,
    {
      type = 'warning',
      title,
      confirmText,
      cancelText
    }: {
      type?: AlertType;
      title?: string;
      confirmText?: string;
      cancelText?: string;
    } = {}
  ) => {
    setConfirmState({
      isOpen: true,
      message,
      type,
      title,
      confirmText,
      cancelText,
      onConfirm,
      loading: false
    });
  };

  const closeConfirm = () => {
    setConfirmState(prev => ({ ...prev, isOpen: false }));
  };

  const handleConfirm = async () => {
    setConfirmState(prev => ({ ...prev, loading: true }));
    try {
      await confirmState.onConfirm();
      closeConfirm();
    } catch (error) {
      setConfirmState(prev => ({ ...prev, loading: false }));
    }
  };

  const ConfirmComponent = () => (
    <ConfirmDialog
      isOpen={confirmState.isOpen}
      onConfirm={handleConfirm}
      onCancel={closeConfirm}
      title={confirmState.title}
      message={confirmState.message}
      type={confirmState.type}
      confirmText={confirmState.confirmText}
      cancelText={confirmState.cancelText}
      loading={confirmState.loading}
    />
  );

  return {
    showConfirm,
    ConfirmComponent,
    showDeleteConfirm: (itemName: string, onConfirm: () => void | Promise<void>) =>
      showConfirm(
        `Are you sure you want to delete "${itemName}"? This action cannot be undone.`,
        onConfirm,
        { type: 'error', title: 'Confirm Deletion', confirmText: 'Delete' }
      ),
  };
};
