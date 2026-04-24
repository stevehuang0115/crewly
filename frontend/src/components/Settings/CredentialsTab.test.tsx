/**
 * Tests for CredentialsTab — render, empty-state, the new headless OAuth flow,
 * and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialsTab, friendlyOAuthError } from './CredentialsTab';

const mockRefresh = vi.fn();
const mockAddApiKey = vi.fn();
const mockImport = vi.fn();
const mockClear = vi.fn();
const mockStartGoogleOAuth = vi.fn();
const mockCompleteGoogleOAuth = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();

const hookReturn = {
  credentials: [] as unknown[],
  isLoading: false,
  error: null as string | null,
  refresh: mockRefresh,
  addApiKey: mockAddApiKey,
  importFromGeminiCli: mockImport,
  clearGeminiCliExtensionFile: mockClear,
  startGoogleOAuth: mockStartGoogleOAuth,
  completeGoogleOAuth: mockCompleteGoogleOAuth,
  update: mockUpdate,
  remove: mockRemove,
};

vi.mock('../../hooks/useCredentials', () => ({
  useCredentials: () => hookReturn,
}));

// QRCodeSVG renders SVG with lots of <path> elements; stub it to keep test
// output readable and avoid depending on the library's DOM shape.
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => (
    <div data-testid="qr-code" data-value={value}>
      [QR]
    </div>
  ),
}));

beforeEach(() => {
  hookReturn.credentials = [];
  hookReturn.isLoading = false;
  hookReturn.error = null;
  mockStartGoogleOAuth.mockReset();
  mockCompleteGoogleOAuth.mockReset();
  mockRefresh.mockReset();
});

describe('CredentialsTab', () => {
  it('renders the disambiguation banner distinguishing from API Keys tab', () => {
    render(<CredentialsTab />);
    expect(screen.getByText(/third-party services your agents call/i)).toBeInTheDocument();
    expect(screen.getByText(/use the/i)).toBeInTheDocument();
  });

  it('shows both section headings when lists are empty', () => {
    render(<CredentialsTab />);
    expect(screen.getByText(/No Google accounts added yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No service API keys added yet/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Service API Keys/i })).toBeInTheDocument();
  });

  it('renders credentials grouped by type', () => {
    hookReturn.credentials = [
      {
        id: 'cred-a',
        name: 'info-gmail',
        type: 'google-oauth',
        provider: 'google',
        helper: 'gemini-cli-workspace',
        accountEmail: 'info@steam-fun.com',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
        createdAt: '2026-04-23T00:00:00Z',
        updatedAt: '2026-04-23T00:00:00Z',
        status: 'active',
      },
      {
        id: 'cred-b',
        name: 'gemini-main',
        type: 'api-key',
        provider: 'gemini',
        createdAt: '2026-04-23T00:00:00Z',
        updatedAt: '2026-04-23T00:00:00Z',
        status: 'active',
      },
    ];

    render(<CredentialsTab />);
    expect(screen.getByText('info-gmail')).toBeInTheDocument();
    expect(screen.getByText('gemini-main')).toBeInTheDocument();
    expect(screen.getByText(/info@steam-fun\.com/)).toBeInTheDocument();
  });

  it('shows error banner when hook reports an error', () => {
    hookReturn.error = 'Network down';
    render(<CredentialsTab />);
    expect(screen.getByText(/Failed to load credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/Network down/i)).toBeInTheDocument();
  });

  it('exposes the "Import from Gemini CLI" developer link', () => {
    render(<CredentialsTab />);
    expect(
      screen.getByRole('button', { name: /Import from Gemini CLI/i }),
    ).toBeInTheDocument();
  });

  // ==========================================================================
  // Headless OAuth flow
  // ==========================================================================

  it('opens the OAuth modal with scope presets when "Add Google Account" is clicked', async () => {
    const user = userEvent.setup();
    render(<CredentialsTab />);

    await user.click(screen.getByRole('button', { name: /Add Google Account/i }));

    // Title + name field + scope preset dropdown must be visible
    expect(screen.getByRole('heading', { name: /Add Google account/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Name \(internal\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Access scope/i)).toBeInTheDocument();
    // Hint text about Google blocking
    expect(screen.getByText(/If Google blocks the sign-in page/i)).toBeInTheDocument();
  });

  it('requires a name before generating the sign-in link', async () => {
    const user = userEvent.setup();
    render(<CredentialsTab />);

    await user.click(screen.getByRole('button', { name: /Add Google Account/i }));
    await user.click(screen.getByRole('button', { name: /Generate sign-in link/i }));

    expect(screen.getByText(/give this account a name/i)).toBeInTheDocument();
    expect(mockStartGoogleOAuth).not.toHaveBeenCalled();
  });

  it('calls startGoogleOAuth with gmail-only scopes by default and moves to sign-in stage', async () => {
    const user = userEvent.setup();
    mockStartGoogleOAuth.mockResolvedValue({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    });
    render(<CredentialsTab />);

    await user.click(screen.getByRole('button', { name: /Add Google Account/i }));
    await user.type(screen.getByLabelText(/Name \(internal\)/i), 'personal-gmail');
    await user.click(screen.getByRole('button', { name: /Generate sign-in link/i }));

    await waitFor(() => {
      expect(mockStartGoogleOAuth).toHaveBeenCalledTimes(1);
    });
    const passed = mockStartGoogleOAuth.mock.calls[0][0];
    expect(passed).toBeDefined();
    expect(Array.isArray(passed.scopes)).toBe(true);
    // Gmail-only preset: openid + userinfo.email + userinfo.profile + gmail.modify
    expect(passed.scopes).toContain('openid');
    expect(passed.scopes).toContain('https://www.googleapis.com/auth/gmail.modify');
    expect(passed.scopes).not.toContain(
      'https://www.googleapis.com/auth/drive.readonly',
    );

    // Moved to sign-in stage → QR + textarea visible
    await waitFor(() => {
      expect(screen.getByTestId('qr-code')).toBeInTheDocument();
    });
    expect(screen.getByTestId('qr-code').getAttribute('data-value')).toMatch(
      /accounts\.google\.com/,
    );
    expect(screen.getByRole('link', { name: /Open sign-in page/i })).toBeInTheDocument();
  });

  it('omits scopes entirely when "Full Workspace" preset is chosen (backend default)', async () => {
    const user = userEvent.setup();
    mockStartGoogleOAuth.mockResolvedValue({ authUrl: 'https://accounts.google.com/?x' });
    render(<CredentialsTab />);

    await user.click(screen.getByRole('button', { name: /Add Google Account/i }));
    await user.type(screen.getByLabelText(/Name \(internal\)/i), 'personal');
    fireEvent.change(screen.getByLabelText(/Access scope/i), {
      target: { value: 'full-workspace' },
    });
    await user.click(screen.getByRole('button', { name: /Generate sign-in link/i }));

    await waitFor(() => expect(mockStartGoogleOAuth).toHaveBeenCalled());
    // Full-workspace preset => pass undefined so backend uses its default list
    expect(mockStartGoogleOAuth.mock.calls[0][0]).toBeUndefined();
  });

  it('saves credential and refreshes list when user pastes JSON and clicks Save', async () => {
    const user = userEvent.setup();
    mockStartGoogleOAuth.mockResolvedValue({ authUrl: 'https://accounts.google.com/?x' });
    mockCompleteGoogleOAuth.mockResolvedValue({
      id: 'new-cred',
      name: 'personal',
      type: 'google-oauth',
      provider: 'google',
      accountEmail: 'me@x.com',
      createdAt: '',
      updatedAt: '',
      status: 'active',
    });

    render(<CredentialsTab />);
    await user.click(screen.getByRole('button', { name: /Add Google Account/i }));
    await user.type(screen.getByLabelText(/Name \(internal\)/i), 'personal');
    await user.click(screen.getByRole('button', { name: /Generate sign-in link/i }));

    // Now we're on the sign-in stage
    await screen.findByTestId('qr-code');

    const textarea = screen.getByLabelText(/paste the JSON/i);
    await user.click(textarea);
    await user.paste('{"access_token":"a","refresh_token":"b"}');

    await user.click(screen.getByRole('button', { name: /Save credential/i }));

    await waitFor(() => {
      expect(mockCompleteGoogleOAuth).toHaveBeenCalledWith({
        name: 'personal',
        credentialsJson: '{"access_token":"a","refresh_token":"b"}',
      });
    });
  });

  it('shows a friendly error when backend says JSON is missing tokens', async () => {
    const user = userEvent.setup();
    mockStartGoogleOAuth.mockResolvedValue({ authUrl: 'https://accounts.google.com/?x' });
    mockCompleteGoogleOAuth.mockRejectedValue(
      new Error(
        'credentialsJson is missing access_token or refresh_token. Make sure you copied the entire JSON block.',
      ),
    );

    render(<CredentialsTab />);
    await user.click(screen.getByRole('button', { name: /Add Google Account/i }));
    await user.type(screen.getByLabelText(/Name \(internal\)/i), 'personal');
    await user.click(screen.getByRole('button', { name: /Generate sign-in link/i }));
    await screen.findByTestId('qr-code');

    const textarea = screen.getByLabelText(/paste the JSON/i);
    await user.click(textarea);
    await user.paste('{}');
    await user.click(screen.getByRole('button', { name: /Save credential/i }));

    // Friendly translation should appear, not the raw error
    await waitFor(() => {
      expect(
        screen.getByText(/sign-in info you pasted is incomplete/i),
      ).toBeInTheDocument();
    });
  });
});

// ============================================================================
// friendlyOAuthError
// ============================================================================

describe('friendlyOAuthError', () => {
  it('translates the missing-tokens error', () => {
    const out = friendlyOAuthError(
      'credentialsJson is missing access_token or refresh_token',
    );
    expect(out).toMatch(/incomplete/i);
  });

  it('translates invalid JSON errors', () => {
    const out = friendlyOAuthError('credentialsJson is not valid JSON. Paste …');
    expect(out).toMatch(/does.?n.?t look like the JSON/i);
  });

  it('translates app-blocked errors', () => {
    const out = friendlyOAuthError('This app is blocked for this account');
    expect(out).toMatch(/doesn't allow sign-in/i);
  });

  it('translates duplicate-account errors', () => {
    const out = friendlyOAuthError('credential already exists for this account');
    expect(out).toMatch(/already linked/i);
  });

  it('falls back to the raw message for unknown errors', () => {
    const out = friendlyOAuthError('some other backend error');
    expect(out).toBe('some other backend error');
  });
});
