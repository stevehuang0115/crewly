/**
 * JoinRelayModal Component
 *
 * Modal for joining an existing relay by entering a pairing code
 * and shared secret provided by the inviting device. On submit,
 * calls POST /api/relay/connect with role=agent.
 *
 * @module components/Settings/JoinRelayModal
 */

import React, { useState, useCallback } from 'react';
import { Alert } from '@crewly/ui/Alert';
import { Button } from '@crewly/ui/Button';
import { Input } from '@crewly/ui/Input';
import { Modal, ModalFooter } from '@crewly/ui/Modal';
import { CLOUD_TOKEN_KEY } from '../../constants/cloud.constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Relay API base URL (without /api suffix — relay-client appends /api/v1/...). */
const RELAY_API_URL = 'https://api.crewlyai.com';

/** Backend relay connect endpoint. */
const RELAY_CONNECT_URL = '/api/relay/connect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the JoinRelayModal component. */
export interface JoinRelayModalProps {
  /** Whether the modal is open. */
  isOpen: boolean;
  /** Callback to close the modal. */
  onClose: () => void;
}

/** Status of the relay connect call. */
type ConnectStatus = 'idle' | 'connecting' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Modal that accepts a pairing code and shared secret to join
 * an existing relay as an agent.
 *
 * @param props - Modal props
 * @returns JoinRelayModal component
 */
export const JoinRelayModal: React.FC<JoinRelayModalProps> = ({ isOpen, onClose }) => {
  const [pairingCode, setPairingCode] = useState('');
  const [sharedSecret, setSharedSecret] = useState('');
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  /**
   * Reset form state when the modal closes.
   */
  const handleClose = useCallback(() => {
    setPairingCode('');
    setSharedSecret('');
    setConnectStatus('idle');
    setErrorMessage('');
    onClose();
  }, [onClose]);

  /**
   * Submit the pairing code and shared secret to join the relay.
   */
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();

    const trimmedCode = pairingCode.trim();
    const trimmedSecret = sharedSecret.trim();

    if (!trimmedCode || !trimmedSecret) {
      setConnectStatus('error');
      setErrorMessage('Both pairing code and shared secret are required');
      return;
    }

    setConnectStatus('connecting');
    setErrorMessage('');

    const token = localStorage.getItem(CLOUD_TOKEN_KEY) || '';

    try {
      const res = await fetch(RELAY_CONNECT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiUrl: RELAY_API_URL,
          pairingCode: trimmedCode,
          role: 'agent',
          token,
          sharedSecret: trimmedSecret,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        setConnectStatus('success');
      } else {
        setConnectStatus('error');
        setErrorMessage(data.error || 'Failed to join relay');
      }
    } catch {
      setConnectStatus('error');
      setErrorMessage('Could not reach the server');
    }
  }, [pairingCode, sharedSecret]);

  const isSubmitting = connectStatus === 'connecting';

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Join Relay" size="md" data-testid="join-relay-modal">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Status feedback */}
        {connectStatus === 'error' && (
          <Alert variant="error" size="sm" data-testid="join-error">{errorMessage}</Alert>
        )}

        {connectStatus === 'success' && (
          <Alert variant="success" size="sm" data-testid="join-success">Connected to relay successfully!</Alert>
        )}

        <Input
          id="join-pairing-code"
          label="Pairing Code"
          type="text"
          value={pairingCode}
          onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
          placeholder="e.g. A3BK7P"
          disabled={isSubmitting || connectStatus === 'success'}
          className="font-mono tracking-wider"
          autoComplete="off"
          fullWidth
          data-testid="join-pairing-code-input"
        />

        <Input
          id="join-shared-secret"
          label="Shared Secret"
          type="text"
          value={sharedSecret}
          onChange={(e) => setSharedSecret(e.target.value)}
          placeholder="64-character hex string"
          disabled={isSubmitting || connectStatus === 'success'}
          className="font-mono text-xs"
          autoComplete="off"
          fullWidth
          data-testid="join-shared-secret-input"
        />

        {/* Instructions */}
        <p className="text-xs text-text-secondary-dark leading-relaxed">
          Enter the pairing code and shared secret from the device that sent the invitation.
        </p>

        <ModalFooter className="px-0 pb-0 pt-2 border-t border-border-dark">
          <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
            {connectStatus === 'success' ? 'Done' : 'Cancel'}
          </Button>
          {connectStatus !== 'success' && (
            <Button
              type="submit"
              size="sm"
              loading={isSubmitting}
              disabled={!pairingCode.trim() || !sharedSecret.trim()}
              data-testid="join-submit-button"
            >
              {isSubmitting ? 'Connecting...' : 'Join'}
            </Button>
          )}
        </ModalFooter>
      </form>
    </Modal>
  );
};

export default JoinRelayModal;
