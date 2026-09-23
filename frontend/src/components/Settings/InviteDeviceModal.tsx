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
import { Copy, Check, QrCode } from 'lucide-react';
import { Alert } from '@crewly/ui/Alert';
import { Button, IconButton } from '@crewly/ui/Button';
import { FormLabel } from '@crewly/ui/Form';
import { LoadingSpinner } from '@crewly/ui/LoadingSpinner';
import { Modal, ModalFooter } from '@crewly/ui/Modal';
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
    <Modal isOpen={isOpen} onClose={onClose} title="Invite Device" size="md" data-testid="invite-device-modal">
      <div className="space-y-4">
        {/* Status indicator */}
        {connectStatus === 'connecting' && (
          <LoadingSpinner
            size="xs"
            inline
            centered={false}
            text="Registering with relay..."
            data-testid="invite-connecting"
          />
        )}

        {connectStatus === 'error' && (
          <Alert variant="error" size="sm" data-testid="invite-error">{errorMessage}</Alert>
        )}

        {connectStatus === 'success' && (
          <Alert variant="success" size="sm" data-testid="invite-success">Waiting for device to join...</Alert>
        )}

        {/* Pairing Code */}
        <div>
          <FormLabel>Pairing Code</FormLabel>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 px-3 py-2 text-lg font-mono font-bold tracking-widest text-text-primary-dark bg-background-dark border border-border-dark rounded-2xl text-center select-all"
              data-testid="invite-pairing-code"
            >
              {pairingCode}
            </code>
            <IconButton
              icon={copiedField === 'code' ? Check : Copy}
              onClick={() => handleCopy(pairingCode, 'code')}
              className={copiedField === 'code' ? 'text-emerald-400' : ''}
              aria-label="Copy pairing code"
              data-testid="copy-pairing-code"
            />
          </div>
        </div>

        {/* Shared Secret */}
        <div>
          <FormLabel>Shared Secret</FormLabel>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 px-3 py-2 text-xs font-mono text-text-primary-dark bg-background-dark border border-border-dark rounded-2xl break-all select-all"
              data-testid="invite-shared-secret"
            >
              {sharedSecret}
            </code>
            <IconButton
              icon={copiedField === 'secret' ? Check : Copy}
              onClick={() => handleCopy(sharedSecret, 'secret')}
              className={`shrink-0 ${copiedField === 'secret' ? 'text-emerald-400' : ''}`}
              aria-label="Copy shared secret"
              data-testid="copy-shared-secret"
            />
          </div>
        </div>

        {/* QR Code toggle */}
        <div>
          <Button
            variant="ghost"
            size="sm"
            icon={QrCode}
            onClick={() => setShowQr(!showQr)}
            className="text-primary hover:text-primary/80"
            data-testid="toggle-qr-code"
          >
            {showQr ? 'Hide QR Code' : 'Show QR Code'}
          </Button>

          {showQr && (
            <div className="mt-3 flex justify-center" data-testid="qr-code-container">
              {/* QR codes need a white quiet zone to scan. */}
              <div className="p-3 bg-white rounded-2xl">
                <QRCodeSVG value={qrPayload} size={160} level="M" />
              </div>
            </div>
          )}
        </div>

        {/* Instructions */}
        <p className="text-xs text-text-secondary-dark leading-relaxed">
          Share the pairing code and secret with the device you want to connect.
          On the other device, click <strong>Join Relay</strong> and enter these values.
        </p>

        <ModalFooter className="px-0 pb-0 pt-3 border-t border-border-dark">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Done
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  );
};

export default InviteDeviceModal;
