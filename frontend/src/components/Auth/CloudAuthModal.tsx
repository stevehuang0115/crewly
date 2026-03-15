/**
 * Cloud Auth Modal
 *
 * Modal dialog for CrewlyAI Cloud authentication.
 * Redirects to crewlyai.com/auth for login (no local forms).
 *
 * @module components/Auth/CloudAuthModal
 */

import React from 'react';
import { Modal } from '../UI';
import { LoginForm } from './LoginForm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for CloudAuthModal. */
export interface CloudAuthModalProps {
  /** Whether the modal is open */
  isOpen: boolean;
  /** Called when the modal should close */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Modal with Cloud login redirect for CrewlyAI Cloud authentication.
 *
 * @param props - CloudAuthModal props
 * @returns CloudAuthModal component
 */
export const CloudAuthModal: React.FC<CloudAuthModalProps> = ({
  isOpen,
  onClose,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="CrewlyAI Cloud"
    >
      <div className="p-4">
        <LoginForm />
      </div>
    </Modal>
  );
};

CloudAuthModal.displayName = 'CloudAuthModal';
