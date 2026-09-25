/**
 * AuthCallback Page Tests
 *
 * Verifies OAuth callback handling: token storage, backend notification,
 * error forwarding, and navigation behaviour.
 *
 * @module pages/AuthCallback.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
let mockSearchParams = new URLSearchParams('?token=test-token');

vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [mockSearchParams],
}));

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AuthCallback', () => {
  let setItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockNavigate.mockReset();
    setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    setItemSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /**
   * Helper that dynamically imports and renders the component.
   * A fresh import is needed because the module-level vi.mock is static,
   * but we swap `mockSearchParams` between tests before importing.
   */
  async function renderAuthCallback() {
    // Clear the module cache so each test gets a fresh component instance
    // that picks up the current mockSearchParams value.
    vi.resetModules();

    const { AuthCallback } = await import('./AuthCallback');
    return render(<AuthCallback />);
  }

  // -----------------------------------------------------------------------
  // Token flow
  // -----------------------------------------------------------------------

  it('should store the token in localStorage when present in URL', async () => {
    mockSearchParams = new URLSearchParams('?token=test-token');
    await renderAuthCallback();

    await waitFor(() => {
      expect(setItemSpy).toHaveBeenCalledWith('crewly_cloud_token', 'test-token');
    });
  });

  it('should POST the token to /api/cloud/connect', async () => {
    mockSearchParams = new URLSearchParams('?token=test-token');
    await renderAuthCallback();

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/cloud/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'test-token' }),
      });
    });
  });

  it('should navigate to /settings?tab=cloud with replace when token is present', async () => {
    mockSearchParams = new URLSearchParams('?token=test-token');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings?tab=cloud', { replace: true });
    });
  });

  // -----------------------------------------------------------------------
  // Error flow
  // -----------------------------------------------------------------------

  it('should navigate with error param when error is in URL', async () => {
    mockSearchParams = new URLSearchParams('?error=access_denied');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/settings?tab=cloud&error=access_denied',
        { replace: true },
      );
    });
  });

  it('should not store anything in localStorage when only error is present', async () => {
    mockSearchParams = new URLSearchParams('?error=access_denied');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('should not call fetch when only error is present', async () => {
    mockSearchParams = new URLSearchParams('?error=access_denied');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Fetch failure resilience
  // -----------------------------------------------------------------------

  it('should handle fetch failure gracefully without throwing', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));
    mockSearchParams = new URLSearchParams('?token=test-token');

    await renderAuthCallback();

    // Navigation should still happen despite the fetch failure
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings?tab=cloud', { replace: true });
    });

    // Token should still be stored
    expect(setItemSpy).toHaveBeenCalledWith('crewly_cloud_token', 'test-token');
  });

  // -----------------------------------------------------------------------
  // No params flow
  // -----------------------------------------------------------------------

  it('should navigate to /settings?tab=cloud when no params are present', async () => {
    mockSearchParams = new URLSearchParams('');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings?tab=cloud', { replace: true });
    });
  });

  // -----------------------------------------------------------------------
  // ?next= (first-run setup, phone sign-in)
  // -----------------------------------------------------------------------

  it('connects, then returns to a same-origin ?next= path', async () => {
    mockSearchParams = new URLSearchParams('?next=%2Fsetup%3Fstep%3Dcloud&token=t1&refreshToken=r1');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/setup?step=cloud', { replace: true });
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/cloud/connect', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 't1', refreshToken: 'r1' }),
    }));
  });

  it('carries an error back to ?next=', async () => {
    mockSearchParams = new URLSearchParams('?next=%2Fsetup%3Fstep%3Dcloud&error=access_denied');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/setup?step=cloud&error=access_denied', { replace: true });
    });
  });

  it('ignores an off-site ?next=', async () => {
    mockSearchParams = new URLSearchParams('?next=%2F%2Fevil.example&token=t1');
    await renderAuthCallback();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/settings?tab=cloud', { replace: true });
    });
  });

  // -----------------------------------------------------------------------
  // UI rendering
  // -----------------------------------------------------------------------

  it('should render a loading spinner with sign-in message', async () => {
    mockSearchParams = new URLSearchParams('?token=test-token');
    await renderAuthCallback();

    expect(screen.getByText('Completing sign-in...')).toBeDefined();
  });

  it('should export default component', async () => {
    vi.resetModules();
    const mod = await import('./AuthCallback');
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe('function');
  });
});
