/**
 * InviteDeviceModal Component Tests
 *
 * Tests cover:
 * - Modal rendering and visibility
 * - Pairing code and shared secret generation
 * - Relay connect API call with correct parameters
 * - Copy-to-clipboard functionality
 * - QR code toggle
 * - Error and success states
 * - Modal close behavior
 *
 * @module components/Settings/InviteDeviceModal.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { InviteDeviceModal, generatePairingCode, generateSharedSecret } from './InviteDeviceModal';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock localStorage
const mockStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => mockStorage.get(key) ?? null,
  setItem: (key: string, value: string) => mockStorage.set(key, value),
  removeItem: (key: string) => mockStorage.delete(key),
});

// Mock clipboard
const mockWriteText = vi.fn().mockResolvedValue(undefined);
vi.stubGlobal('navigator', {
  clipboard: { writeText: mockWriteText },
});

/** Default successful relay connect response. */
function mockRelayConnectSuccess() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { state: 'connecting', message: 'Relay client connection initiated' } }),
  });
}

/** Mock relay connect failure. */
function mockRelayConnectFailure(error = 'Relay client is already in "connecting" state') {
  mockFetch.mockResolvedValue({
    ok: false,
    json: async () => ({ success: false, error }),
  });
}

describe('InviteDeviceModal', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockWriteText.mockClear();
    mockStorage.clear();
    mockStorage.set('crewly_cloud_token', 'test-token');
  });

  // -----------------------------------------------------------------------
  // Helper functions
  // -----------------------------------------------------------------------

  describe('generatePairingCode', () => {
    it('should generate a code of the specified length', () => {
      const code = generatePairingCode(6);
      expect(code).toHaveLength(6);
    });

    it('should only contain allowed alphanumeric characters', () => {
      const code = generatePairingCode(100);
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
    });

    it('should default to 6 characters', () => {
      const code = generatePairingCode();
      expect(code).toHaveLength(6);
    });
  });

  describe('generateSharedSecret', () => {
    it('should generate a hex string of the correct length', () => {
      const secret = generateSharedSecret(32);
      expect(secret).toHaveLength(64); // 32 bytes = 64 hex chars
    });

    it('should only contain hex characters', () => {
      const secret = generateSharedSecret(32);
      expect(secret).toMatch(/^[0-9a-f]+$/);
    });

    it('should default to 32 bytes', () => {
      const secret = generateSharedSecret();
      expect(secret).toHaveLength(64);
    });
  });

  // -----------------------------------------------------------------------
  // Modal rendering
  // -----------------------------------------------------------------------

  it('should not render when isOpen is false', () => {
    render(<InviteDeviceModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('invite-device-modal')).toBeNull();
  });

  it('should render when isOpen is true', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByTestId('invite-device-modal')).toBeDefined();
    expect(screen.getByText('Invite Device')).toBeDefined();
  });

  it('should display generated pairing code and shared secret', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      const code = screen.getByTestId('invite-pairing-code');
      expect(code.textContent).toHaveLength(6);

      const secret = screen.getByTestId('invite-shared-secret');
      expect(secret.textContent).toHaveLength(64);
    });
  });

  // -----------------------------------------------------------------------
  // API call
  // -----------------------------------------------------------------------

  it('should call relay/connect with role=orchestrator on open', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/relay/connect',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    // Verify the body contains the correct parameters
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.role).toBe('orchestrator');
    expect(body.apiUrl).toBe('https://api.crewlyai.com');
    expect(body.token).toBe('test-token');
    expect(body.pairingCode).toHaveLength(6);
    expect(body.sharedSecret).toHaveLength(64);
  });

  it('should show success status after successful connect', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-success')).toBeDefined();
    });
  });

  it('should show error status after failed connect', async () => {
    mockRelayConnectFailure('Already connected');
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-error')).toBeDefined();
      expect(screen.getByText('Already connected')).toBeDefined();
    });
  });

  it('should show error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-error')).toBeDefined();
      expect(screen.getByText('Could not reach the server')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Copy to clipboard
  // -----------------------------------------------------------------------

  it('should copy pairing code to clipboard', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('copy-pairing-code')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('copy-pairing-code'));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
      const copiedValue = mockWriteText.mock.calls[0][0];
      expect(copiedValue).toHaveLength(6);
    });
  });

  it('should copy shared secret to clipboard', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('copy-shared-secret')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('copy-shared-secret'));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalled();
      const copiedValue = mockWriteText.mock.calls[0][0];
      expect(copiedValue).toHaveLength(64);
    });
  });

  // -----------------------------------------------------------------------
  // QR code toggle
  // -----------------------------------------------------------------------

  it('should toggle QR code visibility', async () => {
    mockRelayConnectSuccess();
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('toggle-qr-code')).toBeDefined();
    });

    // QR should be hidden initially
    expect(screen.queryByTestId('qr-code-container')).toBeNull();

    // Click to show
    fireEvent.click(screen.getByTestId('toggle-qr-code'));
    expect(screen.getByTestId('qr-code-container')).toBeDefined();

    // Click to hide
    fireEvent.click(screen.getByTestId('toggle-qr-code'));
    expect(screen.queryByTestId('qr-code-container')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Modal close
  // -----------------------------------------------------------------------

  it('should call onClose when close button clicked', async () => {
    mockRelayConnectSuccess();
    const onClose = vi.fn();
    render(<InviteDeviceModal isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-modal-close')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('invite-modal-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose when backdrop clicked', async () => {
    mockRelayConnectSuccess();
    const onClose = vi.fn();
    render(<InviteDeviceModal isOpen={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-device-modal')).toBeDefined();
    });

    fireEvent.click(screen.getByTestId('invite-device-modal'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should show connecting state during API call', async () => {
    // Keep the promise pending
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<InviteDeviceModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId('invite-connecting')).toBeDefined();
    });
  });
});
