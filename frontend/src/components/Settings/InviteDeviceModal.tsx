/**
 * InviteDeviceModal Component
 *
 * Modal for generating a pairing code and shared secret to invite
 * another device to join the relay. Displays the generated values
 * with copy-to-clipboard buttons and an optional QR code.
 *
 * On open, generates a random pairing code (6 alphanumeric chars)
 * and a shared secret (32-byte hex string), then calls
 * POST /api/relay/connect with role=orchestrator.
 *
 * @module components/Settings/InviteDeviceModal
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Copy, Check, Loader2, AlertCircle, X, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { CLOUD_TOKEN_KEY } from '../../constants/cloud.constants';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Length of the pairing code (alphanumeric characters). */
const PAIRING_CODE_LENGTH = 6;

/** Length of the shared secret in bytes (displayed as hex). */
const SHARED_SECRET_BYTES = 32;

/** Relay API base URL (without /api suffix — relay-client appends /api/v1/...). */
const RELAY_API_URL = 'https://api.crewlyai.com';

/** Backend relay connect endpoint. */
const RELAY_CONNECT_URL = '/api/relay/connect';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random alphanumeric pairing code.
 *
 * @param length - Number of characters
 * @returns Random alphanumeric string (uppercase)
 */
export function generatePairingCode(length: number = PAIRING_CODE_LENGTH): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 to avoid confusion
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => chars[v % chars.length]).join('');
}

/**
 * Generate a random hex shared secret.
 *
 * @param bytes - Number of random bytes
 * @returns Hex-encoded string (64 chars for 32 bytes)
 */
export function generateSharedSecret(bytes: number = SHARED_SECRET_BYTES): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Props for the InviteDeviceModal component. */
export interface InviteDeviceModalProps {
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
 * Modal that generates and displays a pairing code + shared secret
 * for inviting another device to join the relay.
 *
 * @param props - Modal props
 * @returns InviteDeviceModal component
 */
export const InviteDeviceModal: React.FC<InviteDeviceModalProps> = ({ isOpen, onClose }) => {
  const [pairingCode, setPairingCode] = useState('');
  const [sharedSecret, setSharedSecret] = useState('');
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [copiedField, setCopiedField] = useState<'code' | 'secret' | null>(null);
  const [showQr, setShowQr] = useState(false);

  /**
   * Generate new credentials and register with relay on modal open.
   */
  useEffect(() => {
    if (!isOpen) {
      // Reset state when closing
      setConnectStatus('idle');
      setErrorMessage('');
      setCopiedField(null);
      setShowQr(false);
      return;
    }

    const code = generatePairingCode();
    const secret = generateSharedSecret();
    setPairingCode(code);
    setSharedSecret(secret);

    const connectRelay = async () => {
      setConnectStatus('connecting');
      setErrorMessage('');

      const token = localStorage.getItem(CLOUD_TOKEN_KEY) || '';

      try {
        const res = await fetch(RELAY_CONNECT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiUrl: RELAY_API_URL,
            pairingCode: code,
            role: 'orchestrator',
            token,
            sharedSecret: secret,
          }),
        });

        const data = await res.json();

        if (res.ok && data.success) {
          setConnectStatus('success');
        } else {
          setConnectStatus('error');
          setErrorMessage(data.error || 'Failed to register with relay');
        }
      } catch {
        setConnectStatus('error');
        setErrorMessage('Could not reach the server');
      }
    };

    connectRelay();
  }, [isOpen]);

  /**
   * Copy a value to the clipboard and show a brief confirmation.
   *
   * @param value - The string to copy
   * @param field - Which field was copied (for UI feedback)
   */
  const handleCopy = useCallback(async (value: string, field: 'code' | 'secret') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      // Fallback: select text for manual copy
    }
  }, []);

  if (!isOpen) return null;

  /** QR code payload encodes both values as a simple JSON string. */
  const qrPayload = JSON.stringify({ pairingCode, sharedSecret });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Invite Device"
      data-testid="invite-device-modal"
    >
      <div
        className="bg-surface-dark border border-border-dark rounded-xl shadow-2xl w-full max-w-md mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-dark">
          <h3 className="text-sm font-semibold text-text-primary-dark">Invite Device</h3>
          <button
            onClick={onClose}
            className="p-1 text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
            aria-label="Close"
            data-testid="invite-modal-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Status indicator */}
          {connectStatus === 'connecting' && (
            <div className="flex items-center gap-2 text-xs text-text-secondary-dark" data-testid="invite-connecting">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Registering with relay...
            </div>
          )}

          {connectStatus === 'error' && (
            <div className="flex items-center gap-2 text-xs text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded px-3 py-2" data-testid="invite-error">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {errorMessage}
            </div>
          )}

          {connectStatus === 'success' && (
            <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-3 py-2" data-testid="invite-success">
              <Check className="w-3.5 h-3.5 shrink-0" />
              Waiting for device to join...
            </div>
          )}

          {/* Pairing Code */}
          <div>
            <label className="block text-xs font-medium text-text-secondary-dark mb-1.5">Pairing Code</label>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 px-3 py-2 text-lg font-mono font-bold tracking-widest text-text-primary-dark bg-background-dark border border-border-dark rounded-lg text-center select-all"
                data-testid="invite-pairing-code"
              >
                {pairingCode}
              </code>
              <button
                onClick={() => handleCopy(pairingCode, 'code')}
                className="p-2 text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
                aria-label="Copy pairing code"
                data-testid="copy-pairing-code"
              >
                {copiedField === 'code' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Shared Secret */}
          <div>
            <label className="block text-xs font-medium text-text-secondary-dark mb-1.5">Shared Secret</label>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 px-3 py-2 text-[11px] font-mono text-text-primary-dark bg-background-dark border border-border-dark rounded-lg break-all select-all"
                data-testid="invite-shared-secret"
              >
                {sharedSecret}
              </code>
              <button
                onClick={() => handleCopy(sharedSecret, 'secret')}
                className="p-2 text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors shrink-0"
                aria-label="Copy shared secret"
                data-testid="copy-shared-secret"
              >
                {copiedField === 'secret' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* QR Code toggle */}
          <div>
            <button
              onClick={() => setShowQr(!showQr)}
              className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
              data-testid="toggle-qr-code"
            >
              <QrCode className="w-3.5 h-3.5" />
              {showQr ? 'Hide QR Code' : 'Show QR Code'}
            </button>

            {showQr && (
              <div className="mt-3 flex justify-center" data-testid="qr-code-container">
                <div className="p-3 bg-white rounded-lg">
                  <QRCodeSVG value={qrPayload} size={160} level="M" />
                </div>
              </div>
            )}
          </div>

          {/* Instructions */}
          <p className="text-[11px] text-text-secondary-dark leading-relaxed">
            Share the pairing code and secret with the device you want to connect.
            On the other device, click <strong>Join Relay</strong> and enter these values.
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-border-dark flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-text-secondary-dark hover:text-text-primary-dark rounded-md hover:bg-background-dark transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default InviteDeviceModal;
