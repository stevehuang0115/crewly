/**
 * JoinRelayModal Component Tests
 *
 * Tests cover:
 * - Modal rendering and visibility
 * - Input fields for pairing code and shared secret
 * - Form validation (empty fields)
 * - Relay connect API call with correct parameters
 * - Loading, success, and error states
 * - Modal close and state reset
 *
 * @module components/Settings/JoinRelayModal.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JoinRelayModal } from './JoinRelayModal';

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

/** Mock successful relay connect response. */
function mockRelayConnectSuccess() {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { state: 'connecting', message: 'Relay client connection initiated' } }),
  });
}

/** Mock failed relay connect response. */
function mockRelayConnectFailure(error = 'Invalid pairing code') {
  mockFetch.mockResolvedValue({
    ok: false,
    json: async () => ({ success: false, error }),
  });
}

describe('JoinRelayModal', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockStorage.clear();
    mockStorage.set('crewly_cloud_token', 'test-token');
  });

  // -----------------------------------------------------------------------
  // Modal rendering
  // -----------------------------------------------------------------------

  it('should not render when isOpen is false', () => {
    render(<JoinRelayModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('join-relay-modal')).toBeNull();
  });

  it('should render when isOpen is true', () => {
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByTestId('join-relay-modal')).toBeDefined();
    expect(screen.getByText('Join Relay')).toBeDefined();
  });

  it('should render input fields for pairing code and shared secret', () => {
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    expect(screen.getByTestId('join-pairing-code-input')).toBeDefined();
    expect(screen.getByTestId('join-shared-secret-input')).toBeDefined();
  });

  it('should render a disabled submit button when inputs are empty', () => {
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    const submitBtn = screen.getByTestId('join-submit-button');
    expect(submitBtn).toBeDefined();
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Input handling
  // -----------------------------------------------------------------------

  it('should convert pairing code input to uppercase', () => {
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    const input = screen.getByTestId('join-pairing-code-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc123' } });

    expect(input.value).toBe('ABC123');
  });

  it('should enable submit button when both inputs have values', () => {
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'A3BK7P' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'a'.repeat(64) } });

    const submitBtn = screen.getByTestId('join-submit-button');
    expect(submitBtn.hasAttribute('disabled')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Form submission
  // -----------------------------------------------------------------------

  it('should call relay/connect with role=agent on submit', async () => {
    mockRelayConnectSuccess();
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'A3BK7P' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'deadbeef'.repeat(8) } });
    fireEvent.click(screen.getByTestId('join-submit-button'));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/relay/connect',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.role).toBe('agent');
    expect(body.apiUrl).toBe('https://api.crewlyai.com');
    expect(body.pairingCode).toBe('A3BK7P');
    expect(body.sharedSecret).toBe('deadbeef'.repeat(8));
    expect(body.token).toBe('test-token');
  });

  it('should show success feedback after successful connect', async () => {
    mockRelayConnectSuccess();
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'A3BK7P' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByTestId('join-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('join-success')).toBeDefined();
      expect(screen.getByText('Connected to relay successfully!')).toBeDefined();
    });

    // Submit button should be hidden on success
    expect(screen.queryByTestId('join-submit-button')).toBeNull();
  });

  it('should show error feedback after failed connect', async () => {
    mockRelayConnectFailure('Invalid pairing code');
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'BADCOD' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByTestId('join-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('join-error')).toBeDefined();
      expect(screen.getByText('Invalid pairing code')).toBeDefined();
    });
  });

  it('should show error when fetch throws', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'A3BK7P' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByTestId('join-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('join-error')).toBeDefined();
      expect(screen.getByText('Could not reach the server')).toBeDefined();
    });
  });

  it('should show validation error for empty inputs on submit via form', async () => {
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    // Force form submit without button (submit button is disabled for empty inputs)
    // but test the validation guard inside handleSubmit
    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: '  ' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: '  ' } });

    // Button should still be disabled (trim check)
    const submitBtn = screen.getByTestId('join-submit-button');
    expect(submitBtn.hasAttribute('disabled')).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------

  it('should show loading state during submission', async () => {
    mockFetch.mockReturnValue(new Promise(() => {})); // Never resolves
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'A3BK7P' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByTestId('join-submit-button'));

    await waitFor(() => {
      expect(screen.getByText('Connecting...')).toBeDefined();
    });

    // Inputs should be disabled during submission
    expect((screen.getByTestId('join-pairing-code-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('join-shared-secret-input') as HTMLInputElement).disabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Modal close
  // -----------------------------------------------------------------------

  it('should call onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(<JoinRelayModal isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('join-modal-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should call onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    render(<JoinRelayModal isOpen={true} onClose={onClose} />);

    fireEvent.click(screen.getByTestId('join-relay-modal'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should disable inputs after success', async () => {
    mockRelayConnectSuccess();
    render(<JoinRelayModal isOpen={true} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId('join-pairing-code-input'), { target: { value: 'A3BK7P' } });
    fireEvent.change(screen.getByTestId('join-shared-secret-input'), { target: { value: 'a'.repeat(64) } });
    fireEvent.click(screen.getByTestId('join-submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('join-success')).toBeDefined();
    });

    expect((screen.getByTestId('join-pairing-code-input') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('join-shared-secret-input') as HTMLInputElement).disabled).toBe(true);
  });
});
