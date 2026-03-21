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
import { Loader2, AlertCircle, Check, X } from 'lucide-react';
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

  if (!isOpen) return null;

  const isSubmitting = connectStatus === 'connecting';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Join Relay"
      data-testid="join-relay-modal"
    >
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-dark">
          <h3 className="text-sm font-semibold text-text-primary-dark">Join Relay</h3>
          <button
            onClick={handleClose}
            className="p-1 text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
            aria-label="Close"
            data-testid="join-modal-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Status feedback */}
          {connectStatus === 'error' && (
            <div className="flex items-center gap-2 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2" data-testid="join-error">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {errorMessage}
            </div>
          )}

          {connectStatus === 'success' && (
            <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2" data-testid="join-success">
              <Check className="w-3.5 h-3.5 shrink-0" />
              Connected to relay successfully!
            </div>
          )}

          {/* Pairing Code input */}
          <div>
            <label htmlFor="join-pairing-code" className="block text-xs font-medium text-text-secondary-dark mb-1.5">
              Pairing Code
            </label>
            <input
              id="join-pairing-code"
              type="text"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value.toUpperCase())}
              placeholder="e.g. A3BK7P"
              disabled={isSubmitting || connectStatus === 'success'}
              className="w-full px-3 py-2 text-sm font-mono tracking-wider text-text-primary-dark bg-background-dark border border-border-dark rounded-lg placeholder:text-text-secondary-dark/40 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 disabled:opacity-50"
              autoComplete="off"
              data-testid="join-pairing-code-input"
            />
          </div>

          {/* Shared Secret input */}
          <div>
            <label htmlFor="join-shared-secret" className="block text-xs font-medium text-text-secondary-dark mb-1.5">
              Shared Secret
            </label>
            <input
              id="join-shared-secret"
              type="text"
              value={sharedSecret}
              onChange={(e) => setSharedSecret(e.target.value)}
              placeholder="64-character hex string"
              disabled={isSubmitting || connectStatus === 'success'}
              className="w-full px-3 py-2 text-xs font-mono text-text-primary-dark bg-background-dark border border-border-dark rounded-lg placeholder:text-text-secondary-dark/40 focus:outline-none focus:ring-1 focus:ring-primary/50 focus:border-primary/50 disabled:opacity-50"
              autoComplete="off"
              data-testid="join-shared-secret-input"
            />
          </div>

          {/* Instructions */}
          <p className="text-[11px] text-text-secondary-dark leading-relaxed">
            Enter the pairing code and shared secret from the device that sent the invitation.
          </p>

          {/* Footer */}
          <div className="flex justify-end gap-2 pt-2 border-t border-border-dark">
            <button
              type="button"
              onClick={handleClose}
              className="px-4 py-1.5 text-xs font-medium text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
            >
              {connectStatus === 'success' ? 'Done' : 'Cancel'}
            </button>
            {connectStatus !== 'success' && (
              <button
                type="submit"
                disabled={isSubmitting || !pairingCode.trim() || !sharedSecret.trim()}
                className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium text-white bg-primary rounded-md hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="join-submit-button"
              >
                {isSubmitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {isSubmitting ? 'Connecting...' : 'Join'}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

export default JoinRelayModal;
