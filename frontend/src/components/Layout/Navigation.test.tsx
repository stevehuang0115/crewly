/**
 * Navigation Component Tests
 *
 * Tests for the redesigned sidebar (specs/2026-10-02-ui-redesign.md
 * §Navigation): 12 items in Work / Tools / System, badges, pinned
 * favorites, and collapse behavior.
 *
 * @module components/Layout/Navigation.test
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Navigation } from './Navigation';
import { SidebarProvider } from '../../contexts/SidebarContext';
import { NavBadgesProvider } from './NavBadges';

// Mock the QRCodeDisplay component
vi.mock('./QRCodeDisplay', () => ({
  QRCodeDisplay: () => <div data-testid="qr-code">QR Code</div>,
}));

// Mock the AuthStatusIndicator component
vi.mock('../Auth/AuthStatusIndicator', () => ({
  AuthStatusIndicator: () => <div data-testid="auth-status">Auth Status</div>,
}));

// Mock usePinnedFavorites hook
const mockPinnedItems: Array<{ id: string; name: string; type: 'project' | 'team' }> = [];
vi.mock('../../hooks/usePinnedFavorites', () => ({
  usePinnedFavorites: () => ({
    pinnedItems: mockPinnedItems,
    isPinned: (id: string) => mockPinnedItems.some(p => p.id === id),
    togglePin: vi.fn(),
    isAtLimit: false,
  }),
  MAX_PINNED: 5,
  STORAGE_KEY: 'crewly_pinned_favorites',
}));

// Schedules badge count (the hook polls the API; tests set the value)
let mockScheduleCount: number | null = null;
vi.mock('../../hooks/useScheduleCount', () => ({
  useScheduleCount: () => mockScheduleCount,
}));
let mockWaiting: number | null = null;
vi.mock('../../hooks/useWaitingOnYouCount', () => ({
  useWaitingOnYouCount: () => mockWaiting,
}));
let mockUnread: number | null = null;
vi.mock('../../hooks/useChatUnreadCount', () => ({
  useChatUnreadCount: () => mockUnread,
}));

const renderWithProviders = (component: React.ReactElement) => {
  return render(
    <BrowserRouter>
      <SidebarProvider>
        <NavBadgesProvider>{component}</NavBadgesProvider>
      </SidebarProvider>
    </BrowserRouter>
  );
};

/** `/health` answer for the sidebar's version line. */
function healthResponse(body: Record<string, unknown>) {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

describe('Navigation', () => {
  beforeEach(() => {
    mockPinnedItems.length = 0;
    mockScheduleCount = null;
    mockWaiting = null;
    mockUnread = null;
    // The sidebar asks /health for its version line on mount. Left pending
    // here so these synchronous tests see no state update after render —
    // the version-line tests below supply an answer and await it.
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 4-Group Navigation Structure
  // ---------------------------------------------------------------------------

  it('renders the 3 navigation group headers', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('nav-group-work')).toHaveTextContent('WORK');
    expect(screen.getByTestId('nav-group-tools')).toHaveTextContent('TOOLS');
    expect(screen.getByTestId('nav-group-system')).toHaveTextContent('SYSTEM');
    expect(screen.queryByTestId('nav-group-communicate')).not.toBeInTheDocument();
  });

  it('renders the 12 items in order: Work, Tools, System', () => {
    renderWithProviders(<Navigation />);

    const links = screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Dashboard', '/'],
      ['Chat', '/team-chat'],
      ['Tickets', '/tickets'],
      ['Projects', '/projects'],
      ['Teams', '/teams'],
      ['Wiki', '/wiki'],
      ['Schedules', '/triggers'],
      ['Browser', '/browser'],
      ['Marketplace', '/marketplace'],
      ['Connections', '/connections'],
      ['Usage', '/usage'],
      ['Settings', '/settings'],
    ]);
  });

  it('no longer lists the pages that moved (Missions, Work Items, Requests, Cloud Portal, Security, Agents)', () => {
    renderWithProviders(<Navigation />);

    for (const name of [/missions/i, /work items/i, /^requests$/i, /cloud portal/i, /security/i, /^agents$/i]) {
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  it('badges Dashboard with the waiting-on-you count in the attention colour and Chat with unread', () => {
    mockWaiting = 16;
    mockUnread = 3;
    renderWithProviders(<Navigation />);

    const waiting = screen.getByTestId('nav-badge-dashboard');
    expect(waiting).toHaveTextContent('16');
    expect(waiting).toHaveAttribute('aria-label', '16 waiting on you');
    expect(waiting.className).toContain('text-attention');
    const unread = screen.getByTestId('nav-badge-team-chat');
    expect(unread).toHaveTextContent('3');
    expect(unread.className).toContain('text-primary-text');
  });

  it('marks the active page (sub-pages count, dashboard only at /)', () => {
    window.history.pushState({}, '', '/tickets/runs/abc');
    renderWithProviders(<Navigation />);

    expect(screen.getByRole('link', { name: 'Tickets' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveAttribute('aria-current');
    window.history.pushState({}, '', '/');
  });

  it('has no project sub-nav: project sections are tabs in the project header', () => {
    window.history.pushState({}, '', '/projects/p1');
    renderWithProviders(<Navigation />);

    expect(screen.queryByTestId('project-subnav')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editor' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Projects' })).toHaveAttribute('aria-current', 'page');
    window.history.pushState({}, '', '/');
  });

  // ---------------------------------------------------------------------------
  // Logo and Branding
  // ---------------------------------------------------------------------------

  it('shows logo text when expanded', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByText('CREWLY')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Collapse / Expand
  // ---------------------------------------------------------------------------

  it('shows collapse toggle button in footer', () => {
    renderWithProviders(<Navigation />);

    const toggleButton = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(toggleButton).toBeInTheDocument();
  });

  it('toggles sidebar when footer button is clicked', () => {
    renderWithProviders(<Navigation />);

    const toggleButton = screen.getByRole('button', { name: /collapse sidebar/i });
    expect(screen.getByText('Collapse')).toBeInTheDocument();

    fireEvent.click(toggleButton);

    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // QR Code and Auth
  // ---------------------------------------------------------------------------

  it('shows QR code display', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('qr-code')).toBeInTheDocument();
  });

  it('shows auth status indicator', () => {
    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('auth-status')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Pinned Favorites
  // ---------------------------------------------------------------------------

  it('does not show pinned favorites section when empty', () => {
    renderWithProviders(<Navigation />);

    expect(screen.queryByTestId('pinned-favorites')).not.toBeInTheDocument();
  });

  it('shows pinned favorites when items exist', () => {
    mockPinnedItems.push(
      { id: 'proj-1', name: 'My Project', type: 'project' },
      { id: 'team-1', name: 'Dev Team', type: 'team' },
    );

    renderWithProviders(<Navigation />);

    expect(screen.getByTestId('pinned-favorites')).toBeInTheDocument();
    expect(screen.getByText('Favorites')).toBeInTheDocument();
    expect(screen.getByText('My Project')).toBeInTheDocument();
    expect(screen.getByText('Dev Team')).toBeInTheDocument();
  });

  it('pinned project links to correct project URL', () => {
    mockPinnedItems.push(
      { id: 'proj-abc', name: 'Test Project', type: 'project' },
    );

    renderWithProviders(<Navigation />);

    const link = screen.getByRole('link', { name: /test project/i });
    expect(link).toHaveAttribute('href', '/projects/proj-abc');
  });

  it('pinned team links to correct team URL', () => {
    mockPinnedItems.push(
      { id: 'team-xyz', name: 'QA Team', type: 'team' },
    );

    renderWithProviders(<Navigation />);

    const link = screen.getByRole('link', { name: /qa team/i });
    expect(link).toHaveAttribute('href', '/teams/team-xyz');
  });
});


/**
 * The owner asked for the running version under the wordmark — it is the
 * thing you look for first when a machine is behaving like an older build,
 * and tonight that question came up on every restart (2026-09-21).
 */
describe('Navigation — version line', () => {
  beforeEach(() => {
    mockPinnedItems.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the running version under the wordmark', async () => {
    global.fetch = vi.fn().mockResolvedValue(healthResponse({ version: '1.20.55', updateAvailable: false }));
    renderWithProviders(<Navigation />);
    expect(await screen.findByText('v1.20.55')).toBeInTheDocument();
  });

  it('flags an available update beside it', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(healthResponse({ version: '1.20.40', latestVersion: '1.20.55', updateAvailable: true }));
    renderWithProviders(<Navigation />);
    expect(await screen.findByText('v1.20.40')).toBeInTheDocument();
    const chip = screen.getByTestId('update-available-chip');
    expect(chip).toHaveTextContent('Update available');
    // It links to the Upgrade controls.
    expect(chip).toHaveAttribute('href', '/settings?tab=system');
  });

  it('shows no chip when up to date', async () => {
    global.fetch = vi.fn().mockResolvedValue(healthResponse({ version: '1.20.55', latestVersion: '1.20.55', updateAvailable: false }));
    renderWithProviders(<Navigation />);
    expect(await screen.findByText('v1.20.55')).toBeInTheDocument();
    expect(screen.queryByTestId('update-available-chip')).not.toBeInTheDocument();
  });

  // A label is not worth a blank sidebar: the fetch can fail on a backend
  // that is still starting, which is exactly when someone is looking at it.
  it('renders the sidebar anyway when /health cannot be reached', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    renderWithProviders(<Navigation />);
    expect(screen.getByText('CREWLY')).toBeInTheDocument();
    expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
  });

  it('labels the /triggers entry "Schedules" and badges active recurring schedules', () => {
    mockScheduleCount = 4;
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Navigation />);
    const link = screen.getByText('Schedules').closest('a');
    expect(link).toHaveAttribute('href', '/triggers');
    expect(screen.getByTestId('nav-badge-triggers')).toHaveTextContent('4');
  });

  it('shows no schedules badge when the count is zero or unknown', () => {
    mockScheduleCount = 0;
    global.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Navigation />);
    expect(screen.queryByTestId('nav-badge-triggers')).not.toBeInTheDocument();
  });
});
